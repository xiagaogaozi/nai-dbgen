/**
 * L5 UI · 生成工作台（需求 4.15）：写提示词与出图解耦。
 * 归属：W2-I 工作台代理实现。
 *
 * 裁决 D13：提示词状态为 NaiCaption（base 文本域 + 角色分镜可增删列表）。
 * 写出走 workbenchService.writePrompt → NaiCaption；
 * 出图走 generateImage({ caption: NaiCaption, replaceCharacterKeywords, … })。
 *
 * 只导出 mountWorkbench，由 W3 装配接线；不改 panels/drawer shell。
 */

import {
    createButton,
    createField,
    createSelect,
    createMiniAction,
    createToggle,
    createCheckbox,
    createFieldGroup,
    createDetails,
    createInlineError,
    createStatusPill,
} from '../common/controls.js';
import { createNaiParamsForm } from '../common/nai-params-form.js';
import { mountCurrentPicker } from '../common/current-picker.js';
import { openModal } from '../common/modal.js';
import { downloadJson } from '../common/import-export.js';
import { confirmDanger, openImportExportModal } from '../panels/_lib/panel-kit.js';
import { validateMarketCatalog } from '../../adapters/storage/market-catalog.store.js';
import {
    parsePromptText,
} from '../common/prompt-text.js';
import { openSlotImageViewer } from '../common/image-viewer.js';
import { detectImageMime, imageExtension, requestImageDownload } from '../common/image-download.js';
import { emptyNaiCaption } from '../../domain/model/nai-params.js';
import { createCharacter } from '../../domain/model/character.js';
import { newId } from '../../infra/id.js';
import { nowIso } from '../../infra/clock.js';
import { parseCharacterFeatures, formatCharacterFeatures } from '../common/character-features.js';
import { defaultImg2ImgNoise, defaultImg2ImgStrength } from '../../domain/nai/img2img.js';
import { normalizeTagLibraryKind } from '../../domain/model/tag.js';
import { parseCompositionKey } from '../../domain/model/composition-key.js';
import { mountCaptionEditor } from './caption-editor.js';
import { createPromptTextarea, linkTextareaHeights } from '../common/prompt-textarea.js';
import { bindDebouncedInput } from '../common/debounced-input.js';
import { createArtistModelTagChecks } from '../common/artist-model-tags.js';
import {
    artistModelTagForModel,
    followModelForArtistTag,
} from '../../domain/model/plugin-settings.js';
import { resolveArtistModelTag } from '../../domain/model/artist.js';
import {
    WORKBENCH_MAX_CHARACTERS,
    buildWritePromptInput,
    buildGenerateImageInput,
    createDecoupledWorkbenchApi,
    resolveSessionParams,
    formatUnmatchedKeys,
    isWorkbenchAbort,
    workbenchErrorMessage,
    canSubmitGenerate,
    gatePreviewUrl,
    previewUrlFromImage,
    resolvePasteArtistAction,
} from './workbench-logic.js';

const WORKBENCH_DRAFT_KEY = 'nai-dbgen:workbench-draft';
const MARKET_EXPANDED_KEY = 'nai-dbgen:market-expanded';
const WORKBENCH_HISTORY_LIMIT = 50;

/**
 * @returns {Record<string, unknown>|null}
 */
function readWorkbenchDraft() {
    try {
        if (typeof localStorage === 'undefined') return null;
        const raw = localStorage.getItem(WORKBENCH_DRAFT_KEY);
        if (!raw) return null;
        const data = JSON.parse(raw);
        return data && typeof data === 'object' ? data : null;
    } catch {
        return null;
    }
}

/**
 * @param {Record<string, unknown>} data
 */
function writeWorkbenchDraft(data) {
    try {
        if (typeof localStorage === 'undefined') return;
        localStorage.setItem(WORKBENCH_DRAFT_KEY, JSON.stringify(data));
    } catch {
        /* 隐私模式或配额满时，这一次打不开也只是不记住 */
    }
}

/**
 * @param {string} tag
 * @param {string} [className]
 * @returns {HTMLElement}
 */
function el(tag, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
}

/**
 * @param {HTMLElement} node
 * @param {string} text
 */
function setText(node, text) {
    node.textContent = text == null ? '' : String(text);
}

/**
 * @param {object} [host]
 * @param {'info'|'success'|'warning'|'error'} level
 * @param {string} message
 */
function toast(host, level, message) {
    if (host && typeof host.toast === 'function') {
        host.toast(level, message);
    }
}

const REDRAW_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * @param {string} labelText
 * @param {number} value
 * @param {number} min
 * @param {number} max
 */
function redrawNumberField(labelText, value, min, max) {
    const field = el('label', 'nd-wb-redraw__field');
    const label = el('span', 'nd-field__label');
    setText(label, labelText);
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'nd-input';
    input.min = String(min);
    input.max = String(max);
    input.step = '0.05';
    input.value = String(value);
    field.append(label, input);
    return { el: field, input };
}

/**
 * @param {object} host
 * @returns {Promise<string|null>}
 */
async function readRedrawImage(host) {
    const file = await pickRedrawImage();
    if (!file) return null;
    if (file.size > REDRAW_IMAGE_BYTES) {
        toast(host, 'warning', '图片超过 8MB，请换一张小一点的');
        return null;
    }
    if (file.type && !file.type.startsWith('image/')) {
        toast(host, 'warning', '请选择图片文件');
        return null;
    }
    try {
        const dataUrl = await readFileDataUrl(file);
        if (!dataUrl.startsWith('data:image/')) {
            toast(host, 'warning', '这张图读不出来');
            return null;
        }
        return dataUrl;
    } catch {
        toast(host, 'error', '读取图片失败');
        return null;
    }
}

/**
 * @returns {Promise<File|null>}
 */
function pickRedrawImage() {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/png,image/jpeg,image/webp,image/gif';
        let settled = false;
        const finish = (file) => {
            if (settled) return;
            settled = true;
            resolve(file);
        };
        input.addEventListener('change', () => {
            finish(input.files && input.files[0] ? input.files[0] : null);
        });
        input.addEventListener('cancel', () => finish(null));
        input.click();
    });
}

/**
 * @param {Blob} file
 * @returns {Promise<string>}
 */
/**
 * 图生图的图必须和本次宽高一样大，原比例放进画布，空处铺白，输出 PNG。
 * @param {string} dataUrl
 * @param {number} width
 * @param {number} height
 * @returns {Promise<string>}
 */
function fitImg2ImgCanvas(dataUrl, width, height) {
    const w = Math.max(64, Math.round(Number(width) / 64) * 64);
    const h = Math.max(64, Math.round(Number(height) / 64) * 64);
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d', { alpha: false });
            if (!ctx) {
                reject(new Error('canvas'));
                return;
            }
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, w, h);
            const naturalWidth = image.naturalWidth || image.width;
            const naturalHeight = image.naturalHeight || image.height;
            const ratio = Math.min(w / naturalWidth, h / naturalHeight);
            const drawWidth = naturalWidth * ratio;
            const drawHeight = naturalHeight * ratio;
            ctx.drawImage(
                image,
                (w - drawWidth) / 2,
                (h - drawHeight) / 2,
                drawWidth,
                drawHeight,
            );
            resolve(canvas.toDataURL('image/png'));
        };
        image.onerror = () => reject(new Error('image'));
        image.src = dataUrl;
    });
}

function readFileDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error || new Error('read failed'));
        reader.readAsDataURL(file);
    });
}

/**
 * @param {object} deps
 * @returns {{ writePrompt: Function, generateImage: Function }}
 */
function resolveWorkbenchService(deps) {
    if (deps?.workbenchService
        && typeof deps.workbenchService.writePrompt === 'function') {
        return deps.workbenchService;
    }
    if (deps?.workbench && typeof deps.workbench.writePrompt === 'function') {
        return deps.workbench;
    }
    throw new Error('mountWorkbench: missing workbenchService');
}

/**
 * @param {Element} root
 * @param {object} deps 含 workbenchService / tagRepo / host / loadSettings
 * @param {object} [deps.artistFileUrl] 与抽屉共用的画师串封面解析器
 * @param {(fn: () => void) => () => void} [deps.subscribeSettings]
 * @returns {{ destroy: () => void }}
 */
export function mountWorkbench(root, deps) {
    if (!(root instanceof Element)) {
        throw new Error('mountWorkbench: root must be an Element');
    }

    const host = deps?.host;
    const reportCopyError = () => toast(host, 'error', '复制提示词失败，请检查剪贴板权限');
    const service = createDecoupledWorkbenchApi(resolveWorkbenchService(deps));
    const loadSettings = typeof deps?.loadSettings === 'function'
        ? deps.loadSettings
        : () => (host && typeof host.loadSettings === 'function' ? host.loadSettings() : {});
    const artistRepo = deps?.artistRepo
        || deps?.repos?.artist
        || null;
    let destroyed = false;
    /** @type {Array<() => void>} */
    const artistCleanups = [];

    const draft = readWorkbenchDraft();
    // undefined follows global until the workbench chooses; null explicitly disables artist tags.
    let artistOverrideId = typeof draft?.artistOverrideId === 'string'
        ? draft.artistOverrideId : draft?.artistOverrideId === null ? null : undefined;
    const manualTags = new Map(Array.isArray(draft?.manualTags)
        ? draft.manualTags.filter((item) => item?.id && item?.target && item?.value && item?.fragment)
            .map((item) => [String(item.id), item]) : []);
    const hasSavedArtistPositivePrompt = typeof draft?.artistPositivePrompt === 'string';
    const hasSavedArtistNegativePrompt = typeof draft?.artistNegativePrompt === 'string';
    let artistSelectionRequest = 0;
    /** @type {Promise<object|null>} */
    let artistSelectionReady = Promise.resolve(null);
    let artistPositiveEditRevision = 0;
    let artistNegativeEditRevision = 0;
    /** @type {{ el: HTMLElement, input: HTMLTextAreaElement, getValue: () => string, setValue: (value: unknown) => void }|null} */
    let artistPositiveField = null;
    /** @type {{ el: HTMLElement, input: HTMLTextAreaElement, getValue: () => string, setValue: (value: unknown) => void }|null} */
    let artistNegativeField = null;
    let unlinkArtistResize = () => {};
    /** @type {HTMLButtonElement|null} */
    let saveCurrentArtistBtn = null;
    /** @type {HTMLButtonElement|null} */
    let replacePreviewBtn = null;
    let replacingPreview = false;
    /** @type {Blob|null} */
    let currentPreviewBlob = null;
    let marketCatalog = null;
    let marketLoadToken = 0;
    let marketExpanded = false;
    try { marketExpanded = globalThis.localStorage?.getItem(MARKET_EXPANDED_KEY) === 'true'; } catch { /* 默认折叠 */ }
    let marketEnabled = loadSettings()?.enableTagMarket === true;
    let syncArtistSettings = () => {};
    let marketSignature = typeof draft?.marketSignature === 'string' ? draft.marketSignature : '';
    let marketPath = [];
    let marketImportHandle = null;
    const sessionParams = resolveSessionParams(
        draft?.naiParams ? { naiParams: draft.naiParams } : loadSettings(),
    );

    const shell = el('div', 'nd-workbench');
    const writeErr = createInlineError();
    const genErr = createInlineError();
    const unmatchedEl = el('div', 'nd-wb-unmatched');
    unmatchedEl.setAttribute('role', 'status');
    unmatchedEl.setAttribute('aria-live', 'polite');
    unmatchedEl.hidden = true;

    const statusPill = createStatusPill({ label: '空闲', status: 'idle' });

    // ── 写提示词区（独立；绝不调 generateImage）────────────────
    const nlField = (() => {
        const wrap = el('label', 'nd-field');
        const label = el('span', 'nd-field__label nd-wb-tertiary-label');
        setText(label, '自然语言');
        /** @type {HTMLTextAreaElement} */
        const ta = /** @type {HTMLTextAreaElement} */ (el('textarea', 'nd-textarea'));
        ta.rows = 4;
        ta.placeholder = '描述想要的画面';
        wrap.append(label, ta);
        if (typeof draft?.naturalLanguage === 'string') {
            ta.value = draft.naturalLanguage;
        }
        return {
            el: wrap,
            getValue: () => ta.value,
            setValue: (v) => { ta.value = v == null ? '' : String(v); },
            destroy: () => { wrap.remove(); },
        };
    })();

    const floorToggle = createToggle({
        label: '楼内流程',
        hint: '从当前这一楼里按你的拍摄要求只画一帧，再交给生图预设，结果填回这里',
        checked: draft?.floorMode === true,
        onChange: (on) => {
            libBox.hidden = on;
        },
    });

    // This switch is presented with prompt-writing options but still affects generation only.
    const replaceToggle = createToggle({
        label: '替换角色关键词',
        hint: '把提示词里的角色关键字换成该角色固定特征后再出图',
        checked: draft?.replaceCharacterKeywords === true,
    });

    const libBox = el('div', 'nd-wb-libraries');
    if (draft?.floorMode === true) {
        libBox.hidden = true;
    }
    const libTitle = el('span', 'nd-field__label nd-wb-tertiary-label');
    setText(libTitle, '本次使用的条目');
    const libHint = el('p', 'nd-muted');
    setText(libHint, '只发送勾中的条目。勾库或分类会选中其下全部条目。');
    const searchWrap = el('div', 'nd-search-field nd-wb-lib-search');
    const searchInput = /** @type {HTMLInputElement} */ (el('input'));
    searchInput.type = 'search';
    searchInput.placeholder = '搜索名称或正文';
    searchInput.setAttribute('aria-label', '搜索名称或正文');
    searchInput.autocomplete = 'off';
    searchWrap.appendChild(searchInput);
    let onlyPicked = false;
    const onlyPickedBox = createCheckbox({
        label: '只看已勾选',
        checked: false,
        onChange: (on) => {
            onlyPicked = on;
            applyEntryFilter();
        },
    });
    const filterRow = el('div', 'nd-wb-lib-tools');
    filterRow.append(searchWrap, onlyPickedBox.el);
    const searchEmpty = el('p', 'nd-muted nd-wb-lib-empty');
    setText(searchEmpty, '没有匹配的条目');
    searchEmpty.hidden = true;
    const libList = el('div', 'nd-wb-lib-list');
    libBox.append(libTitle, libHint, filterRow, searchEmpty, libList);
    /** @type {{ id: string, entryIds: string[] }[]} */
    const libGroups = [];
    /** @type {Map<string, boolean>} */
    const picked = new Map();
    /** @type {Array<{ destroy: () => void }>} */
    const libControls = [];
    libControls.push(onlyPickedBox);

    /**
     * @param {ReturnType<typeof createCheckbox>} control
     * @param {boolean} on
     * @param {boolean} partial
     */
    function paintCheck(control, on, partial) {
        control.setValue(on && !partial);
        const input = control.el.querySelector('input');
        if (input) input.indeterminate = partial;
    }

    /**
     * @param {string[]} ids
     */
    function countPicked(ids) {
        let n = 0;
        for (const id of ids) {
            if (picked.get(id) === true) n += 1;
        }
        return n;
    }

    function syncGroupChecks() {
        for (const group of libGroups) {
            const n = countPicked(group.entryIds);
            const total = group.entryIds.length;
            paintCheck(group.control, total > 0 && n === total, n > 0 && n < total);
            setText(group.count, total ? `${n}/${total}` : '0');
            for (const cat of group.categories) {
                const cn = countPicked(cat.entryIds);
                const ct = cat.entryIds.length;
                paintCheck(cat.control, ct > 0 && cn === ct, cn > 0 && cn < ct);
                setText(cat.count, ct ? `${cn}/${ct}` : '0');
            }
            for (const row of group.rows) {
                row.control.setValue(picked.get(row.id) === true);
            }
        }
    }

    /**
     * @param {string[]} ids
     * @param {boolean} on
     */
    function setPicked(ids, on) {
        for (const id of ids) {
            picked.set(id, on);
        }
        syncGroupChecks();
        if (onlyPicked) applyEntryFilter();
    }

    /**
     * @param {object[]} entries
     * @param {string} kind
     * @returns {{ title: string, entries: object[] }[]}
     */
    function groupEntries(entries, kind) {
        if (kind !== 'composition') {
            return [{ title: '', entries }];
        }
        /** @type {Map<string, object[]>} */
        const map = new Map();
        for (const entry of entries) {
            const parsed = parseCompositionKey(entry?.key);
            const title = parsed.ok ? parsed.value.category : '未分类';
            if (!map.has(title)) map.set(title, []);
            map.get(title).push(entry);
        }
        return [...map.entries()].map(([title, list]) => ({ title, entries: list }));
    }

    /**
     * @param {object} entry
     * @param {string} kind
     * @returns {string}
     */
    function entryLabel(entry, kind) {
        const key = String(entry?.key ?? entry?.id ?? '');
        let label = key;
        if (kind === 'composition') {
            const parsed = parseCompositionKey(key);
            if (parsed.ok) label = parsed.value.name;
        }
        return entry?.active === false ? `${label}（已关闭）` : label;
    }

    /**
     * @param {object} entry
     * @param {string} kind
     * @returns {string}
     */
    function entryHaystack(entry, kind) {
        return [
            entryLabel(entry, kind),
            entry?.key,
            entry?.value,
            entry?.secondaryKey,
        ].map((part) => String(part ?? '')).join('\n').toLowerCase();
    }

    /**
     * @param {HTMLElement} body
     * @param {HTMLElement} toggle
     * @param {boolean} open
     */
    function setSectionOpen(body, toggle, open) {
        body.hidden = !open;
        paintChevron(toggle, open);
    }

    /**
     * 0.2.48：展开/收起改用 chevron 图标，文字留在 aria-label / title。
     * @param {HTMLElement} toggle
     * @param {boolean} open
     */
    function paintChevron(toggle, open) {
        const icon = document.createElement('i');
        icon.className = `fa-solid ${open ? 'fa-chevron-up' : 'fa-chevron-down'}`;
        icon.setAttribute('aria-hidden', 'true');
        toggle.replaceChildren(icon);
        const text = open ? '收起' : '展开';
        toggle.setAttribute('aria-label', text);
        toggle.title = text;
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    /**
     * @param {HTMLElement} host
     * @param {object[]} entries
     * @param {string} kind
     * @param {{ rows: { id: string, control: ReturnType<typeof createCheckbox> }[] }} bucket
     */
    function paintEntries(host, entries, kind, bucket) {
        host.replaceChildren();
        for (const entry of entries) {
            if (!entry || entry.id == null) continue;
            const id = String(entry.id);
            const control = createCheckbox({
                label: entryLabel(entry, kind),
                checked: picked.get(id) === true,
                onChange: (on) => {
                    picked.set(id, on);
                    syncGroupChecks();
                    if (onlyPicked) applyEntryFilter();
                },
            });
            libControls.push(control);
            const wrap = el('div', 'nd-wb-entry');
            wrap.appendChild(control.el);
            const value = String(entry?.value ?? '').trim();
            if (value) {
                const body = el('div', 'nd-wb-entry__value');
                setText(body, value);
                wrap.appendChild(body);
            }
            const row = { id, control, el: wrap, haystack: entryHaystack(entry, kind) };
            bucket.rows.push(row);
            if (Array.isArray(bucket.local)) bucket.local.push(row);
            host.appendChild(wrap);
        }
    }

    async function loadLibraries() {
        const tagRepo = deps?.tagRepo;
        if (!tagRepo || typeof tagRepo.listLibraries !== 'function') return;
        let libraries = [];
        try {
            const r = await tagRepo.listLibraries();
            if (r?.ok && Array.isArray(r.value)) libraries = r.value;
        } catch {
            return;
        }
        for (const lib of libraries) {
            if (!lib || lib.id == null) continue;
            const kind = normalizeTagLibraryKind(lib.kind);
            const kindText = kind === 'feature' ? '特征库' : kind === 'constant' ? '常驻库' : '构图库';
            /** @type {object[]} */
            let entries = [];
            if (typeof tagRepo.listEntries === 'function') {
                try {
                    const er = await tagRepo.listEntries(lib.id);
                    if (er?.ok && Array.isArray(er.value)) entries = er.value.filter((entry) => entry && entry.id != null);
                } catch {
                    entries = [];
                }
            }
            for (const entry of entries) picked.set(String(entry.id), false);

            const entryIds = entries.map((entry) => String(entry.id));
            const head = el('div', 'nd-wb-lib__head');
            const control = createCheckbox({
                label: `${String(lib.name || lib.id)}（${kindText}）`,
                checked: false,
                onChange: (on) => setPicked(entryIds, on),
            });
            libControls.push(control);
            const count = el('span', 'nd-muted');
            setText(count, entryIds.length ? `0/${entryIds.length}` : '0');
            head.append(control.el, count);

            const body = el('div', 'nd-wb-lib__body');
            body.hidden = true;
            /** @type {{ title: string, entryIds: string[], entries: object[], kind: string, control: ReturnType<typeof createCheckbox>, count: HTMLElement, head: HTMLElement, body: HTMLElement, toggle: HTMLElement, rows: { id: string, control: ReturnType<typeof createCheckbox>, haystack: string }[], painted: boolean, userOpen: boolean }[]} */
            const categories = [];
            /** @type {{ id: string, control: ReturnType<typeof createCheckbox>, haystack: string }[]} */
            const rows = [];
            /** @type {{ id: string, control: ReturnType<typeof createCheckbox>, haystack: string }[]} */
            const looseRows = [];
            const grouped = groupEntries(entries, kind);
            for (const cat of grouped) {
                const catIds = cat.entries.map((entry) => String(entry.id));
                if (!cat.title) {
                    paintEntries(body, cat.entries, kind, { rows, local: looseRows });
                    continue;
                }
                const catHead = el('div', 'nd-wb-cat__head');
                const catControl = createCheckbox({
                    label: cat.title,
                    checked: false,
                    onChange: (on) => setPicked(catIds, on),
                });
                libControls.push(catControl);
                const catCount = el('span', 'nd-muted');
                setText(catCount, catIds.length ? `0/${catIds.length}` : '0');
                const catBody = el('div', 'nd-wb-cat__body');
                catBody.hidden = true;
                /** @type {{ title: string, entryIds: string[], entries: object[], kind: string, control: ReturnType<typeof createCheckbox>, count: HTMLElement, head: HTMLElement, body: HTMLElement, toggle: HTMLElement, rows: { id: string, control: ReturnType<typeof createCheckbox>, haystack: string }[], painted: boolean, userOpen: boolean }} */
                const catState = {
                    title: cat.title,
                    entryIds: catIds,
                    entries: cat.entries,
                    kind,
                    control: catControl,
                    count: catCount,
                    head: catHead,
                    body: catBody,
                    toggle: /** @type {HTMLElement} */ (document.createElement('button')),
                    rows: [],
                    painted: false,
                    userOpen: false,
                };
                const toggle = createMiniAction({
                    label: '展开',
                    onClick: () => {
                        catState.userOpen = catState.body.hidden;
                        if (catState.userOpen) paintCategory(catState);
                        if (onlyPicked || !String(searchInput.value || '').trim()) {
                            applyEntryFilter();
                            return;
                        }
                        setSectionOpen(catState.body, catState.toggle, catState.userOpen);
                    },
                });
                paintChevron(toggle, false);
                catState.toggle = toggle;
                catHead.append(catControl.el, catCount, toggle);
                body.append(catHead, catBody);
                categories.push(catState);
            }

            const libToggle = createMiniAction({
                label: '展开',
                onClick: () => {
                    const group = libGroups.find((item) => item.body === body);
                    if (!group) return;
                    group.userOpen = group.body.hidden;
                    if (onlyPicked || !String(searchInput.value || '').trim()) {
                        applyEntryFilter();
                        return;
                    }
                    setSectionOpen(group.body, group.toggle, group.userOpen);
                },
            });
            paintChevron(libToggle, false);
            head.appendChild(libToggle);
            const block = el('div', 'nd-wb-lib');
            block.append(head, body);
            libList.appendChild(block);
            libGroups.push({
                id: String(lib.id),
                haystack: `${String(lib.name || lib.id)} ${kindText}`.toLowerCase(),
                entryIds,
                control,
                count,
                categories,
                rows,
                looseRows,
                block,
                body,
                toggle: libToggle,
                userOpen: false,
            });
        }
        if (Array.isArray(draft?.entryIds) && draft.entryIds.length) {
            setPicked(draft.entryIds.map((id) => String(id)), true);
        }
        applyEntryFilter();
        renderMarket();
    }

    /**
     * @param {{ body: HTMLElement, entries: object[], kind: string, rows: { id: string, control: ReturnType<typeof createCheckbox>, haystack: string }[], painted: boolean }} cat
     */
    function paintCategory(cat) {
        if (cat.painted) return;
        cat.painted = true;
        const group = libGroups.find((item) => item.categories.includes(cat));
        paintEntries(cat.body, cat.entries, cat.kind, {
            rows: group ? group.rows : cat.rows,
            local: cat.rows,
        });
    }

    /**
     * @param {string} haystack
     * @param {string} q
     * @param {boolean} libHit
     * @param {boolean} titleHit
     * @returns {boolean}
     */
    function textMatches(haystack, q, libHit, titleHit) {
        if (!q) return true;
        if (libHit || titleHit) return true;
        return haystack.includes(q);
    }

    /**
     * @param {string} id
     * @param {string} haystack
     * @param {string} q
     * @param {boolean} libHit
     * @param {boolean} titleHit
     * @returns {boolean}
     */
    function rowShown(id, haystack, q, libHit, titleHit) {
        if (onlyPicked && picked.get(id) !== true) return false;
        return textMatches(haystack, q, libHit, titleHit);
    }

    /**
     * 搜索会展开命中的库和分类。「只看已勾选」只藏未勾选的条目，展开状态保持原样，可以再收起。
     */
    function applyEntryFilter() {
        const q = String(searchInput.value || '').trim().toLowerCase();
        const filtering = Boolean(q) || onlyPicked;
        const forceOpen = Boolean(q) && !onlyPicked;
        let anyVisible = !filtering;
        for (const group of libGroups) {
            const libHit = Boolean(q) && group.haystack.includes(q);
            let groupVisible = false;
            for (const row of group.looseRows) {
                const hit = rowShown(row.id, row.haystack, q, libHit, false);
                (row.el || row.control.el).hidden = !hit;
                if (hit) groupVisible = true;
            }
            for (const cat of group.categories) {
                const titleHit = Boolean(q) && cat.title.toLowerCase().includes(q);
                const hasMatch = cat.entries.some((entry) => rowShown(
                    String(entry.id),
                    entryHaystack(entry, cat.kind),
                    q,
                    libHit,
                    titleHit,
                ));
                if (hasMatch && (forceOpen || cat.userOpen)) paintCategory(cat);
                let catVisible = hasMatch || !filtering;
                if (cat.painted) {
                    catVisible = false;
                    for (const row of cat.rows) {
                        const hit = rowShown(row.id, row.haystack, q, libHit, titleHit);
                        (row.el || row.control.el).hidden = !hit;
                        if (hit) catVisible = true;
                    }
                }
                if (cat.head) cat.head.hidden = filtering && !catVisible;
                setSectionOpen(cat.body, cat.toggle, forceOpen ? catVisible : cat.userOpen);
                if (catVisible) groupVisible = true;
            }
            group.block.hidden = filtering && !groupVisible;
            setSectionOpen(group.body, group.toggle, forceOpen ? groupVisible : group.userOpen);
            if (groupVisible) anyVisible = true;
        }
        setText(searchEmpty, onlyPicked && !q ? '没有已勾选的条目' : '没有匹配的条目');
        searchEmpty.hidden = !filtering || anyVisible || libGroups.length === 0;
    }
    const entrySearchDebounce = bindDebouncedInput(searchInput, applyEntryFilter);

    /** @type {AbortController|null} */
    let writeAbort = null;
    /** @type {boolean} */
    let writing = false;

    const writeBtn = createButton({
        label: '写提示词',
        variant: 'primary',
        onClick: () => { void onWritePrompt(); },
    });
    const writeCancelBtn = createButton({
        label: '取消',
        variant: 'ghost',
        onClick: () => {
            if (writeAbort) writeAbort.abort();
        },
    });
    writeCancelBtn.disabled = true;

    // ── Caption 编辑器（手填 / 自动生成共用同一结构）────────────
    const captionMount = el('div', 'nd-wb-caption-mount');
    const captionEditor = mountCaptionEditor(captionMount, {
        initial: draft?.caption && typeof draft.caption === 'object'
            ? draft.caption
            : emptyNaiCaption(),
        onCopyError: reportCopyError,
        onSaveCharacter: (mode, prompts) => { void openCharacterSaveModal(mode, prompts); },
        onImportCharacter: () => { void openCharacterImportModal(); },
        onCharacterRemove: (removedIndex) => {
            for (const [id, record] of manualTags) {
                const match = /^character\.(\d+)\.(positive|negative)$/.exec(record.target);
                if (!match) continue;
                const index = Number(match[1]);
                if (index === removedIndex) {
                    manualTags.delete(id);
                } else if (index > removedIndex) {
                    manualTags.set(id, { ...record, target: `character.${index - 1}.${match[2]}` });
                }
            }
            reconcileManualTags();
            persistWorkbenchDraft();
        },
    });

    floorToggle.el.querySelector('.nd-toggle-row__text > strong')?.classList.add('nd-wb-tertiary-label');
    replaceToggle.el.querySelector('.nd-toggle-row__text > strong')?.classList.add('nd-wb-tertiary-label');

    const artistSlot = el('div', 'nd-wb-artist-slot');
    const market = el('section', 'nd-wb-market');
    const marketHeader = el('div', 'nd-wb-market__header');
    const marketTitle = el('button', 'nd-wb-market__title');
    marketTitle.type = 'button';
    setText(marketTitle, '标签超市');
    marketTitle.setAttribute('aria-expanded', marketExpanded ? 'true' : 'false');
    marketTitle.addEventListener('click', () => {
        marketExpanded = !marketExpanded;
        try { globalThis.localStorage?.setItem(MARKET_EXPANDED_KEY, String(marketExpanded)); } catch { /* 本地存储不可用时只保留本次状态 */ }
        applyMarketVisibility();
    });
    const marketActions = el('div', 'nd-wb-market__actions');
    const marketImportBtn = createButton({
        label: '导入',
        variant: 'ghost',
        onClick: () => { void openMarketImport(); },
    });
    const marketExportBtn = createButton({
        label: '导出',
        variant: 'ghost',
        onClick: () => { void exportMarket(); },
    });
    const marketClearBtn = createButton({
        label: '清空',
        variant: 'danger',
        onClick: () => { void clearMarket(); },
    });
    marketActions.append(marketImportBtn, marketExportBtn, marketClearBtn);
    marketHeader.append(marketTitle, marketActions);
    // 0.2.49：和其他搜索框一样包一层 .nd-search-field，input 不带类名
    const marketSearchWrap = el('div', 'nd-search-field');
    const marketSearch = /** @type {HTMLInputElement} */ (el('input'));
    marketSearch.type = 'search';
    marketSearch.autocomplete = 'off';
    marketSearchWrap.appendChild(marketSearch);
    marketSearch.placeholder = '搜索标签名称或内容';
    marketSearch.setAttribute('aria-label', '搜索标签');
    const marketCategories = el('div', 'nd-wb-market__categories');
    marketCategories.setAttribute('aria-label', '标签分类导航');
    const marketGrid = el('div', 'nd-wb-market__grid');
    const marketEmpty = el('div', 'nd-empty-lab nd-wb-market__empty');
    marketEmpty.hidden = true;
    const marketBody = el('div', 'nd-wb-market__body');
    marketBody.append(marketSearchWrap, marketCategories, marketGrid, marketEmpty);
    market.append(marketHeader, marketBody);
    market.hidden = !marketEnabled;
    marketBody.hidden = !marketExpanded;
    marketActions.hidden = !marketExpanded;
    // Prevent the tag button from taking focus away before the focused caption/caret is read.
    marketGrid.addEventListener('pointerdown', (event) => {
        if (event.target.closest?.('.nd-wb-market__tag')) event.preventDefault();
    });
    const marketSearchDebounce = bindDebouncedInput(marketSearch, renderMarket);

    function applyMarketVisibility() {
        market.hidden = !marketEnabled;
        marketTitle.setAttribute('aria-expanded', marketExpanded ? 'true' : 'false');
        marketBody.hidden = !marketExpanded;
        marketActions.hidden = !marketExpanded;
        if (!marketEnabled || !marketExpanded) {
            marketLoadToken += 1;
            marketCatalog = null;
            marketCategories.replaceChildren();
            marketGrid.replaceChildren();
            marketEmpty.hidden = true;
            return;
        }
        void loadMarketCatalog().catch(() => {
            if (!destroyed && marketEnabled && marketExpanded) {
                marketEmpty.hidden = false;
                setText(marketEmpty, '读取标签超市失败');
            }
        });
    }

    function marketSignatureOf(catalog) {
        let hash = 2166136261;
        const text = JSON.stringify({
            libraries: (catalog?.libraries ?? []).map((library) => [library.id, library.name]),
            entries: (catalog?.entries ?? []).map((entry) => [entry.id, entry.libraryId, entry.key, entry.value]),
        });
        for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619) >>> 0;
        return `${catalog?.entries?.length ?? 0}:${hash.toString(16)}`;
    }

    function marketLeafText(entry) {
        const path = String(entry?.key ?? '').split('·').map((part) => part.trim()).filter(Boolean);
        return { categories: path.slice(0, -1), name: path.at(-1) ?? String(entry?.key ?? '') };
    }

    // 场景、角色与画师串共用标签目标映射，避免未识别时误写场景。
    function marketTargetForInput(input) {
        if (input && input === artistPositiveField?.input) return 'artist.positive';
        if (input && input === artistNegativeField?.input) return 'artist.negative';
        return captionEditor.getTargetForInput(input);
    }

    function marketInputForTarget(target) {
        if (target === 'artist.positive') return artistPositiveField?.input || null;
        if (target === 'artist.negative') return artistNegativeField?.input || null;
        return captionEditor.getInputForTarget(target);
    }

    let lastMarketTarget = null;
    function rememberMarketTarget(event) {
        const target = marketTargetForInput(event.target);
        if (target) lastMarketTarget = target;
    }

    function marketSelected(entryId) {
        const record = manualTags.get(String(entryId));
        if (!record) return false;
        const input = marketInputForTarget(record.target);
        return Boolean(input && record.fragment && input.value.includes(record.fragment));
    }

    async function loadMarketCatalog() {
        if (!marketEnabled || !marketExpanded || destroyed) return;
        const request = ++marketLoadToken;
        const store = deps?.marketCatalogStore;
        if (!store || typeof store.load !== 'function') {
            marketCatalog = null;
            renderMarket();
            return;
        }
        const result = await store.load();
        if (destroyed || request !== marketLoadToken || !marketEnabled || !marketExpanded) return;
        if (!result?.ok) {
            marketCatalog = null;
            renderMarket();
            marketEmpty.hidden = false;
            setText(marketEmpty, result?.error?.message || '读取独立标签超市失败');
            return;
        }
        marketCatalog = result.value;
        const nextSignature = marketSignatureOf(marketCatalog);
        if (marketSignature && marketSignature !== nextSignature) {
            // A changed catalog invalidates old insert records; keep caption text untouched.
            manualTags.clear();
        }
        marketSignature = nextSignature;
        reconcileManualTags(false);
        renderMarket();
        persistWorkbenchDraft();
    }

    function reconcileManualTags(persist = true) {
        let changed = false;
        for (const [id, record] of manualTags) {
            const input = marketInputForTarget(record.target);
            if (!input || !record.fragment || !input.value.includes(record.fragment)) {
                manualTags.delete(id);
                changed = true;
            }
        }
        if (changed) renderMarket();
        if (changed && persist) persistWorkbenchDraft();
    }

    function removeManualTag(id) {
        const record = manualTags.get(String(id));
        if (!record) return;
        manualTags.delete(String(id));
        const input = marketInputForTarget(record.target);
        if (input) {
            const first = input.value.indexOf(record.fragment);
            if (first >= 0 && input.value.indexOf(record.fragment, first + 1) < 0) {
                input.value = input.value.slice(0, first) + input.value.slice(first + record.fragment.length);
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }
        renderMarket();
    }

    function reapplyManualTags() {
        let missingTargets = 0;
        for (const [id, record] of [...manualTags]) {
            // 重新生成只替换场景和角色，不重写画师串，不能重复追加已有标签。
            if (String(record.target).startsWith('artist.')) continue;
            const input = marketInputForTarget(record.target);
            const value = String(record.value ?? '').trim();
            if (!input || !value) {
                manualTags.delete(id);
                if (!input) missingTargets += 1;
                continue;
            }
            const prefix = input.value && !/[\s,]$/.test(input.value) ? ', ' : '';
            const fragment = `${prefix}${value}`;
            input.setRangeText(fragment, input.value.length, input.value.length, 'end');
            manualTags.set(id, { ...record, value, fragment });
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        if (missingTargets) {
            toast(host, 'warning', `${missingTargets} 个手动标签的原角色已不存在，未改投场景提示词`);
        }
        renderMarket();
    }

    function insertMarketEntry(entry, input, target) {
        const value = String(entry.value ?? '').trim();
        if (!value) return false;
        const start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? start;
        const before = input.value.slice(0, start);
        const after = input.value.slice(end);
        const prefix = before && !/[\s,]$/.test(before) ? ', ' : '';
        const suffix = after && !/^[\s,]/.test(after) ? ', ' : '';
        const fragment = prefix + value + suffix;
        input.setRangeText(fragment, start, end, 'end');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        manualTags.set(String(entry.id), { id: String(entry.id), target, value, fragment });
        return true;
    }

    function renderMarket() {
        if (!marketEnabled || !marketExpanded || destroyed) return;
        marketCategories.replaceChildren();
        marketGrid.replaceChildren();
        marketEmpty.hidden = true;
        setText(marketEmpty, '');
        if (!marketCatalog) {
            marketEmpty.hidden = false;
            setText(marketEmpty, '请导入规范后的标签超市 JSON');
            return;
        }

        const entries = Array.isArray(marketCatalog.entries) ? marketCatalog.entries : [];
        const parsed = entries.map((entry) => ({ entry, ...marketLeafText(entry) }));
        const query = marketSearch.value.trim().toLowerCase();

        function startsWithPath(categories, path) {
            return path.every((part, index) => categories[index] === part);
        }

        function categoriesAt(depth, prefix) {
            return [...new Set(parsed
                .filter(({ categories }) => startsWithPath(categories, prefix))
                .map(({ categories }) => categories[depth])
                .filter(Boolean))];
        }

        // Clamp stale saved paths to the deepest category that still exists in the loaded catalog.
        const validPath = [];
        for (const part of marketPath) {
            const siblings = categoriesAt(validPath.length, validPath);
            if (!siblings.includes(part)) break;
            validPath.push(part);
        }
        if (validPath.length !== marketPath.length) marketPath = validPath;
        if (!marketPath.length) {
            const firstCategory = categoriesAt(0, [])[0];
            if (firstCategory) marketPath = [firstCategory];
        }

        // Select the first root category by default; deeper levels default to All.
        for (let depth = 0; depth <= marketPath.length; depth += 1) {
            const options = categoriesAt(depth, marketPath.slice(0, depth));
            if (!options.length) break;
            const row = el('div', 'nd-wb-market__level-row');
            row.setAttribute('role', 'group');
            row.setAttribute('aria-label', `${depth + 1}级分类`);

            if (depth > 0) {
                const allButton = el('button', 'nd-wb-market__tab');
                allButton.type = 'button';
                setText(allButton, '全部');
                const allActive = marketPath.length === depth;
                allButton.classList.toggle('is-active', allActive);
                allButton.setAttribute('aria-pressed', allActive ? 'true' : 'false');
                allButton.addEventListener('click', () => {
                    if (allActive) return;
                    marketPath = marketPath.slice(0, depth);
                    renderMarket();
                });
                row.appendChild(allButton);
            }

            for (const category of options) {
                const button = el('button', 'nd-wb-market__tab');
                const active = marketPath[depth] === category;
                button.type = 'button';
                setText(button, category);
                button.classList.toggle('is-active', active);
                button.setAttribute('aria-pressed', active ? 'true' : 'false');
                button.addEventListener('click', () => {
                    if (active) return;
                    marketPath = [...marketPath.slice(0, depth), category];
                    renderMarket();
                });
                row.appendChild(button);
            }
            marketCategories.appendChild(row);
            if (depth === marketPath.length) break;
        }

        const inBranch = parsed.filter(({ categories }) => startsWithPath(categories, marketPath));
        const visible = query
            ? parsed.filter(({ entry, name, categories }) =>
                `${name}\n${categories.join(' ')}\n${entry.value ?? ''}`.toLowerCase().includes(query))
            : inBranch;

        for (const { entry, name, categories } of visible) {
            const tag = el('button', 'nd-wb-market__tag');
            const id = String(entry.id);
            const selected = marketSelected(id);
            tag.type = 'button';
            tag.title = `${categories.join(' · ')}${categories.length ? ' · ' : ''}${name}\n${String(entry.value ?? '')}`;
            tag.setAttribute('aria-pressed', selected ? 'true' : 'false');
            tag.classList.toggle('is-selected', selected);
            const title = el('strong');
            const subtitle = el('small');
            setText(title, name);
            setText(subtitle, String(entry.value ?? '').trim());
            tag.append(title, subtitle);
            tag.addEventListener('click', () => {
                if (marketSelected(id)) {
                    removeManualTag(id);
                    return;
                }
                let input = document.activeElement;
                let target = marketTargetForInput(input);
                if (!target && lastMarketTarget) {
                    target = lastMarketTarget;
                    input = marketInputForTarget(target);
                }
                if (!target || !input) {
                    target = 'scene.positive';
                    input = marketInputForTarget(target);
                    const end = input?.value.length ?? 0;
                    input?.setSelectionRange?.(end, end);
                }
                if (input && insertMarketEntry(entry, input, target)) {
                    renderMarket();
                    persistWorkbenchDraft();
                }
            });
            marketGrid.appendChild(tag);
        }

        const hasChildren = !query && inBranch.some(({ categories }) => categories.length > marketPath.length);
        if (!visible.length && (query || !hasChildren)) {
            marketEmpty.hidden = false;
            setText(marketEmpty, query ? '没有匹配的标签' : '该分类暂无标签');
        }
    }

    async function clearMarket() {
        const store = deps?.marketCatalogStore;
        if (!store || typeof store.clear !== 'function') {
            toast(host, 'error', '标签超市清空功能不可用');
            return;
        }
        const confirmed = await confirmDanger({ host }, '将清空服务器上标签超市的全部分类和标签，无法撤销。需要保留时请先导出备份。已写入提示词的内容不会删除。确定清空吗？');
        if (!confirmed || destroyed) return;
        marketClearBtn.disabled = true;
        try {
            const result = await store.clear();
            if (!result?.ok) throw new Error(result?.error?.message || '清空标签超市失败');
            if (destroyed) return;
            marketCatalog = null;
            marketSignature = '';
            marketPath = [];
            manualTags.clear();
            renderMarket();
            persistWorkbenchDraft();
            toast(host, 'success', '标签超市已清空');
        } catch (error) {
            toast(host, 'error', error?.message || '清空标签超市失败');
        } finally {
            marketClearBtn.disabled = false;
        }
    }

    async function exportMarket() {
        const result = await deps?.marketCatalogStore?.load?.();
        if (!result?.ok) {
            toast(host, 'error', result?.error?.message || '读取标签超市失败');
            return;
        }
        if (!result.value) {
            toast(host, 'warning', '尚未导入标签超市');
            return;
        }
        try {
            downloadJson(result.value, 'nai-dbgen-market-supermarket.json');
        } catch (error) {
            toast(host, 'error', error instanceof Error ? error.message : '导出标签超市失败');
        }
    }

    async function openMarketImport() {
        const store = deps?.marketCatalogStore;
        if (!store || typeof store.replace !== 'function') {
            toast(host, 'error', '独立标签超市存储不可用');
            return;
        }
        marketImportHandle?.destroy();
        let importedCatalog = null;
        marketImportHandle = await openImportExportModal({ host }, '导入标签超市', 'tag', async (data) => {
            const valid = validateMarketCatalog(data);
            if (!valid.ok) throw new Error(valid.message);
            const saved = await store.replace(data);
            if (!saved?.ok) throw new Error(saved?.error?.message || '保存标签超市失败');
            importedCatalog = data;
            return { imported: data.entries.length };
        }, async () => {
            const result = await store.load();
            if (!result?.ok) throw new Error(result?.error?.message || '读取标签超市失败');
            return result.value ?? { schemaVersion: 1, kind: 'tag', libraries: [], entries: [] };
        }, () => {
            if (!importedCatalog) return;
            marketCatalog = importedCatalog;
            marketSignature = marketSignatureOf(marketCatalog);
            marketPath = [];
            manualTags.clear();
            renderMarket();
            persistWorkbenchDraft();
        }, { replaceOnly: true });
        if (destroyed) marketImportHandle.destroy();
    }

    /**
     * @returns {Promise<string|null>}
     */
    async function readClipboardText() {
        try {
            if (typeof navigator !== 'undefined'
                && navigator.clipboard
                && typeof navigator.clipboard.readText === 'function') {
                return await navigator.clipboard.readText();
            }
        } catch {
            // fall through
        }
        return null;
    }

    /**
     * 剪贴板不可用时弹出文本框让用户手动粘贴。
     * @returns {Promise<string|null>}
     */
    function promptManualPaste() {
        return new Promise((resolve) => {
            const wrap = el('div', 'nd-wb-paste-fallback');
            const hint = el('p', 'nd-muted');
            setText(hint, '无法读取剪贴板，请把提示词粘贴到下方后确认。');
            /** @type {HTMLTextAreaElement} */
            const ta = /** @type {HTMLTextAreaElement} */ (el('textarea', 'nd-textarea'));
            ta.rows = 12;
            ta.placeholder = '场景\n正面：…';
            const actions = el('div', 'nd-wb-actions');
            let settled = false;
            /** @type {{ destroy: () => void }|null} */
            let modalHandle = null;

            const finish = (value) => {
                if (settled) return;
                settled = true;
                try { modalHandle?.destroy(); } catch { /* ignore */ }
                resolve(value);
            };

            const cancelBtn = createButton({
                label: '取消',
                variant: 'ghost',
                onClick: () => finish(null),
            });
            const okBtn = createButton({
                label: '确认',
                variant: 'primary',
                onClick: () => finish(ta.value),
            });
            actions.append(okBtn, cancelBtn);
            wrap.append(hint, ta, actions);

            void openModal({ host }, {
                title: '粘贴提示词',
                element: wrap,
                wide: true,
                allowVerticalScrolling: true,
            }).then((h) => {
                modalHandle = h;
            }).catch(() => {
                finish(null);
            });
        });
    }

    /**
     * @returns {Promise<object[]>}
     */
    async function listArtists() {
        if (!artistRepo || typeof artistRepo.list !== 'function') return [];
        try {
            const result = await artistRepo.list();
            if (result && result.ok && Array.isArray(result.value)) {
                return result.value;
            }
        } catch {
            /* ignore */
        }
        return [];
    }

    function selectedArtistId() {
        const value = artistOverrideId === undefined
            ? loadSettings().activeArtistId
            : artistOverrideId;
        return value == null || String(value).trim() === '' ? null : String(value);
    }

    async function selectWorkbenchArtist(id, { initialize = false } = {}) {
        const normalizedId = id == null || String(id).trim() === '' ? null : String(id);
        if (!initialize) {
            artistOverrideId = normalizedId;
            artistPositiveField?.setValue('');
            artistNegativeField?.setValue('');
            for (const [id, record] of manualTags) {
                if (String(record.target).startsWith('artist.')) manualTags.delete(id);
            }
            renderMarket();
        }
        const request = ++artistSelectionRequest;
        const positiveRevision = artistPositiveEditRevision;
        const negativeRevision = artistNegativeEditRevision;
        if (saveCurrentArtistBtn) saveCurrentArtistBtn.disabled = normalizedId == null;
        syncReplacePreviewBtn();
        if (!initialize) persistWorkbenchDraft();
        if (normalizedId == null || !artistRepo || typeof artistRepo.get !== 'function') return null;

        let result;
        try {
            result = await artistRepo.get(normalizedId);
        } catch {
            result = null;
        }
        if (destroyed || request !== artistSelectionRequest) return null;
        if (!result?.ok || !result.value) {
            if (!initialize) toast(host, 'warning', '工作台画师串已不存在，请重新选择');
            return null;
        }
        const fillPositive = initialize
            ? !hasSavedArtistPositivePrompt
            : artistPositiveEditRevision === positiveRevision;
        const fillNegative = initialize
            ? !hasSavedArtistNegativePrompt
            : artistNegativeEditRevision === negativeRevision;
        if (fillPositive) artistPositiveField?.setValue(result.value.positivePrompt ?? '');
        if (fillNegative) artistNegativeField?.setValue(result.value.negativePrompt ?? '');
        if (fillPositive || fillNegative) persistWorkbenchDraft();
        if (!initialize) followWorkbenchModel(result.value);
        return result.value;
    }

    /** 0.2.46：工作台换画师串时，模型系列不同就换成绑定模型（只换一次，不锁定）。 */
    function followWorkbenchModel(artist) {
        const settings = loadSettings() || {};
        if (settings.naiModelFollowsArtist === false) return;
        const cur = paramsForm.getValue();
        const next = followModelForArtistTag(settings, cur.model, resolveArtistModelTag(artist));
        if (!next) return;
        paramsForm.setValue({ ...cur, model: next });
        persistWorkbenchDraft();
    }

    function requestWorkbenchArtistSelection(id, options) {
        artistSelectionReady = selectWorkbenchArtist(id, options);
        return artistSelectionReady;
    }

    async function waitForArtistSelection() {
        while (true) {
            const pending = artistSelectionReady;
            await pending;
            if (pending === artistSelectionReady) return;
        }
    }

    /**
     * @param {string} text
     */
    async function applyPastedText(text) {
        const parsed = parsePromptText(text, { maxCharacters: WORKBENCH_MAX_CHARACTERS });
        if (!parsed.ok) {
            toast(host, 'error', parsed.error?.message || '剪贴板里不是提示词');
            return;
        }
        captionEditor.setCaption(parsed.value.caption);
        manualTags.clear();
        renderMarket();

        const artists = await listArtists();
        const side = resolvePasteArtistAction(parsed.value, artists);
        if (side.truncateMessage) {
            toast(host, 'warning', side.truncateMessage);
        }
        toast(host, 'success', '已粘贴');
        persistWorkbenchDraft();

        if (side.artistAction === 'matched' && side.matchedArtist) {
            await requestWorkbenchArtistSelection(side.matchedArtist.id);
            void artistPicker?.refresh();
            toast(host, 'success', `已切换画师串：${side.matchedArtist.name}`);
        } else if (side.artistAction === 'missing') {
            toast(host, 'warning', '画师串库里没有这一串，未切换');
        }
    }

    async function onPastePrompt() {
        let text = await readClipboardText();
        if (text == null) {
            text = await promptManualPaste();
        }
        if (text == null) return;
        await applyPastedText(text);
    }

    // ── 出图区（独立；绝不调 writePrompt）──────────────────────
    // 4.13 共用组件（与出图参数页同一套）
    const paramsForm = createNaiParamsForm(sessionParams, { presentation: 'workbench' });

    function readParams() {
        return paramsForm.getValue();
    }

    /** @type {AbortController|null} */
    let genAbort = null;
    /** @type {boolean} */
    let generating = false;
    /** @type {Array<() => void>} */
    const previewRevokers = [];
    const imageRepo = deps?.imageRepo || null;
    /** @type {string[]} */
    let savedImageRefs = Array.isArray(draft?.imageRefs)
        ? draft.imageRefs.map((id) => String(id)).filter(Boolean)
        : [];
    let previewImageRefs = Array.isArray(draft?.previewImageRefs)
        ? draft.previewImageRefs.map(String).filter((ref) => savedImageRefs.includes(ref))
        : savedImageRefs.slice(-1);

    const previewBox = el('div', 'nd-wb-preview');
    const previewHint = el('p', 'nd-muted nd-wb-preview__empty');
    const downloadActions = el('span', 'nd-wb-preview__downloads');
    downloadActions.setAttribute('role', 'group');
    downloadActions.setAttribute('aria-label', '下载生成图片');
    setText(previewHint, '生成预览');
    previewBox.appendChild(previewHint);

    const genBtn = createButton({
        label: '出图',
        variant: 'primary',
        onClick: () => { void onGenerateImage(); },
    });
    const genCancelBtn = createButton({
        label: '取消出图',
        variant: 'ghost',
        onClick: () => {
            if (genAbort) genAbort.abort();
        },
    });
    genCancelBtn.disabled = true;
    const clearBtn = createButton({
        label: '清空',
        variant: 'ghost',
        onClick: () => {
            captionEditor.setCaption(emptyNaiCaption());
            manualTags.clear();
            renderMarket();
            previewImageRefs = [];
            clearPreviews();
            genErr.clear();
            persistWorkbenchDraft();
        },
    });
    const reverseBtn = createButton({
        label: '反推重绘',
        variant: 'ghost',
        onClick: () => { void onReverseRedraw(); },
    });
    reverseBtn.title = '用这张图写成下面的生图提示词。自然语言有就一起用，没有也可以。不自动出图。';
    const img2imgBtn = createButton({
        label: '图生图',
        variant: 'ghost',
        onClick: () => { void onImg2Img(); },
    });
    img2imgBtn.title = '把这张图和当前提示词交给 NovelAI 图生图。不先反推。';
    const strengthField = redrawNumberField('重绘强度', defaultImg2ImgStrength(sessionParams.model), 0.01, 0.99);
    const noiseField = redrawNumberField('噪声', defaultImg2ImgNoise(sessionParams.model), 0, 1);

    function setUnmatched(keys) {
        const text = formatUnmatchedKeys(keys);
        if (!text) {
            unmatchedEl.hidden = true;
            setText(unmatchedEl, '');
            return;
        }
        unmatchedEl.hidden = false;
        setText(unmatchedEl, text);
    }

    let previewSelectionSequence = 0;
    function clearPreviews() {
        previewSelectionSequence += 1;
        currentPreviewBlob = null;
        downloadActions.replaceChildren();
        while (previewRevokers.length) {
            const revoke = previewRevokers.pop();
            try { revoke?.(); } catch { /* ignore */ }
        }
        previewBox.replaceChildren();
        previewBox.appendChild(previewHint);
        setText(previewHint, '生成预览');
        previewHint.hidden = false;
    }

    /**
     * @param {Array<{ blob?: Blob, mimeType?: string }>} images
     */
    function showPreviews(images) {
        clearPreviews();
        previewHint.hidden = true;
        if (!Array.isArray(images) || images.length === 0) {
            setText(previewHint, '未返回图片');
            previewHint.hidden = false;
            return;
        }
        const lastPreviewBlob = images[images.length - 1]?.blob;
        currentPreviewBlob = typeof Blob !== 'undefined' && lastPreviewBlob instanceof Blob
            ? lastPreviewBlob : null;
        for (let i = 0; i < images.length; i += 1) {
            const image = images[i];
            const { url, revoke } = previewUrlFromImage(image);
            previewRevokers.push(revoke);
            const card = el('div', 'nd-wb-preview__card');
            if (url && gatePreviewUrl(url)) {
                const img = document.createElement('img');
                img.className = 'nd-wb-preview__img';
                img.alt = `预览 ${i + 1}`;
                img.title = '点击查看大图';
                img.tabIndex = 0;
                img.src = url;
                const openLarge = () => {
                    // 历史查看器使用仓库 URL，外部预览更新时不会误撤销查看器正在使用的 URL。
                    const history = savedImageRefs.map((imageRef) => ({ imageRef }));
                    let selected = history.findIndex((entry) => entry.imageRef === image.imageRef);
                    if (selected < 0) {
                        selected = history.length;
                        history.push({ url, blob: image.blob });
                    }
                    void openSlotImageViewer({ host }, {
                        url,
                        title: `预览 ${i + 1}`,
                        alt: `预览 ${i + 1}`,
                        images: history,
                        initialIndex: selected,
                        getImageUrl: async (ref) => {
                            const result = await imageRepo?.getUrl?.(ref);
                            return result?.ok ? result.value : null;
                        },
                        getImageBlob: async (ref) => {
                            const result = await imageRepo?.getBlob?.(ref);
                            return result?.ok ? result.value : null;
                        },
                        onSelect: async (selectedItem) => {
                            if (!selectedItem?.imageRef) return;
                            const seq = ++previewSelectionSequence;
                            const result = await imageRepo?.getBlob?.(selectedItem.imageRef);
                            if (destroyed || seq !== previewSelectionSequence) return;
                            if (!result?.ok || !result.value) throw new Error('所选图片缓存已不可用');
                            previewImageRefs = [String(selectedItem.imageRef)];
                            showPreviews([{ blob: result.value, mimeType: result.value.type, imageRef: String(selectedItem.imageRef) }]);
                            persistWorkbenchDraft();
                        },
                    });
                };
                img.addEventListener('click', openLarge);
                img.addEventListener('keydown', (event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        openLarge();
                    }
                });
                card.appendChild(img);
                const dl = document.createElement('a');
                dl.className = 'nd-button nd-button--ghost';
                dl.href = url;
                dl.download = '';
                let downloadMime = image?.mimeType || image?.blob?.type || '';
                if (!imageExtension(downloadMime, url) && image?.blob) {
                    void detectImageMime(image.blob).then((mime) => { downloadMime = mime; });
                }
                dl.addEventListener('click', (event) => {
                    event.preventDefault();
                    try { requestImageDownload(url, downloadMime); }
                    catch (cause) { toast(host, 'error', cause?.message || '无法下载图片'); }
                });
                setText(dl, images.length === 1 ? '下载' : `下载 ${i + 1}`);
                downloadActions.appendChild(dl);
            } else {
                const bad = el('p', 'nd-muted');
                setText(bad, '图片地址不安全，已拦截');
                card.appendChild(bad);
            }
            previewBox.appendChild(card);
        }
    }

    function setWritingUi(on) {
        writing = on;
        writeBtn.disabled = on;
        reverseBtn.disabled = on || generating;
        writeCancelBtn.disabled = !on;
        if (on) {
            statusPill.setStatus('online');
            statusPill.setLabel('正在写提示词…');
        } else if (!generating) {
            statusPill.setStatus('idle');
            statusPill.setLabel('空闲');
        }
    }

    function syncReplacePreviewBtn() {
        if (!replacePreviewBtn) return;
        replacePreviewBtn.disabled = generating || replacingPreview;
    }

    async function replaceArtistPreview() {
        if (replacingPreview || generating) return;
        const artistId = selectedArtistId();
        if (artistId == null) {
            toast(host, 'warning', '请先选择画师串');
            return;
        }
        if (typeof Blob === 'undefined' || !(currentPreviewBlob instanceof Blob)) {
            toast(host, 'warning', '请先出图，再用这张图替换预览');
            return;
        }
        const saveService = deps?.artistDraftService;
        if (!saveService || typeof saveService.replacePreview !== 'function') {
            toast(host, 'error', '画师串预览替换不可用');
            return;
        }
        replacingPreview = true;
        syncReplacePreviewBtn();
        try {
            const result = await saveService.replacePreview({
                artistId,
                coverBlob: currentPreviewBlob,
            });
            if (!result?.ok) {
                toast(host, 'error', workbenchErrorMessage(result));
                return;
            }
            await artistPicker?.refresh();
            const name = result.value?.name ? `「${result.value.name}」` : '当前画师串';
            toast(host, 'success', `已用这张图替换${name}的预览`);
        } catch (err) {
            toast(host, 'error', workbenchErrorMessage(err));
        } finally {
            replacingPreview = false;
            if (!destroyed) syncReplacePreviewBtn();
        }
    }

    function setGeneratingUi(on) {
        generating = on;
        // 进行中禁按钮，防重复计费
        genBtn.disabled = !canSubmitGenerate(on);
        reverseBtn.disabled = !canSubmitGenerate(on);
        img2imgBtn.disabled = !canSubmitGenerate(on);
        syncReplacePreviewBtn();
        genCancelBtn.disabled = !on;
        if (on) {
            statusPill.setStatus('online');
            statusPill.setLabel('正在出图…');
        } else if (!writing) {
            statusPill.setStatus('idle');
            statusPill.setLabel('空闲');
        }
    }

    /**
     * @param {string} [imageDataUrl] 反推参考图。不传则只按自然语言写提示词
     */
    async function onWritePrompt(imageDataUrl) {
        if (writing) return;
        const reversing = typeof imageDataUrl === 'string' && imageDataUrl.startsWith('data:image/');
        writeErr.clear();
        setUnmatched([]);
        writeAbort = typeof AbortController !== 'undefined' ? new AbortController() : null;
        setWritingUi(true);
        if (reversing) {
            statusPill.setLabel('正在反推…');
        }
        try {
            const entryIds = [];
            const libraryIds = [];
            for (const group of libGroups) {
                const ids = group.entryIds.filter((id) => picked.get(id) === true);
                if (!ids.length) continue;
                libraryIds.push(group.id);
                entryIds.push(...ids);
            }
            const input = buildWritePromptInput({
                naturalLanguage: nlField.getValue(),
                libraryIds,
                entryIds,
                mode: floorToggle.getValue() ? 'floor' : 'entries',
                imageDataUrl: reversing ? imageDataUrl : undefined,
                signal: writeAbort?.signal,
            });
            // 只走 writePrompt；createDecoupledWorkbenchApi 保证不碰 generateImage
            const result = await service.writePrompt(input);
            if (isWorkbenchAbort(result) || isWorkbenchAbort(result?.error)) {
                // Abort 不是失败
                return;
            }
            if (!result || result.ok !== true) {
                const msg = workbenchErrorMessage(result);
                writeErr.setMessage(msg);
                statusPill.setStatus('error');
                statusPill.setLabel(reversing ? '反推失败' : '写提示词失败');
                toast(host, 'error', msg);
                return;
            }
            reconcileManualTags(false);
            captionEditor.setCaption(result.value.caption);
            reapplyManualTags();
            if (result.value.width != null && result.value.height != null) {
                const cur = paramsForm.getValue();
                paramsForm.setValue({
                    ...cur,
                    width: result.value.width,
                    height: result.value.height,
                });
            }
            setUnmatched(result.value.unmatchedKeys);
            if (Array.isArray(result.value.unmatchedKeys) && result.value.unmatchedKeys.length > 0) {
                toast(host, 'warning', formatUnmatchedKeys(result.value.unmatchedKeys));
            } else {
                toast(host, 'success', reversing ? '生图提示词已填入，可以出图' : '提示词已填入工作台');
            }
            persistWorkbenchDraft();
        } catch (err) {
            if (isWorkbenchAbort(err)) return;
            const msg = workbenchErrorMessage(err);
            writeErr.setMessage(msg);
            toast(host, 'error', msg);
        } finally {
            writeAbort = null;
            setWritingUi(false);
        }
    }

    /**
     * @param {{ img2img?: { image: string, strength?: number, noise?: number }, statusLabel?: string }} [redraw]
     */
    async function onGenerateImage(redraw) {
        // 重复提交门禁：进行中直接忽略
        if (!canSubmitGenerate(generating)) return;
        genErr.clear();
        genAbort = typeof AbortController !== 'undefined' ? new AbortController() : null;
        setGeneratingUi(true);
        if (redraw?.statusLabel) {
            statusPill.setLabel(redraw.statusLabel);
        }
        try {
            await restoreReady;
            await waitForArtistSelection();
            // 工作台字段是本次出图覆盖，不读取或修改全局画师串设置。
            const positivePrompt = artistPositiveField?.getValue() ?? '';
            const negativePrompt = artistNegativeField?.getValue() ?? '';
            const selectedId = selectedArtistId();
            let artist = null;
            if (selectedId !== null) {
                const result = await artistRepo?.get(selectedId);
                if (!result?.ok || !result.value) {
                    toast(host, 'warning', '工作台画师串已不存在，请重新选择');
                    return;
                }
                artist = {
                    ...result.value,
                    positivePrompt,
                    negativePrompt,
                };
            } else if (positivePrompt.trim() || negativePrompt.trim()) {
                artist = {
                    name: '工作台临时画师串',
                    positivePrompt,
                    negativePrompt,
                };
            }
            const input = buildGenerateImageInput({
                caption: captionEditor.getCaption(),
                artist,
                replaceCharacterKeywords: replaceToggle.getValue(),
                params: readParams(),
                img2img: redraw?.img2img,
                signal: genAbort?.signal,
            });
            // 只走 generateImage；不经 LLM / writePrompt
            const result = await service.generateImage(input);
            if (isWorkbenchAbort(result) || isWorkbenchAbort(result?.error)) {
                return;
            }
            if (!result || result.ok !== true) {
                const msg = workbenchErrorMessage(result);
                genErr.setMessage(msg);
                statusPill.setStatus('error');
                statusPill.setLabel('出图失败');
                toast(host, 'error', msg);
                return;
            }
            const images = Array.isArray(result.value) ? result.value : [];
            const previews = await rememberPreviews(images);
            showPreviews(previews);
            persistWorkbenchDraft();
            toast(host, 'success', `已生成 ${images.length} 张`);
        } catch (err) {
            if (isWorkbenchAbort(err)) return;
            const msg = workbenchErrorMessage(err);
            genErr.setMessage(msg);
            toast(host, 'error', msg);
        } finally {
            genAbort = null;
            setGeneratingUi(false);
        }
    }

    /** @type {string} */
    let sourceDataUrl = '';

    const sourcePick = /** @type {HTMLButtonElement} */ (el('button', 'nd-wb-source__pick'));
    sourcePick.type = 'button';
    const sourceImg = document.createElement('img');
    sourceImg.alt = '';
    sourceImg.hidden = true;
    const sourceEmpty = el('span', 'nd-wb-source__empty');
    setText(sourceEmpty, '上传图片');
    sourcePick.append(sourceEmpty, sourceImg);
    sourcePick.addEventListener('click', () => { void pickSourceImage(); });

    async function pickSourceImage() {
        const dataUrl = await readRedrawImage(host);
        if (!dataUrl) return;
        sourceDataUrl = dataUrl;
        sourceImg.src = dataUrl;
        sourceImg.hidden = false;
        sourceEmpty.hidden = true;
    }

    function requireSourceImage() {
        if (sourceDataUrl) return sourceDataUrl;
        toast(host, 'warning', '请先上传图片');
        return '';
    }

    async function onReverseRedraw() {
        if (writing || !canSubmitGenerate(generating)) return;
        const dataUrl = requireSourceImage();
        if (!dataUrl) return;
        await onWritePrompt(dataUrl);
    }

    async function onImg2Img() {
        if (!canSubmitGenerate(generating)) return;
        const dataUrl = requireSourceImage();
        if (!dataUrl) return;
        const size = readParams();
        let fitted = dataUrl;
        try {
            fitted = await fitImg2ImgCanvas(dataUrl, size.width, size.height);
        } catch {
            toast(host, 'error', '这张图没法按出图尺寸排好');
            return;
        }
        await onGenerateImage({
            statusLabel: '正在图生图…',
            img2img: {
                image: fitted,
                strength: Number(strengthField.input.value),
                noise: Number(noiseField.input.value),
            },
        });
    }

    function importCharacterFeatures(features) {
        const caption = captionEditor.getCaption();
        const pos = caption.v4_prompt.caption.char_captions;
        const neg = caption.v4_negative_prompt.caption.char_captions;
        if (Math.max(pos.length, neg.length) >= WORKBENCH_MAX_CHARACTERS) {
            throw new Error(`工作台最多支持 ${WORKBENCH_MAX_CHARACTERS} 个角色，请先删除一个`);
        }
        const parsed = parseCharacterFeatures(features);
        const centers = [{ x: 0.5, y: 0.5 }];
        pos.push({ char_caption: parsed.positive, centers });
        neg.push({ char_caption: parsed.negative, centers });
        captionEditor.setCaption(caption);
        persistWorkbenchDraft();
    }

    async function openCharacterImportModal() {
        const repo = deps?.characterRepo;
        if (!repo?.listGroups || !repo?.listByGroup || !repo?.get) {
            toast(host, 'error', '角色库不可用');
            return;
        }
        let result;
        try { result = await repo.listGroups(); }
        catch { toast(host, 'error', '读取角色组失败'); return; }
        if (!result?.ok) { toast(host, 'error', '读取角色组失败'); return; }
        const groups = result.value || [];
        if (!groups.length) { toast(host, 'warning', '角色库没有角色组'); return; }
        const form = el('div', 'nd-form');
        const error = createInlineError();
        const group = createSelect({ label: '角色组', options: groups.map((g) => ({ value: g.id, label: g.name })) });
        const character = createSelect({ label: '角色', options: [] });
        const hint = el('p', 'nd-muted');
        setText(hint, '导入所选角色的固定特征，新增为工作台角色，不覆盖已有内容。');
        form.append(group.el, character.el, hint, error.el);
        let request = 0;
        async function loadCharacters() {
            const seq = ++request;
            error.clear();
            character.setOptions([]);
            try {
                const rows = await repo.listByGroup(group.getValue());
                if (seq !== request) return;
                if (!rows?.ok) throw new Error('读取角色失败');
                character.setOptions((rows.value || []).map((c) => ({ value: c.id, label: c.name })));
                if (!(rows.value || []).length) error.setMessage('该角色组没有角色');
            } catch (cause) { if (seq === request) error.setMessage(cause?.message || '读取角色失败'); }
        }
        group.el.querySelector('select')?.addEventListener('change', () => { void loadCharacters(); });
        const actions = el('div', 'nd-form__actions');
        let modal = null;
        let importing = false;
        const cancel = createButton({ label: '取消', variant: 'ghost', onClick: () => modal?.destroy() });
        const confirm = createButton({
            label: '导入', variant: 'primary',
            onClick: async () => {
                if (importing) return;
                error.clear();
                const id = character.getValue();
                const groupId = group.getValue();
                if (!id) { error.setMessage('请选择角色'); return; }
                importing = true;
                confirm.disabled = true;
                try {
                    const found = await repo.get(id);
                    if (!found?.ok || !found.value || found.value.groupId !== groupId) throw new Error('角色不存在或已移动，请重新选择');
                    importCharacterFeatures(found.value.fixedFeatures);
                    modal?.destroy();
                } catch (cause) { error.setMessage(cause?.message || '导入角色失败'); }
                finally { importing = false; confirm.disabled = false; }
            },
        });
        actions.append(cancel, confirm);
        form.appendChild(actions);
        try {
            modal = await openModal({ host }, { title: '导入角色', element: form, wide: true });
            await loadCharacters();
        } catch (cause) { toast(host, 'error', cause?.message || '打开角色选择窗口失败'); }
    }

    async function openCharacterSaveModal(mode, prompts) {
        const repo = deps?.characterRepo;
        if (!repo?.listGroups || !repo?.listByGroup || !repo?.put) {
            toast(host, 'error', '角色库不可用');
            return;
        }
        let groupsResult;
        try { groupsResult = await repo.listGroups(); }
        catch { toast(host, 'error', '读取角色组失败'); return; }
        if (!groupsResult?.ok) { toast(host, 'error', '读取角色组失败'); return; }
        const groups = groupsResult.value || [];
        if (!groups.length) { toast(host, 'warning', '请先在角色库中新建角色组'); return; }
        const form = el('div', 'nd-form');
        const error = createInlineError();
        const group = createSelect({ label: '角色组', options: groups.map((g) => ({ value: g.id, label: g.name })) });
        const character = createSelect({ label: '已有角色', options: [] });
        const name = createField({ label: '新角色名称', value: '' });
        const hint = el('p', 'nd-muted');
        setText(hint, mode === 'update' ? '保存会替换该角色的固定特征，其他信息不变。' : '将工作台的正负面提示词保存为新角色的固定特征。');
        let request = 0;
        async function loadCharacters() {
            const seq = ++request;
            error.clear();
            const result = await repo.listByGroup(group.getValue());
            if (seq !== request) return;
            if (!result?.ok) { character.setOptions([]); error.setMessage('读取角色失败'); return; }
            character.setOptions((result.value || []).map((c) => ({ value: c.id, label: c.name })));
        }
        group.el.querySelector('select')?.addEventListener('change', () => { if (mode === 'update') void loadCharacters(); });
        form.append(group.el, mode === 'update' ? character.el : name.el, hint, error.el);
        const actions = el('div', 'nd-form__actions');
        let modal = null;
        let saving = false;
        const cancel = createButton({ label: '取消', variant: 'ghost', onClick: () => modal?.destroy() });
        const save = createButton({
            label: mode === 'update' ? '确认覆盖' : '确认新建', variant: 'primary',
            onClick: async () => {
                if (saving) return;
                error.clear();
                const groupId = group.getValue();
                const characterId = character.getValue();
                const nameValue = name.getValue().trim();
                if (!groupId || (mode === 'update' && !characterId) || (mode === 'create' && !nameValue)) {
                    error.setMessage(mode === 'update' ? '请选择角色组和角色' : '请选择角色组并填写角色名称');
                    return;
                }
                saving = true;
                save.disabled = true;
                try {
                    let entity;
                    const fixedFeatures = formatCharacterFeatures(prompts);
                    if (mode === 'update') {
                        const found = await repo.get(characterId);
                        if (!found?.ok || !found.value || found.value.groupId !== groupId) throw new Error('角色不存在或已移动，请重新选择');
                        entity = { ...found.value, fixedFeatures, updatedAt: nowIso() };
                    } else {
                        entity = createCharacter({ groupId, name: nameValue, fixedFeatures }, { id: newId('ch'), now: nowIso() });
                    }
                    const result = await repo.put(entity);
                    if (!result?.ok) throw new Error(result?.error?.message || '保存角色失败');
                    modal?.destroy();
                    toast(host, 'success', mode === 'update' ? '已保存到角色' : '角色已新建');
                } catch (cause) {
                    error.setMessage(cause?.message || '保存角色失败');
                } finally { saving = false; save.disabled = false; }
            },
        });
        actions.append(cancel, save);
        form.appendChild(actions);
        try {
            modal = await openModal({ host }, { title: mode === 'update' ? '保存到已有角色' : '新建角色', element: form, wide: true });
            if (mode === 'update') await loadCharacters();
        } catch (cause) { toast(host, 'error', cause?.message || '打开角色保存窗口失败'); }
    }

    async function openArtistSaveModal(mode) {
        const saveService = deps?.artistDraftService;
        if (!saveService || typeof saveService.save !== 'function') {
            toast(host, 'error', '工作台画师串保存服务不可用');
            return;
        }
        const artistId = selectedArtistId();
        const positiveDraft = artistPositiveField?.getValue() ?? '';
        const negativeDraft = artistNegativeField?.getValue() ?? '';
        if (mode === 'update' && artistId == null) {
            toast(host, 'warning', '请先选择要保存到的画师串');
            return;
        }
        let existing = null;
        if (artistId != null && typeof artistRepo?.get === 'function') {
            try {
                const result = await artistRepo.get(artistId);
                if (result?.ok) existing = result.value;
            } catch {
                /* 提交时由保存服务返回可见错误 */
            }
        }

        const form = el('div', 'nd-form');
        const makeField = (labelText, value, multiline = false) => {
            const field = el('label', 'nd-field');
            const label = el('span', 'nd-field__label');
            setText(label, labelText);
            const input = multiline
                ? /** @type {HTMLInputElement|HTMLTextAreaElement} */ (el('textarea', 'nd-textarea'))
                : /** @type {HTMLInputElement|HTMLTextAreaElement} */ (el('input', 'nd-input'));
            if (multiline) input.rows = 4;
            input.value = value == null ? '' : String(value);
            field.append(label, input);
            return { el: field, input };
        };
        const nameField = makeField('画师串名称', existing?.name ?? (mode === 'create' ? '新建画师串' : ''));
        const positiveField = makeField('画师串 · 正面', positiveDraft, true);
        const negativeField = makeField('画师串 · 负面', negativeDraft, true);
        const coverAvailable = typeof Blob !== 'undefined' && currentPreviewBlob instanceof Blob;
        const modelTagChecks = createArtistModelTagChecks({
            modelTag: artistModelTagForModel(paramsForm.getValue().model)
                ?? (mode === 'update' && existing ? resolveArtistModelTag(existing) : 'v5'),
        });
        const coverToggle = createCheckbox({
            label: '将当前预览图作为画师串封面',
            checked: false,
        });
        const coverInput = coverToggle.el.querySelector('input');
        if (coverInput) coverInput.disabled = !coverAvailable;
        const error = createInlineError();
        form.append(nameField.el, modelTagChecks.el, positiveField.el, negativeField.el, coverToggle.el, error.el);

        let modal = null;
        let settled = false;
        let saving = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            try { modal?.destroy(); } catch { /* ignore */ }
            error.destroy();
            coverToggle.destroy();
            resolveModal(value);
        };
        let resolveModal;
        const resultPromise = new Promise((resolve) => { resolveModal = resolve; });
        const cancel = createButton({ label: '取消', variant: 'ghost', onClick: () => finish(null) });
        const confirm = createButton({
            label: mode === 'update' ? '确认保存' : '确认新建',
            variant: 'primary',
            onClick: async () => {
                if (saving || settled) return;
                error.clear();
                saving = true;
                confirm.disabled = true;
                try {
                    const result = await saveService.save({
                        mode,
                        ...(mode === 'update' ? { artistId } : {}),
                        name: nameField.input.value,
                        positivePrompt: positiveField.input.value,
                        negativePrompt: negativeField.input.value,
                        modelTag: modelTagChecks.getTag(),
                        coverBlob: coverToggle.getValue() && coverAvailable ? currentPreviewBlob : null,
                    });
                    if (!result?.ok || !result.value) {
                        error.setMessage(workbenchErrorMessage(result));
                        return;
                    }
                    artistOverrideId = String(result.value.id);
                    artistSelectionRequest += 1;
                    artistPositiveField?.setValue(result.value.positivePrompt ?? positiveField.input.value);
                    artistNegativeField?.setValue(result.value.negativePrompt ?? negativeField.input.value);
                    if (saveCurrentArtistBtn) saveCurrentArtistBtn.disabled = false;
                    persistWorkbenchDraft();
                    await artistPicker?.refresh();
                    toast(host, 'success', mode === 'update' ? '已保存到当前画师串' : '已新建画师串');
                    finish(result.value);
                } catch (saveError) {
                    error.setMessage(workbenchErrorMessage(saveError));
                } finally {
                    saving = false;
                    if (!settled) confirm.disabled = false;
                }
            },
        });
        const actions = el('div', 'nd-form__actions');
        actions.append(cancel, confirm);
        form.appendChild(actions);

        try {
            modal = await openModal({ host }, {
                title: mode === 'update' ? '保存到当前画师串' : '新建画师串',
                element: form,
                wide: true,
                allowVerticalScrolling: true,
            });
            form.closest('dialog')?.addEventListener('close', () => finish(null), { once: true });
        } catch (errorOpen) {
            error.destroy();
            coverToggle.destroy();
            toast(host, 'error', workbenchErrorMessage(errorOpen));
            resolveModal(null);
        }
        return resultPromise;
    }

    // ── 拼装 DOM ──────────────────────────────────────────────
    const writeActions = el('div', 'nd-wb-actions');
    writeActions.append(writeBtn, writeCancelBtn, statusPill.el);

    const writeSection = createFieldGroup({
        title: '写提示词',
        children: [nlField.el, floorToggle.el, replaceToggle.el, writeActions, libBox, writeErr.el, unmatchedEl],
    });
    writeSection.el.classList.add('nd-wb-section--secondary');

    const captionSection = createFieldGroup({
        title: '当前提示词',
        children: [captionMount],
    });
    captionSection.el.querySelector('.nd-field-group__title')?.classList.add('nd-wb-current-prompt-title');

    const paramsDetails = createDetails({
        summary: '本次出图参数',
        open: true,
        body: [paramsForm.el],
    });
    paramsDetails.el.classList.add('nd-wb-params-details');

    replacePreviewBtn = createButton({
        label: '替换画师串预览',
        variant: 'ghost',
        onClick: () => { void replaceArtistPreview(); },
    });
    replacePreviewBtn.title = '把工作台当前这张生成图写成所选画师串的预览图，不改画师串文字。';
    const genActions = el('div', 'nd-wb-actions nd-wb-actions--generate');
    genActions.append(genBtn, replacePreviewBtn, downloadActions, genCancelBtn, clearBtn);
    const sourceBar = el('div', 'nd-wb-source');
    const sourceActions = el('div', 'nd-wb-source__actions');
    sourceActions.append(reverseBtn, img2imgBtn, strengthField.el, noiseField.el);
    sourceBar.append(sourcePick, sourceActions);

    /** @type {ReturnType<typeof mountCurrentPicker>|null} */
    let artistPicker = null;
    if (artistRepo && typeof artistRepo.list === 'function') {
        const artistField = el('div', 'nd-wb-artist');
        const artistLabel = el('span', 'nd-field__label nd-wb-artist__label');
        setText(artistLabel, '当前画师串');
        const artistMount = el('div');
        artistField.append(artistLabel, artistMount);

        const promptFields = el('div', 'nd-wb-artist-prompts');
        artistPositiveField = createPromptTextarea({
            label: '画师串 · 正面',
            value: typeof draft?.artistPositivePrompt === 'string' ? draft.artistPositivePrompt : '',
            rows: 4,
            onCopyError: reportCopyError,
        });
        artistNegativeField = createPromptTextarea({
            label: '画师串 · 负面',
            value: typeof draft?.artistNegativePrompt === 'string' ? draft.artistNegativePrompt : '',
            rows: 4,
            onCopyError: reportCopyError,
        });
        promptFields.append(artistPositiveField.el, artistNegativeField.el);
        unlinkArtistResize = linkTextareaHeights(artistPositiveField.input, artistNegativeField.input);

        const artistActions = el('div', 'nd-wb-artist-actions nd-wb-actions');
        saveCurrentArtistBtn = createButton({
            label: '保存到当前画师串',
            variant: 'ghost',
            onClick: () => { void openArtistSaveModal('update'); },
        });
        saveCurrentArtistBtn.disabled = selectedArtistId() == null;
        artistActions.appendChild(saveCurrentArtistBtn);
        artistActions.appendChild(createButton({
            label: '新建画师串',
            variant: 'ghost',
            onClick: () => { void openArtistSaveModal('create'); },
        }));
        artistSlot.append(artistField, promptFields, artistActions);

        artistPicker = mountCurrentPicker(artistMount, {
            list: listArtists,
            getActiveId: () => artistOverrideId === undefined
                ? loadSettings().activeArtistId ?? null : artistOverrideId,
            setActiveId: (id) => {
                void requestWorkbenchArtistSelection(id);
                void artistPicker?.refresh();
            },
            cover: true,
            modelTagFilter: true,
            resolveCover: (item) => deps.artistFileUrl?.cardUrl?.(item) ?? null,
        });

        // current-picker 不自行订阅；与抽屉共用设置，并在关闭工作台时释放监听。
        let lastArtistId = loadSettings().activeArtistId ?? null;
        const syncArtist = () => {
            if (destroyed) return;
            const nextId = loadSettings().activeArtistId ?? null;
            if (nextId === lastArtistId) return;
            lastArtistId = nextId;
            if (artistOverrideId === undefined) void requestWorkbenchArtistSelection(nextId);
            void artistPicker.refresh();
        };
        syncArtistSettings = syncArtist;
        if (typeof deps.subscribeSettings !== 'function') {
            const timer = setInterval(syncArtist, 400);
            artistCleanups.push(() => clearInterval(timer));
        }
        if (typeof artistRepo.onChanged === 'function') {
            const unsubscribe = artistRepo.onChanged(() => {
                if (!destroyed) void artistPicker.refresh();
            });
            if (typeof unsubscribe === 'function') artistCleanups.push(unsubscribe);
        }
    }

    const genSection = createFieldGroup({
        title: '生成结果',
        children: [previewBox, genActions, genErr.el],
    });
    genSection.el.classList.add('nd-wb-section--secondary');

    const leftColumn = el('div', 'nd-wb-column nd-wb-column--left');
    leftColumn.id = newId('nd-wb-left');
    const leftRail = el('div', 'nd-wb-left-rail');
    const leftToggle = createButton({
        label: '', variant: 'icon',
        onClick: () => {
            const collapsed = shell.classList.toggle('nd-workbench--left-collapsed');
            leftToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
            leftToggle.setAttribute('aria-label', collapsed ? '展开左侧面板' : '收起左侧面板');
            leftToggle.title = collapsed ? '展开左侧面板' : '收起左侧面板';
        },
    });
    leftToggle.classList.add('nd-wb-left-toggle');
    leftToggle.setAttribute('aria-controls', leftColumn.id);
    leftToggle.setAttribute('aria-expanded', 'true');
    leftToggle.setAttribute('aria-label', '收起左侧面板');
    leftToggle.title = '收起左侧面板';
    const leftToggleIcon = el('span', 'nd-wb-left-toggle__icon');
    leftToggleIcon.setAttribute('aria-hidden', 'true');
    leftToggle.appendChild(leftToggleIcon);
    leftRail.appendChild(leftToggle);
    const middleColumn = el('div', 'nd-wb-column nd-wb-column--middle');
    const rightColumn = el('div', 'nd-wb-column nd-wb-column--right');
    leftColumn.append(paramsDetails.el, writeSection.el);
    middleColumn.append(artistSlot, sourceBar, captionSection.el, market);
    rightColumn.append(genSection.el);
    shell.append(leftRail, leftColumn, middleColumn, rightColumn);
    root.appendChild(shell);

    function persistWorkbenchDraft() {
        const entryIds = [];
        for (const [id, on] of picked) {
            if (on) entryIds.push(id);
        }
        const savedEntryIds = entryIds.length || picked.size
            ? entryIds
            : (Array.isArray(draft?.entryIds) ? draft.entryIds.map((id) => String(id)) : []);
        writeWorkbenchDraft({
            naturalLanguage: nlField.getValue(),
            floorMode: floorToggle.getValue(),
            entryIds: savedEntryIds,
            caption: captionEditor.getCaption(),
            replaceCharacterKeywords: replaceToggle.getValue(),
            naiParams: paramsForm.getValue(),
            imageRefs: savedImageRefs,
            previewImageRefs,
            artistOverrideId,
            artistPositivePrompt: artistPositiveField?.getValue() ?? '',
            artistNegativePrompt: artistNegativeField?.getValue() ?? '',
            marketSignature,
            manualTags: [...manualTags.values()],
        });
    }

    function onWorkbenchInput(event) {
        if (event.target === artistPositiveField?.input) artistPositiveEditRevision += 1;
        if (event.target === artistNegativeField?.input) artistNegativeEditRevision += 1;
        if (marketTargetForInput(event.target)) reconcileManualTags();
        persistWorkbenchDraft();
    }
    shell.addEventListener('focusin', rememberMarketTarget);
    shell.addEventListener('input', onWorkbenchInput);
    shell.addEventListener('change', persistWorkbenchDraft);
    if (!hasSavedArtistPositivePrompt || !hasSavedArtistNegativePrompt) {
        void requestWorkbenchArtistSelection(selectedArtistId(), { initialize: true });
    }

    void loadLibraries();
    applyMarketVisibility();
    if (typeof deps.subscribeSettings === 'function') {
        const unsubscribeMarket = deps.subscribeSettings(() => {
            if (destroyed) return;
            syncArtistSettings();
            const enabled = loadSettings()?.enableTagMarket === true;
            if (enabled === marketEnabled) return;
            marketEnabled = enabled;
            applyMarketVisibility();
        });
        if (typeof unsubscribeMarket === 'function') artistCleanups.push(unsubscribeMarket);
    }

    const restoreReady = restorePreviews();

    /**
     * 最近 50 张工作台历史钉住；只淘汰超过历史上限的工作台图片。
     * @param {Array<{ blob?: Blob, mimeType?: string }>} images
     */
    async function rememberPreviews(images) {
        if (!imageRepo || typeof imageRepo.put !== 'function') return images;
        const next = [];
        const previews = [];
        for (const image of images) {
            let imageRef = null;
            try {
                if (image?.blob) {
                    const put = await imageRepo.put(image.blob, { pinned: true });
                    if (put?.ok && put.value) {
                        imageRef = String(put.value);
                        next.push(imageRef);
                    }
                }
            } catch {
                /* 存不上就只在这一次里显示 */
            }
            previews.push({ ...image, imageRef });
        }
        if (!next.length) return previews;
        const history = [...new Set([...savedImageRefs, ...next])];
        savedImageRefs = history.slice(-WORKBENCH_HISTORY_LIMIT);
        previewImageRefs = next.filter((ref) => savedImageRefs.includes(ref));
        if (typeof imageRepo.remove === 'function') {
            for (const ref of history.slice(0, -WORKBENCH_HISTORY_LIMIT)) {
                try { await imageRepo.remove(ref); } catch { /* ignore */ }
            }
        }
        return previews;
    }

    async function restorePreviews() {
        if (!savedImageRefs.length || !imageRepo || typeof imageRepo.getBlob !== 'function') return;
        const images = [];
        const kept = [];
        for (const ref of previewImageRefs) {
            try {
                const got = await imageRepo.getBlob(ref);
                const blob = got?.ok ? got.value : null;
                if (!blob) continue;
                images.push({ blob, mimeType: blob.type || '', imageRef: ref });
                kept.push(ref);
            } catch {
                /* 这一张读不出来就跳过 */
            }
        }
        const missing = kept.length !== previewImageRefs.length;
        if (missing && !images.length) {
            // 当前预览被清理时只在本机缓存中寻找最近可用图片，不修改历史记录。
            for (const ref of [...savedImageRefs].reverse()) {
                if (previewImageRefs.includes(ref)) continue;
                try {
                    const got = await imageRepo.getBlob(ref);
                    const blob = got?.ok ? got.value : null;
                    if (blob) { images.push({ blob, mimeType: blob.type || '', imageRef: ref }); kept.push(ref); break; }
                } catch { /* 继续查找上一张 */ }
            }
        }
        if (destroyed) return;
        if (missing) {
            previewImageRefs = kept;
            persistWorkbenchDraft();
            toast(host, 'warning', images.length ? '部分预览图片已被清理，已显示本机可用的图片' : '预览图片已不在本机缓存');
        }
        if (!images.length) return;
        showPreviews(images);
    }
    return {
        async importFromPanel(payload) {
            if (destroyed) throw new Error('工作台已关闭');
            if (payload?.artistId != null) {
                const artist = await requestWorkbenchArtistSelection(payload.artistId);
                if (!artist) throw new Error('画师串不存在，无法导入');
                await artistPicker?.refresh();
            }
            if (payload?.characterFeatures != null) {
                importCharacterFeatures(payload.characterFeatures);
            }
            if (payload?.caption) {
                captionEditor.setCaption(payload.caption);
                manualTags.clear();
                renderMarket();
                persistWorkbenchDraft();
            }
        },
        destroy() {
            if (destroyed) return;
            persistWorkbenchDraft();
            destroyed = true;
            if (writeAbort) writeAbort.abort();
            if (genAbort) genAbort.abort();
            for (const cleanup of artistCleanups) cleanup();
            artistCleanups.length = 0;
            marketImportHandle?.destroy();
            marketImportHandle = null;
            artistPicker?.destroy();
            unlinkArtistResize();
            artistPositiveField?.destroy();
            artistNegativeField?.destroy();
            clearPreviews();
            writeErr.destroy();
            genErr.destroy();
            statusPill.destroy();
            nlField.destroy();
            floorToggle.destroy();
            entrySearchDebounce.dispose();
            marketSearchDebounce.dispose();
            shell.removeEventListener('focusin', rememberMarketTarget);
            for (const c of libControls) c.destroy();
            captionEditor.destroy();
            replaceToggle.destroy();
            paramsForm.destroy();
            paramsDetails.destroy();
            writeSection.destroy();
            captionSection.destroy();
            genSection.destroy();
            shell.remove();
        },
    };
}
