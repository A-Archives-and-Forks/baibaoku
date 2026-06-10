import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import bytes from 'bytes';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { parse } from '../../../src/character-card-parser.js';
import { PUBLIC_DIRECTORIES, SETTINGS_FILE } from '../../../src/constants.js';
import { generateTimestamp, removeOldBackups } from '../../../src/util.js';
import { PLUGIN_ID } from './constants.js';
import {
    getTiktokenTokenizer,
    getTokenizerModel,
    countWebTokenizerTokens,
    getSentencepiceTokenizer,
    getWebTokenizer,
} from '../../../src/endpoints/tokenizers.js';
import {
    closeSaveGenerateJobs,
    registerSaveGenerateEndpoints,
} from './save-generate.js';

const FAST_CHARACTER_CACHE_DATABASE = 'baibaoku.internal';
const FAST_CHARACTER_CACHE_STORE = 'character-fast-all';
const FAST_CHARACTER_CACHE_VERSION = 1;
const FAST_CHARACTER_CACHE_PAGE_SIZE = 1000;
const SETTINGS_FAST_CONFIG_DATABASE = 'baibaoku.internal';
const SETTINGS_FAST_CONFIG_STORE = 'fast-config';
const SETTINGS_FAST_CONFIG_KEY = 'global';
const DEFAULT_SETTINGS_ACCELERATION_ENABLED = true;
const DEFAULT_CHARACTER_LIST_ACCELERATION_ENABLED = true;
const DEFAULT_RECENT_CHAT_LIST_ACCELERATION_ENABLED = true;
const DEFAULT_PROGRESSIVE_CHAT_LOADING_ENABLED = false;
const DEFAULT_TOKENIZER_BULK_COUNT_ENABLED = true;
const DEFAULT_EXTENSION_MANIFEST_BUNDLE_ENABLED = true;
const SETTINGS_AUTOSAVE_INTERVAL = 10 * 60 * 1000;
const FAST_RECENT_CHAT_READ_BUFFER_SIZE = 1024 * 1024;
const FAST_CHAT_GET_DEFAULT_THRESHOLD_BYTES = 2 * 1024 * 1024;
const FAST_CHAT_GET_DEFAULT_INITIAL_MESSAGES = 5;
const SETTINGS_TEXT_PERSIST_VERSION = 1;
const SETTINGS_TEXT_PERSIST_FILE = 'settings-text-v1.json';
const SETTINGS_PAYLOAD_PERSIST_VERSION = 1;
const SETTINGS_PAYLOAD_PERSIST_FILE = 'settings-payload-v1.json';
const SETTINGS_RESPONSE_PERSIST_VERSION = 1;
const SETTINGS_RESPONSE_META_FILE = 'settings-response-v1.json';
const SETTINGS_RESPONSE_BODY_FILE = 'settings-response-v1.body';

// Cache structure: Map<userHandle, Map<filename, { mtime: number, size: number, data: Object }>>
const userCaches = new Map();
// Lock structure: Map<userHandle, Promise<void>>
const updateLocks = new Map();
// Cache structure: Map<userHandle, { sections: Map<string, Map<filename, CachedFile>> }>
const settingsUserCaches = new Map();
// Lock structure: Map<userHandle, Promise<Object>>
const settingsUpdateLocks = new Map();
// Cache structure: Map<userHandle, { path: string, text: string, mtime: number, size: number, updatedAt: number }>
const settingsFileCaches = new Map();
// Lock structure: Map<userHandle, Promise<Object>>
const settingsSaveLocks = new Map();
// Cache structure: Map<userHandle, { key: string, text: string }>
const settingsResponseCaches = new Map();
// Scheduler structure: Map<userHandle, { lastBackupAt: number, timer: Timeout|null, pendingPayload: Object|null }>
const settingsBackupSchedulers = new Map();
// Cache structure: Map<userHandle, string>
const lastBackupTexts = new Map();
let staticSettingsPayload = null;
const EARLY_BRIDGE_VERSION = '0.5';

/**
 * Normalizes tags from V1/V2 char data structure.
 */
function extractTags(data) {
    let rawTags = data?.data?.tags || data?.tags || [];
    if (typeof rawTags === 'string') {
        rawTags = rawTags.split(',').map(x => x.trim()).filter(x => x);
    }
    return Array.isArray(rawTags) ? rawTags : [];
}

/**
 * Formats a character exactly like ST's `toShallow`
 */
function formatShallowCharacter(filename, stat, rawDataStr) {
    let charData = {};
    try {
        charData = JSON.parse(rawDataStr);
    } catch (e) {
        console.warn(`[baibaoku] Failed to parse JSON for character card: ${filename}`);
    }

    // Default prefix is usually stripped from avatars in ST core UI 
    // Wait, the core ST removes "default_" when resolving files, but avatar usually keeps its filename
    // Oh, wait, the user specifically mentioned:
    // "酒馆默认角色卡是有default_前缀的,但是后端发回来的响应数据是没有这个前缀的,这个也要统一一下"
    let name = charData?.data?.name || charData?.name || filename.replace('.png', '');
    
    if (filename.startsWith('default_')) {
        const filenameBase = filename.replace('.png', '');
        if (name === filenameBase || name.startsWith('default_')) {
            name = name.replace(/^default_/, '');
        }
    }

    return {
        shallow: true,
        name: name,
        avatar: filename,
        chat: `${name} - ${new Date().toISOString()}`, // mock
        fav: charData?.data?.extensions?.fav || charData?.fav || false,
        date_added: stat.ctimeMs,
        create_date: charData?.create_date || new Date(Math.round(stat.ctimeMs)).toISOString(),
        date_last_chat: 0,
        chat_size: 0,
        data_size: rawDataStr.length,
        tags: extractTags(charData),
        data: {
            name: name,
            character_version: charData?.data?.character_version || '',
            creator: charData?.data?.creator || charData?.creator || '',
            creator_notes: charData?.data?.creator_notes || charData?.creatorcomment || '',
            tags: extractTags(charData),
            extensions: {
                fav: charData?.data?.extensions?.fav || charData?.fav || false,
                world: charData?.data?.extensions?.world || '',
            },
        },
    };
}

async function updateCacheForUser(req, manager, userHandle, charactersDir) {
    // 1. Get or create the cache for this user
    if (!userCaches.has(userHandle)) {
        userCaches.set(userHandle, await loadPersistentCache(req, manager));
    }
    const cache = userCaches.get(userHandle);

    // 2. Read all files in the directory
    let files = [];
    try {
        files = await fs.promises.readdir(charactersDir);
    } catch (e) {
        if (e.code === 'ENOENT') return cache; // Directory doesn't exist yet
        throw e;
    }
    const pngFiles = files.filter(f => f.endsWith('.png'));

    // 3. Batch stat all png files to get mtime
    const statPromises = pngFiles.map(async (filename) => {
        try {
            const stat = await fs.promises.stat(path.join(charactersDir, filename));
            return { filename, stat };
        } catch (e) {
            return { filename, error: e };
        }
    });
    const statResults = await Promise.all(statPromises);

    // 4. Garbage Collection: Remove deleted files from cache
    const currentFileSet = new Set(pngFiles);
    const deletedFilenames = [];
    for (const cachedFilename of cache.keys()) {
        if (!currentFileSet.has(cachedFilename)) {
            cache.delete(cachedFilename);
            deletedFilenames.push(cachedFilename);
        }
    }

    // 5. Identify and parse changed/new files
    const parsePromises = [];
    const updatedItems = [];
    for (const result of statResults) {
        if (result.error) continue;

        const { filename, stat } = result;
        const cachedItem = cache.get(filename);

        // If not in cache, or file metadata differs from the persisted snapshot.
        if (!cachedItem || stat.mtimeMs !== cachedItem.mtime || stat.size !== cachedItem.size) {
            const filePath = path.join(charactersDir, filename);
            const parseTask = async () => {
                try {
                    const rawDataStr = await parse(filePath, 'png');
                    if (rawDataStr) {
                        const shallowData = formatShallowCharacter(filename, stat, rawDataStr);
                        const item = {
                            mtime: stat.mtimeMs,
                            size: stat.size,
                            data: shallowData,
                        };
                        cache.set(filename, item);
                        updatedItems.push({ filename, item });
                    }
                } catch (e) {
                    console.warn(`[baibaoku] Failed to parse character ${filename}:`, e.message);
                }
            };
            parsePromises.push(parseTask());
        }
    }

    // 6. Wait for all parses to complete
    // We can run these concurrently, as parse() reads the buffer async
    await Promise.all(parsePromises);
    await persistCacheChanges(req, manager, updatedItems, deletedFilenames);

    return cache;
}

async function loadPersistentCache(req, manager) {
    const cache = new Map();
    if (!manager) {
        return cache;
    }

    try {
        await manager.openForRequest(req, FAST_CHARACTER_CACHE_DATABASE, {
            displayName: '柏宝库内部缓存',
            version: FAST_CHARACTER_CACHE_VERSION,
        });

        let offset = 0;
        while (true) {
            const result = await manager.entries(req, FAST_CHARACTER_CACHE_DATABASE, FAST_CHARACTER_CACHE_STORE, {
                prefix: '',
                limit: FAST_CHARACTER_CACHE_PAGE_SIZE,
                offset,
            });

            const entries = result.entries || [];
            for (const entry of entries) {
                const item = normalizePersistentCacheItem(entry.value);
                if (item) {
                    cache.set(entry.key, item);
                }
            }

            if (entries.length < FAST_CHARACTER_CACHE_PAGE_SIZE) {
                break;
            }
            offset += FAST_CHARACTER_CACHE_PAGE_SIZE;
        }
    } catch (error) {
        console.warn('[baibaoku] Failed to load persistent character cache:', error.message);
    }

    return cache;
}

async function persistCacheChanges(req, manager, updatedItems, deletedFilenames) {
    if (!manager) {
        return;
    }

    try {
        for (let index = 0; index < updatedItems.length; index += FAST_CHARACTER_CACHE_PAGE_SIZE) {
            const batch = updatedItems.slice(index, index + FAST_CHARACTER_CACHE_PAGE_SIZE);
            if (batch.length) {
                await manager.setMany(req, FAST_CHARACTER_CACHE_DATABASE, FAST_CHARACTER_CACHE_STORE, batch.map(({ filename, item }) => ({
                    key: filename,
                    value: item,
                })));
            }
        }

        for (let index = 0; index < deletedFilenames.length; index += FAST_CHARACTER_CACHE_PAGE_SIZE) {
            const batch = deletedFilenames.slice(index, index + FAST_CHARACTER_CACHE_PAGE_SIZE);
            if (batch.length) {
                await manager.deleteMany(req, FAST_CHARACTER_CACHE_DATABASE, FAST_CHARACTER_CACHE_STORE, batch);
            }
        }
    } catch (error) {
        console.warn('[baibaoku] Failed to persist character cache changes:', error.message);
    }
}

function normalizePersistentCacheItem(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }

    if (!Number.isFinite(value.mtime) || !value.data || typeof value.data !== 'object') {
        return null;
    }

    return {
        mtime: value.mtime,
        size: Number.isFinite(value.size) ? value.size : undefined,
        data: value.data,
    };
}

async function getFastRecentChats(req) {
    const userHandle = req.user?.profile?.handle;
    if (!userHandle) {
        const error = new Error('Unauthorized');
        error.status = 401;
        throw error;
    }

    const startedAt = Date.now();
    const pinnedChats = Array.isArray(req.body?.pinned) ? req.body.pinned : [];
    const max = normalizeRecentMax(req.body?.max) + pinnedChats.length;
    const withMetadata = Boolean(req.body?.metadata);
    const allChatFiles = [];
    const metrics = {
        characterFiles: 0,
        groupFiles: 0,
        rootFiles: 0,
        invalidFiles: 0,
        selectedFiles: 0,
        totalMs: 0,
    };

    await Promise.allSettled([
        collectFastRecentCharacterChatFiles(req, allChatFiles, metrics),
        collectFastRecentGroupChatFiles(req, allChatFiles, metrics),
        collectFastRecentRootChatFiles(req, allChatFiles, metrics),
    ]);

    const recentChats = allChatFiles.sort((a, b) => {
        const isAPinned = isPinnedRecentChat(a, pinnedChats);
        const isBPinned = isPinnedRecentChat(b, pinnedChats);

        if (isAPinned && !isBPinned) return -1;
        if (!isAPinned && isBPinned) return 1;

        return b.mtime - a.mtime;
    }).slice(0, max);
    metrics.selectedFiles = recentChats.length;

    const chatData = await Promise.allSettled(recentChats.map(file => getFastRecentChatInfo(file, withMetadata)));
    const validFiles = [];
    for (const result of chatData) {
        if (result.status === 'fulfilled' && result.value?.file_name) {
            validFiles.push(result.value);
        } else if (result.status === 'rejected') {
            metrics.invalidFiles += 1;
        }
    }

    metrics.totalMs = Date.now() - startedAt;
    return { data: validFiles, metrics };
}

function normalizeRecentMax(value) {
    const max = parseInt(value ?? Number.MAX_SAFE_INTEGER);
    return Number.isFinite(max) && max > 0 ? max : Number.MAX_SAFE_INTEGER;
}

async function collectFastRecentCharacterChatFiles(req, allChatFiles, metrics) {
    const directories = req.user?.directories || {};
    const charactersDir = directories.characters;
    const chatsDir = directories.chats;

    if (!charactersDir || !chatsDir) {
        return;
    }

    const characterDirents = await fs.promises.readdir(charactersDir, { withFileTypes: true });
    const avatarSet = new Set(characterDirents
        .filter(dirent => dirent.isFile() && path.extname(dirent.name) === '.png')
        .map(dirent => dirent.name));
    const chatDirents = await fs.promises.readdir(chatsDir, { withFileTypes: true });

    for (const dirent of chatDirents) {
        if (!dirent.isDirectory()) {
            continue;
        }

        const pngFile = `${dirent.name}.png`;
        if (!avatarSet.has(pngFile)) {
            continue;
        }

        const pathToChats = path.join(chatsDir, dirent.name);
        const chatFiles = await fs.promises.readdir(pathToChats, { withFileTypes: true });
        const jsonlFiles = chatFiles.filter(file => file.isFile() && path.extname(file.name) === '.jsonl');

        for (const file of jsonlFiles) {
            const filePath = path.join(pathToChats, file.name);
            const stats = await fs.promises.stat(filePath);
            allChatFiles.push({ pngFile, filePath, mtime: stats.mtimeMs });
            metrics.characterFiles += 1;
        }
    }
}

async function collectFastRecentGroupChatFiles(req, allChatFiles, metrics) {
    const directories = req.user?.directories || {};
    const groupsDir = directories.groups;
    const groupChatsDir = directories.groupChats;

    if (!groupsDir || !groupChatsDir) {
        return;
    }

    const groupDirents = await fs.promises.readdir(groupsDir, { withFileTypes: true });
    const groups = groupDirents.filter(dirent => dirent.isFile() && path.extname(dirent.name) === '.json');

    for (const group of groups) {
        try {
            const groupPath = path.join(groupsDir, group.name);
            const groupData = JSON.parse(await fs.promises.readFile(groupPath, 'utf8'));

            if (!Array.isArray(groupData.chats)) {
                continue;
            }

            for (const chat of groupData.chats) {
                const filePath = path.join(groupChatsDir, `${chat}.jsonl`);
                if (!fs.existsSync(filePath)) {
                    continue;
                }

                const stats = await fs.promises.stat(filePath);
                allChatFiles.push({ groupId: groupData.id, filePath, mtime: stats.mtimeMs });
                metrics.groupFiles += 1;
            }
        } catch {
            continue;
        }
    }
}

async function collectFastRecentRootChatFiles(req, allChatFiles, metrics) {
    const chatsDir = req.user?.directories?.chats;
    if (!chatsDir) {
        return;
    }

    const dirents = await fs.promises.readdir(chatsDir, { withFileTypes: true });
    const chatFiles = dirents.filter(dirent => dirent.isFile() && path.extname(dirent.name) === '.jsonl');

    for (const file of chatFiles) {
        const filePath = path.join(chatsDir, file.name);
        const stats = await fs.promises.stat(filePath);
        allChatFiles.push({ filePath, mtime: stats.mtimeMs });
        metrics.rootFiles += 1;
    }
}

function isPinnedRecentChat(chatFile, pinnedChats) {
    return pinnedChats.some(pinned => {
        return pinned?.file_name === path.basename(chatFile.filePath)
            && (pinned.avatar === chatFile.pngFile || pinned.group === chatFile.groupId);
    });
}

async function getFastRecentChatInfo(chatFile, withMetadata = false) {
    const parsedPath = path.parse(chatFile.filePath);
    const stats = await fs.promises.stat(chatFile.filePath);
    const chatData = {
        file_id: parsedPath.name,
        file_name: parsedPath.base,
        file_size: bytes.format(stats.size) ?? '',
        chat_items: 0,
        mes: '[The chat is empty]',
        last_mes: stats.mtimeMs,
    };

    if (chatFile.groupId) {
        chatData.group = chatFile.groupId;
    } else if (chatFile.pngFile) {
        chatData.avatar = chatFile.pngFile;
    }

    if (stats.size === 0) {
        return chatData;
    }

    const fileHandle = await fs.promises.open(chatFile.filePath, 'r');

    try {
        const scan = await scanJsonlLineInfo(fileHandle, stats.size);
        chatData.chat_items = Math.max(0, scan.lineCounter - 1);

        if (withMetadata && scan.firstLineLength > 0) {
            const firstLine = await readFileRangeAsUtf8(fileHandle, scan.firstLineStart, scan.firstLineLength);
            const firstJson = parseJsonLine(firstLine);
            if (firstJson?.chat_metadata && typeof firstJson.chat_metadata === 'object') {
                chatData.chat_metadata = firstJson.chat_metadata;
            }
        }

        if (scan.lastLineLength <= 0) {
            return chatData;
        }

        const lastLine = await readFileRangeAsUtf8(fileHandle, scan.lastLineStart, scan.lastLineLength);
        const jsonData = parseJsonLine(lastLine);
        if (jsonData && (jsonData.name || jsonData.character_name || jsonData.chat_metadata)) {
            chatData.mes = jsonData.mes || '[The message is empty]';
            chatData.last_mes = jsonData.send_date || new Date(Math.round(stats.mtimeMs)).toISOString();
            return chatData;
        }

        console.warn('Found an invalid or corrupted chat file:', chatFile.filePath);
        return null;
    } finally {
        await fileHandle.close();
    }
}

async function scanJsonlLineInfo(fileHandle, fileSize) {
    const buffer = Buffer.allocUnsafe(FAST_RECENT_CHAT_READ_BUFFER_SIZE);
    let lineCounter = 0;
    let position = 0;
    let previousLineStart = 0;
    let lastLineStart = 0;
    let firstLineEnd = -1;
    let lastByte = null;

    while (position < fileSize) {
        const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) {
            break;
        }

        const chunk = buffer.subarray(0, bytesRead);
        let searchOffset = 0;
        let newlineOffset;

        while ((newlineOffset = chunk.indexOf(10, searchOffset)) !== -1) {
            const absoluteOffset = position + newlineOffset;
            if (firstLineEnd === -1) {
                firstLineEnd = absoluteOffset;
            }
            lineCounter += 1;
            previousLineStart = lastLineStart;
            lastLineStart = absoluteOffset + 1;
            searchOffset = newlineOffset + 1;
        }

        lastByte = chunk[bytesRead - 1];
        position += bytesRead;
    }

    if (lastByte !== 10) {
        lineCounter += 1;
    }

    const firstLineLength = firstLineEnd === -1 ? fileSize : firstLineEnd;
    const lastLineStartOffset = lastByte === 10 ? previousLineStart : lastLineStart;
    const lastLineEndOffset = lastByte === 10 ? Math.max(0, position - 1) : position;

    return {
        lineCounter,
        firstLineStart: 0,
        firstLineLength,
        lastLineStart: lastLineStartOffset,
        lastLineLength: Math.max(0, lastLineEndOffset - lastLineStartOffset),
    };
}

async function readFileRangeAsUtf8(fileHandle, start, length) {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await fileHandle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString('utf8');
}

function parseJsonLine(line) {
    try {
        return JSON.parse(String(line ?? '').replace(/\r$/, ''));
    } catch {
        return null;
    }
}

async function getFastChatGet(req) {
    const userHandle = req.user?.profile?.handle;
    if (!userHandle) {
        const error = new Error('Unauthorized');
        error.status = 401;
        throw error;
    }

    const source = String(req.body?.source || '');
    const mode = req.body?.mode === 'full' ? 'full' : 'initial';
    const originalRequest = req.body?.originalRequest && typeof req.body.originalRequest === 'object'
        ? req.body.originalRequest
        : {};
    const thresholdBytes = normalizeFastChatThresholdBytes(req.body?.thresholdBytes);
    const initialMessages = normalizeFastChatInitialMessages(req.body?.initialMessages);
    const chatFile = resolveFastChatFile(req, source, originalRequest);
    const startedAt = Date.now();

    if (!chatFile?.filePath) {
        const error = new Error('Unsupported chat source');
        error.status = 400;
        throw error;
    }

    let stats = null;
    try {
        stats = await fs.promises.stat(chatFile.filePath);
    } catch {
        return buildFastChatResponse({
            kind: 'complete',
            chat: [],
            source,
            chatKey: chatFile.chatKey,
            stats: { size: 0, mtimeMs: 0 },
            totalMessages: 0,
            returnedMessages: 0,
            messageStartIndex: 0,
            elapsedMs: Date.now() - startedAt,
        });
    }

    if (stats.size <= 0) {
        return buildFastChatResponse({
            kind: 'complete',
            chat: [],
            source,
            chatKey: chatFile.chatKey,
            stats,
            totalMessages: 0,
            returnedMessages: 0,
            messageStartIndex: 0,
            elapsedMs: Date.now() - startedAt,
        });
    }

    if (mode === 'full' || stats.size <= thresholdBytes) {
        const chat = await readFullJsonlChat(chatFile.filePath);
        const totalMessages = countChatMessages(chat);
        return buildFastChatResponse({
            kind: mode === 'full' ? 'full' : 'complete',
            chat,
            source,
            chatKey: chatFile.chatKey,
            stats,
            totalMessages,
            returnedMessages: totalMessages,
            messageStartIndex: 0,
            elapsedMs: Date.now() - startedAt,
        });
    }

    const partial = await readPartialJsonlChat(chatFile.filePath, stats.size, initialMessages);
    return buildFastChatResponse({
        kind: 'partial',
        chat: partial.chat,
        source,
        chatKey: chatFile.chatKey,
        stats,
        totalMessages: partial.totalMessages,
        returnedMessages: partial.returnedMessages,
        messageStartIndex: partial.messageStartIndex,
        elapsedMs: Date.now() - startedAt,
    });
}

function normalizeFastChatThresholdBytes(value) {
    const threshold = Number(value);
    return Number.isFinite(threshold) && threshold > 0
        ? Math.floor(threshold)
        : FAST_CHAT_GET_DEFAULT_THRESHOLD_BYTES;
}

function normalizeFastChatInitialMessages(value) {
    const count = Number(value);
    return Number.isInteger(count) && count > 0
        ? Math.min(count, 500)
        : FAST_CHAT_GET_DEFAULT_INITIAL_MESSAGES;
}

function resolveFastChatFile(req, source, originalRequest) {
    const directories = req.user?.directories || {};

    if (source === '/api/chats/get') {
        const chatsDir = directories.chats;
        const avatarUrl = String(originalRequest.avatar_url || '');
        const fileName = String(originalRequest.file_name || '');
        if (!chatsDir || !avatarUrl || !fileName) {
            return null;
        }

        const characterDir = sanitizeFastChatPathSegment(avatarUrl.replace('.png', ''));
        const chatFileName = sanitizeFastChatPathSegment(`${fileName}.jsonl`);
        const filePath = path.join(chatsDir, characterDir, chatFileName);
        if (!isFastChatPathUnderParent(chatsDir, filePath)) {
            return null;
        }

        return {
            filePath,
            chatKey: getFastChatKey(req, filePath),
        };
    }

    if (source === '/api/chats/group/get') {
        const groupChatsDir = directories.groupChats;
        const id = String(originalRequest.id || '');
        if (!groupChatsDir || !id) {
            return null;
        }

        const filePath = path.join(groupChatsDir, sanitizeFastChatPathSegment(`${id}.jsonl`));
        if (!isFastChatPathUnderParent(groupChatsDir, filePath)) {
            return null;
        }

        return {
            filePath,
            chatKey: getFastChatKey(req, filePath),
        };
    }

    return null;
}

function sanitizeFastChatPathSegment(value) {
    return path.basename(String(value || ''))
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
        .trim();
}

function isFastChatPathUnderParent(parent, target) {
    const relative = path.relative(path.resolve(parent), path.resolve(target));
    return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function getFastChatKey(req, filePath) {
    const root = req.user?.directories?.root;
    const relative = root
        ? path.relative(root, filePath)
        : filePath;
    return relative.replaceAll(path.sep, '/');
}

async function readFullJsonlChat(filePath) {
    const text = await fs.promises.readFile(filePath, 'utf8');
    if (!text) {
        return [];
    }

    return text
        .split('\n')
        .map(line => parseJsonLine(line))
        .filter(Boolean);
}

async function readPartialJsonlChat(filePath, fileSize, initialMessages) {
    const fileHandle = await fs.promises.open(filePath, 'r');

    try {
        const scan = await scanJsonlTailRanges(fileHandle, fileSize, initialMessages);
        const firstLineText = scan.firstLineRange
            ? await readFileRangeAsUtf8(fileHandle, scan.firstLineRange.start, scan.firstLineRange.length)
            : '';
        const firstJson = parseJsonLine(firstLineText);
        const hasHeader = Boolean(firstJson?.chat_metadata && typeof firstJson.chat_metadata === 'object');
        const tailRanges = hasHeader ? scan.tailMessageRanges : scan.tailAllRanges;
        const totalMessages = hasHeader
            ? Math.max(0, scan.lineCounter - 1)
            : scan.lineCounter;
        const messageStartIndex = Math.max(0, totalMessages - tailRanges.length);
        const chat = [];

        if (hasHeader) {
            chat.push(firstJson);
        }

        for (const range of tailRanges) {
            const text = await readFileRangeAsUtf8(fileHandle, range.start, range.length);
            const json = parseJsonLine(text);
            if (json) {
                chat.push(json);
            }
        }

        return {
            chat,
            totalMessages,
            returnedMessages: tailRanges.length,
            messageStartIndex,
        };
    } finally {
        await fileHandle.close();
    }
}

async function scanJsonlTailRanges(fileHandle, fileSize, tailLimit) {
    const buffer = Buffer.allocUnsafe(FAST_RECENT_CHAT_READ_BUFFER_SIZE);
    let lineCounter = 0;
    let position = 0;
    let lineStart = 0;
    let firstLineRange = null;
    let lastByte = null;
    const tailAllRanges = [];
    const tailMessageRanges = [];

    const pushTail = (queue, range) => {
        queue.push(range);
        while (queue.length > tailLimit) {
            queue.shift();
        }
    };

    const finishLine = (end) => {
        const range = {
            start: lineStart,
            length: Math.max(0, end - lineStart),
        };

        if (!firstLineRange) {
            firstLineRange = range;
        }

        if (range.length > 0) {
            pushTail(tailAllRanges, range);
            if (lineCounter > 0) {
                pushTail(tailMessageRanges, range);
            }
        }

        lineCounter += 1;
        lineStart = end + 1;
    };

    while (position < fileSize) {
        const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) {
            break;
        }

        const chunk = buffer.subarray(0, bytesRead);
        let searchOffset = 0;
        let newlineOffset;

        while ((newlineOffset = chunk.indexOf(10, searchOffset)) !== -1) {
            finishLine(position + newlineOffset);
            searchOffset = newlineOffset + 1;
        }

        lastByte = chunk[bytesRead - 1];
        position += bytesRead;
    }

    if (lastByte !== 10 && lineStart < fileSize) {
        finishLine(fileSize);
    }

    return {
        lineCounter,
        firstLineRange,
        tailAllRanges,
        tailMessageRanges,
    };
}

function countChatMessages(chat) {
    if (!Array.isArray(chat) || chat.length === 0) {
        return 0;
    }

    return chat[0]?.chat_metadata ? Math.max(0, chat.length - 1) : chat.length;
}

function buildFastChatResponse({ kind, chat, source, chatKey, stats, totalMessages, returnedMessages, messageStartIndex, elapsedMs }) {
    const fileSize = Number(stats?.size || 0);
    const mtimeMs = Number(stats?.mtimeMs || 0);
    const startIndex = Math.max(0, Number(messageStartIndex || 0));
    const returned = Math.max(0, Number(returnedMessages || 0));

    return {
        ok: true,
        kind,
        chat,
        meta: {
            partial: kind === 'partial',
            chatKey,
            source,
            fileSize,
            mtimeMs,
            version: `${fileSize}:${mtimeMs}`,
            totalMessages: Math.max(0, Number(totalMessages || 0)),
            returnedMessages: returned,
            messageStartIndex: startIndex,
            messageEndIndexExclusive: startIndex + returned,
            elapsedMs,
        },
    };
}

function getSettingsPath(req) {
    return path.join(req.user.directories.root, SETTINGS_FILE);
}

function getBaibaokuCacheDirectory(req) {
    return path.join(req.user.directories.root, 'baibaoku', 'cache');
}

function getSettingsTextPersistPath(req) {
    return path.join(getBaibaokuCacheDirectory(req), SETTINGS_TEXT_PERSIST_FILE);
}

function getSettingsPayloadPersistPath(req) {
    return path.join(getBaibaokuCacheDirectory(req), SETTINGS_PAYLOAD_PERSIST_FILE);
}

function getSettingsResponseMetaPath(req) {
    return path.join(getBaibaokuCacheDirectory(req), SETTINGS_RESPONSE_META_FILE);
}

function getSettingsResponseBodyPath(req) {
    return path.join(getBaibaokuCacheDirectory(req), SETTINGS_RESPONSE_BODY_FILE);
}

function cacheSettingsText(userHandle, settingsPath, text, stat) {
    settingsFileCaches.set(userHandle, {
        path: settingsPath,
        text,
        mtime: stat.mtimeMs,
        size: stat.size,
        updatedAt: Date.now(),
    });
    settingsResponseCaches.delete(userHandle);
}

function schedulePersistSettingsText(req, userHandle) {
    setTimeout(() => {
        void persistSettingsTextToDisk(req, userHandle)
            .catch((error) => {
                console.warn('[baibaoku] Failed to persist settings text cache:', error.message);
            });
    }, 0);
}

async function persistSettingsTextToDisk(req, userHandle) {
    const cached = settingsFileCaches.get(userHandle);
    if (!cached) {
        return false;
    }

    const payload = {
        version: SETTINGS_TEXT_PERSIST_VERSION,
        savedAt: Date.now(),
        path: cached.path,
        mtime: cached.mtime,
        size: cached.size,
        updatedAt: cached.updatedAt,
        text: cached.text,
    };

    await writeFileAtomicAsync(getSettingsTextPersistPath(req), JSON.stringify(payload));
    return true;
}

async function restoreSettingsTextFromDisk(req, userHandle, settingsPath, stat) {
    let persisted;

    try {
        persisted = JSON.parse(await fs.promises.readFile(getSettingsTextPersistPath(req), 'utf8'));
    } catch {
        return null;
    }

    if (
        persisted?.version !== SETTINGS_TEXT_PERSIST_VERSION
        || persisted.path !== settingsPath
        || persisted.mtime !== stat.mtimeMs
        || persisted.size !== stat.size
        || typeof persisted.text !== 'string'
    ) {
        return null;
    }

    settingsFileCaches.set(userHandle, {
        path: settingsPath,
        text: persisted.text,
        mtime: stat.mtimeMs,
        size: stat.size,
        updatedAt: Number(persisted.updatedAt) || Date.now(),
    });

    return {
        ...settingsFileCaches.get(userHandle),
        cacheHit: true,
        cacheStatus: 'persistent-hit',
    };
}

function hasFreshSettingsTextCache(userHandle, settingsPath, stat) {
    const cached = settingsFileCaches.get(userHandle);

    return Boolean(
        cached
        && cached.path === settingsPath
        && cached.mtime === stat.mtimeMs
        && cached.size === stat.size,
    );
}

async function readSettingsTextWithCache(req, userHandle) {
    const settingsPath = getSettingsPath(req);
    const stat = await fs.promises.stat(settingsPath);

    if (hasFreshSettingsTextCache(userHandle, settingsPath, stat)) {
        return {
            ...settingsFileCaches.get(userHandle),
            cacheHit: true,
            cacheStatus: 'hit',
        };
    }

    const persisted = await restoreSettingsTextFromDisk(req, userHandle, settingsPath, stat);
    if (persisted) {
        return persisted;
    }

    const text = await fs.promises.readFile(settingsPath, 'utf8');
    cacheSettingsText(userHandle, settingsPath, text, stat);
    schedulePersistSettingsText(req, userHandle);

    return {
        ...settingsFileCaches.get(userHandle),
        cacheHit: false,
        cacheStatus: 'miss',
    };
}

function queueSettingsSave(userHandle, task) {
    const previous = settingsSaveLocks.get(userHandle) || Promise.resolve();
    const run = previous.catch(() => {}).then(task);
    const tracked = run.finally(() => {
        if (settingsSaveLocks.get(userHandle) === tracked) {
            settingsSaveLocks.delete(userHandle);
        }
    });

    settingsSaveLocks.set(userHandle, tracked);
    return tracked;
}

async function waitForPendingSettingsSave(userHandle) {
    const pendingSave = settingsSaveLocks.get(userHandle);

    if (pendingSave) {
        await pendingSave.catch(() => {});
    }
}

async function saveSettingsWithCache(req, userHandle) {
    const settingsPath = getSettingsPath(req);
    const text = JSON.stringify(req.body ?? {}, null, 4);
    let currentStat = null;

    try {
        currentStat = await fs.promises.stat(settingsPath);
    } catch (error) {
        if (error?.code !== 'ENOENT') {
            throw error;
        }
    }

    if (currentStat) {
        const currentText = hasFreshSettingsTextCache(userHandle, settingsPath, currentStat)
            ? settingsFileCaches.get(userHandle).text
            : await fs.promises.readFile(settingsPath, 'utf8');

        if (currentText === text) {
            return { result: 'ok', skipped: true };
        }
    }

    writeFileAtomicSync(settingsPath, text, 'utf8');

    const stat = await fs.promises.stat(settingsPath);
    cacheSettingsText(userHandle, settingsPath, text, stat);
    schedulePersistSettingsText(req, userHandle);

    return { result: 'ok' };
}

function getSettingsBackupFilePrefix(userHandle) {
    return `settings_${userHandle}_`;
}

function getSettingsBackupPayload(req, userHandle) {
    const directories = req.user?.directories;
    if (!directories?.backups || !directories?.root) {
        return null;
    }

    return {
        userHandle,
        backupDir: directories.backups,
        settingsPath: path.join(directories.root, SETTINGS_FILE),
    };
}

function getSettingsBackupScheduler(userHandle) {
    if (!settingsBackupSchedulers.has(userHandle)) {
        settingsBackupSchedulers.set(userHandle, {
            lastBackupAt: 0,
            timer: null,
            pendingPayload: null,
        });
    }

    return settingsBackupSchedulers.get(userHandle);
}

function scheduleSettingsAutoBackup(req, userHandle) {
    const payload = getSettingsBackupPayload(req, userHandle);
    if (!payload) {
        return;
    }

    const scheduler = getSettingsBackupScheduler(userHandle);
    const now = Date.now();
    const elapsed = now - scheduler.lastBackupAt;

    if (!scheduler.timer && elapsed >= SETTINGS_AUTOSAVE_INTERVAL) {
        scheduler.lastBackupAt = now;
        scheduler.timer = setTimeout(() => runScheduledSettingsBackup(userHandle, payload), 0);
        return;
    }

    scheduler.pendingPayload = payload;

    if (!scheduler.timer) {
        const delay = Math.max(0, SETTINGS_AUTOSAVE_INTERVAL - elapsed);
        scheduler.timer = setTimeout(() => runScheduledSettingsBackup(userHandle), delay);
    }
}

async function runScheduledSettingsBackup(userHandle, immediatePayload = null) {
    const scheduler = settingsBackupSchedulers.get(userHandle);
    if (!scheduler) {
        return;
    }

    scheduler.timer = null;

    const payload = immediatePayload || scheduler.pendingPayload;
    if (!immediatePayload) {
        scheduler.pendingPayload = null;
    }

    if (!payload) {
        return;
    }

    scheduler.lastBackupAt = Date.now();

    try {
        await backupSettingsIfChanged(payload);
    } catch (error) {
        console.warn('[baibaoku] Settings backup failed:', error.message);
    } finally {
        if (scheduler.pendingPayload && !scheduler.timer) {
            scheduler.timer = setTimeout(() => runScheduledSettingsBackup(userHandle), SETTINGS_AUTOSAVE_INTERVAL);
        }
    }
}

async function backupSettingsIfChanged(payload) {
    const { backupDir, settingsPath, userHandle } = payload;
    const cached = settingsFileCaches.get(userHandle);
    if (cached?.path !== settingsPath || typeof cached.text !== 'string') {
        return;
    }

    const text = cached.text;
    if (lastBackupTexts.get(userHandle) === text) {
        return;
    }

    await fs.promises.mkdir(backupDir, { recursive: true });

    const backupFile = path.join(backupDir, `${getSettingsBackupFilePrefix(userHandle)}${generateTimestamp()}.json`);
    await fs.promises.copyFile(settingsPath, backupFile);
    removeOldBackups(backupDir, `settings_${userHandle}`);
    lastBackupTexts.set(userHandle, text);
}

function getSettingsUserCache(userHandle) {
    if (!settingsUserCaches.has(userHandle)) {
        settingsUserCaches.set(userHandle, {
            userHandle,
            sections: new Map(),
            payload: null,
            payloadDirty: true,
            payloadDirtyReason: 'initial',
            payloadDirtyAt: Date.now(),
            payloadBuiltAt: 0,
            payloadCacheKey: '',
            payloadPersistedBuiltAt: 0,
            payloadPersistPromise: null,
            payloadWatchers: new Map(),
            payloadWatchAttempted: false,
        });
    }

    return settingsUserCaches.get(userHandle);
}

function getSettingsPayloadWatchTargets(directories) {
    return [
        { directoryPath: directories.koboldAI_Settings, sectionName: 'koboldai_settings' },
        { directoryPath: directories.novelAI_Settings, sectionName: 'novelai_settings' },
        { directoryPath: directories.openAI_Settings, sectionName: 'openai_settings' },
        { directoryPath: directories.textGen_Settings, sectionName: 'textgenerationwebui_presets' },
        { directoryPath: directories.worlds, sectionName: null },
        { directoryPath: directories.themes, sectionName: 'themes' },
        { directoryPath: directories.movingUI, sectionName: 'movingUIPresets' },
        { directoryPath: directories.quickreplies, sectionName: 'quickReplyPresets' },
        { directoryPath: directories.instruct, sectionName: 'instruct' },
        { directoryPath: directories.context, sectionName: 'context' },
        { directoryPath: directories.sysprompt, sectionName: 'sysprompt' },
        { directoryPath: directories.reasoning, sectionName: 'reasoning' },
    ].filter(target => target.directoryPath);
}

function markSettingsPayloadDirty(userCache, reason = 'unknown') {
    userCache.payloadDirty = true;
    userCache.payloadDirtyReason = reason;
    userCache.payloadDirtyAt = Date.now();
    settingsResponseCaches.delete(userCache.userHandle);
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function formatSettingsWatchReason(target, eventType, filenameText) {
    return `watch:${eventType}:${target.directoryPath}${filenameText ? `/${filenameText}` : ''}`;
}

async function handleSettingsPayloadWatchEvent(userCache, target, eventType, filename) {
    const filenameText = filename ? String(filename) : '';
    const reason = formatSettingsWatchReason(target, eventType, filenameText);

    if (!filenameText) {
        markSettingsPayloadDirty(userCache, `${reason}:unknown-file`);
        return;
    }

    if (path.extname(filenameText).toLowerCase() !== '.json') {
        return;
    }

    if (!target.sectionName) {
        markSettingsPayloadDirty(userCache, reason);
        return;
    }

    await delay(75);

    const sectionCache = getSettingsSectionCache(userCache, target.sectionName);
    const cached = sectionCache.get(filenameText);
    const filePath = path.join(target.directoryPath, filenameText);
    let stat;
    let file;

    try {
        stat = await fs.promises.stat(filePath);
        file = await fs.promises.readFile(filePath, 'utf8');
    } catch {
        if (cached) {
            markSettingsPayloadDirty(userCache, `${reason}:missing`);
        }
        return;
    }

    const contentHash = hashSettingsFileContent(file);
    if (cached?.contentHash === contentHash) {
        cached.mtime = stat.mtimeMs;
        cached.size = stat.size;
        cached.contentHash = contentHash;
        return;
    }

    markSettingsPayloadDirty(userCache, reason);
}

function ensureSettingsPayloadWatchers(userCache, directories) {
    if (userCache.payloadWatchAttempted) {
        return;
    }

    userCache.payloadWatchAttempted = true;
    const targets = Array.from(new Map(
        getSettingsPayloadWatchTargets(directories).map(target => [target.directoryPath, target]),
    ).values());

    for (const target of targets) {
        try {
            const watcher = fs.watch(target.directoryPath, { persistent: false }, (eventType, filename) => {
                void handleSettingsPayloadWatchEvent(userCache, target, eventType, filename)
                    .catch((error) => {
                        const filenameText = filename ? String(filename) : '';
                        markSettingsPayloadDirty(userCache, `${formatSettingsWatchReason(target, eventType, filenameText)}:validate-error:${error.message}`);
                    });
            });

            watcher.on('error', (error) => {
                markSettingsPayloadDirty(userCache, `watch-error:${target.directoryPath}:${error.message}`);
                console.warn(`[baibaoku] Settings payload watcher failed for ${target.directoryPath}:`, error.message);
            });

            userCache.payloadWatchers.set(target.directoryPath, watcher);
        } catch (error) {
            markSettingsPayloadDirty(userCache, `watch-unavailable:${target.directoryPath}:${error.message}`);
            console.warn(`[baibaoku] Settings payload watcher unavailable for ${target.directoryPath}:`, error.message);
        }
    }
}

function canUseCachedSettingsPayload(userCache) {
    return Boolean(
        userCache.payload
        && !userCache.payloadDirty,
    );
}

function getSettingsSectionCache(userCache, sectionName) {
    if (!userCache.sections.has(sectionName)) {
        userCache.sections.set(sectionName, new Map());
    }

    return userCache.sections.get(sectionName);
}

async function readCachedPresetDirectory(userCache, sectionName, directoryPath) {
    const sectionCache = getSettingsSectionCache(userCache, sectionName);
    const entries = await updateCachedJsonDirectory(sectionCache, directoryPath, {
        sortMode: 'locale',
        valueMode: 'raw-json',
        removeFileExtension: true,
        warnInvalid: true,
    });

    return {
        fileContents: entries.map(entry => entry.value),
        fileNames: entries.map(entry => entry.name),
    };
}

async function readCachedParsedDirectory(userCache, sectionName, directoryPath) {
    const sectionCache = getSettingsSectionCache(userCache, sectionName);
    const entries = await updateCachedJsonDirectory(sectionCache, directoryPath, {
        sortMode: 'default',
        valueMode: 'parsed-json',
        removeFileExtension: false,
        warnInvalid: false,
    });

    return entries.map(entry => entry.value);
}

function hashSettingsFileContent(text) {
    return crypto.createHash('sha1').update(text).digest('hex');
}

function hashSettingsJson(value) {
    return crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex');
}

function computeSettingsPayloadCacheKey(userCache, payload) {
    const sections = {};

    for (const [sectionName, sectionCache] of Array.from(userCache.sections.entries()).sort(([a], [b]) => a.localeCompare(b))) {
        sections[sectionName] = Array.from(sectionCache.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([filename, entry]) => ({
                filename,
                name: entry.name,
                contentHash: entry.contentHash || null,
                size: entry.size,
            }));
    }

    return hashSettingsJson({
        version: SETTINGS_PAYLOAD_PERSIST_VERSION,
        sections,
        world_names: Array.isArray(payload?.world_names) ? payload.world_names : [],
    });
}

async function updateCachedJsonDirectory(sectionCache, directoryPath, options) {
    const {
        sortMode,
        valueMode,
        removeFileExtension,
        warnInvalid,
    } = options;

    const files = (await fs.promises.readdir(directoryPath))
        .filter(file => path.parse(file).ext === '.json')
        .sort(sortMode === 'locale' ? (a, b) => a.localeCompare(b) : undefined);
    const currentFiles = new Set(files);

    for (const cachedFile of sectionCache.keys()) {
        if (!currentFiles.has(cachedFile)) {
            sectionCache.delete(cachedFile);
        }
    }

    await Promise.all(files.map(async (filename) => {
        const filePath = path.join(directoryPath, filename);
        let stat;

        try {
            stat = await fs.promises.stat(filePath);
        } catch {
            sectionCache.delete(filename);
            return;
        }

        const cached = sectionCache.get(filename);
        if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) {
            return;
        }

        try {
            const file = await fs.promises.readFile(filePath, 'utf8');
            const parsed = JSON.parse(file);
            sectionCache.set(filename, {
                mtime: stat.mtimeMs,
                size: stat.size,
                contentHash: hashSettingsFileContent(file),
                name: removeFileExtension ? filename.replace(/\.[^/.]+$/, '') : filename,
                value: valueMode === 'raw-json' ? file : parsed,
            });
        } catch {
            sectionCache.delete(filename);
            if (warnInvalid) {
                console.warn(`${filename} is not a valid JSON`);
            }
        }
    }));

    return files
        .map(filename => sectionCache.get(filename))
        .filter(Boolean);
}

async function readWorldNames(directoryPath) {
    const worldFiles = (await fs.promises.readdir(directoryPath))
        .filter(file => path.extname(file).toLowerCase() === '.json')
        .sort((a, b) => a.localeCompare(b));

    return worldFiles.map(item => path.parse(item).name);
}

async function getJsonDirectorySignature(directoryPath, options = {}) {
    const caseInsensitiveExtension = options.caseInsensitiveExtension === true;
    const files = (await fs.promises.readdir(directoryPath))
        .filter((file) => {
            const extension = path.extname(file);
            return caseInsensitiveExtension ? extension.toLowerCase() === '.json' : extension === '.json';
        })
        .sort((a, b) => a.localeCompare(b));
    const signature = {};

    await Promise.all(files.map(async (filename) => {
        const stat = await fs.promises.stat(path.join(directoryPath, filename));
        signature[filename] = {
            mtime: stat.mtimeMs,
            size: stat.size,
        };
    }));

    return signature;
}

function sameDirectorySignature(left = {}, right = {}) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();

    if (leftKeys.length !== rightKeys.length) {
        return false;
    }

    return leftKeys.every((filename, index) => {
        const otherFilename = rightKeys[index];
        const leftFile = left[filename];
        const rightFile = right[otherFilename];

        return filename === otherFilename
            && leftFile?.mtime === rightFile?.mtime
            && leftFile?.size === rightFile?.size;
    });
}

function sameDirectoryFileNames(left = {}, right = {}) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();

    return leftKeys.length === rightKeys.length
        && leftKeys.every((filename, index) => filename === rightKeys[index]);
}

async function reconcilePersistedSectionSignature(directoryPath, persistedSection, state = {}) {
    const currentSignature = await getJsonDirectorySignature(directoryPath);
    const persistedSignature = persistedSection?.signature || {};
    const persistedFiles = persistedSection?.files || {};

    if (sameDirectorySignature(currentSignature, persistedSignature)) {
        return true;
    }

    if (!sameDirectoryFileNames(currentSignature, persistedSignature)) {
        return false;
    }

    for (const [filename, currentFile] of Object.entries(currentSignature)) {
        const persistedFile = persistedSignature[filename];
        if (persistedFile?.mtime === currentFile.mtime && persistedFile?.size === currentFile.size) {
            continue;
        }

        const persistedCacheEntry = persistedFiles[filename];
        if (!persistedCacheEntry?.contentHash) {
            return false;
        }

        const file = await fs.promises.readFile(path.join(directoryPath, filename), 'utf8');
        const contentHash = hashSettingsFileContent(file);
        if (contentHash !== persistedCacheEntry.contentHash) {
            return false;
        }

        state.reconciled = true;
        persistedSignature[filename] = currentFile;
        persistedCacheEntry.mtime = currentFile.mtime;
        persistedCacheEntry.size = currentFile.size;
        persistedCacheEntry.contentHash = contentHash;
    }

    return true;
}

async function writeFileAtomicAsync(filePath, data, options = 'utf8') {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`;

    try {
        await fs.promises.writeFile(tempPath, data, options);
        await fs.promises.rename(tempPath, filePath);
    } catch (error) {
        await fs.promises.unlink(tempPath).catch(() => {});
        throw error;
    }
}

async function restoreSettingsPayloadFromDisk(req, userHandle, directories) {
    const persistPath = getSettingsPayloadPersistPath(req);
    let persisted;

    try {
        persisted = JSON.parse(await fs.promises.readFile(persistPath, 'utf8'));
    } catch {
        return false;
    }

    if (persisted?.version !== SETTINGS_PAYLOAD_PERSIST_VERSION || !persisted.payload || !persisted.sections) {
        return false;
    }

    const targets = getSettingsPayloadWatchTargets(directories);
    const restoreState = { reconciled: false };

    for (const target of targets) {
        if (target.sectionName) {
            const persistedSection = persisted.sections[target.sectionName];
            if (!persistedSection || !await reconcilePersistedSectionSignature(target.directoryPath, persistedSection, restoreState)) {
                return false;
            }
            continue;
        }

        const currentSignature = await getJsonDirectorySignature(target.directoryPath, {
            caseInsensitiveExtension: true,
        });
        if (!sameDirectorySignature(currentSignature, persisted.worlds?.signature)) {
            return false;
        }
    }

    const userCache = getSettingsUserCache(userHandle);
    userCache.sections.clear();

    for (const [sectionName, persistedSection] of Object.entries(persisted.sections)) {
        const sectionCache = new Map();
        for (const [filename, entry] of Object.entries(persistedSection.files || {})) {
            sectionCache.set(filename, entry);
        }
        userCache.sections.set(sectionName, sectionCache);
    }

    userCache.payload = persisted.payload;
    userCache.payloadDirty = false;
    userCache.payloadDirtyReason = '';
    userCache.payloadDirtyAt = 0;
    userCache.payloadBuiltAt = Number(persisted.payloadBuiltAt) || Date.now();
    userCache.payloadCacheKey = persisted.payloadCacheKey || computeSettingsPayloadCacheKey(userCache, persisted.payload);
    userCache.payloadPersistedBuiltAt = restoreState.reconciled ? 0 : userCache.payloadBuiltAt;
    return true;
}

function ensureSettingsPayloadPersisted(req, userHandle) {
    const userCache = getSettingsUserCache(userHandle);

    if (!canUseCachedSettingsPayload(userCache)) {
        return null;
    }

    if (userCache.payloadPersistedBuiltAt === userCache.payloadBuiltAt) {
        return userCache.payloadPersistPromise;
    }

    if (userCache.payloadPersistPromise) {
        return userCache.payloadPersistPromise;
    }

    userCache.payloadPersistPromise = new Promise(resolve => setTimeout(resolve, 0))
        .then(() => persistSettingsPayloadToDisk(req, userHandle))
        .catch((error) => {
            console.warn('[baibaoku] Failed to persist settings payload cache:', error.message);
            return false;
        })
        .finally(() => {
            userCache.payloadPersistPromise = null;
        });

    return userCache.payloadPersistPromise;
}

async function persistSettingsPayloadToDisk(req, userHandle) {
    const userCache = getSettingsUserCache(userHandle);

    if (!canUseCachedSettingsPayload(userCache)) {
        return false;
    }

    const cachedPayload = userCache.payload;
    const payloadBuiltAt = userCache.payloadBuiltAt;
    const directories = req.user.directories;
    const sections = {};

    for (const target of getSettingsPayloadWatchTargets(directories)) {
        const signature = await getJsonDirectorySignature(target.directoryPath, {
            caseInsensitiveExtension: !target.sectionName,
        });

        if (!target.sectionName) {
            sections.__worlds__ = { signature };
            continue;
        }

        const sectionCache = getSettingsSectionCache(userCache, target.sectionName);
        sections[target.sectionName] = {
            signature,
            files: Object.fromEntries(sectionCache.entries()),
        };
    }

    const persistPayload = {
        version: SETTINGS_PAYLOAD_PERSIST_VERSION,
        savedAt: Date.now(),
        payloadBuiltAt,
        payloadCacheKey: userCache.payloadCacheKey || computeSettingsPayloadCacheKey(userCache, cachedPayload),
        sections: Object.fromEntries(Object.entries(sections).filter(([sectionName]) => sectionName !== '__worlds__')),
        worlds: sections.__worlds__ || { signature: {} },
        payload: cachedPayload,
    };

    if (!canUseCachedSettingsPayload(userCache) || userCache.payload !== cachedPayload || userCache.payloadBuiltAt !== payloadBuiltAt) {
        return false;
    }

    await writeFileAtomicAsync(getSettingsPayloadPersistPath(req), JSON.stringify(persistPayload));
    userCache.payloadPersistedBuiltAt = payloadBuiltAt;
    return true;
}

async function getFastSettingsPayload(req, userHandle, metrics = {}) {
    const userCache = getSettingsUserCache(userHandle);
    const directories = req.user.directories;

    ensureSettingsPayloadWatchers(userCache, directories);

    if (canUseCachedSettingsPayload(userCache)) {
        metrics.payloadCache = 'hit';
        return userCache.payload;
    }

    if (!userCache.payload) {
        try {
            if (await restoreSettingsPayloadFromDisk(req, userHandle, directories)) {
                metrics.payloadCache = 'persistent-hit';
                return userCache.payload;
            }
        } catch (error) {
            console.warn('[baibaoku] Failed to restore settings payload cache from disk:', error.message);
        }
    }

    metrics.payloadCache = userCache.payload ? 'stale' : 'miss';
    metrics.payloadDirtyReason = userCache.payloadDirtyReason || '';
    metrics.payloadDirtyAgeMs = userCache.payloadDirtyAt ? Date.now() - userCache.payloadDirtyAt : 0;

    return buildFastSettingsPayload(req, userHandle);
}

async function buildFastSettingsPayload(req, userHandle) {
    const userCache = getSettingsUserCache(userHandle);
    const directories = req.user.directories;

    const [
        kobold,
        novelai,
        openai,
        textgenerationwebui,
        worldNames,
        themes,
        movingUIPresets,
        quickReplyPresets,
        instruct,
        context,
        sysprompt,
        reasoning,
    ] = await Promise.all([
        readCachedPresetDirectory(userCache, 'koboldai_settings', directories.koboldAI_Settings),
        readCachedPresetDirectory(userCache, 'novelai_settings', directories.novelAI_Settings),
        readCachedPresetDirectory(userCache, 'openai_settings', directories.openAI_Settings),
        readCachedPresetDirectory(userCache, 'textgenerationwebui_presets', directories.textGen_Settings),
        readWorldNames(directories.worlds),
        readCachedParsedDirectory(userCache, 'themes', directories.themes),
        readCachedParsedDirectory(userCache, 'movingUIPresets', directories.movingUI),
        readCachedParsedDirectory(userCache, 'quickReplyPresets', directories.quickreplies),
        readCachedParsedDirectory(userCache, 'instruct', directories.instruct),
        readCachedParsedDirectory(userCache, 'context', directories.context),
        readCachedParsedDirectory(userCache, 'sysprompt', directories.sysprompt),
        readCachedParsedDirectory(userCache, 'reasoning', directories.reasoning),
    ]);

    const payload = {
        koboldai_settings: kobold.fileContents,
        koboldai_setting_names: kobold.fileNames,
        world_names: worldNames,
        novelai_settings: novelai.fileContents,
        novelai_setting_names: novelai.fileNames,
        openai_settings: openai.fileContents,
        openai_setting_names: openai.fileNames,
        textgenerationwebui_presets: textgenerationwebui.fileContents,
        textgenerationwebui_preset_names: textgenerationwebui.fileNames,
        themes,
        movingUIPresets,
        quickReplyPresets,
        instruct,
        context,
        sysprompt,
        reasoning,
    };

    userCache.payload = payload;
    userCache.payloadDirty = false;
    userCache.payloadDirtyReason = '';
    userCache.payloadDirtyAt = 0;
    userCache.payloadBuiltAt = Date.now();
    userCache.payloadCacheKey = computeSettingsPayloadCacheKey(userCache, payload);
    ensureSettingsPayloadPersisted(req, userHandle);

    return payload;
}

async function getStaticSettingsPayload() {
    if (staticSettingsPayload) {
        return staticSettingsPayload;
    }

    const { getConfigValue } = await import('../../../src/util.js');
    const enableRequestCompression = !!getConfigValue('performance.requestCompression.enabled', false, 'boolean');

    staticSettingsPayload = {
        enable_extensions: !!getConfigValue('extensions.enabled', true, 'boolean'),
        enable_extensions_auto_update: !!getConfigValue('extensions.autoUpdate', true, 'boolean'),
        enable_accounts: !!getConfigValue('enableUserAccounts', false, 'boolean'),
        request_compression: {
            enabled: enableRequestCompression,
            minPayloadSize: bytes.parse(getConfigValue('performance.requestCompression.minPayloadSize', '256kb')) || 0,
            maxPayloadSize: bytes.parse(getConfigValue('performance.requestCompression.maxPayloadSize', '8mb')) || 0,
            timeout: Number(getConfigValue('performance.requestCompression.timeout', 3000, 'number')) || 0,
        },
    };

    return staticSettingsPayload;
}

function buildExtensionManifestBundle(req) {
    const userExtensionsDirectory = req.user?.directories?.extensions;

    if (!userExtensionsDirectory) {
        throw new Error('Current SillyTavern user extensions directory was not found.');
    }

    const builtInExtensions = readExtensionFolders(PUBLIC_DIRECTORIES.extensions)
        .filter(folder => folder !== 'third-party')
        .map(folder => ({ type: 'system', name: folder }));

    const userExtensions = readExtensionFolders(userExtensionsDirectory)
        .map(folder => ({ type: 'local', name: `third-party/${folder}` }));

    const globalExtensions = readExtensionFolders(PUBLIC_DIRECTORIES.globalExtensions)
        .map(folder => ({ type: 'global', name: `third-party/${folder}` }))
        .filter(extension => !userExtensions.some(userExtension => userExtension.name === extension.name));

    const extensions = [...builtInExtensions, ...userExtensions, ...globalExtensions];
    const manifests = {};
    const missing = {};
    const invalid = {};

    for (const extension of extensions) {
        const manifestPath = getExtensionManifestPath(req, extension);

        try {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
                throw new Error('Manifest is not a valid JSON object.');
            }
            manifests[extension.name] = manifest;
        } catch (error) {
            const bucket = error?.code === 'ENOENT' ? missing : invalid;
            bucket[extension.name] = {
                path: manifestPath,
                message: error?.message || String(error),
            };
        }
    }

    return {
        extensions,
        manifests,
        missing,
        invalid,
        generatedAt: Date.now(),
    };
}

function readExtensionFolders(directory) {
    if (!fs.existsSync(directory)) {
        fs.mkdirSync(directory, { recursive: true });
    }

    return fs.readdirSync(directory)
        .filter(folder => {
            try {
                return fs.statSync(path.join(directory, folder)).isDirectory();
            } catch {
                return false;
            }
        });
}

function getExtensionManifestPath(req, extension) {
    switch (extension.type) {
        case 'system':
            return path.join(PUBLIC_DIRECTORIES.extensions, extension.name, 'manifest.json');
        case 'local':
            return path.join(req.user.directories.extensions, getThirdPartyExtensionFolder(extension.name), 'manifest.json');
        case 'global':
            return path.join(PUBLIC_DIRECTORIES.globalExtensions, getThirdPartyExtensionFolder(extension.name), 'manifest.json');
        default:
            throw new Error(`Unknown extension type: ${extension.type}`);
    }
}

function getThirdPartyExtensionFolder(name) {
    return String(name || '').replace(/^third-party[\\/]/, '');
}

async function getFastSettingsResponse(req, userHandle, settingsInfo, cachedPayload, staticPayload) {
    const key = getFastSettingsResponseKey(userHandle, settingsInfo, staticPayload);
    const cached = settingsResponseCaches.get(userHandle);

    if (cached?.key === key && typeof cached.text === 'string') {
        return {
            cacheHit: true,
            cacheStatus: 'hit',
            encoding: 'identity',
            body: cached.text,
        };
    }

    return restoreOrBuildFastSettingsResponseCache(req, userHandle, key, settingsInfo, cachedPayload, staticPayload);
}

async function restoreOrBuildFastSettingsResponseCache(req, userHandle, key, settingsInfo, cachedPayload, staticPayload) {
    const restored = await restoreFastSettingsResponseCache(req, userHandle, key);
    if (restored) {
        return {
            cacheHit: true,
            cacheStatus: 'persistent-hit',
            encoding: 'identity',
            body: restored.text,
        };
    }

    const nextCache = buildFastSettingsResponseCache(key, settingsInfo, cachedPayload, staticPayload);
    settingsResponseCaches.set(userHandle, nextCache);
    schedulePersistFastSettingsResponse(req, userHandle, nextCache);

    return {
        cacheHit: false,
        cacheStatus: 'miss',
        encoding: 'identity',
        body: nextCache.text,
    };
}

function getFastSettingsResponseKey(userHandle, settingsInfo, staticPayload) {
    const userCache = getSettingsUserCache(userHandle);

    return [
        settingsInfo.path,
        settingsInfo.mtime,
        settingsInfo.size,
        userCache.payloadCacheKey || userCache.payloadBuiltAt,
        hashSettingsJson(staticPayload),
    ].join('\0');
}

function buildFastSettingsResponseCache(key, settingsInfo, cachedPayload, staticPayload) {
    const text = JSON.stringify({
        settings: settingsInfo.text,
        ...cachedPayload,
        ...staticPayload,
    });

    return { key, text };
}

async function restoreFastSettingsResponseCache(req, userHandle, key) {
    let meta;

    try {
        meta = JSON.parse(await fs.promises.readFile(getSettingsResponseMetaPath(req), 'utf8'));
    } catch {
        return null;
    }

    if (meta?.version !== SETTINGS_RESPONSE_PERSIST_VERSION || meta.key !== key) {
        return null;
    }

    try {
        const text = await fs.promises.readFile(getSettingsResponseBodyPath(req), 'utf8');
        const cache = { key, text };
        settingsResponseCaches.set(userHandle, cache);
        return cache;
    } catch {
        return null;
    }
}

function schedulePersistFastSettingsResponse(req, userHandle, responseCache) {
    setTimeout(() => {
        void persistFastSettingsResponseToDisk(req, userHandle, responseCache)
            .catch((error) => {
                console.warn('[baibaoku] Failed to persist settings response cache:', error.message);
            });
    }, 0);
}

async function persistFastSettingsResponseToDisk(req, userHandle, responseCache) {
    if (!responseCache?.key || typeof responseCache.text !== 'string') {
        return false;
    }

    if (settingsResponseCaches.get(userHandle)?.key !== responseCache.key) {
        return false;
    }

    await writeFileAtomicAsync(getSettingsResponseBodyPath(req), responseCache.text);
    await writeFileAtomicAsync(getSettingsResponseMetaPath(req), JSON.stringify({
        version: SETTINGS_RESPONSE_PERSIST_VERSION,
        savedAt: Date.now(),
        key: responseCache.key,
        hasBody: true,
        bodyFile: SETTINGS_RESPONSE_BODY_FILE,
    }));

    return true;
}

function sameSettingsInfo(left, right) {
    return Boolean(
        left
        && right
        && left.path === right.path
        && left.mtime === right.mtime
        && left.size === right.size
        && left.updatedAt === right.updatedAt,
    );
}

function scheduleSettingsResponseWarmup(req, userHandle, reason = 'unknown') {
    setTimeout(() => {
        void warmSettingsResponseCache(req, userHandle, reason)
            .catch((error) => {
                console.warn(`[baibaoku] Failed to warm settings response cache after ${reason}:`, error.message);
            });
    }, 0);
}

async function warmSettingsResponseCache(req, userHandle) {
    const userCache = getSettingsUserCache(userHandle);

    if (!canUseCachedSettingsPayload(userCache)) {
        return false;
    }

    const cachedPayload = userCache.payload;
    const payloadBuiltAt = userCache.payloadBuiltAt;
    const settingsInfo = await readSettingsTextWithCache(req, userHandle);

    if (!canUseCachedSettingsPayload(userCache) || userCache.payload !== cachedPayload || userCache.payloadBuiltAt !== payloadBuiltAt) {
        return false;
    }

    const staticPayload = await getStaticSettingsPayload();
    const currentSettingsInfo = settingsFileCaches.get(userHandle);

    if (!sameSettingsInfo(settingsInfo, currentSettingsInfo)) {
        return false;
    }

    const key = getFastSettingsResponseKey(userHandle, settingsInfo, staticPayload);
    const nextCache = buildFastSettingsResponseCache(key, settingsInfo, cachedPayload, staticPayload);

    if (
        !canUseCachedSettingsPayload(userCache)
        || userCache.payload !== cachedPayload
        || userCache.payloadBuiltAt !== payloadBuiltAt
        || !sameSettingsInfo(settingsInfo, settingsFileCaches.get(userHandle))
    ) {
        return false;
    }

    settingsResponseCaches.set(userHandle, nextCache);
    schedulePersistFastSettingsResponse(req, userHandle, nextCache);
    return true;
}

async function getSettingsFastConfig(req, manager) {
    const result = await manager.get(
        req,
        SETTINGS_FAST_CONFIG_DATABASE,
        SETTINGS_FAST_CONFIG_STORE,
        SETTINGS_FAST_CONFIG_KEY,
    );
    let value = result.exists && result.value && typeof result.value === 'object'
        ? result.value
        : null;

    if (!value) {
        const legacyResult = await manager.get(
            req,
            SETTINGS_FAST_CONFIG_DATABASE,
            'settings-fast-config',
            'settings',
        );
        value = legacyResult.exists && legacyResult.value && typeof legacyResult.value === 'object'
            ? legacyResult.value
            : {};
    }

    return {
        settingsAccelerationEnabled: value.settingsAccelerationEnabled !== false,
        characterListAccelerationEnabled: value.characterListAccelerationEnabled !== false,
        recentChatListAccelerationEnabled: value.recentChatListAccelerationEnabled !== false,
        progressiveChatLoadingEnabled: value.progressiveChatLoadingEnabled === true,
        tokenizerBulkCountEnabled: value.tokenizerBulkCountEnabled !== false,
        extensionManifestBundleEnabled: value.extensionManifestBundleEnabled !== false,
    };
}

async function setSettingsFastConfig(req, manager) {
    const current = await getSettingsFastConfig(req, manager);
    const next = {
        ...current,
        settingsAccelerationEnabled: req.body?.settingsAccelerationEnabled === undefined
            ? current.settingsAccelerationEnabled !== false
            : req.body.settingsAccelerationEnabled !== false,
        characterListAccelerationEnabled: req.body?.characterListAccelerationEnabled === undefined
            ? current.characterListAccelerationEnabled !== false
            : req.body.characterListAccelerationEnabled !== false,
        recentChatListAccelerationEnabled: req.body?.recentChatListAccelerationEnabled === undefined
            ? current.recentChatListAccelerationEnabled !== false
            : req.body.recentChatListAccelerationEnabled !== false,
        progressiveChatLoadingEnabled: req.body?.progressiveChatLoadingEnabled === undefined
            ? current.progressiveChatLoadingEnabled === true
            : req.body.progressiveChatLoadingEnabled === true,
        tokenizerBulkCountEnabled: req.body?.tokenizerBulkCountEnabled === undefined
            ? current.tokenizerBulkCountEnabled !== false
            : req.body.tokenizerBulkCountEnabled !== false,
        extensionManifestBundleEnabled: req.body?.extensionManifestBundleEnabled === undefined
            ? current.extensionManifestBundleEnabled !== false
            : req.body.extensionManifestBundleEnabled !== false,
    };

    await manager.set(
        req,
        SETTINGS_FAST_CONFIG_DATABASE,
        SETTINGS_FAST_CONFIG_STORE,
        SETTINGS_FAST_CONFIG_KEY,
        next,
        { type: 'json' },
    );

    return next;
}

async function getSettingsFastConfigSafe(req, manager) {
    try {
        return await getSettingsFastConfig(req, manager);
    } catch (error) {
        console.warn('[baibaoku] Failed to read settings fast config; using defaults:', error.message);
        return {
            settingsAccelerationEnabled: DEFAULT_SETTINGS_ACCELERATION_ENABLED,
            characterListAccelerationEnabled: DEFAULT_CHARACTER_LIST_ACCELERATION_ENABLED,
            recentChatListAccelerationEnabled: DEFAULT_RECENT_CHAT_LIST_ACCELERATION_ENABLED,
            progressiveChatLoadingEnabled: DEFAULT_PROGRESSIVE_CHAT_LOADING_ENABLED,
            tokenizerBulkCountEnabled: DEFAULT_TOKENIZER_BULK_COUNT_ENABLED,
            extensionManifestBundleEnabled: DEFAULT_EXTENSION_MANIFEST_BUNDLE_ENABLED,
        };
    }
}

function makeEarlyBridgeScript(options = {}) {
    const apiPrefix = `/api/plugins/${PLUGIN_ID}`;
    const fastSettingsGetPath = `${apiPrefix}/v1/settings/fast-get`;
    const fastSettingsSavePath = `${apiPrefix}/v1/settings/fast-save`;
    const fastCharacterListPath = `${apiPrefix}/v1/characters/fast-all`;
    const fastRecentChatListPath = `${apiPrefix}/v1/chats/fast-recent`;
    const extensionManifestBundlePath = `${apiPrefix}/v1/extensions/manifest-bundle`;
    const settingsAccelerationEnabled = options.settingsAccelerationEnabled !== false;
    const characterListAccelerationEnabled = options.characterListAccelerationEnabled !== false;
    const recentChatListAccelerationEnabled = options.recentChatListAccelerationEnabled !== false;
    const tokenizerBulkCountEnabled = options.tokenizerBulkCountEnabled !== false;
    const extensionManifestBundleEnabled = options.extensionManifestBundleEnabled !== false;

    return `/* baibaoku early bridge v${EARLY_BRIDGE_VERSION} */
(function () {
  'use strict';

  var FLAG = '__baibaokuEarlyBridge';
  var VERSION = ${JSON.stringify(String(EARLY_BRIDGE_VERSION))};
  var FAST_SETTINGS_GET = ${JSON.stringify(fastSettingsGetPath)};
  var FAST_SETTINGS_SAVE = ${JSON.stringify(fastSettingsSavePath)};
  var FAST_CHARACTER_LIST = ${JSON.stringify(fastCharacterListPath)};
  var FAST_RECENT_CHAT_LIST = ${JSON.stringify(fastRecentChatListPath)};
  var EXTENSION_MANIFEST_BUNDLE = ${JSON.stringify(extensionManifestBundlePath)};
  var SETTINGS_ACCELERATION_ENABLED = ${JSON.stringify(settingsAccelerationEnabled)};
  var CHARACTER_LIST_ACCELERATION_ENABLED = ${JSON.stringify(characterListAccelerationEnabled)};
  var RECENT_CHAT_LIST_ACCELERATION_ENABLED = ${JSON.stringify(recentChatListAccelerationEnabled)};
  var TOKENIZER_BULK_COUNT_ENABLED = ${JSON.stringify(tokenizerBulkCountEnabled)};
  var EXTENSION_MANIFEST_BUNDLE_ENABLED = ${JSON.stringify(extensionManifestBundleEnabled)};

  if (window[FLAG] && window[FLAG].installed) {
    return;
  }

  var state = window[FLAG] = window[FLAG] || {};
  var rawFetch = window.fetch && window.fetch.bind(window);

  if (typeof rawFetch !== 'function') {
    state.installed = false;
    state.error = 'window.fetch is unavailable';
    return;
  }

  state.installed = true;
  state.version = VERSION;
  state.installedAt = Date.now();
  state.fastGetPath = FAST_SETTINGS_GET;
  state.fastSavePath = FAST_SETTINGS_SAVE;
  state.fastCharacterListPath = FAST_CHARACTER_LIST;
  state.fastRecentChatListPath = FAST_RECENT_CHAT_LIST;
  state.extensionManifestBundlePath = EXTENSION_MANIFEST_BUNDLE;
  state.requests = state.requests || { get: 0, save: 0, characters: 0, recentChats: 0, extensionBundle: 0, extensionManifest: 0, extensionManifestRefresh: 0, fallback: 0, errors: 0, frontendCache: 0, invalidations: 0, saveFrontendCache: 0 };
  if (typeof state.requests.saveFrontendCache !== 'number') state.requests.saveFrontendCache = 0;
  if (typeof state.requests.recentChats !== 'number') state.requests.recentChats = 0;
  if (typeof state.requests.extensionBundle !== 'number') state.requests.extensionBundle = 0;
  if (typeof state.requests.extensionManifest !== 'number') state.requests.extensionManifest = 0;
  if (typeof state.requests.extensionManifestRefresh !== 'number') state.requests.extensionManifestRefresh = 0;
  state.rawFetch = rawFetch;
  state.settingsGetCache = state.settingsGetCache || null;
  state.settingsGetPending = null;
  state.settingsSaveCache = state.settingsSaveCache || null;
  state.settingsSavePending = null;
  state.extensionManifestBundleCache = state.extensionManifestBundleCache || null;
  state.extensionManifestBundlePending = null;

  function clearExtensionManifestBundleCache(reason) {
    state.extensionManifestBundleCache = null;
    state.extensionManifestBundlePending = null;
    state.lastExtensionManifestBundleInvalidationReason = reason || 'unknown';
    state.lastExtensionManifestBundleInvalidatedAt = Date.now();
  }

  function writeSettingsAccelerationEnabled(enabled) {
    var next = Boolean(enabled);
    state.settingsAccelerationEnabled = next;
    if (!next) {
      clearSettingsGetCache('settings-acceleration-disabled');
    }
    return next;
  }

  state.isSettingsAccelerationEnabled = function () {
    return state.settingsAccelerationEnabled !== false;
  };
  state.setSettingsAccelerationEnabled = writeSettingsAccelerationEnabled;
  state.settingsAccelerationEnabled = SETTINGS_ACCELERATION_ENABLED;

  function writeCharacterListAccelerationEnabled(enabled) {
    state.characterListAccelerationEnabled = Boolean(enabled);
    return state.characterListAccelerationEnabled;
  }

  state.isCharacterListAccelerationEnabled = function () {
    return state.characterListAccelerationEnabled !== false;
  };
  state.setCharacterListAccelerationEnabled = writeCharacterListAccelerationEnabled;
  state.characterListAccelerationEnabled = CHARACTER_LIST_ACCELERATION_ENABLED;

  function writeRecentChatListAccelerationEnabled(enabled) {
    state.recentChatListAccelerationEnabled = Boolean(enabled);
    return state.recentChatListAccelerationEnabled;
  }

  state.isRecentChatListAccelerationEnabled = function () {
    return state.recentChatListAccelerationEnabled !== false;
  };
  state.setRecentChatListAccelerationEnabled = writeRecentChatListAccelerationEnabled;
  state.recentChatListAccelerationEnabled = RECENT_CHAT_LIST_ACCELERATION_ENABLED;

  function writeTokenizerBulkCountEnabled(enabled) {
    state.tokenizerBulkCountEnabled = Boolean(enabled);
    return state.tokenizerBulkCountEnabled;
  }

  state.isTokenizerBulkCountEnabled = function () {
    return state.tokenizerBulkCountEnabled !== false;
  };
  state.setTokenizerBulkCountEnabled = writeTokenizerBulkCountEnabled;
  state.tokenizerBulkCountEnabled = TOKENIZER_BULK_COUNT_ENABLED;

  function writeExtensionManifestBundleEnabled(enabled) {
    state.extensionManifestBundleEnabled = Boolean(enabled);
    if (state.extensionManifestBundleEnabled === false) {
      clearExtensionManifestBundleCache('extension-manifest-bundle-disabled');
    }
    return state.extensionManifestBundleEnabled;
  }

  state.isExtensionManifestBundleEnabled = function () {
    return state.extensionManifestBundleEnabled !== false;
  };
  state.setExtensionManifestBundleEnabled = writeExtensionManifestBundleEnabled;
  state.extensionManifestBundleEnabled = EXTENSION_MANIFEST_BUNDLE_ENABLED;

  function toUrl(input) {
    try {
      if (typeof input === 'string') return new URL(input, location.href);
      if (input instanceof URL) return new URL(input.href, location.href);
      if (input && typeof input.url === 'string') return new URL(input.url, location.href);
    } catch (_) {}
    return null;
  }

  function getMethod(input, init) {
    return String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
  }

  function shouldIntercept(url, method) {
    if (!url || url.origin !== location.origin) return null;
    if (method === 'GET') {
      if (url.pathname === '/api/extensions/discover') return { kind: 'extensionDiscover', fastPath: EXTENSION_MANIFEST_BUNDLE };
      var manifestName = getManifestRequestName(url);
      if (manifestName) return { kind: 'extensionManifest', name: manifestName };
      return null;
    }
    if (method !== 'POST') return null;
    if (url.pathname === '/api/settings/get') return { kind: 'get', fastPath: FAST_SETTINGS_GET };
    if (url.pathname === '/api/settings/save') return { kind: 'save', fastPath: FAST_SETTINGS_SAVE };
    if (url.pathname === '/api/characters/all') return { kind: 'characters', fastPath: FAST_CHARACTER_LIST };
    if (url.pathname === '/api/chats/recent') return { kind: 'recentChats', fastPath: FAST_RECENT_CHAT_LIST };
    return null;
  }

  function getManifestRequestName(url) {
    var match = /^\\/scripts\\/extensions\\/(.+)\\/manifest\\.json$/i.exec(url.pathname || '');
    if (!match) return null;
    try {
      return decodeURIComponent(match[1]);
    } catch (_) {
      return match[1];
    }
  }

  function shouldInvalidateSettingsGetCache(url, method) {
    if (!url || url.origin !== location.origin || method !== 'POST') return false;
    if (url.pathname === '/api/settings/save') return true;
    return [
      '/api/worldinfo/',
      '/api/presets/',
      '/api/themes/',
      '/api/quick-replies/',
      '/api/moving-ui/',
    ].some(function (prefix) {
      return url.pathname.startsWith(prefix);
    });
  }

  function clearSettingsGetCache(reason) {
    if (state.settingsGetCache || state.settingsGetPending) {
      state.requests.invalidations += 1;
    }
    state.settingsGetCache = null;
    state.settingsGetPending = null;
    state.lastInvalidationReason = reason || 'unknown';
    state.lastInvalidatedAt = Date.now();
  }

  function clearSettingsSaveCache(reason) {
    state.settingsSaveCache = null;
    state.settingsSavePending = null;
    state.lastSaveInvalidationReason = reason || 'unknown';
    state.lastSaveInvalidatedAt = Date.now();
  }

  function makeCachedSettingsGetResponse(cache, source) {
    var headers = new Headers(cache.headers || undefined);
    headers.set('content-type', 'application/json; charset=utf-8');
    headers.set('x-baibaoku-frontend-cache', source || 'hit');
    headers.set('x-baibaoku-frontend-cache-age-ms', String(Date.now() - cache.savedAt));
    return new Response(cache.text, {
      status: cache.status || 200,
      statusText: cache.statusText || 'OK',
      headers: headers,
    });
  }

  function makeCachedSettingsSaveResponse(cache, source) {
    var headers = new Headers(cache.headers || undefined);
    headers.set('content-type', 'application/json; charset=utf-8');
    headers.set('x-baibaoku-frontend-save-cache', source || 'hit');
    headers.set('x-baibaoku-frontend-save-cache-age-ms', String(Date.now() - cache.savedAt));
    return new Response(cache.text, {
      status: cache.status || 200,
      statusText: cache.statusText || 'OK',
      headers: headers,
    });
  }

  function makeJsonResponse(data, headers, status) {
    var responseHeaders = new Headers(headers || undefined);
    responseHeaders.set('content-type', 'application/json; charset=utf-8');
    return new Response(JSON.stringify(data), {
      status: status || 200,
      statusText: status && status >= 400 ? 'Error' : 'OK',
      headers: responseHeaders,
    });
  }

  function makeTextResponse(text, status, headers) {
    var responseHeaders = new Headers(headers || undefined);
    responseHeaders.set('content-type', 'text/plain; charset=utf-8');
    return new Response(text || '', {
      status: status || 200,
      statusText: status && status >= 400 ? 'Error' : 'OK',
      headers: responseHeaders,
    });
  }

  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object || {}, key);
  }

  function normalizeExtensionManifestBundle(bundle) {
    if (!bundle || !Array.isArray(bundle.extensions) || !bundle.manifests || typeof bundle.manifests !== 'object') {
      throw new Error('Extension manifest bundle payload is invalid');
    }

    bundle.missing = bundle.missing && typeof bundle.missing === 'object' ? bundle.missing : {};
    bundle.invalid = bundle.invalid && typeof bundle.invalid === 'object' ? bundle.invalid : {};
    return bundle;
  }

  async function fetchExtensionManifestBundle(force) {
    if (!force && state.extensionManifestBundleCache) {
      return state.extensionManifestBundleCache;
    }
    if (!force && state.extensionManifestBundlePending) {
      return state.extensionManifestBundlePending;
    }

    state.requests.extensionBundle += 1;
    state.extensionManifestBundlePending = rawFetch(EXTENSION_MANIFEST_BUNDLE, {
      method: 'GET',
      cache: 'no-store',
    }).then(async function (response) {
      if (!response || !response.ok) {
        throw new Error('Extension manifest bundle request failed: ' + (response ? response.status : 'no response'));
      }

      var bundle = normalizeExtensionManifestBundle(await response.json());
      state.extensionManifestBundleCache = bundle;
      state.lastExtensionManifestBundleAt = Date.now();
      return bundle;
    }).finally(function () {
      state.extensionManifestBundlePending = null;
    });

    return state.extensionManifestBundlePending;
  }

  async function makeExtensionDiscoverResponse() {
    var bundle = await fetchExtensionManifestBundle(false);
    return makeJsonResponse(bundle.extensions, {
      'x-baibaoku-extension-manifest-bundle': 'discover',
    });
  }

  async function makeExtensionManifestResponse(route) {
    var bundle = await fetchExtensionManifestBundle(false);
    var name = route && route.name;

    state.requests.extensionManifest += 1;
    if (hasOwn(bundle.manifests, name)) {
      return makeJsonResponse(bundle.manifests[name], {
        'x-baibaoku-extension-manifest-cache': 'hit',
        'x-baibaoku-extension-name': name,
      });
    }

    if (hasOwn(bundle.invalid, name)) {
      return makeTextResponse('Invalid manifest.json for ' + name, 500, {
        'x-baibaoku-extension-manifest-cache': 'invalid',
        'x-baibaoku-extension-name': name,
      });
    }

    return makeTextResponse('Manifest not found for ' + name, 404, {
      'x-baibaoku-extension-manifest-cache': 'missing',
      'x-baibaoku-extension-name': name,
    });
  }

  function normalizeThirdPartyExtensionName(value) {
    var name = String(value || '').replace(/\\\\/g, '/').trim();
    if (!name) return null;
    name = name.replace(/^\\/+/, '');
    if (name.indexOf('third-party/') === 0) return name;
    if (name === 'third-party') return null;
    if (name.indexOf('third-party') === 0) {
      name = name.slice('third-party'.length).replace(/^\\/+/, '');
    }
    return name ? 'third-party/' + name : null;
  }

  function encodeExtensionManifestPath(name) {
    return String(name || '')
      .split('/')
      .map(function (part) { return encodeURIComponent(part); })
      .join('/');
  }

  function addOrUpdateExtensionEntry(bundle, name, type) {
    if (!bundle || !name) return;
    var extensionType = type || 'local';
    var existing = bundle.extensions.find(function (extension) { return extension && extension.name === name; });
    if (existing) {
      existing.type = extensionType || existing.type;
      return;
    }
    bundle.extensions.push({ type: extensionType, name: name });
  }

  function removeExtensionEntry(bundle, name) {
    if (!bundle || !name) return;
    bundle.extensions = bundle.extensions.filter(function (extension) { return !extension || extension.name !== name; });
    delete bundle.manifests[name];
    delete bundle.invalid[name];
    bundle.missing[name] = {
      message: 'Extension was removed during this page session.',
      removedAt: Date.now(),
    };
  }

  async function refreshCachedExtensionManifest(name) {
    var bundle = state.extensionManifestBundleCache;
    if (!bundle || !name) return;

    state.requests.extensionManifestRefresh += 1;
    var url = '/scripts/extensions/' + encodeExtensionManifestPath(name) + '/manifest.json?baibaoku_refresh=' + Date.now();

    try {
      var response = await rawFetch(url, { method: 'GET', cache: 'no-store' });
      await updateCachedExtensionManifestFromResponse(bundle, name, response);
    } catch (error) {
      delete bundle.manifests[name];
      delete bundle.missing[name];
      bundle.invalid[name] = {
        message: error && error.message ? error.message : String(error),
        refreshedAt: Date.now(),
      };
    }
  }

  async function updateCachedExtensionManifestFromResponse(bundle, name, response) {
    delete bundle.manifests[name];
    delete bundle.missing[name];
    delete bundle.invalid[name];

    if (!response || !response.ok) {
      bundle.missing[name] = {
        status: response ? response.status : 0,
        statusText: response ? response.statusText : '',
        refreshedAt: Date.now(),
      };
      return;
    }

    try {
      var manifest = await response.json();
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        throw new Error('Manifest is not a valid JSON object.');
      }
      bundle.manifests[name] = manifest;
    } catch (error) {
      bundle.invalid[name] = {
        message: error && error.message ? error.message : String(error),
        refreshedAt: Date.now(),
      };
    }
  }

  async function refreshExtensionManifestCacheAfterMutation(url, input, init, response) {
    if (!state.extensionManifestBundleCache || !response || !response.ok || !url || url.origin !== location.origin || getMethod(input, init) !== 'POST') {
      return;
    }

    var path = url.pathname;
    if (path !== '/api/extensions/install'
      && path !== '/api/extensions/delete'
      && path !== '/api/extensions/update'
      && path !== '/api/extensions/move'
      && path !== '/api/extensions/switch') {
      return;
    }

    var body = await readJsonBody(input, init) || {};
    var bundle = state.extensionManifestBundleCache;
    var name = normalizeThirdPartyExtensionName(body.extensionName);

    if (path === '/api/extensions/install') {
      var installPayload = await response.clone().json().catch(function () { return null; });
      name = normalizeThirdPartyExtensionName(installPayload && installPayload.folderName);
      if (name) {
        addOrUpdateExtensionEntry(bundle, name, body.global ? 'global' : 'local');
        await refreshCachedExtensionManifest(name);
      }
      return;
    }

    if (!name) return;

    if (path === '/api/extensions/delete') {
      removeExtensionEntry(bundle, name);
      return;
    }

    if (path === '/api/extensions/move') {
      addOrUpdateExtensionEntry(bundle, name, body.destination === 'global' ? 'global' : 'local');
      await refreshCachedExtensionManifest(name);
      return;
    }

    await refreshCachedExtensionManifest(name);
  }

  async function cacheSettingsGetResponse(response) {
    var text = await response.clone().text();
    var headers = {};
    response.headers.forEach(function (value, key) {
      if (!/^content-encoding$/i.test(key) && !/^content-length$/i.test(key)) {
        headers[key] = value;
      }
    });
    state.settingsGetCache = {
      text: text,
      headers: headers,
      status: response.status,
      statusText: response.statusText,
      savedAt: Date.now(),
    };
    return state.settingsGetCache;
  }

  async function cacheSettingsSaveResponse(response, saveKey) {
    var text = await response.clone().text();
    var headers = {};
    response.headers.forEach(function (value, key) {
      if (!/^content-encoding$/i.test(key) && !/^content-length$/i.test(key)) {
        headers[key] = value;
      }
    });
    var cache = {
      key: saveKey,
      text: text,
      headers: headers,
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
      skipped: response.headers.get('x-baibaoku-save-skipped') === 'true',
      savedAt: Date.now(),
    };
    if (response.ok) {
      state.settingsSaveCache = cache;
    }
    return cache;
  }

  async function getReplayBody(input, init, method) {
    if (method === 'GET' || method === 'HEAD') return undefined;
    if (init && Object.prototype.hasOwnProperty.call(init, 'body')) return init.body;
    try {
      if (input instanceof Request) return await input.clone().arrayBuffer();
    } catch (_) {}
    return undefined;
  }

  function parseJsonOrNull(text) {
    try {
      return JSON.parse(text);
    } catch (_) {
      return null;
    }
  }

  function parseJsonResult(text) {
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch (_) {
      return { ok: false, value: null };
    }
  }

  async function bodyToText(body) {
    if (body === undefined || body === null) return '';
    if (typeof body === 'string') return body;
    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return body.toString();
    if (typeof Blob !== 'undefined' && body instanceof Blob) return await body.text();
    if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
    if (ArrayBuffer.isView(body)) return new TextDecoder().decode(body);
    return null;
  }

  async function getSettingsSaveKey(body) {
    var text = await bodyToText(body);
    if (text === null) return null;
    var parsed = parseJsonResult(text || '{}');
    if (!parsed.ok) return null;
    return JSON.stringify(parsed.value == null ? {} : parsed.value, null, 4);
  }

  async function gzipFastSaveInit(init) {
    var headers = new Headers(init.headers || undefined);
    if (headers.has('content-encoding')) return init;
    if (typeof CompressionStream !== 'function') return init;

    var text = await bodyToText(init.body);
    if (text === null || !text) return init;

    try {
      var encoded = new TextEncoder().encode(text);
      var compressed = await new Response(
        new Blob([encoded]).stream().pipeThrough(new CompressionStream('gzip'))
      ).arrayBuffer();

      if (!compressed || compressed.byteLength >= encoded.byteLength) {
        return init;
      }

      headers.set('content-encoding', 'gzip');
      headers.delete('content-length');
      state.lastFastSaveCompression = {
        encoding: 'gzip',
        originalBytes: encoded.byteLength,
        compressedBytes: compressed.byteLength,
        compressedAt: Date.now(),
      };

      return {
        ...init,
        headers: headers,
        body: compressed,
      };
    } catch (error) {
      state.lastFastSaveCompressionError = error && error.message ? error.message : String(error);
      return init;
    }
  }

  function isPlainEmptyObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
  }

  async function readJsonBody(input, init) {
    if (init && Object.prototype.hasOwnProperty.call(init, 'body')) {
      var body = init.body;
      if (typeof body === 'string') return parseJsonOrNull(body);
      if (body && typeof body.text === 'function') return parseJsonOrNull(await body.text());
      return null;
    }

    try {
      if (input instanceof Request && !input.bodyUsed && input.body) {
        return await input.clone().json().catch(function () { return null; });
      }
    } catch (_) {}
    return null;
  }

  async function shouldUseFastRoute(route, input, init) {
    if (!route) return false;
    if (route.kind === 'extensionDiscover' || route.kind === 'extensionManifest') {
      return state.extensionManifestBundleEnabled !== false;
    }
    if (route.kind === 'characters') {
      if (state.characterListAccelerationEnabled === false) return false;
      return isPlainEmptyObject(await readJsonBody(input, init));
    }
    if (route.kind === 'recentChats') {
      return state.recentChatListAccelerationEnabled !== false;
    }
    return state.settingsAccelerationEnabled !== false;
  }

  async function makeFastInit(input, init, method) {
    var next = {};
    if (input instanceof Request) {
      next.credentials = input.credentials;
      next.cache = input.cache;
      next.redirect = input.redirect;
      next.referrer = input.referrer;
      next.referrerPolicy = input.referrerPolicy;
      next.integrity = input.integrity;
      next.keepalive = input.keepalive;
      next.mode = input.mode;
      next.signal = input.signal;
      next.headers = new Headers(input.headers);
    }
    if (init && typeof init === 'object') {
      Object.assign(next, init);
      next.headers = new Headers(init.headers || next.headers || undefined);
    }
    next.method = method;
    next.cache = 'no-store';
    next.body = await getReplayBody(input, init, method);
    if (!next.headers) next.headers = new Headers();
    if (method !== 'GET' && method !== 'HEAD' && !next.headers.has('content-type')) {
      next.headers.set('content-type', 'application/json');
    }
    return next;
  }

  async function callOriginal(input, init) {
    state.requests.fallback += 1;
    return rawFetch(input, init);
  }

  window.fetch = async function baibaokuEarlyFetch(input, init) {
    var url = toUrl(input);
    var method = getMethod(input, init);
    var route = shouldIntercept(url, method);

    if (!await shouldUseFastRoute(route, input, init)) {
      var originalResponse = await rawFetch(input, init);
      try {
        await refreshExtensionManifestCacheAfterMutation(url, input, init, originalResponse);
      } catch (error) {
        state.requests.errors += 1;
        state.lastExtensionManifestRefreshError = error && error.message ? error.message : String(error);
      }
      if (originalResponse && originalResponse.ok && shouldInvalidateSettingsGetCache(url, method)) {
        clearSettingsGetCache('mutation:' + url.pathname);
        if (url.pathname === '/api/settings/save') {
          clearSettingsSaveCache('mutation:' + url.pathname);
        }
      }
      return originalResponse;
    }

    try {
      if (route.kind === 'extensionDiscover') {
        return await makeExtensionDiscoverResponse();
      }

      if (route.kind === 'extensionManifest') {
        return await makeExtensionManifestResponse(route);
      }

      state.requests[route.kind] += 1;

      if (route.kind === 'get') {
        if (state.settingsGetCache) {
          state.requests.frontendCache += 1;
          return makeCachedSettingsGetResponse(state.settingsGetCache, 'hit');
        }
        if (state.settingsGetPending) {
          state.requests.frontendCache += 1;
          var pendingCache = await state.settingsGetPending;
          return makeCachedSettingsGetResponse(pendingCache, 'pending');
        }
      }

      var fastInit = await makeFastInit(input, init, method);

      if (route.kind === 'save') {
        var saveKey = await getSettingsSaveKey(fastInit.body);
        if (saveKey && state.settingsSavePending && state.settingsSavePending.key === saveKey) {
          state.requests.frontendCache += 1;
          state.requests.saveFrontendCache += 1;
          var pendingSaveCache = await state.settingsSavePending.promise;
          if (pendingSaveCache && pendingSaveCache.ok) {
            return makeCachedSettingsSaveResponse(pendingSaveCache, 'pending');
          }
          return callOriginal(input, init);
        }
        if (saveKey && !state.settingsSavePending && state.settingsSaveCache && state.settingsSaveCache.key === saveKey) {
          state.requests.frontendCache += 1;
          state.requests.saveFrontendCache += 1;
          return makeCachedSettingsSaveResponse(state.settingsSaveCache, 'hit');
        }

        fastInit = await gzipFastSaveInit(fastInit);
        var saveResponsePromise = rawFetch(route.fastPath, fastInit);
        if (saveKey) {
          var saveCachePromise = saveResponsePromise
            .then(function (saveResponse) {
              return cacheSettingsSaveResponse(saveResponse, saveKey);
            })
            .catch(function (error) {
              state.requests.errors += 1;
              state.lastSaveCacheError = error && error.message ? error.message : String(error);
              return null;
            })
            .finally(function () {
              if (state.settingsSavePending && state.settingsSavePending.key === saveKey) {
                state.settingsSavePending = null;
              }
            });
          state.settingsSavePending = { key: saveKey, promise: saveCachePromise };
        }

        var saveResponse = await saveResponsePromise;
        if (saveResponse && saveResponse.ok) {
          if (saveResponse.headers.get('x-baibaoku-save-skipped') !== 'true') {
            clearSettingsGetCache('save');
          }
          return saveResponse;
        }
        return callOriginal(input, init);
      }

      var response = await rawFetch(route.fastPath, fastInit);
      if (response && response.ok) {
        if (route.kind === 'get') {
          state.settingsGetPending = cacheSettingsGetResponse(response)
            .catch(function (error) {
              state.requests.errors += 1;
              state.lastCacheError = error && error.message ? error.message : String(error);
              state.settingsGetCache = null;
              throw error;
            })
            .finally(function () {
              state.settingsGetPending = null;
            });
        } else if (route.kind === 'characters') {
          var characterData = await response.clone().json().catch(function () { return null; });
          if (!Array.isArray(characterData)) {
            throw new Error('Fast character list returned a non-array payload');
          }
        } else if (route.kind === 'recentChats') {
          var recentChatData = await response.clone().json().catch(function () { return null; });
          if (!Array.isArray(recentChatData)) {
            throw new Error('Fast recent chat list returned a non-array payload');
          }
        }
        return response;
      }
      return callOriginal(input, init);
    } catch (error) {
      state.requests.errors += 1;
      state.lastError = error && error.message ? error.message : String(error);
      return callOriginal(input, init);
    }
  };
})();
`;
}

/**
 * Count tokens for a single message using the appropriate tokenizer.
 * Mimics the per-message behavior of ST's /api/tokenizers/openai/count
 * when called with a single-element array.
 * @param {string} model - Raw query model name
 * @param {string} resolvedModel - Resolved tokenizer model name
 * @param {object} msg - Single message object
 * @returns {Promise<number>} Token count for this message
 */
async function countSingleMessageBulk(model, resolvedModel, msg) {
    // 1. WebTokenizer models (claude, llama3, deepseek, qwen2, command-r/a, nemo)
    const webTokenizer = getWebTokenizer(resolvedModel);
    if (webTokenizer) {
        const instance = await webTokenizer.get();
        if (instance) return countWebTokenizerTokens(instance, [msg]);
        return guesstimateBulk(JSON.stringify([msg]));
    }

    // 2. SentencePiece models (llama, mistral, yi, gemma, jamba, nerdstash)
    const sppTokenizer = getSentencepiceTokenizer(resolvedModel);
    if (sppTokenizer) {
        return await countSentencepieceArrayTokensBulk(sppTokenizer, [msg]);
    }

    // 3. Default: tiktoken models (gpt-3.5, gpt-4, gpt-4o, o1, etc.)
    const tokensPerName = model.includes('gpt-3.5-turbo-0301') ? -1 : 1;
    const tokensPerMessage = model.includes('gpt-3.5-turbo-0301') ? 4 : 3;
    const tokensPadding = 3;
    const tokenizer = getTiktokenTokenizer(resolvedModel);

    let count = tokensPerMessage + tokensPadding;
    for (const [key, value] of Object.entries(msg)) {
        count += tokenizer.encode(String(value ?? '')).length;
        if (key === 'name') count += tokensPerName;
    }
    if (model.includes('gpt-3.5-turbo-0301')) count += 9;
    return count;
}

async function countSentencepieceArrayTokensBulk(tokenizer, array) {
    const jsonBody = array.flatMap(x => Object.values(x)).join('\n\n');
    const result = await countSentencepieceTokensBulk(tokenizer, jsonBody);
    return result.count;
}

async function countSentencepieceTokensBulk(tokenizer, text) {
    const instance = await tokenizer?.get();

    if (!instance) {
        return {
            ids: [],
            count: guesstimateBulk(text),
        };
    }

    const ids = instance.encodeIds(text);
    return {
        ids,
        count: ids.length,
    };
}

function guesstimateBulk(str) {
    const byteLength = Buffer.byteLength(str, 'utf8');
    return Math.ceil(byteLength / 3.35);
}

export function closeStEndpointCaches() {
    closeSaveGenerateJobs();

    for (const userCache of settingsUserCaches.values()) {
        for (const watcher of userCache.payloadWatchers?.values() || []) {
            watcher.close();
        }
    }

    settingsUserCaches.clear();
    settingsUpdateLocks.clear();
    settingsFileCaches.clear();
    settingsSaveLocks.clear();
    settingsResponseCaches.clear();
    for (const scheduler of settingsBackupSchedulers.values()) {
        if (scheduler.timer) {
            clearTimeout(scheduler.timer);
        }
    }
    settingsBackupSchedulers.clear();
    lastBackupTexts.clear();
}

export function registerStEndpoints(router, manager) {
    registerSaveGenerateEndpoints(router);

    router.get('/v1/extensions/manifest-bundle', (req, res) => {
        try {
            res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
            res.json(buildExtensionManifestBundle(req));
        } catch (error) {
            console.error('[baibaoku] Error in extension manifest bundle endpoint:', error);
            res.status(500).json({ error: true, message: error.message });
        }
    });

    router.get('/v1/early/bridge.js', async (req, res) => {
        try {
            const config = await getSettingsFastConfigSafe(req, manager);
            res.type('application/javascript; charset=utf-8');
            res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
            res.send(makeEarlyBridgeScript(config));
        } catch (error) {
            console.error('[baibaoku] Error in early bridge endpoint:', error);
            res.status(500).type('application/javascript; charset=utf-8').send(`console.error(${JSON.stringify(error.message)});`);
        }
    });

    router.post('/v1/characters/fast-all', async (req, res) => {
        try {
            const userHandle = req.user?.profile?.handle;
            if (!userHandle) {
                return res.status(401).json({ error: true, message: 'Unauthorized' });
            }

            const charactersDir = req.user.directories.characters;

            // 1. Concurrency control: if this user is already updating, wait for it
            if (!updateLocks.has(userHandle)) {
                const updatePromise = updateCacheForUser(req, manager, userHandle, charactersDir)
                    .finally(() => updateLocks.delete(userHandle));
                updateLocks.set(userHandle, updatePromise);
            }

            // 2. Await the update lock (whether we created it or someone else did)
            const cache = await updateLocks.get(userHandle);

            // 3. Return the cached data as an array
            const dataArray = Array.from(cache.values()).map(item => item.data);
            res.json(dataArray);

        } catch (error) {
            console.error('[baibaoku] Error in fast-all endpoint:', error);
            res.status(500).json({ error: true, message: error.message });
        }
    });

    router.post('/v1/chats/fast-recent', async (req, res) => {
        try {
            const { data, metrics } = await getFastRecentChats(req);

            res.set('X-Baibaoku-Elapsed-Ms', String(metrics.totalMs));
            res.set('X-Baibaoku-Recent-Selected-Files', String(metrics.selectedFiles));
            res.set('X-Baibaoku-Recent-Character-Files', String(metrics.characterFiles));
            res.set('X-Baibaoku-Recent-Group-Files', String(metrics.groupFiles));
            res.set('X-Baibaoku-Recent-Root-Files', String(metrics.rootFiles));
            res.json(data);
        } catch (error) {
            console.error('[baibaoku] Error in fast-recent endpoint:', error);
            res.status(error.status || 500).json({ error: true, message: error.message });
        }
    });

    router.post('/v1/chats/fast-get', async (req, res) => {
        try {
            const result = await getFastChatGet(req);

            res.set('X-Baibaoku-Elapsed-Ms', String(result.meta.elapsedMs || 0));
            res.set('X-Baibaoku-Chat-Kind', String(result.kind));
            res.set('X-Baibaoku-Chat-Partial', String(result.meta.partial === true));
            res.set('X-Baibaoku-Chat-Total-Messages', String(result.meta.totalMessages || 0));
            res.json({
                ok: true,
                data: result,
            });
        } catch (error) {
            console.error('[baibaoku] Error in fast-get endpoint:', error);
            res.status(error.status || 500).json({ ok: false, error: true, message: error.message });
        }
    });

    router.get('/v1/fast-config', async (req, res) => {
        try {
            const userHandle = req.user?.profile?.handle;
            if (!userHandle) {
                return res.status(401).json({ error: true, message: 'Unauthorized' });
            }

            res.json({
                ok: true,
                data: await getSettingsFastConfig(req, manager),
            });
        } catch (error) {
            console.error('[baibaoku] Error in fast-config endpoint:', error);
            res.status(500).json({ ok: false, error: true, message: error.message });
        }
    });

    router.post('/v1/fast-config', async (req, res) => {
        try {
            const userHandle = req.user?.profile?.handle;
            if (!userHandle) {
                return res.status(401).json({ error: true, message: 'Unauthorized' });
            }

            res.json({
                ok: true,
                data: await setSettingsFastConfig(req, manager),
            });
        } catch (error) {
            console.error('[baibaoku] Error in fast-config endpoint:', error);
            res.status(500).json({ ok: false, error: true, message: error.message });
        }
    });

    router.get('/v1/settings/fast-config', async (req, res) => {
        try {
            const userHandle = req.user?.profile?.handle;
            if (!userHandle) {
                return res.status(401).json({ error: true, message: 'Unauthorized' });
            }

            res.json({
                ok: true,
                data: await getSettingsFastConfig(req, manager),
            });
        } catch (error) {
            console.error('[baibaoku] Error in settings fast-config endpoint:', error);
            res.status(500).json({ ok: false, error: true, message: error.message });
        }
    });

    router.post('/v1/settings/fast-config', async (req, res) => {
        try {
            const userHandle = req.user?.profile?.handle;
            if (!userHandle) {
                return res.status(401).json({ error: true, message: 'Unauthorized' });
            }

            res.json({
                ok: true,
                data: await setSettingsFastConfig(req, manager),
            });
        } catch (error) {
            console.error('[baibaoku] Error in settings fast-config endpoint:', error);
            res.status(500).json({ ok: false, error: true, message: error.message });
        }
    });

    router.post('/v1/settings/fast-save', async (req, res) => {
        const startedAt = Date.now();

        try {
            const userHandle = req.user?.profile?.handle;
            if (!userHandle) {
                return res.status(401).json({ error: true, message: 'Unauthorized' });
            }

            const result = await queueSettingsSave(userHandle, () => saveSettingsWithCache(req, userHandle));

            res.set('X-Baibaoku-Elapsed-Ms', String(Date.now() - startedAt));
            if (result.skipped) {
                res.set('X-Baibaoku-Save-Skipped', 'true');
            }
            res.json(result);
            scheduleSettingsResponseWarmup(req, userHandle, result.skipped ? 'fast-save-skipped' : 'fast-save');

            // Trigger backup after responding; the backup task is throttled and non-blocking.
            if (!result.skipped) {
                scheduleSettingsAutoBackup(req, userHandle);
            }
        } catch (error) {
            console.error('[baibaoku] Error in settings fast-save endpoint:', error);
            res.status(500).json({ error: true, message: error.message });
        }
    });

    router.post('/v1/settings/fast-get', async (req, res) => {
        const startedAt = Date.now();

        try {
            const metrics = {};
            const userHandle = req.user?.profile?.handle;
            if (!userHandle) {
                return res.status(401).json({ error: true, message: 'Unauthorized' });
            }

            await waitForPendingSettingsSave(userHandle);
            const settingsStartedAt = Date.now();
            const settingsPromise = readSettingsTextWithCache(req, userHandle)
                .then((settingsInfo) => {
                    metrics.settingsMs = Date.now() - settingsStartedAt;
                    metrics.settingsCache = settingsInfo.cacheStatus || (settingsInfo.cacheHit ? 'hit' : 'miss');
                    return settingsInfo;
                });

            if (!settingsUpdateLocks.has(userHandle)) {
                const updatePromise = getFastSettingsPayload(req, userHandle, metrics)
                    .finally(() => settingsUpdateLocks.delete(userHandle));
                settingsUpdateLocks.set(userHandle, updatePromise);
            } else {
                metrics.payloadCache = 'shared';
            }

            const payloadStartedAt = Date.now();
            const [settingsInfo, cachedPayload] = await Promise.all([
                settingsPromise,
                settingsUpdateLocks.get(userHandle),
            ]);
            metrics.payloadMs = Date.now() - payloadStartedAt;
            ensureSettingsPayloadPersisted(req, userHandle);

            const staticStartedAt = Date.now();
            const staticPayload = await getStaticSettingsPayload();
            metrics.staticMs = Date.now() - staticStartedAt;

            const responseStartedAt = Date.now();
            const response = await getFastSettingsResponse(
                req,
                userHandle,
                settingsInfo,
                cachedPayload,
                staticPayload,
            );
            metrics.responseMs = Date.now() - responseStartedAt;
            metrics.responseCache = response.cacheStatus || (response.cacheHit ? 'hit' : 'miss');
            metrics.totalMs = Date.now() - startedAt;

            res.type('application/json; charset=utf-8');
            res.set('Cache-Control', 'no-cache');
            res.set('X-Baibaoku-Elapsed-Ms', String(metrics.totalMs));
            res.set('X-Baibaoku-Settings-Cache', metrics.settingsCache);
            res.set('X-Baibaoku-Payload-Cache', metrics.payloadCache);
            if (metrics.payloadDirtyReason) {
                res.set('X-Baibaoku-Payload-Dirty-Reason', metrics.payloadDirtyReason.slice(0, 512));
                res.set('X-Baibaoku-Payload-Dirty-Age-Ms', String(metrics.payloadDirtyAgeMs || 0));
            }
            res.set('X-Baibaoku-Response-Cache', metrics.responseCache);
            res.set('X-Baibaoku-Response-Encoding', response.encoding);
            res.set('Server-Timing', [
                `settings;dur=${metrics.settingsMs}`,
                `payload;dur=${metrics.payloadMs}`,
                `static;dur=${metrics.staticMs}`,
                `response;dur=${metrics.responseMs}`,
                `total;dur=${metrics.totalMs}`,
            ].join(', '));
            res.send(response.body);
        } catch (error) {
            console.error('[baibaoku] Error in settings fast-get endpoint:', error);
            res.status(500).json({ error: true, message: error.message });
        }
    });

    router.post('/v1/tokenizers/bulk-count', async (req, res) => {
        try {
            const model = String(req.body?.model || 'gpt-3.5-turbo');
            const messages = req.body?.messages;
            if (!Array.isArray(messages) || messages.length === 0) {
                return res.status(400).json({ ok: false, error: { message: 'messages must be a non-empty array' } });
            }

            const resolvedModel = getTokenizerModel(model);
            const counts = await Promise.all(messages.map(msg =>
                countSingleMessageBulk(model, resolvedModel, msg)));

            res.json({
                ok: true,
                data: {
                    counts,
                    token_count: counts.reduce((a, b) => a + b, 0),
                },
            });
        } catch (error) {
            console.error('[baibaoku] Error in bulk-count endpoint:', error);
            res.status(500).json({ ok: false, error: { message: error.message } });
        }
    });
}
