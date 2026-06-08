import fs from 'node:fs';
import path from 'node:path';

import { BaiBaoKuError } from './errors.js';

const STORAGE_DIRECTORY = 'baibaoku';
const DATABASES_DIRECTORY = 'databases';
const REGISTRY_FILE = 'registry.json';

export function getStoragePaths(req, database) {
    const userRoot = req.user?.directories?.root;
    if (!userRoot) {
        throw new BaiBaoKuError('USER_ROOT_NOT_FOUND', 'Current SillyTavern user data directory was not found.', 500);
    }

    const root = path.resolve(userRoot, STORAGE_DIRECTORY);
    const databasesRoot = path.resolve(root, DATABASES_DIRECTORY);
    const registryPath = path.resolve(root, REGISTRY_FILE);
    const databasePath = path.resolve(databasesRoot, `${database}.sqlite`);

    assertPathInside(databasesRoot, databasePath);
    fs.mkdirSync(databasesRoot, { recursive: true });

    return {
        userRoot: path.resolve(userRoot),
        root,
        databasesRoot,
        registryPath,
        databasePath,
    };
}

export function relativeToUserRoot(userRoot, targetPath) {
    return path.relative(userRoot, targetPath).replaceAll(path.sep, '/');
}

function assertPathInside(parent, child) {
    const relative = path.relative(parent, child);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new BaiBaoKuError('INVALID_DATABASE_PATH', 'Database path escaped the BaiBaoKu storage directory.', 400);
    }
}
