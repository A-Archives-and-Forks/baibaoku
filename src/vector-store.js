import crypto from 'node:crypto';

import { BaiBaoKuError } from './errors.js';

/**
 * 柏宝书向量记忆仓库。
 *
 * 设计:每个角色一个独立的 <database>.sqlite(库名由前端按角色 avatar 算),
 * 该角色所有聊天 + bundle 快照都落这一个文件;删角色 = 删这一个库。
 * 库内用 scope 区分两类可召回集合:
 *   'chat:<chatId>'   某聊天边玩边索引的叶子(可增删覆盖)
 *   'bundle:<hash>'   带数据建新聊天那刻冻结的快照包(内容寻址、不可变)
 * 同一 leaf_id 可跨多个 scope 各存一份;召回按 leaf_id 去重由前端做。
 *
 * 向量由前端 embed(API key/CORS 在前端),传 base64(float32 小端)上来;
 * 本类只负责存、按余弦相似度算、按 scope 圈范围。检索是纯 JS 点积(零依赖、Node 端快)。
 */
export class VectorStore {
    constructor(manager) {
        this.manager = manager;
        // 已建过表的连接(按库路径去重),避免每次请求都跑 CREATE TABLE
        this.ensured = new WeakSet();
    }

    async #db(req, database) {
        const db = await this.manager.getConnection(req, database);
        if (!this.ensured.has(db)) {
            this.#ensureSchema(db);
            this.ensured.add(db);
        }
        return db;
    }

    #ensureSchema(db) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS vec_items (
                scope TEXT NOT NULL,
                leaf_id TEXT NOT NULL,
                doc_hash TEXT NOT NULL,
                vector BLOB NOT NULL,
                dim INTEGER NOT NULL,
                document TEXT NOT NULL,
                mes_full TEXT,
                story_time TEXT,
                msg_index INTEGER,
                created_at INTEGER NOT NULL,
                PRIMARY KEY (scope, leaf_id)
            );

            CREATE INDEX IF NOT EXISTS idx_vec_scope ON vec_items(scope);
        `);
    }

    /**
     * 写入/覆盖一批向量到某 scope(通常是 'chat:<chatId>',当前聊天实时索引)。
     * items: [{ leafId, docHash, vector(base64 float32 小端), dim, document, mesFull?, storyTime?, msgIndex? }]
     * leaf_id 冲突即覆盖(叶子重摘/编辑后用同 id upsert)。
     */
    async upsert(req, database, scope, items) {
        const db = await this.#db(req, database);
        const now = Date.now();
        const stmt = db.prepare(`
            INSERT INTO vec_items
                (scope, leaf_id, doc_hash, vector, dim, document, mes_full, story_time, msg_index, created_at)
            VALUES
                (@scope, @leafId, @docHash, @vector, @dim, @document, @mesFull, @storyTime, @msgIndex, @createdAt)
            ON CONFLICT(scope, leaf_id) DO UPDATE SET
                doc_hash = excluded.doc_hash,
                vector = excluded.vector,
                dim = excluded.dim,
                document = excluded.document,
                mes_full = excluded.mes_full,
                story_time = excluded.story_time,
                msg_index = excluded.msg_index
        `);

        const tx = db.transaction((rows) => {
            for (const it of rows) {
                const buf = decodeVectorBase64(it.vector);
                const dim = Number.isInteger(it.dim) ? it.dim : Math.floor(buf.length / 4);
                if (buf.length !== dim * 4) {
                    throw new BaiBaoKuError('VEC_DIM_MISMATCH', 'Vector byte length does not match dim.', 400, {
                        leafId: it.leafId, bytes: buf.length, dim,
                    });
                }
                stmt.run({
                    scope,
                    leafId: String(it.leafId),
                    docHash: String(it.docHash ?? ''),
                    vector: buf,
                    dim,
                    document: String(it.document ?? ''),
                    mesFull: it.mesFull == null ? null : String(it.mesFull),
                    storyTime: it.storyTime == null ? null : String(it.storyTime),
                    msgIndex: Number.isInteger(it.msgIndex) ? it.msgIndex : null,
                    createdAt: now,
                });
            }
            return rows.length;
        });

        const count = tx(items);
        return { database, scope, upserted: count };
    }

    /**
     * 在给定 scopes 范围内检索:对每条 query 向量算余弦相似度,多 query 用 **max 融合**
     * (每个叶子取它在各 query 上的最高余弦当最终分),纯按最终分取前 topK 返回
     * (**不套相似度阈值**,阈值留给前端分档)。
     * queryVectors: [base64 float32…];excludeLeafIds: 命中也跳过(已在窗口内的叶子)。
     * 返回 [{ leafId, scope, similarity, queryIndex, document, mesFull, storyTime, msgIndex }]
     * (similarity = 最佳单 query 余弦;queryIndex = 取得该最佳分的 query 下标,供前端调试展示「来源 Q」)。
     *
     * 为何 max 而非 RRF:rewrite 拆出的多条 Q 各是不同检索意图,本不该要求互相印证;
     * 「某叶子仅在单条 Q 上极相关」恰恰是该召回的精准命中,RRF 按名次累加会把它压下去。
     * max 宽进、后续 rerank + 阈值严出,更契合记忆召回。
     */
    async search(req, database, scopes, queryVectors, options = {}) {
        const db = await this.#db(req, database);
        const topK = Number.isInteger(options.topK) && options.topK > 0 ? options.topK : 20;
        const exclude = new Set((options.excludeLeafIds ?? []).map(String));

        if (!scopes.length || !queryVectors.length) {
            return { database, results: [] };
        }

        // 取范围内全部行(每行一份向量)。规模 = 该角色全历史叶子数,单角色可控。
        const placeholders = scopes.map(() => '?').join(',');
        const rows = db.prepare(`
            SELECT scope, leaf_id, vector, dim, document, mes_full, story_time, msg_index
            FROM vec_items
            WHERE scope IN (${placeholders})
        `).all(...scopes);

        const queries = queryVectors.map(decodeFloat32).map(normalize);

        // max 融合:每个叶子取它在所有 query 上的最高余弦。candidate key = leaf_id
        // (跨 scope/跨 query 同叶子合并,留相似度最高的那行,通常是 chat: 实时那份)。
        // 同时记录「获胜 query 的下标」(queryIndex),供前端调试面板展示「来源 Q」。
        const fused = new Map(); // leafId -> { row, bestSim, bestQuery }
        for (const r of rows) {
            if (exclude.has(String(r.leaf_id))) continue;
            const v = bufferToFloat32(r.vector);
            let best = -1;
            let bestQ = -1;
            for (let qi = 0; qi < queries.length; qi++) {
                const sim = dotNormalized(queries[qi], v); // q 已归一,v 在此归一
                if (sim > best) { best = sim; bestQ = qi; }
            }
            const key = String(r.leaf_id);
            const prev = fused.get(key);
            if (!prev || best > prev.bestSim) {
                fused.set(key, { row: r, bestSim: best, bestQuery: bestQ });
            }
        }

        const merged = [...fused.values()];
        merged.sort((a, b) => b.bestSim - a.bestSim);
        const top = merged.slice(0, topK);

        return {
            database,
            results: top.map(({ row, bestSim, bestQuery }) => ({
                leafId: row.leaf_id,
                scope: row.scope,
                similarity: bestSim,
                queryIndex: bestQuery,
                document: row.document,
                mesFull: row.mes_full ?? null,
                storyTime: row.story_time ?? null,
                msgIndex: row.msg_index ?? null,
            })),
        };
    }

    /** 删某 scope 下指定叶子(删叶子/陈旧时同步)。只动 chat: scope;bundle 不可变,前端不应来删。 */
    async delete(req, database, scope, leafIds) {
        const db = await this.#db(req, database);
        const stmt = db.prepare('DELETE FROM vec_items WHERE scope = ? AND leaf_id = ?');
        const tx = db.transaction((ids) => {
            let n = 0;
            for (const id of ids) n += stmt.run(scope, String(id)).changes;
            return n;
        });
        const deleted = tx(leafIds);
        return { database, scope, deleted };
    }

    /**
     * 对账某 scope 的索引与「前端当前应有的叶子集合」:
     *  - 删掉 scope 下不在 present 里的叶子(重摘换 id / 删楼 / 编辑失效留下的陈旧向量);
     *  - 返回 present 里「后端没有、或 doc_hash 变了」的 leafId(需前端 embed 后 upsert)。
     * present: [{ leafId, docHash }]。这是增量索引的核心:同文本(同 hash)不重复 embed。
     */
    async reconcile(req, database, scope, present) {
        const db = await this.#db(req, database);
        const presentMap = new Map(present.map(p => [String(p.leafId), String(p.docHash ?? '')]));

        const rows = db.prepare('SELECT leaf_id, doc_hash FROM vec_items WHERE scope = ?').all(scope);
        const existing = new Map(rows.map(r => [String(r.leaf_id), String(r.doc_hash)]));

        const toDelete = [];
        for (const id of existing.keys()) if (!presentMap.has(id)) toDelete.push(id);

        const missing = [];
        for (const [id, hash] of presentMap) {
            const cur = existing.get(id);
            if (cur === undefined || cur !== hash) missing.push(id);
        }

        if (toDelete.length) {
            const del = db.prepare('DELETE FROM vec_items WHERE scope = ? AND leaf_id = ?');
            const tx = db.transaction(() => {
                for (const id of toDelete) del.run(scope, id);
            });
            tx();
        }

        return { database, scope, deleted: toDelete.length, missing };
    }

    /** 清空某 scope(整聊天删除时用)。 */
    async clearScope(req, database, scope) {
        const db = await this.#db(req, database);
        const result = db.prepare('DELETE FROM vec_items WHERE scope = ?').run(scope);
        return { database, scope, deleted: result.changes };
    }

    /** 各 scope 的索引条数(诊断/UI 展示)。 */
    async stats(req, database, scopes) {
        const db = await this.#db(req, database);
        if (!scopes.length) return { database, stats: {} };
        const stmt = db.prepare('SELECT COUNT(*) AS c FROM vec_items WHERE scope = ?');
        const out = {};
        for (const s of scopes) out[s] = stmt.get(s).c;
        return { database, stats: out };
    }

    /**
     * 带数据建新聊天时:把源聊天 'chat:<sourceChatId>' 的全部向量**内部复制**成一个
     * 'bundle:<hash>' 冻结快照(向量不经前端、不重 embed)。hash 按集合内容算,幂等:
     * 同内容同 hash,重复 create 直接返回已存 hash、不重复插。
     */
    async bundleCreate(req, database, sourceChatId) {
        const db = await this.#db(req, database);
        const sourceScope = `chat:${sourceChatId}`;
        const rows = db.prepare(`
            SELECT leaf_id, doc_hash, vector, dim, document, mes_full, story_time, msg_index
            FROM vec_items WHERE scope = ?
            ORDER BY leaf_id
        `).all(sourceScope);

        // 内容寻址:对「叶子 id + 内容 hash」的有序集合算稳定 hash。空源也允许(得到固定空 hash)。
        const h = crypto.createHash('sha256');
        for (const r of rows) h.update(`${r.leaf_id} ${r.doc_hash} `);
        const hash = h.digest('hex').slice(0, 32);
        const bundleScope = `bundle:${hash}`;

        const existing = db.prepare('SELECT COUNT(*) AS c FROM vec_items WHERE scope = ?').get(bundleScope).c;
        if (existing > 0) {
            return { database, hash, scope: bundleScope, copied: 0, reused: true };
        }

        const now = Date.now();
        const insert = db.prepare(`
            INSERT INTO vec_items
                (scope, leaf_id, doc_hash, vector, dim, document, mes_full, story_time, msg_index, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(scope, leaf_id) DO NOTHING
        `);
        const tx = db.transaction((src) => {
            for (const r of src) {
                insert.run(
                    bundleScope, r.leaf_id, r.doc_hash, r.vector, r.dim,
                    r.document, r.mes_full ?? null, r.story_time ?? null, r.msg_index ?? null, now,
                );
            }
            return src.length;
        });
        const copied = tx(rows);
        return { database, hash, scope: bundleScope, copied, reused: false };
    }
}

/* ============ 向量编解码 / 相似度(纯 JS) ============ */

function decodeVectorBase64(value) {
    if (Buffer.isBuffer(value)) return value;
    if (typeof value !== 'string') {
        throw new BaiBaoKuError('VEC_NOT_BASE64', 'Vector must be a base64 float32 string.', 400);
    }
    const buf = Buffer.from(value, 'base64');
    if (buf.length === 0 || buf.length % 4 !== 0) {
        throw new BaiBaoKuError('VEC_BAD_LENGTH', 'Vector byte length must be a positive multiple of 4.', 400, {
            bytes: buf.length,
        });
    }
    return buf;
}

/** base64 float32 小端 → Float32Array */
function decodeFloat32(value) {
    const buf = decodeVectorBase64(value);
    return bufferToFloat32(buf);
}

function bufferToFloat32(buf) {
    // 复制到对齐的 ArrayBuffer(SQLite BLOB 的 byteOffset 不保证 4 对齐)
    return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
}

/** 原地归一化(返回新数组),零向量原样返回 */
function normalize(vec) {
    let s = 0;
    for (let i = 0; i < vec.length; i++) s += vec[i] * vec[i];
    const norm = Math.sqrt(s);
    if (norm === 0) return vec;
    const out = new Float32Array(vec.length);
    for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
    return out;
}

/** a 已归一化,b 在此归一化后点积 = 余弦相似度。维度不一致返回 -1(不可比)。 */
function dotNormalized(a, b) {
    if (a.length !== b.length) return -1;
    let dot = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        nb += b[i] * b[i];
    }
    const norm = Math.sqrt(nb);
    if (norm === 0) return -1;
    return dot / norm;
}
