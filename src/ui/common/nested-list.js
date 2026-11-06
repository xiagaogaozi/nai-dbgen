/**
 * L5 UI · 两层列表（组→角色 / 库→条目 同构，裁决「组件缺口」）。
 * 子层可选挂 mountVirtualList（标签条目上千条）。
 */

import { t } from '../i18n/zh-CN.js';
import { createToggle } from './controls.js';
import { mountVirtualList } from './virtual-list.js';

/** 与 tokens.css `--nd-nested-child-h` 一致；虚拟列表 rowHeight 必须同值。 */
export const NESTED_CHILD_ROW_HEIGHT = 44;

/**
 * 子行左侧两行文字：上 primary（加粗）、下 secondary（淡色），各自单行省略；完整文案放 title。
 * secondary 内换行显示为空格。
 *
 * @param {HTMLElement} row
 * @param {{ primary?: string, secondary?: string }} texts
 * @returns {{ main: HTMLElement, primaryEl: HTMLElement, secondaryEl: HTMLElement }}
 */
export function paintNestedChildTexts(row, texts) {
    const primaryText = String(texts?.primary ?? '');
    const rawSecondary = String(texts?.secondary ?? '');
    const secondaryText = rawSecondary.replace(/\r?\n/g, ' ');

    const main = document.createElement('div');
    main.className = 'nd-nested-list__child-main';

    const primaryEl = document.createElement('div');
    primaryEl.className = 'nd-nested-list__child-key';
    primaryEl.textContent = primaryText;
    primaryEl.title = primaryText;

    const secondaryEl = document.createElement('div');
    secondaryEl.className = 'nd-nested-list__child-value';
    secondaryEl.textContent = secondaryText;
    secondaryEl.title = rawSecondary;

    main.append(primaryEl, secondaryEl);
    row.appendChild(main);
    return { main, primaryEl, secondaryEl };
}

/**
 * @param {object} parent
 * @param {(p: object) => string} [getId]
 * @returns {string}
 */
function parentIdOf(parent, getId) {
    if (typeof getId === 'function') return String(getId(parent) ?? '');
    if (parent?.id != null) return String(parent.id);
    return '';
}

/**
 * @param {object} parent
 * @param {(p: object) => string} [getLabel]
 * @returns {string}
 */
function parentLabelOf(parent, getLabel) {
    if (typeof getLabel === 'function') return String(getLabel(parent) ?? '');
    if (parent?.name != null) return String(parent.name);
    if (parent?.label != null) return String(parent.label);
    return parentIdOf(parent);
}

/**
 * 通用两层列表：父级（组/库）带启用开关与折叠；子级可虚拟化。
 *
 * 角色库：parents=组，children=角色。
 * 标签库：parents=库，children=条目；条目多时设 virtualizeChildren / virtualThreshold。
 *
 * @param {Element} root
 * @param {object} deps
 * @param {() => object[]} deps.getParents
 * @param {(parent: object) => object[]} deps.getChildren
 * @param {(parent: object) => string} [deps.getParentId]
 * @param {(parent: object) => string} [deps.getParentLabel]
 * @param {(parent: object) => boolean} [deps.isParentEnabled]
 * @param {(parent: object, enabled: boolean) => void} [deps.onParentEnabledChange]
 * @param {(child: object, el: HTMLElement, parent: object) => void} deps.renderChild
 * @param {(parent: object, el: HTMLElement) => void} [deps.renderParentMeta]
 * @param {(parentId: string) => boolean} [deps.isExpanded]
 * @param {(parentId: string, expanded: boolean) => void} [deps.onExpandedChange]
 * @param {boolean} [deps.virtualizeChildren=true]
 * @param {number} [deps.virtualThreshold=48]
 * @param {number} [deps.childRowHeight=NESTED_CHILD_ROW_HEIGHT]
 * @param {number} [deps.virtualListHeight=240]
 * @returns {{ destroy: () => void, refresh: () => void }}
 */
export function mountNestedList(root, deps) {
    if (!(root instanceof Element)) {
        throw new Error('mountNestedList: root must be an Element');
    }

    const getParents = typeof deps?.getParents === 'function' ? deps.getParents : () => [];
    const getChildren = typeof deps?.getChildren === 'function' ? deps.getChildren : () => [];
    const renderChild = typeof deps?.renderChild === 'function'
        ? deps.renderChild
        : () => {};
    const getParentId = deps?.getParentId;
    const getParentLabel = deps?.getParentLabel;
    const isParentEnabled = typeof deps?.isParentEnabled === 'function'
        ? deps.isParentEnabled
        : (p) => Boolean(p?.enabled ?? p?.active ?? true);
    const onParentEnabledChange = deps?.onParentEnabledChange;
    const renderParentMeta = deps?.renderParentMeta;
    const virtualizeChildren = deps?.virtualizeChildren !== false;
    const virtualThreshold = Math.max(0, Number(deps?.virtualThreshold) || 48);
    const childRowHeight = Math.max(1, Number(deps?.childRowHeight) || NESTED_CHILD_ROW_HEIGHT);
    const virtualListHeight = Math.max(childRowHeight * 3, Number(deps?.virtualListHeight) || 240);

    /** @type {Map<string, boolean>} */
    const localExpanded = new Map();

    /**
     * @param {string} id
     * @returns {boolean}
     */
    function readExpanded(id) {
        if (typeof deps?.isExpanded === 'function') {
            return Boolean(deps.isExpanded(id));
        }
        return localExpanded.get(id) === true;
    }

    /**
     * @param {string} id
     * @param {boolean} expanded
     */
    function writeExpanded(id, expanded) {
        if (typeof deps?.onExpandedChange === 'function') {
            deps.onExpandedChange(id, expanded);
        } else {
            localExpanded.set(id, expanded);
        }
    }

    const shell = document.createElement('div');
    shell.className = 'nd-nested-list';
    root.appendChild(shell);

    /** @type {{ destroy: () => void }[]} */
    let childHandles = [];
    /** @type {{ destroy: () => void }[]} */
    let toggleHandles = [];
    let destroyed = false;

    function clearHandles() {
        for (const h of childHandles) h.destroy();
        childHandles = [];
        for (const h of toggleHandles) h.destroy();
        toggleHandles = [];
    }

    /**
     * @param {object} parent
     * @param {HTMLElement} body
     */
    function mountChildren(parent, body) {
        const children = getChildren(parent) || [];
        if (!children.length) {
            const empty = document.createElement('div');
            empty.className = 'nd-nested-list__empty';
            empty.textContent = t('nested.emptyChildren');
            body.appendChild(empty);
            return;
        }

        const useVirtual = virtualizeChildren && children.length >= virtualThreshold;
        if (useVirtual) {
            const host = document.createElement('div');
            host.className = 'nd-nested-list__virtual';
            host.style.height = `${virtualListHeight}px`;
            body.appendChild(host);
            const handle = mountVirtualList(host, {
                getItems: () => getChildren(parent) || [],
                renderRow: (item, el) => {
                    el.classList.add('nd-nested-list__child');
                    renderChild(item, el, parent);
                },
                rowHeight: childRowHeight,
            });
            childHandles.push(handle);
            return;
        }

        for (const child of children) {
            const row = document.createElement('div');
            row.className = 'nd-nested-list__child';
            row.style.height = `${childRowHeight}px`;
            row.style.minHeight = `${childRowHeight}px`;
            row.style.maxHeight = `${childRowHeight}px`;
            row.style.overflow = 'hidden';
            renderChild(child, row, parent);
            body.appendChild(row);
        }
    }

    function paint() {
        if (destroyed) return;
        clearHandles();
        shell.replaceChildren();

        const parents = getParents() || [];
        if (!parents.length) {
            const empty = document.createElement('div');
            empty.className = 'nd-empty-lab';
            empty.textContent = t('nested.emptyParents');
            shell.appendChild(empty);
            return;
        }

        for (const parent of parents) {
            const id = parentIdOf(parent, getParentId);
            const label = parentLabelOf(parent, getParentLabel);
            const expanded = readExpanded(id);

            const block = document.createElement('section');
            block.className = 'nd-nested-list__parent';
            block.dataset.parentId = id;
            if (!isParentEnabled(parent)) {
                block.classList.add('is-disabled');
            }

            const header = document.createElement('div');
            header.className = 'nd-nested-list__header';

            const expandBtn = document.createElement('button');
            expandBtn.type = 'button';
            expandBtn.className = 'nd-nested-list__expand';
            const chevron = document.createElement('i');
            chevron.className = `fa-solid ${expanded ? 'fa-chevron-up' : 'fa-chevron-down'}`;
            chevron.setAttribute('aria-hidden', 'true');
            expandBtn.replaceChildren(chevron);
            expandBtn.setAttribute(
                'aria-label',
                expanded ? t('nested.collapse') : t('nested.expand'),
            );
            expandBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
            expandBtn.addEventListener('click', () => {
                writeExpanded(id, !readExpanded(id));
                paint();
            });

            const title = document.createElement('strong');
            title.className = 'nd-nested-list__title';
            title.textContent = label;

            header.append(expandBtn, title);

            if (typeof renderParentMeta === 'function') {
                const meta = document.createElement('div');
                meta.className = 'nd-nested-list__meta';
                renderParentMeta(parent, meta);
                header.appendChild(meta);
            }

            if (typeof onParentEnabledChange === 'function') {
                const toggle = createToggle({
                    label: t('library.enabled'),
                    checked: isParentEnabled(parent),
                    onChange: (v) => onParentEnabledChange(parent, v),
                });
                toggle.el.classList.add('nd-nested-list__enable');
                header.appendChild(toggle.el);
                toggleHandles.push(toggle);
            }

            block.appendChild(header);
            // 0.2.48：点条目标题本身也能展开/收起；按钮、开关等交互控件除外
            header.addEventListener('click', (e) => {
                const target = /** @type {any} */ (e?.target);
                if (target?.closest?.('button, input, label, a, select, textarea, .nd-toggle, .nd-toggle-row')) return;
                writeExpanded(id, !readExpanded(id));
                paint();
            });

            const body = document.createElement('div');
            body.className = 'nd-nested-list__children';
            if (!expanded) {
                body.classList.add('nd-hidden');
            } else {
                mountChildren(parent, body);
            }
            block.appendChild(body);
            shell.appendChild(block);
        }
    }

    paint();

    return {
        refresh() {
            paint();
        },
        destroy() {
            if (destroyed) return;
            destroyed = true;
            clearHandles();
            shell.remove();
            localExpanded.clear();
        },
    };
}
