import { BaiBaoKuError } from './errors.js';

export const VALUE_TYPES = Object.freeze(['json', 'text', 'blob', 'float32']);

export function serializeValue(value, type = 'json', maxBytes) {
    const normalizedType = normalizeValueTypeName(type);

    let storedValue;
    switch (normalizedType) {
        case 'json':
            storedValue = serializeJson(value);
            break;
        case 'text':
            storedValue = serializeText(value);
            break;
        case 'blob':
            storedValue = decodeBase64Value(value, 'blob');
            break;
        case 'float32':
            storedValue = serializeFloat32(value);
            break;
        default:
            throw new BaiBaoKuError('UNKNOWN_VALUE_TYPE', `Unknown value type: ${normalizedType}`, 400);
    }

    const bytes = getStoredBytes(storedValue);
    assertMaxBytes(bytes, maxBytes);

    return {
        value: storedValue,
        type: normalizedType,
        bytes,
    };
}

export function deserializeValue(value, type) {
    return deserializeStoredValue(value, type).value;
}

export function deserializeStoredValue(value, type) {
    const normalizedType = normalizeValueTypeName(type);
    const bytes = getStoredBytes(value);

    switch (normalizedType) {
        case 'json':
            return {
                type: normalizedType,
                value: parseJsonValue(value),
                bytes,
            };
        case 'text':
            return {
                type: normalizedType,
                value: normalizeStoredText(value),
                bytes,
            };
        case 'blob':
            return {
                type: normalizedType,
                value: normalizeStoredBuffer(value, normalizedType).toString('base64'),
                encoding: 'base64',
                bytes,
            };
        case 'float32': {
            const buffer = normalizeStoredBuffer(value, normalizedType);
            return {
                type: normalizedType,
                value: buffer.toString('base64'),
                encoding: 'base64',
                byteOrder: 'little-endian',
                dimensions: Math.floor(buffer.length / 4),
                bytes,
            };
        }
        default:
            throw new BaiBaoKuError('UNKNOWN_VALUE_TYPE', `Unknown stored value type: ${normalizedType}`, 500);
    }
}

function serializeJson(value) {
    let serialized;

    try {
        serialized = JSON.stringify(value);
    } catch (error) {
        throw new BaiBaoKuError('VALUE_NOT_SERIALIZABLE', 'Value must be JSON serializable.', 400, {
            cause: error.message,
        });
    }

    if (serialized === undefined) {
        throw new BaiBaoKuError('VALUE_NOT_SERIALIZABLE', 'Value must not be undefined.', 400);
    }

    return serialized;
}

function serializeText(value) {
    if (typeof value !== 'string') {
        throw new BaiBaoKuError('VALUE_NOT_TEXT', 'Text values must be strings.', 400);
    }

    return value;
}

function serializeFloat32(value) {
    if (Array.isArray(value)) {
        const buffer = Buffer.allocUnsafe(value.length * 4);
        for (let index = 0; index < value.length; index++) {
            const item = Number(value[index]);
            if (!Number.isFinite(item)) {
                throw new BaiBaoKuError('VALUE_NOT_FLOAT32_ARRAY', 'Float32 array values must be finite numbers.', 400, {
                    index,
                });
            }
            buffer.writeFloatLE(item, index * 4);
        }
        return buffer;
    }

    const buffer = decodeBase64Value(value, 'float32');
    if (buffer.length % 4 !== 0) {
        throw new BaiBaoKuError('VALUE_NOT_FLOAT32_BLOB', 'Float32 binary values must have a byte length divisible by 4.', 400, {
            bytes: buffer.length,
        });
    }

    const expectedDimensions = typeof value === 'object' && value !== null ? value.dimensions : undefined;
    if (expectedDimensions !== undefined) {
        if (!Number.isInteger(expectedDimensions) || expectedDimensions < 0) {
            throw new BaiBaoKuError('INVALID_FLOAT32_DIMENSIONS', 'Float32 dimensions must be a non-negative integer.', 400);
        }
        const actualDimensions = buffer.length / 4;
        if (expectedDimensions !== actualDimensions) {
            throw new BaiBaoKuError('FLOAT32_DIMENSIONS_MISMATCH', 'Float32 dimensions do not match binary byte length.', 400, {
                expectedDimensions,
                actualDimensions,
                bytes: buffer.length,
            });
        }
    }

    return buffer;
}

function parseJsonValue(value) {
    try {
        return JSON.parse(normalizeStoredText(value));
    } catch (error) {
        throw new BaiBaoKuError('CORRUPT_VALUE', 'Stored value is not valid JSON.', 500, {
            cause: error.message,
        });
    }
}

function decodeBase64Value(value, type) {
    const payload = extractBase64Payload(value, type);
    const compact = payload.replace(/\s+/g, '');

    if (!isValidBase64(compact)) {
        throw new BaiBaoKuError('VALUE_NOT_BASE64', `${type} values must be base64 strings.`, 400);
    }

    return Buffer.from(compact, 'base64');
}

function extractBase64Payload(value, type) {
    if (typeof value === 'string') {
        return value;
    }

    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new BaiBaoKuError('VALUE_NOT_BASE64', `${type} values must be base64 strings.`, 400);
    }

    const encoding = value.encoding ?? 'base64';
    if (encoding !== 'base64') {
        throw new BaiBaoKuError('UNSUPPORTED_VALUE_ENCODING', `${type} values only support base64 encoding.`, 400, {
            encoding,
        });
    }

    const payload = value.data ?? value.base64 ?? value.value;
    if (typeof payload !== 'string') {
        throw new BaiBaoKuError('VALUE_NOT_BASE64', `${type} values must include a base64 string payload.`, 400);
    }

    return payload;
}

function isValidBase64(value) {
    if (value === '') return true;
    if (value.length % 4 !== 0) return false;
    return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

function normalizeStoredText(value) {
    if (typeof value === 'string') return value;
    if (Buffer.isBuffer(value)) return value.toString('utf8');
    return String(value);
}

function normalizeStoredBuffer(value, type) {
    if (Buffer.isBuffer(value)) return value;
    if (typeof value === 'string') return Buffer.from(value, 'base64');
    throw new BaiBaoKuError('CORRUPT_VALUE', `Stored ${type} value is not binary.`, 500);
}

function getStoredBytes(value) {
    if (Buffer.isBuffer(value)) return value.length;
    return Buffer.byteLength(String(value), 'utf8');
}

function assertMaxBytes(bytes, maxBytes) {
    if (bytes > maxBytes) {
        throw new BaiBaoKuError('VALUE_TOO_LARGE', `Value is too large. Maximum size is ${maxBytes} bytes.`, 413, {
            bytes,
            maxBytes,
        });
    }
}

function normalizeValueTypeName(type) {
    if (typeof type !== 'string' || !VALUE_TYPES.includes(type)) {
        throw new BaiBaoKuError('UNKNOWN_VALUE_TYPE', `Unknown value type: ${type}`, 400);
    }

    return type;
}
