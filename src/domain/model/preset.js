/**
 * L3 领域模型 · 生图/召回预设（架构文档 §5.2，对齐 ST prompts[]+prompt_order[]）。
 * 归属：W0 契约冻结。中文变量名由插件自备替换器处理（基线 §7）。
 */

import {
    isArrayOf,
    isNonEmptyString,
    isPlainObject,
    requireArg,
    schemaVersionMismatch,
    validationErr,
    validationOk,
} from '../../infra/validate.js';

export const PRESET_SCHEMA_VERSION = 1;
export const DEFAULT_PRESET_RETRY_COUNT = 3;

/** 首轮失败后允许追加的结果纠错次数。旧预设缺省为 3。 */
export function presetRetryCount(preset) {
    return preset?.retryCount ?? DEFAULT_PRESET_RETRY_COUNT;
}

/**
 * @typedef {object} PresetPrompt
 * @property {string} identifier
 * @property {string} name
 * @property {'system'|'user'|'assistant'} role
 * @property {string} content
 * @property {boolean} enabled
 * @property {boolean} workbenchOnly 勾选后只在工作台生图出现，楼内双击生图不带上
 * @property {0|1} injection_position RELATIVE=0 / ABSOLUTE=1
 * @property {number} injection_depth
 * @property {number} injection_order
 */

/**
 * @typedef {object} PresetOrderItem
 * @property {string} identifier
 * @property {boolean} enabled
 */

/**
 * 预设类型（需求 4.4 / 4.11 / 4.16）。
 * @typedef {'imagegen'|'recall'|'single-recall'|'single-imagegen'} PresetKind
 */

/**
 * @typedef {object} Preset
 * @property {number} schemaVersion
 * @property {string} id
 * @property {string} name
 * @property {PresetKind} kind
 * @property {number} retryCount 结果格式/必填字段校验失败后的重试次数，0 禁用
 * @property {PresetPrompt[]} prompts
 * @property {PresetOrderItem[]} prompt_order 单角色场景扁平化（基线 §10 的 order 数组）
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/** @type {ReadonlySet<PresetKind>} */
const PRESET_KINDS = Object.freeze(new Set([
    'imagegen',
    'recall',
    'single-recall',
    'single-imagegen',
]));

/**
 * @param {unknown} raw
 * @returns {PresetKind}
 */
export function normalizePresetKind(raw) {
    if (typeof raw === 'string' && PRESET_KINDS.has(/** @type {PresetKind} */ (raw))) {
        return /** @type {PresetKind} */ (raw);
    }
    return 'imagegen';
}

/**
 * @typedef {{ id: string, now: string }} IdNowDeps
 */

/**
 * @param {object} input
 * @param {IdNowDeps} deps
 * @returns {Preset}
 */
export function createPreset(input, deps) {
    requireArg(isPlainObject(input), 'input');
    requireArg(deps && isNonEmptyString(deps.id) && isNonEmptyString(deps.now), 'deps');
    return {
        schemaVersion: PRESET_SCHEMA_VERSION,
        id: deps.id,
        name: String(input.name ?? ''),
        kind: normalizePresetKind(input.kind),
        retryCount: input.retryCount ?? DEFAULT_PRESET_RETRY_COUNT,
        prompts: normalizePrompts(input.prompts),
        prompt_order: normalizePromptOrder(input.prompt_order, input.prompts),
        createdAt: deps.now,
        updatedAt: deps.now,
    };
}

/**
 * 从酒馆预设 JSON 抽取可导入内核：只取 prompts + prompt_order[].order，丢弃连接/采样键。
 * @param {object} stJson
 * @param {{ kind?: PresetKind, name?: string }} [opts]
 * @param {IdNowDeps} deps
 * @returns {{ ok: true, value: Preset } | { ok: false, error: import('../../infra/errors.js').AppError }}
 */
export function importFromSillyTavernPreset(stJson, opts, deps) {
    requireArg(deps && isNonEmptyString(deps.id) && isNonEmptyString(deps.now), 'deps');
    if (!isPlainObject(stJson)) {
        return validationErr('PRESET_ST_SHAPE', '不是有效的酒馆预设 JSON');
    }
    if (!Array.isArray(stJson.prompts)) {
        return validationErr('PRESET_ST_PROMPTS', '酒馆预设缺少 prompts 数组');
    }
    let order = [];
    if (Array.isArray(stJson.prompt_order) && stJson.prompt_order.length > 0) {
        const first = stJson.prompt_order[0];
        if (isPlainObject(first) && Array.isArray(first.order)) {
            order = first.order;
        } else if (isArrayOf(stJson.prompt_order, (x) => isPlainObject(x) && 'identifier' in x)) {
            // 已扁平
            order = stJson.prompt_order;
        }
    }
    const preset = createPreset({
        name: opts?.name ?? String(stJson.name ?? '导入预设'),
        kind: normalizePresetKind(opts?.kind),
        retryCount: stJson.retryCount ?? DEFAULT_PRESET_RETRY_COUNT,
        prompts: stJson.prompts,
        prompt_order: order,
    }, deps);
    return validatePreset(preset);
}

/**
 * @param {unknown} raw
 * @returns {PresetPrompt[]}
 */
function normalizePrompts(raw) {
    if (!Array.isArray(raw)) {
        return [];
    }
    return raw.filter((p) => isPlainObject(p)).map((p) => ({
        identifier: String(p.identifier ?? ''),
        name: String(p.name ?? ''),
        role: p.role === 'user' || p.role === 'assistant' ? p.role : 'system',
        content: String(p.content ?? ''),
        enabled: p.enabled !== false,
        workbenchOnly: p.workbenchOnly === true,
        injection_position: p.injection_position === 1 ? 1 : 0,
        injection_depth: Number.isFinite(p.injection_depth) ? Number(p.injection_depth) : 0,
        injection_order: Number.isFinite(p.injection_order) ? Number(p.injection_order) : 100,
    }));
}

/**
 * @param {unknown} raw
 * @param {unknown} prompts
 * @returns {PresetOrderItem[]}
 */
function normalizePromptOrder(raw, prompts) {
    if (Array.isArray(raw) && raw.length > 0) {
        return raw.filter((o) => isPlainObject(o)).map((o) => ({
            identifier: String(o.identifier ?? ''),
            enabled: o.enabled !== false,
        }));
    }
    // 缺省：按 prompts 顺序全开
    return normalizePrompts(prompts).map((p) => ({
        identifier: p.identifier,
        enabled: p.enabled,
    }));
}

/**
 * @param {unknown} obj
 * @returns {{ ok: true, value: Preset } | { ok: false, error: import('../../infra/errors.js').AppError }}
 */
export function validatePreset(obj) {
    if (!isPlainObject(obj)) {
        return validationErr('PRESET_SHAPE', '预设格式无效');
    }
    if (!isNonEmptyString(obj.id)) {
        return validationErr('PRESET_ID', '预设缺少 id');
    }
    if (!isNonEmptyString(obj.name)) {
        return validationErr('PRESET_NAME', '请填写预设名称');
    }
    if (!PRESET_KINDS.has(/** @type {PresetKind} */ (obj.kind))) {
        return validationErr(
            'PRESET_KIND',
            '预设类型必须是 imagegen、recall、single-recall 或 single-imagegen',
        );
    }
    if (!Array.isArray(obj.prompts)) {
        return validationErr('PRESET_PROMPTS', '预设 prompts 必须是数组');
    }
    const retryCount = presetRetryCount(obj);
    if (!Number.isSafeInteger(retryCount) || retryCount < 0) {
        return validationErr('PRESET_RETRY_COUNT', '结果纠错重试次数必须是大于或等于 0 的整数');
    }
    const ver = schemaVersionMismatch(obj, PRESET_SCHEMA_VERSION, 'PRESET_SCHEMA', '预设');
    if (ver) {
        return ver;
    }
    return validationOk(/** @type {Preset} */ ({
        schemaVersion: PRESET_SCHEMA_VERSION,
        id: String(obj.id),
        name: String(obj.name),
        kind: /** @type {PresetKind} */ (obj.kind),
        retryCount,
        prompts: normalizePrompts(obj.prompts),
        prompt_order: normalizePromptOrder(obj.prompt_order, obj.prompts),
        createdAt: String(obj.createdAt ?? ''),
        updatedAt: String(obj.updatedAt ?? ''),
    }));
}
