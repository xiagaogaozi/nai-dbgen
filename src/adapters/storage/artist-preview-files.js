/**
 * L2 适配器 · 画师串示例图。
 * 导入和预览写本机固定路径，按名称计算，不进会清理的公共图片缓存。
 */

import {
    SERVER_FILE_PREFIX,
    isValidServerFileName,
} from './server-files.js';
import { Ok, Err } from '../../infra/result.js';
import { configError, hostError } from '../../infra/errors.js';
import { parseImageDataUrl, toImageDataUrl } from './artist-io.js';

/**
 * FNV-1a 32-bit → 8 hex，用于 id 安全化后仍保证唯一。
 * @param {string} str
 * @returns {string}
 */
export function fnv1aHex(str) {
    let h = 0x811c9dc5;
    const s = String(str);
    for (let i = 0; i < s.length; i += 1) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * 画师串示例图的本机路径。按名称计算，手机和电脑导入同一条时路径相同。
 * v5 沿用只含名称的旧路径。其它版本把版本算进路径，避免同名不同版本互相覆盖封面。
 * @param {string} name
 * @param {'ref'|'card'} kind
 * @param {string} [modelTag]
 * @returns {string}
 */
export function artistLocalImageId(name, kind, modelTag) {
    const tag = modelTag != null && String(modelTag) !== '' && String(modelTag) !== 'v5'
        ? String(modelTag)
        : '';
    const key = tag ? `${name}\u0000${tag}` : String(name);
    return `artist-${kind}:${sanitizeArtistIdForFile(key)}`;
}

/**
 * @param {string} artistId
 * @returns {string} 仅含 [A-Za-z0-9_\-.] 的安全片段（含哈希防撞）
 */
export function sanitizeArtistIdForFile(artistId) {
    const raw = String(artistId ?? '');
    const cleaned = raw.replace(/[^A-Za-z0-9_\-.]+/g, '_').replace(/^_+|_+$/g, '');
    const base = (cleaned || 'id').slice(0, 64);
    return `${base}__${fnv1aHex(raw)}`;
}

/**
 * 原图文件名。
 * @param {string} artistId
 * @param {'png'|'webp'} [ext='png']
 * @returns {string}
 */
export function artistPreviewFileName(artistId, ext = 'png') {
    const e = ext === 'webp' ? 'webp' : 'png';
    return `${SERVER_FILE_PREFIX}artist-preview_${sanitizeArtistIdForFile(artistId)}.${e}`;
}

/**
 * 卡片图文件名（`_card` 后缀，固定 webp）。
 * @param {string} artistId
 * @returns {string}
 */
export function artistCardFileName(artistId) {
    return `${SERVER_FILE_PREFIX}artist-preview_${sanitizeArtistIdForFile(artistId)}_card.webp`;
}

/**
 * @param {unknown} ref
 * @returns {boolean}
 */
export function isArtistPreviewRef(ref) {
    if (typeof ref !== 'string' || !ref) {
        return false;
    }
    let name = ref;
    if (name.startsWith('/user/files/')) {
        name = name.slice('/user/files/'.length).split('?')[0];
    } else if (name.includes('?')) {
        name = name.split('?')[0];
    }
    return isValidServerFileName(name) && name.startsWith(`${SERVER_FILE_PREFIX}artist-preview_`);
}

/**
 * @param {unknown} ref
 * @returns {string|null} 规范化文件名
 */
export function artistPreviewRefToName(ref) {
    if (typeof ref !== 'string' || !ref) {
        return null;
    }
    let name = ref.trim();
    if (name.startsWith('/user/files/')) {
        name = name.slice('/user/files/'.length);
    }
    name = name.split('?')[0];
    return isValidServerFileName(name) ? name : null;
}

/**
 * Blob → base64（无 data: 前缀）。
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
export async function blobToBase64(blob) {
    const buf = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

/**
 * @param {Blob} blob
 * @returns {'png'|'webp'}
 */
export function extFromBlob(blob) {
    const t = String(blob?.type || '').toLowerCase();
    if (t.includes('webp')) {
        return 'webp';
    }
    return 'png';
}

/**
 * @param {string} fileName
 * @returns {'png'|'webp'}
 */
export function extFromFileName(fileName) {
    return String(fileName).toLowerCase().endsWith('.webp') ? 'webp' : 'png';
}

/**
 * @param {object} deps
 * @param {ReturnType<import('./server-files.js').createServerFiles>} deps.serverFiles
 * @param {string} artistId
 * @param {Blob} blob
 * @param {string|null|undefined} oldRef
 * @param {'reference'|'card'} kind
 */
async function putArtistImageFile(deps, artistId, blob, oldRef, kind) {
    const serverFiles = deps?.serverFiles;
    if (!serverFiles) {
        return Err(configError({
            code: 'ARTIST_PREVIEW_NO_SERVER_FILES',
            message: '示例图存储不可用',
        }));
    }
    if (typeof Blob === 'undefined' || !(blob instanceof Blob)) {
        return Err(configError({
            code: 'ARTIST_PREVIEW_BLOB_REQUIRED',
            message: '示例图需要 Blob',
        }));
    }
    const name = kind === 'card'
        ? artistCardFileName(artistId)
        : artistPreviewFileName(artistId, extFromBlob(blob));
    let b64;
    try {
        b64 = await blobToBase64(blob);
    } catch (err) {
        return Err(hostError({
            code: 'ARTIST_PREVIEW_ENCODE',
            message: '示例图编码失败',
            cause: err,
        }));
    }
    const wr = await serverFiles.writeBase64(name, b64);
    if (!wr.ok) {
        return wr;
    }
    const oldName = artistPreviewRefToName(oldRef);
    if (oldName && oldName !== name) {
        await serverFiles.remove(oldName);
    }
    return Ok(name);
}

/**
 * 上传原图，返回 referenceImageRef 文件名。
 * @param {object} deps
 * @param {ReturnType<import('./server-files.js').createServerFiles>} deps.serverFiles
 * @param {string} artistId
 * @param {Blob} blob
 * @param {string|null|undefined} [oldRef]
 */
export async function putArtistPreview(deps, artistId, blob, oldRef) {
    return putArtistImageFile(deps, artistId, blob, oldRef, 'reference');
}

/**
 * 上传卡片图，返回 cardImageRef 文件名。
 * @param {object} deps
 * @param {ReturnType<import('./server-files.js').createServerFiles>} deps.serverFiles
 * @param {string} artistId
 * @param {Blob} blob
 * @param {string|null|undefined} [oldRef]
 */
export async function putArtistCard(deps, artistId, blob, oldRef) {
    return putArtistImageFile(deps, artistId, blob, oldRef, 'card');
}

/**
 * 用 data URL 写原图服务器文件。
 * @param {object} deps
 * @param {ReturnType<import('./server-files.js').createServerFiles>} deps.serverFiles
 * @param {string} artistId
 * @param {string} dataUrl
 * @param {string|null|undefined} [oldRef]
 */
export async function putArtistImageFromDataUrl(deps, artistId, dataUrl, oldRef) {
    const parsed = parseImageDataUrl(dataUrl);
    if (!parsed.ok) {
        return Err(configError({
            code: 'ARTIST_IMAGE_DATA_URL',
            message: parsed.error,
            context: { artistId },
        }));
    }
    const serverFiles = deps?.serverFiles;
    if (!serverFiles) {
        return Err(configError({
            code: 'ARTIST_PREVIEW_NO_SERVER_FILES',
            message: '示例图存储不可用',
        }));
    }
    const name = artistPreviewFileName(artistId, parsed.value.ext);
    const wr = await serverFiles.writeBase64(name, parsed.value.base64);
    if (!wr.ok) {
        return wr;
    }
    const oldName = artistPreviewRefToName(oldRef);
    if (oldName && oldName !== name) {
        await serverFiles.remove(oldName);
    }
    return Ok(name);
}

/**
 * 原图 + 卡片图一并上传；换图时删旧文件。
 * @param {object} deps
 * @param {ReturnType<import('./server-files.js').createServerFiles>} deps.serverFiles
 * @param {string} artistId
 * @param {Blob} referenceBlob
 * @param {Blob} cardBlob
 * @param {{ referenceImageRef?: string|null, cardImageRef?: string|null }} [oldRefs]
 */
export async function putArtistPreviewPair(deps, artistId, referenceBlob, cardBlob, oldRefs) {
    const imageRepo = deps?.imageRepo;
    if (!imageRepo || typeof imageRepo.put !== 'function') {
        return Err(configError({
            code: 'ARTIST_PREVIEW_NO_LOCAL_STORE',
            message: '示例图存储不可用',
        }));
    }
    const refId = artistLocalImageId(artistId, 'ref');
    const cardId = artistLocalImageId(artistId, 'card');
    const refR = await imageRepo.put(referenceBlob, { id: refId });
    if (!refR.ok) return refR;
    const cardR = await imageRepo.put(cardBlob, { id: cardId });
    if (!cardR.ok) {
        if (typeof imageRepo.remove === 'function') {
            await imageRepo.remove(refR.value);
        }
        return cardR;
    }
    if (typeof imageRepo.remove === 'function') {
        if (oldRefs?.referenceImageRef && oldRefs.referenceImageRef !== refId) {
            await imageRepo.remove(oldRefs.referenceImageRef);
        }
        if (oldRefs?.cardImageRef && oldRefs.cardImageRef !== cardId) {
            await imageRepo.remove(oldRefs.cardImageRef);
        }
    }
    return Ok({
        referenceImageRef: refR.value,
        cardImageRef: cardR.value,
    });
}

/**
 * 删除画师串时清理原图与卡片图。
 * @param {object} deps
 * @param {ReturnType<import('./server-files.js').createServerFiles>} deps.serverFiles
 * @param {{ referenceImageRef?: string|null, cardImageRef?: string|null }|null|undefined} refs
 */
export async function removeArtistPreviewFiles(deps, refs) {
    const serverFiles = deps?.serverFiles;
    if (!serverFiles || !refs) {
        return Ok(undefined);
    }
    const names = [
        artistPreviewRefToName(refs.referenceImageRef),
        artistPreviewRefToName(refs.cardImageRef),
    ].filter(Boolean);
    /** @type {string[]} */
    const unique = [...new Set(/** @type {string[]} */ (names))];
    for (const name of unique) {
        const r = await serverFiles.remove(name);
        if (!r.ok) return r;
    }
    return Ok(undefined);
}

/**
 * 读服务器文件 → data URL。文件应有却读不到 → Err（禁止静默 null）。
 * @param {object} deps
 * @param {ReturnType<import('./server-files.js').createServerFiles>} deps.serverFiles
 * @param {string|null|undefined} ref
 * @param {string} [label]
 */
export async function readArtistImageDataUrl(deps, ref, label = '示例图') {
    if (ref == null || ref === '') {
        return Ok(null);
    }
    const name = artistPreviewRefToName(ref);
    if (!name) {
        return Err(configError({
            code: 'ARTIST_IMAGE_REF_INVALID',
            message: `${label}引用无效`,
            context: { ref: String(ref) },
        }));
    }
    const serverFiles = deps?.serverFiles;
    if (!serverFiles || typeof serverFiles.readBase64 !== 'function') {
        return Err(configError({
            code: 'ARTIST_PREVIEW_NO_SERVER_FILES',
            message: '示例图存储不可用',
        }));
    }
    const r = await serverFiles.readBase64(name);
    if (!r.ok) return r;
    if (r.value == null) {
        return Err(hostError({
            code: 'ARTIST_IMAGE_MISSING',
            message: `${label}文件不存在或无法读取`,
            hint: '请勿静默导出 null；检查服务器文件后重试',
            context: { name },
        }));
    }
    return Ok(toImageDataUrl(extFromFileName(name), r.value));
}

/**
 * 展示 URL：带稳定版本参数（随画师串 updatedAt），便于浏览器缓存；换图后地址变。
 * 与 JSON 读（readJson 自带 ?t= + no-store）策略分开。
 * 画师串图片 URL **只在此生成**；UI 经注入的 resolver 调用，勿再散落拼接。
 * @param {ReturnType<import('./server-files.js').createServerFiles>} serverFiles
 * @param {string|null|undefined} ref
 * @param {string|number|null|undefined} [version]
 * @returns {string|null}
 */
export function artistPreviewDisplayUrl(serverFiles, ref, version) {
    const name = artistPreviewRefToName(ref);
    if (!name || !serverFiles || typeof serverFiles.urlOf !== 'function') {
        return null;
    }
    return serverFiles.urlOf(name, version);
}

/**
 * 注入给 UI 的画师串文件 URL 解析器（卡片图 / 原图；一律带 ?v=）。
 * @param {ReturnType<import('./server-files.js').createServerFiles>} serverFiles
 * @returns {{
 *   urlOf: (ref: string|null|undefined, version?: string|number|null) => string|null,
 *   cardUrl: (item: object|null|undefined) => string|null,
 *   referenceUrl: (item: object|null|undefined) => string|null,
 * }}
 */
export function createArtistFileUrlResolver(imageRepo) {
    /**
     * @param {string|null|undefined} ref
     * @returns {Promise<string|null>}
     */
    async function urlOf(ref) {
        if (ref == null || ref === '' || !imageRepo || typeof imageRepo.getUrl !== 'function') {
            return null;
        }
        const r = await imageRepo.getUrl(ref);
        return r.ok ? (r.value || null) : null;
    }

    /**
     * 小缩略图 / 库卡：只用卡片图。
     * @param {object|null|undefined} item
     * @returns {string|null}
     */
    function cardUrl(item) {
        if (!item || typeof item !== 'object') {
            return null;
        }
        const rec = /** @type {{ cardImageRef?: unknown, updatedAt?: unknown }} */ (item);
        return urlOf(
            rec.cardImageRef == null ? null : String(rec.cardImageRef),
            /** @type {string|number|null|undefined} */ (rec.updatedAt),
        );
    }

    /**
     * 大图查看：原图。
     * @param {object|null|undefined} item
     * @returns {string|null}
     */
    function referenceUrl(item) {
        if (!item || typeof item !== 'object') {
            return null;
        }
        const rec = /** @type {{ referenceImageRef?: unknown, updatedAt?: unknown }} */ (item);
        return urlOf(
            rec.referenceImageRef == null ? null : String(rec.referenceImageRef),
            /** @type {string|number|null|undefined} */ (rec.updatedAt),
        );
    }

    return { urlOf, cardUrl, referenceUrl };
}
