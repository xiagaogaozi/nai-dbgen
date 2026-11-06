import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom } from './fake-dom.js';
import { mountDrawer } from '../../src/ui/drawer/drawer.js';

/**
 * @param {Element} root
 * @returns {any[]}
 */
function findSearchInputs(root) {
    /** @type {any[]} */
    const out = [];
    /**
     * @param {any} node
     */
    function walk(node) {
        if (!node) return;
        if (node.tagName === 'INPUT' && node.type === 'search') out.push(node);
        for (const c of node.childNodes || []) walk(c);
    }
    walk(root);
    return out;
}

describe('D60 mountDrawer picker refresh', () => {
    /** @type {ReturnType<typeof installFakeDom>|null} */
    let fake = null;

    beforeEach(() => {
        fake = installFakeDom();
    });

    afterEach(() => {
        fake?.restore();
        fake = null;
    });

    it('refresh() re-syncs all pickers after external settings clear', async () => {
        const root = document.createElement('div');
        document.body.appendChild(root);

        /** @type {Record<string, any>} */
        let settings = {
            contextWindowSize: 5,
            autoWriteSlots: false,
            autoRenderSlots: false,
            activeArtistId: 'artist-1',
            activeNaiConfigId: 'nai-1',
            recallLlmConfigId: 'llm-r',
            promptGenLlmConfigId: 'llm-p',
            activeImagegenPresetId: 'img-p',
            activeRecallPresetId: 'rec-p',
        };

        /** @type {Array<() => void>} */
        const settingsListeners = [];

        const api = mountDrawer(root, {
            loadSettings: () => ({ ...settings }),
            saveSettings: (s) => {
                settings = { ...s };
            },
            openManagementShell: () => {},
            subscribeSettings: (fn) => {
                settingsListeners.push(fn);
                return () => {
                    const i = settingsListeners.indexOf(fn);
                    if (i >= 0) settingsListeners.splice(i, 1);
                };
            },
            repos: {
                artist: {
                    list: async () => ({
                        ok: true,
                        value: [{ id: 'artist-1', name: 'Artist One' }],
                    }),
                    onChanged: () => () => {},
                },
                naiConfig: {
                    list: async () => ({
                        ok: true,
                        value: [{ id: 'nai-1', name: 'NAI One', apiKey: 'k' }],
                    }),
                    onChanged: () => () => {},
                },
                llmConfig: {
                    list: async () => ({
                        ok: true,
                        value: [
                            { id: 'llm-r', name: 'Recall LLM', secretId: 'sec-r' },
                            { id: 'llm-p', name: 'Prompt LLM', secretId: 'sec-p' },
                        ],
                    }),
                    onChanged: () => () => {},
                },
                preset: {
                    list: async () => ({
                        ok: true,
                        value: [
                            { id: 'img-p', name: 'Image Preset', kind: 'imagegen' },
                            { id: 'rec-p', name: 'Recall Preset', kind: 'recall' },
                        ],
                    }),
                    onChanged: () => () => {},
                },
            },
        });

        assert.equal(typeof api.refresh, 'function');
        await api.refresh();

        const inputs = findSearchInputs(root);
        assert.equal(inputs.length, 7); // 0.2.49：生图模型也是 current-picker
        assert.equal(inputs[0].value, 'Artist One');
        assert.equal(inputs[1].value, 'NAI One');

        // 外部空配置（不重挂）
        settings = {
            ...settings,
            activeArtistId: null,
            activeNaiConfigId: null,
            recallLlmConfigId: null,
            promptGenLlmConfigId: null,
            activeImagegenPresetId: null,
            activeRecallPresetId: null,
        };
        for (const fn of settingsListeners) fn();
        await api.refresh();

        const after = findSearchInputs(root);
        assert.ok(after.every((el) => el.value === ''));

        api.destroy();
        assert.equal(settingsListeners.length, 0);
    });

    it('subscribeSettings path notifies without explicit refresh()', async () => {
        const root = document.createElement('div');
        document.body.appendChild(root);

        /** @type {Record<string, any>} */
        let settings = {
            contextWindowSize: 5,
            autoWriteSlots: false,
            autoRenderSlots: false,
            activeArtistId: 'a1',
        };
        /** @type {Array<() => void>} */
        const listeners = [];

        const api = mountDrawer(root, {
            loadSettings: () => ({ ...settings }),
            saveSettings: (s) => {
                settings = { ...s };
            },
            openManagementShell: () => {},
            subscribeSettings: (fn) => {
                listeners.push(fn);
                return () => {
                    const i = listeners.indexOf(fn);
                    if (i >= 0) listeners.splice(i, 1);
                };
            },
            repos: {
                artist: {
                    list: async () => ({
                        ok: true,
                        value: [
                            { id: 'a1', name: 'Alpha' },
                            { id: 'a2', name: 'Beta' },
                        ],
                    }),
                    onChanged: () => () => {},
                },
            },
        });

        await api.refresh();
        const [search] = findSearchInputs(root);
        assert.equal(search.value, 'Alpha');

        settings = { ...settings, activeArtistId: 'a2' };
        for (const fn of listeners) fn();
        // subscribe 触发 refreshAll；给微任务一点时间
        await new Promise((r) => setTimeout(r, 0));
        await api.refresh();
        assert.equal(search.value, 'Beta');

        api.destroy();
    });

    it('destroy unbinds document close listener (no leak)', () => {
        const root = document.createElement('div');
        document.body.appendChild(root);

        const before = document._docListeners?.length ?? 0;
        const api = mountDrawer(root, {
            loadSettings: () => ({
                contextWindowSize: 5,
                autoWriteSlots: false,
                autoRenderSlots: false,
            }),
            saveSettings: () => {},
            openManagementShell: () => {},
            subscribeSettings: (fn) => {
                void fn;
                return () => {};
            },
            repos: {},
        });
        const mid = document._docListeners?.length ?? 0;
        assert.ok(mid > before, 'expected close listener registered');
        api.destroy();
        const after = document._docListeners?.length ?? 0;
        assert.equal(after, before);
    });

    it('artist picker cover uses artistFileUrl server file URL', async () => {
        const root = document.createElement('div');
        document.body.appendChild(root);
        const fileUrl = '/user/files/nai-dbgen_artist-preview_a1__deadbeef_card.webp?v=t1';
        /** @type {object[]} */
        const asked = [];

        const api = mountDrawer(root, {
            loadSettings: () => ({
                contextWindowSize: 5,
                autoWriteSlots: false,
                autoRenderSlots: false,
                activeArtistId: 'a1',
            }),
            saveSettings: () => {},
            openManagementShell: () => {},
            subscribeSettings: (fn) => {
                void fn;
                return () => {};
            },
            artistFileUrl: {
                urlOf: () => null,
                cardUrl: (item) => {
                    asked.push(item);
                    return fileUrl;
                },
                referenceUrl: () => null,
            },
            repos: {
                artist: {
                    list: async () => ({
                        ok: true,
                        value: [
                            {
                                id: 'a1',
                                name: 'Alpha',
                                cardImageRef: 'nai-dbgen_artist-preview_a1__deadbeef_card.webp',
                                updatedAt: 't1',
                            },
                        ],
                    }),
                    onChanged: () => () => {},
                },
            },
        });

        await api.refresh();
        assert.ok(asked.length >= 1);
        assert.equal(asked[0]?.id, 'a1');

        /** @param {any} node @param {(n: any) => boolean} pred */
        function findNode(node, pred) {
            if (!node) return null;
            if (pred(node)) return node;
            for (const c of node.childNodes || []) {
                const hit = findNode(c, pred);
                if (hit) return hit;
            }
            return null;
        }

        const cover = findNode(root, (n) =>
            String(n.className || '').includes('nd-picker__cover'),
        );
        assert.ok(cover);
        const img = findNode(cover, (n) => String(n.tagName).toUpperCase() === 'IMG');
        assert.ok(img);
        assert.equal(img.src, fileUrl);
        api.destroy();
    });
});
