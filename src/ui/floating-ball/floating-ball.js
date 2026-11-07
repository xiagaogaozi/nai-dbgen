/**
 * L5 UI · 悬浮球入口（单击配置 / 双击本楼生图 / 长按切换画师串）。
 * 装配（挂 body、接容器）由 bootstrap 代理完成；本模块只导出 mountFloatingBall。
 */

import { isOk, isErr } from '../../infra/result.js';
import { mergePluginSettings, isQuickConfigItemVisible } from '../../domain/model/plugin-settings.js';
import { createButton, createEmptyState, createTokenSelect } from '../common/controls.js';
import { paintSafeCover } from '../common/safe-url.js';
import { bindDebouncedInput } from '../common/debounced-input.js';
import {
    artistMatchesModelFilter,
    createArtistModelTagFilter,
} from '../common/artist-model-tags.js';
import { filterSortItems } from '../panels/_lib/library-logic.js';
import { mountDrawer } from '../drawer/drawer.js';
import {
    createGestureRecognizer,
    GESTURE_DOUBLE_TAP_MS,
    GESTURE_LONG_PRESS_MS,
    GESTURE_TAP_SLOP,
} from './gesture.js';
import {
    FAB_POS_STORAGE_KEY,
    computePanelPlacement,
    defaultFabPos,
    deserializeFabPos,
    pixelToStored,
    serializeFabPos,
    storedToPixel,
    clamp,
    clampToViewport,
    freePlace,
} from './position.js';

/** 球直径（px）；触控目标 ≥44 */
export const FAB_SIZE_PX = 40;

/** 浮层最大宽度 */
const PANEL_MAX_WIDTH = 360;

/** 忙碌态轮询间隔下限（ms） */
const BUSY_POLL_MS = 500;

/**
 * 本楼生图成功摘要。形状以 application/generate-floor.usecase.js 为准。
 *
 * @typedef {object} GenerateFloorSummary
 * @property {number} messageId
 * @property {boolean} wroteSlots
 * @property {number[]} rendered
 * @property {{ slotId: number, reason: string }[]} skipped
 * @property {{ slotId: number, message: string }[]} failed
 */

/**
 * @typedef {import('../../domain/model/plugin-settings.js').PluginSettings} PluginSettings
 */

/**
 * @typedef {object} FloatingBallDeps
 * @property {() => PluginSettings} loadSettings
 * @property {(settings: PluginSettings) => void} saveSettings
 * @property {(fn: () => void) => () => void} [subscribeSettings]
 * @property {object} repos
 *   至少含 `artist`；其余字段原样传给 `mountDrawer`。
 * @property {(fn: () => void) => (() => void)|void} [onSettingsChange]
 *   只给悬浮球自己用：设置变了就重读 hideFloatingBall（常规设置里改了立刻生效）。不传给抽屉。
 * @property {() => void|Promise<void>} openManagement
 * @property {() => Promise<{ ok: true, value: GenerateFloorSummary } | { ok: false, error: unknown }>} generateFloor
 * @property {() => boolean} [isFloorBusy]
 * @property {(level: 'success'|'error'|'info'|'warning'|string, message: string) => void} toast
 * @property {(err: unknown) => string} formatError
 * @property {{
 *   urlOf: (ref: string|null|undefined, version?: string|number|null) => string|null,
 *   cardUrl: (item: object|null|undefined) => string|null,
 *   referenceUrl: (item: object|null|undefined) => string|null,
 * }} [artistFileUrl]
 *   画师串卡片图 URL（服务端文件 + ?v=）；切换画师串面板必注入。
 * @property {{ getItem: (k: string) => string|null, setItem: (k: string, v: string) => void }} [storage]
 *   默认 `window.localStorage`；读写失败静默降级。
 */

/**
 * @typedef {object} FloatingBallHandle
 * @property {() => void} destroy
 * @property {() => void} closePanels
 */

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
 * 内联调色板 SVG（不依赖 Font Awesome）。
 * @returns {SVGElement|HTMLElement}
 */
function createPaletteIcon() {
    const NS = 'http://www.w3.org/2000/svg';
    /** @type {SVGElement|HTMLElement} */
    let svg;
    if (typeof document.createElementNS === 'function') {
        svg = document.createElementNS(NS, 'svg');
    } else {
        svg = /** @type {HTMLElement} */ (document.createElement('svg'));
    }
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '20');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'nd-fab__icon');

    /**
     * @param {string} name
     * @param {Record<string, string>} attrs
     * @returns {Element}
     */
    function child(name, attrs) {
        /** @type {Element} */
        let node;
        if (typeof document.createElementNS === 'function') {
            node = document.createElementNS(NS, name);
        } else {
            node = document.createElement(name);
        }
        for (const [k, v] of Object.entries(attrs)) {
            node.setAttribute(k, v);
        }
        svg.appendChild(node);
        return node;
    }

    child('path', {
        fill: '#ffffff',
        d: 'M12 3c-4.4 0-8 3.1-8 7 0 2.4 1.4 4.5 3.5 5.7.3.2.5.5.5.9v.9c0 1.1.9 2 2 2h.5c.6 0 1.1-.4 1.3-.9.3-.7 1-1.1 1.7-1.1h.5c3.6 0 6.5-2.9 6.5-6.5C20.5 5.9 16.6 3 12 3z',
    });
    child('circle', { cx: '8.5', cy: '9.2', r: '1.15', fill: '#ffffff', opacity: '0.95' });
    child('circle', { cx: '12', cy: '7.4', r: '1.15', fill: '#ffffff', opacity: '0.9' });
    child('circle', { cx: '15.5', cy: '9.2', r: '1.15', fill: '#ffffff', opacity: '0.85' });
    child('circle', { cx: '13.8', cy: '12.4', r: '1.05', fill: '#ffffff', opacity: '0.8' });
    return svg;
}

/**
 * @param {GenerateFloorSummary} summary
 * @returns {{ level: string, message: string }}
 */
export function formatGenerateFloorToast(summary) {
    if (summary?.confirmationRequired) return {
        level: 'warning', message: '本楼已有图片，再次启动将从写提示词重跑并消耗额度',
    };
    const floor = Number(summary?.messageId);
    const floorLabel = Number.isFinite(floor) ? String(floor) : '?';
    const failed = Array.isArray(summary?.failed) ? summary.failed : [];
    const rendered = Array.isArray(summary?.rendered) ? summary.rendered : [];
    const wroteSlots = summary?.wroteSlots === true;

    if (failed.length > 0) {
        return {
            level: 'warning',
            message: `第 ${floorLabel} 楼：${failed.length} 张图生成失败`,
        };
    }
    if (!wroteSlots && rendered.length === 0) {
        return {
            level: 'info',
            message: `第 ${floorLabel} 楼的图都已生成过了`,
        };
    }
    return {
        level: 'success',
        message: `第 ${floorLabel} 楼：生成 ${rendered.length} 条提示词，出图 ${rendered.length} 张`,
    };
}

/**
 * @param {Element} el
 * @returns {{ left: number, top: number, right: number, bottom: number, width: number, height: number }}
 */
function readRect(el) {
    if (el && typeof /** @type {any} */ (el).getBoundingClientRect === 'function') {
        const r = /** @type {any} */ (el).getBoundingClientRect();
        return {
            left: Number(r.left) || 0,
            top: Number(r.top) || 0,
            right: Number(r.right) || 0,
            bottom: Number(r.bottom) || 0,
            width: Number(r.width) || FAB_SIZE_PX,
            height: Number(r.height) || FAB_SIZE_PX,
        };
    }
    return { left: 0, top: 0, right: FAB_SIZE_PX, bottom: FAB_SIZE_PX, width: FAB_SIZE_PX, height: FAB_SIZE_PX };
}

/**
 * @returns {{ w: number, h: number }}
 */
function viewportSize() {
    // iPhone Safari：地址栏 / 键盘收放时 innerHeight 不准，优先用 visualViewport
    const vv = typeof window !== 'undefined' ? /** @type {any} */ (window).visualViewport : null;
    if (vv && Number(vv.width) > 0 && Number(vv.height) > 0) {
        return { w: Number(vv.width), h: Number(vv.height) };
    }
    const w =
        (typeof window !== 'undefined' && Number(window.innerWidth)) ||
        (typeof globalThis !== 'undefined' && Number(/** @type {any} */ (globalThis).innerWidth)) ||
        1024;
    const h =
        (typeof window !== 'undefined' && Number(window.innerHeight)) ||
        (typeof globalThis !== 'undefined' && Number(/** @type {any} */ (globalThis).innerHeight)) ||
        768;
    return { w: w > 0 ? w : 1024, h: h > 0 ? h : 768 };
}

/**
 * @param {FloatingBallDeps['storage']|null|undefined} storage
 * @param {string} key
 * @returns {string|null}
 */
function storageGet(storage, key) {
    try {
        if (!storage || typeof storage.getItem !== 'function') return null;
        return storage.getItem(key);
    } catch {
        return null;
    }
}

/**
 * @param {FloatingBallDeps['storage']|null|undefined} storage
 * @param {string} key
 * @param {string} value
 */
function storageSet(storage, key, value) {
    try {
        if (!storage || typeof storage.setItem !== 'function') return;
        storage.setItem(key, value);
    } catch {
        // 静默降级
    }
}

/**
 * 画师串封面：只用卡片图（经注入的 artistFileUrl）。
 * @param {object|null|undefined} item
 * @param {{ cardUrl?: (item: object|null|undefined) => string|null }|null|undefined} artistFileUrl
 * @returns {string|null}
 */
function resolveArtistCardUrl(item, artistFileUrl) {
    if (!artistFileUrl || typeof artistFileUrl.cardUrl !== 'function') {
        return Promise.resolve(null);
    }
    return Promise.resolve(artistFileUrl.cardUrl(item)).then((raw) => (
        raw == null || String(raw).trim() === '' ? null : String(raw)
    ));
}

/**
 * 挂载悬浮球。
 * @param {Element} root
 * @param {FloatingBallDeps} deps
 * @returns {FloatingBallHandle}
 */
export function mountFloatingBall(root, deps) {
    if (!(root instanceof Element)) {
        throw new Error('mountFloatingBall: root must be an Element');
    }
    if (typeof deps?.loadSettings !== 'function' || typeof deps?.saveSettings !== 'function') {
        throw new Error('mountFloatingBall: loadSettings/saveSettings required');
    }
    if (typeof deps?.generateFloor !== 'function') {
        throw new Error('mountFloatingBall: generateFloor required');
    }
    if (typeof deps?.toast !== 'function' || typeof deps?.formatError !== 'function') {
        throw new Error('mountFloatingBall: toast/formatError required');
    }

    const storage =
        deps.storage ||
        (typeof window !== 'undefined' && window.localStorage ? window.localStorage : null);

    /** @type {string} */
    const hostClass = 'nd-fab-host';
    if (root instanceof HTMLElement || (root && /** @type {any} */ (root).classList)) {
        /** @type {any} */ (root).classList.add(hostClass);
    }

    let destroyed = false;
    /** @type {'none'|'config'|'artist'} */
    let openPanel = 'none';
    /** @type {{ destroy: () => void }|null} */
    let drawerHandle = null;
    /** @type {(() => void)|null} 浮层关闭时的额外清理（如令牌下拉框的全局监听） */
    let panelCleanup = null;
    /** @type {HTMLElement|null} */
    let panelEl = null;
    /** @type {Map<string, string|null>} itemId → 已过白名单的 src（或 null 占位） */
    const coverUrlCache = new Map();
    let floorBusyLocal = false;
    /** @type {ReturnType<typeof setInterval>|null} */
    let busyPollTimer = null;
    /** @type {number} */
    let dragOffsetX = 0;
    /** @type {number} */
    let dragOffsetY = 0;
    /** @type {{ x: number, y: number, side: 'left'|'right' }} */
    let pos = defaultFabPos(FAB_SIZE_PX, viewportSize().w, viewportSize().h);

    const stored = deserializeFabPos(storageGet(storage, FAB_POS_STORAGE_KEY));
    /** 最近一次存下的位置记录；窗口尺寸变化时按它的比例重算（0.2.46 不再吸边） */
    let lastStored = stored;
    /**
     * 拖动期间锁定浮层在球的哪一侧、向上还是向下展开，避免拖过中线时跳边。
     * @type {{ side: 'left'|'right', preferBelow: boolean }|null}
     */
    let placementLock = null;
    if (stored) {
        const restored = storedToPixel(stored, FAB_SIZE_PX, viewportSize().w, viewportSize().h);
        if (restored) pos = restored;
    }

    const ball = /** @type {HTMLElement} */ (el('button', 'nd-fab'));
    ball.type = 'button';
    ball.setAttribute('role', 'button');
    ball.tabIndex = 0;
    const a11y = '酒馆数据库生图：单击配置，双击本楼生图，长按切换画师串';
    ball.setAttribute('aria-label', a11y);
    ball.title = a11y;
    ball.style.touchAction = 'none';
    ball.appendChild(createPaletteIcon());

    const busyRing = el('span', 'nd-fab__busy-ring');
    busyRing.setAttribute('aria-hidden', 'true');
    ball.appendChild(busyRing);

    root.appendChild(ball);

    /**
     * @returns {void}
     */
    function applyBallPos() {
        ball.style.left = `${pos.x}px`;
        ball.style.top = `${pos.y}px`;
        ball.dataset.side = pos.side;
    }

    /**
     * @returns {void}
     */
    function persistPos() {
        const { w, h } = viewportSize();
        const storedPos = pixelToStored(pos, FAB_SIZE_PX, h, w);
        lastStored = /** @type {any} */ (storedPos);
        storageSet(storage, FAB_POS_STORAGE_KEY, serializeFabPos(/** @type {any} */ (storedPos)));
    }

    /**
     * 锁定当前浮层的展开方向（浮层打开时才有意义）。
     * @returns {void}
     */
    function lockPlacement() {
        if (placementLock || !panelEl) return;
        const { h } = viewportSize();
        let preferBelow = pos.y + FAB_SIZE_PX / 2 < h / 2;
        try {
            const pr = readRect(panelEl);
            if (pr.height > 0) preferBelow = pr.top >= pos.y - 1;
        } catch {
            // ignore
        }
        placementLock = { side: pos.side, preferBelow };
    }

    applyBallPos();

    /**
     * @returns {boolean}
     */
    function readBallHidden() {
        try {
            return deps.loadSettings?.()?.hideFloatingBall === true;
        } catch {
            return false;
        }
    }

    /**
     * @param {boolean} hidden
     */
    function applyBallHidden(hidden) {
        ball.classList.toggle('nd-fab--hidden', hidden);
        ball.setAttribute('aria-hidden', hidden ? 'true' : 'false');
        ball.tabIndex = hidden ? -1 : 0;
    }

    applyBallHidden(readBallHidden());

    /** @type {(() => void)|null} */
    let unsubHidden = null;
    if (typeof deps.onSettingsChange === 'function') {
        const unsub = deps.onSettingsChange(() => {
            if (!destroyed) applyBallHidden(readBallHidden());
        });
        if (typeof unsub === 'function') unsubHidden = unsub;
    }

    /**
     * @param {boolean} busy
     */
    function setBusyVisual(busy) {
        ball.classList.toggle('nd-fab--busy', busy);
        ball.setAttribute('aria-busy', busy ? 'true' : 'false');
    }

    /**
     * @returns {boolean}
     */
    function isBusy() {
        if (floorBusyLocal) return true;
        if (typeof deps.isFloorBusy === 'function') {
            try {
                return deps.isFloorBusy() === true;
            } catch {
                return false;
            }
        }
        return false;
    }

    /**
     * @returns {void}
     */
    function syncBusyFromExternal() {
        if (destroyed) return;
        setBusyVisual(isBusy());
    }

    if (typeof deps.isFloorBusy === 'function') {
        busyPollTimer = setInterval(syncBusyFromExternal, BUSY_POLL_MS);
        syncBusyFromExternal();
    }

    /**
     * @returns {void}
     */
    function closePanels() {
        if (drawerHandle) {
            try {
                drawerHandle.destroy();
            } catch {
                // ignore
            }
            drawerHandle = null;
        }
        if (panelCleanup) {
            try {
                panelCleanup();
            } catch {
                // ignore
            }
            panelCleanup = null;
        }
        unwatchPanelSize();
        if (panelEl) {
            panelEl.remove();
            panelEl = null;
        }
        openPanel = 'none';
        placementLock = null;
        // 0.2.47：浮层关掉后球回来；是否真的显示仍由 hideFloatingBall（nd-fab--hidden）决定
        ball.classList.remove('nd-fab--as-panel');
    }

    /**
     * 按球位置把浮层摆进视口，并写入 maxHeight 让内部滚动。
     * @param {HTMLElement} panel
     */
    function placePanel(panel) {
        const { w: vw, h: vh } = viewportSize();
        // 0.2.48：浮层可贴满视口四边，不再让出酒馆顶栏
        // 先撤掉上次写的 maxHeight 再量，量到的是内容自然高度（CSS 里仍有 100vh 上限）
        let measured = 0;
        if (panel.isConnected && typeof panel.getBoundingClientRect === 'function') {
            panel.style.maxHeight = '';
            measured = Number(panel.getBoundingClientRect().height) || 0;
        }
        const br = ball.classList.contains('nd-fab--hidden') || ball.classList.contains('nd-fab--as-panel')
            ? {
                left: pos.x,
                top: pos.y,
                right: pos.x + FAB_SIZE_PX,
                bottom: pos.y + FAB_SIZE_PX,
            }
            : readRect(ball);
        const placed = computePanelPlacement({
            ballLeft: br.left,
            ballTop: br.top,
            ballRight: br.right,
            ballBottom: br.bottom,
            side: placementLock ? placementLock.side : pos.side,
            preferBelow: placementLock ? placementLock.preferBelow : undefined,
            viewportW: vw,
            viewportH: vh,
            panelWidth: PANEL_MAX_WIDTH,
            panelHeight: measured > 0 ? measured : undefined,
            minTop: 0,
            margin: 0,
            anchor: 'corner',
        });
        panel.style.left = `${placed.left}px`;
        panel.style.top = `${placed.top}px`;
        panel.style.width = `${placed.width}px`;
        panel.style.maxWidth = `${placed.width}px`;
        panel.style.maxHeight = `${placed.maxHeight}px`;
    }

    /** @type {ResizeObserver|null} */
    let panelResizeObserver = null;
    let replaceRaf = 0;

    /** 浮层尺寸 / 视口变化时按实测高度重新贴球（合并到下一帧，避免和 ResizeObserver 互相触发） */
    function schedulePlace() {
        if (replaceRaf || destroyed || !panelEl) return;
        const raf = typeof requestAnimationFrame === 'function'
            ? requestAnimationFrame
            : (fn) => setTimeout(fn, 0);
        replaceRaf = raf(() => {
            replaceRaf = 0;
            if (!destroyed && panelEl) placePanel(panelEl);
        }) || 1;
    }

    function watchPanelSize(panel) {
        unwatchPanelSize();
        if (typeof ResizeObserver === 'function') {
            panelResizeObserver = new ResizeObserver(() => schedulePlace());
            panelResizeObserver.observe(panel);
        }
    }

    function unwatchPanelSize() {
        if (panelResizeObserver) {
            panelResizeObserver.disconnect();
            panelResizeObserver = null;
        }
    }

    /**
     * @param {'config'|'artist'} kind
     * @param {HTMLElement} panel
     */
    function openOverlay(kind, panel) {
        closePanels();
        openPanel = kind;
        panelEl = panel;
        panel.classList.add('nd-root', 'nd-fab-panel');
        if (kind === 'config') panel.classList.add('nd-fab-panel--config');
        if (kind === 'artist') panel.classList.add('nd-fab-panel--artist');
        // 0.2.47：球变成浮层，两者不同时出现；无展开动画
        ball.classList.add('nd-fab--as-panel');
        root.appendChild(panel);
        placePanel(panel);
        watchPanelSize(panel);
    }

    /**
     * @returns {void}
     */
    function toggleConfigPanel() {
        if (openPanel === 'config') {
            closePanels();
            return;
        }
        const panel = el('div', 'nd-fab-panel__shell');
        const head = el('div', 'nd-fab-panel__head');
        const title = el('h3', 'nd-fab-panel__title');
        setText(title, '快捷配置');
        head.appendChild(title);
        bindPanelHeadDrag(head);

        const body = el('div', 'nd-fab-panel__body');
        const footer = el('div', 'nd-fab-panel__footer');

        footer.classList.add('nd-fab-panel__footer--single');
        const managementBtn = createButton({
            label: '管理台',
            variant: 'primary',
            onClick: () => {
                closePanels();
                if (typeof deps.openManagement === 'function') {
                    void Promise.resolve(deps.openManagement()).catch(() => undefined);
                }
            },
        });
        footer.append(managementBtn);
        const emptyNote = el('p', 'nd-muted nd-fab-panel__empty');
        setText(emptyNote, '快速配置内容已全部隐藏，可在管理台—常规设置中恢复');
        emptyNote.hidden = true;

        panel.append(head, body, emptyNote, footer);
        openOverlay('config', panel);

        drawerHandle = mountDrawer(body, {
            loadSettings: deps.loadSettings,
            saveSettings: deps.saveSettings,
            subscribeSettings: deps.subscribeSettings,
            repos: deps.repos || {},
            artistFileUrl: deps.artistFileUrl,
            onVisibilityApplied: (anyVisible) => {
                const showMgmt = isQuickConfigItemVisible(deps.loadSettings?.(), 'management');
                managementBtn.hidden = !showMgmt;
                footer.hidden = !showMgmt;
                body.hidden = !anyVisible;
                emptyNote.hidden = anyVisible || showMgmt;
            },
            openManagementShell: () => {
                closePanels();
                if (typeof deps.openManagement === 'function') {
                    return deps.openManagement();
                }
            },
        });
        placePanel(panel);
    }

    /**
     * @param {object[]} items
     * @param {string} query
     * @param {string} [modelTag]
     * @returns {object[]}
     */
    function filterArtists(items, query, modelTag = '') {
        const q = String(query || '').trim().toLowerCase();
        return items.filter((it) => {
            if (!artistMatchesModelFilter(it, modelTag)) return false;
            if (!q) return true;
            return String(it?.name ?? '').toLowerCase().includes(q);
        });
    }

    /**
     * @param {object|null|undefined} item
     * @returns {string|null}
     */
    function resolveCover(item) {
        const cacheKey = [
            item?.id != null ? String(item.id) : '',
            item?.cardImageRef != null ? String(item.cardImageRef) : '',
            item?.updatedAt != null ? String(item.updatedAt) : '',
        ].join('::');
        if (coverUrlCache.has(cacheKey)) {
            return coverUrlCache.get(cacheKey) ?? null;
        }
        const url = resolveArtistCardUrl(item, deps.artistFileUrl);
        return url.then((resolved) => {
            coverUrlCache.set(cacheKey, resolved);
            return resolved;
        });
    }

    /**
     * @param {HTMLElement} coverEl
     * @param {object} item
     * @param {string} name
     * @returns {void}
     */
    function paintArtistCover(coverEl, item, name) {
        Promise.resolve(resolveCover(item)).then((url) => {
            paintSafeCover(coverEl, url, name, { emptyVariant: 'mark' });
        });
    }

    /**
     * @returns {Promise<void>}
     */
    async function openArtistPanel() {
        if (openPanel === 'artist') {
            closePanels();
            return;
        }

        const panel = el('div', 'nd-fab-panel__shell');
        const head = el('div', 'nd-fab-panel__head');
        const title = el('h3', 'nd-fab-panel__title');
        setText(title, '切换画师串');
        head.appendChild(title);

        // 0.2.47：排序与画师串库共用 nai-dbgen:artist-sort
        const ARTIST_SORT_KEY = 'nai-dbgen:artist-sort';
        const sortChoices = [
            ['sequence-asc', '排序号'],
            ['sequence-desc', '排序号倒序'],
            ['name-asc', '名称'],
            ['name-desc', '名称倒序'],
            ['updated-desc', '最近更新'],
        ];
        let sort = 'sequence-asc';
        try {
            const raw = storageGet(storage, ARTIST_SORT_KEY);
            if (raw && sortChoices.some(([v]) => v === raw)) sort = raw;
        } catch {
            // ignore
        }
        // 0.2.48：令牌下拉框，和搜索框并排
        const sortSelect = createTokenSelect({
            options: sortChoices.map(([value, label]) => ({ value, label })),
            value: sort,
            ariaLabel: '排序',
            className: 'nd-fab-panel__sort',
            onChange: (v) => {
                sort = sortChoices.some(([c]) => c === v) ? v : 'sequence-asc';
                try {
                    storageSet(storage, ARTIST_SORT_KEY, sort);
                } catch {
                    // ignore
                }
                renderList();
            },
        });

        const searchRow = el('div', 'nd-fab-panel__search-row');
        const searchWrap = el('div', 'nd-search-field nd-fab-panel__search');
        const search = /** @type {HTMLInputElement} */ (document.createElement('input'));
        search.type = 'search';
        search.placeholder = '搜索画师串';
        search.setAttribute('aria-label', '搜索画师串');
        search.autocomplete = 'off';
        searchWrap.appendChild(search);

        const body = el('div', 'nd-fab-panel__body');
        const listHost = el('div', 'nd-fab-artist-grid');
        body.appendChild(listHost);
        const tagFilter = createArtistModelTagFilter({
            onChange: () => renderList(),
        });
        searchRow.append(searchWrap, sortSelect.el);
        panel.append(head, searchRow, tagFilter.el, body);

        /** @type {object[]} */
        let allItems = [];
        const activeId = () => deps.loadSettings()?.activeArtistId ?? null;

        /**
         * @returns {void}
         */
        function renderList() {
            listHost.replaceChildren();
            const filtered = filterSortItems(
                filterArtists(allItems, search.value, tagFilter.getValue()),
                { sort },
            );
            if (allItems.length === 0) {
                const go = createButton({
                    label: '去管理台添加',
                    variant: 'primary',
                    onClick: () => {
                        closePanels();
                        if (typeof deps.openManagement === 'function') {
                            void Promise.resolve(deps.openManagement()).catch(() => undefined);
                        }
                    },
                });
                const empty = createEmptyState({
                    title: '还没有画师串',
                    description: '先到管理台添加一条，再回来快速切换。',
                    action: go,
                });
                listHost.appendChild(empty.el);
                return;
            }
            if (filtered.length === 0) {
                const empty = createEmptyState({
                    title: '无匹配项',
                    description: '换个版本或关键词试试。',
                });
                listHost.appendChild(empty.el);
                return;
            }
            const current = activeId();
            for (const item of filtered) {
                const id = item?.id != null ? String(item.id) : '';
                const name = item?.name != null ? String(item.name) : id;
                const card = el('button', 'nd-fab-artist-card');
                card.type = 'button';
                if (id && id === current) {
                    card.classList.add('nd-fab-artist-card--active');
                }
                const cover = el('div', 'nd-fab-artist-card__cover');
                paintArtistCover(cover, item, name);
                card.appendChild(cover);
                const label = el('span', 'nd-fab-artist-card__name');
                setText(label, name);
                card.appendChild(label);
                card.addEventListener('click', (event) => {
                    event.preventDefault();
                    if (!id) return;
                    const next = mergePluginSettings(deps.loadSettings(), { activeArtistId: id });
                    deps.saveSettings(next);
                    deps.toast('success', `已切换画师串：${name}`);
                    closePanels();
                });
                listHost.appendChild(card);
            }
        }

        // 浮层关掉后 input 随 panel 一起移除；定时器到点时面板已换就不再渲染
        bindDebouncedInput(search, () => {
            if (panelEl === panel && !destroyed) renderList();
        });
        openOverlay('artist', panel);
        panelCleanup = () => sortSelect.destroy();

        const repo = deps.repos?.artist;
        if (!repo || typeof repo.list !== 'function') {
            allItems = [];
            renderList();
            placePanel(panel);
            return;
        }
        try {
            const result = await repo.list();
            if (destroyed || panelEl !== panel) return;
            allItems = result && result.ok && Array.isArray(result.value) ? result.value : [];
        } catch {
            allItems = [];
        }
        renderList();
        placePanel(panel);
    }

    /**
     * @returns {Promise<void>}
     */
    async function runGenerateFloor() {
        if (destroyed) return;
        if (isBusy()) return;
        floorBusyLocal = true;
        setBusyVisual(true);
        try {
            const result = await deps.generateFloor();
            if (destroyed) return;
            if (result == null || (typeof result === 'object' && !('ok' in result))) {
                // 非 Result：视为编程错误，保持忙碌视觉由外部恢复；本地闸门释放以免永久锁死 UI
                deps.toast('error', '本楼生图失败，请重试');
                return;
            }
            if (isOk(result)) {
                const toast = formatGenerateFloorToast(/** @type {GenerateFloorSummary} */ (result.value));
                deps.toast(toast.level, toast.message);
            } else if (isErr(result)) {
                deps.toast('error', deps.formatError(result.error));
            }
        } catch (err) {
            if (!destroyed) {
                deps.toast('error', deps.formatError(err));
            }
        } finally {
            floorBusyLocal = false;
            if (!destroyed) syncBusyFromExternal();
        }
    }

    const gesture = createGestureRecognizer({
        now: () => Date.now(),
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: (id) => clearTimeout(/** @type {any} */ (id)),
        onTap: () => {
            if (destroyed) return;
            toggleConfigPanel();
        },
        onDoubleTap: () => {
            if (destroyed) return;
            void runGenerateFloor();
        },
        onLongPress: () => {
            if (destroyed) return;
            try {
                if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
                    navigator.vibrate(15);
                }
            } catch {
                // ignore
            }
            ball.classList.add('nd-fab--pulse');
            setTimeout(() => {
                if (!destroyed) ball.classList.remove('nd-fab--pulse');
            }, 180);
            void openArtistPanel();
        },
        onDragStart: (x, y) => {
            // 0.2.46：浮层打开时拖球不关浮层，锁定展开方向后跟着球重新定位
            if (panelEl) lockPlacement();
            const br = readRect(ball);
            dragOffsetX = x - br.left;
            dragOffsetY = y - br.top;
            ball.classList.add('nd-fab--dragging');
        },
        onDragMove: (x, y) => {
            const { w, h } = viewportSize();
            const rawX = x - dragOffsetX;
            const rawY = y - dragOffsetY;
            const clamped = clampToViewport(rawX, rawY, FAB_SIZE_PX, w, h, 0);
            pos = { ...pos, x: clamped.x, y: clamped.y };
            applyBallPos();
            if (panelEl) placePanel(panelEl);
        },
        onDragEnd: () => {
            ball.classList.remove('nd-fab--dragging');
            const { w, h } = viewportSize();
            // 0.2.46：停在松手位置，只限制在视口内（0.2.48 可贴边）
            pos = freePlace(pos.x, pos.y, FAB_SIZE_PX, w, h, 0);
            applyBallPos();
            persistPos();
            if (panelEl) placePanel(panelEl);
        },
        options: {
            tapSlop: GESTURE_TAP_SLOP,
            longPressMs: GESTURE_LONG_PRESS_MS,
            doubleTapMs: GESTURE_DOUBLE_TAP_MS,
        },
    });

    /**
     * 0.2.46：按住快捷配置标题栏拖动，球跟着移动，浮层用 placePanel 贴着球。
     * @param {HTMLElement} head
     * @returns {void}
     */
    function bindPanelHeadDrag(head) {
        head.classList.add('nd-fab-panel__head--drag');
        head.style.touchAction = 'none';
        /** @type {{ id: number, x0: number, y0: number, l: number, t: number, w: number, h: number }|null} */
        let drag = null;
        head.addEventListener('pointerdown', (event) => {
            if (destroyed || !panelEl) return;
            const e = /** @type {PointerEvent} */ (event);
            if (typeof e.button === 'number' && e.button !== 0) return;
            lockPlacement();
            // 0.2.48：直接拖浮层本身（可贴满四边），球位置按锚定角反推
            const pr = readRect(panelEl);
            drag = {
                id: typeof e.pointerId === 'number' ? e.pointerId : 0,
                x0: e.clientX,
                y0: e.clientY,
                l: pr.left,
                t: pr.top,
                w: pr.width,
                h: pr.height,
            };
            try {
                if (typeof head.setPointerCapture === 'function' && typeof e.pointerId === 'number') {
                    head.setPointerCapture(e.pointerId);
                }
            } catch {
                // ignore
            }
            if (typeof e.preventDefault === 'function') e.preventDefault();
        });
        head.addEventListener('pointermove', (event) => {
            if (!drag || destroyed) return;
            const e = /** @type {PointerEvent} */ (event);
            if (typeof e.pointerId === 'number' && e.pointerId !== drag.id) return;
            const { w, h } = viewportSize();
            const nl = clamp(drag.l + e.clientX - drag.x0, 0, Math.max(0, w - drag.w));
            const nt = clamp(drag.t + e.clientY - drag.y0, 0, Math.max(0, h - drag.h));
            if (panelEl) {
                panelEl.style.left = `${nl}px`;
                panelEl.style.top = `${nt}px`;
            }
            const side = placementLock ? placementLock.side : pos.side;
            const below = placementLock ? placementLock.preferBelow : true;
            const bx = side === 'right' ? nl + drag.w - FAB_SIZE_PX : nl;
            const by = below ? nt : nt + drag.h - FAB_SIZE_PX;
            const c = clampToViewport(bx, by, FAB_SIZE_PX, w, h, 0);
            pos = { ...pos, x: c.x, y: c.y };
            applyBallPos();
            if (typeof e.preventDefault === 'function') e.preventDefault();
        });
        const end = (event) => {
            if (!drag) return;
            const e = /** @type {PointerEvent} */ (event);
            if (typeof e.pointerId === 'number' && e.pointerId !== drag.id) return;
            drag = null;
            if (destroyed) return;
            persistPos();
            // 刷新 maxHeight；锚定角与球位置一致，浮层不会跳
            if (panelEl) placePanel(panelEl);
        };
        head.addEventListener('pointerup', end);
        head.addEventListener('pointercancel', end);
    }

    /**
     * @param {Event} event
     * @returns {{ x: number, y: number }|null}
     */
    function pointFromEvent(event) {
        const e = /** @type {PointerEvent & { clientX?: number, clientY?: number }} */ (event);
        if (typeof e.clientX === 'number' && typeof e.clientY === 'number') {
            return { x: e.clientX, y: e.clientY };
        }
        return null;
    }

    /** @type {number|null} */
    let activePointerId = null;

    /**
     * @param {Event} event
     */
    function onPointerDown(event) {
        if (destroyed) return;
        const pt = pointFromEvent(event);
        if (!pt) return;
        const e = /** @type {PointerEvent} */ (event);
        activePointerId = typeof e.pointerId === 'number' ? e.pointerId : 0;
        try {
            if (typeof ball.setPointerCapture === 'function' && typeof e.pointerId === 'number') {
                ball.setPointerCapture(e.pointerId);
            }
        } catch {
            // ignore
        }
        if (typeof e.preventDefault === 'function') e.preventDefault();
        gesture.pointerDown(pt.x, pt.y);
    }

    /**
     * @param {Event} event
     */
    function onPointerMove(event) {
        if (destroyed) return;
        const e = /** @type {PointerEvent} */ (event);
        if (activePointerId != null && typeof e.pointerId === 'number' && e.pointerId !== activePointerId) {
            return;
        }
        const pt = pointFromEvent(event);
        if (!pt) return;
        if (typeof e.preventDefault === 'function') e.preventDefault();
        gesture.pointerMove(pt.x, pt.y);
    }

    /**
     * @param {Event} event
     */
    function onPointerUp(event) {
        if (destroyed) return;
        const e = /** @type {PointerEvent} */ (event);
        if (activePointerId != null && typeof e.pointerId === 'number' && e.pointerId !== activePointerId) {
            return;
        }
        activePointerId = null;
        const pt = pointFromEvent(event) || { x: pos.x, y: pos.y };
        gesture.pointerUp(pt.x, pt.y);
    }

    /**
     * @param {Event} [_event]
     */
    function onPointerCancel(_event) {
        activePointerId = null;
        gesture.pointerCancel();
    }

    /**
     * @param {Event} event
     */
    function onKeyDown(event) {
        if (destroyed) return;
        const e = /** @type {KeyboardEvent} */ (event);
        if (e.key === 'Escape' || e.key === 'Esc') {
            if (openPanel !== 'none') {
                closePanels();
                if (typeof e.preventDefault === 'function') e.preventDefault();
            }
            return;
        }
        if (e.target !== ball) return;
        if (e.key === 'Enter' || e.key === ' ') {
            if (typeof e.preventDefault === 'function') e.preventDefault();
            toggleConfigPanel();
        }
    }

    /**
     * @param {Event} event
     */
    function onDocPointerDown(event) {
        if (destroyed || openPanel === 'none' || !panelEl) return;
        const target = /** @type {Node|null} */ (event.target);
        if (!target) return;
        if (ball.contains(target) || panelEl.contains(target)) return;
        if (target instanceof Element && target.closest('[data-nd-fab-picker-portal]')) return;
        closePanels();
    }

    /**
     * @returns {void}
     */
    function onResize() {
        if (destroyed) return;
        const { w, h } = viewportSize();
        // 0.2.46：按存下的比例重算，不再吸边
        const restored = lastStored ? storedToPixel(lastStored, FAB_SIZE_PX, w, h) : null;
        pos = restored || freePlace(pos.x, pos.y, FAB_SIZE_PX, w, h, 0);
        applyBallPos();
        if (panelEl) placePanel(panelEl);
    }

    ball.addEventListener('pointerdown', onPointerDown);
    ball.addEventListener('pointermove', onPointerMove);
    ball.addEventListener('pointerup', onPointerUp);
    ball.addEventListener('pointercancel', onPointerCancel);
    // 防止部分环境把 touch 合成 click 再触发意外逻辑
    ball.addEventListener('click', (event) => {
        if (typeof event.preventDefault === 'function') event.preventDefault();
        if (typeof event.stopPropagation === 'function') event.stopPropagation();
    });
    ball.addEventListener('contextmenu', (event) => {
        if (typeof event.preventDefault === 'function') event.preventDefault();
    });

    const visualVp = typeof window !== 'undefined' ? /** @type {any} */ (window).visualViewport : null;
    if (typeof window !== 'undefined') {
        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('resize', onResize);
    }
    if (visualVp && typeof visualVp.addEventListener === 'function') {
        visualVp.addEventListener('resize', onResize);
        visualVp.addEventListener('scroll', schedulePlace);
    }
    if (typeof document !== 'undefined') {
        document.addEventListener('pointerdown', onDocPointerDown, true);
    }

    return {
        closePanels,
        openArtistPanel() {
            if (destroyed) return;
            void openArtistPanel();
        },
        openConfigPanel() {
            if (destroyed) return;
            toggleConfigPanel();
        },
        destroy() {
            if (destroyed) return;
            destroyed = true;
            closePanels();
            try {
                unsubHidden?.();
            } catch {
                // ignore
            }
            unsubHidden = null;
            gesture.destroy();
            if (busyPollTimer != null) {
                clearInterval(busyPollTimer);
                busyPollTimer = null;
            }
            ball.removeEventListener('pointerdown', onPointerDown);
            ball.removeEventListener('pointermove', onPointerMove);
            ball.removeEventListener('pointerup', onPointerUp);
            ball.removeEventListener('pointercancel', onPointerCancel);
            if (typeof window !== 'undefined') {
                window.removeEventListener('keydown', onKeyDown);
                window.removeEventListener('resize', onResize);
            }
            if (visualVp && typeof visualVp.removeEventListener === 'function') {
                visualVp.removeEventListener('resize', onResize);
                visualVp.removeEventListener('scroll', schedulePlace);
            }
            if (typeof document !== 'undefined') {
                document.removeEventListener('pointerdown', onDocPointerDown, true);
            }
            coverUrlCache.clear();
            try {
                /** @type {any} */ (root).classList?.remove(hostClass);
            } catch {
                // ignore
            }
            ball.remove();
        },
    };
}
