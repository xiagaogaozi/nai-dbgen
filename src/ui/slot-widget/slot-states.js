/**
 * L5 UI · slot 四态推导与文案（纯函数，可单测）。
 * 归属：W2-G。
 *
 * 四态：idle（未生图）/ generating（生图中）/ done（已出图）/ error（失败）。
 * Abort / SLOT_ALREADY_RENDERED 不计作失败红错。
 * D43：非 Result（含 undefined）→ invalid，调用方不得清视觉表。
 */

import { t } from '../i18n/zh-CN.js';

/** @typedef {'idle'|'generating'|'done'|'error'|'beyond_retain'|'load_error'} SlotUiState */

/**
 * @typedef {object} SlotRuntimeSnapshot
 * @property {'generating'|'error'|null|undefined} [status]
 * @property {unknown} [error]
 * @property {string|null|undefined} [traceId]
 * @property {boolean} [beyondRetain]
 * @property {boolean} [hasCachedImage]
 * @property {boolean} [cacheMissing]
 *   记录里有 imageRef 但浏览器缓存已不在 → 按未生图（可再出）。
 * @property {boolean} [loadError]
 * @property {string|null|undefined} [loadErrorMessage]
 */

/**
 * @typedef {object} SlotUiView
 * @property {SlotUiState} state
 * @property {string} buttonLabel
 * @property {string} stateClass
 * @property {boolean} busy
 * @property {boolean} showImage
 * @property {boolean} showError
 * @property {string} errorMessage
 * @property {string} traceId
 * @property {boolean} [canClick]
 */

/**
 * @param {{ images?: Array<{ imageRef?: string }> }|null|undefined} record
 * @returns {{ imageRef: string }|null}
 */
export function latestImageEntry(record) {
    if (!record || !Array.isArray(record.images) || record.images.length === 0) {
        return null;
    }
    const last = record.images[record.images.length - 1];
    if (!last || last.imageRef == null || String(last.imageRef).trim() === '') {
        return null;
    }
    return { imageRef: String(last.imageRef) };
}

/**
 * @param {{ images?: unknown[] }|null|undefined} record
 * @returns {boolean}
 */
export function recordHasImage(record) {
    return latestImageEntry(record) != null;
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function errorCode(err) {
    if (err == null || typeof err !== 'object') {
        return '';
    }
    const rec = /** @type {Record<string, unknown>} */ (err);
    if (rec.error != null && rec.error !== err && typeof rec.ok === 'boolean') {
        return errorCode(rec.error);
    }
    return rec.code != null ? String(rec.code) : '';
}

/**
 * 用户取消 / Abort：不计失败、不弹错。
 * @param {unknown} err
 * @returns {boolean}
 */
export function isAbortFailure(err) {
    if (err == null) {
        return false;
    }
    if (typeof err === 'object') {
        const code = errorCode(err);
        if (
            code === 'UPSTREAM_ABORTED'
            || code === 'NAI_ABORTED'
            || code === 'ABORT_ERR'
        ) {
            return true;
        }
        const rec = /** @type {Record<string, unknown>} */ (err);
        const name = rec.name != null ? String(rec.name) : '';
        if (name === 'AbortError') {
            return true;
        }
        if (rec.error != null && rec.error !== err) {
            return isAbortFailure(rec.error);
        }
    }
    return false;
}

/**
 * 应用层闸门拒重出（D35）：正常工作，不弹红错。
 * @param {unknown} err
 * @returns {boolean}
 */
export function isAlreadyRenderedFailure(err) {
    return errorCode(err) === 'SLOT_ALREADY_RENDERED';
}

/**
 * 是否应进入 error 态（Abort / 已出图拒重出 → false）。
 * @param {unknown} err
 * @returns {boolean}
 */
export function shouldTreatAsError(err) {
    if (err == null) {
        return false;
    }
    if (isAbortFailure(err) || isAlreadyRenderedFailure(err)) {
        return false;
    }
    return true;
}

/**
 * @param {unknown} err
 * @returns {string}
 */
export function slotErrorMessage(err) {
    if (err == null) {
        return '';
    }
    if (typeof err === 'string') {
        return err;
    }
    if (typeof err === 'object') {
        const rec = /** @type {Record<string, unknown>} */ (err);
        if (rec.error != null && rec.error !== err && typeof rec.ok === 'boolean') {
            return slotErrorMessage(rec.error);
        }
        if (rec.message != null && String(rec.message).trim() !== '') {
            return String(rec.message);
        }
    }
    return '生图失败';
}

/**
 * @param {unknown} err
 * @param {string|null|undefined} [fallbackTraceId]
 * @returns {string}
 */
export function slotErrorTraceId(err, fallbackTraceId) {
    if (err && typeof err === 'object') {
        const rec = /** @type {Record<string, unknown>} */ (err);
        if (rec.error != null && rec.error !== err && typeof rec.ok === 'boolean') {
            return slotErrorTraceId(rec.error, fallbackTraceId);
        }
        if (rec.traceId != null && String(rec.traceId).trim() !== '') {
            return String(rec.traceId);
        }
    }
    if (fallbackTraceId != null && String(fallbackTraceId).trim() !== '') {
        return String(fallbackTraceId);
    }
    return '';
}

/**
 * @param {SlotUiState} state
 * @returns {string}
 */
export function slotStateClass(state) {
    switch (state) {
        case 'generating':
            return 'nd-slot--generating';
        case 'done':
            return 'nd-slot--done';
        case 'error':
            return 'nd-slot--error';
        case 'beyond_retain':
            return 'nd-slot--beyond';
        case 'load_error':
            return 'nd-slot--error';
        case 'idle':
        default:
            return 'nd-slot--idle';
    }
}

/**
 * @param {SlotUiState} state
 * @returns {string}
 */
export function slotButtonLabel(state) {
    switch (state) {
        case 'generating':
            return '正在生图…';
        case 'done':
            return t('slot.regenerate');
        case 'error':
            return '重试';
        case 'beyond_retain':
            return '已超出保留范围';
        case 'load_error':
            return '记录加载失败';
        case 'idle':
        default:
            return t('slot.generate');
    }
}

/**
 * @param {{ images?: unknown[] }|null|undefined} record
 * @param {SlotRuntimeSnapshot|null|undefined} runtime
 * @returns {SlotUiView}
 */
export function deriveSlotUiView(record, runtime) {
    /** @type {SlotUiState} */
    let state = 'idle';

    if (runtime && runtime.loadError) {
        state = 'load_error';
    } else if (runtime && runtime.status === 'generating') {
        state = 'generating';
    } else if (runtime && runtime.status === 'error' && shouldTreatAsError(runtime.error)) {
        state = 'error';
    } else if (recordHasImage(record) && runtime?.cacheMissing !== true) {
        state = 'done';
    } else if (runtime && runtime.beyondRetain) {
        // 有缓存图照常显示，但不可再出图（需求 4.17）
        state = 'beyond_retain';
    } else {
        state = 'idle';
    }

    const errSrc = runtime && runtime.status === 'error' ? runtime.error : null;
    let errorMessage = state === 'error' ? slotErrorMessage(errSrc) : '';
    if (state === 'load_error') {
        errorMessage = runtime?.loadErrorMessage
            ? String(runtime.loadErrorMessage)
            : '生图记录加载失败，请刷新后重试';
    }
    if (state === 'beyond_retain') {
        errorMessage = runtime?.hasCachedImage
            ? '已超出保留范围，仅可查看已出的图'
            : '已超出保留范围';
    }
    const traceId = state === 'error'
        ? slotErrorTraceId(errSrc, runtime?.traceId)
        : '';

    const canClick = state !== 'beyond_retain'
        && state !== 'load_error'
        && state !== 'generating';

    return {
        state,
        buttonLabel: slotButtonLabel(state),
        stateClass: slotStateClass(state),
        busy: state === 'generating',
        showImage: state === 'done' || state === 'generating'
            || (state === 'beyond_retain' && runtime?.hasCachedImage === true),
        showError: state === 'error' || state === 'load_error' || state === 'beyond_retain',
        errorMessage,
        traceId,
        /** @type {boolean} */
        canClick,
    };
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isResultShape(value) {
    return value != null
        && typeof value === 'object'
        && typeof /** @type {{ ok?: unknown }} */ (value).ok === 'boolean';
}

/**
 * 解析 onGenerateClick 结算（D43：必须是 Result）。
 * @param {unknown} settled
 * @returns {
 *   | { kind: 'ok' }
 *   | { kind: 'abort' }
 *   | { kind: 'already' }
 *   | { kind: 'error', error: unknown }
 *   | { kind: 'invalid' }
 * }
 */
export function classifyGenerateSettlement(settled) {
    // D43：undefined / void / 非 Result → invalid，调用方不得清表
    if (!isResultShape(settled)) {
        return { kind: 'invalid' };
    }
    const result = /** @type {{ ok: boolean, error?: unknown }} */ (settled);
    if (result.ok) {
        return { kind: 'ok' };
    }
    if (isAbortFailure(result.error)) {
        return { kind: 'abort' };
    }
    if (isAlreadyRenderedFailure(result.error)) {
        return { kind: 'already' };
    }
    return { kind: 'error', error: result.error ?? settled };
}
