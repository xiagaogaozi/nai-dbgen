/** 图片下载共用：只更改下载文件名，不改原始数据。 */
import { safeImageUrl } from './safe-url.js';
import { newId } from '../../infra/id.js';

export function imageExtension(mime, url = '') {
    const type = String(mime || '').toLowerCase().split(';')[0].trim();
    const map = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
    if (map[type]) return map[type];
    const dataType = /^data:(image\/(?:png|jpe?g|webp|gif))/i.exec(String(url));
    if (dataType) return map[dataType[1].toLowerCase()] || 'jpg';
    const suffix = /\.(png|jpe?g|webp|gif)(?:[?#]|$)/i.exec(String(url));
    return suffix ? suffix[1].toLowerCase().replace('jpeg', 'jpg') : null;
}

/** 在准备阶段检查二进制签名，处理 Blob 缺失 MIME 的图片。 */
export async function detectImageMime(blob) {
    if (!(blob instanceof Blob)) return '';
    if (imageExtension(blob.type)) return blob.type;
    const b = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    if (b.length >= 8 && [137,80,78,71,13,10,26,10].every((x, i) => b[i] === x)) return 'image/png';
    if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg';
    if (b.length >= 6 && String.fromCharCode(...b.slice(0,6)).match(/^GIF8[79]a$/)) return 'image/gif';
    if (b.length >= 12 && String.fromCharCode(...b.slice(0,4)) === 'RIFF' && String.fromCharCode(...b.slice(8,12)) === 'WEBP') return 'image/webp';
    return '';
}

/** 在用户手势回调内同步调用；浏览器是否允许多文件下载由用户授权决定。 */
export function requestImageDownload(url, mime = '') {
    const safe = safeImageUrl(url);
    const extension = imageExtension(mime, safe);
    if (!safe || !extension) throw new Error('图片类型或地址不可用，无法下载');
    const name = String(newId()).replace(/[^a-z0-9]/gi, '') || `${Date.now()}${Math.floor(Math.random()*1e9)}`;
    const anchor = document.createElement('a');
    anchor.href = safe;
    anchor.download = `${name}.${extension}`;
    anchor.style.display = 'none';
    (document.body || document.documentElement).appendChild(anchor);
    try { anchor.click(); } finally { anchor.remove(); }
    return anchor.download;
}