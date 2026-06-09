import fs from 'node:fs';
import path from 'node:path';

import { BaiBaoKuError } from './errors.js';
import { getStoragePaths, relativeToUserRoot } from './paths.js';
import { serializeValue, deserializeStoredValue } from './serializer.js';
import { updateRegistry } from './registry.js';

const SCHEMA_VERSION = 1;
const DEFAULT_TYPE = 'json';
const MAX_VALUE_BYTES = 5 * 1024 * 1024;
const WAL_AUTOCHECKPOINT_PAGES = 512;
const WAL_JOURNAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;
const WAL_TRUNCATE_AFTER_BYTES = 32 * 1024 * 1024;
const WAL_TRUNCATE_MIN_INTERVAL_MS = 60 * 1000;

let sqliteDriver = null;
let sqliteImportError = null;

export class DatabaseManager {
    constructor() {
        this.connections = new Map();
        this.writeStats = new Map();
    }

    async getDriverStatus() {
        try {
            const driver = await loadSqliteDriver();
            return { available: true, package: driver.package };
        } catch (error) {
            return {
                available: false,
                package: 'node:sqlite/better-sqlite3',
                message: error.message,
                details: error.details,
            };
        }
    }

    async openForRequest(req, database, options = {}) {
        const context = await this.#getContext(req, database, options);
        const stats = this.#getStats(context.db);

        return {
            database,
            displayName: context.registryEntry.displayName,
            version: context.registryEntry.version,
            path: relativeToUserRoot(context.paths.userRoot, context.paths.databasePath),
            createdAt: context.registryEntry.createdAt,
            updatedAt: context.registryEntry.updatedAt,
            stats,
        };
    }

    async info(req, database) {
        const context = await this.#getContext(req, database);
        const stats = this.#getStats(context.db);

        return {
            database,
            displayName: context.registryEntry.displayName,
            version: context.registryEntry.version,
            path: relativeToUserRoot(context.paths.userRoot, context.paths.databasePath),
            createdAt: context.registryEntry.createdAt,
            updatedAt: context.registryEntry.updatedAt,
            stats,
        };
    }

    async set(req, database, store, key, value, options = {}) {
        const context = await this.#getContext(req, database);
        const now = Date.now();
        const serialized = serializeValue(value, options.type ?? DEFAULT_TYPE, MAX_VALUE_BYTES);
        const expiresAt = options.ttl ? now + options.ttl * 1000 : null;

        context.db.prepare(`
            INSERT INTO kv (store, key, value, type, created_at, updated_at, expires_at)
            VALUES (@store, @key, @value, @type, @now, @now, @expiresAt)
            ON CONFLICT(store, key) DO UPDATE SET
                value = excluded.value,
                type = excluded.type,
                updated_at = excluded.updated_at,
                expires_at = excluded.expires_at
        `).run({
            store,
            key,
            value: serialized.value,
            type: serialized.type,
            now,
            expiresAt,
        });

        this.#afterWrite(context, { bytes: serialized.bytes, changes: 1 });
        return {
            database,
            store,
            key,
            type: serialized.type,
            expiresAt,
            bytes: serialized.bytes,
        };
    }

    async setMany(req, database, store, entries) {
        const context = await this.#getContext(req, database);
        const now = Date.now();
        const upsert = context.db.prepare(`
            INSERT INTO kv (store, key, value, type, created_at, updated_at, expires_at)
            VALUES (@store, @key, @value, @type, @now, @now, @expiresAt)
            ON CONFLICT(store, key) DO UPDATE SET
                value = excluded.value,
                type = excluded.type,
                updated_at = excluded.updated_at,
                expires_at = excluded.expires_at
        `);

        const transaction = context.db.transaction((items) => {
            const saved = [];
            for (const item of items) {
                const serialized = serializeValue(item.value, item.type ?? DEFAULT_TYPE, MAX_VALUE_BYTES);
                const expiresAt = item.ttl ? now + item.ttl * 1000 : null;
                upsert.run({
                    store,
                    key: item.key,
                    value: serialized.value,
                    type: serialized.type,
                    now,
                    expiresAt,
                });
                saved.push({
                    key: item.key,
                    type: serialized.type,
                    expiresAt,
                    bytes: serialized.bytes,
                });
            }
            return saved;
        });

        const saved = transaction(entries);
        const totalBytes = saved.reduce((sum, entry) => sum + entry.bytes, 0);
        this.#afterWrite(context, { bytes: totalBytes, changes: saved.length });

        return {
            database,
            store,
            count: saved.length,
            totalBytes,
            entries: saved,
        };
    }

    async get(req, database, store, key) {
        const context = await this.#getContext(req, database);
        this.#deleteExpired(context.db);

        const row = context.db.prepare(`
            SELECT value, type, created_at, updated_at, expires_at
            FROM kv
            WHERE store = ? AND key = ?
        `).get(store, key);

        if (!row) {
            return { database, store, key, exists: false, value: null };
        }

        return {
            database,
            store,
            key,
            exists: true,
            ...formatStoredValue(row),
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            expiresAt: row.expires_at,
        };
    }

    async getMany(req, database, store, keys) {
        const context = await this.#getContext(req, database);
        this.#deleteExpired(context.db);

        const select = context.db.prepare(`
            SELECT value, type, created_at, updated_at, expires_at
            FROM kv
            WHERE store = ? AND key = ?
        `);

        const entries = keys.map(key => {
            const row = select.get(store, key);

            if (!row) {
                return { key, exists: false, value: null };
            }

            return {
                key,
                exists: true,
                ...formatStoredValue(row),
                createdAt: row.created_at,
                updatedAt: row.updated_at,
                expiresAt: row.expires_at,
            };
        });

        return {
            database,
            store,
            entries,
        };
    }

    async has(req, database, store, key) {
        const context = await this.#getContext(req, database);
        this.#deleteExpired(context.db);

        const row = context.db.prepare('SELECT 1 FROM kv WHERE store = ? AND key = ?').get(store, key);
        return { database, store, key, exists: !!row };
    }

    async delete(req, database, store, key) {
        const context = await this.#getContext(req, database);
        const result = context.db.prepare('DELETE FROM kv WHERE store = ? AND key = ?').run(store, key);
        this.#afterWrite(context, { changes: result.changes });

        return { database, store, key, deleted: result.changes > 0 };
    }

    async deleteMany(req, database, store, keys) {
        const context = await this.#getContext(req, database);
        const remove = context.db.prepare('DELETE FROM kv WHERE store = ? AND key = ?');
        const transaction = context.db.transaction((items) => items.map(key => {
            const result = remove.run(store, key);
            return { key, deleted: result.changes > 0 };
        }));

        const entries = transaction(keys);
        this.#afterWrite(context, { changes: entries.filter(entry => entry.deleted).length });

        return {
            database,
            store,
            deleted: entries.filter(entry => entry.deleted).length,
            entries,
        };
    }

    async keys(req, database, store, options = {}) {
        const context = await this.#getContext(req, database);
        this.#deleteExpired(context.db);

        const { clause, params } = buildPrefixClause(store, options.prefix);
        const rows = context.db.prepare(`
            SELECT key
            FROM kv
            ${clause}
            ORDER BY key COLLATE BINARY
            LIMIT ? OFFSET ?
        `).all(...params, options.limit, options.offset);

        return {
            database,
            store,
            prefix: options.prefix,
            limit: options.limit,
            offset: options.offset,
            keys: rows.map(row => row.key),
        };
    }

    async entries(req, database, store, options = {}) {
        const context = await this.#getContext(req, database);
        this.#deleteExpired(context.db);

        const { clause, params } = buildPrefixClause(store, options.prefix);
        const rows = context.db.prepare(`
            SELECT key, value, type, created_at, updated_at, expires_at
            FROM kv
            ${clause}
            ORDER BY key COLLATE BINARY
            LIMIT ? OFFSET ?
        `).all(...params, options.limit, options.offset);

        return {
            database,
            store,
            prefix: options.prefix,
            limit: options.limit,
            offset: options.offset,
            entries: rows.map(row => ({
                key: row.key,
                ...formatStoredValue(row),
                createdAt: row.created_at,
                updatedAt: row.updated_at,
                expiresAt: row.expires_at,
            })),
        };
    }

    async clear(req, database, store, options = {}) {
        const context = await this.#getContext(req, database);
        const { clause, params } = buildPrefixClause(store, options.prefix);
        const result = context.db.prepare(`DELETE FROM kv ${clause}`).run(...params);
        this.#afterWrite(context, { changes: result.changes });

        return {
            database,
            store,
            prefix: options.prefix,
            deleted: result.changes,
        };
    }

    closeAll() {
        for (const db of this.connections.values()) {
            try {
                db.pragma('wal_checkpoint(TRUNCATE)');
                db.close();
            } catch {
                // Ignore close errors during server shutdown.
            }
        }
        this.connections.clear();
    }

    async #getContext(req, database, options = {}) {
        const paths = getStoragePaths(req, database);
        const db = await this.#openDatabase(paths.databasePath);
        this.#ensureSchema(db);
        const registryEntry = updateRegistry(paths.registryPath, database, options);
        this.#syncMeta(db, database, registryEntry);

        return { db, paths, registryEntry };
    }

    async #openDatabase(databasePath) {
        const driver = await loadSqliteDriver();
        fs.mkdirSync(path.dirname(databasePath), { recursive: true });

        const connectionKey = path.resolve(databasePath);
        if (this.connections.has(connectionKey)) {
            return this.connections.get(connectionKey);
        }

        const db = driver.open(databasePath);
        db.pragma('journal_mode = WAL');
        db.pragma(`wal_autocheckpoint = ${WAL_AUTOCHECKPOINT_PAGES}`);
        db.pragma(`journal_size_limit = ${WAL_JOURNAL_SIZE_LIMIT_BYTES}`);
        db.pragma('busy_timeout = 5000');
        db.pragma('foreign_keys = ON');
        this.connections.set(connectionKey, db);
        return db;
    }

    #ensureSchema(db) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS kv (
                store TEXT NOT NULL DEFAULT 'default',
                key TEXT NOT NULL,
                value BLOB NOT NULL,
                type TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                expires_at INTEGER,
                PRIMARY KEY (store, key)
            );

            CREATE INDEX IF NOT EXISTS idx_kv_store ON kv(store);
            CREATE INDEX IF NOT EXISTS idx_kv_expires_at ON kv(expires_at);

            CREATE TABLE IF NOT EXISTS meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
        `);

        db.pragma(`user_version = ${SCHEMA_VERSION}`);
        db.prepare(`
            INSERT INTO meta (key, value)
            VALUES ('schema_version', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run(String(SCHEMA_VERSION));
    }

    #syncMeta(db, database, registryEntry) {
        const setMeta = db.prepare(`
            INSERT INTO meta (key, value)
            VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `);

        const transaction = db.transaction(() => {
            setMeta.run('database', database);
            setMeta.run('display_name', registryEntry.displayName ?? '');
            setMeta.run('client_version', String(registryEntry.version ?? 1));
            setMeta.run('updated_at', String(registryEntry.updatedAt));
        });

        transaction();
    }

    #deleteExpired(db) {
        const now = Date.now();
        db.prepare('DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at <= ?').run(now);
    }

    #afterWrite(context, info = {}) {
        const changes = Number(info.changes) || 0;
        const bytes = Number(info.bytes) || 0;
        if (changes <= 0 && bytes <= 0) return;

        const key = path.resolve(context.paths.databasePath);
        const stats = this.writeStats.get(key) ?? {
            bytesSinceCheckpoint: 0,
            lastTruncateAt: 0,
        };

        stats.bytesSinceCheckpoint += bytes || changes * 1024;
        this.writeStats.set(key, stats);

        if (stats.bytesSinceCheckpoint < WAL_TRUNCATE_AFTER_BYTES) return;

        const now = Date.now();
        if (now - stats.lastTruncateAt < WAL_TRUNCATE_MIN_INTERVAL_MS) return;

        try {
            context.db.pragma('wal_checkpoint(TRUNCATE)');
            stats.bytesSinceCheckpoint = 0;
            stats.lastTruncateAt = now;
        } catch (error) {
            console.warn('[BaiBaoKu] WAL checkpoint failed:', error);
            stats.lastTruncateAt = now;
        }
    }

    #getStats(db) {
        const count = db.prepare('SELECT COUNT(*) AS count FROM kv').get().count;
        const pageCount = db.pragma('page_count', { simple: true });
        const pageSize = db.pragma('page_size', { simple: true });

        return {
            keys: count,
            sizeBytes: pageCount * pageSize,
        };
    }
}

async function loadSqliteDriver() {
    if (sqliteDriver) {
        return sqliteDriver;
    }

    if (sqliteImportError) {
        throw sqliteImportError;
    }

    const causes = [];

    try {
        const module = await import('node:sqlite');
        if (module.DatabaseSync) {
            sqliteDriver = {
                package: 'node:sqlite',
                open(databasePath) {
                    return new NodeSqliteDatabase(new module.DatabaseSync(databasePath));
                },
            };
            return sqliteDriver;
        }

        causes.push('node:sqlite did not export DatabaseSync.');
    } catch (error) {
        causes.push(`node:sqlite: ${error.message}`);
    }

    try {
        const module = await import('better-sqlite3');
        const BetterSqliteDatabase = module.default ?? module;
        sqliteDriver = {
            package: 'better-sqlite3',
            open(databasePath) {
                return new BetterSqliteDatabase(databasePath);
            },
        };
        return sqliteDriver;
    } catch (error) {
        causes.push(`better-sqlite3: ${error.message}`);
        sqliteImportError = new BaiBaoKuError(
            'SQLITE_DRIVER_NOT_AVAILABLE',
            'No SQLite driver is available. Use a Node.js version with node:sqlite, or install optional better-sqlite3 inside plugins/baibaoku.',
            503,
            { causes },
        );
        throw sqliteImportError;
    }
}

class NodeSqliteDatabase {
    constructor(db) {
        this.db = db;
    }

    prepare(sql) {
        return new NodeSqliteStatement(this.db.prepare(sql));
    }

    exec(sql) {
        return this.db.exec(sql);
    }

    close() {
        return this.db.close();
    }

    pragma(sql, options = {}) {
        const rows = this.db.prepare(`PRAGMA ${sql}`).all().map(normalizeNodeSqliteRow);
        if (options.simple) {
            const row = rows[0];
            if (!row) return undefined;
            return Object.values(row)[0];
        }

        return rows;
    }

    transaction(callback) {
        return (...args) => {
            let shouldRollback = false;

            try {
                this.db.exec('BEGIN IMMEDIATE');
                shouldRollback = true;

                const result = callback(...args);

                this.db.exec('COMMIT');
                shouldRollback = false;
                return result;
            } catch (error) {
                if (shouldRollback) {
                    try {
                        this.db.exec('ROLLBACK');
                    } catch (rollbackError) {
                        console.warn('[BaiBaoKu] SQLite rollback failed:', rollbackError);
                    }
                }

                throw error;
            }
        };
    }
}

class NodeSqliteStatement {
    constructor(statement) {
        this.statement = statement;
    }

    run(...params) {
        return this.statement.run(...params);
    }

    get(...params) {
        return normalizeNodeSqliteRow(this.statement.get(...params));
    }

    all(...params) {
        return this.statement.all(...params).map(normalizeNodeSqliteRow);
    }
}

function normalizeNodeSqliteRow(row) {
    if (!row || typeof row !== 'object') return row;

    const normalized = {};
    for (const [key, value] of Object.entries(row)) {
        normalized[key] = normalizeNodeSqliteValue(value);
    }

    return normalized;
}

function normalizeNodeSqliteValue(value) {
    if (value instanceof Uint8Array && !Buffer.isBuffer(value)) {
        return Buffer.from(value);
    }

    return value;
}

function buildPrefixClause(store, prefix) {
    if (!prefix) {
        return {
            clause: 'WHERE store = ?',
            params: [store],
        };
    }

    return {
        clause: "WHERE store = ? AND key LIKE ? ESCAPE '\\'",
        params: [store, `${escapeLike(prefix)}%`],
    };
}

function escapeLike(value) {
    return value.replace(/[\\%_]/g, char => `\\${char}`);
}

function formatStoredValue(row) {
    const value = deserializeStoredValue(row.value, row.type);
    const result = {
        value: value.value,
        type: value.type,
        bytes: value.bytes,
    };

    if (value.encoding) result.encoding = value.encoding;
    if (value.byteOrder) result.byteOrder = value.byteOrder;
    if (value.dimensions !== undefined) result.dimensions = value.dimensions;

    return result;
}
