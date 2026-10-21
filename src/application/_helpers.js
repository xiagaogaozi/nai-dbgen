/**
 * L4 应用层私有辅助（不对外契约）。
 */

import { Err } from '../infra/result.js';
import { upstreamFromHttpStatus } from '../infra/errors.js';

/**
 * @param {AbortSignal} [signal]
 * @param {string} [traceId]
 * @returns {import('../infra/result.js').Err<import('../infra/errors.js').AppError>|null}
 */
export function abortErrIfNeeded(signal, traceId) {
    if (signal == null || !signal.aborted) {
        return null;
    }
    const cause = signal.reason instanceof Error
        ? signal.reason
        : Object.assign(new Error('aborted'), { name: 'AbortError' });
    return Err(upstreamFromHttpStatus(0, {
        code: 'UPSTREAM_ABORTED',
        message: '请求已取消',
        cause,
        traceId: traceId ?? null,
    }));
}

/**
 * 给 AppError 补上 traceId（若尚无）。
 * @template T
 * @param {{ ok: true, value: T } | { ok: false, error: import('../infra/errors.js').AppError }} r
 * @param {string} traceId
 * @returns {{ ok: true, value: T } | { ok: false, error: import('../infra/errors.js').AppError }}
 */
export function attachTraceId(r, traceId) {
    if (r.ok) {
        return r;
    }
    if (r.error && r.error.traceId == null) {
        r.error.traceId = traceId;
    }
    return r;
}

/**
 * 从 LLM 回文中抽出 key 列表（数组，或 { keys: [...] }）。
 * 单图召回等路径沿用；楼中构图召回请用 extractRecalledPositions。
 * @param {unknown} json
 * @param {string} [text]
 * @returns {string[]}
 */
export function extractRecalledKeyList(json, text) {
    if (Array.isArray(json)) {
        return json.map((x) => (x == null ? '' : String(x)));
    }
    if (json && typeof json === 'object') {
        const keys = /** @type {Record<string, unknown>} */ (json).keys
            ?? /** @type {Record<string, unknown>} */ (json).key
            ?? /** @type {Record<string, unknown>} */ (json).tags;
        if (Array.isArray(keys)) {
            return keys.map((x) => (x == null ? '' : String(x)));
        }
    }
    if (typeof text === 'string' && text.trim()) {
        // 兜底：按行拆非空行
        return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    }
    return [];
}

/**
 * @typedef {object} RecalledPositionRaw
 * @property {string} anchorSentence 生成点
 * @property {string[]} keys
 */

/**
 * @typedef {object} ExtractRecalledPositionsResult
 * @property {'ok'|'legacy-key-list'|'empty'|'invalid'} status
 * @property {RecalledPositionRaw[]} positions
 */

/**
 * 从楼中召回 LLM 回文抽出位置数组（需求 4.11）。
 * 宽容：外层包一层对象、positions/items/data、代码块已由网关剥掉后的 json。
 * 旧纯 key 列表 → status='legacy-key-list'（调用方应报错提示更新预设）。
 * @param {unknown} json
 * @param {string} [text]
 * @returns {ExtractRecalledPositionsResult}
 */
export function extractRecalledPositions(json, text) {
    /** @type {unknown} */
    let payload = json;
    if ((payload == null || payload === '') && typeof text === 'string' && text.trim()) {
        try {
            payload = JSON.parse(text.trim());
        } catch {
            const fence = text.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
            if (fence) {
                try {
                    payload = JSON.parse(fence[1].trim());
                } catch {
                    payload = null;
                }
            }
        }
    }

    if (payload == null) {
        return { status: 'empty', positions: [] };
    }
    if (Array.isArray(payload) && payload.length === 0) {
        return { status: 'empty', positions: [] };
    }

    // 旧格式：纯字符串数组
    if (Array.isArray(payload) && payload.every((x) => typeof x === 'string' || typeof x === 'number')) {
        return { status: 'legacy-key-list', positions: [] };
    }

    /** @type {unknown[]} */
    let items = [];
    if (Array.isArray(payload)) {
        items = payload;
    } else if (payload && typeof payload === 'object') {
        const o = /** @type {Record<string, unknown>} */ (payload);
        // 旧格式：{ keys|key|tags: string[] }
        const legacyKeys = o.keys ?? o.key ?? o.tags;
        if (Array.isArray(legacyKeys)
            && legacyKeys.every((x) => typeof x === 'string' || typeof x === 'number')
            && !Array.isArray(o.positions)
            && !Array.isArray(o.items)
            && !Array.isArray(o.data)
            && o.anchor == null
            && o['生成点'] == null) {
            return { status: 'legacy-key-list', positions: [] };
        }
        if (Array.isArray(o.positions)) {
            items = o.positions;
        } else if (Array.isArray(o.items)) {
            items = o.items;
        } else if (Array.isArray(o.data)) {
            items = o.data;
        } else if (typeof o.anchor === 'string' || typeof o['生成点'] === 'string' || Array.isArray(o.key) || Array.isArray(o.keys)) {
            items = [o];
        } else {
            return { status: 'invalid', positions: [] };
        }
    } else {
        return { status: 'invalid', positions: [] };
    }

    if (items.length === 0) {
        return { status: 'empty', positions: [] };
    }

    // 数组元素全是字符串 → 旧格式
    if (items.every((x) => typeof x === 'string' || typeof x === 'number')) {
        return { status: 'legacy-key-list', positions: [] };
    }

    /** @type {RecalledPositionRaw[]} */
    const positions = [];
    const issues = [];
    for (const [index, item] of items.entries()) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            issues.push(`positions[${index}] 必须是包含 anchor 和 key 的对象`);
            continue;
        }
        const row = /** @type {Record<string, unknown>} */ (item);
        const anchor = row.anchor ?? row.anchorSentence ?? row['生成点'] ?? '';
        const rawKeys = row.key ?? row.keys ?? row.tags;
        if (typeof anchor !== 'string' || !anchor.trim()) issues.push(`positions[${index}].anchor（生成点）缺失或为空，须填写目标楼原文`);
        if (!Array.isArray(rawKeys)) issues.push(`positions[${index}].key 缺失或不是数组；没有候选时也必须输出 []`);
        /** @type {string[]} */
        const keys = Array.isArray(rawKeys)
            ? rawKeys.map((x) => (x == null ? '' : String(x)))
            : [];
        positions.push({
            anchorSentence: String(anchor ?? ''),
            keys,
        });
    }

    if (positions.length === 0) {
        return { status: 'invalid', positions: [], ...(issues.length ? { issues } : {}) };
    }
    return { status: issues.length ? 'invalid' : 'ok', positions, ...(issues.length ? { issues } : {}) };
}

/**
 * 解析步骤 5 的 SlotPlan 数组（兼容外层包一层对象）。
 * @param {unknown} json
 * @returns {unknown[]}
 */
export function extractSlotPlanItems(json) {
    if (Array.isArray(json)) {
        return json;
    }
    if (json && typeof json === 'object') {
        const o = /** @type {Record<string, unknown>} */ (json);
        if (Array.isArray(o.slots)) {
            return o.slots;
        }
        if (Array.isArray(o.items)) {
            return o.items;
        }
        if (Array.isArray(o.data)) {
            return o.data;
        }
        if (o.slotid != null || o.slotId != null || o.caption != null || o['生图内容'] != null) {
            return [json];
        }
    }
    return [];
}

/**
 * 列出角色库全部角色（跨组）。
 * @param {import('../ports/repository.port.js').CharacterRepository} characterRepo
 * @returns {Promise<{ ok: true, value: { groups: import('../domain/model/character.js').CharacterGroup[], characters: import('../domain/model/character.js').Character[] } } | { ok: false, error: import('../infra/errors.js').AppError }>}
 */
export async function loadAllCharacters(characterRepo) {
    const groupsR = await characterRepo.listGroups();
    if (!groupsR.ok) {
        return groupsR;
    }
    /** @type {import('../domain/model/character.js').Character[]} */
    const characters = [];
    for (const g of groupsR.value) {
        const cr = await characterRepo.listByGroup(g.id);
        if (!cr.ok) {
            return cr;
        }
        characters.push(...cr.value);
    }
    return { ok: true, value: { groups: groupsR.value, characters } };
}

/** 召回预设里「候选 key」变量名（BlockSet 额外键，见 preset-renderer 注释） */
export const RECALL_CANDIDATE_KEYS_VAR = '候选 key';

/** 步骤 5 结构化输出 schema。生图内容必须是 caption 树，空对象不算。 */
const CAPTION_TREE_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
        v4_prompt: {
            type: 'object',
            properties: {
                caption: {
                    type: 'object',
                    properties: {
                        base_caption: { type: 'string', minLength: 1 },
                        char_captions: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    char_caption: { type: 'string' },
                                },
                                required: ['char_caption'],
                            },
                        },
                    },
                    required: ['base_caption', 'char_captions'],
                },
            },
            required: ['caption'],
        },
        v4_negative_prompt: {
            type: 'object',
            properties: {
                caption: {
                    type: 'object',
                    properties: {
                        base_caption: { type: 'string' },
                        char_captions: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    char_caption: { type: 'string' },
                                },
                                required: ['char_caption'],
                            },
                        },
                    },
                    required: ['base_caption', 'char_captions'],
                },
            },
            required: ['caption'],
        },
    },
    required: ['v4_prompt', 'v4_negative_prompt'],
});

export const SLOT_PLAN_JSON_SCHEMA = Object.freeze({
    name: 'slot_plan_array',
    strict: false,
    schema: {
        type: 'object',
        properties: {
            slots: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        slotid: { type: 'integer' },
                        analysis: { type: 'string' },
                        size: { type: 'string' },
                        caption: CAPTION_TREE_SCHEMA,
                    },
                    required: ['slotid', 'caption'],
                },
            },
        },
        required: ['slots'],
    },
});

/** 召回 key 列表 schema（单图召回等；楼中构图召回用 RECALL_POSITIONS_JSON_SCHEMA） */
export const RECALL_KEYS_JSON_SCHEMA = Object.freeze({
    name: 'recall_keys',
    schema: {
        type: 'array',
        items: { type: 'string' },
    },
});

/** 楼中构图召回：位置数组 schema（需求 4.11） */
export const RECALL_POSITIONS_JSON_SCHEMA = Object.freeze({
    name: 'recall_positions',
    schema: {
        type: 'object',
        properties: {
            positions: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        anchor: { type: 'string' },
                        key: {
                            type: 'array',
                            items: { type: 'string' },
                        },
                    },
                    required: ['anchor', 'key'],
                },
            },
        },
        required: ['positions'],
    },
});

/** 工作台写提示词：直接产出 NaiCaption */
export const WORKBENCH_CAPTION_JSON_SCHEMA = Object.freeze({
    name: 'nai_caption',
    schema: {
        type: 'object',
        properties: {
            v4_prompt: { type: 'object' },
            v4_negative_prompt: { type: 'object' },
        },
        required: ['v4_prompt', 'v4_negative_prompt'],
    },
});

/** 应用层 → UI 事件名与载荷约定（W3 / UI 装配必读） */
export const APP_EVENTS = Object.freeze({
    /**
     * generateSlots 写完 slot 后发出。
     * payload: { messageId, records, traceId, llmCallCount, unmatchedKeys, placements? }
     */
    SLOTS_WRITTEN: 'slots:written',
    SLOTS_EDITED: 'slots:edited',
    /**
     * renderSlot 出图成功后发出（在 inflight 清表之后，保证订阅方读 isRendering===false）。
     * payload: { messageId, slotId, imageRef, traceId, record, chatId? }
     */
    SLOT_RENDERED: 'slot:rendered',
    /**
     * renderSlot 出图失败/拒出后发出（同样在 inflight 清表之后）。
     * 含 Abort / SLOT_ALREADY_RENDERED；UI 自行按 classifyGenerateSettlement 分流。
     * payload: { messageId, slotId, error, traceId?, chatId? }
     */
    SLOT_RENDER_FAILED: 'slot:render-failed',
    /**
     * 召回有未命中 key / 丢弃生成点时发出（可与 toast 订阅）。
     * payload: { messageId?, traceId, unmatchedKeys, discardedAnchors?, matchedCount?, positionCount? }
     */
    TAG_RECALL_UNMATCHED: 'tag-recall:unmatched',
    /**
     * 图片缓存按上限裁剪后发出（启动裁剪 / 存储管理手动清理）。
     * payload: { removed, removedRefs: string[], limit }
     */
    IMAGE_CACHE_TRIMMED: 'image-cache:trimmed',
});

/**
 * 从单图 / 工作台 LLM JSON 取出 caption 对象。
 * @param {unknown} json
 * @returns {unknown|null}
 */
export function extractSingleCaption(json) {
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
        return null;
    }
    const o = /** @type {Record<string, unknown>} */ (json);
    if (o.caption != null && typeof o.caption === 'object') {
        const inner = /** @type {Record<string, unknown>} */ (o.caption);
        if (inner.v4_prompt != null || inner.v4_negative_prompt != null) {
            return o.caption;
        }
    }
    if (o['生图内容'] != null) {
        return o['生图内容'];
    }
    if (o.v4_prompt != null && o.v4_negative_prompt != null) {
        return o;
    }
    return null;
}

/**
 * 从 LLM 对象取可选「尺寸」「解析」；空串视为未写。
 * @param {unknown} json
 * @returns {{ size?: string, analysis?: string }}
 */
export function extractOptionalSizeAnalysis(json) {
    /** @type {{ size?: string, analysis?: string }} */
    const out = {};
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
        return out;
    }
    const o = /** @type {Record<string, unknown>} */ (json);
    const sizeRaw = typeof o.size === 'string' ? o.size : o['尺寸'];
    const size = typeof sizeRaw === 'string' ? sizeRaw.trim() : '';
    if (size) {
        out.size = size;
    }
    const analysisRaw = typeof o.analysis === 'string' ? o.analysis : o['解析'];
    const analysis = typeof analysisRaw === 'string' ? analysisRaw.trim() : '';
    if (analysis) {
        out.analysis = analysis;
    }
    return out;
}
