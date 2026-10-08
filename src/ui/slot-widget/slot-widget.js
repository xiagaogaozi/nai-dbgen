/**
 * L5 UI · 楼层内 slot 控件：补类名、填按钮文案、塞图片、事件绑定。
 * 归属：W2-G 控件代理实现。W0 仅冻结签名。
 * 每个挂载函数须返回 { destroy }。
 *
 * 裁决：
 * - D35：本地视觉表只管外观；busy 优先问 isRendering / hasPendingWrite
 * - D36：视觉键带 chatId；切聊天清其它条目
 * - D40：类名常量来自 ./constants.js，不反向 import adapters
 * - D43：onGenerateClick 必须返回 Promise<Result>；非 Result 不清视觉表
 *
 * XSS：禁用 innerHTML；img.src 一律 safeImageUrl。
 * blob URL：由 getImageUrl 提供方（ImageRepository / W3）负责 create/revoke；本控件不自建 ObjectURL。
 */

import { APP_EVENTS } from '../../application/_helpers.js';
import { safeImageUrl } from '../common/safe-url.js';
import {
    ensureSlotUnprefixedClasses,
    hasClassToken,
    SLOT_BTN_CLASS,
    SLOT_IMG_CLASS,
    SLOT_ROOT_CLASS,
} from './constants.js';
import {
    classifyGenerateSettlement,
    deriveSlotUiView,
    latestImageEntry,
    recordHasImage,
    slotErrorTraceId,
} from './slot-states.js';
import {
    attachSlotInflightPromise,
    beginSlotInflight,
    clearSlotInflightOtherChats,
    peekSlotInflight,
    resolveSlotInflightAbort,
    resolveSlotInflightError,
    resolveSlotInflightOk,
    resolveVisualRuntime,
    watchSlotInflight,
} from './slot-mount.js';
import { openSlotImageViewer } from '../common/image-viewer.js';

/**
 * @typedef {object} SlotWidgetDeps
 * @property {(
 *   messageId: number,
 *   slotId: number,
 *   opts?: { signal?: AbortSignal, force?: boolean }
 * ) => Promise<{ ok: boolean, error?: unknown, value?: unknown }>} onGenerateClick
 *   D43：必须返回 Promise<Result>
 * @property {(messageId: number, slotId: number) => import('../../domain/model/slot.js').SlotRecord|null} getRecord
 * @property {(imageRef: string) => Promise<string|null>} getImageUrl
 * @property {() => (string|null)} [getChatId]
 * @property {(messageId: number, slotId: number) => boolean} [isRendering]
 *   D35：应用层闸门查询
 * @property {(messageId: number, slotId: number) => boolean} [hasPendingWrite]
 *   D35 / D42
 * @property {{ on: (type: string, fn: (payload: unknown) => void) => (() => void) }} [bus]
 * @property {import('../../ports/host.port.js').HostPort} [host]
 */

/**
 * @param {Element} root
 * @param {(el: Element) => boolean} pred
 * @returns {Element|null}
 */
function findDescendant(root, pred) {
    if (!root) {
        return null;
    }
    /** @type {Element[]} */
    const stack = [];
    const kids0 = /** @type {{ childNodes?: ArrayLike<Element> }} */ (root).childNodes;
    if (kids0) {
        for (let i = kids0.length - 1; i >= 0; i -= 1) {
            const child = kids0[i];
            if (child && typeof /** @type {{ tagName?: unknown }} */ (child).tagName === 'string') {
                stack.push(/** @type {Element} */ (child));
            }
        }
    }
    while (stack.length) {
        const cur = /** @type {Element} */ (stack.pop());
        if (pred(cur)) {
            return cur;
        }
        const kids = /** @type {{ childNodes?: ArrayLike<Element> }} */ (cur).childNodes;
        if (kids) {
            for (let i = kids.length - 1; i >= 0; i -= 1) {
                const child = kids[i];
                if (child && typeof /** @type {{ tagName?: unknown }} */ (child).tagName === 'string') {
                    stack.push(/** @type {Element} */ (child));
                }
            }
        }
    }
    return null;
}

/**
 * @param {Element} rootEl
 * @returns {{ btn: HTMLButtonElement, imgBox: HTMLElement, statusEl: HTMLElement, errEl: HTMLElement }}
 */
function ensureChrome(rootEl) {
    ensureSlotUnprefixedClasses(rootEl);
    rootEl.classList.add(SLOT_ROOT_CLASS);

    let btn = /** @type {HTMLButtonElement|null} */ (findDescendant(rootEl, (el) => {
        const tag = String(el.tagName || '').toUpperCase();
        if (tag === 'BUTTON') {
            return true;
        }
        return hasClassToken(el, SLOT_BTN_CLASS) || hasClassToken(el, 'nai-slot-btn');
    }));
    const doc = rootEl.ownerDocument || document;
    if (!btn) {
        btn = /** @type {HTMLButtonElement} */ (doc.createElement('button'));
        rootEl.appendChild(btn);
    }
    btn.classList.add(SLOT_BTN_CLASS);
    if (typeof btn.setAttribute === 'function') {
        btn.setAttribute('type', 'button');
    } else {
        /** @type {{ type?: string }} */ (btn).type = 'button';
    }

    let imgBox = /** @type {HTMLElement|null} */ (findDescendant(rootEl, (el) => (
        hasClassToken(el, SLOT_IMG_CLASS)
        || hasClassToken(el, 'nai-slot-img')
        || hasClassToken(el, 'custom-nai-slot-img')
    )));
    if (!imgBox) {
        imgBox = doc.createElement('div');
        rootEl.appendChild(imgBox);
    }
    imgBox.classList.add(SLOT_IMG_CLASS);
    setBlockShown(imgBox, false);

    let statusEl = /** @type {HTMLElement|null} */ (findDescendant(rootEl, (el) => (
        hasClassToken(el, 'nd-slot__status')
    )));
    if (!statusEl) {
        statusEl = doc.createElement('div');
        statusEl.className = 'nd-slot__status';
        statusEl.setAttribute('aria-live', 'polite');
        rootEl.appendChild(statusEl);
    }

    let errEl = /** @type {HTMLElement|null} */ (findDescendant(rootEl, (el) => (
        hasClassToken(el, 'nd-slot__error')
    )));
    if (!errEl) {
        errEl = doc.createElement('div');
        errEl.className = 'nd-slot__error';
        errEl.setAttribute('role', 'alert');
        errEl.hidden = true;
        errEl.style.display = 'none';
        rootEl.appendChild(errEl);
    }

    return { btn, imgBox, statusEl, errEl };
}

/**
 * @param {HTMLElement} imgBox
 * @param {string|null} url
 * @param {(event: Event) => void} onThumbClick
 * @returns {HTMLImageElement|null}
 */
/** 同一目标高度最多写两次。再写就会和宿主的高度脚本对顶，页面线程不再回来。 */
const MAX_FRAME_FIT_WRITES = 2;

/**
 * @param {HTMLElement} frame
 * @returns {number}
 */
function currentFrameHeight(frame) {
    const declared = Number.parseFloat(String(frame.style?.height || ''));
    if (Number.isFinite(declared) && declared > 0) {
        return Math.round(declared);
    }
    const box = typeof frame.getBoundingClientRect === 'function'
        ? frame.getBoundingClientRect().height
        : 0;
    return Math.round(Number(box) || 0);
}

/**
 * 按按钮这一块的实际高度收 iframe。
 * 不能用 body.scrollHeight：第一次渲染时正文被撑满整框，量出来的就是空行本身。
 * 高度已经对上就立刻停，避免和宿主互相改高度。
 * @param {Element} rootEl
 */
function fitHostFrameNow(rootEl) {
    const doc = rootEl?.ownerDocument;
    const frame = doc?.defaultView?.frameElement;
    if (!frame || !doc || rootEl.__ndFitting) {
        return;
    }
    rootEl.__ndFitting = true;
    try {
        const html = doc.documentElement;
        const body = doc.body;
        if (html) {
            html.style.height = 'auto';
            html.style.minHeight = '0';
            html.style.background = 'transparent';
            html.style.setProperty('overflow', 'hidden', 'important');
        }
        if (body) {
            body.style.margin = '0';
            body.style.height = 'auto';
            body.style.minHeight = '0';
            body.style.background = 'transparent';
            body.style.setProperty('overflow', 'hidden', 'important');
            void body.offsetHeight;
        }
        const top = rootEl.offsetTop || 0;
        const box = typeof rootEl.getBoundingClientRect === 'function'
            ? rootEl.getBoundingClientRect().height
            : rootEl.scrollHeight;
        const height = Math.ceil(top + (Number(box) || 0));
        if (!height) {
            return;
        }
        if (rootEl.__ndFitTarget !== height) {
            rootEl.__ndFitTarget = height;
            rootEl.__ndFitWrites = 0;
        }
        if (Math.abs(currentFrameHeight(frame) - height) <= 1) {
            return;
        }
        const writes = Number(rootEl.__ndFitWrites) || 0;
        if (writes >= MAX_FRAME_FIT_WRITES) {
            return;
        }
        rootEl.__ndFitWrites = writes + 1;
        frame.style.height = `${height}px`;
        frame.style.minHeight = '0';
        if (!frame.__ndFrameChrome) {
            frame.__ndFrameChrome = true;
            frame.style.setProperty('border', '0', 'important');
            frame.style.setProperty('background', 'transparent', 'important');
            frame.style.setProperty('display', 'block', 'important');
            frame.style.setProperty('overflow', 'hidden', 'important');
            frame.setAttribute('scrolling', 'no');
            const parent = frame.parentElement;
            const parentClass = String(parent?.className || '');
            if (parent && !/mes_text|mes_block/.test(parentClass)) {
                parent.style.setProperty('min-height', '0', 'important');
                parent.style.setProperty('padding', '0', 'important');
                parent.style.setProperty('border', '0', 'important');
                parent.style.setProperty('background', 'transparent', 'important');
            }
        }
    } finally {
        rootEl.__ndFitting = false;
    }
}

/**
 * 宿主会在我们量完之后再改一次高度。只补一次，高度对上就不再写。
 * @param {Element} rootEl
 */
function fitHostFrame(rootEl) {
    fitHostFrameNow(rootEl);
    const win = rootEl?.ownerDocument?.defaultView;
    if (!win || !rootEl) {
        return;
    }
    const prev = /** @type {{ raf?: number, timers?: number[] }} */ (rootEl.__ndFitTimers);
    if (prev) {
        if (prev.raf != null && typeof win.cancelAnimationFrame === 'function') {
            win.cancelAnimationFrame(prev.raf);
        }
        for (const id of prev.timers || []) {
            win.clearTimeout(id);
        }
    }
    /** @type {{ raf?: number, timers: number[] }} */
    const next = { timers: [] };
    if (typeof win.setTimeout === 'function') {
        next.timers.push(win.setTimeout(() => fitHostFrameNow(rootEl), 80));
    }
    rootEl.__ndFitTimers = next;
}

/**
 * @param {HTMLElement} el
 * @param {boolean} shown
 */
/**
 * @param {Element} rootEl
 * @param {HTMLElement} imgBox
 * @param {() => number} [readScale]
 */
function applyFloorImageScale(rootEl, imgBox, readScale) {
    let scale = 100;
    if (typeof readScale === 'function') {
        const n = Number(readScale());
        if (Number.isInteger(n) && n >= 20 && n <= 100) {
            scale = n;
        }
    }
    const width = `${scale}%`;
    if (rootEl?.style?.setProperty) {
        rootEl.style.setProperty('--nd-floor-image-width', width);
    }
    if (imgBox?.style?.setProperty) {
        imgBox.style.setProperty('width', width, 'important');
        imgBox.style.setProperty('max-width', width, 'important');
    }
}

function setBlockShown(el, shown) {
    el.hidden = !shown;
    el.style.display = shown ? '' : 'none';
}

function paintImage(imgBox, url, onThumbClick) {
    imgBox.replaceChildren();
    const safe = safeImageUrl(url);
    if (!safe) {
        setBlockShown(imgBox, false);
        return null;
    }
    setBlockShown(imgBox, true);
    const img = (imgBox.ownerDocument || document).createElement('img');
    img.className = 'nd-slot__thumb';
    img.alt = '';
    img.style.cssText = 'display:block;width:100%;height:auto;margin-top:8px';
    img.src = safe;
    img.addEventListener('click', onThumbClick);
    imgBox.appendChild(img);
    return img;
}

/**
 * 在已存在的 div[data-slot] 根上挂载（幂等：已 data-nai-mounted 则跳过或刷新）。
 * @param {Element} rootEl div[data-slot]
 * @param {number} messageId
 * @param {SlotWidgetDeps} deps
 * @returns {{ destroy: () => void, refresh: () => void }}
 */
export function mountSlotWidget(rootEl, messageId, deps) {
    if (!rootEl || typeof deps?.onGenerateClick !== 'function') {
        throw new Error('invalid argument: mountSlotWidget');
    }
    if (typeof deps.getRecord !== 'function' || typeof deps.getImageUrl !== 'function') {
        throw new Error('invalid argument: mountSlotWidget deps');
    }

    const slotIdRaw = rootEl.getAttribute?.('data-slot');
    const slotId = Number(slotIdRaw);
    if (!Number.isInteger(slotId) || slotId < 1) {
        throw new Error('invalid argument: data-slot');
    }

    const { btn, imgBox, statusEl, errEl } = ensureChrome(rootEl);

    let destroyed = false;
    /** @type {string|null} */
    let currentImageUrl = null;
    /** @type {(() => void)|null} */
    let unwatchInflight = null;
    /** @type {(() => void)|null} */
    let unsubBus = null;
    /** @type {(() => void)|null} */
    let unsubChat = null;
    /** @type {number} */
    let paintGeneration = 0;

    /**
     * @returns {string|null}
     */
    function resolveChatId() {
        if (typeof deps.getChatId === 'function') {
            const id = deps.getChatId();
            return id == null || id === '' ? null : String(id);
        }
        if (deps.host && typeof deps.host.getCurrentChatId === 'function') {
            const id = deps.host.getCurrentChatId();
            return id == null || id === '' ? null : String(id);
        }
        return null;
    }

    /**
     * @returns {boolean}
     */
    function appIsRendering() {
        return typeof deps.isRendering === 'function'
            ? Boolean(deps.isRendering(messageId, slotId))
            : false;
    }

    /**
     * @returns {boolean}
     */
    function appHasPendingWrite() {
        return typeof deps.hasPendingWrite === 'function'
            ? Boolean(deps.hasPendingWrite(messageId, slotId))
            : false;
    }

    /**
     * @param {string} stateClass
     */
    function applyStateClasses(stateClass) {
        rootEl.classList.remove(
            'nd-slot--idle',
            'nd-slot--generating',
            'nd-slot--done',
            'nd-slot--error',
            'nd-slot--beyond',
        );
        rootEl.classList.add(stateClass);
    }

    /**
     * @param {Event} [event]
     */
    function onThumbClick(event) {
        if (event && typeof event.preventDefault === 'function') {
            event.preventDefault();
        }
        if (destroyed || !currentImageUrl) {
            return;
        }
        const history = (deps.getRecord(messageId, slotId)?.images || [])
            .filter((item) => item?.imageRef);
        void openSlotImageViewer(
            { host: deps.host },
            {
                url: currentImageUrl,
                title: `图片 #${slotId} 历史`,
                images: history,
                initialIndex: history.length - 1,
                getImageUrl: deps.getImageUrl,
            },
        );
    }

    /**
     * @param {unknown} payload
     * @returns {boolean}
     */
    function busPayloadMatches(payload) {
        if (!payload || typeof payload !== 'object') {
            return false;
        }
        const p = /** @type {{ messageId?: unknown, slotId?: unknown, chatId?: unknown }} */ (payload);
        if (Number(p.messageId) !== Number(messageId) || Number(p.slotId) !== Number(slotId)) {
            return false;
        }
        const chatId = resolveChatId();
        if (p.chatId != null && chatId != null && String(p.chatId) !== String(chatId)) {
            return false;
        }
        return true;
    }

    /**
     * 外部出图（悬浮球 / auto-trigger）结算后刷新。
     * settle 事件在 usecase inflight 清表之后发出，此时 isRendering 已为 false。
     * @param {'ok'|'error'} kind
     * @param {unknown} [error]
     */
    function onExternalSettle(kind, error) {
        if (destroyed) {
            return;
        }
        const chatId = resolveChatId();
        if (kind === 'ok') {
            resolveSlotInflightOk(chatId, messageId, slotId);
        } else {
            const settled = { ok: false, error };
            const classified = classifyGenerateSettlement(settled);
            if (classified.kind === 'abort' || classified.kind === 'already') {
                resolveSlotInflightOk(chatId, messageId, slotId);
            } else if (classified.kind === 'invalid') {
                // D43：非 Result 形态的 error 载荷 → 不清表
                return;
            } else {
                const err = classified.kind === 'error' ? classified.error : error;
                const traceId = slotErrorTraceId(err, null);
                resolveSlotInflightError(chatId, messageId, slotId, err, traceId || null);
            }
        }
        void paintFromStore();
    }

    /**
     * @returns {Promise<void>}
     */
    async function paintFromStore() {
        if (destroyed) {
            return;
        }
        const gen = ++paintGeneration;
        const chatId = resolveChatId();
        const record = deps.getRecord(messageId, slotId);
        const meta = typeof deps.getSlotMeta === 'function'
            ? (deps.getSlotMeta(messageId, slotId) || {})
            : {};
        const runtime = {
            ...resolveVisualRuntime({
                chatId,
                messageId,
                slotId,
                appRendering: appIsRendering(),
                appPendingWrite: appHasPendingWrite(),
            }),
            beyondRetain: meta.beyondRetain === true,
            hasCachedImage: meta.hasCachedImage === true,
            loadError: meta.loadError === true,
            loadErrorMessage: meta.loadErrorMessage ?? null,
        };
        const entry = latestImageEntry(record);
        const cachedRef = !entry && meta.cachedImageRef
            ? String(meta.cachedImageRef)
            : null;
        const imageRef = entry?.imageRef || cachedRef;

        /** @type {string|null} */
        let url = null;
        let cacheMissing = false;
        if (imageRef) {
            try {
                url = await deps.getImageUrl(imageRef);
            } catch {
                url = null;
            }
            if (destroyed || gen !== paintGeneration) {
                return;
            }
            // 记录在 + 缓存无 → 未生图；beyond_retain 仅缓存图时 cache 没了走无图
            if (!url) {
                cacheMissing = entry != null;
            }
        }

        const view = deriveSlotUiView(record, {
            ...runtime,
            cacheMissing,
            hasCachedImage: Boolean(url) && runtime.hasCachedImage,
        });

        applyFloorImageScale(rootEl, imgBox, deps?.getFloorImageScale);
        applyStateClasses(view.stateClass);
        btn.textContent = view.buttonLabel;
        const clickable = view.canClick !== false && !view.busy;
        btn.disabled = !clickable;
        if (typeof btn.setAttribute === 'function') {
            btn.setAttribute('aria-busy', view.busy ? 'true' : 'false');
        }

        statusEl.textContent = view.busy && appHasPendingWrite() && !appIsRendering()
            ? '写入中…'
            : (view.state === 'beyond_retain' ? '已超出保留范围' : '');
        setBlockShown(statusEl, statusEl.textContent.length > 0);

        if (view.showError && view.errorMessage) {
            setBlockShown(errEl, true);
            errEl.style.margin = '0.35em 0 0';
            errEl.style.padding = '0';
            errEl.style.border = '0';
            errEl.style.background = 'transparent';
            errEl.replaceChildren();
            const msg = document.createElement('div');
            msg.className = 'nd-slot__error-msg';
            msg.textContent = view.errorMessage;
            errEl.appendChild(msg);
            if (view.traceId) {
                const tid = document.createElement('div');
                tid.className = 'nd-slot__error-trace';
                tid.textContent = `traceId: ${view.traceId}`;
                errEl.appendChild(tid);
            }
        } else {
            setBlockShown(errEl, false);
            errEl.replaceChildren();
        }

        if (!imageRef || !url || cacheMissing) {
            if (view.state !== 'generating') {
                paintImage(imgBox, null, onThumbClick);
                currentImageUrl = null;
            }
            fitHostFrame(rootEl);
            return;
        }

        currentImageUrl = url;
        const img = paintImage(imgBox, url, onThumbClick);
        img?.addEventListener('load', () => fitHostFrame(rootEl));
        fitHostFrame(rootEl);
    }

    function bindInflightWatch() {
        if (unwatchInflight) {
            unwatchInflight();
            unwatchInflight = null;
        }
        const chatId = resolveChatId();
        const entry = peekSlotInflight(chatId, messageId, slotId);
        if (!entry) {
            return;
        }
        unwatchInflight = watchSlotInflight(chatId, messageId, slotId, () => {
            if (!destroyed) {
                void paintFromStore();
            }
        });
    }

    /**
     * @returns {Promise<void>}
     */
    async function runGenerate() {
        if (destroyed) {
            return;
        }
        const chatId = resolveChatId();

        // 视觉：若本地已在 generating，只刷新；仍允许再次 onGenerateClick
        // （D35：应用层共享 Promise，不会双份扣费）
        const { entry, created } = beginSlotInflight(chatId, messageId, slotId);
        bindInflightWatch();
        await paintFromStore();

        // 本地已有进行中视觉且应用层也 busy → 不必再调（减少噪音）；否则仍调闸门
        if (!created && (appIsRendering() || appHasPendingWrite())) {
            return;
        }

        const record = deps.getRecord(messageId, slotId);
        const force = recordHasImage(record);
        const signal = entry.controller ? entry.controller.signal : undefined;

        const work = Promise.resolve().then(() => (
            deps.onGenerateClick(messageId, slotId, { signal, force })
        ));
        attachSlotInflightPromise(chatId, messageId, slotId, work);

        let settled;
        try {
            settled = await work;
        } catch (err) {
            settled = err;
        }

        // 切聊天后本键可能已清；用发起时的 chatId 结算
        const kind = classifyGenerateSettlement(settled);
        if (kind.kind === 'ok' || kind.kind === 'already') {
            // already = SLOT_ALREADY_RENDERED：闸门正常，不弹红
            resolveSlotInflightOk(chatId, messageId, slotId);
        } else if (kind.kind === 'abort') {
            resolveSlotInflightAbort(chatId, messageId, slotId);
        } else if (kind.kind === 'invalid') {
            // D43：非 Result → 不清表，保持 generating，避免再点再发
            return;
        } else {
            const err = kind.error;
            const traceId = slotErrorTraceId(err, null);
            resolveSlotInflightError(chatId, messageId, slotId, err, traceId || null);
        }

        if (!destroyed) {
            await paintFromStore();
        }
    }

    /**
     * @param {Event} [event]
     */
    function onBtnClick(event) {
        if (event && typeof event.preventDefault === 'function') {
            event.preventDefault();
        }
        if (event && typeof event.stopPropagation === 'function') {
            event.stopPropagation();
        }
        if (destroyed || btn.disabled) {
            return;
        }
        void runGenerate();
    }

    btn.addEventListener('click', onBtnClick);
    if (typeof btn.removeAttribute === 'function') {
        btn.removeAttribute('onclick');
    }

    /** @type {Array<() => void>} */
    const busUnsubs = [];
    if (deps.bus && typeof deps.bus.on === 'function') {
        busUnsubs.push(deps.bus.on(APP_EVENTS.SLOT_RENDERED, (payload) => {
            if (!busPayloadMatches(payload)) {
                return;
            }
            onExternalSettle('ok');
        }));
        busUnsubs.push(deps.bus.on(APP_EVENTS.SLOT_RENDER_FAILED, (payload) => {
            if (!busPayloadMatches(payload)) {
                return;
            }
            const p = /** @type {{ error?: unknown }} */ (payload);
            onExternalSettle('error', p.error);
        }));
        busUnsubs.push(deps.bus.on(APP_EVENTS.IMAGE_CACHE_TRIMMED, (payload) => {
            if (destroyed) {
                return;
            }
            const refs = Array.isArray(payload?.removedRefs) ? payload.removedRefs : [];
            if (!refs.length) {
                return;
            }
            const record = deps.getRecord(messageId, slotId);
            const meta = typeof deps.getSlotMeta === 'function'
                ? (deps.getSlotMeta(messageId, slotId) || {})
                : {};
            const entry = latestImageEntry(record);
            const currentRef = entry?.imageRef
                || (meta.cachedImageRef != null ? String(meta.cachedImageRef) : null);
            if (!currentRef) {
                return;
            }
            const hit = refs.some((r) => String(r) === currentRef);
            if (hit) {
                void paintFromStore();
            }
        }));
        unsubBus = () => {
            for (const off of busUnsubs) {
                try {
                    off();
                } catch {
                    // ignore
                }
            }
            busUnsubs.length = 0;
        };
    }

    if (deps.host && typeof deps.host.onChatChanged === 'function') {
        unsubChat = deps.host.onChatChanged((nextChatId) => {
            clearSlotInflightOtherChats(nextChatId);
            if (!destroyed) {
                void paintFromStore();
            }
        });
    }

    // 挂载时先按当前 chat 清掉其它聊天残留（D36）
    clearSlotInflightOtherChats(resolveChatId());

    if (peekSlotInflight(resolveChatId(), messageId, slotId) || appIsRendering() || appHasPendingWrite()) {
        bindInflightWatch();
    }

    void paintFromStore();

    return {
        refresh() {
            if (destroyed) {
                return;
            }
            void paintFromStore();
        },
        destroy() {
            if (destroyed) {
                return;
            }
            destroyed = true;
            btn.removeEventListener('click', onBtnClick);
            if (unsubBus) {
                unsubBus();
                unsubBus = null;
            }
            if (unsubChat) {
                unsubChat();
                unsubChat = null;
            }
            if (unwatchInflight) {
                unwatchInflight();
                unwatchInflight = null;
            }
            currentImageUrl = null;
            // 不清应用层闸门；不清本 chat 视觉 generating（remount 可附着）
        },
    };
}
