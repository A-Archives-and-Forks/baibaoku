import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import bytes from 'bytes';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { parse } from '../../../src/character-card-parser.js';
import { SETTINGS_FILE } from '../../../src/constants.js';
import { PLUGIN_ID } from './constants.js';

const FAST_CHARACTER_CACHE_DATABASE = 'baibaoku.internal';
const FAST_CHARACTER_CACHE_STORE = 'character-fast-all';
const FAST_CHARACTER_CACHE_VERSION = 1;
const FAST_CHARACTER_CACHE_PAGE_SIZE = 1000;
const SETTINGS_FAST_CONFIG_DATABASE = 'baibaoku.internal';
const SETTINGS_FAST_CONFIG_STORE = 'fast-config';
const SETTINGS_FAST_CONFIG_KEY = 'global';
const DEFAULT_SETTINGS_ACCELERATION_ENABLED = true;
const DEFAULT_CHARACTER_LIST_ACCELERATION_ENABLED = true;
const SETTINGS_TEXT_PERSIST_VERSION = 1;
const SETTINGS_TEXT_PERSIST_FILE = 'settings-text-v1.json';
const SETTINGS_PAYLOAD_PERSIST_VERSION = 1;
const SETTINGS_PAYLOAD_PERSIST_FILE = 'settings-payload-v1.json';
const SETTINGS_RESPONSE_PERSIST_VERSION = 1;
const SETTINGS_RESPONSE_META_FILE = 'settings-response-v1.json';
const SETTINGS_RESPONSE_BODY_FILE = 'settings-response-v1.body';
const SETTINGS_RESPONSE_GZIP_FILE = 'settings-response-v1.gzip';
const SETTINGS_RESPONSE_BR_FILE = 'settings-response-v1.br';
const BROTLI_FAST_OPTIONS = {
    params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 4,
    },
};

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
// Cache structure: Map<userHandle, { key: string, text?: string, gzipBuffer?: Buffer, brBuffer?: Buffer }>
const settingsResponseCaches = new Map();
let staticSettingsPayload = null;
const EARLY_BRIDGE_VERSION = '0.4';

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

function getSettingsResponseGzipPath(req) {
    return path.join(getBaibaokuCacheDirectory(req), SETTINGS_RESPONSE_GZIP_FILE);
}

function getSettingsResponseBrPath(req) {
    return path.join(getBaibaokuCacheDirectory(req), SETTINGS_RESPONSE_BR_FILE);
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

async function getFastSettingsResponse(req, userHandle, settingsInfo, cachedPayload, staticPayload, encoding, metrics = {}) {
    const key = getFastSettingsResponseKey(userHandle, settingsInfo, staticPayload);
    const cached = settingsResponseCaches.get(userHandle);

    if (cached?.key === key) {
        const body = getFastSettingsResponseBody(cached, encoding, metrics);
        if (body !== null) {
            return {
                cacheHit: true,
                cacheStatus: 'hit',
                encoding,
                body,
            };
        }

        return restoreOrBuildFastSettingsResponseCache(req, userHandle, key, settingsInfo, cachedPayload, staticPayload, encoding, metrics);
    }

    return restoreOrBuildFastSettingsResponseCache(req, userHandle, key, settingsInfo, cachedPayload, staticPayload, encoding, metrics);
}

async function restoreOrBuildFastSettingsResponseCache(req, userHandle, key, settingsInfo, cachedPayload, staticPayload, encoding, metrics = {}) {
    const restored = await restoreFastSettingsResponseCache(req, userHandle, key, encoding, metrics);
    if (restored) {
        return {
            cacheHit: true,
            cacheStatus: 'persistent-hit',
            encoding: restored.encoding,
            body: restored.body,
        };
    }

    const nextCache = buildFastSettingsResponseCache(key, settingsInfo, cachedPayload, staticPayload, encoding, metrics);
    settingsResponseCaches.set(userHandle, nextCache);
    schedulePersistFastSettingsResponse(req, userHandle, nextCache);

    return {
        cacheHit: false,
        cacheStatus: 'miss',
        encoding,
        body: getFastSettingsResponseBody(nextCache, encoding, metrics),
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

function buildFastSettingsResponseCache(key, settingsInfo, cachedPayload, staticPayload, encoding, metrics = {}) {
    const text = JSON.stringify({
        settings: settingsInfo.text,
        ...cachedPayload,
        ...staticPayload,
    });
    const nextCache = { key, text };

    getFastSettingsResponseBody(nextCache, encoding, metrics);

    return nextCache;
}

function getFastSettingsResponseBody(responseCache, encoding, metrics = {}) {
    if (encoding === 'identity') {
        return typeof responseCache.text === 'string' ? responseCache.text : null;
    }

    if (encoding === 'gzip') {
        if (!responseCache.gzipBuffer && typeof responseCache.text === 'string') {
            const startedAt = Date.now();
            responseCache.gzipBuffer = zlib.gzipSync(responseCache.text, { level: 1 });
            metrics.gzipMs = Date.now() - startedAt;
            metrics.compressMs = (metrics.compressMs || 0) + metrics.gzipMs;
        }
        return responseCache.gzipBuffer || null;
    }

    if (encoding === 'br') {
        if (!responseCache.brBuffer && typeof responseCache.text === 'string') {
            const startedAt = Date.now();
            responseCache.brBuffer = zlib.brotliCompressSync(responseCache.text, BROTLI_FAST_OPTIONS);
            metrics.brMs = Date.now() - startedAt;
            metrics.compressMs = (metrics.compressMs || 0) + metrics.brMs;
        }
        return responseCache.brBuffer || null;
    }

    return null;
}

async function restoreFastSettingsResponseCache(req, userHandle, key, encoding, metrics = {}) {
    let meta;

    try {
        meta = JSON.parse(await fs.promises.readFile(getSettingsResponseMetaPath(req), 'utf8'));
    } catch {
        return null;
    }

    if (meta?.version !== SETTINGS_RESPONSE_PERSIST_VERSION || meta.key !== key) {
        return null;
    }

    if (encoding === 'gzip' && meta.hasGzip) {
        try {
            const gzipBuffer = await fs.promises.readFile(getSettingsResponseGzipPath(req));
            settingsResponseCaches.set(userHandle, { key, gzipBuffer });
            return {
                encoding: 'gzip',
                body: gzipBuffer,
            };
        } catch {
            // Fall through to the persisted plain body if the compressed sidecar is missing.
        }
    }

    if (encoding === 'br' && meta.hasBr) {
        try {
            const brBuffer = await fs.promises.readFile(getSettingsResponseBrPath(req));
            settingsResponseCaches.set(userHandle, { key, brBuffer });
            return {
                encoding: 'br',
                body: brBuffer,
            };
        } catch {
            // Fall through to the persisted plain body if the compressed sidecar is missing.
        }
    }

    try {
        const text = await fs.promises.readFile(getSettingsResponseBodyPath(req), 'utf8');
        const cache = { key, text };
        const body = getFastSettingsResponseBody(cache, encoding, metrics);

        if (body === null) {
            return null;
        }

        settingsResponseCaches.set(userHandle, cache);
        if (encoding !== 'identity') {
            schedulePersistFastSettingsResponse(req, userHandle, cache);
        }
        return {
            encoding,
            body,
        };
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

    const gzipBuffer = responseCache.gzipBuffer || zlib.gzipSync(responseCache.text, { level: 1 });
    const brBuffer = responseCache.brBuffer || zlib.brotliCompressSync(responseCache.text, BROTLI_FAST_OPTIONS);

    await writeFileAtomicAsync(getSettingsResponseBodyPath(req), responseCache.text);
    await writeFileAtomicAsync(getSettingsResponseGzipPath(req), gzipBuffer);
    await writeFileAtomicAsync(getSettingsResponseBrPath(req), brBuffer);
    await writeFileAtomicAsync(getSettingsResponseMetaPath(req), JSON.stringify({
        version: SETTINGS_RESPONSE_PERSIST_VERSION,
        savedAt: Date.now(),
        key: responseCache.key,
        hasBody: true,
        hasGzip: true,
        hasBr: true,
        bodyFile: SETTINGS_RESPONSE_BODY_FILE,
        gzipFile: SETTINGS_RESPONSE_GZIP_FILE,
        brFile: SETTINGS_RESPONSE_BR_FILE,
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
    const nextCache = buildFastSettingsResponseCache(key, settingsInfo, cachedPayload, staticPayload, 'gzip');

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

function getRequestAcceptedEncodings(req) {
    const acceptEncoding = String(req.headers?.['accept-encoding'] || '');

    return {
        br: /\bbr\b/i.test(acceptEncoding),
        gzip: /\bgzip\b/i.test(acceptEncoding),
    };
}

function getFastSettingsResponseEncoding(req) {
    const accepted = getRequestAcceptedEncodings(req);
    const clientIp = getRequestClientIp(req);
    const isLocalNetwork = isLocalOrPrivateIp(clientIp);

    if (!isLocalNetwork && accepted.br) {
        return 'br';
    }

    if (accepted.gzip) {
        return 'gzip';
    }

    if (accepted.br) {
        return 'br';
    }

    return 'identity';
}

function getRequestClientIp(req) {
    const forwardedFor = String(req.headers?.['x-forwarded-for'] || '').split(',')[0];
    const forwarded = parseForwardedHeaderClientIp(req.headers?.forwarded);

    return normalizeClientIp(
        forwardedFor
        || req.headers?.['x-real-ip']
        || forwarded
        || req.ip
        || req.socket?.remoteAddress
        || req.connection?.remoteAddress
        || '',
    );
}

function parseForwardedHeaderClientIp(value) {
    const match = String(value || '').match(/(?:^|[;,]\s*)for=(?:"?\[?)([^";,\]\s]+)(?:\]?"?)?/i);
    return match ? match[1] : '';
}

function normalizeClientIp(value) {
    let ip = String(value || '').trim();

    if (!ip) {
        return '';
    }

    ip = ip.replace(/^"|"$/g, '');

    if (ip.startsWith('[')) {
        const bracketEnd = ip.indexOf(']');
        if (bracketEnd !== -1) {
            ip = ip.slice(1, bracketEnd);
        }
    } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(ip)) {
        ip = ip.replace(/:\d+$/, '');
    }

    if (ip.toLowerCase().startsWith('::ffff:')) {
        ip = ip.slice(7);
    }

    return ip.toLowerCase();
}

function isLocalOrPrivateIp(ip) {
    if (!ip) {
        return true;
    }

    if (ip === 'localhost' || ip === '::1' || ip === '0:0:0:0:0:0:0:1') {
        return true;
    }

    const ipv4 = parseIpv4(ip);
    if (ipv4) {
        const [first, second] = ipv4;
        return first === 10
            || first === 127
            || (first === 172 && second >= 16 && second <= 31)
            || (first === 192 && second === 168)
            || (first === 169 && second === 254);
    }

    return ip.startsWith('fc')
        || ip.startsWith('fd')
        || ip.startsWith('fe80:')
        || ip === '::';
}

function parseIpv4(value) {
    const parts = String(value || '').split('.');
    if (parts.length !== 4) {
        return null;
    }

    const numbers = parts.map((part) => {
        if (!/^\d{1,3}$/.test(part)) {
            return NaN;
        }
        return Number(part);
    });

    return numbers.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
        ? numbers
        : null;
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
        };
    }
}

function makeEarlyBridgeScript(options = {}) {
    const apiPrefix = `/api/plugins/${PLUGIN_ID}`;
    const fastSettingsGetPath = `${apiPrefix}/v1/settings/fast-get`;
    const fastSettingsSavePath = `${apiPrefix}/v1/settings/fast-save`;
    const fastCharacterListPath = `${apiPrefix}/v1/characters/fast-all`;
    const settingsAccelerationEnabled = options.settingsAccelerationEnabled !== false;
    const characterListAccelerationEnabled = options.characterListAccelerationEnabled !== false;

    return `/* baibaoku early bridge v${EARLY_BRIDGE_VERSION} */
(function () {
  'use strict';

  var FLAG = '__baibaokuEarlyBridge';
  var VERSION = ${JSON.stringify(String(EARLY_BRIDGE_VERSION))};
  var FAST_SETTINGS_GET = ${JSON.stringify(fastSettingsGetPath)};
  var FAST_SETTINGS_SAVE = ${JSON.stringify(fastSettingsSavePath)};
  var FAST_CHARACTER_LIST = ${JSON.stringify(fastCharacterListPath)};
  var SETTINGS_ACCELERATION_ENABLED = ${JSON.stringify(settingsAccelerationEnabled)};
  var CHARACTER_LIST_ACCELERATION_ENABLED = ${JSON.stringify(characterListAccelerationEnabled)};

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
  state.requests = state.requests || { get: 0, save: 0, characters: 0, fallback: 0, errors: 0, frontendCache: 0, invalidations: 0, saveFrontendCache: 0 };
  if (typeof state.requests.saveFrontendCache !== 'number') state.requests.saveFrontendCache = 0;
  state.rawFetch = rawFetch;
  state.settingsGetCache = state.settingsGetCache || null;
  state.settingsGetPending = null;
  state.settingsSaveCache = state.settingsSaveCache || null;
  state.settingsSavePending = null;

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
    if (!url || url.origin !== location.origin || method !== 'POST') return null;
    if (url.pathname === '/api/settings/get') return { kind: 'get', fastPath: FAST_SETTINGS_GET };
    if (url.pathname === '/api/settings/save') return { kind: 'save', fastPath: FAST_SETTINGS_SAVE };
    if (url.pathname === '/api/characters/all') return { kind: 'characters', fastPath: FAST_CHARACTER_LIST };
    return null;
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
    if (route.kind === 'characters') {
      if (state.characterListAccelerationEnabled === false) return false;
      return isPlainEmptyObject(await readJsonBody(input, init));
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
      if (originalResponse && originalResponse.ok && shouldInvalidateSettingsGetCache(url, method)) {
        clearSettingsGetCache('mutation:' + url.pathname);
        if (url.pathname === '/api/settings/save') {
          clearSettingsSaveCache('mutation:' + url.pathname);
        }
      }
      return originalResponse;
    }

    state.requests[route.kind] += 1;

    try {
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

export function closeStEndpointCaches() {
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
}

export function registerStEndpoints(router, manager) {
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
                getFastSettingsResponseEncoding(req),
                metrics,
            );
            metrics.responseMs = Date.now() - responseStartedAt;
            metrics.responseCache = response.cacheStatus || (response.cacheHit ? 'hit' : 'miss');
            metrics.totalMs = Date.now() - startedAt;

            res.type('application/json; charset=utf-8');
            res.set('Cache-Control', 'no-store, no-transform');
            res.set('Vary', 'Accept-Encoding');
            if (response.encoding !== 'identity') {
                res.set('Content-Encoding', response.encoding);
            }
            res.set('Content-Length', String(response.body.length));
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
                `compress;dur=${metrics.compressMs || 0}`,
                `gzip;dur=${metrics.gzipMs || 0}`,
                `br;dur=${metrics.brMs || 0}`,
                `total;dur=${metrics.totalMs}`,
            ].join(', '));
            res.send(response.body);
        } catch (error) {
            console.error('[baibaoku] Error in settings fast-get endpoint:', error);
            res.status(500).json({ error: true, message: error.message });
        }
    });
}
