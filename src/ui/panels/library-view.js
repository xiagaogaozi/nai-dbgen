/**
 * L5 UI · 四库共用的「工具栏 + 卡片网格」范式（架构 §8.5）。
 * 归属：W2-H 面板代理实现。W0 仅冻结签名。
 */

import { createStyleCard, createLibraryToolbar } from '../common/library-chrome.js';
import { createEmptyState } from '../common/controls.js';
import { createStore } from '../common/store.js';
import { filterSortItems, resolveDeleteIdsByIdentity } from './_lib/library-logic.js';
import { el, setText } from './_lib/panel-kit.js';

/**
 * @typedef {object} LibraryColumn
 * @property {string} key
 * @property {string} label
 * @property {(item: object) => string|Element} [render]
 */

/**
 * @typedef {object} LibraryViewDeps
 * @property {() => Promise<object[]>} list
 * @property {(item: object) => void} onEdit
 * @property {() => void} onCreate
 * @property {(ids: string[]) => void} [onDelete]
 * @property {() => void} [onImport]
 * @property {() => void} [onExport]
 * @property {(item: object, active: boolean) => void} [onToggleActive]
 * @property {(item: object) => void} [onCoverClick]
 */

/**
 * @param {Element} root
 * @param {LibraryViewDeps} deps
 * @param {{
 *   columns?: LibraryColumn[],
 *   searchKeys?: string[],
 *   cover?: boolean,
 *   titleBadge?: (item: object) => string|null|undefined,
 *   cardMeta?: (item: object) => {
 *     subtitle?: string,
 *     chips?: string[],
 *     status?: string,
 *   }|null|undefined,
 *   sortOptions?: { value: string, label: string }[],
 *   defaultSort?: string,
 *   filterBar?: HTMLElement,
 * }} [opts]
 *   `cover: true` 画师串等应有图的类型（无图也保留同比例占位）；缺省/false 为紧凑文字卡
 *   `titleBadge` 返回名字旁 muted 提示（如未填 Key）
 *   `cardMeta` 覆盖 columns 拼副标题：分行副标题 + 用途徽标 + 状态
 * @returns {{ destroy: () => void, refresh: () => Promise<void> }}
 */
export function mountLibraryView(root, deps, opts) {
    if (!(root instanceof Element)) {
        throw new Error('mountLibraryView: root must be an Element');
    }

    const searchKeys = opts?.searchKeys || ['name', 'key', 'model', 'baseUrl'];
    const showCover = opts?.cover === true;
    const defaultSort = opts?.defaultSort != null ? String(opts.defaultSort) : 'name-asc';
    const sortOptions = Array.isArray(opts?.sortOptions) && opts.sortOptions.length
        ? opts.sortOptions
        : [
            { value: 'name-asc', label: '名称' },
            { value: 'name-desc', label: '名称倒序' },
            { value: 'updated-desc', label: '最近更新' },
        ];
    const store = createStore({
        query: '',
        filter: '',
        sort: defaultSort,
        items: /** @type {object[]} */ ([]),
    });

    const shell = el('div', 'nd-library-view');
    const toolbar = createLibraryToolbar({
        onSearch: (q) => store.set((s) => ({ ...s, query: q })),
        onSort: (v) => store.set((s) => ({ ...s, sort: v })),
        sortOptions,
        sortValue: defaultSort,
        onCreate: deps.onCreate,
        onImport: deps.onImport,
        onExport: deps.onExport,
    });
    const grid = el('div', showCover ? 'nd-style-grid' : 'nd-style-grid nd-style-grid--text');
    const status = el('div', 'nd-library-view__status');
    status.setAttribute('aria-live', 'polite');
    const scroller = el('div', 'nd-library-view__scroller');
    scroller.appendChild(grid);
    shell.append(toolbar.el);
    if (opts?.filterBar instanceof Element) {
        shell.appendChild(opts.filterBar);
    }
    shell.append(status, scroller);
    root.appendChild(shell);

    /** @type {{ destroy: () => void }[]} */
    let cards = [];
    let destroyed = false;

    function clearCards() {
        for (const c of cards) c.destroy();
        cards = [];
        grid.replaceChildren();
    }

    function paint() {
        if (destroyed) return;
        clearCards();
        const state = store.get();
        const visible = filterSortItems(state.items, {
            query: state.query,
            sort: state.sort,
            searchKeys,
            predicate: state.filter
                ? (item) => String(item?.kind ?? item?.type ?? '') === state.filter
                : undefined,
        });

        setText(status, `共 ${visible.length} 条`);

        if (!visible.length) {
            const empty = createEmptyState({
                title: '暂无内容',
                description: '没有匹配的条目，换个筛选条件试试。',
            });
            grid.appendChild(empty.el);
            cards.push(empty);
            return;
        }

        for (const item of visible) {
            /** @type {string|undefined} */
            let subtitle;
            /** @type {string[]|undefined} */
            let chips;
            /** @type {string|undefined} */
            let status;
            if (typeof opts?.cardMeta === 'function') {
                const meta = opts.cardMeta(item) || {};
                subtitle = meta.subtitle != null && String(meta.subtitle).trim()
                    ? String(meta.subtitle).trim()
                    : undefined;
                chips = Array.isArray(meta.chips)
                    ? meta.chips.map((c) => String(c ?? '').trim()).filter(Boolean)
                    : undefined;
                status = meta.status != null && String(meta.status).trim()
                    ? String(meta.status).trim()
                    : undefined;
            } else {
                const subtitleParts = [];
                const columns = Array.isArray(opts?.columns) ? opts.columns : [];
                for (const col of columns) {
                    if (col.key === 'name') continue;
                    let text = '';
                    if (typeof col.render === 'function') {
                        const rendered = col.render(item);
                        text = typeof rendered === 'string' ? rendered : '';
                    } else if (item && item[col.key] != null) {
                        text = String(item[col.key]);
                    }
                    if (text) subtitleParts.push(text);
                }
                subtitle = subtitleParts.join(' · ') || undefined;
            }

            const card = createStyleCard({
                title: String(item?.name ?? item?.key ?? item?.id ?? ''),
                titleBadge: typeof opts?.titleBadge === 'function'
                    ? (opts.titleBadge(item) || undefined)
                    : undefined,
                subtitle,
                chips,
                status,
                cover: showCover,
                coverUrl: item?.coverUrl,
                active: Boolean(item?.__active),
                enabled: item?.active !== false && item?.enabled !== false,
                onEnabledChange: typeof deps.onToggleActive === 'function'
                    ? (v) => deps.onToggleActive(item, v)
                    : undefined,
                onOpen: () => deps.onEdit(item),
                onCoverClick: typeof deps.onCoverClick === 'function'
                    ? () => deps.onCoverClick(item)
                    : undefined,
                actions: [
                    {
                        label: '编辑',
                        action: 'edit',
                        onClick: () => deps.onEdit(item),
                    },
                    typeof deps.onDelete === 'function'
                        ? {
                            label: '删除',
                            action: 'delete',
                            variant: 'danger',
                            onClick: () => {
                                // 按实体 id 删除，避免筛选/排序后的可见下标错位
                                const ids = resolveDeleteIdsByIdentity(
                                    store.get().items,
                                    [String(item.id)],
                                );
                                if (ids.length) deps.onDelete(ids);
                            },
                        }
                        : null,
                ].filter(Boolean),
            });
            grid.appendChild(card.el);
            cards.push(card);
        }
    }

    const unsub = store.subscribe(() => paint());

    async function refresh() {
        if (destroyed) return;
        try {
            const list = await deps.list();
            store.set((s) => ({
                ...s,
                items: Array.isArray(list) ? list : [],
            }));
        } catch {
            store.set((s) => ({ ...s, items: [] }));
        }
        paint();
    }

    void refresh();

    return {
        refresh,
        destroy() {
            if (destroyed) return;
            destroyed = true;
            unsub();
            clearCards();
            toolbar.destroy();
            shell.remove();
        },
    };
}
