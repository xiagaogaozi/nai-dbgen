/**
 * 从 PNG（文本块 / 像素隐写）或 JPEG（EXIF / XMP / COM）中读取 NovelAI 提示词。
 * 不在此处猜测画师串与场景的分界。
 */

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
const STEALTH_SIGS = [
    { sig: 'stealth_pnginfo', mode: 'alpha', compressed: false },
    { sig: 'stealth_pngcomp', mode: 'alpha', compressed: true },
    { sig: 'stealth_rgbinfo', mode: 'rgb', compressed: false },
    { sig: 'stealth_rgbcomp', mode: 'rgb', compressed: true },
];

async function decompressBytes(bytes, format) {
    if (typeof DecompressionStream === 'undefined') {
        throw new Error('浏览器不支持解压图片提示词');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

function decodeText(bytes) {
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        return new TextDecoder('latin1').decode(bytes);
    }
}

function decodeUtf16Le(bytes) {
    try {
        return new TextDecoder('utf-16le').decode(bytes).replace(/\0+$/, '');
    } catch {
        return '';
    }
}

function isPng(bytes) {
    return bytes.length >= 8 && PNG_SIG.every((v, i) => bytes[i] === v);
}

function isJpeg(bytes) {
    return bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

function tryParseJson(text) {
    if (typeof text !== 'string') return null;
    const trimmed = text.trim();
    if (!trimmed) return null;
    try {
        const parsed = JSON.parse(trimmed);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        const start = trimmed.indexOf('{');
        const end = trimmed.lastIndexOf('}');
        if (start >= 0 && end > start) {
            try {
                const parsed = JSON.parse(trimmed.slice(start, end + 1));
                return parsed && typeof parsed === 'object' ? parsed : null;
            } catch {
                return null;
            }
        }
        return null;
    }
}

function unescapeXml(text) {
    return String(text || '')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

async function readPngTextFields(bytes, view) {
    /** @type {Record<string, string>} */
    const fields = {};
    let offset = 8;
    let finished = false;
    while (offset + 12 <= bytes.length) {
        const length = view.getUint32(offset);
        if (length > bytes.length - offset - 12) throw new Error('图片数据不完整');
        const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
        const data = bytes.subarray(offset + 8, offset + 8 + length);
        if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
            const sep = data.indexOf(0);
            if (sep > 0) {
                const key = decodeText(data.subarray(0, sep));
                if (key === 'Comment' || key === 'Description' || key === 'parameters') {
                    let value;
                    if (type === 'tEXt') {
                        value = data.subarray(sep + 1);
                    } else if (type === 'zTXt') {
                        if (data[sep + 1] !== 0) throw new Error('图片提示词的压缩方式不受支持');
                        value = await decompressBytes(data.subarray(sep + 2), 'deflate');
                    } else {
                        const flag = data[sep + 1];
                        const method = data[sep + 2];
                        const langEnd = data.indexOf(0, sep + 3);
                        const nameEnd = langEnd < 0 ? -1 : data.indexOf(0, langEnd + 1);
                        if (nameEnd < 0 || (flag !== 0 && flag !== 1) || (flag === 1 && method !== 0)) {
                            throw new Error('图片提示词格式不受支持');
                        }
                        value = data.subarray(nameEnd + 1);
                        if (flag === 1) value = await decompressBytes(value, 'deflate');
                    }
                    fields[key] = decodeText(value);
                }
            }
        }
        offset += length + 12;
        if (type === 'IEND') {
            finished = true;
            break;
        }
    }
    if (!finished) throw new Error('图片数据不完整');
    return fields;
}

/**
 * 从 RGBA 像素数组中提取 NovelAI 隐写元数据（按列读取 Alpha 或 RGB 的 LSB）。
 * 导出以便纯单测直接验证，无需真实浏览器 canvas。
 * @param {Uint8ClampedArray|Uint8Array} data
 * @param {number} width
 * @param {number} height
 * @returns {Promise<Record<string, unknown>|null>}
 */
export async function extractStealthFromImageData(data, width, height) {
    if (!data || width <= 0 || height <= 0) return null;
    for (const mode of ['alpha', 'rgb']) {
        const totalBits = mode === 'alpha' ? width * height : width * height * 3;
        if (totalBits < 15 * 8 + 32) continue;

        let bitCursor = 0;
        const readBit = () => {
            if (bitCursor >= totalBits) return -1;
            const idx = bitCursor++;
            if (mode === 'alpha') {
                const x = Math.floor(idx / height);
                const y = idx % height;
                return data[(y * width + x) * 4 + 3] & 1;
            }
            const pixelIndex = Math.floor(idx / 3);
            const channel = idx % 3;
            const x = Math.floor(pixelIndex / height);
            const y = pixelIndex % height;
            return data[(y * width + x) * 4 + channel] & 1;
        };

        const readBytes = (count) => {
            const out = new Uint8Array(count);
            for (let i = 0; i < count; i += 1) {
                let b = 0;
                for (let j = 0; j < 8; j += 1) {
                    const bit = readBit();
                    if (bit < 0) return null;
                    b = (b << 1) | bit;
                }
                out[i] = b;
            }
            return out;
        };

        const sigBytes = readBytes(15);
        if (!sigBytes) continue;
        const sigText = decodeText(sigBytes);
        const spec = STEALTH_SIGS.find((item) => item.mode === mode && item.sig === sigText);
        if (!spec) continue;

        const lenBytes = readBytes(4);
        if (!lenBytes) continue;
        const bitLen = ((lenBytes[0] << 24) | (lenBytes[1] << 16) | (lenBytes[2] << 8) | lenBytes[3]) >>> 0;
        const byteLen = Math.floor(bitLen / 8);
        if (byteLen <= 0 || bitLen > totalBits - bitCursor) continue;

        const payload = readBytes(byteLen);
        if (!payload) continue;
        try {
            const raw = spec.compressed ? await decompressBytes(payload, 'gzip') : payload;
            const parsed = tryParseJson(decodeText(raw));
            if (parsed) return parsed;
        } catch {
            // 尝试下一种隐写通道
        }
    }
    return null;
}

async function decodeImageDataFromBlob(blob) {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
    if (typeof createImageBitmap === 'function') {
        try {
            const bitmap = await createImageBitmap(blob);
            try {
                const canvas = document.createElement('canvas');
                canvas.width = bitmap.width;
                canvas.height = bitmap.height;
                const ctx = canvas.getContext?.('2d');
                if (!ctx) return null;
                ctx.drawImage(bitmap, 0, 0);
                return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
            } finally {
                bitmap.close?.();
            }
        } catch {
            // 回退到 Image + ObjectURL
        }
    }
    if (typeof Image === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
        return null;
    }
    const url = URL.createObjectURL(blob);
    try {
        const img = await new Promise((resolve, reject) => {
            const node = new Image();
            node.onload = () => resolve(node);
            node.onerror = () => reject(new Error('decode'));
            node.src = url;
        });
        const canvas = document.createElement('canvas');
        const width = img.naturalWidth || img.width;
        const height = img.naturalHeight || img.height;
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext?.('2d');
        if (!ctx) return null;
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, width, height);
    } catch {
        return null;
    } finally {
        try { URL.revokeObjectURL(url); } catch { /* ignore */ }
    }
}

function parseExifTexts(exifBytes) {
    /** @type {string[]} */
    const texts = [];
    if (exifBytes.length < 14) return texts;
    const header = String.fromCharCode(...exifBytes.subarray(0, 6));
    if (header !== 'Exif\0\0') return texts;
    const tiff = exifBytes.subarray(6);
    if (tiff.length < 8) return texts;
    const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
    const endian = String.fromCharCode(tiff[0], tiff[1]);
    if (endian !== 'II' && endian !== 'MM') return texts;
    const le = endian === 'II';

    const readIfd = (ifdOffset) => {
        if (ifdOffset < 0 || ifdOffset + 2 > tiff.length) return;
        const count = view.getUint16(ifdOffset, le);
        for (let i = 0; i < count; i += 1) {
            const entry = ifdOffset + 2 + i * 12;
            if (entry + 12 > tiff.length) break;
            const tag = view.getUint16(entry, le);
            const type = view.getUint16(entry + 2, le);
            const num = view.getUint32(entry + 4, le);
            const valOffset = view.getUint32(entry + 8, le);

            if (tag === 0x8769) {
                readIfd(valOffset);
                continue;
            }
            if (tag !== 0x010e && tag !== 0x9286 && tag !== 0x9c9c) continue;
            const unitSize = type === 3 ? 2 : type === 4 ? 4 : 1;
            const byteLen = num * unitSize;
            const slice = byteLen <= 4
                ? tiff.subarray(entry + 8, entry + 8 + byteLen)
                : (valOffset + byteLen <= tiff.length ? tiff.subarray(valOffset, valOffset + byteLen) : null);
            if (!slice || !slice.length) continue;

            if (tag === 0x9c9c) {
                const s = decodeUtf16Le(slice).trim();
                if (s) texts.push(s);
            } else if (tag === 0x9286) {
                let body = slice;
                if (slice.length > 8) {
                    const prefix = String.fromCharCode(...slice.subarray(0, 8));
                    if (prefix.startsWith('ASCII') || prefix.startsWith('UNICODE') || prefix.startsWith('JIS')) {
                        body = slice.subarray(8);
                    }
                }
                const s = (body.length >= 2 && body[1] === 0 && body[0] !== 0
                    ? decodeUtf16Le(body)
                    : decodeText(body)).replace(/\0+$/, '').trim();
                if (s) texts.push(s);
            } else {
                const s = decodeText(slice).replace(/\0+$/, '').trim();
                if (s) texts.push(s);
            }
        }
    };

    const firstIfd = view.getUint32(4, le);
    readIfd(firstIfd);
    return texts;
}

function parseXmpTexts(xmpText) {
    /** @type {string[]} */
    const texts = [];
    const patterns = [
        /<exif:UserComment[\s\S]*?<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/gi,
        /<dc:description[\s\S]*?<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/gi,
        /<[^>]*Comment[^>]*>([\s\S]*?)<\/[^>]*Comment>/gi,
    ];
    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(xmpText)) !== null) {
            const value = unescapeXml(match[1]).trim();
            if (value) texts.push(value);
        }
    }
    return texts;
}

function readJpegCandidates(bytes) {
    /** @type {string[]} */
    const candidates = [];
    let offset = 2;
    while (offset + 4 <= bytes.length) {
        if (bytes[offset] !== 0xff) break;
        while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
        if (offset >= bytes.length) break;
        const marker = bytes[offset++];
        if (marker === 0xd9 || marker === 0xda) break; // EOI / SOS
        if (offset + 2 > bytes.length) break;
        const length = (bytes[offset] << 8) | bytes[offset + 1];
        if (length < 2 || offset + length > bytes.length) break;
        const segment = bytes.subarray(offset + 2, offset + length);
        offset += length;

        if (marker === 0xe1) {
            const head6 = String.fromCharCode(...segment.subarray(0, Math.min(6, segment.length)));
            if (head6 === 'Exif\0\0') {
                candidates.push(...parseExifTexts(segment));
            } else {
                const text = decodeText(segment);
                if (text.includes('http://ns.adobe.com/xap/1.0/')) {
                    candidates.push(...parseXmpTexts(text));
                }
            }
        } else if (marker === 0xfe) {
            const comment = decodeText(segment).replace(/\0+$/, '').trim();
            if (comment) candidates.push(comment);
        }
    }
    return candidates;
}

function normalizeCenters(centers, fallbackCenter) {
    if (Array.isArray(centers) && centers.length) return centers;
    if (fallbackCenter && typeof fallbackCenter === 'object') return [fallbackCenter];
    return [{ x: 0.5, y: 0.5 }];
}

function buildCaptionFromMeta(meta, descriptionFallback = '') {
    let source = meta && typeof meta === 'object' ? meta : {};
    if (typeof source.Comment === 'string') {
        const inner = tryParseJson(source.Comment);
        if (inner) {
            if (!descriptionFallback && typeof source.Description === 'string') {
                descriptionFallback = source.Description;
            }
            source = inner;
        }
    }

    const pos = source?.v4_prompt?.caption || {};
    const neg = source?.v4_negative_prompt?.caption || {};
    const positive = typeof pos.base_caption === 'string'
        ? pos.base_caption
        : (typeof source.prompt === 'string' ? source.prompt : descriptionFallback);
    const negative = typeof neg.base_caption === 'string'
        ? neg.base_caption
        : (typeof source.uc === 'string'
            ? source.uc
            : (typeof source.negative_prompt === 'string' ? source.negative_prompt : ''));

    let posChars = Array.isArray(pos.char_captions) ? pos.char_captions : [];
    let negChars = Array.isArray(neg.char_captions) ? neg.char_captions : [];

    if (!posChars.length && !negChars.length && Array.isArray(source.characterPrompts)) {
        posChars = source.characterPrompts.map((item) => ({
            char_caption: typeof item?.prompt === 'string' ? item.prompt : '',
            centers: normalizeCenters(item?.centers, item?.center),
        }));
        negChars = source.characterPrompts.map((item) => ({
            char_caption: typeof item?.uc === 'string' ? item.uc : '',
            centers: normalizeCenters(item?.centers, item?.center),
        }));
    }

    if (Math.max(posChars.length, negChars.length) > 4) {
        throw new Error('图片角色超过工作台支持的 4 个，未导入');
    }
    if (!positive && !negative && !posChars.length && !negChars.length) {
        return null;
    }
    return {
        v4_prompt: { caption: { base_caption: String(positive || ''), char_captions: posChars } },
        v4_negative_prompt: { caption: { base_caption: String(negative || ''), char_captions: negChars } },
    };
}

export async function readImageCaption(blob) {
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);

    if (isPng(bytes)) {
        const fields = await readPngTextFields(bytes, view);
        const parsedComment = tryParseJson(fields.Comment || '');
        const fromText = buildCaptionFromMeta(parsedComment || {}, fields.Description || '');
        if (fromText) return fromText;

        const imgData = await decodeImageDataFromBlob(blob);
        if (imgData) {
            const stealthMeta = await extractStealthFromImageData(imgData.data, imgData.width, imgData.height);
            const fromStealth = buildCaptionFromMeta(stealthMeta || {}, '');
            if (fromStealth) return fromStealth;
        }
        throw new Error('图片中没有可读取的提示词，未修改工作台');
    }

    if (isJpeg(bytes)) {
        const candidates = readJpegCandidates(bytes);
        let fallbackDesc = '';
        for (const text of candidates) {
            const parsed = tryParseJson(text);
            if (parsed) {
                const caption = buildCaptionFromMeta(parsed, fallbackDesc);
                if (caption) return caption;
            } else if (!fallbackDesc && text.trim()) {
                fallbackDesc = text.trim();
            }
        }
        if (fallbackDesc) {
            const caption = buildCaptionFromMeta({}, fallbackDesc);
            if (caption) return caption;
        }
        throw new Error('图片中没有可读取的提示词，未修改工作台');
    }

    throw new Error('仅支持读取 PNG 或 JPEG 图片的 NovelAI 提示词');
}

export const readPngCaption = readImageCaption;
