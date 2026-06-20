import fs from 'node:fs/promises';
import path from 'node:path';

import { BaiBaoKuError } from './errors.js';

const STORAGE_DIRECTORY = 'baibaoku';
const PRESET_BACKUPS_DIRECTORY = 'preset_backups';
const OPENAI_PRESET_BACKUPS_DIRECTORY = 'openai';
const PRESET_BACKUP_INDEX_FILE_NAME = 'index.json';
const PRESET_BACKUP_EXTENSION = '.json';
const MAX_PRESET_BACKUP_NAME_LENGTH = 160;
const MAX_PRESET_BACKUP_FILE_NAME_LENGTH = 240;
const MAX_PRESET_BACKUP_NOTE_LENGTH = 500;
let presetBackupIndexQueue = Promise.resolve();

export async function savePresetBackup(req) {
    const directory = await getPresetBackupDirectory(req);
    const presetName = normalizePresetBackupDisplayName(
        req.body?.name
        ?? req.body?.presetName
        ?? req.body?.filename
        ?? req.body?.fileName
        ?? 'openai-preset',
    );
    const timestamp = formatPresetBackupTimestamp(new Date());
    const fileName = await getAvailablePresetBackupFileName(directory, `${timestamp}__${sanitizePresetBackupFilePart(presetName)}${PRESET_BACKUP_EXTENSION}`);
    const filePath = resolvePresetBackupFilePath(directory, fileName);
    const text = `${JSON.stringify(req.body ?? {}, null, 2)}\n`;

    await fs.writeFile(filePath, text, { encoding: 'utf8', flag: 'wx' });

    const stat = await fs.stat(filePath);
    const index = await updatePresetBackupIndex(directory, currentIndex => {
        currentIndex[fileName] = { showName: presetName };
    });
    return toPresetBackupResponseItem(formatPresetBackupListItem(fileName, stat, index));
}

export async function listPresetBackups(req) {
    const directory = await getPresetBackupDirectory(req);
    let dirents = [];

    try {
        dirents = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return { items: [] };
        }

        throw error;
    }

    const index = await readPresetBackupIndex(directory);
    const items = [];

    for (const dirent of dirents) {
        if (!dirent.isFile() || dirent.name === PRESET_BACKUP_INDEX_FILE_NAME || path.extname(dirent.name) !== PRESET_BACKUP_EXTENSION) {
            continue;
        }

        try {
            const filePath = resolvePresetBackupFilePath(directory, dirent.name);
            const stat = await fs.stat(filePath);
            items.push(formatPresetBackupListItem(dirent.name, stat, index));
        } catch (error) {
            if (error?.code !== 'ENOENT') {
                throw error;
            }
        }
    }

    items.sort((a, b) => b.createdAtMs - a.createdAtMs || b.fileName.localeCompare(a.fileName));

    return {
        items: items.map(toPresetBackupResponseItem),
    };
}

export async function renamePresetBackup(req) {
    const directory = await getPresetBackupDirectory(req);
    const fileName = normalizePresetBackupFileName(req.body?.fileName ?? req.body?.oldFileName);
    const showName = normalizePresetBackupDisplayName(req.body?.showName ?? req.body?.newName ?? req.body?.name ?? req.body?.newFileName);
    const filePath = resolvePresetBackupFilePath(directory, fileName);
    const stat = await statExistingPresetBackup(filePath);
    const index = await updatePresetBackupIndex(directory, currentIndex => {
        currentIndex[fileName] = { ...currentIndex[fileName], showName };
    });
    return toPresetBackupResponseItem(formatPresetBackupListItem(fileName, stat, index));
}

export async function updatePresetBackupNote(req) {
    const directory = await getPresetBackupDirectory(req);
    const fileName = normalizePresetBackupFileName(req.body?.fileName ?? req.body?.name);
    const note = normalizePresetBackupNote(req.body?.note);
    const filePath = resolvePresetBackupFilePath(directory, fileName);
    const stat = await statExistingPresetBackup(filePath);
    const index = await updatePresetBackupIndex(directory, currentIndex => {
        const entry = { ...currentIndex[fileName] };

        if (note) {
            entry.note = note;
        } else {
            delete entry.note;
        }

        currentIndex[fileName] = entry;
    });
    return toPresetBackupResponseItem(formatPresetBackupListItem(fileName, stat, index));
}

export async function deletePresetBackup(req) {
    const directory = await getPresetBackupDirectory(req);
    const fileName = normalizePresetBackupFileName(req.body?.fileName ?? req.body?.name);
    const filePath = resolvePresetBackupFilePath(directory, fileName);

    try {
        await fs.unlink(filePath);
    } catch (error) {
        if (error?.code === 'ENOENT') {
            throw new BaiBaoKuError('PRESET_BACKUP_NOT_FOUND', 'Preset backup was not found.', 404);
        }

        throw error;
    }

    await updatePresetBackupIndex(directory, currentIndex => {
        delete currentIndex[fileName];
    });

    return { fileName, deleted: true };
}

export async function downloadPresetBackup(req) {
    const directory = await getPresetBackupDirectory(req);
    const fileName = normalizePresetBackupFileName(req.body?.fileName ?? req.body?.name);
    const filePath = resolvePresetBackupFilePath(directory, fileName);
    const stat = await statExistingPresetBackup(filePath);
    const index = await readPresetBackupIndex(directory);
    const text = await fs.readFile(filePath, 'utf8');
    let body;

    try {
        body = JSON.parse(text);
    } catch {
        throw new BaiBaoKuError('INVALID_PRESET_BACKUP_DATA', 'Preset backup file is not valid JSON.', 500);
    }

    return {
        ...toPresetBackupResponseItem(formatPresetBackupListItem(fileName, stat, index)),
        body,
    };
}

async function getPresetBackupDirectory(req) {
    const userRoot = req.user?.directories?.root;

    if (!userRoot) {
        throw new BaiBaoKuError('USER_ROOT_NOT_FOUND', 'Current SillyTavern user data directory was not found.', 500);
    }

    const directory = path.resolve(userRoot, STORAGE_DIRECTORY, PRESET_BACKUPS_DIRECTORY, OPENAI_PRESET_BACKUPS_DIRECTORY);
    assertPathInside(path.resolve(userRoot, STORAGE_DIRECTORY), directory, 'Preset backup directory escaped the BaiBaoKu storage directory.');
    await fs.mkdir(directory, { recursive: true });
    return directory;
}

function normalizePresetBackupFileName(value) {
    if (typeof value !== 'string') {
        throw new BaiBaoKuError('INVALID_PRESET_BACKUP_FILE_NAME', 'Preset backup fileName must be a string.', 400);
    }

    const fileName = path.basename(value.trim());

    if (!fileName || fileName === PRESET_BACKUP_INDEX_FILE_NAME || fileName !== value.trim() || fileName.length > MAX_PRESET_BACKUP_FILE_NAME_LENGTH || path.extname(fileName) !== PRESET_BACKUP_EXTENSION) {
        throw new BaiBaoKuError('INVALID_PRESET_BACKUP_FILE_NAME', 'Preset backup fileName must be a JSON file name without path segments.', 400);
    }

    return fileName;
}

function normalizePresetBackupDisplayName(value) {
    if (typeof value !== 'string') {
        throw new BaiBaoKuError('INVALID_PRESET_BACKUP_NAME', 'Preset backup name must be a string.', 400);
    }

    const name = value.trim();

    if (!name || name.length > MAX_PRESET_BACKUP_NAME_LENGTH || name.includes('\0')) {
        throw new BaiBaoKuError('INVALID_PRESET_BACKUP_NAME', `Preset backup name must be a non-empty string up to ${MAX_PRESET_BACKUP_NAME_LENGTH} characters.`, 400);
    }

    return name;
}

function normalizePresetBackupNote(value) {
    if (value === undefined || value === null) {
        return '';
    }

    if (typeof value !== 'string') {
        throw new BaiBaoKuError('INVALID_PRESET_BACKUP_NOTE', 'Preset backup note must be a string.', 400);
    }

    const note = value.replace(/\0/g, '').trim();

    if (note.length > MAX_PRESET_BACKUP_NOTE_LENGTH) {
        throw new BaiBaoKuError('INVALID_PRESET_BACKUP_NOTE', `Preset backup note must be up to ${MAX_PRESET_BACKUP_NOTE_LENGTH} characters.`, 400);
    }

    return note;
}

function sanitizePresetBackupFilePart(value) {
    const sanitized = value
        .normalize('NFKC')
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
        .replace(/\s+/g, ' ')
        .replace(/[. ]+$/g, '')
        .slice(0, 120)
        .trim();

    return sanitized || 'openai-preset';
}

function formatPresetBackupTimestamp(date) {
    const pad = value => String(value).padStart(2, '0');

    return [
        date.getFullYear(),
        pad(date.getMonth() + 1),
        pad(date.getDate()),
        '_',
        pad(date.getHours()),
        pad(date.getMinutes()),
        pad(date.getSeconds()),
    ].join('');
}

async function getAvailablePresetBackupFileName(directory, preferredFileName) {
    let fileName = preferredFileName;
    const parsed = path.parse(preferredFileName);

    for (let index = 1; index <= 999; index += 1) {
        const filePath = resolvePresetBackupFilePath(directory, fileName);

        try {
            await fs.access(filePath);
        } catch (error) {
            if (error?.code === 'ENOENT') {
                return fileName;
            }

            throw error;
        }

        fileName = `${parsed.name}-${index}${parsed.ext}`;
    }

    throw new BaiBaoKuError('PRESET_BACKUP_NAME_EXHAUSTED', 'Could not create a unique preset backup file name.', 409);
}

async function statExistingPresetBackup(filePath) {
    try {
        return await fs.stat(filePath);
    } catch (error) {
        if (error?.code === 'ENOENT') {
            throw new BaiBaoKuError('PRESET_BACKUP_NOT_FOUND', 'Preset backup was not found.', 404);
        }

        throw error;
    }
}

function resolvePresetBackupFilePath(directory, fileName) {
    const filePath = path.resolve(directory, fileName);
    assertPathInside(directory, filePath, 'Preset backup path escaped the backup directory.');
    return filePath;
}

function assertPathInside(parent, child, message) {
    const relative = path.relative(parent, child);

    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new BaiBaoKuError('INVALID_PRESET_BACKUP_PATH', message, 400);
    }
}

async function readPresetBackupIndex(directory) {
    const indexPath = resolvePresetBackupIndexPath(directory);

    try {
        const text = await fs.readFile(indexPath, 'utf8');
        const index = JSON.parse(text);
        return index && typeof index === 'object' && !Array.isArray(index) ? index : {};
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return {};
        }

        console.warn('[baibaoku] Failed to read preset backup index:', error?.message || error);
        return {};
    }
}

async function writePresetBackupIndex(directory, index) {
    const indexPath = resolvePresetBackupIndexPath(directory);
    await fs.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
}

async function updatePresetBackupIndex(directory, updater) {
    const run = presetBackupIndexQueue
        .catch(() => undefined)
        .then(async () => {
            const index = await readPresetBackupIndex(directory);
            await updater(index);
            await writePresetBackupIndex(directory, index);
            return index;
        });

    presetBackupIndexQueue = run.then(() => undefined, () => undefined);
    return run;
}

function resolvePresetBackupIndexPath(directory) {
    return resolvePresetBackupFilePath(directory, PRESET_BACKUP_INDEX_FILE_NAME);
}

function formatPresetBackupListItem(fileName, stat, index = {}) {
    const createdAtMs = getCreatedAtMs(stat);

    return {
        fileName,
        showName: getPresetBackupShowName(fileName, index),
        note: getPresetBackupNote(fileName, index),
        createdAt: new Date(createdAtMs).toISOString(),
        createdAtMs,
    };
}

function toPresetBackupResponseItem({ fileName, showName, note, createdAt }) {
    return { fileName, showName, note: note ?? '', createdAt };
}

function getPresetBackupShowName(fileName, index) {
    const showName = index?.[fileName]?.showName;

    if (typeof showName === 'string' && showName.trim()) {
        return showName.trim();
    }

    return fileName;
}

function getPresetBackupNote(fileName, index) {
    const note = index?.[fileName]?.note;

    if (typeof note === 'string' && note.trim()) {
        return note.trim();
    }

    return '';
}

function getCreatedAtMs(stat) {
    return stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.ctimeMs;
}





