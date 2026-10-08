/**
 * L3 领域层 · 「近期生图记录」注入块格式化（需求 4.4 / 4.17 / 步骤 5）。
 *
 * 按 slotid 从小到大；每 slot 只写有值的行；slot 之间空一行；无记录 → 空串。
 */

/**
 * @typedef {import('../model/slot.js').SlotRecord} SlotRecord
 */

/**
 * @param {string|undefined|null} value
 * @returns {string|null} 非空文本，否则 null
 */
function nonEmptyText(value) {
    if (typeof value !== 'string') {
        return null;
    }
    const t = value.trim();
    return t.length > 0 ? t : null;
}

/**
 * @param {{ slotId?: number, analysis?: string, size?: string, caption?: unknown }|null|undefined} rec
 * @returns {string}
 */
function formatReferenceEntry(rec) {
    if (!rec) {
        return '';
    }
    /** @type {string[]} */
    const lines = [`slotid: ${Number(rec.slotId)}`];
    const analysis = nonEmptyText(rec.analysis);
    if (analysis != null) {
        lines.push(`解析: ${analysis}`);
    }
    const size = nonEmptyText(rec.size);
    if (size != null) {
        lines.push(`尺寸: ${size}`);
    }
    if (rec.caption != null) {
        lines.push(`生图内容: ${JSON.stringify(rec.caption)}`);
    }
    return lines.join('\n');
}

/**
 * 将保留范围内的 slot 记录格式化为「近期生图记录」变量值。
 * @param {SlotRecord[]} records 调用方已排除本轮 slot；本函数再按 slotId 排序
 * @returns {string}
 */
export function formatRecentSlotsBlock(records) {
    if (!Array.isArray(records) || records.length === 0) {
        return '';
    }
    const sorted = [...records].sort((a, b) => Number(a.slotId) - Number(b.slotId));
    return sorted.map((rec) => formatReferenceEntry(rec)).filter(Boolean).join('\n\n');
}

/**
 * 按调用先后格式化，不再按 slotId 打乱。一次调用里的多张图紧挨着。
 * @param {Array<{ items?: Array<{ slotId?: number, analysis?: string, size?: string, caption?: unknown }> }>|null|undefined} groups
 * @returns {string}
 */
export function formatPromptReferenceGroups(groups) {
    /** @type {string[]} */
    const parts = [];
    for (const group of groups || []) {
        for (const item of group?.items || []) {
            const text = formatReferenceEntry(item);
            if (text) parts.push(text);
        }
    }
    return parts.join('\n\n');
}
