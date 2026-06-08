import fs from 'node:fs';
import path from 'node:path';
import bytes from 'bytes';
import { parse } from '../../../src/character-card-parser.js';
import { SETTINGS_FILE } from '../../../src/constants.js';

const FAST_CHARACTER_CACHE_DATABASE = 'baibaoku.internal';
const FAST_CHARACTER_CACHE_STORE = 'character-fast-all';
const FAST_CHARACTER_CACHE_VERSION = 1;
const FAST_CHARACTER_CACHE_PAGE_SIZE = 1000;

// Cache structure: Map<userHandle, Map<filename, { mtime: number, size: number, data: Object }>>
const userCaches = new Map();
// Lock structure: Map<userHandle, Promise<void>>
const updateLocks = new Map();
// Cache structure: Map<userHandle, { sections: Map<string, Map<filename, CachedFile>> }>
const settingsUserCaches = new Map();
// Lock structure: Map<userHandle, Promise<Object>>
const settingsUpdateLocks = new Map();
let staticSettingsPayload = null;

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

function getSettingsUserCache(userHandle) {
    if (!settingsUserCaches.has(userHandle)) {
        settingsUserCaches.set(userHandle, { sections: new Map() });
    }

    return settingsUserCaches.get(userHandle);
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

async function getFastSettingsPayload(req, userHandle) {
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

    return {
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

export function registerStEndpoints(router, manager) {
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

    router.post('/v1/settings/fast-get', async (req, res) => {
        const startedAt = Date.now();

        try {
            const userHandle = req.user?.profile?.handle;
            if (!userHandle) {
                return res.status(401).json({ error: true, message: 'Unauthorized' });
            }

            const settingsPath = path.join(req.user.directories.root, SETTINGS_FILE);
            const settingsPromise = fs.promises.readFile(settingsPath, 'utf8');

            if (!settingsUpdateLocks.has(userHandle)) {
                const updatePromise = getFastSettingsPayload(req, userHandle)
                    .finally(() => settingsUpdateLocks.delete(userHandle));
                settingsUpdateLocks.set(userHandle, updatePromise);
            }

            const [settings, cachedPayload] = await Promise.all([
                settingsPromise,
                settingsUpdateLocks.get(userHandle),
            ]);
            const staticPayload = await getStaticSettingsPayload();

            res.set('X-Baibaoku-Elapsed-Ms', String(Date.now() - startedAt));
            res.json({
                settings,
                ...cachedPayload,
                ...staticPayload,
            });
        } catch (error) {
            console.error('[baibaoku] Error in settings fast-get endpoint:', error);
            res.status(500).json({ error: true, message: error.message });
        }
    });
}
