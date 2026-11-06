/**
 * L5 UI · button / field / toggle / range / chip 工厂。
 * 归属：W1-E 组件代理实现。W0 仅冻结签名。
 */

import { t } from '../i18n/zh-CN.js';
import { bindDebouncedInput } from './debounced-input.js';

/**
 * @param {string} tag
 * @param {string} [className]
 * @returns {HTMLElement}
 */
function el(tag, className) {
    const node = document.createElement(tag);
    if (className) {
        node.className = className;
    }
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
 * @param {object} opts
 * @param {string} opts.label
 * @param {'primary'|'ghost'|'danger'|string} [opts.variant]
 * @param {() => void} [opts.onClick]
 * @returns {HTMLButtonElement}
 */
export function createButton(opts) {
    const label = opts?.label != null ? String(opts.label) : '';
    const variant = opts?.variant != null ? String(opts.variant) : 'ghost';
    /** @type {HTMLButtonElement} */
    const btn = /** @type {HTMLButtonElement} */ (el('button', 'nd-button'));
    btn.type = 'button';
    setText(btn, label);

    if (variant === 'primary') {
        btn.classList.add('nd-button--primary');
    } else if (variant === 'danger') {
        btn.classList.add('nd-button--danger');
    } else if (variant === 'icon') {
        btn.className = 'nd-icon-button';
    } else if (variant === 'text') {
        btn.className = 'nd-text-button';
    } else {
        btn.classList.add('nd-button--ghost');
    }

    if (typeof opts?.onClick === 'function') {
        btn.addEventListener('click', (event) => {
            event.preventDefault();
            opts.onClick();
        });
    }
    return btn;
}

/**
 * 卡底 / 嵌套列表行内统一小条按钮（浅粉底；danger 仅红字，非实心红底）。
 * @param {object} opts
 * @param {string} opts.label
 * @param {boolean} [opts.danger]
 * @param {string} [opts.action]
 * @param {() => void} [opts.onClick]
 * @returns {HTMLButtonElement}
 */
export function createMiniAction(opts) {
    const btn = createButton({
        label: opts?.label,
        variant: 'ghost',
        onClick: opts?.onClick,
    });
    btn.classList.add('nd-mini-action');
    if (opts?.danger) {
        btn.classList.add('nd-mini-action--danger');
    }
    if (opts?.action != null && String(opts.action) !== '') {
        btn.dataset.action = String(opts.action);
    }
    return btn;
}

/**
 * 分段标签（管理台子切换）：与 `.nd-shell__tab` 同一视觉体系；`role=tablist/tab` + 左右键。
 * @param {object} opts
 * @param {{ id: string, label: string }[]} opts.items
 * @param {string} [opts.value]
 * @param {(id: string) => void} [opts.onChange]
 * @param {string} [opts.storageKey] sessionStorage 记住上次选中
 * @param {string} [opts.ariaLabel]
 * @returns {{
 *   el: HTMLElement,
 *   getValue: () => string,
 *   setValue: (id: string) => void,
 *   destroy: () => void,
 * }}
 */
export function createSegmentedTabs(opts) {
    const items = Array.isArray(opts?.items) ? opts.items.filter((it) => it && it.id != null) : [];
    if (!items.length) {
        throw new Error('createSegmentedTabs: items required');
    }

    const storageKey = opts?.storageKey != null ? String(opts.storageKey) : '';
    let current = String(opts?.value ?? items[0].id);
    if (storageKey && typeof sessionStorage !== 'undefined') {
        try {
            const saved = sessionStorage.getItem(storageKey);
            if (saved && items.some((it) => String(it.id) === saved)) {
                current = saved;
            }
        } catch {
            // ignore
        }
    }
    if (!items.some((it) => String(it.id) === current)) {
        current = String(items[0].id);
    }

    const root = el('div', 'nd-segment');
    root.setAttribute('role', 'tablist');
    if (opts?.ariaLabel) {
        root.setAttribute('aria-label', String(opts.ariaLabel));
    }

    /** @type {HTMLButtonElement[]} */
    const buttons = [];

    /**
     * @param {string} id
     * @param {{ silent?: boolean }} [flags]
     */
    function select(id, flags = {}) {
        const next = String(id);
        if (!items.some((it) => String(it.id) === next)) return;
        current = next;
        for (const btn of buttons) {
            const on = btn.dataset.tab === current;
            btn.classList.toggle('is-active', on);
            btn.setAttribute('aria-selected', on ? 'true' : 'false');
            btn.tabIndex = on ? 0 : -1;
        }
        if (storageKey && typeof sessionStorage !== 'undefined') {
            try {
                sessionStorage.setItem(storageKey, current);
            } catch {
                // ignore
            }
        }
        if (!flags.silent && typeof opts?.onChange === 'function') {
            opts.onChange(current);
        }
    }

    for (const item of items) {
        const id = String(item.id);
        const btn = /** @type {HTMLButtonElement} */ (el('button', 'nd-button nd-segment__tab'));
        btn.type = 'button';
        btn.dataset.tab = id;
        btn.setAttribute('role', 'tab');
        setText(btn, item.label != null ? String(item.label) : id);
        btn.addEventListener('click', () => select(id));
        btn.addEventListener('keydown', (ev) => {
            if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight' && ev.key !== 'Home' && ev.key !== 'End') {
                return;
            }
            ev.preventDefault();
            const idx = items.findIndex((it) => String(it.id) === current);
            let nextIdx = idx;
            if (ev.key === 'ArrowLeft') {
                nextIdx = (idx - 1 + items.length) % items.length;
            } else if (ev.key === 'ArrowRight') {
                nextIdx = (idx + 1) % items.length;
            } else if (ev.key === 'Home') {
                nextIdx = 0;
            } else if (ev.key === 'End') {
                nextIdx = items.length - 1;
            }
            select(String(items[nextIdx].id));
            const focusBtn = buttons[nextIdx];
            if (focusBtn && typeof focusBtn.focus === 'function') {
                focusBtn.focus();
            }
        });
        root.appendChild(btn);
        buttons.push(btn);
    }

    select(current, { silent: true });

    return {
        el: root,
        getValue: () => current,
        setValue: (id) => select(String(id)),
        destroy: () => {
            root.remove();
        },
    };
}

/**
 * @param {object} opts
 * @param {string} opts.label
 * @param {string} [opts.value]
 * @param {(v: string) => void} [opts.onChange]
 * @returns {{ el: HTMLElement, getValue: () => string, setValue: (v: string) => void, destroy: () => void }}
 */
export function createField(opts) {
    const root = el('label', 'nd-field');
    const labelEl = el('span', 'nd-field__label');
    setText(labelEl, opts?.label != null ? String(opts.label) : '');
    /** @type {HTMLInputElement} */
    const input = /** @type {HTMLInputElement} */ (el('input', 'nd-input'));
    input.type = opts?.type ? String(opts.type) : 'text';
    input.value = opts?.value != null ? String(opts.value) : '';
    if (opts?.placeholder != null) {
        input.placeholder = String(opts.placeholder);
    }
    if (opts?.min != null) input.min = String(opts.min);
    if (opts?.max != null) input.max = String(opts.max);
    if (opts?.step != null) input.step = String(opts.step);

    /** @type {(v: string) => void} */
    const onChange = typeof opts?.onChange === 'function' ? opts.onChange : () => {};
    const handler = () => onChange(input.value);
    input.addEventListener('input', handler);

    root.append(labelEl, input);
    return {
        el: root,
        getValue: () => input.value,
        setValue: (v) => {
            input.value = v == null ? '' : String(v);
        },
        destroy: () => {
            input.removeEventListener('input', handler);
            root.remove();
        },
    };
}

/**
 * @param {object} opts
 * @param {string} opts.label
 * @param {string} [opts.value]
 * @param {string} [opts.placeholder]
 * @param {string} [opts.hint]
 * @param {number} [opts.rows]
 * @param {(v: string) => void} [opts.onChange]
 * @returns {{ el: HTMLElement, getValue: () => string, setValue: (v: string) => void, destroy: () => void }}
 */
export function createTextarea(opts) {
    const root = el('label', 'nd-field');
    const labelEl = el('span', 'nd-field__label');
    setText(labelEl, opts?.label != null ? String(opts.label) : '');
    /** @type {HTMLTextAreaElement} */
    const input = /** @type {HTMLTextAreaElement} */ (el('textarea', 'nd-input nd-textarea'));
    input.rows = Number(opts?.rows) > 0 ? Number(opts.rows) : 3;
    input.value = opts?.value != null ? String(opts.value) : '';
    if (opts?.placeholder != null) {
        input.placeholder = String(opts.placeholder);
    }
    const hint = opts?.hint != null && String(opts.hint)
        ? el('small', 'nd-field-hint')
        : null;
    if (hint) {
        setText(hint, String(opts.hint));
    }

    /** @type {(v: string) => void} */
    const onChange = typeof opts?.onChange === 'function' ? opts.onChange : () => {};
    const handler = () => onChange(input.value);
    input.addEventListener('input', handler);

    root.append(labelEl, input);
    if (hint) {
        root.append(hint);
    }
    return {
        el: root,
        getValue: () => input.value,
        setValue: (v) => {
            input.value = v == null ? '' : String(v);
        },
        destroy: () => {
            input.removeEventListener('input', handler);
            root.remove();
        },
    };
}

/**
 * 可搜索组合框：输入过滤；聚焦/点击展开列表（fixed 定位，弹层内不裁切）；
 * 键盘 ↑↓ 选中、Enter 确认、Esc 收起；列表外手输有效。
 *
 * @param {object} opts
 * @param {string} opts.label
 * @param {string} [opts.value]
 * @param {string} [opts.placeholder]
 * @param {string[]} [opts.options]
 * @param {HTMLElement} [opts.trailing] 贴在输入右侧的控件（如「获取模型」）
 * @param {(v: string) => void} [opts.onChange]
 * @returns {{
 *   el: HTMLElement,
 *   getValue: () => string,
 *   setValue: (v: string) => void,
 *   setOptions: (options: string[]) => void,
 *   open: () => void,
 *   close: () => void,
 *   destroy: () => void,
 * }}
 */
export function createCombobox(opts) {
    const root = el('div', 'nd-field nd-combobox');
    const labelEl = el('span', 'nd-field__label');
    setText(labelEl, opts?.label != null ? String(opts.label) : '');

    const row = el('div', 'nd-combobox__row');
    /** @type {HTMLInputElement} */
    const input = /** @type {HTMLInputElement} */ (el('input', 'nd-input nd-combobox__input'));
    input.type = 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.value = opts?.value != null ? String(opts.value) : '';
    if (opts?.placeholder != null) {
        input.placeholder = String(opts.placeholder);
    }
    row.appendChild(input);
    if (opts?.trailing instanceof HTMLElement) {
        const trail = el('div', 'nd-combobox__trail');
        trail.appendChild(opts.trailing);
        row.appendChild(trail);
    }

    /** @type {HTMLElement} */
    const list = el('ul', 'nd-combobox__list');
    list.setAttribute('role', 'listbox');
    list.hidden = true;

    root.append(labelEl, row);

    /** @type {string[]} */
    let allOptions = normalizeOptions(opts?.options);
    /** @type {string[]} */
    let filtered = [];
    let highlight = -1;
    let open = false;
    // 0.2.46：打开时先列全部选项；只有用户手动输入之后才按输入过滤
    let userTyped = false;

    /** @type {(v: string) => void} */
    const onChange = typeof opts?.onChange === 'function' ? opts.onChange : () => {};

    /**
     * @param {unknown} options
     * @returns {string[]}
     */
    function normalizeOptions(options) {
        if (!Array.isArray(options)) return [];
        return options.map((item) => {
            if (item == null) return '';
            if (typeof item === 'string' || typeof item === 'number') return String(item);
            if (typeof item === 'object') {
                if (/** @type {{value?: unknown}} */ (item).value != null) {
                    return String(/** @type {{value: unknown}} */ (item).value);
                }
                if (/** @type {{label?: unknown}} */ (item).label != null) {
                    return String(/** @type {{label: unknown}} */ (item).label);
                }
            }
            return String(item);
        }).filter(Boolean);
    }

    function emit() {
        onChange(input.value);
    }

    function filterOptions() {
        const q = userTyped ? input.value.trim().toLowerCase() : '';
        filtered = q
            ? allOptions.filter((id) => id.toLowerCase().includes(q))
            : [...allOptions];
        if (filtered.length > 500) {
            filtered = filtered.slice(0, 500);
        }
    }

    function renderList() {
        list.replaceChildren();
        if (filtered.length === 0) {
            const empty = el('li', 'nd-combobox__empty');
            setText(empty, allOptions.length ? '无匹配项，可直接手输' : '暂无列表，可直接手输');
            list.appendChild(empty);
            highlight = -1;
            return;
        }
        filtered.forEach((id, index) => {
            const item = el('li', 'nd-combobox__option');
            item.setAttribute('role', 'option');
            item.dataset.index = String(index);
            setText(item, id);
            if (index === highlight) {
                item.classList.add('is-active');
                item.setAttribute('aria-selected', 'true');
            }
            item.addEventListener('mousedown', (ev) => {
                ev.preventDefault();
                pick(id);
            });
            list.appendChild(item);
        });
    }

    function positionList() {
        const rect = typeof input.getBoundingClientRect === 'function'
            ? input.getBoundingClientRect()
            : { top: 0, bottom: 32, left: 0, right: 200, width: 200, height: 32 };
        const view = typeof window !== 'undefined' ? window : null;
        const vh = view?.innerHeight || 600;
        const spaceBelow = vh - rect.bottom;
        const maxH = Math.min(280, Math.max(120, spaceBelow > 160 ? spaceBelow - 8 : rect.top - 8));
        list.style.position = 'fixed';
        list.style.left = `${Math.round(rect.left)}px`;
        list.style.width = `${Math.round(rect.width)}px`;
        list.style.maxHeight = `${Math.round(maxH)}px`;
        // 0.2.48：浮层已拉到最高层，下拉列表再高一级才不会被盖住
        list.style.zIndex = '2147483002';
        if (spaceBelow < 140 && rect.top > spaceBelow) {
            list.style.top = 'auto';
            list.style.bottom = `${Math.round(vh - rect.top + 4)}px`;
        } else {
            list.style.bottom = 'auto';
            list.style.top = `${Math.round(rect.bottom + 4)}px`;
        }
    }

    function ensureListMounted() {
        if (list.parentNode) {
            return;
        }
        const host = root.closest('.nd-root') || document.body;
        host.appendChild(list);
    }

    function openList() {
        filterOptions();
        if (!userTyped) {
            const at = filtered.indexOf(input.value);
            if (at >= 0) highlight = at;
        }
        if (highlight < 0 && filtered.length) {
            highlight = 0;
        }
        renderList();
        ensureListMounted();
        positionList();
        list.hidden = false;
        open = true;
        root.classList.add('is-open');
    }

    function closeList() {
        list.hidden = true;
        open = false;
        highlight = -1;
        userTyped = false;
        root.classList.remove('is-open');
    }

    /**
     * @param {string} id
     */
    function pick(id) {
        input.value = id;
        emit();
        closeList();
        input.focus();
    }

    /**
     * @param {number} next
     */
    function moveHighlight(next) {
        if (!filtered.length) {
            highlight = -1;
            return;
        }
        highlight = ((next % filtered.length) + filtered.length) % filtered.length;
        renderList();
        const active = list.querySelector('.is-active');
        if (active && typeof active.scrollIntoView === 'function') {
            active.scrollIntoView({ block: 'nearest' });
        }
    }

    // 输入值立即回传；下拉过滤等停止输入后再做
    const onInput = () => {
        userTyped = true;
        emit();
    };
    const applyFilter = () => {
        filterOptions();
        highlight = filtered.length ? 0 : -1;
        if (!open) {
            openList();
        } else {
            renderList();
            positionList();
        }
    };

    const onFocus = () => {
        userTyped = false;
        openList();
    };
    const onClick = () => {
        if (open) return;
        userTyped = false;
        openList();
    };

    const onKeyDown = (ev) => {
        if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp' || ev.key === 'Enter') {
            filterDebounce.flush();
        }
        if (ev.key === 'ArrowDown') {
            ev.preventDefault();
            if (!open) openList();
            else moveHighlight(highlight + 1);
            return;
        }
        if (ev.key === 'ArrowUp') {
            ev.preventDefault();
            if (!open) openList();
            else moveHighlight(highlight - 1);
            return;
        }
        if (ev.key === 'Enter') {
            if (open && highlight >= 0 && filtered[highlight]) {
                ev.preventDefault();
                pick(filtered[highlight]);
            }
            return;
        }
        if (ev.key === 'Escape') {
            if (open) {
                ev.preventDefault();
                closeList();
            }
        }
    };

    const onDocPointer = (ev) => {
        if (!open) return;
        const t = /** @type {Node|null} */ (ev.target);
        if (t && (root.contains(t) || list.contains(t))) return;
        closeList();
    };

    const onScrollOrResize = () => {
        if (open) positionList();
    };

    const view = typeof window !== 'undefined' ? window : null;
    input.addEventListener('input', onInput);
    input.addEventListener('focus', onFocus);
    input.addEventListener('click', onClick);
    // keydown 先挂：方向键/回车时先 flush 过滤再处理
    input.addEventListener('keydown', onKeyDown);
    const filterDebounce = bindDebouncedInput(input, applyFilter, { runOnEnter: false });
    document.addEventListener('mousedown', onDocPointer, true);
    if (view) {
        view.addEventListener('resize', onScrollOrResize);
        view.addEventListener('scroll', onScrollOrResize, true);
    }

    return {
        el: root,
        getValue: () => input.value,
        setValue: (v) => {
            input.value = v == null ? '' : String(v);
        },
        setOptions: (options) => {
            allOptions = normalizeOptions(options);
            if (open) {
                filterOptions();
                highlight = filtered.length ? Math.min(highlight, filtered.length - 1) : -1;
                renderList();
                positionList();
            }
        },
        open: () => {
            input.focus();
            userTyped = false;
            openList();
        },
        close: closeList,
        destroy: () => {
            input.removeEventListener('input', onInput);
            input.removeEventListener('focus', onFocus);
            input.removeEventListener('click', onClick);
            input.removeEventListener('keydown', onKeyDown);
            filterDebounce.dispose();
            document.removeEventListener('mousedown', onDocPointer, true);
            if (view) {
                view.removeEventListener('resize', onScrollOrResize);
                view.removeEventListener('scroll', onScrollOrResize, true);
            }
            list.remove();
            root.remove();
        },
    };
}

/**
 * @param {object} opts
 * @param {string} opts.label
 * @param {string} [opts.hint] 标签下小字说明
 * @param {boolean} [opts.checked]
 * @param {(v: boolean) => void} [opts.onChange]
 * @returns {{ el: HTMLElement, getValue: () => boolean, setValue: (v: boolean) => void, destroy: () => void }}
 */
export function createToggle(opts) {
    const root = /** @type {HTMLLabelElement} */ (el('label', 'nd-toggle-row'));
    const text = el('span', 'nd-toggle-row__text');
    const strong = el('strong');
    setText(strong, opts?.label != null ? String(opts.label) : '');
    text.appendChild(strong);
    if (opts?.hint != null && String(opts.hint)) {
        const small = el('small');
        setText(small, String(opts.hint));
        text.appendChild(small);
    }

    /** @type {HTMLInputElement} */
    const input = /** @type {HTMLInputElement} */ (el('input'));
    input.type = 'checkbox';
    input.checked = Boolean(opts?.checked);
    const track = el('i');

    /** @type {(v: boolean) => void} */
    const onChange = typeof opts?.onChange === 'function' ? opts.onChange : () => {};
    const handler = () => onChange(input.checked);
    input.addEventListener('change', handler);

    root.append(text, input, track);
    return {
        el: root,
        getValue: () => input.checked,
        setValue: (v) => {
            input.checked = Boolean(v);
        },
        destroy: () => {
            input.removeEventListener('change', handler);
            root.remove();
        },
    };
}

/**
 * @param {object} opts
 * @param {string} opts.label
 * @param {number} opts.min
 * @param {number} opts.max
 * @param {number} [opts.value]
 * @param {(v: number) => void} [opts.onChange]
 * @returns {{ el: HTMLElement, getValue: () => number, setValue: (v: number) => void, destroy: () => void }}
 */
export function createRange(opts) {
    const min = Number(opts?.min);
    const max = Number(opts?.max);
    const initial = opts?.value != null ? Number(opts.value) : min;

    const root = el('label', 'nd-range-label');
    const head = el('span');
    const title = el('span');
    setText(title, opts?.label != null ? String(opts.label) : '');
    const output = el('output');
    setText(output, String(initial));
    head.append(title, output);

    /** @type {HTMLInputElement} */
    const input = /** @type {HTMLInputElement} */ (el('input', 'nd-range'));
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.value = String(initial);

    /** @type {(v: number) => void} */
    const onChange = typeof opts?.onChange === 'function' ? opts.onChange : () => {};
    const handler = () => {
        const n = Number(input.value);
        setText(output, String(n));
        onChange(n);
    };
    input.addEventListener('input', handler);

    root.append(head, input);
    return {
        el: root,
        getValue: () => Number(input.value),
        setValue: (v) => {
            const n = Number(v);
            input.value = String(n);
            setText(output, String(n));
        },
        destroy: () => {
            input.removeEventListener('input', handler);
            root.remove();
        },
    };
}

/**
 * @param {object} opts
 * @param {string} opts.label
 * @param {boolean} [opts.active]
 * @param {() => void} [opts.onClick]
 * @returns {HTMLButtonElement}
 */
export function createChip(opts) {
    /** @type {HTMLButtonElement} */
    const btn = /** @type {HTMLButtonElement} */ (el('button', 'nd-chip'));
    btn.type = 'button';
    setText(btn, opts?.label != null ? String(opts.label) : '');
    if (opts?.active) {
        btn.classList.add('is-active');
    }
    if (typeof opts?.onClick === 'function') {
        btn.addEventListener('click', (event) => {
            event.preventDefault();
            opts.onClick();
        });
    }
    return btn;
}

/**
 * @param {object} opts
 * @param {string} opts.label
 * @param {number} [opts.value]
 * @param {number} [opts.min]
 * @param {number} [opts.max]
 * @param {number} [opts.step]
 * @param {(v: number) => void} [opts.onChange]
 * @returns {{ el: HTMLElement, getValue: () => number, setValue: (v: number) => void, destroy: () => void }}
 */
export function createNumberField(opts) {
    const root = el('label', 'nd-field');
    const labelEl = el('span', 'nd-field__label');
    setText(labelEl, opts?.label != null ? String(opts.label) : '');
    /** @type {HTMLInputElement} */
    const input = /** @type {HTMLInputElement} */ (el('input', 'nd-input'));
    input.type = 'number';
    if (opts?.min != null) input.min = String(opts.min);
    if (opts?.max != null) input.max = String(opts.max);
    if (opts?.step != null) input.step = String(opts.step);
    input.value = opts?.value != null ? String(opts.value) : '';

    /** @type {(v: number) => void} */
    const onChange = typeof opts?.onChange === 'function' ? opts.onChange : () => {};
    const handler = () => onChange(Number(input.value));
    input.addEventListener('input', handler);

    root.append(labelEl, input);
    return {
        el: root,
        getValue: () => Number(input.value),
        setValue: (v) => {
            input.value = v == null ? '' : String(v);
        },
        destroy: () => {
            input.removeEventListener('input', handler);
            root.remove();
        },
    };
}

/**
 * @param {object} opts
 * @param {string} opts.label
 * @param {{ value: string|number, label: string }[]} opts.options
 * @param {string|number} [opts.value]
 * @param {boolean} [opts.disabled]
 * @param {(v: string) => void} [opts.onChange]
 * @returns {{
 *   el: HTMLElement,
 *   getValue: () => string,
 *   setValue: (v: string|number) => void,
 *   setOptions: (options: { value: string|number, label: string }[], keepValue?: string|number) => void,
 *   setDisabled: (disabled: boolean) => void,
 *   destroy: () => void,
 * }}
 */
export function createSelect(opts) {
    const root = el('label', 'nd-field');
    const labelEl = el('span', 'nd-field__label');
    setText(labelEl, opts?.label != null ? String(opts.label) : '');
    /** @type {HTMLSelectElement} */
    const select = /** @type {HTMLSelectElement} */ (el('select', 'nd-select'));

    /**
     * @param {{ value: string|number, label: string }[]} list
     * @param {string|number} [preferred]
     */
    function fillOptions(list, preferred) {
        const keep = preferred != null ? String(preferred) : select.value;
        select.replaceChildren();
        for (const item of list) {
            const option = document.createElement('option');
            option.value = String(item.value);
            setText(option, item.label != null ? String(item.label) : String(item.value));
            select.appendChild(option);
        }
        if (keep && [...select.options].some((o) => o.value === keep)) {
            select.value = keep;
        } else if (select.options.length > 0) {
            select.selectedIndex = 0;
        }
    }

    fillOptions(Array.isArray(opts?.options) ? opts.options : [], opts?.value);
    if (opts?.value != null) {
        select.value = String(opts.value);
    }
    select.disabled = opts?.disabled === true;

    /** @type {(v: string) => void} */
    const onChange = typeof opts?.onChange === 'function' ? opts.onChange : () => {};
    const handler = () => onChange(select.value);
    select.addEventListener('change', handler);

    root.append(labelEl, select);
    return {
        el: root,
        getValue: () => select.value,
        setValue: (v) => {
            select.value = v == null ? '' : String(v);
        },
        setOptions: (options, keepValue) => {
            fillOptions(Array.isArray(options) ? options : [], keepValue);
        },
        setDisabled: (disabled) => {
            select.disabled = Boolean(disabled);
            root.classList.toggle('is-disabled', Boolean(disabled));
        },
        destroy: () => {
            select.removeEventListener('change', handler);
            root.remove();
        },
    };
}

/**
 * @param {object} opts
 * @param {string} opts.label
 * @param {boolean} [opts.checked]
 * @param {(v: boolean) => void} [opts.onChange]
 * @returns {{ el: HTMLElement, getValue: () => boolean, setValue: (v: boolean) => void, destroy: () => void }}
 */
export function createCheckbox(opts) {
    const root = /** @type {HTMLLabelElement} */ (el('label', 'nd-checkbox-row'));
    /** @type {HTMLInputElement} */
    const input = /** @type {HTMLInputElement} */ (el('input'));
    input.type = 'checkbox';
    input.checked = Boolean(opts?.checked);
    const text = el('span');
    setText(text, opts?.label != null ? String(opts.label) : '');

    /** @type {(v: boolean) => void} */
    const onChange = typeof opts?.onChange === 'function' ? opts.onChange : () => {};
    const handler = () => onChange(input.checked);
    input.addEventListener('change', handler);

    root.append(input, text);
    return {
        el: root,
        getValue: () => input.checked,
        setValue: (v) => {
            input.checked = Boolean(v);
        },
        destroy: () => {
            input.removeEventListener('change', handler);
            root.remove();
        },
    };
}

/**
 * @param {object} opts
 * @param {string} [opts.title]
 * @param {HTMLElement[]} [opts.children]
 * @returns {{ el: HTMLElement, destroy: () => void }}
 */
export function createFieldGroup(opts) {
    const root = el('div', 'nd-field-group');
    if (opts?.title) {
        const title = el('h4', 'nd-field-group__title');
        setText(title, String(opts.title));
        root.appendChild(title);
    }
    const children = Array.isArray(opts?.children) ? opts.children : [];
    for (const child of children) {
        if (child instanceof HTMLElement) {
            root.appendChild(child);
        }
    }
    return {
        el: root,
        destroy: () => {
            root.remove();
        },
    };
}

/**
 * @param {object} opts
 * @param {string} opts.summary
 * @param {HTMLElement|HTMLElement[]} [opts.body]
 * @param {boolean} [opts.open]
 * @returns {{ el: HTMLElement, destroy: () => void }}
 */
export function createDetails(opts) {
    /** @type {HTMLDetailsElement} */
    const root = /** @type {HTMLDetailsElement} */ (el('details', 'nd-details'));
    root.open = Boolean(opts?.open);
    const summary = el('summary');
    setText(summary, opts?.summary != null ? String(opts.summary) : '');
    const body = el('div', 'nd-details__body');
    const content = opts?.body;
    if (Array.isArray(content)) {
        for (const child of content) {
            if (child instanceof HTMLElement) body.appendChild(child);
        }
    } else if (content instanceof HTMLElement) {
        body.appendChild(content);
    }
    root.append(summary, body);
    return {
        el: root,
        destroy: () => {
            root.remove();
        },
    };
}

/**
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} [opts.description]
 * @param {HTMLElement} [opts.action]
 * @returns {{ el: HTMLElement, destroy: () => void }}
 */
export function createEmptyState(opts) {
    const root = el('div', 'nd-empty');
    const title = el('h2', 'nd-empty__title');
    setText(title, opts?.title != null ? String(opts.title) : t('empty.title'));
    root.appendChild(title);
    if (opts?.description) {
        const desc = el('p', 'nd-empty__desc');
        setText(desc, String(opts.description));
        root.appendChild(desc);
    }
    if (opts?.action instanceof HTMLElement) {
        root.appendChild(opts.action);
    }
    return {
        el: root,
        destroy: () => {
            root.remove();
        },
    };
}

/**
 * @param {object} opts
 * @param {string} opts.label
 * @param {'idle'|'online'|'error'} [opts.status]
 * @returns {{ el: HTMLElement, setStatus: (s: 'idle'|'online'|'error') => void, setLabel: (s: string) => void, destroy: () => void }}
 */
export function createStatusPill(opts) {
    const root = el('div', 'nd-status-pill');
    const dot = el('i');
    const text = el('span');
    setText(text, opts?.label != null ? String(opts.label) : '');
    root.append(dot, text);

    /**
     * @param {'idle'|'online'|'error'} status
     */
    function setStatus(status) {
        root.classList.remove('is-online', 'is-error');
        if (status === 'online') root.classList.add('is-online');
        if (status === 'error') root.classList.add('is-error');
    }
    setStatus(opts?.status || 'idle');

    return {
        el: root,
        setStatus,
        setLabel: (s) => setText(text, s == null ? '' : String(s)),
        destroy: () => {
            root.remove();
        },
    };
}

/**
 * 0.2.48：令牌风格下拉框（替代原生 select，列表复用 combobox 样式）。
 * @param {object} opts
 * @param {{ value: string, label?: string }[]} opts.options
 * @param {string} [opts.value]
 * @param {string} [opts.ariaLabel]
 * @param {string} [opts.className]
 * @param {(v: string) => void} [opts.onChange]
 * @returns {{ el: HTMLButtonElement, getValue: () => string, setValue: (v: string) => void, destroy: () => void }}
 */
export function createTokenSelect(opts) {
    const options = (Array.isArray(opts?.options) ? opts.options : [])
        .filter((o) => o && o.value != null)
        .map((o) => ({ value: String(o.value), label: o.label != null ? String(o.label) : String(o.value) }));
    let value = opts?.value != null && options.some((o) => o.value === String(opts.value))
        ? String(opts.value)
        : (options[0]?.value ?? '');
    const onChange = typeof opts?.onChange === 'function' ? opts.onChange : () => {};

    const btn = /** @type {HTMLButtonElement} */ (el('button', `nd-select nd-token-select${opts?.className ? ` ${opts.className}` : ''}`));
    btn.type = 'button';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    if (opts?.ariaLabel) btn.setAttribute('aria-label', String(opts.ariaLabel));
    const text = el('span', 'nd-token-select__text');
    const icon = el('i', 'fa-solid fa-chevron-down nd-token-select__icon');
    icon.setAttribute('aria-hidden', 'true');
    btn.append(text, icon);

    const list = el('ul', 'nd-combobox__list nd-token-select__list');
    list.setAttribute('role', 'listbox');
    list.hidden = true;
    let open = false;

    function paintLabel() {
        const cur = options.find((o) => o.value === value);
        setText(text, cur ? cur.label : '');
    }

    function renderList() {
        list.replaceChildren();
        for (const o of options) {
            const item = el('li', 'nd-combobox__option');
            item.setAttribute('role', 'option');
            setText(item, o.label);
            if (o.value === value) {
                item.classList.add('is-active');
                item.setAttribute('aria-selected', 'true');
            }
            item.addEventListener('mousedown', (ev) => {
                ev.preventDefault();
                pick(o.value);
            });
            list.appendChild(item);
        }
    }

    function positionList() {
        const rect = typeof btn.getBoundingClientRect === 'function'
            ? btn.getBoundingClientRect()
            : { top: 0, bottom: 32, left: 0, right: 160, width: 160 };
        const vh = (typeof window !== 'undefined' && window.innerHeight) || 600;
        const vw = (typeof window !== 'undefined' && window.innerWidth) || 800;
        const width = Math.max(rect.width, 120);
        const spaceBelow = vh - rect.bottom;
        list.style.position = 'fixed';
        list.style.left = `${Math.round(Math.max(0, Math.min(rect.left, vw - width)))}px`;
        list.style.width = `${Math.round(width)}px`;
        list.style.maxHeight = `${Math.round(Math.min(280, Math.max(120, spaceBelow > 160 ? spaceBelow - 8 : rect.top - 8)))}px`;
        list.style.zIndex = '2147483002';
        if (spaceBelow < 140 && rect.top > spaceBelow) {
            list.style.top = 'auto';
            list.style.bottom = `${Math.round(vh - rect.top + 4)}px`;
        } else {
            list.style.bottom = 'auto';
            list.style.top = `${Math.round(rect.bottom + 4)}px`;
        }
    }

    function openList() {
        renderList();
        if (!list.parentNode) (btn.closest('.nd-root') || document.body).appendChild(list);
        positionList();
        list.hidden = false;
        open = true;
        btn.setAttribute('aria-expanded', 'true');
        btn.classList.add('is-open');
    }

    function closeList() {
        list.hidden = true;
        open = false;
        btn.setAttribute('aria-expanded', 'false');
        btn.classList.remove('is-open');
    }

    function pick(v) {
        closeList();
        if (v === value) return;
        value = v;
        paintLabel();
        onChange(value);
    }

    const onClick = () => (open ? closeList() : openList());
    const onKey = (ev) => {
        if (ev.key === 'Escape' && open) {
            ev.preventDefault();
            closeList();
        }
    };
    const onDocPointer = (ev) => {
        if (!open) return;
        const t = /** @type {Node|null} */ (ev.target);
        if (t && (btn.contains(t) || list.contains(t))) return;
        closeList();
    };
    const onScroll = (ev) => {
        if (open && !(ev?.target && list.contains(/** @type {Node} */ (ev.target)))) closeList();
    };
    btn.addEventListener('click', onClick);
    btn.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDocPointer, true);
    const view = typeof window !== 'undefined' ? window : null;
    view?.addEventListener('resize', closeList);
    view?.addEventListener('scroll', onScroll, true);
    paintLabel();

    return {
        el: btn,
        getValue: () => value,
        setValue: (v) => {
            const s = v == null ? '' : String(v);
            if (options.some((o) => o.value === s)) value = s;
            paintLabel();
        },
        destroy: () => {
            btn.removeEventListener('click', onClick);
            btn.removeEventListener('keydown', onKey);
            document.removeEventListener('mousedown', onDocPointer, true);
            view?.removeEventListener('resize', closeList);
            view?.removeEventListener('scroll', onScroll, true);
            list.remove();
            btn.remove();
        },
    };
}

/**
 * @param {object} [opts]
 * @param {string} [opts.message]
 * @returns {{ el: HTMLElement, setMessage: (msg: string) => void, clear: () => void, destroy: () => void }}
 */
export function createInlineError(opts) {
    const root = el('div', 'nd-inline-error');
    root.setAttribute('role', 'alert');
    root.setAttribute('aria-live', 'polite');
    setText(root, opts?.message != null ? String(opts.message) : '');
    return {
        el: root,
        setMessage: (msg) => setText(root, msg == null ? '' : String(msg)),
        clear: () => setText(root, ''),
        destroy: () => {
            root.remove();
        },
    };
}
