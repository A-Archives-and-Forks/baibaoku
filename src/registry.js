import fs from 'node:fs';
import path from 'node:path';

const REGISTRY_VERSION = 1;

export function readRegistry(registryPath) {
    if (!fs.existsSync(registryPath)) {
        return createEmptyRegistry();
    }

    try {
        const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
        if (!registry || typeof registry !== 'object') {
            return createEmptyRegistry();
        }

        registry.version = REGISTRY_VERSION;
        registry.databases ??= {};
        return registry;
    } catch {
        return createEmptyRegistry();
    }
}

export function updateRegistry(registryPath, database, options = {}) {
    const now = Date.now();
    const registry = readRegistry(registryPath);
    const existing = registry.databases[database] ?? {};
    const shouldWrite = !existing.database || options.displayName !== undefined || options.version !== undefined;

    const entry = {
        database,
        displayName: options.displayName ?? existing.displayName ?? database,
        version: options.version ?? existing.version ?? 1,
        createdAt: existing.createdAt ?? now,
        updatedAt: shouldWrite ? now : existing.updatedAt ?? now,
    };

    if (shouldWrite) {
        registry.databases[database] = entry;
        writeRegistry(registryPath, registry);
    }

    return entry;
}

function createEmptyRegistry() {
    return {
        version: REGISTRY_VERSION,
        databases: {},
    };
}

function writeRegistry(registryPath, registry) {
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    const tempPath = `${registryPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(registry, null, 2));
    fs.renameSync(tempPath, registryPath);
}
