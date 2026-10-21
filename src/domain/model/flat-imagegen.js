/**
 * 生图模型回文：一行一个字段。程序再套成 NAI caption 树。
 * 字段名：slotid / size / analysis / scene / scene_uc / char / char_uc。
 * char 可写成 `0.4,0.6 | 提示词`；没有坐标时用画面中心。
 */

const FIELD_RE = /^(?:[-*]\s+)?(?:\*\*)?(slotid|size|analysis|scene|scene_uc|char|char_uc)(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*(.*)$/i;
const EXTRA_FIELD_RE = /^(?:[-*]\s+)?(?:\*\*)?[\p{L}_][\p{L}\p{N}_ -]*?(?:\*\*)?\s*[:：]/u;
const ANALYSIS_HEADING_RE = /^(?:foreground|middle\s*ground|background)\s*[:：]/i;

/**
 * @param {string} raw
 * @returns {{ x: number, y: number, text: string }}
 */
function splitCharLine(raw) {
    const text = String(raw ?? '').trim();
    const m = text.match(/^([0-9]*\.?[0-9]+)\s*,\s*([0-9]*\.?[0-9]+)\s*\|\s*([\s\S]*)$/);
    if (!m) {
        return { x: 0.5, y: 0.5, text };
    }
    const x = Number(m[1]);
    const y = Number(m[2]);
    const ok = Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 1 && y >= 0 && y <= 1;
    return {
        x: ok ? x : 0.5,
        y: ok ? y : 0.5,
        text: m[3].trim(),
    };
}

/**
 * @param {string} text
 * @returns {Array<Record<string, string|string[]>>}
 */
function splitBlocks(text) {
    /** @type {Array<Record<string, string|string[]>>} */
    const blocks = [];
    /** @type {Record<string, string|string[]>|null} */
    let cur = null;
    /** @type {string|null} */
    let field = null;

    const push = () => {
        if (cur) {
            blocks.push(cur);
        }
    };

    for (const line of String(text ?? '').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (/^```/.test(trimmed)) continue;
        if (trimmed === '---') {
            push();
            cur = null;
            field = null;
            continue;
        }
        const m = trimmed.match(FIELD_RE);
        if (m) {
            const key = m[1].toLowerCase();
            if (key === 'slotid' && cur && Object.hasOwn(cur, 'slotid')) {
                push();
                cur = null;
                field = null;
            }
            if (!cur) {
                cur = {};
            }
            field = key;
            if (field === 'char') {
                cur.chars ??= [];
                /** @type {string[]} */ (cur.chars).push(m[2]);
            } else if (field === 'char_uc') {
                cur.char_ucs ??= [];
                /** @type {string[]} */ (cur.char_ucs).push(m[2]);
            } else {
                cur[field] = m[2];
            }
            continue;
        }
        // 额外字段是边界，不能串进必填字段；分析中的分层标题仍属于分析正文。
        if (EXTRA_FIELD_RE.test(trimmed) && !(field === 'analysis' && ANALYSIS_HEADING_RE.test(trimmed))) {
            field = null;
            continue;
        }
        // 编号、尺寸是单行字段，后续说明不能被当作它们的续行。
        if (cur && field && trimmed && field !== 'slotid' && field !== 'size') {
            if (field === 'char') {
                const list = /** @type {string[]} */ (cur.chars);
                list[list.length - 1] = `${list[list.length - 1]}\n${line.trim()}`;
            } else if (field === 'char_uc') {
                const list = /** @type {string[]} */ (cur.char_ucs);
                list[list.length - 1] = `${list[list.length - 1]}\n${line.trim()}`;
            } else {
                cur[field] = `${cur[field] || ''}\n${line.trim()}`;
            }
        }
    }
    push();
    return blocks;
}

/** 保留字段存在性，避免把缺失 UC / 角色字段补成空值后误认为完整输出。 */
export function inspectFlatImagegenFields(text, { requireSlotId = true } = {}) {
    const blocks = splitBlocks(text);
    const issues = [];
    for (const [index, block] of blocks.entries()) {
        const label = `第 ${index + 1} 段${block.slotid ? `（slotid: ${block.slotid}）` : ''}`;
        const required = [
            ...(requireSlotId ? [['slotid', 'slotid']] : []),
            ['analysis', 'analysis'], ['scene', 'scene'], ['scene_uc', 'scene_uc'],
            ...((Object.hasOwn(block, 'chars') || Object.hasOwn(block, 'char_ucs'))
                ? [['chars', 'char'], ['char_ucs', 'char_uc']] : []),
        ];
        for (const [key, name] of required) {
            if (!Object.hasOwn(block, key)) issues.push(`${label}缺少必填字段 ${name}`);
        }
        for (const key of ['analysis', 'scene']) {
            if (Object.hasOwn(block, key) && !String(block[key]).trim()) issues.push(`${label}的 ${key} 不能为空`);
        }
        const chars = block.chars || [];
        const ucs = block.char_ucs || [];
        if (chars.length !== ucs.length) issues.push(`${label}的 char 与 char_uc 数量不一致（${chars.length}/${ucs.length}），每个角色必须对应一条 char_uc`);
    }
    return { recognized: blocks.length > 0, issues };
}

/**
 * @param {Record<string, string|string[]>} block
 * @returns {import('./nai-params.js').NaiCaption}
 */
function blockToCaption(block) {
    const chars = /** @type {string[]} */ (block.chars || []);
    const ucs = /** @type {string[]} */ (block.char_ucs || []);
    const posChars = chars.map((line) => {
        const parsed = splitCharLine(line);
        return {
            char_caption: parsed.text,
            centers: [{ x: parsed.x, y: parsed.y }],
        };
    });
    const negCount = Math.max(chars.length, ucs.length);
    const negChars = [];
    for (let i = 0; i < negCount; i += 1) {
        negChars.push({ char_caption: String(ucs[i] ?? '').trim() });
    }
    return {
        v4_prompt: {
            caption: {
                base_caption: String(block.scene ?? '').trim(),
                char_captions: posChars,
            },
        },
        v4_negative_prompt: {
            caption: {
                base_caption: String(block.scene_uc ?? '').trim(),
                char_captions: negChars,
            },
        },
    };
}

/**
 * 多图回文。没有 slotid 行时返回空数组。
 * @param {unknown} text
 * @returns {object[]}
 */
export function parseFlatSlotPlans(text) {
    return splitBlocks(text)
        .filter((b) => String(b.slotid ?? '').trim())
        .map((b) => {
            /** @type {Record<string, unknown>} */
            const item = {
                slotid: String(b.slotid).trim(),
                caption: blockToCaption(b),
            };
            const size = String(b.size ?? '').trim();
            const analysis = String(b.analysis ?? '').trim();
            if (size) {
                item.size = size;
            }
            if (analysis) {
                item.analysis = analysis;
            }
            return item;
        });
}

/**
 * 单图回文：没有 slotid 也收。
 * @param {unknown} text
 * @returns {{ caption: import('./nai-params.js').NaiCaption, size?: string, analysis?: string }|null}
 */
export function parseFlatSingleCaption(text) {
    const blocks = splitBlocks(text);
    const block = blocks.find((b) => b.scene || (Array.isArray(b.chars) && b.chars.length > 0));
    if (!block) {
        return null;
    }
    /** @type {{ caption: import('./nai-params.js').NaiCaption, size?: string, analysis?: string }} */
    const out = { caption: blockToCaption(block) };
    const size = String(block.size ?? '').trim();
    const analysis = String(block.analysis ?? '').trim();
    if (size) {
        out.size = size;
    }
    if (analysis) {
        out.analysis = analysis;
    }
    return out;
}
