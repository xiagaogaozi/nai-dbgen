/**
 * L2 适配器 · 画师串导入导出映射（需求 4.2）。
 * 外部格式 A：裸 JSON 数组，仅五字段；其它字段（含 thumbnail）导入忽略，导出不写。
 * 外部格式 B：`{ presets, images }` 只导入不导出；导入入口自动识别。
 */

import { isPlainObject } from '../../infra/validate.js';
import {
    ARTIST_SCHEMA_VERSION,
    normalizeArtist,
} from '../../domain/model/artist.js';

/** @type {readonly string[]} */
export const ARTIST_EXPORT_FIELD_ORDER = Object.freeze([
    'name',
    'sequence',
    'positivePrompt',
    'negativePrompt',
    'referenceImage',
]);

/**
 * @typedef {object} ArtistExportRow
 * @property {string} name
 * @property {number} sequence
 * @property {string} positivePrompt
 * @property {string} negativePrompt
 * @property {string|null} referenceImage
 */

/**
 * @typedef {'array'|'presets'} ArtistImportFormat
 */

/**
 * 自动识别导入格式。
 * - 顶层数组 → array（原始对象列表，逐条 pick；单条失败不阻断）
 * - 顶层对象且有 presets 对象 → presets（已映射为五字段行；sequence 暂 0）
 * - 其它 → 明确报错
 * @param {unknown} data
 * @returns {{ ok: true, value: object[], format: ArtistImportFormat } | { ok: false, error: string }}
 */
export function normalizeArtistImportPayload(data) {
    if (Array.isArray(data)) {
        const parsed = parseArtistImportArray(data);
        if (!parsed.ok) return parsed;
        return { ok: true, value: parsed.value, format: 'array' };
    }
    if (isPlainObject(data) && isPlainObject(data.presets)) {
        return convertPresetsArtistImport(data);
    }
    return {
        ok: false,
        error: '无法识别的画师串导入格式，请使用支持的 JSON 结构',
    };
}

/**
 * presets 格式 → 五字段行（只导入不导出）。
 * sequence 填 0；调用方按库内 max+1 续编。
 * @param {Record<string, unknown>} data
 * @returns {{ ok: true, value: ArtistExportRow[], format: 'presets' } | { ok: false, error: string }}
 */
export function convertPresetsArtistImport(data) {
    if (!isPlainObject(data) || !isPlainObject(data.presets)) {
        return { ok: false, error: 'presets 格式无效：缺少 presets 对象' };
    }
    const presets = /** @type {Record<string, unknown>} */ (data.presets);
    const images = isPlainObject(data.images)
        ? /** @type {Record<string, unknown>} */ (data.images)
        : {};

    /** @type {ArtistExportRow[]} */
    const rows = [];
    for (const [rawName, preset] of Object.entries(presets)) {
        const name = String(rawName);
        if (!name.trim()) {
            return { ok: false, error: 'presets 中存在空名称键' };
        }
        if (!isPlainObject(preset)) {
            return { ok: false, error: `「${name}」的 preset 不是对象` };
        }
        const fixed = preset.fixedPrompt == null ? '' : String(preset.fixedPrompt);
        const fixedEnd = preset.fixedPrompt_end == null ? '' : String(preset.fixedPrompt_end);
        const positivePrompt = fixedEnd !== '' ? `${fixed}, ${fixedEnd}` : fixed;
        const negativePrompt = preset.negativePrompt == null ? '' : String(preset.negativePrompt);

        let referenceImage = null;
        const img = images[name];
        if (typeof img === 'string' && img.startsWith('data:image/')) {
            referenceImage = img;
        }

        rows.push({
            name,
            sequence: 0,
            positivePrompt,
            negativePrompt,
            referenceImage,
        });
    }
    return { ok: true, value: rows, format: 'presets' };
}

/**
 * @param {unknown} data
 * @returns {{ ok: true, value: object[] } | { ok: false, error: string }}
 */
export function parseArtistImportArray(data) {
    if (!Array.isArray(data)) {
        return { ok: false, error: '画师串导入必须是 JSON 数组' };
    }
    /** @type {object[]} */
    const rows = [];
    for (let i = 0; i < data.length; i += 1) {
        const item = data[i];
        if (!isPlainObject(item)) {
            return { ok: false, error: `第 ${i + 1} 条不是对象` };
        }
        rows.push(item);
    }
    return { ok: true, value: rows };
}

/**
 * 从外部条目抽出五字段（忽略 thumbnail 等其余）；不做 id 生成。
 * @param {Record<string, unknown>} raw
 * @returns {{ ok: true, value: ArtistExportRow } | { ok: false, error: string }}
 */
export function pickArtistImportFields(raw) {
    if (!isPlainObject(raw)) {
        return { ok: false, error: '条目不是对象' };
    }
    const name = String(raw.name ?? '').trim();
    if (!name) {
        return { ok: false, error: '缺少名称' };
    }
    const sequence = Number(raw.sequence);
    if (!Number.isFinite(sequence)) {
        return { ok: false, error: `「${name}」排序号无效` };
    }
    if (typeof raw.positivePrompt !== 'string' || typeof raw.negativePrompt !== 'string') {
        return { ok: false, error: `「${name}」正负向必须是文本` };
    }
    const referenceImage = normalizeDataUrlOrNull(raw.referenceImage, name, 'referenceImage');
    if (!referenceImage.ok) return referenceImage;

    return {
        ok: true,
        value: {
            name,
            sequence,
            positivePrompt: raw.positivePrompt,
            negativePrompt: raw.negativePrompt,
            referenceImage: referenceImage.value,
        },
    };
}

/**
 * @param {unknown} value
 * @param {string} name
 * @param {string} field
 * @returns {{ ok: true, value: string|null } | { ok: false, error: string }}
 */
function normalizeDataUrlOrNull(value, name, field) {
    if (value == null || (typeof value === 'string' && !value.trim())) {
        return { ok: true, value: null };
    }
    if (typeof value !== 'string') {
        return { ok: false, error: `「${name}」的 ${field} 必须是 data URL 或 null` };
    }
    if (!value.startsWith('data:image/')) {
        return { ok: false, error: `「${name}」的 ${field} 不是合法图片 data URL` };
    }
    return { ok: true, value };
}

/**
 * 解析 data URL → { mime, ext, base64 }。
 * @param {string} dataUrl
 * @returns {{ ok: true, value: { mime: string, ext: 'png'|'webp', base64: string } } | { ok: false, error: string }}
 */
export function parseImageDataUrl(dataUrl) {
    const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/.exec(String(dataUrl ?? ''));
    if (!m) {
        return { ok: false, error: '图片 data URL 格式无效' };
    }
    const mime = m[1].toLowerCase();
    const ext = mime.includes('webp') ? 'webp' : 'png';
    return { ok: true, value: { mime, ext, base64: m[2] } };
}

/**
 * @param {'png'|'webp'|string} ext
 * @param {string} base64
 * @returns {string}
 */
export function toImageDataUrl(ext, base64) {
    const mime = ext === 'webp' ? 'image/webp' : 'image/png';
    return `data:${mime};base64,${base64}`;
}

/**
 * 按固定字段顺序构造导出对象（保证 JSON.stringify 键序）。
 * @param {ArtistExportRow} row
 * @returns {ArtistExportRow}
 */
export function buildArtistExportRow(row) {
    return {
        name: String(row.name ?? ''),
        sequence: Number(row.sequence) || 0,
        positivePrompt: String(row.positivePrompt ?? ''),
        negativePrompt: String(row.negativePrompt ?? ''),
        referenceImage: row.referenceImage == null ? null : String(row.referenceImage),
    };
}

/**
 * @param {object} args
 * @param {ArtistExportRow} args.row
 * @param {string} args.id
 * @param {string} args.now
 * @param {string|null} args.referenceImageRef
 * @param {string|null} args.cardImageRef
 * @param {string|undefined} [args.modelTag] 本次导入选定的一个模型版本；缺省视为 v5
 * @param {string} [args.createdAt]
 * @returns {import('../../domain/model/artist.js').ArtistString}
 */
export function artistFromImportRow(args) {
    return normalizeArtist({
        schemaVersion: ARTIST_SCHEMA_VERSION,
        id: args.id,
        name: args.row.name,
        sequence: args.row.sequence,
        positivePrompt: args.row.positivePrompt,
        negativePrompt: args.row.negativePrompt,
        referenceImageRef: args.referenceImageRef,
        cardImageRef: args.cardImageRef ?? null,
        modelTag: args.modelTag,
        createdAt: args.createdAt ?? args.now,
        updatedAt: args.now,
    });
}
