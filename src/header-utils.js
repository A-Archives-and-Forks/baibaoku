import { validateHeaderName, validateHeaderValue } from 'node:http';

const HEADER_VALUE_CHECK_NAME = 'X-Baibaoku-Header-Value';
const DEFAULT_MAX_SOURCE_LENGTH = 2048;
const DEFAULT_MAX_HEADER_LENGTH = 4096;

export function toSafeHeaderValue(value, options = {}) {
    if (Array.isArray(value)) {
        return value.map(item => toSafeHeaderValue(item, options));
    }

    const maxSourceLength = getPositiveIntegerOption(options.maxSourceLength, DEFAULT_MAX_SOURCE_LENGTH);
    const maxLength = getPositiveIntegerOption(options.maxLength, DEFAULT_MAX_HEADER_LENGTH);
    let text = String(value ?? '');

    if (text.length > maxSourceLength) {
        text = text.slice(0, maxSourceLength);
    }

    if (isValidHeaderValue(text)) {
        return truncateHeaderValue(text, maxLength);
    }

    return truncateHeaderValue(percentEncodeUnsafeHeaderValue(text), maxLength);
}

export function setSafeHeader(res, name, value, options = {}) {
    try {
        const headerName = String(name);
        validateHeaderName(headerName);
        res.set(headerName, toSafeHeaderValue(value, options));
        return true;
    } catch {
        return false;
    }
}

export function setHeaderIfValid(res, name, value) {
    try {
        const headerName = String(name);
        validateHeaderName(headerName);
        validateHeaderValue(headerName, value);
        res.set(headerName, value);
        return true;
    } catch {
        return false;
    }
}

function getPositiveIntegerOption(value, fallback) {
    return Number.isInteger(value) && value > 0 ? value : fallback;
}

function isValidHeaderValue(value) {
    try {
        validateHeaderValue(HEADER_VALUE_CHECK_NAME, value);
        return true;
    } catch {
        return false;
    }
}

function truncateHeaderValue(value, maxLength) {
    return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function percentEncodeUnsafeHeaderValue(value) {
    let output = '';

    for (const char of String(value)) {
        const codePoint = char.codePointAt(0);
        if (codePoint >= 0x20 && codePoint <= 0x7E) {
            output += char;
            continue;
        }

        for (const byte of Buffer.from(char, 'utf8')) {
            output += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
        }
    }

    return output;
}
