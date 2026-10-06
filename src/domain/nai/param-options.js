/**
 * L3 领域层 · 4.13 出图参数可选项对照表（唯一点）。
 * 模型 / 采样器 / 噪声计划 / 官方负面预设 / 尺寸预设 / Variety / 能力开关。
 * 取值出处写在各常量旁；组装与 UI 一律读本模块，禁止散落魔法数。
 */

import { defaultNaiParams, normalizeNaiParams } from '../model/nai-params.js';
import { Ok, Err } from '../../infra/result.js';
import { domainError } from '../../infra/errors.js';

/**
 * @typedef {{ value: string, label: string }} NamedOption
 * @typedef {{ value: number, label: string }} UcOption
 * @typedef {{ id: string, label: string, width: number, height: number }} SizePreset
 * @typedef {'off'|'smea'|'smea_dyn'} SmeaMode
 */

/**
 * 预设里列出的 V4 及以上模型。assembler 固定写 v4_prompt，V3 及更早不放进预设；
 * 表单仍可手填任意编号。
 *
 * 文生图编号出处：docs.novelai.net 的 V5 Curated / V5 Full，以及既有 V4 / V4.5 编号。
 * 局部重绘：V5 发布说明只上了 V5 Full Inpainting，没有 V5 Curated Inpainting。
 * V4 / V4.5 的重绘编号与官方客户端一致。
 *
 * @type {readonly NamedOption[]}
 */
export const NAI_MODEL_OPTIONS = Object.freeze([
    Object.freeze({ value: 'nai-diffusion-5-curated', label: 'NAI Diffusion V5 Curated' }),
    Object.freeze({ value: 'nai-diffusion-5-full', label: 'NAI Diffusion V5 Full' }),
    Object.freeze({
        value: 'nai-diffusion-5-full-inpainting',
        label: 'NAI Diffusion V5 Full Inpainting',
    }),
    Object.freeze({ value: 'nai-diffusion-4-5-curated', label: 'NAI Diffusion V4.5 Curated' }),
    Object.freeze({ value: 'nai-diffusion-4-5-full', label: 'NAI Diffusion V4.5 Full' }),
    Object.freeze({
        value: 'nai-diffusion-4-5-curated-inpainting',
        label: 'NAI Diffusion V4.5 Curated Inpainting',
    }),
    Object.freeze({
        value: 'nai-diffusion-4-5-full-inpainting',
        label: 'NAI Diffusion V4.5 Full Inpainting',
    }),
    Object.freeze({
        value: 'nai-diffusion-4-curated-preview',
        label: 'NAI Diffusion V4 Curated',
    }),
    Object.freeze({ value: 'nai-diffusion-4-full', label: 'NAI Diffusion V4 Full' }),
    Object.freeze({
        value: 'nai-diffusion-4-curated-inpainting',
        label: 'NAI Diffusion V4 Curated Inpainting',
    }),
    Object.freeze({
        value: 'nai-diffusion-4-full-inpainting',
        label: 'NAI Diffusion V4 Full Inpainting',
    }),
]);

/** @type {ReadonlySet<string>} */
const MODEL_ID_SET = new Set(NAI_MODEL_OPTIONS.map((o) => o.value));

/**
 * 采样器。出处：`app/public/index.html` #sampler；与 ST `loadNovelSamplers` 重叠子集。
 * @type {readonly NamedOption[]}
 */
export const NAI_SAMPLER_OPTIONS = Object.freeze([
    Object.freeze({ value: 'k_euler_ancestral', label: 'Euler Ancestral' }),
    Object.freeze({ value: 'k_euler', label: 'Euler' }),
    Object.freeze({ value: 'k_dpmpp_2s_ancestral', label: 'DPM++ 2S Ancestral' }),
    Object.freeze({ value: 'k_dpmpp_2m', label: 'DPM++ 2M' }),
    Object.freeze({ value: 'k_dpmpp_sde', label: 'DPM++ SDE' }),
    Object.freeze({ value: 'ddim_v3', label: 'DDIM' }),
]);

/**
 * 噪声计划（4.5 / V4）。出处：`app/public/index.html` #noiseSchedule；
 * ST `loadNovelSchedulers` 同四项。V5 官方固定 Karras（见 `supportsNoiseScheduleSelect`）。
 * @type {readonly NamedOption[]}
 */
export const NAI_NOISE_SCHEDULE_OPTIONS = Object.freeze([
    Object.freeze({ value: 'karras', label: 'Karras' }),
    Object.freeze({ value: 'native', label: 'Native' }),
    Object.freeze({ value: 'exponential', label: 'Exponential' }),
    Object.freeze({ value: 'polyexponential', label: 'Polyexponential' }),
]);

/**
 * V4.5 / V5 官方负面预设编号。
 * 出处：novelai-bridge `UcPreset::as_api_value`（Heavy=0…None=4）；
 * 显示名对齐 `app/public/index.html` #ucPreset。
 * @type {readonly UcOption[]}
 */
export const NAI_UC_PRESET_OPTIONS = Object.freeze([
    Object.freeze({ value: 0, label: '严格排除' }),
    Object.freeze({ value: 1, label: '轻度排除' }),
    Object.freeze({ value: 2, label: '兽人主体' }),
    Object.freeze({ value: 3, label: '人类主体' }),
    Object.freeze({ value: 4, label: '不使用' }),
]);

/** 「不使用」档的 ucPreset 编号（tag_hint_uc_preset=false）。 */
export const UC_PRESET_NONE = 4;

/**
 * 官方质量词。出处：桌面端 `Rd`。插件只有开/关，开对应 standard，关对应 none。
 * 写在正向提示词末尾，不作为请求字段生效。
 */
export const OFFICIAL_QUALITY_TAGS = 'very aesthetic, masterpiece, no text';

/** @type {readonly string[]} 与 NAI_UC_PRESET_OPTIONS 下标对齐。 */
const UC_PRESET_KEYS = Object.freeze(['heavy', 'light', 'furryFocus', 'humanFocus', 'none']);

/**
 * 官方负面预设正文。出处：桌面端 `Nd`。不附加 nsfw。
 * 4.5 与 V4 用 4.5 词表，V5 用 5.0 词表。
 * @type {Readonly<Record<'v45'|'v5', Record<string, string>>>}
 */
const OFFICIAL_UC_TEXT = Object.freeze({
    v45: Object.freeze({
        heavy: 'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page',
        light: 'lowres, artistic error, scan artifacts, worst quality, bad quality, jpeg artifacts, multiple views, very displeasing, too many watermarks, negative space, blank page',
        furryFocus: '{worst quality}, distracting watermark, unfinished, bad quality, {widescreen}, upscale, {sequence}, {{grandfathered content}}, blurred foreground, chromatic aberration, sketch, everyone, [sketch background], simple, [flat colors], ych (character), outline, multiple scenes, [[horror (theme)]], comic',
        humanFocus: 'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page, @_@, mismatched pupils, glowing eyes, bad anatomy',
        none: '',
    }),
    v5: Object.freeze({
        heavy: 'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page',
        light: 'lowres, bad hands, bad anatomy, artistic error, sepia, white haze, worst quality, very displeasing, jpeg artifacts, 0::ai-generated::',
        furryFocus: '{worst quality}, distracting watermark, unfinished, bad quality, {widescreen}, upscale, {sequence}, {{grandfathered content}}, blurred foreground, chromatic aberration, sketch, everyone, [sketch background], simple, [flat colors], ych (character), outline, multiple scenes, [[horror (theme)]], comic',
        humanFocus: 'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page, @_@, mismatched pupils, glowing eyes, bad anatomy',
        none: '',
    }),
});

/**
 * @param {boolean} qualityOn
 * @returns {string}
 */
export function officialQualityTags(qualityOn) {
    return qualityOn ? OFFICIAL_QUALITY_TAGS : '';
}

/**
 * @param {string} model
 * @param {number} ucPreset
 * @returns {string}
 */
export function officialUndesiredContent(model, ucPreset) {
    const family = classifyNaiModel(model) === 'v5' ? 'v5' : 'v45';
    const index = Number(ucPreset);
    const key = Number.isInteger(index) && index >= 0 && index < UC_PRESET_KEYS.length
        ? UC_PRESET_KEYS[index]
        : 'heavy';
    return OFFICIAL_UC_TEXT[family][key] ?? '';
}

/**
 * 尺寸预设。出处：`app/public/index.html` .size-presets（竖/横/方）。
 * @type {readonly SizePreset[]}
 */
export const NAI_SIZE_PRESETS = Object.freeze([
    Object.freeze({ id: 'portrait', label: '竖图 · 832 × 1216', width: 832, height: 1216 }),
    Object.freeze({ id: 'landscape', label: '横图 · 1216 × 832', width: 1216, height: 832 }),
    Object.freeze({ id: 'square', label: '方图 · 1024 × 1024', width: 1024, height: 1024 }),
]);

/** SMEA 三档。出处：官方 sm / sm_dyn；ST 先 sm 后 sm_dyn。 */
export const SMEA_MODE_OPTIONS = Object.freeze([
    Object.freeze({ value: 'off', label: '关' }),
    Object.freeze({ value: 'smea', label: 'SMEA' }),
    Object.freeze({ value: 'smea_dyn', label: 'SMEA DYN' }),
]);

/** Variety 参考像素与系数。出处：`app/backend.js` `wM` = sqrt(w*h/1011712)*58 */
const VARIETY_REF_PIXELS = 1011712;
const VARIETY_SIGMA_MAGIC = 58;

/**
 * @param {string} model
 * @returns {boolean}
 */
export function isKnownNaiModel(model) {
    return MODEL_ID_SET.has(String(model || ''));
}

/**
 * 列表里显示「完整名（编号）」。手填时直接写编号。
 * @param {NamedOption} option
 * @returns {string}
 */
export function formatNaiModelOption(option) {
    return `${option.label}（${option.value}）`;
}

/**
 * 把下拉显示名或手填文本收成要发给接口的模型编号。
 * 预设名、预设编号、带括号的显示名都能认；其余非空文本原样保留。
 * @param {unknown} raw
 * @returns {string}
 */
export function resolveNaiModelInput(raw) {
    const text = String(raw ?? '').trim();
    if (!text) return '';
    const byValue = NAI_MODEL_OPTIONS.find((option) => option.value === text);
    if (byValue) return byValue.value;
    const byLabel = NAI_MODEL_OPTIONS.find((option) => option.label === text);
    if (byLabel) return byLabel.value;
    const byDisplay = NAI_MODEL_OPTIONS.find((option) => formatNaiModelOption(option) === text);
    if (byDisplay) return byDisplay.value;
    const wrapped = /^(.+?)（([a-z0-9][a-z0-9._-]*)）$/.exec(text);
    if (wrapped) {
        const id = wrapped[2];
        const known = NAI_MODEL_OPTIONS.find((option) => option.value === id);
        if (known) return known.value;
    }
    return text;
}

/**
 * 已知模型显示完整名，手填编号原样显示。
 * @param {unknown} model
 * @returns {string}
 */
export function formatNaiModelInput(model) {
    const id = String(model ?? '').trim();
    const hit = NAI_MODEL_OPTIONS.find((option) => option.value === id);
    return hit ? formatNaiModelOption(hit) : id;
}

/**
 * @param {string} model
 * @returns {'v5'|'v45'|'v4'|null}
 */
export function classifyNaiModel(model) {
    const m = String(model || '').toLowerCase();
    // 必须先判 4.5，再判 V5：`nai-diffusion-4-5-full` 含 `-5-full` 子串
    if (m.includes('4-5') || m.includes('4.5')) {
        return 'v45';
    }
    if (
        m.includes('nai-diffusion-5')
        || m.includes('diffusion-5')
        || /(?:^|[^0-9])5(?:-full|-curated)?(?:$|[^0-9])/.test(m)
    ) {
        return 'v5';
    }
    if (m.includes('nai-diffusion-4') || m.includes('diffusion-4')) {
        return 'v4';
    }
    return null;
}

/**
 * SMEA：仅 V3 及更早。4 / 4.5 / V5 不发（需求 4.13；app 4.5/V5 分支不带 sm；
 * ST 对 V4 Full/Curated 亦强制关）。本插件不列 V3 → UI 恒隐藏。
 * @param {string} model
 * @returns {boolean}
 */
export function supportsSmea(model) {
    const kind = classifyNaiModel(model);
    return kind == null;
}

/**
 * Variety：app `syncModelCapabilities` 对 V5 禁用；仅 4.5 族发送。
 * @param {string} model
 * @returns {boolean}
 */
export function supportsVariety(model) {
    return classifyNaiModel(model) === 'v45';
}

/**
 * CFG Rescale（Prompt Guidance Rescale，请求字段 cfg_rescale）。
 * 各模型都可带：0 是关闭，非 0 也原样发出，不再按模型归 0。
 * @param {string} _model
 * @returns {boolean}
 */
export function supportsCfgRescale(_model) {
    return true;
}

/**
 * 噪声计划可选：V5 官方固定 Karras（app `syncModelCapabilities` / backend V5 分支）。
 * @param {string} model
 * @returns {boolean}
 */
export function supportsNoiseScheduleSelect(model) {
    return classifyNaiModel(model) !== 'v5';
}

/**
 * 透明底只对 V5 生效。请求里靠正向提示词里的 transparent background，不是单独的布尔字段。
 * @param {string} model
 * @returns {boolean}
 */
export function supportsTransparentBackground(model) {
    return classifyNaiModel(model) === 'v5';
}

/**
 * @param {string} model
 * @returns {readonly NamedOption[]}
 */
export function samplersForModel(_model) {
    return NAI_SAMPLER_OPTIONS;
}

/**
 * @param {string} model
 * @returns {readonly NamedOption[]}
 */
export function noiseSchedulesForModel(model) {
    if (!supportsNoiseScheduleSelect(model)) {
        return Object.freeze([NAI_NOISE_SCHEDULE_OPTIONS[0]]);
    }
    return NAI_NOISE_SCHEDULE_OPTIONS;
}

/**
 * @param {string} model
 * @returns {readonly UcOption[]}
 */
export function ucPresetsForModel(_model) {
    return NAI_UC_PRESET_OPTIONS;
}

/**
 * Variety 的 skip_cfg_above_sigma。出处：`app/backend.js` function wM。
 * @param {number} width
 * @param {number} height
 * @param {string} [_model] 保留；app 对 4.5/V5 共用同一公式（V5 根本不发）
 * @returns {number}
 */
export function computeVarietySigma(width, height, _model) {
    const w = Number(width) || 0;
    const h = Number(height) || 0;
    if (!(w > 0) || !(h > 0)) {
        return 0;
    }
    return Math.sqrt((w * h) / VARIETY_REF_PIXELS) * VARIETY_SIGMA_MAGIC;
}

/**
 * @param {boolean} sm
 * @param {boolean} smDyn
 * @returns {SmeaMode}
 */
export function smeaModeFromFlags(sm, smDyn) {
    if (smDyn) return 'smea_dyn';
    if (sm) return 'smea';
    return 'off';
}

/**
 * @param {SmeaMode|string} mode
 * @returns {{ sm: boolean, sm_dyn: boolean }}
 */
export function smeaFlagsFromMode(mode) {
    if (mode === 'smea_dyn') return { sm: true, sm_dyn: true };
    if (mode === 'smea') return { sm: true, sm_dyn: false };
    return { sm: false, sm_dyn: false };
}

/**
 * @param {number} width
 * @param {number} height
 * @returns {string} 预设 id，或 `custom`
 */
export function matchSizePresetId(width, height) {
    const w = Number(width);
    const h = Number(height);
    for (const p of NAI_SIZE_PRESETS) {
        if (p.width === w && p.height === h) return p.id;
    }
    return 'custom';
}

/**
 * @param {number} n
 * @returns {boolean}
 */
export function isMultipleOf64(n) {
    return typeof n === 'number' && Number.isInteger(n) && n >= 64 && n % 64 === 0;
}

/**
 * 换模型后校验当前值；不可用则回退默认并附产品文案。
 *
 * @param {import('../model/nai-params.js').NaiParams|object} params
 * @param {string} model
 * @returns {{ params: import('../model/nai-params.js').NaiParams, notices: string[] }}
 */
export function reconcileParamsForModel(params, model) {
    const defaults = defaultNaiParams();
    const base = normalizeNaiParams({ ...defaults, ...(params || {}), model });
    /** @type {string[]} */
    const notices = [];
    const next = { ...base, model: String(model || defaults.model) };

    if (!String(next.model || '').trim()) {
        notices.push(`未填写模型，已改为「${labelOfModel(defaults.model)}」`);
        next.model = defaults.model;
    }

    const samplerOpts = samplersForModel(next.model);
    if (!samplerOpts.some((o) => o.value === next.sampler)) {
        const fb = defaults.sampler;
        notices.push(`该模型不支持当前采样器，已改为「${labelOf(samplerOpts, fb)}」`);
        next.sampler = fb;
    }

    const noiseOpts = noiseSchedulesForModel(next.model);
    if (!supportsNoiseScheduleSelect(next.model)) {
        if (next.noise_schedule !== 'karras') {
            notices.push('该模型固定使用 Karras 噪声计划，已改为「Karras」');
        }
        next.noise_schedule = 'karras';
    } else if (!noiseOpts.some((o) => o.value === next.noise_schedule)) {
        const fb = defaults.noise_schedule;
        notices.push(`该模型不支持当前噪声计划，已改为「${labelOf(noiseOpts, fb)}」`);
        next.noise_schedule = fb;
    }

    const ucOpts = ucPresetsForModel(next.model);
    if (!ucOpts.some((o) => o.value === next.ucPreset)) {
        const fb = defaults.ucPreset;
        notices.push(`该模型不支持当前官方负面预设，已改为「${labelOfUc(ucOpts, fb)}」`);
        next.ucPreset = fb;
        next.tag_hint_uc_preset = fb !== UC_PRESET_NONE;
    } else {
        next.tag_hint_uc_preset = next.ucPreset !== UC_PRESET_NONE;
    }

    // 成对：质量词 / 透明底 保持同值
    next.tag_hint_qt = next.qualityToggle !== false;
    next.qualityToggle = next.qualityToggle !== false;

    if (!supportsTransparentBackground(next.model)) {
        if (next.straight_alpha || next.tag_hint_transparent_background) {
            notices.push('该模型不支持透明底，已关闭');
        }
        next.straight_alpha = false;
        next.tag_hint_transparent_background = false;
    } else {
        const on = next.straight_alpha === true || next.tag_hint_transparent_background === true;
        next.straight_alpha = on;
        next.tag_hint_transparent_background = on;
    }

    if (!supportsSmea(next.model)) {
        if (next.sm || next.sm_dyn) {
            notices.push('该模型不支持 SMEA，已关闭');
        }
        next.sm = false;
        next.sm_dyn = false;
    }

    if (!supportsVariety(next.model)) {
        if (next.skip_cfg_above_sigma != null) {
            notices.push('该模型不支持 Variety，已关闭');
        }
        next.skip_cfg_above_sigma = null;
    }

    if (!supportsCfgRescale(next.model)) {
        if (Number(next.cfg_rescale) !== 0) {
            notices.push('该模型不支持 CFG Rescale，已改为 0');
        }
        next.cfg_rescale = 0;
    }

    return { params: normalizeNaiParams(next), notices };
}

/**
 * 保存 / UI 换模型：强制合法组合（静默回退）。
 * 4.14 对外入口的显式参数校验见 `mergeNaiParamsForGenerate`，不走本函数。
 * @param {import('../model/nai-params.js').NaiParams|object} params
 * @returns {import('../model/nai-params.js').NaiParams}
 */
export function coerceNaiParams(params) {
    return reconcileParamsForModel(params, params?.model).params;
}

/** @type {ReadonlySet<string>} */
const NAI_PARAM_KEYS = new Set(Object.keys(defaultNaiParams()));

/**
 * 4.14 合并：调用方**显式**传入的非法项 → Err；未传的项取 4.13，若对新模型不合法则回退默认。
 *
 * @param {import('../model/nai-params.js').NaiParams|object} base 运行配置 naiParams
 * @param {Record<string, unknown>|null|undefined} overrides 本次显式覆盖（含多传原生字段）
 * @returns {{
 *   ok: true,
 *   value: {
 *     params: import('../model/nai-params.js').NaiParams,
 *     extras: Record<string, unknown>,
 *   },
 * } | {
 *   ok: false,
 *   error: import('../../infra/errors.js').AppError,
 * }}
 */
export function mergeNaiParamsForGenerate(base, overrides) {
    const defaults = defaultNaiParams();
    const baseN = normalizeNaiParams(base && typeof base === 'object' ? base : defaults);
    const raw = (overrides && typeof overrides === 'object') ? overrides : {};

    /** @type {Record<string, unknown>} */
    const explicit = {};
    /** @type {Record<string, unknown>} */
    const extras = {};
    for (const [key, value] of Object.entries(raw)) {
        if (NAI_PARAM_KEYS.has(key)) {
            explicit[key] = value;
        } else {
            extras[key] = value;
        }
    }

    /**
     * @param {string} key
     * @returns {boolean}
     */
    const has = (key) => Object.prototype.hasOwnProperty.call(explicit, key);

    // —— 模型 ——
    let model;
    if (has('model')) {
        model = resolveNaiModelInput(explicit.model);
        if (!model) {
            return Err(paramValidationError({
                field: 'model',
                value: model,
                message: '请填写模型编号',
                allowed: NAI_MODEL_OPTIONS.map((o) => o.value),
            }));
        }
    } else {
        model = resolveNaiModelInput(baseN.model) || defaults.model;
    }

    /** @type {import('../model/nai-params.js').NaiParams} */
    const next = { ...baseN, model };

    // —— 采样器 ——
    {
        const sampler = has('sampler') ? String(explicit.sampler) : next.sampler;
        const opts = samplersForModel(model);
        if (!opts.some((o) => o.value === sampler)) {
            if (has('sampler')) {
                return Err(paramValidationError({
                    field: 'sampler',
                    value: sampler,
                    message: `采样器「${sampler}」不被模型「${labelOfModel(model)}」支持，可选：${opts.map((o) => o.label).join('、')}`,
                    allowed: opts.map((o) => o.value),
                    model,
                }));
            }
            next.sampler = defaults.sampler;
        } else {
            next.sampler = sampler;
        }
    }

    // —— 噪声计划 ——
    {
        const noise = has('noise_schedule')
            ? String(explicit.noise_schedule)
            : next.noise_schedule;
        const opts = noiseSchedulesForModel(model);
        if (!opts.some((o) => o.value === noise)) {
            if (has('noise_schedule')) {
                return Err(paramValidationError({
                    field: 'noise_schedule',
                    value: noise,
                    message: `噪声计划「${noise}」不被模型「${labelOfModel(model)}」支持，可选：${opts.map((o) => o.label).join('、')}`,
                    allowed: opts.map((o) => o.value),
                    model,
                }));
            }
            next.noise_schedule = opts[0]?.value || defaults.noise_schedule;
        } else {
            next.noise_schedule = noise;
        }
    }

    // —— 官方负面预设 ——
    {
        const uc = has('ucPreset') ? Number(explicit.ucPreset) : next.ucPreset;
        const opts = ucPresetsForModel(model);
        if (!opts.some((o) => o.value === uc)) {
            if (has('ucPreset')) {
                return Err(paramValidationError({
                    field: 'ucPreset',
                    value: uc,
                    message: `官方负面预设编号「${uc}」不被模型「${labelOfModel(model)}」支持，可选：${opts.map((o) => `${o.label}(${o.value})`).join('、')}`,
                    allowed: opts.map((o) => o.value),
                    model,
                }));
            }
            next.ucPreset = defaults.ucPreset;
            next.tag_hint_uc_preset = defaults.ucPreset !== UC_PRESET_NONE;
        } else {
            next.ucPreset = uc;
            if (has('tag_hint_uc_preset')) {
                next.tag_hint_uc_preset = explicit.tag_hint_uc_preset !== false;
            } else {
                next.tag_hint_uc_preset = uc !== UC_PRESET_NONE;
            }
        }
    }

    // —— 宽高 ——
    {
        const width = has('width') ? Number(explicit.width) : next.width;
        const height = has('height') ? Number(explicit.height) : next.height;
        if (has('width') && !isMultipleOf64(width)) {
            return Err(paramValidationError({
                field: 'width',
                value: width,
                message: `宽「${width}」无效：须为 64–4096 且为 64 的倍数`,
                allowed: ['64 的倍数，范围 64–4096'],
                model,
            }));
        }
        if (has('height') && !isMultipleOf64(height)) {
            return Err(paramValidationError({
                field: 'height',
                value: height,
                message: `高「${height}」无效：须为 64–4096 且为 64 的倍数`,
                allowed: ['64 的倍数，范围 64–4096'],
                model,
            }));
        }
        next.width = isMultipleOf64(width) ? width : defaults.width;
        next.height = isMultipleOf64(height) ? height : defaults.height;
    }

    // —— Variety ——
    {
        const skip = has('skip_cfg_above_sigma')
            ? (explicit.skip_cfg_above_sigma == null
                ? null
                : Number(explicit.skip_cfg_above_sigma))
            : next.skip_cfg_above_sigma;
        if (skip != null && !supportsVariety(model)) {
            if (has('skip_cfg_above_sigma')) {
                return Err(paramValidationError({
                    field: 'skip_cfg_above_sigma',
                    value: skip,
                    message: `模型「${labelOfModel(model)}」不支持 Variety（skip_cfg_above_sigma），请勿传入该字段或改为 null`,
                    allowed: [null],
                    model,
                }));
            }
            next.skip_cfg_above_sigma = null;
        } else {
            next.skip_cfg_above_sigma = skip != null && Number.isFinite(skip) ? skip : null;
        }
    }

    // —— CFG Rescale ——
    {
        const cfg = has('cfg_rescale') ? Number(explicit.cfg_rescale) : next.cfg_rescale;
        if (!supportsCfgRescale(model) && Number(cfg) !== 0) {
            if (has('cfg_rescale')) {
                return Err(paramValidationError({
                    field: 'cfg_rescale',
                    value: cfg,
                    message: `模型「${labelOfModel(model)}」不支持 CFG Rescale，请传 0 或不传`,
                    allowed: [0],
                    model,
                }));
            }
            next.cfg_rescale = 0;
        } else {
            next.cfg_rescale = Number.isFinite(cfg) ? cfg : 0;
        }
    }

    // —— 透明底 ——
    {
        const straight = has('straight_alpha')
            ? explicit.straight_alpha === true
            : next.straight_alpha === true;
        const hintTb = has('tag_hint_transparent_background')
            ? explicit.tag_hint_transparent_background === true
            : next.tag_hint_transparent_background === true;
        const wantOn = straight || hintTb;
        const explicitTransparent = has('straight_alpha')
            || has('tag_hint_transparent_background');
        if (wantOn && !supportsTransparentBackground(model)) {
            if (explicitTransparent) {
                return Err(paramValidationError({
                    field: 'straight_alpha',
                    value: true,
                    message: `模型「${labelOfModel(model)}」不支持透明底，请勿开启 straight_alpha / tag_hint_transparent_background`,
                    allowed: [false],
                    model,
                }));
            }
            next.straight_alpha = false;
            next.tag_hint_transparent_background = false;
        } else {
            next.straight_alpha = wantOn && supportsTransparentBackground(model);
            next.tag_hint_transparent_background = next.straight_alpha;
        }
    }

    // —— SMEA ——
    {
        const sm = has('sm') ? explicit.sm === true : next.sm === true;
        const smDyn = has('sm_dyn') ? explicit.sm_dyn === true : next.sm_dyn === true;
        const wantSmea = sm || smDyn;
        const explicitSmea = has('sm') || has('sm_dyn');
        if (wantSmea && !supportsSmea(model)) {
            if (explicitSmea) {
                return Err(paramValidationError({
                    field: 'sm',
                    value: { sm, sm_dyn: smDyn },
                    message: `模型「${labelOfModel(model)}」不支持 SMEA，请勿传入 sm / sm_dyn`,
                    allowed: [{ sm: false, sm_dyn: false }],
                    model,
                }));
            }
            next.sm = false;
            next.sm_dyn = false;
        } else if (supportsSmea(model)) {
            next.sm = sm;
            next.sm_dyn = smDyn;
        } else {
            next.sm = false;
            next.sm_dyn = false;
        }
    }

    // 其余显式键直接覆盖（质量词开关、步数等）
    for (const key of [
        'steps', 'scale', 'seed', 'image_format',
        'qualityToggle', 'tag_hint_qt', 'n_samples', 'schemaVersion',
    ]) {
        if (has(key)) {
            next[key] = /** @type {any} */ (explicit[key]);
        }
    }

    // 成对质量词
    if (has('qualityToggle') || has('tag_hint_qt')) {
        const on = has('qualityToggle')
            ? explicit.qualityToggle !== false
            : explicit.tag_hint_qt !== false;
        next.qualityToggle = on;
        next.tag_hint_qt = on;
    } else {
        next.tag_hint_qt = next.qualityToggle !== false;
        next.qualityToggle = next.qualityToggle !== false;
    }

    return Ok({
        params: normalizeNaiParams(next),
        extras,
    });
}

/**
 * @param {object} init
 * @param {string} init.field
 * @param {unknown} init.value
 * @param {string} init.message
 * @param {unknown} init.allowed
 * @param {string} [init.model]
 * @returns {import('../../infra/errors.js').AppError}
 */
function paramValidationError(init) {
    return domainError({
        code: 'NAI_PARAMS_INVALID',
        message: init.message,
        hint: '请按模型允许的取值修正后重试',
        context: {
            field: init.field,
            value: init.value,
            allowed: init.allowed,
            ...(init.model ? { model: init.model } : {}),
        },
    });
}

/**
 * 按模型能力展开最终要写入 parameters 的采样字段（成对字段 + Variety 计算）。
 * @param {import('../model/nai-params.js').NaiParams|object} params
 * @returns {Record<string, unknown>}
 */
export function expandNaiParamFields(params) {
    const coerced = coerceNaiParams(params);
    const model = coerced.model;
    const qualityOn = coerced.qualityToggle !== false;
    const ucNone = coerced.ucPreset === UC_PRESET_NONE;
    const transparentOn = supportsTransparentBackground(model)
        && (coerced.straight_alpha === true || coerced.tag_hint_transparent_background === true);

    /** @type {Record<string, unknown>} */
    const out = {
        model,
        width: coerced.width,
        height: coerced.height,
        steps: coerced.steps,
        scale: coerced.scale,
        sampler: coerced.sampler,
        noise_schedule: supportsNoiseScheduleSelect(model) ? coerced.noise_schedule : 'karras',
        seed: coerced.seed,
        n_samples: 1,
        image_format: coerced.image_format,
        qualityToggle: qualityOn,
        tag_hint_qt: qualityOn,
        ucPreset: coerced.ucPreset,
        tag_hint_uc_preset: !ucNone,
        cfg_rescale: supportsCfgRescale(model) ? coerced.cfg_rescale : 0,
        skip_cfg_above_sigma: null,
        straight_alpha: transparentOn,
        tag_hint_transparent_background: transparentOn,
    };

    if (supportsVariety(model) && coerced.skip_cfg_above_sigma != null) {
        out.skip_cfg_above_sigma = computeVarietySigma(coerced.width, coerced.height, model);
    }

    if (supportsSmea(model)) {
        out.sm = coerced.sm === true;
        out.sm_dyn = coerced.sm_dyn === true;
    }

    return out;
}

/**
 * @param {readonly NamedOption[]} opts
 * @param {string} value
 * @returns {string}
 */
function labelOf(opts, value) {
    const hit = opts.find((o) => o.value === value);
    return hit ? hit.label : String(value);
}

/**
 * @param {readonly UcOption[]} opts
 * @param {number} value
 * @returns {string}
 */
function labelOfUc(opts, value) {
    const hit = opts.find((o) => o.value === value);
    return hit ? hit.label : String(value);
}

/**
 * @param {string} model
 * @returns {string}
 */
export function labelOfModel(model) {
    const hit = NAI_MODEL_OPTIONS.find((o) => o.value === model);
    return hit ? hit.label : String(model || '');
}
