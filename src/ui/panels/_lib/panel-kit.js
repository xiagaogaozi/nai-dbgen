/**
 * 面板共享装配（DOM + Result 解包 + 确认框 + 导入弹层）。
 * 仅被 panels/ drawer 使用；不改冻结签名。
 */

import { createButton, createInlineError, createEmptyState } from '../../common/controls.js';
import { openModal } from '../../common/modal.js';
import { mountImportExport } from '../../common/import-export.js';
import { mergePluginSettings } from '../../../domain/model/plugin-settings.js';
import { newId } from '../../../infra/id.js';
import { nowIso } from '../../../infra/clock.js';
import { yieldMain } from '../../../infra/yield-main.js';
import { prepareImportCommit, pickAllowedSettingsPatch, formatErrorDisplay } from './library-logic.js';

/**
 * @param {string} tag
 * @param {string} [className]
 * @returns {HTMLElement}
 */
export function el(tag, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
}

/**
 * @param {HTMLElement} node
 * @param {string} text
 */
export function setText(node, text) {
    node.textContent = text == null ? '' : String(text);
}

/**
 * @param {{ ok: boolean, value?: unknown, error?: { message?: string, hint?: string } }} result
 * @returns {unknown}
 */
export function unwrapOrThrow(result) {
    if (result && result.ok) return result.value;
    throw new Error(formatErrorDisplay(result?.error, '操作失败'));
}

/**
 * @param {object} [host]
 * @param {'info'|'success'|'warning'|'error'} level
 * @param {string} message
 */
export function toast(host, level, message) {
    if (host && typeof host.toast === 'function') {
        host.toast(level, message);
    }
}

/**
 * D58：把 Result / AppError / 普通 Error 收成带 hint 的展示文案后 toast。
 * @param {object} [host]
 * @param {'info'|'success'|'warning'|'error'} level
 * @param {unknown} errOrMessage
 * @param {string} [fallback]
 */
export function toastError(host, errOrMessage, fallback = '操作失败') {
    toast(host, 'error', formatErrorDisplay(errOrMessage, fallback));
}

/**
 * @param {object} deps
 * @param {() => object} [deps.loadSettings]
 * @param {(s: object) => void} [deps.saveSettings]
 * @param {object} [deps.host]
 * @returns {{ load: () => object, save: (s: object) => void, patch: (partial: object) => object }}
 */
export function settingsApi(deps) {
    const load = () => {
        if (typeof deps?.loadSettings === 'function') return deps.loadSettings();
        if (deps?.host && typeof deps.host.loadSettings === 'function') {
            return deps.host.loadSettings();
        }
        return {};
    };
    const save = (s) => {
        if (typeof deps?.saveSettings === 'function') {
            deps.saveSettings(s);
            return;
        }
        if (deps?.host && typeof deps.host.saveSettings === 'function') {
            deps.host.saveSettings(s);
        }
    };
    return {
        load,
        save,
        patch(partial) {
            const allowed = pickAllowedSettingsPatch(partial);
            const next = mergePluginSettings(load(), /** @type {any} */ (allowed));
            save(next);
            return next;
        },
    };
}

/**
 * @param {object} deps
 * @returns {{ id: (prefix?: string) => string, now: () => string }}
 */
export function idNow(deps) {
    return {
        id: (prefix) => (typeof deps?.newId === 'function' ? deps.newId(prefix) : newId(prefix)),
        now: () => (typeof deps?.nowIso === 'function' ? deps.nowIso() : nowIso()),
    };
}

/**
 * D50：关窗 / 从 DOM 卸下时立即取消。
 * @param {Element} element
 * @param {() => void} onDismiss
 * @returns {() => void}
 */
export function watchModalDismiss(element, onDismiss) {
    /** @type {(() => void)[]} */
    const cleanups = [];

    const dlg = typeof element.closest === 'function'
        ? element.closest('dialog')
        : null;
    if (dlg instanceof HTMLDialogElement) {
        const onClose = () => onDismiss();
        dlg.addEventListener('close', onClose);
        dlg.addEventListener('cancel', onClose);
        cleanups.push(() => {
            dlg.removeEventListener('close', onClose);
            dlg.removeEventListener('cancel', onClose);
        });
    }

    if (typeof MutationObserver === 'function') {
        const obs = new MutationObserver(() => {
            if (!element.isConnected) onDismiss();
        });
        obs.observe(document.documentElement, { childList: true, subtree: true });
        cleanups.push(() => obs.disconnect());
    }

    return () => {
        for (const fn of cleanups) fn();
    };
}

/**
 * 异步确认框（单层 dialog）。禁止 window.confirm / alert / prompt。
 * @param {object} [deps]
 * @param {object} [deps.host]
 * @param {object} opts
 * @param {string} opts.message
 * @param {string} [opts.title='确认']
 * @param {string} [opts.okLabel='确认']
 * @param {string} [opts.cancelLabel='取消']
 * @param {'danger'|'primary'|'ghost'} [opts.okVariant='danger']
 * @returns {Promise<boolean>}
 */
export async function confirmAsk(deps, opts) {
    const host = deps?.host;
    const message = opts?.message != null ? String(opts.message) : '';
    const title = opts?.title != null ? String(opts.title) : '确认';
    const okLabel = opts?.okLabel != null ? String(opts.okLabel) : '确认';
    const cancelLabel = opts?.cancelLabel != null ? String(opts.cancelLabel) : '取消';
    const okVariant = opts?.okVariant === 'primary' || opts?.okVariant === 'ghost'
        ? opts.okVariant
        : 'danger';

    const body = el('div', 'nd-confirm');
    const p = el('p');
    setText(p, message);
    const actions = el('div', 'nd-confirm__actions');
    let resolved = false;
    /** @type {(v: boolean) => void} */
    let settle = () => {};
    const done = new Promise((resolve) => {
        settle = (v) => {
            if (resolved) return;
            resolved = true;
            resolve(v);
        };
    });

    const cancel = createButton({
        label: cancelLabel,
        variant: 'ghost',
        onClick: () => settle(false),
    });
    const ok = createButton({
        label: okLabel,
        variant: okVariant,
        onClick: () => settle(true),
    });
    actions.append(cancel, ok);
    body.append(p, actions);

    /** @type {{ destroy: () => void }|null} */
    let modal = null;
    /** @type {(() => void)|null} */
    let unwatch = null;
    try {
        modal = await openModal(
            { host },
            { title, element: body, dialogClass: 'nd-popup--compact' },
        );
        // D50：关窗立即 settle(false)，不用长超时
        unwatch = watchModalDismiss(body, () => settle(false));
        const result = await done;
        return Boolean(result);
    } finally {
        unwatch?.();
        modal?.destroy();
    }
}

/**
 * 删除二次确认（confirmAsk 包装）。
 * @param {object} deps
 * @param {object} [deps.host]
 * @param {string} message
 * @returns {Promise<boolean>}
 */
export async function confirmDanger(deps, message) {
    return confirmAsk(deps, {
        message: message == null ? '' : String(message),
        title: '确认删除',
        okLabel: '确认删除',
        cancelLabel: '取消',
        okVariant: 'danger',
    });
}

/**
 * 打开导入导出弹层；import 前必经 prepareImportCommit。
 * @param {object} deps
 * @param {object} [deps.host]
 * @param {string} title
 * @param {string} expectedKind
 * @param {(data: object|object[], strategy: string, progress?: { onProgress?: Function }) => Promise<object>} importJson
 * @param {(progress?: { onProgress?: Function }) => Promise<object|object[]>} exportJson
 * @param {() => void} [onDone]
 * @param {{
 *   allowBareArray?: boolean,
 *   onCancelIo?: () => void,
 *   autoImport?: { data: object|object[], strategy?: string },
 *   replaceOnly?: boolean,
 *   mode?: 'import'|'export',
 *   leading?: HTMLElement,
 *   countOverwrite?: (rows: object[]) => number|Promise<number>,
 *   overwriteMessage?: (count: number) => string,
 *   bindReload?: (reload: () => Promise<void>) => void,
 * }} [opts]
 * @returns {Promise<{ destroy: () => void }>}
 */
export async function openImportExportModal(deps, title, expectedKind, importJson, exportJson, onDone, opts) {
    const root = el('div', 'nd-import-modal');
    if (opts?.leading && typeof Element !== 'undefined' && opts.leading instanceof Element) {
        root.appendChild(opts.leading);
    }
    const err = createInlineError();
    root.appendChild(err.el);

    const progressEl = el('p', 'nd-muted nd-import-progress');
    progressEl.setAttribute('aria-live', 'polite');
    root.appendChild(progressEl);

    /**
     * @param {{ index: number, total: number, name?: string }|null} p
     */
    function setProgress(p) {
        const inline = root.querySelector('.nd-import-status');
        if (!p) {
            setText(progressEl, '');
            if (inline instanceof HTMLElement && inline.dataset.ndProgress === '1') {
                setText(inline, '');
                delete inline.dataset.ndProgress;
            }
            return;
        }
        const name = p.name ? ` · ${p.name}` : '';
        const line = `进度 ${p.index}/${p.total}${name}`;
        setText(progressEl, line);
        if (inline) {
            if (inline instanceof HTMLElement) inline.dataset.ndProgress = '1';
            setText(inline, line);
        }
    }

    /**
     * 与「导入已勾选」同一条提交路径（含进度）。
     * @param {object|object[]} data
     * @param {string} strategy
     * @returns {Promise<object>}
     */
    async function commitImport(data, strategy) {
        const prepared = prepareImportCommit(data, expectedKind);
        if (!prepared.ok) {
            err.setMessage(prepared.error);
            throw new Error(prepared.error);
        }
        try {
            setProgress({ index: 0, total: prepared.value.rows.length });
            // 先画出「进度 0/N」，再进入可能很重的 importJson（含大图）
            await yieldMain();
            const result = await importJson(prepared.value.data, strategy, {
                onProgress: (p) => setProgress(p),
            });
            err.clear();
            if (typeof onDone === 'function') onDone();
            toast(deps?.host, 'success', '导入完成');
            return result;
        } catch (e) {
            const msg = formatErrorDisplay(e, '导入失败');
            err.setMessage(msg);
            throw e;
        } finally {
            setProgress(null);
        }
    }

    const ioMode = opts?.mode === 'export' ? 'export' : 'import';
    const handle = mountImportExport(root, {
        mode: ioMode,
        exportJson: async () => {
            try {
                return await exportJson({
                    onProgress: (p) => setProgress(p),
                });
            } finally {
                setProgress(null);
            }
        },
        importJson: commitImport,
        replaceOnly: opts?.replaceOnly === true,
        countOverwrite: opts?.countOverwrite,
        confirmOverwrite: async (count) => confirmAsk(deps, {
            title: opts?.replaceOnly ? '替换标签超市' : '覆盖导入',
            message: opts?.replaceOnly
                ? `将用预览的完整文件替换当前标签超市（现有 ${count} 条记录）。`
                : (typeof opts?.overwriteMessage === 'function'
                    ? opts.overwriteMessage(count)
                    : `将覆盖 ${count} 条已有记录。`),
            okLabel: opts?.replaceOnly ? '确认替换' : '覆盖',
            cancelLabel: '取消',
            okVariant: 'danger',
        }),
    });

    if (typeof opts?.bindReload === 'function') {
        opts.bindReload(() => handle.reload());
    }

    if (typeof opts?.onCancelIo === 'function') {
        const cancelBtn = createButton({
            label: ioMode === 'export' ? '取消进行中的导出' : '取消进行中的导入',
            variant: 'ghost',
            onClick: () => opts.onCancelIo(),
        });
        root.appendChild(cancelBtn);
    }

    const modal = await openModal(
        { host: deps?.host },
        {
            title,
            element: root,
            wide: true,
            allowVerticalScrolling: true,
        },
    );

    if (opts?.autoImport?.data != null) {
        // 让弹层先上屏再导入；rAF 与短超时先到者继续（后台标签页 rAF 可能永不触发）
        await Promise.race([
            typeof requestAnimationFrame === 'function'
                ? new Promise((resolve) => {
                    requestAnimationFrame(() => resolve(undefined));
                })
                : Promise.resolve(),
            new Promise((resolve) => {
                setTimeout(resolve, 50);
            }),
        ]);
        const strategy = opts.autoImport.strategy || 'skip';
        try {
            await commitImport(opts.autoImport.data, strategy);
        } catch {
            // 错误已写进弹层
        }
    }

    return {
        destroy() {
            handle.destroy();
            err.destroy();
            modal.destroy();
        },
    };
}

/**
 * 编辑表单弹层：挂 body，返回 { destroy, body }。
 * @param {object} deps
 * @param {string} title
 * @param {HTMLElement} formEl
 * @returns {Promise<{ destroy: () => void, setError: (msg: string) => void }>}
 */
export async function openFormModal(deps, title, formEl) {
    const wrap = el('div', 'nd-form-modal');
    const err = createInlineError();
    wrap.append(err.el, formEl);
    const modal = await openModal(
        { host: deps?.host },
        {
            title,
            element: wrap,
            wide: true,
            allowVerticalScrolling: true,
        },
    );
    return {
        destroy() {
            err.destroy();
            modal.destroy();
        },
        setError(msg) {
            err.setMessage(formatErrorDisplay(msg, ''));
        },
    };
}

/**
 * @param {HTMLElement} host
 * @param {string} title
 * @param {string} [description]
 */
export function paintEmpty(host, title, description) {
    host.replaceChildren();
    const empty = createEmptyState({ title, description });
    host.appendChild(empty.el);
}

/**
 * Result 仓储调用 → 失败 toast（含 hint）。
 * @param {object} [host]
 * @param {Promise<{ ok: boolean, value?: any, error?: { message?: string, hint?: string } }>} promise
 * @param {string} [fallback]
 * @returns {Promise<any|null>}
 */
export async function awaitRepo(host, promise, fallback = '操作失败') {
    try {
        const r = await promise;
        if (r && r.ok) return r.value;
        toastError(host, r?.error, fallback);
        return null;
    } catch (e) {
        toastError(host, e, fallback);
        return null;
    }
}

/**
 * D55：付费按钮互斥执行。进行中禁用 + 文案反馈；结束（成功/失败/取消）后恢复。
 * @param {object} opts
 * @param {HTMLButtonElement} opts.button
 * @param {string} opts.idleLabel
 * @param {string} opts.busyLabel
 * @param {() => Promise<unknown>} opts.run
 * @returns {Promise<{ started: boolean, value?: unknown }>}
 */
export async function runExclusivePaidAction(opts) {
    const button = opts?.button;
    if (!(button instanceof HTMLButtonElement) && !(button && button.tagName === 'BUTTON')) {
        throw new Error('runExclusivePaidAction: button required');
    }
    if (button.disabled || button.dataset.ndBusy === '1') {
        return { started: false };
    }
    const idleLabel = opts.idleLabel != null ? String(opts.idleLabel) : (button.textContent || '');
    const busyLabel = opts.busyLabel != null ? String(opts.busyLabel) : '进行中…';
    button.dataset.ndBusy = '1';
    button.disabled = true;
    button.textContent = busyLabel;
    button.classList.add('is-busy');
    if (typeof button.setAttribute === 'function') {
        button.setAttribute('aria-busy', 'true');
    }
    try {
        const value = await opts.run();
        return { started: true, value };
    } finally {
        button.dataset.ndBusy = '0';
        button.disabled = false;
        button.textContent = idleLabel;
        button.classList.remove('is-busy');
        if (typeof button.removeAttribute === 'function') {
            button.removeAttribute('aria-busy');
        }
    }
}

/**
 * @param {string} label
 * @param {string} [value]
 * @param {number} [rows]
 * @returns {{ el: HTMLElement, getValue: () => string, setValue: (v: string) => void, destroy: () => void }}
 */
export function labeledTextarea(label, value = '', rows = 4) {
    const root = el('label', 'nd-field');
    const title = el('span', 'nd-field__label');
    setText(title, label);
    const ta = /** @type {HTMLTextAreaElement} */ (el('textarea', 'nd-textarea'));
    ta.rows = rows;
    ta.value = value == null ? '' : String(value);
    root.append(title, ta);
    return {
        el: root,
        getValue: () => ta.value,
        setValue: (v) => {
            ta.value = v == null ? '' : String(v);
        },
        destroy: () => {
            root.remove();
        },
    };
}
