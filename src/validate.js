import { BaiBaoKuError } from './errors.js';
import { VALUE_TYPES } from './serializer.js';

const DATABASE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const STORE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const MAX_KEY_LENGTH = 1024;
const MAX_PREFIX_LENGTH = 1024;
const MAX_DISPLAY_NAME_LENGTH = 120;
const MAX_LIMIT = 1000;
const MAX_KEYS = 1000;
const DEFAULT_LIMIT = 100;

export function normalizeDatabaseName(value) {
    if (typeof value !== 'string' || !DATABASE_NAME_RE.test(value)) {
        throw new BaiBaoKuError(
            'INVALID_DATABASE',
            'Database name must match /^[a-z0-9][a-z0-9._-]{0,79}$/.',
            400,
        );
    }

    return value;
}

export function normalizeStoreName(value) {
    if (value === undefined || value === null || value === '') {
        return 'default';
    }

    if (typeof value !== 'string' || !STORE_NAME_RE.test(value)) {
        throw new BaiBaoKuError(
            'INVALID_STORE',
            'Store name must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.',
            400,
        );
    }

    return value;
}

export function normalizeKey(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_KEY_LENGTH || value.includes('\0')) {
        throw new BaiBaoKuError('INVALID_KEY', `Key must be a non-empty string up to ${MAX_KEY_LENGTH} characters.`, 400);
    }

    return value;
}

export function normalizeKeys(value) {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_KEYS) {
        throw new BaiBaoKuError('INVALID_KEYS', `Keys must be a non-empty array with at most ${MAX_KEYS} items.`, 400);
    }

    return value.map(normalizeKey);
}

export function normalizeValueType(value) {
    if (value === undefined || value === null || value === '') {
        return 'json';
    }

    if (typeof value !== 'string') {
        throw new BaiBaoKuError('INVALID_VALUE_TYPE', `Value type must be one of: ${VALUE_TYPES.join(', ')}.`, 400);
    }

    const normalized = value.toLowerCase();
    if (!VALUE_TYPES.includes(normalized)) {
        throw new BaiBaoKuError('INVALID_VALUE_TYPE', `Value type must be one of: ${VALUE_TYPES.join(', ')}.`, 400);
    }

    return normalized;
}

export function normalizeSetManyEntries(value, defaults = {}) {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_KEYS) {
        throw new BaiBaoKuError('INVALID_ENTRIES', `Entries must be a non-empty array with at most ${MAX_KEYS} items.`, 400);
    }

    const defaultType = normalizeValueType(defaults.type ?? defaults.valueType);
    const defaultTtl = normalizeTtl(defaults.ttl);

    return value.map((entry, index) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            throw new BaiBaoKuError('INVALID_ENTRY', 'Each entry must be an object.', 400, { index });
        }

        return {
            key: normalizeKey(entry.key),
            value: entry.value,
            type: normalizeValueType(entry.type ?? entry.valueType ?? defaultType),
            ttl: entry.ttl === undefined ? defaultTtl : normalizeTtl(entry.ttl),
        };
    });
}

export function normalizePrefix(value) {
    if (value === undefined || value === null) {
        return '';
    }

    if (typeof value !== 'string' || value.length > MAX_PREFIX_LENGTH || value.includes('\0')) {
        throw new BaiBaoKuError('INVALID_PREFIX', `Prefix must be a string up to ${MAX_PREFIX_LENGTH} characters.`, 400);
    }

    return value;
}

export function normalizeLimit(value) {
    if (value === undefined || value === null) {
        return DEFAULT_LIMIT;
    }

    if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
        throw new BaiBaoKuError('INVALID_LIMIT', `Limit must be an integer from 1 to ${MAX_LIMIT}.`, 400);
    }

    return value;
}

export function normalizeOffset(value) {
    if (value === undefined || value === null) {
        return 0;
    }

    if (!Number.isInteger(value) || value < 0) {
        throw new BaiBaoKuError('INVALID_OFFSET', 'Offset must be a non-negative integer.', 400);
    }

    return value;
}

export function normalizeTtl(value) {
    if (value === undefined || value === null) {
        return null;
    }

    if (!Number.isInteger(value) || value < 1) {
        throw new BaiBaoKuError('INVALID_TTL', 'TTL must be a positive integer number of seconds.', 400);
    }

    return value;
}

export function normalizeOpenOptions(value) {
    const options = {};

    if (value.displayName !== undefined) {
        if (typeof value.displayName !== 'string' || value.displayName.length > MAX_DISPLAY_NAME_LENGTH) {
            throw new BaiBaoKuError('INVALID_DISPLAY_NAME', `Display name must be a string up to ${MAX_DISPLAY_NAME_LENGTH} characters.`, 400);
        }
        options.displayName = value.displayName || undefined;
    }

    if (value.version !== undefined) {
        if (!Number.isInteger(value.version) || value.version < 1) {
            throw new BaiBaoKuError('INVALID_VERSION', 'Version must be a positive integer.', 400);
        }
        options.version = value.version;
    }

    return options;
}
