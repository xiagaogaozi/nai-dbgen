/**
 * L5 UI · 当前项选择器（可选封面 + 搜索 + 高亮 + 清除）。
 * 归属：W1-E 组件代理实现。W0 仅冻结签名。
 *
 * 封面由调用方显式 `cover: true` 开启（仅领域模型有图片字段的类型，如画师串）；
 * 无图类型不得生成封面 DOM。
 */

import { t } from '../i18n/zh-CN.js';
import { paintSafeCover } from './safe-url.js';
import { bindDebouncedInput } from './debounced-input.js';
import {
    artistMatchesModelFilter,
    createArtistModelTagFilter,
    formatArtistModelTag,
} from './artist-model-tags.js';

/**
 * @param {object} item
 * @param {(item: object) => string} [getLabel]
 * @returns {string}
 */
function labelOf(item, getLabel) {
    if (typeof getLabel === 'function') {
        return String(getLabel(item) ?? '');
    }
    if (item == null) return '';
    if (item.name != null) return String(item.name);
    if (item.label != null) return String(item.label);
    if (item.id != null) return String(item.id);
    return '';
}

/**
 * @param {object} item
 * @returns {string}
 */
function idOf(item) {
    if (item == null || item.id == null) return '';
    return String(item.id);
}

/**
 * @param {Element} root
 * @param {object} deps
 * @param {() => Promise<object[]>} deps.list
 * @param {() => string|null} deps.getActiveId
 * @param {(id: string|null) => void} deps.setActiveId
 * @param {(item: object) => string} [deps.getLabel]
 * @param {boolean} [deps.cover=false] 仅有图片字段的类型传 true；false 时不生成封面节点
 * @param {(item: object|null|undefined) => (string|null|Promise<string|null>)} [deps.resolveCover]
 *   有图类型须注入（画师串经 artistFileUrl.cardUrl）；未传则无图占位
 * @param {boolean} [deps.modelTagFilter=false] 画师串选择：结果里可按 v4.5 / v5 过滤
 * @returns {{ destroy: () => void, refresh: () => Promise<void> }}
 *
 * D60：不自动订阅设置变更。外部（抽屉 / 管理台）改了激活项或列表后，
 * 必须调用返回的 `refresh()`，否则搜索框/封面会显示旧当前项。
 *
 * `refresh(): Promise<void>`
 * - 重新 `await deps.list()` 刷新候选项
 * - 用当前 `deps.getActiveId()` 同步封面与关闭态下的搜索框文案
 * - 若结果面板开着，按当前 query 重渲选项
 * - destroy 之后调用为 no-op
 */
export function mountCurrentPicker(root, deps) {
    if (!(root instanceof Element)) {
        throw new Error('mountCurrentPicker: root must be an Element');
    }

    const list = typeof deps?.list === 'function' ? deps.list : async () => [];
    const getActiveId = typeof deps?.getActiveId === 'function' ? deps.getActiveId : () => null;
    const setActiveId = typeof deps?.setActiveId === 'function' ? deps.setActiveId : () => {};
    const getLabel = deps?.getLabel;
    const showCover = deps?.cover === true;
    const resolveCover = typeof deps?.resolveCover === 'function' ? deps.resolveCover : null;
    const modelTagFilter = deps?.modelTagFilter === true;
    const tagFilter = modelTagFilter
        ? createArtistModelTagFilter({
            onChange: () => {
                if (resultsOpen) renderResults(input.value);
            },
        })
        : null;

    const shell = document.createElement('div');
    shell.className = 'nd-picker';

    const control = document.createElement('div');
    control.className = showCover ? 'nd-picker__control' : 'nd-picker__control nd-picker__control--no-cover';

    /** @type {HTMLElement|null} */
    let cover = null;
    if (showCover) {
        cover = document.createElement('div');
        cover.className = 'nd-picker__cover';
        cover.setAttribute('aria-hidden', 'true');
    }

    const input = document.createElement('input');
    input.type = 'search';
    input.placeholder = t('picker.searchPlaceholder');
    input.setAttribute('aria-label', t('common.search'));
    input.autocomplete = 'off';

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'nd-picker__clear';
    clearBtn.textContent = '×';
    clearBtn.title = t('picker.clear');
    clearBtn.setAttribute('aria-label', t('picker.clear'));

    if (cover) {
        control.append(cover, input, clearBtn);
    } else {
        control.append(input, clearBtn);
    }

    const results = document.createElement('div');
    results.className = 'nd-picker__results nd-hidden';
    results.setAttribute('role', 'listbox');

    shell.append(control, results);
    root.appendChild(shell);

    // 快捷配置本身是滚动并裁切的浮层：把列表放在视口级浮层中，避免被祖先裁掉。
    const fabPanel = shell.closest?.('.nd-fab-panel') || null;
    let portal = null;
    let positionFrame = 0;
    if (fabPanel && document.body) {
        portal = document.createElement('div');
        portal.className = 'nd-root nd-fab-picker-portal';
        portal.dataset.ndFabPickerPortal = 'true';
        portal.hidden = true;
        portal.appendChild(results);
        document.body.appendChild(portal);
    }

    /** @type {object[]} */
    let items = [];
    let destroyed = false;
    let resultsOpen = false;

    /**
     * @param {HTMLElement} coverEl
     * @param {object|null|undefined} item
     * @param {string} label
     */
    function paintCover(coverEl, item, label) {
        const gen = (Number(coverEl.dataset.coverGen) || 0) + 1;
        coverEl.dataset.coverGen = String(gen);
        paintSafeCover(coverEl, null, label, { emptyVariant: 'mark' });
        if (!resolveCover) {
            return;
        }
        Promise.resolve(resolveCover(item))
            .then((url) => {
                if (destroyed || coverEl.dataset.coverGen !== String(gen)) return;
                paintSafeCover(coverEl, url, label, { emptyVariant: 'mark' });
            })
            .catch(() => {
                if (destroyed || coverEl.dataset.coverGen !== String(gen)) return;
                paintSafeCover(coverEl, null, label, { emptyVariant: 'mark' });
            });
    }

    function positionPortal() {
        positionFrame = 0;
        if (!portal || !resultsOpen || destroyed) return;
        const rect = control.getBoundingClientRect();
        const body = fabPanel?.querySelector?.('.nd-fab-panel__body');
        const bounds = body?.getBoundingClientRect();
        if (bounds && (rect.bottom <= bounds.top || rect.top >= bounds.bottom)) {
            setResultsOpen(false);
            syncControl();
            return;
        }
        const vv = window.visualViewport;
        const leftEdge = vv?.offsetLeft || 0;
        const topEdge = vv?.offsetTop || 0;
        const width = vv?.width || window.innerWidth;
        const height = vv?.height || window.innerHeight;
        const bottomEdge = topEdge + height;
        const availableBelow = Math.max(0, bottomEdge - rect.bottom - 8);
        const availableAbove = Math.max(0, rect.top - topEdge - 8);
        const above = availableBelow < 160 && availableAbove > availableBelow;
        const available = above ? availableAbove : availableBelow;
        const portalWidth = Math.min(rect.width, Math.max(0, width - 12));
        portal.style.left = `${Math.max(leftEdge + 6, Math.min(rect.left, leftEdge + width - portalWidth - 6))}px`;
        portal.style.width = `${portalWidth}px`;
        portal.style.top = above ? 'auto' : `${rect.bottom + 4}px`;
        portal.style.bottom = above ? `${Math.max(0, window.innerHeight - rect.top + 4)}px` : 'auto';
        results.style.maxHeight = `${Math.max(0, Math.min(320, available))}px`;
    }

    function schedulePortalPosition() {
        if (!portal || !resultsOpen || positionFrame) return;
        if (typeof requestAnimationFrame === 'function') {
            positionFrame = requestAnimationFrame(positionPortal) || 0;
        } else {
            positionPortal();
        }
    }

    /** @param {boolean} open */
    function setResultsOpen(open) {
        resultsOpen = open;
        results.classList.toggle('nd-hidden', !open);
        if (portal) {
            portal.hidden = !open;
            if (open) positionPortal();
        }
    }

    function activeItem() {
        const id = getActiveId();
        if (id == null) return null;
        return items.find((item) => idOf(item) === String(id)) || null;
    }

    function syncControl() {
        const current = activeItem();
        const label = labelOf(current, getLabel);
        if (cover) {
            paintCover(cover, current, label);
        }
        if (!resultsOpen) {
            input.value = label;
        }
    }

    /**
     * @param {string} query
     */
    function renderResults(query) {
        results.replaceChildren();
        if (tagFilter) results.appendChild(tagFilter.el);
        const q = String(query || '').trim().toLowerCase();
        const modelTag = tagFilter ? tagFilter.getValue() : '';
        const filtered = items.filter((item) => {
            if (!artistMatchesModelFilter(item, modelTag)) return false;
            if (!q) return true;
            return labelOf(item, getLabel).toLowerCase().includes(q);
        });

        if (!filtered.length) {
            const empty = document.createElement('div');
            empty.className = 'nd-empty-lab';
            empty.style.minHeight = '72px';
            empty.textContent = t('picker.noResults');
            results.appendChild(empty);
            return;
        }

        const activeId = getActiveId();
        for (const item of filtered) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = showCover
                ? 'nd-picker-option'
                : 'nd-picker-option nd-picker-option--no-cover';
            btn.setAttribute('role', 'option');
            const id = idOf(item);
            if (activeId != null && String(activeId) === id) {
                btn.classList.add('is-active');
                btn.setAttribute('aria-selected', 'true');
            } else {
                btn.setAttribute('aria-selected', 'false');
            }

            const label = labelOf(item, getLabel);
            /** @type {HTMLElement[]} */
            const parts = [];

            if (showCover) {
                const mini = document.createElement('div');
                mini.className = 'nd-mini-cover';
                paintCover(mini, item, label);
                parts.push(mini);
            }

            const meta = document.createElement('span');
            meta.className = 'nd-picker-option__meta';
            const strong = document.createElement('strong');
            strong.textContent = label;
            meta.appendChild(strong);
            if (modelTagFilter) {
                const small = document.createElement('small');
                small.textContent = formatArtistModelTag(item);
                meta.appendChild(small);
            } else if (item.category != null || item.subtitle != null) {
                const small = document.createElement('small');
                small.textContent = String(item.category ?? item.subtitle);
                meta.appendChild(small);
            }
            parts.push(meta);

            btn.append(...parts);
            btn.addEventListener('click', () => {
                setActiveId(id || null);
                setResultsOpen(false);
                syncControl();
            });
            results.appendChild(btn);
        }
    }

    async function refresh() {
        if (destroyed) return;
        try {
            const next = await list();
            items = Array.isArray(next) ? next : [];
        } catch {
            items = [];
        }
        syncControl();
        if (resultsOpen) {
            renderResults(input.value);
        }
    }

    const onFocus = () => {
        setResultsOpen(true);
        input.value = '';
        renderResults('');
    };

    // 下拉立即打开；结果列表等停止输入后再筛
    const onInput = () => {
        setResultsOpen(true);
    };

    const onClear = (event) => {
        event.preventDefault();
        setActiveId(null);
        setResultsOpen(false);
        syncControl();
    };

    const onDocPointer = (event) => {
        if (!resultsOpen || destroyed) return;
        const target = event.target;
        if (target instanceof Node && (shell.contains(target) || portal?.contains(target))) return;
        setResultsOpen(false);
        syncControl();
    };

    input.addEventListener('focus', onFocus);
    input.addEventListener('input', onInput);
    const searchDebounce = bindDebouncedInput(input, () => {
        if (destroyed || !resultsOpen) return;
        renderResults(input.value);
    });
    clearBtn.addEventListener('click', onClear);
    document.addEventListener('pointerdown', onDocPointer);
    if (portal) {
        document.addEventListener('scroll', schedulePortalPosition, true);
        document.addEventListener('pointermove', schedulePortalPosition, true);
        window.addEventListener('resize', schedulePortalPosition);
        window.visualViewport?.addEventListener('resize', schedulePortalPosition);
        window.visualViewport?.addEventListener('scroll', schedulePortalPosition);
    }

    const boot = refresh();

    return {
        refresh: () => refresh(),
        destroy() {
            if (destroyed) return;
            destroyed = true;
            input.removeEventListener('focus', onFocus);
            input.removeEventListener('input', onInput);
            searchDebounce.dispose();
            clearBtn.removeEventListener('click', onClear);
            document.removeEventListener('pointerdown', onDocPointer);
            if (portal) {
                document.removeEventListener('scroll', schedulePortalPosition, true);
                document.removeEventListener('pointermove', schedulePortalPosition, true);
                window.removeEventListener('resize', schedulePortalPosition);
                window.visualViewport?.removeEventListener('resize', schedulePortalPosition);
                window.visualViewport?.removeEventListener('scroll', schedulePortalPosition);
                if (positionFrame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(positionFrame);
                portal.remove();
            }
            tagFilter?.destroy();
            shell.remove();
            void boot;
        },
    };
}
