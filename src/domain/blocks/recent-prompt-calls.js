/**
 * 本聊天最近几次写词调用留下的生图内容。一次调用可以有多张图。
 * 外部写词不落 slot，靠这份记录让下一次还能看见。
 */

export const RECENT_PROMPT_CALL_LIMIT = 3;

/**
 * @param {unknown} raw
 * @returns {Array<{ at: string, items: Array<{ slotId: number, caption: object, size?: string, analysis?: string }> }>}
 */
export function normalizePromptCalls(raw) {
    if (!Array.isArray(raw)) {
        return [];
    }
    /** @type {Array<{ at: string, items: Array<{ slotId: number, caption: object, size?: string, analysis?: string }> }>} */
    const calls = [];
    for (const call of raw) {
        if (!call || typeof call !== 'object') {
            continue;
        }
        const row = /** @type {{ at?: unknown, items?: unknown }} */ (call);
        /** @type {Array<{ slotId: number, caption: object, size?: string, analysis?: string }>} */
        const items = [];
        const list = Array.isArray(row.items) ? row.items : [];
        for (const item of list) {
            if (!item || typeof item !== 'object') {
                continue;
            }
            const entry = /** @type {{ slotId?: unknown, caption?: unknown, size?: unknown, analysis?: unknown }} */ (item);
            const slotId = Number(entry.slotId);
            if (!Number.isInteger(slotId) || slotId < 1) {
                continue;
            }
            if (!entry.caption || typeof entry.caption !== 'object' || Array.isArray(entry.caption)) {
                continue;
            }
            /** @type {{ slotId: number, caption: object, size?: string, analysis?: string }} */
            const next = { slotId, caption: entry.caption };
            if (typeof entry.size === 'string' && entry.size.trim()) {
                next.size = entry.size.trim();
            }
            if (typeof entry.analysis === 'string' && entry.analysis.trim()) {
                next.analysis = entry.analysis.trim();
            }
            items.push(next);
        }
        if (!items.length) {
            continue;
        }
        calls.push({ at: row.at == null ? '' : String(row.at), items });
    }
    return calls.slice(-RECENT_PROMPT_CALL_LIMIT);
}

/**
 * @param {unknown} existing
 * @param {unknown} call
 * @returns {ReturnType<typeof normalizePromptCalls>}
 */
export function appendPromptCall(existing, call) {
    const prior = Array.isArray(existing) ? existing : [];
    return normalizePromptCalls([...prior, call]);
}

/**
 * 楼内 slot 按同一次 trace 合成一次调用；没有 trace 的旧记录各自算一次。
 * 再并上外部写词留下的调用，只留时间上最近的几次。
 * @param {Array<{ slotId?: number, messageId?: number, createdAt?: string, traceId?: string|null, caption?: unknown, size?: string, analysis?: string }>|null|undefined} slotRecords
 * @param {ReturnType<typeof normalizePromptCalls>|null|undefined} promptCalls
 * @param {{ limit?: number }} [opts]
 * @returns {ReturnType<typeof normalizePromptCalls>}
 */
export function selectRecentPromptGroups(slotRecords, promptCalls, opts) {
    const limit = Number.isInteger(opts?.limit) && opts.limit > 0
        ? opts.limit
        : RECENT_PROMPT_CALL_LIMIT;
    /** @type {Map<string, { at: string, items: Array<{ slotId: number, caption: object, size?: string, analysis?: string }> }>} */
    const byKey = new Map();
    for (const rec of slotRecords || []) {
        if (!rec || rec.caption == null || typeof rec.caption !== 'object') {
            continue;
        }
        const slotId = Number(rec.slotId);
        if (!Number.isInteger(slotId) || slotId < 1) {
            continue;
        }
        const trace = rec.traceId == null ? '' : String(rec.traceId);
        const key = trace
            ? `trace:${trace}`
            : `slot:${rec.messageId}:${slotId}:${rec.createdAt || ''}`;
        let group = byKey.get(key);
        if (!group) {
            group = { at: rec.createdAt == null ? '' : String(rec.createdAt), items: [] };
            byKey.set(key, group);
        }
        const at = rec.createdAt == null ? '' : String(rec.createdAt);
        if (at > group.at) {
            group.at = at;
        }
        /** @type {{ slotId: number, caption: object, size?: string, analysis?: string }} */
        const item = { slotId, caption: rec.caption };
        if (typeof rec.size === 'string' && rec.size.trim()) {
            item.size = rec.size.trim();
        }
        if (typeof rec.analysis === 'string' && rec.analysis.trim()) {
            item.analysis = rec.analysis.trim();
        }
        group.items.push(item);
    }
    for (const group of byKey.values()) {
        group.items.sort((a, b) => a.slotId - b.slotId);
    }
    const groups = [...byKey.values(), ...normalizePromptCalls(promptCalls)];
    groups.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    return groups.slice(-limit);
}
