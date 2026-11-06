/**
 * L5 UI · 生图提示词管理面板。
 * 打开即列出当前会话保留范围内的生图记录；无 messageId / traceId 手填。
 * 每张图右侧分层展示画师串 / 场景 / 角色；复制产出可粘进工作台的分类纯文本。
 * 归属：W2-H 面板代理。
 */

import { createButton, createCheckbox, createEmptyState, createInlineError } from '../../common/controls.js';
import { openSlotImageViewer } from '../../common/image-viewer.js';
import { paintSafeCover } from '../../common/safe-url.js';
import { bindDebouncedInput } from '../../common/debounced-input.js';
import { latestSlotImage } from '../../../domain/model/slot.js';
import { el, setText, toast, settingsApi } from '../_lib/panel-kit.js';
import {
    buildCopyPromptText,
    buildPromptDisplayModel,
    filterFloorGroups,
    isUsableArtist,
    resolveArtistIdForRecord,
    summarizeMessageText,
} from './prompts-logic.js';

/**
 * @param {{ label: string, text: string }[]} rows
 * @returns {HTMLElement}
 */
function paintKvRows(rows) {
    const grid = el('div', 'nd-prompt-card__kv');
    for (const row of rows) {
        const isNeg = row.label === '负面';
        const isPos = row.label === '正面';
        let labelClass = 'nd-prompt-card__kv-label nd-prompt-card__pill';
        if (isPos) labelClass += ' nd-prompt-card__pill--pos';
        else if (isNeg) labelClass += ' nd-prompt-card__pill--neg';
        const label = el('span', labelClass);
        setText(label, row.label);

        let valueClass = 'nd-prompt-card__kv-value';
        if (isNeg) valueClass += ' nd-prompt-card__kv-value--neg';
        const value = el('span', valueClass);
        setText(value, row.text);
        grid.append(label, value);
    }
    return grid;
}

/**
 * @param {import('./prompts-logic.js').PromptDisplayModel} model
 * @returns {HTMLElement}
 */
function paintLayers(model) {
    const layers = el('div', 'nd-prompt-card__layers');
    for (const section of model.sections || []) {
        const isChars = Array.isArray(section.children) && section.children.length > 0;
        const block = el(
            'div',
            isChars ? 'nd-prompt-card__section nd-prompt-card__section--chars' : 'nd-prompt-card__section',
        );
        const title = el('div', 'nd-prompt-card__section-title');
        setText(title, section.title);
        block.appendChild(title);

        if (Array.isArray(section.rows) && section.rows.length) {
            block.appendChild(paintKvRows(section.rows));
        }
        if (isChars) {
            const charsGrid = el('div', 'nd-prompt-card__chars');
            for (const child of section.children) {
                const charBlock = el('div', 'nd-prompt-card__char');
                const charTitle = el('div', 'nd-prompt-card__char-title');
                setText(charTitle, child.title);
                charBlock.append(charTitle, paintKvRows(child.rows || []));
                charsGrid.appendChild(charBlock);
            }
            block.appendChild(charsGrid);
        }
        layers.appendChild(block);
    }
    return layers;
}

/**
 * @param {Element} root
 * @param {object} deps repos / host / bus / loadSettings
 * @returns {{ destroy: () => void, refresh: () => Promise<void> }}
 */
export function mountPromptsPanel(root, deps) {
    if (!(root instanceof Element)) {
        throw new Error('mountPromptsPanel: root must be an Element');
    }
    const slotRepo = deps?.repos?.slot;
    const imageRepo = deps?.repos?.image;
    const artistRepo = deps?.repos?.artist;
    const host = deps?.host;
    const settings = settingsApi(deps);

    const shell = el('div', 'nd-panel nd-panel--prompts');
    const loadErr = createInlineError();

    const toolbar = el('div', 'nd-prompts-toolbar');

    const searchWrap = el('div', 'nd-search-field nd-prompts-toolbar__search');
    /** @type {HTMLInputElement} */
    // 0.2.48：和库工具栏一样用无类名 input，样式全由 .nd-search-field 提供
    const searchInput = /** @type {HTMLInputElement} */ (document.createElement('input'));
    searchInput.type = 'search';
    searchInput.placeholder = '搜索生图提示词';
    searchInput.setAttribute('aria-label', '搜索生图提示词');
    searchInput.autocomplete = 'off';
    searchWrap.appendChild(searchInput);

    const refreshBtn = createButton({
        label: '刷新',
        variant: 'ghost',
        onClick: () => void refresh(),
    });
    toolbar.append(searchWrap, refreshBtn);

    const list = el('div', 'nd-prompts-list');
    shell.append(loadErr.el, toolbar, list);
    root.appendChild(shell);

    let destroyed = false;
    let loadGen = 0;
    /** @type {import('./prompts-logic.js').FloorGroup[]} */
    let allGroups = [];
    /** @type {Map<string, { positive?: string, negative?: string }|null>} */
    let artistByRecordKey = new Map();

    /**
     * @param {import('../../../domain/model/slot.js').SlotRecord} record
     * @returns {string}
     */
    function recordKey(record) {
        return `${record.messageId}:${record.slotId}`;
    }

    /**
     * @returns {string|null}
     */
    function currentActiveArtistId() {
        try {
            const id = settings.load()?.activeArtistId;
            return id == null || id === '' ? null : String(id);
        } catch {
            return null;
        }
    }

    /**
     * @param {string} artistId
     * @param {Map<string, { positive?: string, negative?: string }|null>} cache
     * @returns {Promise<{ positive?: string, negative?: string }|null>}
     */
    async function loadArtistById(artistId, cache) {
        if (!artistId) return null;
        if (cache.has(artistId)) return cache.get(artistId) ?? null;
        if (!artistRepo || typeof artistRepo.get !== 'function') {
            cache.set(artistId, null);
            return null;
        }
        try {
            const result = await artistRepo.get(artistId);
            const value = result?.ok && isUsableArtist(result.value) ? result.value : null;
            cache.set(artistId, value);
            return value;
        } catch {
            cache.set(artistId, null);
            return null;
        }
    }

    /**
     * @returns {import('./prompts-logic.js').FloorGroup[]}
     */
    function filteredGroups() {
        return filterFloorGroups(allGroups, searchInput.value, {
            artistFor: (r) => artistByRecordKey.get(recordKey(r)) ?? null,
        });
    }

    const searchDebounce = bindDebouncedInput(searchInput, () => {
        if (destroyed) return;
        paintList(filteredGroups());
    });

    /**
     * @param {string} text
     */
    async function copyPrompt(text) {
        const value = text == null ? '' : String(text);
        try {
            if (typeof navigator !== 'undefined'
                && navigator.clipboard
                && typeof navigator.clipboard.writeText === 'function') {
                await navigator.clipboard.writeText(value);
                toast(host, 'success', '已复制提示词');
                return;
            }
        } catch {
            // fall through
        }
        toast(host, 'warning', '复制失败，请手动选中文本');
    }

    /**
     * @param {HTMLElement} thumbEl
     */
    function paintEmptyThumb(thumbEl) {
        thumbEl.classList.remove('nd-prompt-card__thumb--clickable');
        const ph = el('span', 'nd-prompt-card__thumb-empty');
        setText(ph, '未出图');
        thumbEl.replaceChildren(ph);
    }

    /**
     * @param {import('../../../domain/model/slot.js').SlotRecord} record
     * @returns {HTMLElement}
     */
    function buildCard(record) {
        const artist = artistByRecordKey.get(recordKey(record)) ?? null;
        const model = buildPromptDisplayModel(record.caption, artist);
        const card = el('article', 'nd-prompt-card');

        const thumb = el('div', 'nd-prompt-card__thumb');
        const latest = latestSlotImage(record);
        if (latest?.imageRef) {
            setText(thumb, '');
            void resolveAndPaintThumb(thumb, latest.imageRef, '生图预览');
        } else {
            paintEmptyThumb(thumb);
        }

        const body = el('div', 'nd-prompt-card__body');
        body.appendChild(paintLayers(model));

        const foot = el('div', 'nd-prompt-card__foot');
        const includeArtistCb = createCheckbox({
            label: '连画师串一起复制',
            checked: false,
        });
        /** @type {HTMLInputElement|null} */
        let includeInput = null;
        for (const child of includeArtistCb.el.childNodes || []) {
            if (child && child.tagName === 'INPUT') {
                includeInput = /** @type {HTMLInputElement} */ (child);
                break;
            }
        }
        if (includeInput) {
            includeInput.disabled = !model.hasArtist;
        }

        const copyBtn = createButton({
            label: '复制',
            variant: 'ghost',
            onClick: () => {
                const includeArtist = Boolean(includeInput && !includeInput.disabled && includeInput.checked);
                const text = buildCopyPromptText(record.caption, {
                    artist,
                    includeArtist,
                });
                void copyPrompt(text);
            },
        });
        copyBtn.classList.add('nd-prompt-card__copy');
        foot.append(includeArtistCb.el, copyBtn);
        body.appendChild(foot);

        card.append(thumb, body);
        return card;
    }

    /**
     * @param {HTMLElement} thumbEl
     * @param {string} imageRef
     * @param {string} label
     */
    async function resolveAndPaintThumb(thumbEl, imageRef, label) {
        if (destroyed) return;
        if (!imageRepo || typeof imageRepo.getUrl !== 'function') {
            paintEmptyThumb(thumbEl);
            return;
        }
        try {
            const r = await imageRepo.getUrl(imageRef);
            if (destroyed) return;
            if (r?.ok && r.value) {
                const painted = paintSafeCover(thumbEl, r.value, label);
                if (painted) {
                    const url = r.value;
                    thumbEl.classList.add('nd-prompt-card__thumb--clickable');
                    thumbEl.setAttribute('role', 'button');
                    thumbEl.setAttribute('tabindex', '0');
                    thumbEl.addEventListener('click', () => {
                        if (destroyed) return;
                        void openSlotImageViewer({ host }, { url, alt: label });
                    });
                } else {
                    paintEmptyThumb(thumbEl);
                }
                return;
            }
        } catch {
            // fall through to placeholder
        }
        if (destroyed) return;
        paintEmptyThumb(thumbEl);
    }

    /**
     * @param {import('./prompts-logic.js').FloorGroup[]} groups
     */
    function paintList(groups) {
        list.replaceChildren();
        if (!groups.length) {
            const hasData = allGroups.length > 0;
            const empty = createEmptyState({
                title: hasData ? '没有匹配的生图提示词' : '当前会话还没有生图提示词',
                description: hasData
                    ? '清空搜索框，或换个关键词试试。'
                    : '双击悬浮球，或点楼层里的「生图」。',
            });
            list.appendChild(empty.el);
            return;
        }
        for (const g of groups) {
            const section = el('section', 'nd-prompts-floor');
            const header = el('header', 'nd-prompts-floor__header');
            const title = el('h2', 'nd-prompts-floor__title');
            setText(title, `第 ${g.messageId} 楼`);
            const summary = el('p', 'nd-prompts-floor__summary nd-muted');
            setText(summary, g.summary || '（无正文）');
            header.append(title, summary);
            section.appendChild(header);

            if (g.status === 'error') {
                const errLine = el('p', 'nd-prompts-floor__error nd-inline-error');
                setText(errLine, g.errorMessage || '读取生图提示词失败，请刷新后重试');
                section.appendChild(errLine);
            } else {
                const cards = el('div', 'nd-prompts-floor__cards');
                for (const rec of g.records || []) {
                    cards.appendChild(buildCard(rec));
                }
                section.appendChild(cards);
            }
            list.appendChild(section);
        }
    }

    /**
     * 从会话保留范围内的 slot 记录拉取并渲染。
     * @returns {Promise<void>}
     */
    async function refresh() {
        const gen = ++loadGen;
        loadErr.clear();
        if (!slotRepo || typeof slotRepo.listRetained !== 'function') {
            allGroups = [];
            artistByRecordKey = new Map();
            if (!destroyed && gen === loadGen) {
                paintList([]);
                loadErr.setMessage('生图提示词暂不可用，请刷新后重试');
                toast(host, 'error', '生图提示词暂不可用，请刷新后重试');
            }
            return;
        }

        /** @type {import('./prompts-logic.js').FloorGroup[]} */
        const groups = [];

        let listR;
        try {
            listR = await slotRepo.listRetained();
        } catch (e) {
            if (!destroyed && gen === loadGen) {
                allGroups = [];
                artistByRecordKey = new Map();
                paintList([]);
                const msg = e?.message || '读取生图记录失败';
                loadErr.setMessage(msg);
                toast(host, 'error', msg);
            }
            return;
        }
        if (destroyed || gen !== loadGen) return;
        if (!listR || listR.ok !== true) {
            if (!destroyed && gen === loadGen) {
                allGroups = [];
                artistByRecordKey = new Map();
                paintList([]);
                const msg = listR?.error?.message || '读取生图记录失败';
                loadErr.setMessage(msg);
                toast(host, 'error', msg);
            }
            return;
        }

        /** @type {Map<number, import('../../../domain/model/slot.js').SlotRecord[]>} */
        const byMsg = new Map();
        for (const rec of listR.value || []) {
            if (!rec) continue;
            const mid = Number(rec.messageId);
            if (!byMsg.has(mid)) byMsg.set(mid, []);
            byMsg.get(mid).push(rec);
        }
        const messageIds = [...byMsg.keys()].sort((a, b) => b - a);
        for (const messageId of messageIds) {
            if (destroyed || gen !== loadGen) return;
            const records = byMsg.get(messageId) || [];
            let summary = '';
            try {
                const msg = host?.getMessage?.(messageId);
                summary = summarizeMessageText(msg?.text ?? '');
            } catch {
                summary = '';
            }
            groups.push({
                messageId,
                summary,
                status: 'ok',
                records,
            });
        }

        if (destroyed || gen !== loadGen) return;

        /** @type {Map<string, { positive?: string, negative?: string }|null>} */
        const idCache = new Map();
        /** @type {Map<string, { positive?: string, negative?: string }|null>} */
        const nextArtistMap = new Map();
        const activeId = currentActiveArtistId();
        for (const g of groups) {
            if (g.status !== 'ok') continue;
            for (const rec of g.records || []) {
                const artistId = resolveArtistIdForRecord(rec, activeId);
                const artist = artistId ? await loadArtistById(artistId, idCache) : null;
                if (destroyed || gen !== loadGen) return;
                nextArtistMap.set(recordKey(rec), artist);
            }
        }

        if (destroyed || gen !== loadGen) return;
        allGroups = groups;
        artistByRecordKey = nextArtistMap;
        paintList(filteredGroups());
    }

    void refresh();

    return {
        destroy() {
            if (destroyed) return;
            destroyed = true;
            loadGen += 1;
            searchDebounce.dispose();
            shell.remove();
        },
        refresh,
    };
}
