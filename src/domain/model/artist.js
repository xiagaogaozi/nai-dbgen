/**
 * L3 领域模型 · 画师串（架构文档 §5.1，需求 4.2）。
 * 导入导出五字段：name / sequence / positivePrompt / negativePrompt / referenceImage。
 * 库内另存 referenceImageRef + cardImageRef（卡片图不导出），以及 modelTag（一个模型版本，不进五字段导出）。
 * 没有版本的旧数据一律视为 v5。同名且版本相同才是同一条；版本不同是另一条。
 */

import {
    isNonEmptyString,
    isPlainObject,
    requireArg,
    schemaVersionMismatch,
    validationErr,
    validationOk,
} from '../../infra/validate.js';

export const ARTIST_SCHEMA_VERSION = 1;

/**
 * 画师串适用的 NAI 模型版本。顺序即展示与存储顺序。
 * @readonly
 */
export const ARTIST_MODEL_TAGS = Object.freeze(['v4.5', 'v5']);

/**
 * 旧库、未标明版本的画师串使用的版本。
 * @readonly
 */
export const DEFAULT_ARTIST_MODEL_TAGS = Object.freeze(['v5']);

/**
 * 库列表卡片图：宽 480、按原图比例、webp。
 * @readonly
 */
export const ARTIST_CARD_IMAGE = Object.freeze({
    width: 480,
    quality: 0.85,
});

/**
 * @typedef {string} ImageRef 服务器示例图文件名
 */

/**
 * @typedef {object} ArtistString
 * @property {number} schemaVersion
 * @property {string} id
 * @property {string} name
 * @property {number} sequence
 * @property {string} positivePrompt
 * @property {string} negativePrompt
 * @property {ImageRef|null} referenceImageRef
 * @property {ImageRef|null} cardImageRef 卡片图（不导出；导入/预览时从原图生成）
 * @property {string} modelTag 适用模型版本，只能是 v4.5 或 v5；缺省为 v5
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {{ id: string, now: string }} IdNowDeps
 */

/**
 * @param {object} input
 * @param {IdNowDeps} deps
 * @returns {ArtistString}
 */
export function createArtist(input, deps) {
    requireArg(isPlainObject(input), 'input');
    requireArg(deps && isNonEmptyString(deps.id) && isNonEmptyString(deps.now), 'deps');
    const sequence = Number(input.sequence);
    return {
        schemaVersion: ARTIST_SCHEMA_VERSION,
        id: deps.id,
        name: String(input.name ?? ''),
        sequence: Number.isFinite(sequence) ? sequence : 0,
        positivePrompt: String(input.positivePrompt ?? ''),
        negativePrompt: String(input.negativePrompt ?? ''),
        referenceImageRef: input.referenceImageRef == null || input.referenceImageRef === ''
            ? null
            : String(input.referenceImageRef),
        cardImageRef: input.cardImageRef == null || input.cardImageRef === ''
            ? null
            : String(input.cardImageRef),
        modelTag: resolveArtistModelTag(input.modelTag != null ? input.modelTag : input.modelTags),
        createdAt: deps.now,
        updatedAt: deps.now,
    };
}

/**
 * 收成一个已知版本。字符串、旧的 modelTags 数组、或带这两个字段的画师对象都可以。
 * 缺字段或全是未知值时回落到 v5。数组里有多个已知版本时只留第一个。
 * @param {unknown} source
 * @returns {string}
 */
export function resolveArtistModelTag(source) {
    if (typeof source === 'string') {
        return ARTIST_MODEL_TAGS.includes(source) ? source : DEFAULT_ARTIST_MODEL_TAGS[0];
    }
    if (Array.isArray(source)) {
        for (const item of source) {
            const tag = String(item);
            if (ARTIST_MODEL_TAGS.includes(tag)) return tag;
        }
        return DEFAULT_ARTIST_MODEL_TAGS[0];
    }
    if (source && typeof source === 'object') {
        const row = /** @type {{ modelTag?: unknown, modelTags?: unknown }} */ (source);
        if (typeof row.modelTag === 'string' && ARTIST_MODEL_TAGS.includes(row.modelTag)) {
            return row.modelTag;
        }
        if (Array.isArray(row.modelTags)) return resolveArtistModelTag(row.modelTags);
    }
    return DEFAULT_ARTIST_MODEL_TAGS[0];
}

/**
 * 判重键：名称 + 版本。版本不同则不是同一条。
 * @param {string} name
 * @param {unknown} modelTag
 * @returns {string}
 */
export function artistDuplicateKey(name, modelTag) {
    return `${String(name)}\u0000${resolveArtistModelTag(modelTag)}`;
}

/**
 * @param {{ modelTag?: unknown, modelTags?: unknown }|null|undefined} artist
 * @param {string} tag
 * @returns {boolean}
 */
export function artistHasModelTag(artist, tag) {
    return resolveArtistModelTag(artist) === String(tag);
}

/**
 * @param {unknown} obj
 * @returns {{ ok: true, value: ArtistString } | { ok: false, error: import('../../infra/errors.js').AppError }}
 */
export function validateArtist(obj) {
    if (!isPlainObject(obj)) {
        return validationErr('ARTIST_SHAPE', '画师串格式无效');
    }
    if (!isNonEmptyString(obj.id)) {
        return validationErr('ARTIST_ID', '画师串缺少 id');
    }
    if (!isNonEmptyString(obj.name)) {
        return validationErr('ARTIST_NAME', '请填写画师串名称');
    }
    if (typeof obj.positivePrompt !== 'string' || typeof obj.negativePrompt !== 'string') {
        return validationErr('ARTIST_PN', '正负向必须是文本');
    }
    if (typeof obj.sequence !== 'number' || !Number.isFinite(obj.sequence)) {
        return validationErr('ARTIST_SEQUENCE', '排序号必须是数字');
    }
    const ver = schemaVersionMismatch(obj, ARTIST_SCHEMA_VERSION, 'ARTIST_SCHEMA', '画师串');
    if (ver) {
        return ver;
    }
    return validationOk(/** @type {ArtistString} */ (normalizeArtist(obj)));
}

/**
 * @param {Record<string, unknown>} obj
 * @returns {ArtistString}
 */
export function normalizeArtist(obj) {
    const sequence = Number(obj.sequence);
    return {
        schemaVersion: ARTIST_SCHEMA_VERSION,
        id: String(obj.id),
        name: String(obj.name ?? ''),
        sequence: Number.isFinite(sequence) ? sequence : 0,
        positivePrompt: String(obj.positivePrompt ?? ''),
        negativePrompt: String(obj.negativePrompt ?? ''),
        referenceImageRef: obj.referenceImageRef == null || obj.referenceImageRef === ''
            ? null
            : String(obj.referenceImageRef),
        cardImageRef: obj.cardImageRef == null || obj.cardImageRef === ''
            ? null
            : String(obj.cardImageRef),
        modelTag: resolveArtistModelTag(obj.modelTag != null ? obj.modelTag : obj.modelTags),
        createdAt: String(obj.createdAt ?? ''),
        updatedAt: String(obj.updatedAt ?? ''),
    };
}

/**
 * 当前库最大 sequence + 1；空库从 0 起。
 * @param {Iterable<{ sequence?: number }>} artists
 * @returns {number}
 */
export function nextArtistSequence(artists) {
    let max = -1;
    for (const item of artists || []) {
        const n = Number(item?.sequence);
        if (Number.isFinite(n) && n > max) {
            max = n;
        }
    }
    return max + 1;
}

/**
 * 按 sequence 升序；同号再按 name。
 * @param {ArtistString[]} items
 * @returns {ArtistString[]}
 */
export function sortArtistsBySequence(items) {
    return [...(items || [])].sort((a, b) => {
        const d = (Number(a.sequence) || 0) - (Number(b.sequence) || 0);
        if (d !== 0) return d;
        return String(a.name || '').localeCompare(String(b.name || ''));
    });
}
