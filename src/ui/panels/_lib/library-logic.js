/**
 * 库管理面板纯逻辑（可单测，无 DOM）。
 * 筛选 / 排序 / 导入预检 / 设置键白名单 / 画师预览入参。
 */

import { extractPreviewRows } from '../../common/import-export.js';
import { safeImageUrl } from '../../common/safe-url.js';
import { ARTIST_PREVIEW_SIZE } from '../../../domain/model/nai-params.js';

/**
 * D8 冻结键名（与 plugin-settings.js 对齐；不得自创）。
 * @type {readonly string[]}
 */
export const PLUGIN_SETTINGS_KEYS = Object.freeze([
    'schemaVersion',
    'activeArtistId',
    'activeNaiConfigId',
    'recallLlmConfigId',
    'promptGenLlmConfigId',
    'activeImagegenPresetId',
    'activeRecallPresetId',
    'activeSingleRecallPresetId',
    'activeSingleImagegenPresetId',
    'contextWindowSize',
    'imageCacheLimit',
    'floorImageScale',
    'autoWriteSlots',
    'autoRenderSlots',
    'naiParallel',
    'hideFloatingBall',
    'includeWorldInfo',
    'omitRecentSlots',
    'matchDefaults',
    'naiParams',
]);

/**
 * @param {unknown} query
 * @returns {string}
 */
export function normalizeSearchQuery(query) {
    return String(query ?? '').trim().toLowerCase();
}

/**
 * @param {object} item
 * @param {string[]} keys
 * @returns {string}
 */
export function itemSearchHaystack(item, keys) {
    if (!item || typeof item !== 'object') return '';
    const parts = [];
    for (const key of keys) {
        const v = /** @type {Record<string, unknown>} */ (item)[key];
        if (v == null) continue;
        if (Array.isArray(v)) {
            parts.push(v.map((x) => String(x)).join(' '));
        } else {
            parts.push(String(v));
        }
    }
    return parts.join(' ').toLowerCase();
}

/**
 * @template T
 * @param {T[]} items
 * @param {object} opts
 * @param {string} [opts.query]
 * @param {string[]} [opts.searchKeys]
 * @param {(item: T) => boolean} [opts.predicate]
 * @param {string} [opts.sort]
 * @param {(a: T, b: T) => number} [opts.compare]
 * @returns {T[]}
 */
export function filterSortItems(items, opts = {}) {
    const list = Array.isArray(items) ? items.slice() : [];
    const q = normalizeSearchQuery(opts.query);
    const keys = Array.isArray(opts.searchKeys) && opts.searchKeys.length
        ? opts.searchKeys
        : ['name', 'key', 'label', 'model', 'baseUrl'];
    let out = list;
    if (q) {
        out = out.filter((item) => itemSearchHaystack(item, keys).includes(q));
    }
    if (typeof opts.predicate === 'function') {
        out = out.filter(opts.predicate);
    }
    if (typeof opts.compare === 'function') {
        out.sort(opts.compare);
    } else if (opts.sort === 'sequence-asc') {
        out.sort((a, b) => Number(a?.sequence ?? 0) - Number(b?.sequence ?? 0));
    } else if (opts.sort === 'sequence-desc') {
        out.sort((a, b) => Number(b?.sequence ?? 0) - Number(a?.sequence ?? 0));
    } else if (opts.sort === 'name-desc') {
        out.sort((a, b) => String(b?.name ?? '').localeCompare(String(a?.name ?? ''), 'zh'));
    } else if (opts.sort === 'updated-desc') {
        out.sort((a, b) => String(b?.updatedAt ?? '').localeCompare(String(a?.updatedAt ?? '')));
    } else {
        // name-asc 默认
        out.sort((a, b) => String(a?.name ?? a?.key ?? '').localeCompare(String(b?.name ?? b?.key ?? ''), 'zh'));
    }
    return out;
}

/**
 * 两层列表：按父级过滤 + 子级搜索。
 * @template {{ id: string }} P
 * @template {{ id: string }} C
 * @param {P[]} parents
 * @param {Map<string, C[]>|Record<string, C[]>} childrenByParent
 * @param {object} opts
 * @param {string} [opts.query]
 * @param {string[]} [opts.parentSearchKeys]
 * @param {string[]} [opts.childSearchKeys]
 * @param {(p: P) => boolean} [opts.parentPredicate]
 * @param {boolean} [opts.activeOnly]
 * @returns {{ parents: P[], childrenByParentId: Map<string, C[]> }}
 */
export function filterNestedLibrary(parents, childrenByParent, opts = {}) {
    const q = normalizeSearchQuery(opts.query);
    const parentKeys = opts.parentSearchKeys || ['name'];
    const childKeys = opts.childSearchKeys || ['name', 'key', 'value', 'fixedFeatures'];
    /** @type {Map<string, C[]>} */
    const map = childrenByParent instanceof Map
        ? childrenByParent
        : new Map(Object.entries(childrenByParent || {}));

    /** @type {P[]} */
    const outParents = [];
    /** @type {Map<string, C[]>} */
    const outChildren = new Map();

    for (const parent of parents || []) {
        if (typeof opts.parentPredicate === 'function' && !opts.parentPredicate(parent)) {
            continue;
        }
        if (opts.activeOnly && parent && /** @type {{ active?: boolean }} */ (parent).active === false) {
            continue;
        }
        const pid = String(parent.id);
        const children = (map.get(pid) || []).slice();
        let matchedChildren = children;
        if (q) {
            const parentHit = itemSearchHaystack(parent, parentKeys).includes(q);
            matchedChildren = children.filter((c) => itemSearchHaystack(c, childKeys).includes(q));
            if (!parentHit && matchedChildren.length === 0) {
                continue;
            }
            if (parentHit && matchedChildren.length === 0) {
                matchedChildren = children;
            }
        }
        outParents.push(parent);
        outChildren.set(pid, matchedChildren);
    }

    outParents.sort((a, b) => {
        const ao = Number(/** @type {{ order?: number }} */ (a).order);
        const bo = Number(/** @type {{ order?: number }} */ (b).order);
        if (Number.isFinite(ao) && Number.isFinite(bo) && ao !== bo) return ao - bo;
        return String(a?.name ?? '').localeCompare(String(b?.name ?? ''), 'zh');
    });

    return { parents: outParents, childrenByParentId: outChildren };
}

/**
 * 解析导入文本：非法 JSON → Err，不产生可提交载荷。
 * @param {string} text
 * @returns {{ ok: true, value: object } | { ok: false, error: string }}
 */
export function parseImportJsonText(text) {
    try {
        const data = JSON.parse(String(text ?? ''));
        if (data == null || typeof data !== 'object') {
            return { ok: false, error: '导入根节点必须是对象或数组' };
        }
        return { ok: true, value: /** @type {object} */ (data) };
    } catch (err) {
        return {
            ok: false,
            error: `无法解析 JSON：${err instanceof Error ? err.message : String(err)}`,
        };
    }
}

/**
 * 导入预检：先解析、再按 kind 校验信封；失败则不得调用仓储 importJson。
 * @param {string|object} raw
 * @param {string} expectedKind
 * @returns {{ ok: true, value: { data: object, rows: object[] } } | { ok: false, error: string }}
 */
export function prepareImportCommit(raw, expectedKind) {
    /** @type {object} */
    let data;
    if (typeof raw === 'string') {
        const parsed = parseImportJsonText(raw);
        if (!parsed.ok) return parsed;
        data = parsed.value;
    } else if (raw && typeof raw === 'object') {
        data = /** @type {object} */ (raw);
    } else {
        return { ok: false, error: '导入数据无效' };
    }

    const kindCheck = assertImportKind(data, expectedKind);
    if (!kindCheck.ok) return kindCheck;

    const rows = extractPreviewRows(data);
    if (!rows.length) {
        return { ok: false, error: '没有可导入的条目' };
    }
    return { ok: true, value: { data, rows } };
}

/**
 * @param {object} data
 * @param {string} expectedKind
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function assertImportKind(data, expectedKind) {
    // 画师串（需求 4.2）：裸 JSON 数组，无信封
    if (Array.isArray(data)) {
        if (expectedKind === 'artist') {
            return { ok: true };
        }
        return {
            ok: false,
            error: '导入必须是带 kind 的信封对象，不接受裸数组',
        };
    }
    if (!data || typeof data !== 'object') {
        return { ok: false, error: '导入数据无效' };
    }
    const kind = /** @type {{ kind?: unknown }} */ (data).kind;
    if (kind == null || kind === '') {
        return { ok: false, error: '导入信封缺少 kind 字段' };
    }
    if (String(kind) !== expectedKind) {
        return {
            ok: false,
            error: `导入类型不匹配：期望 ${expectedKind}，实际 ${String(kind)}`,
        };
    }
    return { ok: true };
}

/**
 * D45：表单字段叠到原实体上；未展示字段原样保留。
 * @param {object|null|undefined} original
 * @param {Record<string, unknown>} formFields
 * @returns {Record<string, unknown>}
 */
export function applyFormFields(original, formFields) {
    const base = original && typeof original === 'object' && !Array.isArray(original)
        ? { ...original }
        : {};
    const patch = formFields && typeof formFields === 'object' ? formFields : {};
    return { ...base, ...patch };
}

/**
 * 预设 prompt 段：只覆盖表单编辑的键，保留 injection_* 等未展示字段。
 * @param {object|null|undefined} original
 * @param {object} formFields
 * @returns {object}
 */
export function mergePresetPrompt(original, formFields) {
    return applyFormFields(original, {
        identifier: formFields.identifier,
        name: formFields.name,
        role: formFields.role,
        content: formFields.content,
        enabled: formFields.enabled,
        workbenchOnly: formFields.workbenchOnly === true,
    });
}

/**
 * 筛选/排序后按 id 取删除目标（禁止用可见列表下标当库下标）。
 * @param {object[]} allItems
 * @param {string[]} selectedIds
 * @returns {string[]}
 */
export function resolveDeleteIdsByIdentity(allItems, selectedIds) {
    const want = new Set((selectedIds || []).map((id) => String(id)));
    const known = new Set(
        (allItems || [])
            .filter((item) => item && item.id != null)
            .map((item) => String(item.id)),
    );
    /** @type {string[]} */
    const out = [];
    for (const id of want) {
        if (known.has(id)) out.push(id);
    }
    return out;
}

/**
 * 导出→导入往返：深克隆 JSON 信封，供测「不失真」。
 * @param {object} envelope
 * @returns {object}
 */
export function roundTripJson(envelope) {
    return JSON.parse(JSON.stringify(envelope));
}

/**
 * 封面 URL 门禁（面板侧统一入口，内部仍走 safeImageUrl）。
 * @param {unknown} url
 * @returns {string|null}
 */
export function gateCoverUrl(url) {
    return safeImageUrl(url);
}

/**
 * 从「正在编辑的画师串」构造预览入参（D9）。
 * 绝不用 settings.activeArtistId；尺寸只用 ARTIST_PREVIEW_SIZE。
 *
 * @param {object} editingArtist 表单中的那一条（须有 id）
 * @param {object} opts
 * @param {string} opts.promptText
 * @param {string} [opts.negativeText]
 * @param {boolean} [opts.saveAsPreview]
 * @param {string|null|undefined} [opts.activeArtistId] 仅用于断言对照，不得写入返回值
 * @returns {{
 *   artistId: string,
 *   promptText: string,
 *   negativeText?: string,
 *   saveAsPreview: boolean,
 *   previewSize: { width: number, height: number },
 * }}
 */
export function buildArtistPreviewRequest(editingArtist, opts) {
    if (!editingArtist || typeof editingArtist !== 'object' || editingArtist.id == null || editingArtist.id === '') {
        throw new Error('invalid argument: editingArtist.id');
    }
    const artistId = String(editingArtist.id);
    // 故意对照：即使传入 activeArtistId 也绝不采用
    void opts?.activeArtistId;
    /** @type {{ artistId: string, promptText: string, negativeText?: string, saveAsPreview: boolean, previewSize: { width: number, height: number } }} */
    const req = {
        artistId,
        promptText: String(opts?.promptText ?? ''),
        saveAsPreview: opts?.saveAsPreview !== false,
        previewSize: {
            width: ARTIST_PREVIEW_SIZE.width,
            height: ARTIST_PREVIEW_SIZE.height,
        },
    };
    if (opts?.negativeText != null) {
        req.negativeText = String(opts.negativeText);
    }
    return req;
}

/** 画师串预览图的正负面。不进插件设置（D8 键名已冻结），只记在本机。 */
export const ARTIST_PREVIEW_PROMPT_KEY = 'nai-dbgen:artist-preview-prompts';

/**
 * @returns {Storage|null}
 */
function browserStorage() {
    try {
        return typeof localStorage !== 'undefined' ? localStorage : null;
    } catch {
        return null;
    }
}

/**
 * @param {Storage|null|undefined} [storage]
 * @returns {{ promptText: string, negativeText: string }}
 */
export function readArtistPreviewPrompts(storage) {
    const empty = { promptText: '', negativeText: '' };
    const store = storage === undefined ? browserStorage() : storage;
    if (!store || typeof store.getItem !== 'function') return empty;
    try {
        const raw = store.getItem(ARTIST_PREVIEW_PROMPT_KEY);
        if (!raw) return empty;
        const data = JSON.parse(raw);
        return {
            promptText: typeof data?.promptText === 'string' ? data.promptText : '',
            negativeText: typeof data?.negativeText === 'string' ? data.negativeText : '',
        };
    } catch {
        return empty;
    }
}

/**
 * @param {string} promptText
 * @param {string} negativeText
 * @param {Storage|null|undefined} [storage]
 */
export function writeArtistPreviewPrompts(promptText, negativeText, storage) {
    const store = storage === undefined ? browserStorage() : storage;
    if (!store || typeof store.setItem !== 'function') return;
    try {
        store.setItem(ARTIST_PREVIEW_PROMPT_KEY, JSON.stringify({
            promptText: String(promptText ?? ''),
            negativeText: String(negativeText ?? ''),
        }));
    } catch {
        /* 隐私模式或配额满时，这一次打不开也只是不记住 */
    }
}

/**
 * 设置 patch 白名单：只保留 D8 键；嵌套 matchDefaults / naiParams 浅合并形状。
 * @param {unknown} patch
 * @returns {Record<string, unknown>}
 */
export function pickAllowedSettingsPatch(patch) {
    /** @type {Record<string, unknown>} */
    const out = {};
    if (!patch || typeof patch !== 'object') return out;
    const src = /** @type {Record<string, unknown>} */ (patch);
    for (const key of PLUGIN_SETTINGS_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(src, key)) continue;
        if (key === 'matchDefaults' && src.matchDefaults && typeof src.matchDefaults === 'object') {
            /** @type {Record<string, unknown>} */
            const md = {};
            const raw = /** @type {Record<string, unknown>} */ (src.matchDefaults);
            if (typeof raw.caseSensitive === 'boolean') md.caseSensitive = raw.caseSensitive;
            if (typeof raw.matchWholeWords === 'boolean') md.matchWholeWords = raw.matchWholeWords;
            out.matchDefaults = md;
            continue;
        }
        if (key === 'naiParams' && src.naiParams && typeof src.naiParams === 'object') {
            out.naiParams = { .../** @type {object} */ (src.naiParams) };
            continue;
        }
        out[key] = src[key];
    }
    return out;
}

/**
 * @param {Record<string, unknown>} before
 * @param {Record<string, unknown>} after
 * @param {string[]} keys
 * @returns {boolean}
 */
export function settingsKeysUnchanged(before, after, keys) {
    for (const key of keys) {
        if (!Object.is(before?.[key], after?.[key])) return false;
    }
    return true;
}

/**
 * D58：错误展示拼上 hint，告知下一步。
 * @param {unknown} err
 * @param {string} [fallback]
 * @returns {string}
 */
export function formatErrorDisplay(err, fallback = '操作失败') {
    if (err == null) return fallback;
    if (typeof err === 'string') {
        const s = err.trim();
        return s || fallback;
    }
    if (typeof err !== 'object') {
        const s = String(err).trim();
        return s || fallback;
    }
    const rec = /** @type {{ message?: unknown, hint?: unknown }} */ (err);
    const message = rec.message != null && String(rec.message).trim() !== ''
        ? String(rec.message).trim()
        : fallback;
    const hint = rec.hint != null && String(rec.hint).trim() !== ''
        ? String(rec.hint).trim()
        : '';
    if (hint) return `${message}（${hint}）`;
    return message;
}

/**
 * D55：付费请求进行中不得再提交。
 * @param {boolean} busy
 * @returns {boolean}
 */
export function canSubmitPaidAction(busy) {
    return busy !== true;
}

/**
 * @param {'artistPreview'} kind
 * @returns {{ idle: string, busy: string }}
 */
export function paidActionLabels(kind) {
    if (kind === 'artistPreview') {
        return { idle: '预览出图', busy: '出图中…' };
    }
    return { idle: '提交', busy: '进行中…' };
}
