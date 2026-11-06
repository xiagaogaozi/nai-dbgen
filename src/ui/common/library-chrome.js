/**
 * L5 UI · 库管理铬件：卡片 + 工具栏工厂（W2 面板共用，裁决「组件缺口」）。
 * 封面一律走 safeImageUrl（D24）。
 * 封面 DOM：`cover: true` 时始终生成（无图则同比例占位「无示例图」）；
 * `cover: false` / 缺省为紧凑文字卡（预设、API 库等）。
 */

import { t } from '../i18n/zh-CN.js';
import { createButton, createMiniAction, createToggle, createTokenSelect } from './controls.js';
import { paintSafeCover, paintCoverEmpty } from './safe-url.js';
import { bindDebouncedInput } from './debounced-input.js';

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
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} [opts.titleBadge] 标题旁 muted 小字（如「未填 Key」）
 * @param {string} [opts.subtitle] 标题下方一行灰色小字（悬停看全文）；不盖在封面上
 * @param {string[]} [opts.chips] 用途等小徽标（可换行）
 * @param {string} [opts.status] 与徽标同行的状态文案（如「已填 Key」）
 * @param {boolean} [opts.cover=false] 仅有图片字段的类型传 true；false 时不生成封面/monogram
 * @param {unknown} [opts.coverUrl] 已解析的展示 URL（会过 safeImageUrl）；由面板经 artistFileUrl 注入解析
 * @param {boolean} [opts.active]
 * @param {boolean} [opts.selected]
 * @param {(on: boolean) => void} [opts.onSelect] 有则在卡片角上放勾选框
 * @param {boolean} [opts.enabled]
 * @param {(v: boolean) => void} [opts.onEnabledChange] 有则渲染启用开关
 * @param {{ label: string, action?: string, variant?: string, onClick?: () => void }[]} [opts.actions]
 * @param {() => void} [opts.onOpen] 点标题（封面默认也走这里，除非给了 onCoverClick）
 * @param {() => void} [opts.onCoverClick] 点封面；有则封面不走 onOpen
 * @param {string} [opts.coverBadge] 封面右下角小角标（如 v5 / v4.5）
 * @param {boolean} [opts.openOnCardClick] 点卡片任意处（封面、勾选框除外）走 onOpen
 * @param {HTMLElement} [opts.body]
 * @returns {{
 *   el: HTMLElement,
 *   setTitle: (s: string) => void,
 *   setTitleBadge: (s: string|null|undefined) => void,
 *   setSubtitle: (s: string) => void,
 *   setCover: (url: unknown, label?: string) => void,
 *   setActive: (v: boolean) => void,
 *   setSelected: (v: boolean) => void,
 *   setEnabled: (v: boolean) => void,
 *   destroy: () => void,
 * }}
 */
export function createStyleCard(opts) {
    const wantCover = opts?.cover === true;
    const titleText = opts?.title != null ? String(opts.title) : '';
    const coverSrc = opts?.coverUrl;
    const hasCoverSrc = coverSrc != null && String(coverSrc).trim() !== '';
    // 画师串等 cover:true：始终留同比例封面区；无图时浅底 +「无示例图」（D67）
    // 预设/API 等 cover:false：不生成封面 DOM
    const showCover = wantCover;
    const root = el('article', showCover ? 'nd-style-card' : 'nd-style-card nd-style-card--no-cover');
    if (opts?.active) root.classList.add('is-active');
    if (opts?.selected) root.classList.add('is-selected');

    /** @type {HTMLElement|null} */
    let cover = null;
    if (showCover) {
        cover = el('button', 'nd-style-card__cover');
        /** @type {HTMLButtonElement} */ (cover).type = 'button';
        if (hasCoverSrc) {
            paintSafeCover(cover, coverSrc, titleText, { emptyVariant: 'label' });
        } else {
            cover.classList.add('nd-style-card__cover--empty');
            paintCoverEmpty(cover, { variant: 'label' });
        }
    }
    /** @type {HTMLElement|null} */
    let coverBadgeEl = null;
    const coverBadgeText = opts?.coverBadge != null ? String(opts.coverBadge).trim() : '';
    if (coverBadgeText && cover) {
        // 挂在封面里；setCover 重绘封面后重新补回
        coverBadgeEl = el('span', 'nd-style-card__cover-badge');
        coverBadgeEl.textContent = coverBadgeText;
        cover.appendChild(coverBadgeEl);
    }
    // 裂图时 paintSafeCover 会把封面换成占位，角标随之被清；事后补回
    const onCoverImgError = () => {
        setTimeout(() => {
            if (cover && coverBadgeEl && coverBadgeEl.parentNode !== cover) cover.appendChild(coverBadgeEl);
        }, 0);
    };
    if (coverBadgeEl && cover) cover.addEventListener('error', onCoverImgError, true);

    const body = el('div', 'nd-style-card__body');
    const textCol = el('div', 'nd-style-card__text');
    const heading = el('h3', 'nd-style-card__title');
    const titleSpan = el('span', 'nd-style-card__title-text');
    titleSpan.textContent = titleText;
    heading.appendChild(titleSpan);
    heading.title = titleText;
    /** @type {HTMLElement|null} */
    let titleBadgeEl = null;
    const badgeText = opts?.titleBadge != null ? String(opts.titleBadge).trim() : '';
    if (badgeText) {
        titleBadgeEl = el('span', 'nd-muted nd-style-card__title-badge');
        titleBadgeEl.textContent = badgeText;
        heading.appendChild(titleBadgeEl);
    }
    textCol.appendChild(heading);

    /** @type {HTMLElement|null} */
    let subtitleEl = null;
    const subtitleText = opts?.subtitle != null ? String(opts.subtitle).trim() : '';
    if (subtitleText) {
        subtitleEl = el('p', 'nd-style-card__subtitle');
        subtitleEl.textContent = subtitleText;
        subtitleEl.title = subtitleText;
        textCol.appendChild(subtitleEl);
    }

    /** @type {HTMLElement|null} */
    let chipsRow = null;
    const chipList = Array.isArray(opts?.chips)
        ? opts.chips.map((c) => String(c ?? '').trim()).filter(Boolean)
        : [];
    const statusText = opts?.status != null ? String(opts.status).trim() : '';
    if (chipList.length || statusText) {
        chipsRow = el('div', 'nd-style-card__chips');
        for (const label of chipList) {
            const chip = el('span', 'nd-style-card__chip');
            chip.textContent = label;
            chipsRow.appendChild(chip);
        }
        if (statusText) {
            const st = el('span', 'nd-style-card__status');
            st.textContent = statusText;
            chipsRow.appendChild(st);
        }
        textCol.appendChild(chipsRow);
    }
    body.appendChild(textCol);

    if (opts?.body instanceof HTMLElement) {
        body.appendChild(opts.body);
    }

    /** @type {{ destroy: () => void }|null} */
    let enabledToggle = null;
    if (typeof opts?.onEnabledChange === 'function') {
        enabledToggle = createToggle({
            label: t('library.enabled'),
            checked: Boolean(opts.enabled),
            onChange: opts.onEnabledChange,
        });
        enabledToggle.el.classList.add('nd-style-card__enable');
        body.appendChild(enabledToggle.el);
    }

    // D65：`.card-actions` 是 body 的兄弟节点，不是塞进标题区
    const actions = el('div', 'nd-style-card__actions');
    /** @type {(() => void)[]} */
    const cleanups = [];

    const actionList = Array.isArray(opts?.actions) ? opts.actions : [];
    for (const spec of actionList) {
        // 卡底小按钮条：与嵌套列表共用 nd-mini-action
        const btn = createMiniAction({
            label: spec.label,
            danger: spec.variant === 'danger',
            action: spec.action,
            onClick: spec.onClick,
        });
        actions.appendChild(btn);
    }
    if (actionList.length) {
        // 列数跟真实动作数走（只有编辑/删除时 repeat(2,1fr)，不硬凑四个假按钮）
        actions.style.gridTemplateColumns = `repeat(${actionList.length}, minmax(0, 1fr))`;
    }

    if (typeof opts?.onOpen === 'function' || typeof opts?.onCoverClick === 'function') {
        const onOpen = (event) => {
            event.preventDefault();
            if (typeof opts.onOpen === 'function') opts.onOpen();
        };
        const onCover = (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (typeof opts.onCoverClick === 'function') {
                opts.onCoverClick();
            } else if (typeof opts.onOpen === 'function') {
                opts.onOpen();
            }
        };
        if (cover) {
            cover.addEventListener('click', onCover);
            cleanups.push(() => {
                cover.removeEventListener('click', onCover);
            });
        }
        if (typeof opts.onOpen === 'function' && opts.openOnCardClick === true) {
            root.classList.add('nd-style-card--clickable');
            const onRoot = (event) => {
                const target = event.target instanceof Element ? event.target : null;
                const inner = target?.closest('button, a, input, label, select, textarea');
                if (inner && inner !== root) return;
                event.preventDefault();
                opts.onOpen();
            };
            root.addEventListener('click', onRoot);
            cleanups.push(() => {
                root.removeEventListener('click', onRoot);
            });
        } else if (typeof opts.onOpen === 'function') {
            heading.style.cursor = 'pointer';
            heading.addEventListener('click', onOpen);
            cleanups.push(() => {
                heading.removeEventListener('click', onOpen);
            });
        }
    }

    if (coverBadgeEl && cover) {
        cleanups.push(() => cover.removeEventListener('error', onCoverImgError, true));
    }

    /** @type {HTMLElement[]} */
    const children = [];
    if (cover) children.push(cover);
    children.push(body);
    if (actionList.length) children.push(actions);
    root.append(...children);

    /** @type {HTMLInputElement|null} */
    let selectInput = null;
    if (typeof opts?.onSelect === 'function') {
        const selectLabel = el('label', 'nd-style-card__select');
        selectInput = /** @type {HTMLInputElement} */ (document.createElement('input'));
        selectInput.type = 'checkbox';
        selectInput.checked = Boolean(opts.selected);
        selectInput.setAttribute('aria-label', '选择');
        const onChange = () => {
            if (typeof opts.onSelect === 'function') opts.onSelect(Boolean(selectInput?.checked));
        };
        const stop = (event) => {
            event.stopPropagation();
        };
        selectInput.addEventListener('change', onChange);
        selectLabel.addEventListener('click', stop);
        cleanups.push(() => {
            selectInput?.removeEventListener('change', onChange);
            selectLabel.removeEventListener('click', stop);
        });
        selectLabel.appendChild(selectInput);
        root.appendChild(selectLabel);
    }

    let destroyed = false;
    return {
        el: root,
        setTitle(s) {
            const text = s == null ? '' : String(s);
            titleSpan.textContent = text;
            heading.title = text;
        },
        setTitleBadge(s) {
            const text = s == null ? '' : String(s).trim();
            if (!text) {
                titleBadgeEl?.remove();
                titleBadgeEl = null;
                return;
            }
            if (!titleBadgeEl) {
                titleBadgeEl = el('span', 'nd-muted nd-style-card__title-badge');
                heading.appendChild(titleBadgeEl);
            }
            titleBadgeEl.textContent = text;
        },
        setSubtitle(s) {
            const text = s == null ? '' : String(s).trim();
            if (!text) {
                subtitleEl?.remove();
                subtitleEl = null;
                return;
            }
            if (!subtitleEl) {
                subtitleEl = el('p', 'nd-style-card__subtitle');
                // 插在标题后、chips 前
                if (chipsRow) textCol.insertBefore(subtitleEl, chipsRow);
                else textCol.appendChild(subtitleEl);
            }
            subtitleEl.textContent = text;
            subtitleEl.title = text;
        },
        /**
         * @param {string[]|null|undefined} chips
         * @param {string|null|undefined} [status]
         */
        setChips(chips, status) {
            const list = Array.isArray(chips)
                ? chips.map((c) => String(c ?? '').trim()).filter(Boolean)
                : [];
            const stText = status != null ? String(status).trim() : '';
            if (!list.length && !stText) {
                chipsRow?.remove();
                chipsRow = null;
                return;
            }
            if (!chipsRow) {
                chipsRow = el('div', 'nd-style-card__chips');
                textCol.appendChild(chipsRow);
            }
            chipsRow.replaceChildren();
            for (const label of list) {
                const chip = el('span', 'nd-style-card__chip');
                chip.textContent = label;
                chipsRow.appendChild(chip);
            }
            if (stText) {
                const st = el('span', 'nd-style-card__status');
                st.textContent = stText;
                chipsRow.appendChild(st);
            }
        },
        setCover(url, label) {
            if (!cover) return;
            const text = label != null ? label : heading.textContent;
            const hasUrl = url != null && String(url).trim() !== '';
            if (hasUrl) {
                cover.classList.remove('nd-style-card__cover--empty');
                paintSafeCover(cover, url, text, { emptyVariant: 'label' });
            } else {
                cover.classList.add('nd-style-card__cover--empty');
                paintCoverEmpty(cover, { variant: 'label' });
            }
            if (coverBadgeEl) cover.appendChild(coverBadgeEl);
        },
        setActive(v) {
            root.classList.toggle('is-active', Boolean(v));
        },
        setSelected(v) {
            const on = Boolean(v);
            root.classList.toggle('is-selected', on);
            if (selectInput) selectInput.checked = on;
        },
        setEnabled(v) {
            if (enabledToggle) enabledToggle.setValue(Boolean(v));
        },
        destroy() {
            if (destroyed) return;
            destroyed = true;
            for (const fn of cleanups) fn();
            enabledToggle?.destroy();
            root.remove();
        },
    };
}

/**
 * @param {object} opts
 * @param {string} [opts.searchPlaceholder]
 * @param {string} [opts.searchValue]
 * @param {(q: string) => void} [opts.onSearch]
 * @param {{ value: string, label: string }[]} [opts.filters]
 * @param {string} [opts.filterValue]
 * @param {string} [opts.filterLabel]
 * @param {(v: string) => void} [opts.onFilter]
 * @param {{ value: string, label: string }[]} [opts.sortOptions]
 * @param {string} [opts.sortValue]
 * @param {string} [opts.sortLabel]
 * @param {(v: string) => void} [opts.onSort]
 * @param {() => void} [opts.onCreate]
 * @param {() => void} [opts.onImport]
 * @param {() => void} [opts.onExport]
 * @param {HTMLElement[]} [opts.extra]
 * @param {HTMLElement[]} [opts.leading] 插在「新建」后、导入/导出前
 * @returns {{
 *   el: HTMLElement,
 *   getSearch: () => string,
 *   setSearch: (s: string) => void,
 *   getFilter: () => string,
 *   setFilter: (v: string) => void,
 *   getSort: () => string,
 *   setSort: (v: string) => void,
 *   destroy: () => void,
 * }}
 */
export function createLibraryToolbar(opts) {
    const root = el('div', 'nd-library-toolbar');

    const searchWrap = el('div', 'nd-search-field');
    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = opts?.searchPlaceholder != null
        ? String(opts.searchPlaceholder)
        : t('library.searchPlaceholder');
    search.setAttribute('aria-label', t('common.search'));
    search.value = opts?.searchValue != null ? String(opts.searchValue) : '';
    search.autocomplete = 'off';
    searchWrap.appendChild(search);

    /** @type {HTMLSelectElement|null} */
    let filterSelect = null;
    if (Array.isArray(opts?.filters) && opts.filters.length) {
        filterSelect = /** @type {HTMLSelectElement} */ (el('select', 'nd-select'));
        filterSelect.setAttribute(
            'aria-label',
            opts.filterLabel != null ? String(opts.filterLabel) : t('library.filter'),
        );
        for (const item of opts.filters) {
            const option = document.createElement('option');
            option.value = String(item.value);
            option.textContent = item.label != null ? String(item.label) : String(item.value);
            filterSelect.appendChild(option);
        }
        if (opts.filterValue != null) filterSelect.value = String(opts.filterValue);
    }

    // 0.2.48：排序改用令牌风格下拉框，不再用原生 select
    /** @type {ReturnType<typeof createTokenSelect>|null} */
    let sortSelect = null;
    if (Array.isArray(opts?.sortOptions) && opts.sortOptions.length) {
        sortSelect = createTokenSelect({
            options: opts.sortOptions,
            value: opts.sortValue != null ? String(opts.sortValue) : undefined,
            ariaLabel: opts.sortLabel != null ? String(opts.sortLabel) : t('library.sort'),
            onChange: (v) => {
                if (typeof opts?.onSort === 'function') opts.onSort(v);
            },
        });
    }

    /** @type {HTMLButtonElement[]} */
    const buttons = [];
    if (typeof opts?.onCreate === 'function') {
        buttons.push(createButton({
            label: t('library.create'),
            variant: 'primary',
            onClick: opts.onCreate,
        }));
    }
    for (const node of Array.isArray(opts?.leading) ? opts.leading : []) {
        if (node instanceof HTMLElement) buttons.push(/** @type {HTMLButtonElement} */ (node));
    }
    if (typeof opts?.onImport === 'function') {
        buttons.push(createButton({
            label: t('common.import'),
            variant: 'ghost',
            onClick: opts.onImport,
        }));
    }
    if (typeof opts?.onExport === 'function') {
        buttons.push(createButton({
            label: t('common.export'),
            variant: 'ghost',
            onClick: opts.onExport,
        }));
    }

    const actions = el('div', 'nd-library-toolbar__actions');
    for (const btn of buttons) actions.appendChild(btn);
    const extras = Array.isArray(opts?.extra) ? opts.extra : [];
    for (const node of extras) {
        if (node instanceof HTMLElement) actions.appendChild(node);
    }

    root.appendChild(searchWrap);
    if (filterSelect) root.appendChild(filterSelect);
    if (sortSelect) root.appendChild(sortSelect.el);
    if (actions.childNodes.length) root.appendChild(actions);

    const onSearch = () => {
        if (typeof opts?.onSearch === 'function') opts.onSearch(search.value);
    };
    const onFilter = () => {
        if (filterSelect && typeof opts?.onFilter === 'function') {
            opts.onFilter(filterSelect.value);
        }
    };

    const searchDebounce = bindDebouncedInput(search, onSearch);
    filterSelect?.addEventListener('change', onFilter);


    let destroyed = false;
    return {
        el: root,
        getSearch: () => search.value,
        setSearch(s) {
            search.value = s == null ? '' : String(s);
        },
        getFilter: () => (filterSelect ? filterSelect.value : ''),
        setFilter(v) {
            if (filterSelect) filterSelect.value = v == null ? '' : String(v);
        },
        getSort: () => (sortSelect ? sortSelect.getValue() : ''),
        setSort(v) {
            if (sortSelect) sortSelect.setValue(v);
        },
        destroy() {
            if (destroyed) return;
            destroyed = true;
            searchDebounce.dispose();
            filterSelect?.removeEventListener('change', onFilter);
            sortSelect?.destroy();
            root.remove();
        },
    };
}
