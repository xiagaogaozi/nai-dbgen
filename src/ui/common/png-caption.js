/** 从 PNG 的 NovelAI 文本元数据读取提示词；不猜测画师串与场景的分界。 */
async function inflate(bytes) {
    if (typeof DecompressionStream === 'undefined') throw new Error('浏览器不支持解压图片提示词');
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

function decode(bytes) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { return new TextDecoder('latin1').decode(bytes); }
}

export async function readPngCaption(blob) {
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    if (bytes.length < 8 || ![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)) {
        throw new Error('此图片不是 PNG，无法读取 NovelAI 提示词');
    }
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
                const key = decode(data.subarray(0, sep));
                if (key === 'Comment' || key === 'Description') {
                    let value;
                    if (type === 'tEXt') value = data.subarray(sep + 1);
                    else if (type === 'zTXt') {
                        if (data[sep + 1] !== 0) throw new Error('图片提示词的压缩方式不受支持');
                        value = await inflate(data.subarray(sep + 2));
                    } else {
                        const flag = data[sep + 1];
                        const method = data[sep + 2];
                        const langEnd = data.indexOf(0, sep + 3);
                        const nameEnd = langEnd < 0 ? -1 : data.indexOf(0, langEnd + 1);
                        if (nameEnd < 0 || (flag !== 0 && flag !== 1) || (flag === 1 && method !== 0)) throw new Error('图片提示词格式不受支持');
                        value = data.subarray(nameEnd + 1);
                        if (flag === 1) value = await inflate(value);
                    }
                    fields[key] = decode(value);
                }
            }
        }
        offset += length + 12;
        if (type === 'IEND') { finished = true; break; }
    }
    if (!finished) throw new Error('图片数据不完整');
    let meta = {};
    try { meta = JSON.parse(fields.Comment || '{}'); } catch { /* 允许仅有 Description 的图片 */ }
    const pos = meta?.v4_prompt?.caption || {};
    const neg = meta?.v4_negative_prompt?.caption || {};
    const positive = typeof pos.base_caption === 'string' ? pos.base_caption : (meta.prompt || fields.Description || '');
    const negative = typeof neg.base_caption === 'string' ? neg.base_caption : (meta.uc || meta.negative_prompt || '');
    const posChars = Array.isArray(pos.char_captions) ? pos.char_captions : [];
    const negChars = Array.isArray(neg.char_captions) ? neg.char_captions : [];
    if (Math.max(posChars.length, negChars.length) > 4) throw new Error('图片角色超过工作台支持的 4 个，未导入');
    if (!positive && !negative && !posChars.length && !negChars.length) throw new Error('图片中没有可读取的提示词，未修改工作台');
    return {
        v4_prompt: { caption: { base_caption: String(positive), char_captions: posChars } },
        v4_negative_prompt: { caption: { base_caption: String(negative), char_captions: negChars } },
    };
}