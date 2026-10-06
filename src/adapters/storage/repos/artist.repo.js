/**
 * L2 适配器 · ArtistString 仓库（需求 4.2）。
 * 导入导出为裸数组五字段；示例图只写本机，路径由名称算出，不进公共图片缓存。
 */

import { Ok, Err } from '../../../infra/result.js';
import { configError, hostError } from '../../../infra/errors.js';
import { newId } from '../../../infra/id.js';
import { nowIso } from '../../../infra/clock.js';
import { yieldMain } from '../../../infra/yield-main.js';
import { IDB_STORES } from '../idb.js';
import { mapIdbError } from '../idb.js';
import {
    catchToResult,
    createChangeEmitter,
} from '../import-export.js';
import {
    ARTIST_MODEL_TAGS,
    artistDuplicateKey,
    resolveArtistModelTag,
    sortArtistsBySequence,
    validateArtist,
    nextArtistSequence,
} from '../../../domain/model/artist.js';
import {
    artistFromImportRow,
    buildArtistExportRow,
    normalizeArtistImportPayload,
    pickArtistImportFields,
    toImageDataUrl,
} from '../artist-io.js';
import { artistLocalImageId, blobToBase64 } from '../artist-preview-files.js';
import { dataUrlToBlob } from '../image-scale.js';

/**
 * @param {{ put: Function, remove?: Function, getBlob: Function }|null} imageRepo
 * @param {Blob} blob
 * @param {string} id 固定路径，再次导入覆盖同一条
 */
async function saveLocalArtistBlob(imageRepo, blob, id) {
    if (!imageRepo || typeof imageRepo.put !== 'function') {
        return Err(configError({
            code: 'ARTIST_PREVIEW_NO_LOCAL_STORE',
            message: '示例图存储不可用',
        }));
    }
    return imageRepo.put(blob, { id });
}

/**
 * @param {{ remove?: Function }|null} imageRepo
 * @param {string|null|undefined} ref
 */
async function dropLocalArtistBlob(imageRepo, ref) {
    if (!ref || !imageRepo || typeof imageRepo.remove !== 'function') {
        return;
    }
    await imageRepo.remove(ref);
}

/**
 * @param {any} row
 * @returns {boolean}
 */
function rowHasCanonicalModelTag(row) {
    if (!ARTIST_MODEL_TAGS.includes(String(row?.modelTag ?? ''))) return false;
    return !Array.isArray(row?.modelTags);
}

/**
 * @param {{ getBlob?: Function }|null} imageRepo
 * @param {string|null|undefined} ref
 * @param {string} label
 */
async function readLocalArtistDataUrl(imageRepo, ref, label) {
    if (ref == null || ref === '') {
        return Ok(null);
    }
    if (!imageRepo || typeof imageRepo.getBlob !== 'function') {
        return Err(configError({
            code: 'ARTIST_PREVIEW_NO_LOCAL_STORE',
            message: '示例图存储不可用',
        }));
    }
    const got = await imageRepo.getBlob(ref);
    if (!got.ok) return got;
    if (!got.value) {
        return Err(hostError({
            code: 'ARTIST_IMAGE_MISSING',
            message: `${label}不存在或无法读取`,
            context: { ref: String(ref) },
        }));
    }
    const blob = got.value;
    const ext = blob.type === 'image/webp' ? 'webp' : 'png';
    const b64 = await blobToBase64(blob);
    return Ok(toImageDataUrl(ext, b64));
}

/**
 * @param {object} deps
 * @param {object} deps.db
 * @param {object} [deps.bus]
 * @param {{ put: Function, remove: Function, getBlob: Function }} [deps.imageRepo]
 * @param {() => string} [deps.nowIso]
 * @param {(prefix?: string) => string} [deps.newId]
 * @param {(blob: Blob) => Promise<Blob>} [deps.makeCardImage]
 * @returns {import('../../../ports/repository.port.js').Repository<any> & {
 *   importJson: Function,
 *   exportJson: Function,
 * }}
 */
export function createArtistRepo(deps) {
    const db = deps?.db;
    if (!db) {
        throw new Error('createArtistRepo requires db');
    }
    const storeName = IDB_STORES.ARTISTS;
    const imageRepo = deps.imageRepo || null;
    const clock = typeof deps.nowIso === 'function' ? deps.nowIso : nowIso;
    const idFn = typeof deps.newId === 'function' ? deps.newId : newId;
    const makeCardImage = typeof deps.makeCardImage === 'function' ? deps.makeCardImage : null;
    const changes = createChangeEmitter();

    /**
     * @param {unknown} err
     */
    function mapErr(err) {
        if (err && typeof err === 'object' && 'category' in err && 'code' in err) {
            return /** @type {import('../../../infra/errors.js').AppError} */ (err);
        }
        return mapIdbError(err);
    }

    /**
     * @param {any[]} rows
     */
    function normalizeList(rows) {
        /** @type {import('../../../domain/model/artist.js').ArtistString[]} */
        const out = [];
        for (const row of rows) {
            const v = validateArtist(row);
            if (v.ok) out.push(v.value);
        }
        return sortArtistsBySequence(out);
    }

    /**
     * @param {AbortSignal|undefined} signal
     */
    function abortIfNeeded(signal) {
        if (signal?.aborted) {
            return Err(hostError({
                code: 'ARTIST_IO_ABORTED',
                message: '已取消',
                retryable: false,
            }));
        }
        return null;
    }

    /**
     * @param {import('../../../domain/model/artist.js').ArtistString[]} entities
     * @param {string[]} [removeIds]
     */
    async function bulkWrite(entities, removeIds = []) {
        if (typeof db.runTransaction === 'function') {
            await db.runTransaction([storeName], 'readwrite', (stores) => {
                for (const id of removeIds) {
                    stores[storeName].delete(id);
                }
                for (const entity of entities) {
                    stores[storeName].put(entity);
                }
            });
            return;
        }
        for (const id of removeIds) {
            await db.delete(storeName, id);
        }
        for (const entity of entities) {
            await db.put(storeName, entity);
        }
    }

    /**
     * 旧库没有模型版本时写成 v5。写失败不挡住本次读取。
     * @param {any[]} rows
     * @param {import('../../../domain/model/artist.js').ArtistString[]} items
     */
    async function backfillMissingModelTags(rows, items) {
        /** @type {Set<string>} */
        const stale = new Set();
        for (const row of rows || []) {
            if (!row || row.id == null || rowHasCanonicalModelTag(row)) continue;
            stale.add(String(row.id));
        }
        if (!stale.size) return;
        const patch = items.filter((item) => stale.has(item.id));
        if (!patch.length) return;
        try {
            await bulkWrite(patch);
        } catch {
            // 回填失败时界面仍按规范化结果展示 v5
        }
    }

    return {
        async list() {
            return catchToResult(async () => {
                const rows = await db.getAll(storeName);
                const items = normalizeList(rows);
                await backfillMissingModelTags(rows, items);
                return items;
            }, mapErr, Ok, Err);
        },

        async get(id) {
            return catchToResult(async () => {
                const row = await db.get(storeName, id);
                if (!row) return null;
                const v = validateArtist(row);
                return v.ok ? v.value : null;
            }, mapErr, Ok, Err);
        },

        async put(entity) {
            const validated = validateArtist(entity);
            if (!validated.ok) return validated;
            return catchToResult(async () => {
                await db.put(storeName, validated.value);
                changes.emit({ type: 'put', id: validated.value.id });
                return validated.value;
            }, mapErr, Ok, Err);
        },

        async remove(id) {
            return catchToResult(async () => {
                await db.delete(storeName, id);
                changes.emit({ type: 'remove', id });
            }, mapErr, Ok, Err);
        },

        /**
         * 导出裸数组五字段；按 sequence 排序。
         * 原图读不到就留空并继续，不中断整次导出。
         * 传入 modelTag 时只导出该版本。
         * @param {{
         *   modelTag?: string,
         *   onWarning?: (message: string) => void,
         *   onProgress?: (p: { index: number, total: number, name: string }) => void,
         *   signal?: AbortSignal,
         * }} [opts]
         */
        async exportJson(opts = {}) {
            const signal = opts.signal;
            const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
            const onWarning = typeof opts.onWarning === 'function' ? opts.onWarning : null;
            const modelTag = opts.modelTag != null && opts.modelTag !== ''
                ? resolveArtistModelTag(opts.modelTag)
                : '';

            try {
                const aborted0 = abortIfNeeded(signal);
                if (aborted0) return aborted0;

                const items = normalizeList(await db.getAll(storeName))
                    .filter((artist) => !modelTag || artist.modelTag === modelTag);
                /** @type {ReturnType<typeof buildArtistExportRow>[]} */
                const out = [];

                for (let i = 0; i < items.length; i += 1) {
                    const aborted = abortIfNeeded(signal);
                    if (aborted) return aborted;

                    const artist = items[i];
                    if (onProgress) {
                        onProgress({ index: i + 1, total: items.length, name: artist.name });
                    }

                    /** @type {string|null} */
                    let referenceImage = null;
                    if (artist.referenceImageRef) {
                        const refR = await readLocalArtistDataUrl(
                            imageRepo,
                            artist.referenceImageRef,
                            `「${artist.name}」原图`,
                        );
                        if (refR.ok && refR.value) {
                            referenceImage = refR.value;
                        } else if (onWarning) {
                            onWarning(refR.ok
                                ? `「${artist.name}」原图不存在或无法读取`
                                : (refR.error?.message || `「${artist.name}」原图不存在或无法读取`));
                        }
                    }

                    out.push(buildArtistExportRow({
                        name: artist.name,
                        sequence: artist.sequence,
                        positivePrompt: artist.positivePrompt,
                        negativePrompt: artist.negativePrompt,
                        referenceImage,
                    }));
                }

                return Ok(out);
            } catch (err) {
                return Err(mapErr(err));
            }
        },

        /**
         * 导入：自动识别五字段数组或 { presets, images }；按名称加版本判重；
         * 原图上传 + 卡片图生成计入进度；库文件批量写一次。
         * 某条失败记入 errors 并继续；已成功保留。
         * @param {unknown} data
         * @param {{
         *   strategy?: 'skip'|'overwrite'|'rename',
         *   modelTag?: string,
         *   onProgress?: (p: { index: number, total: number, name: string }) => void,
         *   signal?: AbortSignal,
         * }} [opts]
         * `modelTag` 打到本次导入的每一条上，只能有一个；不传则视为 v5。
         * 判重是名称加版本：同名但版本不同会另存，不会覆盖。
         */
        async importJson(data, opts = {}) {
            const normalized = normalizeArtistImportPayload(data);
            if (!normalized.ok) {
                return Err(configError({
                    code: 'IMPORT_SHAPE',
                    message: normalized.error,
                }));
            }

            const strategy = opts.strategy === 'overwrite' || opts.strategy === 'rename'
                ? opts.strategy
                : 'skip';
            const signal = opts.signal;
            const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
            const now = clock();

            let imported = 0;
            let skipped = 0;
            /** @type {string[]} */
            const errors = [];
            /** @type {import('../../../domain/model/artist.js').ArtistString[]} */
            const toWrite = [];

            try {
                const existing = normalizeList(await db.getAll(storeName));
                const importTag = resolveArtistModelTag(opts.modelTag);
                /** @type {Map<string, import('../../../domain/model/artist.js').ArtistString>} */
                const byIdentity = new Map(existing.map((e) => [artistDuplicateKey(e.name, e.modelTag), e]));

                /** @type {import('../artist-io.js').ArtistExportRow[]} */
                let rows;
                if (normalized.format === 'presets') {
                    let seq = nextArtistSequence(existing);
                    rows = normalized.value.map((r) => ({
                        .../** @type {import('../artist-io.js').ArtistExportRow} */ (r),
                        sequence: seq++,
                    }));
                } else {
                    rows = [];
                    for (let i = 0; i < normalized.value.length; i += 1) {
                        const picked = pickArtistImportFields(
                            /** @type {Record<string, unknown>} */ (normalized.value[i]),
                        );
                        if (!picked.ok) {
                            errors.push(`第 ${i + 1} 条：${picked.error}`);
                            continue;
                        }
                        rows.push(picked.value);
                    }
                }

                /** 进度让出节流：每条都让出会在大批量时徒增数百 ms～数秒 */
                let lastYieldAt = 0;
                const YIELD_MIN_MS = 32;

                for (let i = 0; i < rows.length; i += 1) {
                    const aborted = abortIfNeeded(signal);
                    if (aborted) {
                        if (toWrite.length) {
                            try {
                                await bulkWrite(toWrite);
                                changes.emit({ type: 'import', imported, skipped });
                            } catch {
                                // ignore secondary write error on abort
                            }
                        }
                        return aborted;
                    }

                    const row = rows[i];
                    if (onProgress) {
                        onProgress({ index: i + 1, total: rows.length, name: row.name });
                    }
                    // 让出主线程：进度文案可绘制；按时间节流，避免 N 次空转
                    const nowYield = typeof performance !== 'undefined' && performance.now
                        ? performance.now()
                        : Date.now();
                    if (nowYield - lastYieldAt >= YIELD_MIN_MS || i === 0 || i === rows.length - 1) {
                        lastYieldAt = nowYield;
                        await yieldMain();
                    }

                    const existingRow = byIdentity.get(artistDuplicateKey(row.name, importTag));
                    if (existingRow && strategy === 'skip') {
                        skipped += 1;
                        continue;
                    }

                    let id;
                    let createdAt;
                    let name = row.name;
                    /** @type {string|null} */
                    let oldRef = null;
                    /** @type {string|null} */
                    let oldCard = null;

                    if (existingRow && strategy === 'overwrite') {
                        id = existingRow.id;
                        createdAt = existingRow.createdAt;
                        oldRef = existingRow.referenceImageRef;
                        oldCard = existingRow.cardImageRef;
                    } else {
                        id = idFn('ar');
                        createdAt = now;
                        if (existingRow && strategy === 'rename') {
                            name = `${row.name} · 导入副本`;
                        }
                    }

                    /** @type {string|null} */
                    let referenceImageRef = null;
                    /** @type {string|null} */
                    let cardImageRef = null;

                    try {
                        if (row.referenceImage) {
                            const blob = await dataUrlToBlob(row.referenceImage);
                            referenceImageRef = artistLocalImageId(name, 'ref', importTag);
                            cardImageRef = artistLocalImageId(name, 'card', importTag);
                            const up = await saveLocalArtistBlob(imageRepo, blob, referenceImageRef);
                            if (!up.ok) {
                                throw new Error(up.error.message || '原图保存失败');
                            }
                            if (!makeCardImage) {
                                throw new Error('卡片图处理不可用');
                            }
                            const cardBlob = await makeCardImage(blob);
                            const cardUp = await saveLocalArtistBlob(imageRepo, cardBlob, cardImageRef);
                            if (!cardUp.ok) {
                                throw new Error(cardUp.error.message || '卡片图保存失败');
                            }
                            if (oldRef && oldRef !== referenceImageRef) {
                                await dropLocalArtistBlob(imageRepo, oldRef);
                            }
                            if (oldCard && oldCard !== cardImageRef) {
                                await dropLocalArtistBlob(imageRepo, oldCard);
                            }
                            oldRef = null;
                            oldCard = null;
                            row.referenceImage = null;
                        } else if (strategy === 'overwrite') {
                            await dropLocalArtistBlob(imageRepo, oldRef);
                            await dropLocalArtistBlob(imageRepo, oldCard);
                            oldRef = null;
                            oldCard = null;
                        }
                    } catch (err) {
                        errors.push(`「${row.name}」：${err instanceof Error ? err.message : String(err)}`);
                        await dropLocalArtistBlob(imageRepo, referenceImageRef);
                        await dropLocalArtistBlob(imageRepo, cardImageRef);
                        continue;
                    }

                    const entity = artistFromImportRow({
                        row: { ...row, name },
                        id,
                        now,
                        createdAt,
                        referenceImageRef,
                        cardImageRef,
                        modelTag: importTag,
                    });
                    const validated = validateArtist(entity);
                    if (!validated.ok) {
                        errors.push(`「${row.name}」：${validated.error.message}`);
                        await dropLocalArtistBlob(imageRepo, referenceImageRef);
                        await dropLocalArtistBlob(imageRepo, cardImageRef);
                        continue;
                    }

                    toWrite.push(validated.value);
                    byIdentity.set(artistDuplicateKey(validated.value.name, validated.value.modelTag), validated.value);
                    imported += 1;
                }

                if (toWrite.length) {
                    await bulkWrite(toWrite);
                }
                changes.emit({ type: 'import', imported, skipped });
                return Ok({ imported, skipped, errors });
            } catch (err) {
                return Err(mapErr(err));
            }
        },

        onChanged(fn) {
            return changes.subscribe(fn);
        },
    };
}
