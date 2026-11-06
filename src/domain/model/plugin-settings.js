/**
 * L3 领域模型 · 插件全局常规设置（裁决 D8）。
 * 键名一旦冻结即为全项目唯一真相；HostPort.loadSettings/saveSettings 与 settings.store 必须用本类型。
 * 归属：W0 契约冻结。defaultPluginSettings 不得调 Date.now / randomUUID。
 */

import {
    isIntInRange,
    isPlainObject,
    requireArg,
    schemaVersionMismatch,
    validationErr,
    validationOk,
} from '../../infra/validate.js';
import {
    defaultNaiParams,
    validateNaiParams,
} from './nai-params.js';
import {
    DEFAULT_CONTEXT_BODY_PATTERN,
    normalizeContextBodyPattern,
} from '../blocks/context-body.js';
import { classifyNaiModel, isKnownNaiModel } from '../nai/param-options.js';

/** @type {number} */
export const PLUGIN_SETTINGS_SCHEMA_VERSION = 1;

/**
 * 快速配置悬浮窗里可显隐的项目，按悬浮窗中的实际顺序。
 * `defaultVisible` 为设置里没写这一项时的默认值。
 */
export const QUICK_CONFIG_ITEMS = Object.freeze([
    { id: 'hideFloatingBall', label: '隐藏悬浮球', defaultVisible: false },
    { id: 'contextWindowSize', label: '上下文楼数', defaultVisible: true },
    { id: 'contextBodyPattern', label: '上下文正文正则', defaultVisible: true },
    { id: 'floorImageScale', label: '楼层图片显示比例', defaultVisible: true },
    { id: 'autoWriteSlots', label: '自动生成提示词', defaultVisible: true },
    { id: 'autoRenderSlots', label: '自动出图', defaultVisible: true },
    { id: 'naiParallel', label: '并行出图', defaultVisible: true },
    { id: 'includeWorldInfo', label: '传入世界书', defaultVisible: true },
    { id: 'includeWorldInfoCharacters', label: '传入世界书角色', defaultVisible: true },
    { id: 'omitRecentSlots', label: '不发近期生图记录', defaultVisible: true },
    { id: 'artist', label: '当前画师串', defaultVisible: true },
    { id: 'nai', label: '当前 NAI', defaultVisible: true },
    { id: 'naiModel', label: '生图模型', defaultVisible: true },
    { id: 'recallLlm', label: '召回 LLM', defaultVisible: true },
    { id: 'promptLlm', label: '提示词 LLM', defaultVisible: true },
    { id: 'imagegenPreset', label: '生图预设', defaultVisible: true },
    { id: 'recallPreset', label: '召回预设', defaultVisible: true },
    { id: 'management', label: '管理台按钮', defaultVisible: true },
]);

/**
 * @param {{ quickConfigVisibility?: Record<string, boolean> }|null|undefined} settings
 * @param {string} id
 * @returns {boolean}
 */
export function isQuickConfigItemVisible(settings, id) {
    const map = settings?.quickConfigVisibility;
    if (map && typeof map[id] === 'boolean') return map[id];
    const item = QUICK_CONFIG_ITEMS.find((it) => it.id === id);
    return item ? item.defaultVisible : true;
}

/**
 * @param {unknown} raw
 * @returns {Record<string, boolean>}
 */
function normalizeQuickConfigVisibility(raw) {
    /** @type {Record<string, boolean>} */
    const out = {};
    if (!isPlainObject(raw)) return out;
    for (const item of QUICK_CONFIG_ITEMS) {
        if (typeof raw[item.id] === 'boolean') out[item.id] = raw[item.id];
    }
    return out;
}

/** 画师串模型版本 → 生图模型的默认绑定。 */
export const DEFAULT_ARTIST_MODEL_BINDING = Object.freeze({
    v5: 'nai-diffusion-5-full',
    'v4.5': 'nai-diffusion-4-5-full',
});

/** 画师串版本标签 → classifyNaiModel 的系列值 */
const TAG_FAMILY = Object.freeze({ v5: 'v5', 'v4.5': 'v45' });

/**
 * @param {unknown} raw
 * @returns {{ v5: string, 'v4.5': string }}
 */
function normalizeArtistModelBinding(raw) {
    const src = isPlainObject(raw) ? raw : {};
    /** @type {Record<string, string>} */
    const out = {};
    for (const [tag, fallback] of Object.entries(DEFAULT_ARTIST_MODEL_BINDING)) {
        const v = typeof src[tag] === 'string' ? src[tag].trim() : '';
        out[tag] = v && isKnownNaiModel(v) && classifyNaiModel(v) === TAG_FAMILY[tag] ? v : fallback;
    }
    return /** @type {{ v5: string, 'v4.5': string }} */ (out);
}

/**
 * 模型 → 画师串版本标签；V4 / 不认识返回 null。
 * @param {unknown} model
 * @returns {'v5'|'v4.5'|null}
 */
export function artistModelTagForModel(model) {
    const fam = classifyNaiModel(String(model || ''));
    if (fam === 'v5') return 'v5';
    if (fam === 'v45') return 'v4.5';
    return null;
}

/**
 * 某版本绑定的生图模型。
 * @param {{ artistModelBinding?: unknown }|null|undefined} settings
 * @param {unknown} tag
 * @returns {string}
 */
export function boundModelForArtistTag(settings, tag) {
    const binding = normalizeArtistModelBinding(settings?.artistModelBinding);
    return tag === 'v4.5' ? binding['v4.5'] : binding.v5;
}

/**
 * 当前画师串换了之后要不要换模型：系列不同才换成绑定模型，否则返回 null（保持不动）。
 * @param {{ artistModelBinding?: unknown }|null|undefined} settings
 * @param {unknown} currentModel
 * @param {unknown} tag 画师串的 modelTag
 * @returns {string|null}
 */
export function followModelForArtistTag(settings, currentModel, tag) {
    const want = tag === 'v4.5' ? 'v4.5' : tag === 'v5' ? 'v5' : null;
    if (!want) return null;
    if (artistModelTagForModel(currentModel) === want) return null;
    const next = boundModelForArtistTag(settings, want);
    return next && next !== currentModel ? next : null;
}

/**
 * 角色关键字匹配的全局默认（可被单条 Character.matchOverrides 覆盖）。
 * @typedef {object} MatchDefaults
 * @property {boolean} caseSensitive
 *   是否区分大小写。默认 false，镜像酒馆 world_info_case_sensitive（基线 §6.4）。
 * @property {boolean} matchWholeWords
 *   是否全词匹配。默认 false，镜像酒馆 world_info_match_whole_words（基线 §6.4）。
 */

/**
 * 插件常规设置。全部键列于下方；任何代理不得自创键名（裁决 D8）。
 *
 * @typedef {object} PluginSettings
 * @property {number} schemaVersion
 * @property {string|null} activeArtistId
 *   当前激活的画师串 id（需求 4.2）。改选前一直用这一条；null = 尚未选择。
 * @property {string|null} activeNaiConfigId
 *   当前激活的 NAI API 配置 id（需求 4.10）。null = 尚未选择。
 * @property {string|null} recallLlmConfigId
 *   标签召回专用的 LLM 配置 id（需求 4.9）。与提示词生成互不覆盖。
 * @property {string|null} promptGenLlmConfigId
 *   提示词生成专用的 LLM 配置 id（需求 4.9）。与召回互不覆盖。
 * @property {string|null} activeImagegenPresetId
 *   当前生图预设 id（需求 4.4 kind=imagegen）。null = 尚未选择。
 * @property {string|null} activeRecallPresetId
 *   当前召回预设 id（需求 4.11 kind=recall）。null = 尚未选择。
 * @property {string|null} activeSingleRecallPresetId
 *   单图召回预设 id（需求 4.16 kind=single-recall）。null = 尚未选择。
 * @property {string|null} activeSingleImagegenPresetId
 *   单图生图预设 id（需求 4.16 kind=single-imagegen）。null = 尚未选择。
 * @property {number} contextWindowSize
 *   「当前上下文」取最近几条 AI 回复楼（需求 4.6）。默认 5。
 * @property {string} contextBodyPattern
 *   从楼层原文抽出正文的正则。默认只留 <content> 内部。空字符串表示整楼都要。
 * @property {number} imageCacheLimit
 *   浏览器楼层图缓存张数上限（需求 4.17）。默认 500；整数 ≥1。没改过不写进扩展设置。
 * @property {number} floorImageScale
 *   楼层里已出图片相对正文的显示宽度，20–100。100 为铺满。只影响显示，不改生成尺寸。
 * @property {boolean} autoWriteSlots
 *   自动写 slot：新 AI 楼落定后走步骤 4–5（需求 4.12）。默认 false。
 * @property {boolean} autoRenderSlots
 *   自动出图：slot 写好后对尚未生图编号走出图（需求 4.12）。默认 false。已生图的不自动再出。
 * @property {boolean} naiParallel 同时请求多张。默认关，一张完成再请求下一张。
 * @property {boolean} hideFloatingBall 隐藏悬浮球。默认关。快捷回复栏仍可进配置和本楼生图。
 * @property {boolean} slotDoubleTapRegenerate
 *   打开后有图的 slot 隐藏「重新生成/重试」按钮，双击图片重新生成。默认关。
 * @property {boolean} confirmSlotRegenerate 双击重新生成前先确认。默认开。
 * @property {number} maxImagesPerFloor 每层楼最多生成几张图；-1 不限。
 * @property {'light'|'dark'} themeMode 插件界面配色；dark 为地雷色夜间模式。
 * @property {boolean} naiModelFollowsArtist 切换当前画师串时，模型系列不同就换成绑定模型。默认开。
 * @property {{ v5: string, 'v4.5': string }} artistModelBinding 画师串版本绑定的生图模型。
 * @property {Record<string, boolean>} quickConfigVisibility
 *   快速配置悬浮窗各项显隐（id 见 QUICK_CONFIG_ITEMS）。没写的项按 defaultVisible。
 * @property {boolean} includeWorldInfo
 *   楼内生图是否把酒馆扫描到的整段世界书写入 {{世界书}}。默认关。
 *   与 includeWorldInfoCharacters 互斥：界面打开其中一个会关掉另一个。
 * @property {boolean} includeWorldInfoCharacters
 *   打开后，{{世界书}} 只放已开启、且条目标题完整包含调用方关键字的条目。
 *   关键字由外部接口传入。没开这个开关时不看关键字。
 * @property {boolean} omitRecentSlots
 *   打开后不把近期生图记录写入 {{近期生图记录}}。默认关。
 *   打开时接口写提示词和直接楼内生图都不读取、不发送这段记录。
 * @property {MatchDefaults} matchDefaults
 *   角色关键字匹配的全局默认。
 * @property {import('./nai-params.js').NaiParams} naiParams
 *   楼层 slot 出图的 4.13 固定参数集。工作台/外部调用可按次覆盖。
 */

/**
 * 返回一份全新的默认配置（纯数据，无副作用）。
 * @returns {PluginSettings}
 */
export function defaultPluginSettings() {
    return {
        schemaVersion: PLUGIN_SETTINGS_SCHEMA_VERSION,
        activeArtistId: null,
        activeNaiConfigId: null,
        recallLlmConfigId: null,
        promptGenLlmConfigId: null,
        activeImagegenPresetId: null,
        activeRecallPresetId: null,
        activeSingleRecallPresetId: null,
        activeSingleImagegenPresetId: null,
        contextWindowSize: 5,
        contextBodyPattern: DEFAULT_CONTEXT_BODY_PATTERN,
        imageCacheLimit: 500,
        floorImageScale: 100,
        autoWriteSlots: false,
        autoRenderSlots: false,
        naiParallel: false,
        hideFloatingBall: false,
        slotDoubleTapRegenerate: false,
        confirmSlotRegenerate: true,
        maxImagesPerFloor: -1,
        themeMode: 'light',
        naiModelFollowsArtist: true,
        artistModelBinding: { ...DEFAULT_ARTIST_MODEL_BINDING },
        quickConfigVisibility: {},
        includeWorldInfo: false,
        includeWorldInfoCharacters: false,
        omitRecentSlots: false,
        matchDefaults: {
            caseSensitive: false,
            matchWholeWords: false,
        },
        naiParams: defaultNaiParams(),
    };
}

/**
 * @param {unknown} v
 * @returns {string|null}
 */
function nullOrString(v) {
    if (v == null || v === '') {
        return null;
    }
    return String(v);
}

/**
 * @param {unknown} raw
 * @returns {MatchDefaults}
 */
function normalizeMatchDefaults(raw) {
    if (!isPlainObject(raw)) {
        return {
            caseSensitive: false,
            matchWholeWords: false,
        };
    }
    return {
        caseSensitive: raw.caseSensitive === true,
        matchWholeWords: raw.matchWholeWords === true,
    };
}

/**
 * 归一化任意输入为 PluginSettings 形状（不做严格业务校验）。
 * @param {unknown} obj
 * @returns {PluginSettings}
 */
export function normalizePluginSettings(obj) {
    const base = defaultPluginSettings();
    if (!isPlainObject(obj)) {
        return base;
    }
    const naiRaw = isPlainObject(obj.naiParams) ? obj.naiParams : {};
    const naiResult = validateNaiParams({ ...defaultNaiParams(), ...naiRaw });
    return {
        schemaVersion: PLUGIN_SETTINGS_SCHEMA_VERSION,
        activeArtistId: nullOrString(obj.activeArtistId),
        activeNaiConfigId: nullOrString(obj.activeNaiConfigId),
        recallLlmConfigId: nullOrString(obj.recallLlmConfigId),
        promptGenLlmConfigId: nullOrString(obj.promptGenLlmConfigId),
        activeImagegenPresetId: nullOrString(obj.activeImagegenPresetId),
        activeRecallPresetId: nullOrString(obj.activeRecallPresetId),
        activeSingleRecallPresetId: nullOrString(obj.activeSingleRecallPresetId),
        activeSingleImagegenPresetId: nullOrString(obj.activeSingleImagegenPresetId),
        contextWindowSize: isIntInRange(obj.contextWindowSize, 1, 100)
            ? Number(obj.contextWindowSize)
            : base.contextWindowSize,
        contextBodyPattern: normalizeContextBodyPattern(
            Object.prototype.hasOwnProperty.call(obj, 'contextBodyPattern')
                ? obj.contextBodyPattern
                : DEFAULT_CONTEXT_BODY_PATTERN,
        ),
        imageCacheLimit: isIntInRange(obj.imageCacheLimit, 1, Number.MAX_SAFE_INTEGER)
            ? Number(obj.imageCacheLimit)
            : base.imageCacheLimit,
        floorImageScale: Number.isInteger(Number(obj.floorImageScale))
            ? Math.min(100, Math.max(20, Number(obj.floorImageScale)))
            : base.floorImageScale,
        autoWriteSlots: obj.autoWriteSlots === true,
        autoRenderSlots: obj.autoRenderSlots === true,
        naiParallel: obj.naiParallel === true,
        hideFloatingBall: obj.hideFloatingBall === true,
        slotDoubleTapRegenerate: obj.slotDoubleTapRegenerate === true,
        confirmSlotRegenerate: obj.confirmSlotRegenerate !== false,
        maxImagesPerFloor: Number.isInteger(Number(obj.maxImagesPerFloor)) && Number(obj.maxImagesPerFloor) >= 1
            ? Number(obj.maxImagesPerFloor)
            : -1,
        themeMode: obj.themeMode === 'dark' ? 'dark' : 'light',
        naiModelFollowsArtist: obj.naiModelFollowsArtist !== false,
        artistModelBinding: normalizeArtistModelBinding(obj.artistModelBinding),
        quickConfigVisibility: normalizeQuickConfigVisibility(obj.quickConfigVisibility),
        includeWorldInfo: obj.includeWorldInfo === true && obj.includeWorldInfoCharacters !== true,
        includeWorldInfoCharacters: obj.includeWorldInfoCharacters === true,
        omitRecentSlots: obj.omitRecentSlots === true,
        matchDefaults: normalizeMatchDefaults(obj.matchDefaults),
        naiParams: naiResult.ok ? naiResult.value : defaultNaiParams(),
    };
}

/**
 * @param {unknown} obj
 * @returns {{ ok: true, value: PluginSettings } | { ok: false, error: import('../../infra/errors.js').AppError }}
 */
export function validatePluginSettings(obj) {
    if (!isPlainObject(obj)) {
        return validationErr('SETTINGS_SHAPE', '插件配置格式无效');
    }
    const ver = schemaVersionMismatch(obj, PLUGIN_SETTINGS_SCHEMA_VERSION, 'SETTINGS_SCHEMA', '插件配置');
    if (ver) {
        return ver;
    }
    if (obj.contextWindowSize != null && !isIntInRange(obj.contextWindowSize, 1, 100)) {
        return validationErr('SETTINGS_CONTEXT_N', '上下文楼数必须是 1–100 的整数');
    }
    if (obj.imageCacheLimit != null && !isIntInRange(obj.imageCacheLimit, 1, Number.MAX_SAFE_INTEGER)) {
        return validationErr('SETTINGS_IMAGE_CACHE_LIMIT', '图片缓存上限必须是 ≥1 的整数');
    }
    if (obj.floorImageScale != null && !isIntInRange(obj.floorImageScale, 20, 100)) {
        return validationErr('SETTINGS_FLOOR_IMAGE_SCALE', '楼层图片显示比例必须是 20–100 的整数');
    }
    if (obj.naiParams != null) {
        const nai = validateNaiParams(obj.naiParams);
        if (!nai.ok) {
            return nai;
        }
    }
    if (obj.matchDefaults != null && !isPlainObject(obj.matchDefaults)) {
        return validationErr('SETTINGS_MATCH', '关键字匹配默认值格式无效');
    }
    return validationOk(normalizePluginSettings(obj));
}

/**
 * 深合并 patch 到当前设置（仅认识的键会被写入）。
 * @param {PluginSettings} current
 * @param {Partial<PluginSettings>} patch
 * @returns {PluginSettings}
 */
export function mergePluginSettings(current, patch) {
    requireArg(isPlainObject(current), 'current');
    if (!isPlainObject(patch)) {
        return normalizePluginSettings(current);
    }
    /** @type {Record<string, unknown>} */
    const merged = { ...current, ...patch };
    if (isPlainObject(patch.matchDefaults)) {
        merged.matchDefaults = {
            ...current.matchDefaults,
            ...patch.matchDefaults,
        };
    }
    if (isPlainObject(patch.naiParams)) {
        merged.naiParams = {
            ...current.naiParams,
            ...patch.naiParams,
        };
    }
    return normalizePluginSettings(merged);
}
