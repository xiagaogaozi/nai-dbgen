/**
 * L5 UI · 悬浮球入口（单击配置 / 双击本楼生图 / 长按切换画师串）。
 * 装配（挂 body、接容器）由 bootstrap 代理完成；本模块只导出 mountFloatingBall。
 */

import { isOk, isErr } from '../../infra/result.js';
import { mergePluginSettings } from '../../domain/model/plugin-settings.js';
import { createButton, createEmptyState, createToggle } from '../common/controls.js';
import { paintSafeCover } from '../common/safe-url.js';
import {
    artistMatchesModelFilter,
    createArtistModelTagFilter,
    formatArtistModelTag,
} from '../common/artist-model-tags.js';
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
    snapToNearestEdge,
    storedToPixel,
    clampToViewport,
} from './position.js';

/** 球直径（px）；触控目标 ≥44 */
export const FAB_SIZE_PX = 48;

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
 * @property {() => void|Promise<void>} openManagement
 * @property {() => void|Promise<void>} openWorkbench
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
    svg.setAttribute('width', '22');
    svg.setAttribute('height', '22');
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
    /** @type {{ destroy: () => void }|null} */
    let hideBallToggle = null;
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
        const storedPos = pixelToStored(pos, FAB_SIZE_PX, viewportSize().h);
        storageSet(storage, FAB_POS_STORAGE_KEY, serializeFabPos(storedPos));
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
        if (hideBallToggle) {
            try {
                hideBallToggle.destroy();
            } catch {
                // ignore
            }
            hideBallToggle = null;
        }
        if (drawerHandle) {
            try {
                drawerHandle.destroy();
            } catch {
                // ignore
            }
            drawerHandle = null;
        }
        if (panelEl) {
            panelEl.remove();
            panelEl = null;
        }
        openPanel = 'none';
    }

    /**
     * 按球位置把浮层摆进视口，并写入 maxHeight 让内部滚动。
     * @param {HTMLElement} panel
     */
    function placePanel(panel) {
        const { w: vw, h: vh } = viewportSize();
        const br = ball.classList.contains('nd-fab--hidden')
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
            side: pos.side,
            viewportW: vw,
            viewportH: vh,
            panelWidth: PANEL_MAX_WIDTH,
        });
        panel.style.left = `${placed.left}px`;
        panel.style.top = `${placed.top}px`;
        panel.style.width = `${placed.width}px`;
        panel.style.maxWidth = `${placed.width}px`;
        panel.style.maxHeight = `${placed.maxHeight}px`;
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
        root.appendChild(panel);
        placePanel(panel);
        const raf =
            typeof requestAnimationFrame === 'function'
                ? requestAnimationFrame
                : (fn) => setTimeout(fn, 0);
        raf(() => {
            if (!destroyed && panelEl === panel) {
                panel.classList.add('nd-fab-panel--open');
            }
        });
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
        setText(title, '配置');
        head.appendChild(title);

        const body = el('div', 'nd-fab-panel__body');
        const footer = el('div', 'nd-fab-panel__footer');

        const managementBtn = createButton({
            label: '打开管理台',
            variant: 'ghost',
            onClick: () => {
                closePanels();
                if (typeof deps.openManagement === 'function') {
                    void Promise.resolve(deps.openManagement()).catch(() => undefined);
                }
            },
        });
        const workbenchBtn = createButton({
            label: '打开工作台',
            variant: 'primary',
            onClick: () => {
                closePanels();
                if (typeof deps.openWorkbench === 'function') {
                    void Promise.resolve(deps.openWorkbench()).catch(() => undefined);
                }
            },
        });
        const hideToggle = createToggle({
            label: '隐藏悬浮球',
            hint: '关掉后从快捷回复栏进入',
            checked: readBallHidden(),
            onChange: (on) => {
                const current = deps.loadSettings();
                deps.saveSettings(mergePluginSettings(current, { hideFloatingBall: on }));
                applyBallHidden(on);
            },
        });
        footer.append(hideToggle.el, managementBtn, workbenchBtn);

        panel.append(head, body, footer);
        openOverlay('config', panel);
        hideBallToggle = hideToggle;

        drawerHandle = mountDrawer(body, {
            loadSettings: deps.loadSettings,
            saveSettings: deps.saveSettings,
            subscribeSettings: deps.subscribeSettings,
            repos: deps.repos || {},
            artistFileUrl: deps.artistFileUrl,
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

        const searchWrap = el('div', 'nd-search-field nd-fab-panel__search');
        const search = /** @type {HTMLInputElement} */ (el('input', 'nd-input'));
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
        panel.append(head, searchWrap, tagFilter.el, body);

        /** @type {object[]} */
        let allItems = [];
        const activeId = () => deps.loadSettings()?.activeArtistId ?? null;

        /**
         * @returns {void}
         */
        function renderList() {
            listHost.replaceChildren();
            const filtered = filterArtists(allItems, search.value, tagFilter.getValue());
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
                const tags = el('span', 'nd-fab-artist-card__tags');
                setText(tags, formatArtistModelTag(item));
                card.appendChild(tags);
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

        search.addEventListener('input', () => renderList());
        openOverlay('artist', panel);

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
            closePanels();
            const br = readRect(ball);
            dragOffsetX = x - br.left;
            dragOffsetY = y - br.top;
            ball.classList.add('nd-fab--dragging');
        },
        onDragMove: (x, y) => {
            const { w, h } = viewportSize();
            const rawX = x - dragOffsetX;
            const rawY = y - dragOffsetY;
            const clamped = clampToViewport(rawX, rawY, FAB_SIZE_PX, w, h);
            pos = { ...pos, x: clamped.x, y: clamped.y };
            applyBallPos();
        },
        onDragEnd: () => {
            ball.classList.remove('nd-fab--dragging');
            const { w, h } = viewportSize();
            pos = snapToNearestEdge(pos.x, pos.y, FAB_SIZE_PX, w, h);
            applyBallPos();
            persistPos();
        },
        options: {
            tapSlop: GESTURE_TAP_SLOP,
            longPressMs: GESTURE_LONG_PRESS_MS,
            doubleTapMs: GESTURE_DOUBLE_TAP_MS,
        },
    });

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
        closePanels();
    }

    /**
     * @returns {void}
     */
    function onResize() {
        if (destroyed) return;
        const { w, h } = viewportSize();
        pos = snapToNearestEdge(pos.x, pos.y, FAB_SIZE_PX, w, h);
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

    if (typeof window !== 'undefined') {
        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('resize', onResize);
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
