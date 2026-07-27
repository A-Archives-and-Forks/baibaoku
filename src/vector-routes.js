import { BaiBaoKuError, errorPayload, toHttpError } from './errors.js';
import { normalizeDatabaseName } from './validate.js';

/**
 * 向量记忆路由 /v1/vec/*,与 KV 接口并列、互不干扰。
 * 校验内联在此(向量入参形态特殊,不复用 KV 的 validate)。
 */
export function registerVectorRoutes(router, store) {
    router.post('/v1/vec/upsert', route(async (req, res) => {
        const database = normalizeDatabaseName(req.body?.database);
        const scope = normalizeScope(req.body?.scope);
        const items = normalizeUpsertItems(req.body?.items);
        sendOk(res, await store.upsert(req, database, scope, items));
    }));

    router.post('/v1/vec/update-payload', route(async (req, res) => {
        const database = normalizeDatabaseName(req.body?.database);
        const scope = normalizeScope(req.body?.scope);
        const items = normalizePayloadItems(req.body?.items);
        sendOk(res, await store.updatePayload(req, database, scope, items));
    }));

    router.post('/v1/vec/search', route(async (req, res) => {
        const database = normalizeDatabaseName(req.body?.database);
        const scopes = normalizeScopes(req.body?.scopes);
        const queryVectors = normalizeQueryVectors(req.body?.queryVectors);
        const topK = normalizePosInt(req.body?.topK, 'topK', 1000);
        const excludeLeafIds = normalizeIdList(req.body?.excludeLeafIds);
        sendOk(res, await store.search(req, database, scopes, queryVectors, { topK, excludeLeafIds }));
    }));

    router.post('/v1/vec/delete', route(async (req, res) => {
        const database = normalizeDatabaseName(req.body?.database);
        const scope = normalizeScope(req.body?.scope);
        const leafIds = normalizeIdList(req.body?.leafIds);
        sendOk(res, await store.delete(req, database, scope, leafIds));
    }));

    router.post('/v1/vec/reconcile', route(async (req, res) => {
        const database = normalizeDatabaseName(req.body?.database);
        const scope = normalizeScope(req.body?.scope);
        const present = normalizePresent(req.body?.present);
        sendOk(res, await store.reconcile(req, database, scope, present));
    }));

    router.post('/v1/vec/clear-scope', route(async (req, res) => {
        const database = normalizeDatabaseName(req.body?.database);
        const scope = normalizeScope(req.body?.scope);
        sendOk(res, await store.clearScope(req, database, scope));
    }));

    router.post('/v1/vec/stats', route(async (req, res) => {
        const database = normalizeDatabaseName(req.body?.database);
        const scopes = normalizeScopes(req.body?.scopes);
        sendOk(res, await store.stats(req, database, scopes));
    }));

    router.post('/v1/vec/bundle/create', route(async (req, res) => {
        const database = normalizeDatabaseName(req.body?.database);
        const sourceChatId = normalizeChatId(req.body?.sourceChatId);
        sendOk(res, await store.bundleCreate(req, database, sourceChatId));
    }));
}

function route(handler) {
    return async (req, res) => {
        try {
            await handler(req, res);
        } catch (error) {
            const httpError = toHttpError(error);
            res.status(httpError.status).json(errorPayload(httpError));
        }
    };
}

function sendOk(res, data) {
    res.json({ ok: true, data });
}

/* ============ 校验 ============ */

const MAX_SCOPES = 256;
const MAX_ITEMS = 1000;
const MAX_QUERIES = 16;

function normalizeScope(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 256 || value.includes('\0')) {
        throw new BaiBaoKuError('INVALID_SCOPE', 'Scope must be a non-empty string up to 256 chars.', 400);
    }
    return value;
}

function normalizeScopes(value) {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SCOPES) {
        throw new BaiBaoKuError('INVALID_SCOPES', `Scopes must be a non-empty array up to ${MAX_SCOPES} items.`, 400);
    }
    return value.map(normalizeScope);
}

function normalizeChatId(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
        throw new BaiBaoKuError('INVALID_CHAT_ID', 'sourceChatId must be a non-empty string.', 400);
    }
    return value;
}

function normalizeUpsertItems(value) {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ITEMS) {
        throw new BaiBaoKuError('INVALID_ITEMS', `items must be a non-empty array up to ${MAX_ITEMS}.`, 400);
    }
    return value.map((it, index) => {
        if (!it || typeof it !== 'object' || Array.isArray(it)) {
            throw new BaiBaoKuError('INVALID_ITEM', 'Each item must be an object.', 400, { index });
        }
        if (typeof it.leafId !== 'string' || !it.leafId) {
            throw new BaiBaoKuError('INVALID_ITEM', 'item.leafId must be a non-empty string.', 400, { index });
        }
        if (typeof it.vector !== 'string' || !it.vector) {
            throw new BaiBaoKuError('INVALID_ITEM', 'item.vector must be a base64 string.', 400, { index });
        }
        return it;
    });
}

function normalizePayloadItems(value) {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ITEMS) {
        throw new BaiBaoKuError('INVALID_ITEMS', `items must be a non-empty array up to ${MAX_ITEMS}.`, 400);
    }
    return value.map((it, index) => {
        if (!it || typeof it !== 'object' || Array.isArray(it)) {
            throw new BaiBaoKuError('INVALID_ITEM', 'Each item must be an object.', 400, { index });
        }
        if (typeof it.leafId !== 'string' || !it.leafId) {
            throw new BaiBaoKuError('INVALID_ITEM', 'item.leafId must be a non-empty string.', 400, { index });
        }
        if (typeof it.payloadHash !== 'string' || !it.payloadHash) {
            throw new BaiBaoKuError('INVALID_ITEM', 'item.payloadHash must be a non-empty string.', 400, { index });
        }
        return it;
    });
}

function normalizeQueryVectors(value) {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_QUERIES) {
        throw new BaiBaoKuError('INVALID_QUERIES', `queryVectors must be a non-empty array up to ${MAX_QUERIES}.`, 400);
    }
    return value.map((v, index) => {
        if (typeof v !== 'string' || !v) {
            throw new BaiBaoKuError('INVALID_QUERY', 'Each query vector must be a base64 string.', 400, { index });
        }
        return v;
    });
}

function normalizePresent(value) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.length > MAX_ITEMS) {
        throw new BaiBaoKuError('INVALID_PRESENT', `present must be an array up to ${MAX_ITEMS}.`, 400);
    }
    return value.map((p, index) => {
        if (!p || typeof p !== 'object' || typeof p.leafId !== 'string' || !p.leafId) {
            throw new BaiBaoKuError('INVALID_PRESENT_ITEM', 'Each present item needs a leafId.', 400, { index });
        }
        return {
            leafId: p.leafId,
            docHash: typeof p.docHash === 'string' ? p.docHash : '',
            payloadHash: typeof p.payloadHash === 'string' ? p.payloadHash : '',
        };
    });
}

function normalizeIdList(value) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
        throw new BaiBaoKuError('INVALID_ID_LIST', 'Expected an array of ids.', 400);
    }
    return value.map(String);
}

function normalizePosInt(value, name, max) {
    if (value === undefined || value === null) return undefined;
    if (!Number.isInteger(value) || value < 1 || value > max) {
        throw new BaiBaoKuError('INVALID_INT', `${name} must be an integer from 1 to ${max}.`, 400);
    }
    return value;
}
