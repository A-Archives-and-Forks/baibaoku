import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import bytes from 'bytes';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { parse } from '../../../src/character-card-parser.js';
import { SETTINGS_FILE } from '../../../src/constants.js';
import { PLUGIN_ID } from './constants.js';

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
// Cache structure: Map<userHandle, { path: string, text: string, mtime: number, size: number, updatedAt: number }>
const settingsFileCaches = new Map();
// Lock structure: Map<userHandle, Promise<Object>>
const settingsSaveLocks = new Map();
// Cache structure: Map<userHandle, { key: string, text: string, gzipBuffer?: Buffer }>
const settingsResponseCaches = new Map();
let staticSettingsPayload = null;
const EARLY_BRIDGE_VERSION = 2;

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
        };
    }

    const text = await fs.promises.readFile(settingsPath, 'utf8');
    cacheSettingsText(userHandle, settingsPath, text, stat);

    return {
        ...settingsFileCaches.get(userHandle),
        cacheHit: false,
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

    writeFileAtomicSync(settingsPath, text, 'utf8');

    const stat = await fs.promises.stat(settingsPath);
    cacheSettingsText(userHandle, settingsPath, text, stat);

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
            payloadRefreshPromise: null,
            payloadWatchers: new Map(),
            payloadWatchAttempted: false,
        });
    }

    return settingsUserCaches.get(userHandle);
}

function getSettingsPayloadWatchTargets(directories) {
    return [
        directories.koboldAI_Settings,
        directories.novelAI_Settings,
        directories.openAI_Settings,
        directories.textGen_Settings,
        directories.worlds,
        directories.themes,
        directories.movingUI,
        directories.quickreplies,
        directories.instruct,
        directories.context,
        directories.sysprompt,
        directories.reasoning,
    ].filter(Boolean);
}

function markSettingsPayloadDirty(userCache, reason = 'unknown') {
    userCache.payloadDirty = true;
    userCache.payloadDirtyReason = reason;
    userCache.payloadDirtyAt = Date.now();
}

function ensureSettingsPayloadWatchers(userCache, directories) {
    if (userCache.payloadWatchAttempted) {
        return;
    }

    userCache.payloadWatchAttempted = true;
    const targets = Array.from(new Set(getSettingsPayloadWatchTargets(directories)));

    for (const directoryPath of targets) {
        try {
            const watcher = fs.watch(directoryPath, { persistent: false }, (eventType, filename) => {
                const filenameText = filename ? String(filename) : '';
                markSettingsPayloadDirty(userCache, `watch:${eventType}:${directoryPath}${filenameText ? `/${filenameText}` : ''}`);
            });

            watcher.on('error', (error) => {
                markSettingsPayloadDirty(userCache, `watch-error:${directoryPath}:${error.message}`);
                console.warn(`[baibaoku] Settings payload watcher failed for ${directoryPath}:`, error.message);
            });

            userCache.payloadWatchers.set(directoryPath, watcher);
        } catch (error) {
            markSettingsPayloadDirty(userCache, `watch-unavailable:${directoryPath}:${error.message}`);
            console.warn(`[baibaoku] Settings payload watcher unavailable for ${directoryPath}:`, error.message);
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

async function getFastSettingsPayload(req, userHandle, metrics = {}) {
    const userCache = getSettingsUserCache(userHandle);
    const directories = req.user.directories;

    ensureSettingsPayloadWatchers(userCache, directories);

    if (canUseCachedSettingsPayload(userCache)) {
        metrics.payloadCache = 'hit';
        return userCache.payload;
    }

    metrics.payloadCache = userCache.payload ? 'stale' : 'miss';
    metrics.payloadDirtyReason = userCache.payloadDirtyReason || '';
    metrics.payloadDirtyAgeMs = userCache.payloadDirtyAt ? Date.now() - userCache.payloadDirtyAt : 0;

    if (userCache.payload && settingsResponseCaches.has(userHandle)) {
        metrics.payloadCache = 'stale-served';
        scheduleSettingsPayloadRefresh(req, userHandle);
        return userCache.payload;
    }

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

    return payload;
}

function scheduleSettingsPayloadRefresh(req, userHandle) {
    const userCache = getSettingsUserCache(userHandle);

    if (userCache.payloadRefreshPromise) {
        return userCache.payloadRefreshPromise;
    }

    userCache.payloadRefreshPromise = (async () => {
        const [settingsInfo, cachedPayload] = await Promise.all([
            readSettingsTextWithCache(req, userHandle),
            buildFastSettingsPayload(req, userHandle),
        ]);
        const staticPayload = await getStaticSettingsPayload();

        getFastSettingsResponse(userHandle, settingsInfo, cachedPayload, staticPayload, true);
    })()
        .catch((error) => {
            console.warn('[baibaoku] Failed to refresh settings payload cache in background:', error.message);
        })
        .finally(() => {
            userCache.payloadRefreshPromise = null;
        });

    return userCache.payloadRefreshPromise;
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

function getFastSettingsResponse(userHandle, settingsInfo, cachedPayload, staticPayload, acceptsGzip, metrics = {}) {
    const userCache = getSettingsUserCache(userHandle);
    const key = [
        settingsInfo.path,
        settingsInfo.mtime,
        settingsInfo.size,
        settingsInfo.updatedAt,
        userCache.payloadBuiltAt,
    ].join('\0');
    const cached = settingsResponseCaches.get(userHandle);

    if (cached?.key === key) {
        if (acceptsGzip) {
            const gzipStartedAt = Date.now();
            cached.gzipBuffer ??= zlib.gzipSync(cached.text, { level: 1 });
            metrics.gzipMs = Date.now() - gzipStartedAt;

            return {
                cacheHit: true,
                encoding: 'gzip',
                body: cached.gzipBuffer,
            };
        }

        return {
            cacheHit: true,
            encoding: 'identity',
            body: cached.text,
        };
    }

    const text = JSON.stringify({
        settings: settingsInfo.text,
        ...cachedPayload,
        ...staticPayload,
    });
    const nextCache = { key, text };

    if (acceptsGzip) {
        const gzipStartedAt = Date.now();
        nextCache.gzipBuffer = zlib.gzipSync(text, { level: 1 });
        metrics.gzipMs = Date.now() - gzipStartedAt;
    }

    settingsResponseCaches.set(userHandle, nextCache);

    return {
        cacheHit: false,
        encoding: acceptsGzip ? 'gzip' : 'identity',
        body: acceptsGzip ? nextCache.gzipBuffer : text,
    };
}

function requestAcceptsGzip(req) {
    return /\bgzip\b/i.test(String(req.headers?.['accept-encoding'] || ''));
}

function makeEarlyBridgeScript() {
    const apiPrefix = `/api/plugins/${PLUGIN_ID}`;
    const fastSettingsGetPath = `${apiPrefix}/v1/settings/fast-get`;
    const fastSettingsSavePath = `${apiPrefix}/v1/settings/fast-save`;

    return `/* baibaoku early bridge v${EARLY_BRIDGE_VERSION} */
(function () {
  'use strict';

  var FLAG = '__baibaokuEarlyBridge';
  var VERSION = ${JSON.stringify(String(EARLY_BRIDGE_VERSION))};
  var FAST_SETTINGS_GET = ${JSON.stringify(fastSettingsGetPath)};
  var FAST_SETTINGS_SAVE = ${JSON.stringify(fastSettingsSavePath)};

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
  state.requests = state.requests || { get: 0, save: 0, fallback: 0, errors: 0, frontendCache: 0, invalidations: 0 };
  state.rawFetch = rawFetch;
  state.settingsGetCache = state.settingsGetCache || null;
  state.settingsGetPending = null;

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

  async function getReplayBody(input, init, method) {
    if (method === 'GET' || method === 'HEAD') return undefined;
    if (init && Object.prototype.hasOwnProperty.call(init, 'body')) return init.body;
    try {
      if (input instanceof Request) return await input.clone().arrayBuffer();
    } catch (_) {}
    return undefined;
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

    if (!route) {
      var originalResponse = await rawFetch(input, init);
      if (originalResponse && originalResponse.ok && shouldInvalidateSettingsGetCache(url, method)) {
        clearSettingsGetCache('mutation:' + url.pathname);
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
        } else if (route.kind === 'save') {
          clearSettingsGetCache('save');
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
    router.get('/v1/early/bridge.js', (_req, res) => {
        res.type('application/javascript; charset=utf-8');
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.send(makeEarlyBridgeScript());
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

    router.post('/v1/settings/fast-save', async (req, res) => {
        const startedAt = Date.now();

        try {
            const userHandle = req.user?.profile?.handle;
            if (!userHandle) {
                return res.status(401).json({ error: true, message: 'Unauthorized' });
            }

            const result = await queueSettingsSave(userHandle, () => saveSettingsWithCache(req, userHandle));

            res.set('X-Baibaoku-Elapsed-Ms', String(Date.now() - startedAt));
            res.json(result);
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
                    metrics.settingsCache = settingsInfo.cacheHit ? 'hit' : 'miss';
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

            const staticStartedAt = Date.now();
            const staticPayload = await getStaticSettingsPayload();
            metrics.staticMs = Date.now() - staticStartedAt;

            const responseStartedAt = Date.now();
            const response = getFastSettingsResponse(
                userHandle,
                settingsInfo,
                cachedPayload,
                staticPayload,
                requestAcceptsGzip(req),
                metrics,
            );
            metrics.responseMs = Date.now() - responseStartedAt;
            metrics.responseCache = response.cacheHit ? 'hit' : 'miss';
            metrics.totalMs = Date.now() - startedAt;

            res.type('application/json; charset=utf-8');
            res.set('Cache-Control', 'no-store, no-transform');
            res.set('Vary', 'Accept-Encoding');
            if (response.encoding === 'gzip') {
                res.set('Content-Encoding', 'gzip');
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
                `gzip;dur=${metrics.gzipMs || 0}`,
                `total;dur=${metrics.totalMs}`,
            ].join(', '));
            res.send(response.body);
        } catch (error) {
            console.error('[baibaoku] Error in settings fast-get endpoint:', error);
            res.status(500).json({ error: true, message: error.message });
        }
    });
}
