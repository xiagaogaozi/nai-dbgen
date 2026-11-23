/**
 * L4 应用层 · 图片缓存按张数上限裁剪（需求 4.17）。
 * 读常规设置上限 → imageRepo.trimToLimit → 通知 UI。
 */

import { Ok, Err, isErr } from '../infra/result.js';
import { configError } from '../infra/errors.js';
import { APP_EVENTS } from './_helpers.js';

/** 与 defaultPluginSettings().imageCacheLimit 一致 */
const DEFAULT_IMAGE_CACHE_LIMIT = 500;

/**
 * @typedef {object} ImageCacheTrimResult
 * @property {number} removed
 * @property {string[]} removedRefs
 * @property {number} limit
 */

/**
 * @param {object} deps
 * @param {() => { imageCacheLimit?: number }} deps.loadSettings
 * @param {{
 *   trimToLimit: (limit: number) => Promise<import('../infra/result.js').Ok<{ removed: number, removedRefs: string[] }>|import('../infra/result.js').Err<import('../infra/errors.js').AppError>>,
 *   removeMany?: (refs: string[]) => Promise<import('../infra/result.js').Ok<{ removed: number, removedRefs: string[] }>|import('../infra/result.js').Err<import('../infra/errors.js').AppError>>,
 *   clearCache?: () => Promise<import('../infra/result.js').Ok<{ removed: number, removedRefs: string[] }>|import('../infra/result.js').Err<import('../infra/errors.js').AppError>>,
 * }} deps.imageRepo
 * @param {{ emit: (type: string, payload?: unknown) => void }} [deps.bus]
 * @returns {{
 *   trim: () => Promise<import('../infra/result.js').Ok<ImageCacheTrimResult>|import('../infra/result.js').Err<import('../infra/errors.js').AppError>>,
 *   removeRefs: (refs: string[]) => Promise<import('../infra/result.js').Ok<{ removed: number, removedRefs: string[] }>|import('../infra/result.js').Err<import('../infra/errors.js').AppError>>,
 *   clearAll: () => Promise<import('../infra/result.js').Ok<{ removed: number, removedRefs: string[] }>|import('../infra/result.js').Err<import('../infra/errors.js').AppError>>,
 * }}
 */
export function createImageCacheTrimService(deps) {
    const loadSettings = deps?.loadSettings;
    const imageRepo = deps?.imageRepo;
    const bus = deps?.bus;
    if (typeof loadSettings !== 'function') {
        throw new Error('createImageCacheTrimService requires loadSettings');
    }
    if (!imageRepo || typeof imageRepo.trimToLimit !== 'function') {
        throw new Error('createImageCacheTrimService requires imageRepo.trimToLimit');
    }

    /**
     * @param {number} removed
     * @param {string[]} removedRefs
     * @param {number} limit
     */
    function emitTrimmed(removed, removedRefs, limit) {
        if (removed > 0 && bus && typeof bus.emit === 'function') {
            bus.emit(APP_EVENTS.IMAGE_CACHE_TRIMMED, {
                removed,
                removedRefs: [...removedRefs],
                limit,
            });
        }
    }

    return {
        async trim() {
            let limit = DEFAULT_IMAGE_CACHE_LIMIT;
            try {
                const settings = loadSettings();
                const raw = settings?.imageCacheLimit;
                if (Number.isInteger(raw) && raw >= 1) {
                    limit = raw;
                }
            } catch {
                // 读设置失败时用默认上限继续裁剪
            }

            const r = await imageRepo.trimToLimit(limit);
            if (isErr(r)) {
                return r;
            }

            const { removed, removedRefs } = r.value;
            emitTrimmed(removed, removedRefs, limit);

            return Ok({
                removed,
                removedRefs: [...removedRefs],
                limit,
            });
        },

        async removeRefs(refs) {
            if (typeof imageRepo.removeMany !== 'function') {
                return Err(configError({
                    code: 'IMAGE_CACHE_REMOVE_UNSUPPORTED',
                    message: '批量删除图片缓存暂不可用',
                }));
            }
            const r = await imageRepo.removeMany(Array.isArray(refs) ? refs : []);
            if (isErr(r)) {
                return r;
            }
            const { removed, removedRefs } = r.value;
            emitTrimmed(removed, removedRefs, 0);
            return Ok({
                removed,
                removedRefs: [...removedRefs],
            });
        },

        async clearAll() {
            if (typeof imageRepo.clearCache !== 'function') {
                return Err(configError({
                    code: 'IMAGE_CACHE_CLEAR_UNSUPPORTED',
                    message: '清空图片缓存暂不可用',
                }));
            }
            const r = await imageRepo.clearCache();
            if (isErr(r)) {
                return r;
            }
            const { removed, removedRefs } = r.value;
            emitTrimmed(removed, removedRefs, 0);
            return Ok({
                removed,
                removedRefs: [...removedRefs],
            });
        },
    };
}
