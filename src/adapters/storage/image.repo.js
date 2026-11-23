/**
 * L2 适配器 · 图片 blob 仓库（IndexedDB）+ 按会话 slot 的缓存索引。
 *
 * 展示规则（需求 4.17）：
 * - 记录在 + 缓存在 → 正常已生图
 * - 记录在 + 缓存无 → 未生图（可再出）
 * - 记录无 + 缓存在 → 照常显示图，不可再出图（超出保留范围）
 * - 记录无 + 缓存无 → 「已超出保留范围」
 *
 * 裁决 D22：gc 空 liveRefs 必须 Err。
 */

import { Ok, Err } from '../../infra/result.js';
import { configError } from '../../infra/errors.js';
import { newId } from '../../infra/id.js';
import { nowIso } from '../../infra/clock.js';
import { mapIdbError, IDB_STORES } from './idb.js';
import { catchToResult } from './import-export.js';

/**
 * 从会话 slot 记录收集仍存活的 imageRef。
 * @param {Iterable<{ images?: Array<{ imageRef?: string }> }>} records
 * @returns {string[]}
 */
export function collectLiveRefsFromRecords(records) {
    /** @type {Set<string>} */
    const refs = new Set();
    if (records == null) {
        return [];
    }
    for (const slot of records) {
        if (!slot || !Array.isArray(slot.images)) {
            continue;
        }
        for (const entry of slot.images) {
            if (entry?.imageRef != null && entry.imageRef !== '') {
                refs.add(String(entry.imageRef));
            }
        }
    }
    return [...refs];
}

/**
 * @param {object} deps
 * @param {object} deps.db openIdb 返回值
 * @returns {import('../../ports/repository.port.js').ImageRepository & {
 *   linkSlot: (sessionId: string, slotId: number, imageRef: string) => Promise<import('../../infra/result.js').Ok<void>|import('../../infra/result.js').Err<import('../../infra/errors.js').AppError>>,
 *   clearSlot: (sessionId: string, slotId: number) => Promise<import('../../infra/result.js').Ok<void>|import('../../infra/result.js').Err<import('../../infra/errors.js').AppError>>,
 *   getSlotImageRef: (sessionId: string, slotId: number) => Promise<import('../../infra/result.js').Ok<string|null>|import('../../infra/result.js').Err<import('../../infra/errors.js').AppError>>,
 *   listCacheRefs: (sessionId?: string|null) => Promise<import('../../infra/result.js').Ok<string[]>|import('../../infra/result.js').Err<import('../../infra/errors.js').AppError>>,
 *   collectLiveRefs: (records: Iterable<object>, sessionId?: string|null) => Promise<import('../../infra/result.js').Ok<string[]>|import('../../infra/result.js').Err<import('../../infra/errors.js').AppError>>,
 *   trimToLimit: (limit: number) => Promise<import('../../infra/result.js').Ok<{ removed: number, removedRefs: string[] }>|import('../../infra/result.js').Err<import('../../infra/errors.js').AppError>>,
 *   removeMany: (refs: string[]) => Promise<import('../../infra/result.js').Ok<{ removed: number, removedRefs: string[] }>|import('../../infra/result.js').Err<import('../../infra/errors.js').AppError>>,
 *   clearCache: () => Promise<import('../../infra/result.js').Ok<{ removed: number, removedRefs: string[] }>|import('../../infra/result.js').Err<import('../../infra/errors.js').AppError>>,
 * }}
 */
export function createImageRepo(deps) {
    const db = deps?.db;
    if (!db) {
        throw new Error('createImageRepo requires deps.db');
    }

    /** @type {Map<string, { url: string, stamp: string }>} imageRef → 当前 blob 的 objectURL */
    const urlCache = new Map();

    /**
     * @param {unknown} err
     */
    function mapErr(err) {
        if (err && typeof err === 'object' && 'category' in err && 'code' in err) {
            return /** @type {import('../../infra/errors.js').AppError} */ (err);
        }
        return mapIdbError(err);
    }

    /**
     * @param {string} ref
     */
    function revokeCached(ref) {
        const cached = urlCache.get(ref);
        const url = cached?.url;
        if (url && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
            try {
                URL.revokeObjectURL(url);
            } catch {
                // ignore
            }
        }
        urlCache.delete(ref);
    }

    const repo = {
        async put(blob, opts) {
            if (typeof Blob === 'undefined' || !(blob instanceof Blob)) {
                return Err(configError({
                    code: 'IMAGE_BLOB_REQUIRED',
                    message: 'put 需要 Blob',
                }));
            }
            return catchToResult(async () => {
                const stableId = opts?.id != null && String(opts.id) !== ''
                    ? String(opts.id)
                    : '';
                const id = stableId || newId('img');
                const record = {
                    id,
                    blob,
                    mimeType: blob.type || 'application/octet-stream',
                    size: blob.size,
                    createdAt: nowIso(),
                    pinned: opts?.pinned === true,
                };
                // 画师串预览按名称覆盖同一 id。旧 objectURL 还指着上一张图。
                if (stableId) revokeCached(stableId);
                await db.put(
                    stableId ? IDB_STORES.ARTIST_IMAGES : IDB_STORES.IMAGES,
                    record,
                );
                return id;
            }, mapErr, Ok, Err);
        },

        async remove(ref) {
            if (ref == null || ref === '') {
                return Ok(undefined);
            }
            const key = String(ref);
            return catchToResult(async () => {
                await db.delete(IDB_STORES.IMAGES, key);
                await db.delete(IDB_STORES.ARTIST_IMAGES, key);
                revokeCached(key);
            }, mapErr, Ok, Err);
        },

        async getBlob(ref) {
            if (ref == null || ref === '') {
                return Ok(null);
            }
            const key = String(ref);
            return catchToResult(async () => {
                const row = await db.get(IDB_STORES.IMAGES, key)
                    || await db.get(IDB_STORES.ARTIST_IMAGES, key);
                return row?.blob || null;
            }, mapErr, Ok, Err);
        },

        async getUrl(ref) {
            if (ref == null || ref === '') {
                return Ok(null);
            }
            const key = String(ref);
            return catchToResult(async () => {
                const row = await db.get(IDB_STORES.IMAGES, key)
                    || await db.get(IDB_STORES.ARTIST_IMAGES, key);
                if (!row || !row.blob) {
                    revokeCached(key);
                    return null;
                }
                const stamp = row.createdAt != null ? String(row.createdAt) : '';
                const cached = urlCache.get(key);
                if (cached && cached.stamp === stamp) {
                    return cached.url;
                }
                revokeCached(key);
                if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
                    return null;
                }
                const url = URL.createObjectURL(row.blob);
                urlCache.set(key, { url, stamp });
                return url;
            }, mapErr, Ok, Err);
        },

        /**
         * 绑定会话 slot → imageRef（出图成功后）。
         * @param {string} sessionId
         * @param {number} slotId
         * @param {string} imageRef
         */
        async linkSlot(sessionId, slotId, imageRef) {
            const sid = String(sessionId ?? '');
            const id = Number(slotId);
            if (!sid || !Number.isInteger(id) || id < 1) {
                return Err(configError({
                    code: 'SLOT_IMAGE_KEY',
                    message: 'linkSlot 需要有效 sessionId 与 slotId',
                }));
            }
            return catchToResult(async () => {
                await db.put(IDB_STORES.SLOT_IMAGE_CACHE, {
                    sessionId: sid,
                    slotId: id,
                    imageRef: String(imageRef),
                    updatedAt: nowIso(),
                });
            }, mapErr, Ok, Err);
        },

        /**
         * 编号复用或显式清缓存。
         * @param {string} sessionId
         * @param {number} slotId
         */
        async unlinkSlot(sessionId, slotId) {
            return catchToResult(async () => {
                await db.delete(IDB_STORES.SLOT_IMAGE_CACHE, [String(sessionId), Number(slotId)]);
            }, mapErr, Ok, Err);
        },

        async clearSlot(sessionId, slotId) {
            const sid = String(sessionId ?? '');
            const id = Number(slotId);
            return catchToResult(async () => {
                const row = await db.get(IDB_STORES.SLOT_IMAGE_CACHE, [sid, id]);
                if (row?.imageRef) {
                    const ref = String(row.imageRef);
                    await db.delete(IDB_STORES.IMAGES, ref);
                    revokeCached(ref);
                }
                await db.delete(IDB_STORES.SLOT_IMAGE_CACHE, [sid, id]);
            }, mapErr, Ok, Err);
        },

        /**
         * @param {string} sessionId
         * @param {number} slotId
         */
        async getSlotImageRef(sessionId, slotId) {
            const sid = String(sessionId ?? '');
            const id = Number(slotId);
            return catchToResult(async () => {
                const row = await db.get(IDB_STORES.SLOT_IMAGE_CACHE, [sid, id]);
                if (!row?.imageRef) {
                    return null;
                }
                const ref = String(row.imageRef);
                const img = await db.get(IDB_STORES.IMAGES, ref);
                if (!img?.blob) {
                    return null;
                }
                return ref;
            }, mapErr, Ok, Err);
        },

        /**
         * @param {string|null} [sessionId]
         */
        async listCacheRefs(sessionId) {
            return catchToResult(async () => {
                /** @type {any[]} */
                let rows;
                if (sessionId != null && sessionId !== '' && typeof db.getAllByIndex === 'function') {
                    rows = await db.getAllByIndex(
                        IDB_STORES.SLOT_IMAGE_CACHE,
                        'by_sessionId',
                        String(sessionId),
                    );
                } else {
                    rows = await db.getAll(IDB_STORES.SLOT_IMAGE_CACHE);
                }
                /** @type {Set<string>} */
                const refs = new Set();
                for (const row of rows) {
                    if (row?.imageRef) {
                        refs.add(String(row.imageRef));
                    }
                }
                return [...refs];
            }, mapErr, Ok, Err);
        },

        /**
         * 合并会话记录引用 + 缓存索引引用（供 GC）。
         * @param {Iterable<object>} records
         * @param {string|null} [sessionId]
         */
        async collectLiveRefs(records, sessionId) {
            return catchToResult(async () => {
                /** @type {Set<string>} */
                const refs = new Set(collectLiveRefsFromRecords(records));
                const cacheR = await repo.listCacheRefs(sessionId);
                if (!cacheR.ok) {
                    throw cacheR.error;
                }
                for (const ref of cacheR.value) {
                    refs.add(ref);
                }
                return [...refs];
            }, mapErr, Ok, Err);
        },

        /**
         * @param {import('../../domain/model/slot.js').ImageRef[]} liveRefs
         * @param {{ force?: boolean }} [opts]
         */
        async gc(liveRefs, opts) {
            if (!Array.isArray(liveRefs)) {
                return Err(configError({
                    code: 'IMAGE_GC_INVALID_LIVE_REFS',
                    message: 'gc 需要 liveRefs 数组',
                    hint: '请先收集仍在使用的图片引用；确需强制清空请确认操作',
                    context: { typeofLiveRefs: typeof liveRefs },
                }));
            }

            const live = new Set(
                liveRefs
                    .filter((r) => r != null && r !== '')
                    .map((r) => String(r)),
            );

            if (live.size === 0 && opts?.force !== true) {
                return Err(configError({
                    code: 'IMAGE_GC_EMPTY_LIVE_REFS',
                    message: 'gc 拒绝空 liveRefs（防止误删全库）',
                    hint: '请先收集仍在使用的图片引用；确需强制清空请确认操作',
                    context: { force: false, inputLength: liveRefs.length },
                }));
            }

            return catchToResult(async () => {
                const all = await db.getAll(IDB_STORES.IMAGES);
                let removed = 0;
                for (const row of all) {
                    const id = String(row.id);
                    if (!live.has(id)) {
                        await db.delete(IDB_STORES.IMAGES, id);
                        revokeCached(id);
                        removed += 1;
                    }
                }
                // 同步清掉指向已删 blob 的缓存索引
                const cacheRows = await db.getAll(IDB_STORES.SLOT_IMAGE_CACHE);
                for (const row of cacheRows) {
                    if (row?.imageRef && !live.has(String(row.imageRef))) {
                        await db.delete(IDB_STORES.SLOT_IMAGE_CACHE, [row.sessionId, row.slotId]);
                    }
                }
                return { removed };
            }, mapErr, Ok, Err);
        },

        async listMeta() {
            return catchToResult(async () => {
                const all = await db.getAll(IDB_STORES.IMAGES);
                return all.map((row) => ({
                    id: String(row.id),
                    size: Number(row.size) || (row.blob && row.blob.size) || 0,
                    createdAt: row.createdAt || '',
                    pinned: row.pinned === true,
                    mimeType: row.mimeType || '',
                })).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
            }, mapErr, Ok, Err);
        },

        async estimateUsage() {
            return catchToResult(async () => {
                const all = await db.getAll(IDB_STORES.IMAGES);
                let bytes = 0;
                for (const row of all) {
                    bytes += Number(row.size) || (row.blob && row.blob.size) || 0;
                }
                let quota = null;
                let usage = null;
                try {
                    if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
                        const est = await navigator.storage.estimate();
                        quota = est.quota ?? null;
                        usage = est.usage ?? null;
                    }
                } catch {
                    // ignore
                }
                return { bytes, count: all.length, quota, usage };
            }, mapErr, Ok, Err);
        },

        /**
         * 按张数上限裁剪：全部缓存图按 createdAt 从老到新，删掉超出上限的最老部分。
         * 同步删 SLOT_IMAGE_CACHE 中指向被删图的行，并 revoke object URL。
         * 画师串示例图在独立的 ARTIST_IMAGES 表，不受影响。
         * @param {number} limit 整数 ≥1
         * @returns {Promise<import('../../infra/result.js').Ok<{ removed: number, removedRefs: string[] }>|import('../../infra/result.js').Err<import('../../infra/errors.js').AppError>>}
         */
        async trimToLimit(limit) {
            const n = Number(limit);
            if (!Number.isInteger(n) || n < 1) {
                return Err(configError({
                    code: 'IMAGE_CACHE_LIMIT',
                    message: '图片缓存上限必须是 ≥1 的整数',
                }));
            }
            return catchToResult(async () => {
                const all = await db.getAll(IDB_STORES.IMAGES);
                if (all.length <= n) {
                    return { removed: 0, removedRefs: /** @type {string[]} */ ([]) };
                }
                const sorted = [...all].sort((a, b) => {
                    const ca = String(a?.createdAt ?? '');
                    const cb = String(b?.createdAt ?? '');
                    if (ca !== cb) {
                        return ca < cb ? -1 : 1;
                    }
                    return String(a?.id ?? '').localeCompare(String(b?.id ?? ''));
                });
                const excess = sorted.length - n;
                const toRemove = sorted.slice(0, excess);
                /** @type {string[]} */
                const removedRefs = [];
                /** @type {Set<string>} */
                const removedSet = new Set();
                for (const row of toRemove) {
                    const id = String(row.id);
                    await db.delete(IDB_STORES.IMAGES, id);
                    revokeCached(id);
                    removedRefs.push(id);
                    removedSet.add(id);
                }
                const cacheRows = await db.getAll(IDB_STORES.SLOT_IMAGE_CACHE);
                for (const row of cacheRows) {
                    if (row?.imageRef && removedSet.has(String(row.imageRef))) {
                        await db.delete(IDB_STORES.SLOT_IMAGE_CACHE, [row.sessionId, row.slotId]);
                    }
                }
                return { removed: removedRefs.length, removedRefs };
            }, mapErr, Ok, Err);
        },

        /**
         * 批量删除指定的本机缓存图（IMAGES 表），同步清理 SLOT_IMAGE_CACHE 并 revoke object URL。
         * 不触碰 ARTIST_IMAGES（画师串封面）。
         * @param {string[]} refs
         * @returns {Promise<import('../../infra/result.js').Ok<{ removed: number, removedRefs: string[] }>|import('../../infra/result.js').Err<import('../../infra/errors.js').AppError>>}
         */
        async removeMany(refs) {
            const want = new Set(
                (Array.isArray(refs) ? refs : [])
                    .filter((r) => r != null && r !== '')
                    .map((r) => String(r)),
            );
            if (!want.size) {
                return Ok({ removed: 0, removedRefs: /** @type {string[]} */ ([]) });
            }
            return catchToResult(async () => {
                const all = await db.getAll(IDB_STORES.IMAGES);
                /** @type {string[]} */
                const removedRefs = [];
                /** @type {Set<string>} */
                const removedSet = new Set();
                for (const row of all) {
                    const id = String(row.id);
                    if (!want.has(id)) continue;
                    await db.delete(IDB_STORES.IMAGES, id);
                    revokeCached(id);
                    removedRefs.push(id);
                    removedSet.add(id);
                }
                if (removedSet.size) {
                    const cacheRows = await db.getAll(IDB_STORES.SLOT_IMAGE_CACHE);
                    for (const row of cacheRows) {
                        if (row?.imageRef && removedSet.has(String(row.imageRef))) {
                            await db.delete(IDB_STORES.SLOT_IMAGE_CACHE, [row.sessionId, row.slotId]);
                        }
                    }
                }
                return { removed: removedRefs.length, removedRefs };
            }, mapErr, Ok, Err);
        },

        /**
         * 清空本机图片缓存（IMAGES 表全部图片），同步清理 SLOT_IMAGE_CACHE 并 revoke object URL。
         * 不触碰 ARTIST_IMAGES（画师串封面）。
         * @returns {Promise<import('../../infra/result.js').Ok<{ removed: number, removedRefs: string[] }>|import('../../infra/result.js').Err<import('../../infra/errors.js').AppError>>}
         */
        async clearCache() {
            return catchToResult(async () => {
                const all = await db.getAll(IDB_STORES.IMAGES);
                /** @type {string[]} */
                const removedRefs = [];
                /** @type {Set<string>} */
                const removedSet = new Set();
                for (const row of all) {
                    const id = String(row.id);
                    await db.delete(IDB_STORES.IMAGES, id);
                    revokeCached(id);
                    removedRefs.push(id);
                    removedSet.add(id);
                }
                if (removedSet.size) {
                    const cacheRows = await db.getAll(IDB_STORES.SLOT_IMAGE_CACHE);
                    for (const row of cacheRows) {
                        if (row?.imageRef && removedSet.has(String(row.imageRef))) {
                            await db.delete(IDB_STORES.SLOT_IMAGE_CACHE, [row.sessionId, row.slotId]);
                        }
                    }
                }
                return { removed: removedRefs.length, removedRefs };
            }, mapErr, Ok, Err);
        },

        revokeAllUrls() {
            for (const ref of [...urlCache.keys()]) {
                revokeCached(ref);
            }
        },
    };

    return repo;
}
