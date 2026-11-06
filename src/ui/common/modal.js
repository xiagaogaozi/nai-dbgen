/**
 * L5 UI · 包一层酒馆 Popup（基线 §11）。
 * 归属：W1-E 组件代理实现。W0 仅冻结签名。
 *
 * 策略：优先走 HostPort.openModal（W1-B 已接 callGenericPopup / Popup.DISPLAY）；
 * 宿主无弹窗能力时降级为原生 <dialog>，保证管理台仍可打开。
 * destroy 只关本实例持有的 dialog（裁决 D30），不盲猜最后一个 open dialog。
 *
 * D52：作用域根用 class `.nd-root`，禁止用 id 全局查找作用域根。
 * D70：宿主 dialog / 原生 dialog 本身是唯一可见容器；内层 shell 只做布局。
 * 定位本弹窗：从调用方传入的 `element` 做 closest('dialog')——元素引用唯一，不会拿错实例。
 *
 * 标题与 × 同在 `.nd-popup-header` 一行；内容在 `.nd-popup-scroll`。
 * openModal 自建铬件，向宿主传空 title，避免宿主再套一层裸 h3。
 */

import { t } from '../i18n/zh-CN.js';

/**
 * @param {{ title: string, element: Element, footer?: Element, wide?: boolean, large?: boolean, allowVerticalScrolling?: boolean }} opts
 * @returns {HTMLElement}
 */
function buildRoot(opts) {
    const wrap = document.createElement('div');
    wrap.className = 'nd-root nd-modal-root';

    const header = document.createElement('div');
    header.className = 'nd-popup-header';
    if (opts?.title) {
        const h = document.createElement('h3');
        h.className = 'nd-modal-title';
        h.textContent = String(opts.title);
        header.appendChild(h);
    }
    wrap.appendChild(header);

    const scroll = document.createElement('div');
    scroll.className = 'nd-popup-scroll';
    if (opts?.element instanceof Element) {
        scroll.appendChild(opts.element);
    }
    wrap.appendChild(scroll);
    // 0.2.45：可选底栏，固定在滚动区下方（编辑弹窗的按钮行）
    if (opts?.footer instanceof Element) {
        opts.footer.classList.add('nd-popup-footer');
        wrap.appendChild(opts.footer);
    }
    return wrap;
}

/**
 * @param {Element|null|undefined} node
 * @returns {HTMLDialogElement|null}
 */
function closestDialog(node) {
    if (!(node instanceof Element)) {
        return null;
    }
    const dlg = node.closest('dialog');
    return dlg instanceof HTMLDialogElement ? dlg : null;
}

/**
 * @param {HTMLDialogElement|null} dlg
 */
function closeOwnedDialog(dlg) {
    if (!dlg) {
        return;
    }
    const closeBtn = dlg.querySelector('.popup-button-close, [data-nd-close], .nd-native-dialog__close');
    if (closeBtn instanceof HTMLElement) {
        closeBtn.click();
        return;
    }
    if (typeof dlg.close === 'function') {
        dlg.close();
    }
    if (dlg.classList.contains('nd-native-dialog')) {
        dlg.remove();
    }
}

/**
 * Duck-type element check（假 DOM 不是真实 HTMLElement）。
 * @param {unknown} node
 * @returns {boolean}
 */
function isDomElement(node) {
    return Boolean(
        node
        && typeof node === 'object'
        && (
            /** @type {{ nodeType?: number }} */ (node).nodeType === 1
            || typeof /** @type {{ appendChild?: unknown }} */ (node).appendChild === 'function'
            || typeof /** @type {{ tagName?: unknown }} */ (node).tagName === 'string'
        ),
    );
}

/**
 * 查 class（假 DOM 的 querySelector 恒 null，需 DFS 回退）。
 * @param {Element|null|undefined} root
 * @param {string} className
 * @returns {Element|null}
 */
function findByClass(root, className) {
    if (!isDomElement(root)) return null;
    const needle = String(className || '');
    if (typeof root.querySelector === 'function') {
        try {
            const hit = root.querySelector(`.${needle}`);
            if (hit) return /** @type {Element} */ (hit);
        } catch {
            // ignore
        }
    }
    if (root.classList?.contains(needle)) return /** @type {Element} */ (root);
    const kids = /** @type {{ childNodes?: Iterable<unknown> }} */ (root).childNodes;
    if (!kids) return null;
    for (const child of kids) {
        const hit = findByClass(/** @type {Element} */ (child), needle);
        if (hit) return hit;
    }
    return null;
}

/**
 * 关闭钮挂到 `.nd-popup-header` 行内右侧；找不到 header 时再退到 shell / dialog。
 * @param {HTMLDialogElement} dlg
 * @param {Element} closeBtn
 */
function mountCloseButton(dlg, closeBtn) {
    const header = findByClass(dlg, 'nd-popup-header');
    if (isDomElement(header)) {
        const parent = /** @type {{ parentNode?: Element|null, parentElement?: Element|null }} */ (closeBtn);
        if (parent.parentNode !== header && parent.parentElement !== header) {
            header.appendChild(closeBtn);
        }
        return;
    }
    const shell = findByClass(dlg, 'nd-native-dialog__shell');
    const mount = isDomElement(shell) ? shell : dlg;
    const parent = /** @type {{ parentNode?: Element|null, parentElement?: Element|null }} */ (closeBtn);
    if (parent.parentNode === mount || parent.parentElement === mount) return;
    if (typeof mount.insertBefore === 'function' && mount.firstChild) {
        mount.insertBefore(closeBtn, mount.firstChild);
    } else if (typeof mount.appendChild === 'function') {
        mount.appendChild(closeBtn);
    }
}

/**
 * D70：把宿主 / 原生 dialog 收成唯一可见容器；隐藏酒馆自带 ×，挂我们的关闭钮。
 * @param {HTMLDialogElement} dlg
 * @param {{ isNative?: boolean }} [opts]
 */
export function applyNdPopupChrome(dlg, opts = {}) {
    if (!isDomElement(dlg) || typeof dlg.classList?.add !== 'function') {
        return;
    }
    dlg.classList.add('nd-root', 'nd-popup');
    if (opts.isNative || dlg.classList.contains('nd-native-dialog')) {
        dlg.classList.add('nd-native-dialog');
    }

    const stClose = findByClass(dlg, 'popup-button-close');
    if (isDomElement(stClose) && stClose.style) {
        stClose.style.display = 'none';
        if (typeof stClose.setAttribute === 'function') {
            stClose.setAttribute('aria-hidden', 'true');
        }
        stClose.tabIndex = -1;
    }

    let closeBtn = findByClass(dlg, 'nd-native-dialog__close');
    if (!isDomElement(closeBtn)) {
        closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'nd-native-dialog__close';
        const closeIcon = document.createElement('i');
        closeIcon.className = 'fa-solid fa-xmark';
        if (typeof closeIcon.setAttribute === 'function') closeIcon.setAttribute('aria-hidden', 'true');
        closeBtn.appendChild(closeIcon);
        if (typeof closeBtn.setAttribute === 'function') {
            closeBtn.setAttribute('aria-label', t('common.close'));
            closeBtn.setAttribute('data-nd-close', '1');
        }
    }

    mountCloseButton(dlg, closeBtn);

    if (isDomElement(closeBtn) && !closeBtn.dataset?.ndCloseWired) {
        if (closeBtn.dataset) closeBtn.dataset.ndCloseWired = '1';
        if (typeof closeBtn.addEventListener === 'function') {
            closeBtn.addEventListener('click', (event) => {
                event?.preventDefault?.();
                event?.stopPropagation?.();
                if (isDomElement(stClose)) {
                    if (stClose.style) stClose.style.display = '';
                    if (typeof stClose.click === 'function') stClose.click();
                    if (stClose.style) stClose.style.display = 'none';
                    return;
                }
                if (typeof dlg.close === 'function') {
                    dlg.close();
                }
                if (dlg.classList?.contains('nd-native-dialog') && typeof dlg.remove === 'function') {
                    dlg.remove();
                }
            });
        }
    }
}

/**
 * 原生兜底：dialog 本身即唯一可见容器（D70）；shell 只布局。
 * 保留 contentRoot（.nd-modal-root）的 header + scroll 结构，不拆散子树。
 * @param {HTMLElement} contentRoot 已是 .nd-root.nd-modal-root
 * @param {string} title
 * @param {string|undefined} dialogClass
 * @returns {{ destroy: () => void, dialog: HTMLDialogElement }}
 */
function openNativeDialog(contentRoot, title, dialogClass) {
    const dlg = document.createElement('dialog');
    dlg.className = 'nd-native-dialog nd-root nd-popup';
    if (dialogClass) {
        dlg.classList.add(dialogClass);
    }
    dlg.setAttribute('aria-label', title || t('modal.fallbackTitle'));

    const shell = document.createElement('div');
    shell.className = 'nd-native-dialog__shell';

    const card = document.createElement('div');
    card.className = 'nd-native-dialog__card';
    card.appendChild(contentRoot);

    shell.appendChild(card);
    dlg.appendChild(shell);
    document.body.appendChild(dlg);

    applyNdPopupChrome(dlg, { isNative: true });

    let closed = false;
    const close = () => {
        if (closed) {
            return;
        }
        closed = true;
        if (typeof dlg.close === 'function') {
            dlg.close();
        }
        dlg.remove();
    };

    dlg.addEventListener('cancel', (event) => {
        event.preventDefault();
        close();
    });

    if (typeof dlg.showModal === 'function') {
        dlg.showModal();
    } else {
        dlg.setAttribute('open', '');
    }

    return { destroy: close, dialog: dlg };
}

/**
 * @param {object} deps
 * @param {import('../../ports/host.port.js').HostPort} deps.host
 * @param {{ title: string, element: Element, footer?: Element, wide?: boolean, large?: boolean, allowVerticalScrolling?: boolean, dialogClass?: string }} opts
 * @returns {Promise<{ destroy: () => void }>}
 */
export async function openModal(deps, opts) {
    const host = deps?.host;
    const title = opts?.title != null ? String(opts.title) : '';
    const element = opts?.element;
    if (!(element instanceof Element)) {
        throw new Error('openModal: opts.element must be an Element');
    }

    // 自建头部（标题 + 关闭槽）；宿主只挂节点，不再套裸 h3
    const wrap = buildRoot({ title, element, footer: opts?.footer });
    const dialogClass = opts?.dialogClass;
    /** @type {HTMLDialogElement|null} */
    let preparedDialog = null;
    /** @param {HTMLDialogElement} dlg */
    const prepareDialog = (dlg) => {
        if (preparedDialog === dlg) return;
        if (title && typeof dlg.setAttribute === 'function') {
            dlg.setAttribute('aria-label', title);
        }
        if (dialogClass) {
            dlg.classList.add(dialogClass);
        }
        applyNdPopupChrome(dlg);
        preparedDialog = dlg;
    };

    if (host && typeof host.openModal === 'function') {
        /** @type {{ title: string, element: Element, wide?: boolean, large?: boolean, allowVerticalScrolling?: boolean, prepareDialog: (dlg: HTMLDialogElement) => void }} */
        const hostOpts = { title: '', element: wrap, prepareDialog };
        // 裁决 D20：透传，不吞、不写死
        if (opts && Object.prototype.hasOwnProperty.call(opts, 'wide')) {
            hostOpts.wide = opts.wide;
        }
        if (opts && Object.prototype.hasOwnProperty.call(opts, 'large')) {
            hostOpts.large = opts.large;
        }
        if (opts && Object.prototype.hasOwnProperty.call(opts, 'allowVerticalScrolling')) {
            hostOpts.allowVerticalScrolling = opts.allowVerticalScrolling;
        }

        const pending = host.openModal(hostOpts);

        await Promise.resolve();
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });

        // D52：从本实例 element 向上找 dialog，不用 getElementById（多根会拿错）
        /** @type {HTMLDialogElement|null} */
        let ownedDialog = closestDialog(wrap);

        let destroyed = false;
        const destroy = () => {
            if (destroyed) {
                return;
            }
            destroyed = true;
            closeOwnedDialog(ownedDialog);
        };

        Promise.resolve(pending).catch(() => {});

        if (!ownedDialog) {
            const native = openNativeDialog(wrap, title, dialogClass);
            ownedDialog = native.dialog;
            return { destroy: native.destroy };
        }

        if (preparedDialog !== ownedDialog) {
            prepareDialog(ownedDialog);
        }
        return { destroy };
    }

    return openNativeDialog(wrap, title, dialogClass);
}
