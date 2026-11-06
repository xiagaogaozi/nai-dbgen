/**
 * 悬浮球最小 DOM 假件测试（不引第三方库）。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom } from '../fake-dom.js';
import { defaultPluginSettings } from '../../../src/domain/model/plugin-settings.js';
import {
    formatGenerateFloorToast,
    mountFloatingBall,
} from '../../../src/ui/floating-ball/floating-ball.js';

/**
 * @param {any} el
 * @param {string} type
 * @param {object} [extra]
 */
function fire(el, type, extra = {}) {
    const listeners = (el._listeners || []).filter((l) => l.type === type);
    for (const l of listeners) {
        l.fn({
            preventDefault() {},
            stopPropagation() {},
            pointerId: 1,
            clientX: 100,
            clientY: 200,
            target: el,
            ...extra,
        });
    }
}

/**
 * @param {any} ball
 */
function doubleTap(ball) {
    fire(ball, 'pointerdown');
    fire(ball, 'pointerup');
    fire(ball, 'pointerdown');
    fire(ball, 'pointerup');
}

/**
 * @param {any} node
 * @param {(n: any) => boolean} pred
 * @returns {any|null}
 */
function findNode(node, pred) {
    if (!node) return null;
    if (pred(node)) return node;
    for (const c of node.childNodes || []) {
        const hit = findNode(c, pred);
        if (hit) return hit;
    }
    return null;
}

describe('ui/floating-ball/floating-ball', () => {
    /** @type {ReturnType<typeof installFakeDom>|null} */
    let fake = null;
    /** @type {Record<string, unknown>} */
    let prevGlobals = {};

    beforeEach(() => {
        fake = installFakeDom();
        prevGlobals = {
            window: globalThis.window,
            navigator: globalThis.navigator,
            requestAnimationFrame: globalThis.requestAnimationFrame,
            innerWidth: globalThis.innerWidth,
            innerHeight: globalThis.innerHeight,
        };

        /** @type {Array<{ type: string, fn: Function }>} */
        const winListeners = [];
        const win = {
            innerWidth: 900,
            innerHeight: 700,
            localStorage: {
                store: /** @type {Record<string, string>} */ ({}),
                getItem(k) {
                    return this.store[k] ?? null;
                },
                setItem(k, v) {
                    this.store[k] = String(v);
                },
            },
            addEventListener(type, fn) {
                winListeners.push({ type, fn });
            },
            removeEventListener(type, fn) {
                const i = winListeners.findIndex((l) => l.type === type && l.fn === fn);
                if (i >= 0) winListeners.splice(i, 1);
            },
            _listeners: winListeners,
        };
        globalThis.window = win;
        globalThis.innerWidth = 900;
        globalThis.innerHeight = 700;
        try {
            Object.defineProperty(globalThis, 'navigator', {
                value: { vibrate() {} },
                configurable: true,
                writable: true,
            });
        } catch {
            // 宿主 navigator 不可写时跳过 vibrate 桩
        }
        globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

        document.createElementNS = (_ns, tag) => document.createElement(tag);
    });

    afterEach(() => {
        fake?.restore();
        fake = null;
        for (const [k, v] of Object.entries(prevGlobals)) {
            try {
                if (v === undefined) {
                    delete globalThis[k];
                } else {
                    globalThis[k] = v;
                }
            } catch {
                try {
                    Object.defineProperty(globalThis, k, {
                        value: v,
                        configurable: true,
                        writable: true,
                    });
                } catch {
                    // navigator 等只读属性：跳过还原
                }
            }
        }
    });

    it('formatGenerateFloorToast 覆盖成功 / 已出齐 / 部分失败', () => {
        assert.deepEqual(
            formatGenerateFloorToast({
                messageId: 12,
                wroteSlots: true,
                rendered: [1, 2, 3],
                skipped: [],
                failed: [],
            }),
            { level: 'success', message: '第 12 楼：生成 3 条提示词，出图 3 张' },
        );
        assert.deepEqual(
            formatGenerateFloorToast({
                messageId: 12,
                wroteSlots: false,
                rendered: [],
                skipped: [{ slotId: 1, reason: 'exists' }],
                failed: [],
            }),
            { level: 'info', message: '第 12 楼的图都已生成过了' },
        );
        assert.equal(
            formatGenerateFloorToast({
                messageId: 3,
                wroteSlots: true,
                rendered: [1],
                skipped: [],
                failed: [{ slotId: 2, message: 'x' }],
            }).level,
            'warning',
        );
    });

    it('双击进行中再双击只调一次 generateFloor', async () => {
        const root = document.createElement('div');
        document.body.appendChild(root);

        let calls = 0;
        /** @type {(() => void)|null} */
        let release = null;
        const api = mountFloatingBall(root, {
            loadSettings: () => defaultPluginSettings(),
            saveSettings: () => {},
            openManagement: () => {},
            openWorkbench: () => {},
            repos: { artist: { list: async () => ({ ok: true, value: [] }) } },
            generateFloor: () => {
                calls += 1;
                return new Promise((resolve) => {
                    release = () => resolve({
                        ok: true,
                        value: {
                            messageId: 1,
                            wroteSlots: true,
                            rendered: [1],
                            skipped: [],
                            failed: [],
                        },
                    });
                });
            },
            toast: () => {},
            formatError: () => 'err',
            storage: {
                getItem: () => null,
                setItem: () => {},
            },
        });

        const ball = root.childNodes[0];
        ball.getBoundingClientRect = () => ({
            left: 100,
            top: 200,
            right: 148,
            bottom: 248,
            width: 48,
            height: 48,
        });

        doubleTap(ball);
        await new Promise((r) => setTimeout(r, 0));
        assert.equal(calls, 1);

        doubleTap(ball);
        await new Promise((r) => setTimeout(r, 0));
        assert.equal(calls, 1);

        release?.();
        await new Promise((r) => setTimeout(r, 0));
        api.destroy();
        api.destroy();
    });

    it('generateFloor 返回 Err 时 toast error', async () => {
        const root = document.createElement('div');
        document.body.appendChild(root);
        /** @type {Array<[string, string]>} */
        const toasts = [];

        const api = mountFloatingBall(root, {
            loadSettings: () => defaultPluginSettings(),
            saveSettings: () => {},
            openManagement: () => {},
            openWorkbench: () => {},
            repos: { artist: { list: async () => ({ ok: true, value: [] }) } },
            generateFloor: async () => ({ ok: false, error: { code: 'X' } }),
            toast: (level, message) => toasts.push([level, message]),
            formatError: (err) => `fmt:${err?.code || 'unknown'}`,
            storage: { getItem: () => null, setItem: () => {} },
        });

        const ball = root.childNodes[0];
        ball.getBoundingClientRect = () => ({
            left: 10,
            top: 10,
            right: 58,
            bottom: 58,
            width: 48,
            height: 48,
        });

        doubleTap(ball);
        await new Promise((r) => setTimeout(r, 0));
        assert.deepEqual(toasts, [['error', 'fmt:X']]);
        api.destroy();
    });

    it('选画师串后 saveSettings 收到正确 activeArtistId', async () => {
        const root = document.createElement('div');
        document.body.appendChild(root);

        let settings = {
            ...defaultPluginSettings(),
            activeArtistId: 'a1',
        };
        /** @type {object|null} */
        let saved = null;
        /** @type {Array<[string, string]>} */
        const toasts = [];

        const api = mountFloatingBall(root, {
            loadSettings: () => ({ ...settings }),
            saveSettings: (s) => {
                saved = s;
                settings = { ...s };
            },
            openManagement: () => {},
            openWorkbench: () => {},
            repos: {
                artist: {
                    list: async () => ({
                        ok: true,
                        value: [
                            { id: 'a1', name: 'Alice', cardImageRef: 'https://example.com/a.png' },
                            { id: 'a2', name: 'Bob', cardImageRef: 'https://example.com/b.png' },
                        ],
                    }),
                },
            },
            generateFloor: async () => ({
                ok: true,
                value: {
                    messageId: 1,
                    wroteSlots: false,
                    rendered: [],
                    skipped: [],
                    failed: [],
                },
            }),
            toast: (level, message) => toasts.push([level, message]),
            formatError: () => 'err',
            storage: { getItem: () => null, setItem: () => {} },
        });

        const ball = root.childNodes[0];
        ball.getBoundingClientRect = () => ({
            left: 800,
            top: 100,
            right: 848,
            bottom: 148,
            width: 48,
            height: 48,
        });

        fire(ball, 'pointerdown');
        await new Promise((r) => setTimeout(r, 520));
        fire(ball, 'pointerup');
        await new Promise((r) => setTimeout(r, 20));

        const card = findNode(root, (n) =>
            String(n.className || '').includes('nd-fab-artist-card') &&
            findNode(n, (c) => String(c.textContent || '') === 'Bob'),
        );
        assert.ok(card, 'expected Bob artist card');

        const click = (card._listeners || []).find((l) => l.type === 'click');
        assert.ok(click);
        click.fn({ preventDefault() {} });

        assert.equal(saved?.activeArtistId, 'a2');
        assert.ok(toasts.some(([level, msg]) => level === 'success' && msg.includes('Bob')));
        api.destroy();
    });

    it('cardImageRef + artistFileUrl → 封面 img.src 为服务器文件 URL', async () => {
        const root = document.createElement('div');
        document.body.appendChild(root);
        /** @type {object[]} */
        const asked = [];
        const fileUrl = '/user/files/nai-dbgen_artist-preview_a1__deadbeef_card.webp?v=2026-01-01T00%3A00%3A00.000Z';

        const api = mountFloatingBall(root, {
            loadSettings: () => defaultPluginSettings(),
            saveSettings: () => {},
            openManagement: () => {},
            openWorkbench: () => {},
            repos: {
                artist: {
                    list: async () => ({
                        ok: true,
                        value: [
                            {
                                id: 'a1',
                                name: 'WithRef',
                                cardImageRef: 'nai-dbgen_artist-preview_a1__deadbeef_card.webp',
                                updatedAt: '2026-01-01T00:00:00.000Z',
                            },
                        ],
                    }),
                },
            },
            artistFileUrl: {
                urlOf: () => null,
                cardUrl: (item) => {
                    asked.push(item);
                    return fileUrl;
                },
                referenceUrl: () => null,
            },
            generateFloor: async () => ({
                ok: true,
                value: {
                    messageId: 1,
                    wroteSlots: false,
                    rendered: [],
                    skipped: [],
                    failed: [],
                },
            }),
            toast: () => {},
            formatError: () => 'err',
            storage: { getItem: () => null, setItem: () => {} },
        });

        const ball = root.childNodes[0];
        ball.getBoundingClientRect = () => ({
            left: 100,
            top: 100,
            right: 148,
            bottom: 148,
            width: 48,
            height: 48,
        });

        fire(ball, 'pointerdown');
        await new Promise((r) => setTimeout(r, 520));
        fire(ball, 'pointerup');
        await new Promise((r) => setTimeout(r, 30));

        assert.equal(asked.length, 1);
        assert.equal(asked[0]?.id, 'a1');
        const cover = findNode(root, (n) =>
            String(n.className || '').includes('nd-fab-artist-card__cover'),
        );
        assert.ok(cover);
        const img = findNode(cover, (n) => String(n.tagName).toUpperCase() === 'IMG');
        assert.ok(img, 'expected img from server file url');
        assert.equal(img.src, fileUrl);
        api.destroy();
    });

    it('artistFileUrl 无图 → 淡色占位，无裂图无首字母', async () => {
        const root = document.createElement('div');
        document.body.appendChild(root);

        const api = mountFloatingBall(root, {
            loadSettings: () => defaultPluginSettings(),
            saveSettings: () => {},
            openManagement: () => {},
            openWorkbench: () => {},
            repos: {
                artist: {
                    list: async () => ({
                        ok: true,
                        value: [
                            {
                                id: 'a1',
                                name: 'Evil',
                            },
                        ],
                    }),
                },
            },
            artistFileUrl: {
                urlOf: () => null,
                cardUrl: () => null,
                referenceUrl: () => null,
            },
            generateFloor: async () => ({
                ok: true,
                value: {
                    messageId: 1,
                    wroteSlots: false,
                    rendered: [],
                    skipped: [],
                    failed: [],
                },
            }),
            toast: () => {},
            formatError: () => 'err',
            storage: { getItem: () => null, setItem: () => {} },
        });

        const ball = root.childNodes[0];
        ball.getBoundingClientRect = () => ({
            left: 100,
            top: 100,
            right: 148,
            bottom: 148,
            width: 48,
            height: 48,
        });

        fire(ball, 'pointerdown');
        await new Promise((r) => setTimeout(r, 520));
        fire(ball, 'pointerup');
        await new Promise((r) => setTimeout(r, 30));

        const cover = findNode(root, (n) =>
            String(n.className || '').includes('nd-fab-artist-card__cover'),
        );
        assert.ok(cover);
        assert.ok(String(cover.className).includes('nd-cover--empty'));
        const img = findNode(cover, (n) => String(n.tagName).toUpperCase() === 'IMG');
        assert.equal(img, null);
        const mark = findNode(cover, (n) =>
            String(n.className || '').includes('nd-cover-empty-mark'),
        );
        assert.ok(mark);
        assert.equal(String(mark.textContent || '').trim(), '');
        const mono = findNode(cover, (n) =>
            String(n.className || '').includes('nd-cover-monogram'),
        );
        assert.equal(mono, null);
        api.destroy();
    });

    it('destroy 后 DOM 清空且可重复调用', () => {
        const root = document.createElement('div');
        document.body.appendChild(root);
        const api = mountFloatingBall(root, {
            loadSettings: () => defaultPluginSettings(),
            saveSettings: () => {},
            openManagement: () => {},
            openWorkbench: () => {},
            repos: { artist: { list: async () => ({ ok: true, value: [] }) } },
            generateFloor: async () => ({
                ok: true,
                value: {
                    messageId: 1,
                    wroteSlots: false,
                    rendered: [],
                    skipped: [],
                    failed: [],
                },
            }),
            toast: () => {},
            formatError: () => 'err',
            storage: { getItem: () => null, setItem: () => {} },
        });

        assert.equal(root.childNodes.length, 1);
        api.destroy();
        assert.equal(root.childNodes.length, 0);
        assert.doesNotThrow(() => api.destroy());
    });

    it('常规设置改了隐藏悬浮球后球立即隐藏，再次挂上仍隐藏', async () => {
        const root = document.createElement('div');
        document.body.appendChild(root);
        /** @type {ReturnType<typeof defaultPluginSettings>} */
        let settings = { ...defaultPluginSettings() };
        /** @type {Set<() => void>} */
        const listeners = new Set();
        const deps = {
            loadSettings: () => settings,
            saveSettings: (next) => {
                settings = next;
            },
            subscribeSettings: () => () => {},
            onSettingsChange: (fn) => {
                listeners.add(fn);
                return () => listeners.delete(fn);
            },
            openManagement: () => {},
            repos: {},
            generateFloor: async () => ({
                ok: true,
                value: {
                    messageId: 1,
                    wroteSlots: false,
                    rendered: [],
                    skipped: [],
                    failed: [],
                },
            }),
            toast: () => {},
            formatError: () => 'err',
            storage: { getItem: () => null, setItem: () => {} },
        };
        const api = mountFloatingBall(root, deps);
        const ball = root.childNodes[0];
        assert.equal(ball.classList.contains('nd-fab--hidden'), false);

        api.openConfigPanel();

        assert.notEqual(findNode(root, (n) => n.textContent === '隐藏悬浮球'), null, '配置面板里有隐藏悬浮球开关（默认隐藏，可在显隐器打开）');
        settings = { ...settings, hideFloatingBall: true };
        for (const fn of listeners) fn();
        assert.equal(ball.classList.contains('nd-fab--hidden'), true);
        api.destroy();

        const again = mountFloatingBall(root, deps);
        assert.equal(root.childNodes[0].classList.contains('nd-fab--hidden'), true);
        again.destroy();
    });
});
