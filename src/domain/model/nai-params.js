/**
 * L3 领域模型 · 4.13 生图参数 + 五个结构开关常量（架构文档 §5.4）。
 * FIXED_STRUCTURE 唯一定义点；不给用户改、不按张改。
 * 归属：W0 契约冻结。
 */

import {
    isFiniteNumber,
    isIntInRange,
    isNonEmptyString,
    isPlainObject,
    requireArg,
    schemaVersionMismatch,
    validationErr,
    validationOk,
} from '../../infra/validate.js';

export const NAI_PARAMS_SCHEMA_VERSION = 1;

/**
 * 程序写死的五个结构开关（需求步骤 5）。
 */
export const FIXED_STRUCTURE = Object.freeze({
    v4_prompt: Object.freeze({ use_coords: true, use_order: true }),
    v4_negative_prompt: Object.freeze({
        legacy_uc: false,
    }),
});

/**
 * 画师串预览全库写死尺寸（需求 4.2 / 4.13：不读用户宽高）。
 * 裁决 D2/D10：832×1216（桌面项目 lab.js 竖图标准分辨率）。
 * W2-F 必须 import 本常量，禁止魔法数。
 */
export const ARTIST_PREVIEW_SIZE = Object.freeze({
    width: 832,
    height: 1216,
});

/**
 * @typedef {object} CharCaption
 * @property {string} char_caption
 * @property {Array<{x: number, y: number}>} [centers]
 */

/**
 * @typedef {object} CaptionBody
 * @property {string} base_caption
 * @property {CharCaption[]} char_captions
 */

/**
 * LLM 产出的「生图内容」caption（不含结构开关、不含 input/negative_prompt）。
 * @typedef {object} NaiCaption
 * @property {{ caption: CaptionBody }} v4_prompt
 * @property {{ caption: CaptionBody }} v4_negative_prompt
 */

/**
 * 4.13 固定参数集（楼层 slot 出图默认值；工作台/外部可按次覆盖）。
 * @typedef {object} NaiParams
 * @property {number} schemaVersion
 * @property {string} model
 * @property {number} width
 * @property {number} height
 * @property {number} steps
 * @property {number} scale
 * @property {string} sampler
 * @property {string} noise_schedule
 * @property {number} seed -1 表示每次出图换一颗种子
 * @property {number} n_samples 固定 1
 * @property {'png'|'webp'} image_format
 * @property {boolean} qualityToggle
 * @property {boolean} tag_hint_qt
 * @property {number} ucPreset
 * @property {boolean} tag_hint_uc_preset
 * @property {number} cfg_rescale
 * @property {number|null} skip_cfg_above_sigma Variety；null 表示关闭
 * @property {boolean} sm SMEA；仅旧模型发送
 * @property {boolean} sm_dyn
 * @property {boolean} straight_alpha
 * @property {boolean} tag_hint_transparent_background
 */

/**
 * 发给 ImageGenPort 的完整请求体（装配后）。
 * @typedef {object} NaiRequest
 * @property {string} input
 * @property {string} negative_prompt
 * @property {object} parameters 含 v4_prompt / v4_negative_prompt 与采样字段
 * @property {string} [model]
 * @property {'generate'|'img2img'} [action] 缺省文生图。图生图由 applyImg2Img 写入
 * @property {Record<string, unknown>} [extra] 调用方多传的 NAI 原生字段
 */

/**
 * @returns {NaiParams}
 */
export function defaultNaiParams() {
    return {
        schemaVersion: NAI_PARAMS_SCHEMA_VERSION,
        model: 'nai-diffusion-4-5-full',
        width: 832,
        height: 1216,
        steps: 28,
        scale: 5,
        sampler: 'k_euler_ancestral',
        noise_schedule: 'karras',
        seed: -1,
        n_samples: 1,
        image_format: 'png',
        qualityToggle: true,
        tag_hint_qt: true,
        ucPreset: 0,
        tag_hint_uc_preset: true,
        cfg_rescale: 0,
        skip_cfg_above_sigma: null,
        sm: false,
        sm_dyn: false,
        straight_alpha: false,
        tag_hint_transparent_background: false,
    };
}

/**
 * @param {object} input
 * @param {{ now?: string }} [_deps] 保留签名一致；参数集无 id
 * @returns {NaiParams}
 */
export function createNaiParams(input, _deps) {
    requireArg(isPlainObject(input), 'input');
    return normalizeNaiParams({ ...defaultNaiParams(), ...input });
}

/**
 * @param {Record<string, unknown>} obj
 * @returns {NaiParams}
 */
export function normalizeNaiParams(obj) {
    const base = defaultNaiParams();
    return {
        schemaVersion: NAI_PARAMS_SCHEMA_VERSION,
        model: isNonEmptyString(obj.model) ? String(obj.model) : base.model,
        width: pickInt(obj.width, base.width),
        height: pickInt(obj.height, base.height),
        steps: pickInt(obj.steps, base.steps),
        scale: isFiniteNumber(obj.scale) ? Number(obj.scale) : base.scale,
        sampler: isNonEmptyString(obj.sampler) ? String(obj.sampler) : base.sampler,
        noise_schedule: isNonEmptyString(obj.noise_schedule)
            ? String(obj.noise_schedule)
            : base.noise_schedule,
        seed: resolveStoredSeed(obj, base.seed),
        n_samples: 1,
        image_format: obj.image_format === 'webp' ? 'webp' : 'png',
        qualityToggle: obj.qualityToggle !== false,
        tag_hint_qt: obj.tag_hint_qt !== false,
        ucPreset: pickInt(obj.ucPreset, base.ucPreset),
        tag_hint_uc_preset: obj.tag_hint_uc_preset !== false,
        cfg_rescale: isFiniteNumber(obj.cfg_rescale) ? Number(obj.cfg_rescale) : base.cfg_rescale,
        skip_cfg_above_sigma: obj.skip_cfg_above_sigma == null
            ? null
            : (isFiniteNumber(obj.skip_cfg_above_sigma) ? Number(obj.skip_cfg_above_sigma) : null),
        sm: obj.sm === true,
        sm_dyn: obj.sm_dyn === true,
        straight_alpha: obj.straight_alpha === true,
        tag_hint_transparent_background: obj.tag_hint_transparent_background === true,
    };
}

/**
 * @param {unknown} v
 * @param {number} fallback
 * @returns {number}
 */
function pickInt(v, fallback) {
    return typeof v === 'number' && Number.isInteger(v) ? v : fallback;
}

/**
 * 旧数据用 seedRandom 勾选表示随机，那一勾没有写进请求。
 * 勾选为开时改成种子 -1。
 * @param {Record<string, unknown>} obj
 * @param {number} fallback
 * @returns {number}
 */
function resolveStoredSeed(obj, fallback) {
    if (obj.seedRandom === true) {
        return -1;
    }
    return pickInt(obj.seed, fallback);
}

/**
 * @param {unknown} obj
 * @returns {{ ok: true, value: NaiParams } | { ok: false, error: import('../../infra/errors.js').AppError }}
 */
export function validateNaiParams(obj) {
    if (!isPlainObject(obj)) {
        return validationErr('NAI_PARAMS_SHAPE', '生图参数格式无效');
    }
    const ver = schemaVersionMismatch(obj, NAI_PARAMS_SCHEMA_VERSION, 'NAI_PARAMS_SCHEMA', '生图参数');
    if (ver) {
        return ver;
    }
    const n = normalizeNaiParams(obj);
    if (!isNonEmptyString(n.model)) {
        return validationErr('NAI_PARAMS_MODEL', '请选择生图模型');
    }
    if (!isIntInRange(n.width, 64, 4096) || !isIntInRange(n.height, 64, 4096)) {
        return validationErr('NAI_PARAMS_SIZE', '宽高超出允许范围');
    }
    if (n.width % 64 !== 0 || n.height % 64 !== 0) {
        return validationErr('NAI_PARAMS_SIZE_STEP', '宽高必须是 64 的倍数');
    }
    if (!isIntInRange(n.steps, 1, 50)) {
        return validationErr('NAI_PARAMS_STEPS', '步数必须在 1–50');
    }
    return validationOk(n);
}

/**
 * 空 caption 骨架（无角色时 char_captions 为空数组）。
 * @returns {NaiCaption}
 */
// 正向场景或任一角色词有字，才算一份能拿去出图的提示词。空骨架不算。
export function captionHasPromptText(caption) {
    const pos = caption && caption.v4_prompt && caption.v4_prompt.caption;
    if (!pos || typeof pos !== 'object') return false;
    if (String(pos.base_caption || '').trim()) return true;
    const chars = Array.isArray(pos.char_captions) ? pos.char_captions : [];
    return chars.some((item) => String(item && item.char_caption || '').trim());
}

export function emptyNaiCaption() {
    return {
        v4_prompt: {
            caption: { base_caption: '', char_captions: [] },
        },
        v4_negative_prompt: {
            caption: { base_caption: '', char_captions: [] },
        },
    };
}

/**
 * @param {unknown} obj
 * @returns {{ ok: true, value: NaiCaption } | { ok: false, error: import('../../infra/errors.js').AppError }}
 */
export function validateNaiCaption(obj) {
    if (!isPlainObject(obj)) {
        return validationErr('NAI_CAPTION_SHAPE', '生图内容格式无效');
    }
    const pos = obj.v4_prompt;
    const neg = obj.v4_negative_prompt;
    if (!isPlainObject(pos) || !isPlainObject(pos.caption)) {
        return validationErr('NAI_CAPTION_POS', '缺少 v4_prompt.caption');
    }
    if (!isPlainObject(neg) || !isPlainObject(neg.caption)) {
        return validationErr('NAI_CAPTION_NEG', '缺少 v4_negative_prompt.caption');
    }
    return validationOk(/** @type {NaiCaption} */ ({
        v4_prompt: {
            caption: {
                base_caption: String(pos.caption.base_caption ?? ''),
                char_captions: normalizeCharCaptions(pos.caption.char_captions),
            },
        },
        v4_negative_prompt: {
            caption: {
                base_caption: String(neg.caption.base_caption ?? ''),
                char_captions: normalizeCharCaptions(neg.caption.char_captions),
            },
        },
    }));
}

/**
 * @param {unknown} raw
 * @returns {CharCaption[]}
 */
function normalizeCharCaptions(raw) {
    if (!Array.isArray(raw)) {
        return [];
    }
    return raw.filter((c) => isPlainObject(c)).map((c) => {
        /** @type {CharCaption} */
        const item = { char_caption: String(c.char_caption ?? '') };
        if (Array.isArray(c.centers)) {
            item.centers = c.centers
                .filter((p) => isPlainObject(p))
                .map((p) => ({
                    x: isFiniteNumber(p.x) ? Number(p.x) : 0,
                    y: isFiniteNumber(p.y) ? Number(p.y) : 0,
                }));
        }
        return item;
    });
}

