/**
 * 存储管理面板 · 图片缓存区
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Ok, Err } from '../../src/infra/result.js';
import { installFakeDom } from './fake-dom.js';
import { mountStoragePanel } from '../../src/ui/panels/storage/storage-panel.js';

/**
 * @param {object} root
 * @param {string} className
 * @returns {object[]}
 */
function findAllByClass(root, className) {
    /** @type {object[]} */
    const out = [];
    function walk(node) {
        if (!node) return;
        if (String(node.className || '').split(/\s+/).includes(className)) {
            out.push(node);
        }
        for (const child of node.childNodes || []) walk(child);
    }
    walk(root);
    return out;
}

/**
 * @param {object} root
 * @returns {object[]}
 */
function findButtons(root) {
    /** @type {object[]} */
    const out = [];
    function walk(node) {
        if (!node) return;
        if (String(node.tagName || '').toLowerCase() === 'button') {
            out.push(node);
        }
        for (const child of node.childNodes || []) walk(child);
    }
    walk(root);
    return out;
}

/**
 * @param {object} btn
 */
function click(btn) {
    const ev = { preventDefault() {}, stopPropagation() {} };
    for (const l of (btn._listeners || []).filter((x) => x.type === 'click')) {
        l.fn(ev);
    }
}

describe('storage-panel image cache', () => {
    /** @type {ReturnType<typeof installFakeDom>|null} */
    let fake = null;

    beforeEach(() => {
        fake = installFakeDom();
    });

    afterEach(() => {
        fake?.restore();
        fake = null;
    });

    it('shows count/size, supports delete selected and clear all regardless of limit', async () => {
        const root = document.createElement('div');
        root.className = 'nd-root';
        document.body.appendChild(root);

        /** @type {object[]} */
        const toasts = [];
        let cleared = false;
        /** @type {string[]} */
        let removedSelection = [];
        let items = [
            { id: 'img-1', size: 1024, createdAt: '2026-01-01', pinned: true, mimeType: 'image/png' },
            { id: 'img-2', size: 1024, createdAt: '2026-01-02', pinned: false, mimeType: 'image/png' },
        ];
        const handle = mountStoragePanel(root, {
            host: {
                toast: (level, message) => {
                    toasts.push({ level, message });
                },
                loadSettings: () => ({ imageCacheLimit: 500 }),
                saveSettings: () => {},
            },
            services: {
                storageCleanup: {
                    cleanup: async () => Ok({
                        removedSessions: 0,
                        removedMissingFiles: 0,
                        removedSessionIds: [],
                    }),
                },
                imageCacheTrim: {
                    trim: async () => Ok({ removed: 0, removedRefs: [], limit: 500 }),
                    removeRefs: async (refs) => {
                        removedSelection = [...refs];
                        items = items.filter((it) => !refs.includes(it.id));
                        return Ok({ removed: refs.length, removedRefs: refs });
                    },
                    clearAll: async () => {
                        cleared = true;
                        const refs = items.map((it) => it.id);
                        items = [];
                        return Ok({ removed: refs.length, removedRefs: refs });
                    },
                },
            },
            repos: {
                image: {
                    estimateUsage: async () => Ok({
                        bytes: items.reduce((sum, it) => sum + it.size, 0),
                        count: items.length,
                        quota: null,
                        usage: null,
                    }),
                    listMeta: async () => Ok(items.map((it) => ({ ...it }))),
                    getUrl: async (id) => Ok(`blob:mock/${id}`),
                },
            },
        });

        await new Promise((r) => setTimeout(r, 10));
        const stats = findAllByClass(root, 'nd-storage-stats')[0];
        assert.ok(stats);
        assert.match(String(stats.textContent || ''), /2 张/);
        assert.match(String(stats.textContent || ''), /2\.0 KB/);

        // 选择模式：选中第一张并点击「删除所选」
        const selectBtn = findButtons(root).find((b) => String(b.textContent || '') === '选择');
        assert.ok(selectBtn);
        click(selectBtn);
        const cards = findAllByClass(root, 'nd-cache-card');
        assert.equal(cards.length, 2);
        click(cards[0]);
        const delSelBtn = findButtons(root).find((b) => String(b.textContent || '') === '删除所选');
        assert.ok(delSelBtn);
        assert.equal(delSelBtn.disabled, false);
        click(delSelBtn);
        await new Promise((r) => setTimeout(r, 0));
        const confirmDel1 = findButtons(document.body).find((b) => String(b.textContent || '') === '确认删除');
        assert.ok(confirmDel1);
        click(confirmDel1);
        await new Promise((r) => setTimeout(r, 10));
        assert.deepEqual(removedSelection, ['img-1']);

        // 未超 500 上限，点击「清理图片缓存」依然能立即清空
        const trimBtn = findButtons(root).find((b) => String(b.textContent || '').includes('清理图片缓存'));
        assert.ok(trimBtn);
        click(trimBtn);
        await new Promise((r) => setTimeout(r, 0));
        const confirmDel2 = findButtons(document.body).find((b) => String(b.textContent || '') === '确认删除');
        assert.ok(confirmDel2);
        click(confirmDel2);
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(cleared, true);
        assert.ok(toasts.some((t) => String(t.message).includes('已清理 1 张')));

        handle.destroy();
    });

    it('clear failure shows reason', async () => {
        const root = document.createElement('div');
        root.className = 'nd-root';
        document.body.appendChild(root);

        /** @type {object[]} */
        const toasts = [];
        const handle = mountStoragePanel(root, {
            host: {
                toast: (level, message) => {
                    toasts.push({ level, message });
                },
                loadSettings: () => ({ imageCacheLimit: 500 }),
                saveSettings: () => {},
            },
            services: {
                imageCacheTrim: {
                    trim: async () => Ok({ removed: 0, removedRefs: [], limit: 500 }),
                    clearAll: async () => Err({
                        code: 'X', message: '磁盘只读', category: 'storage',
                    }),
                },
            },
            repos: {
                image: {
                    estimateUsage: async () => Ok({
                        bytes: 1024, count: 1, quota: null, usage: null,
                    }),
                },
            },
        });
        await new Promise((r) => setTimeout(r, 0));
        const trimBtn = findButtons(root).find((b) => String(b.textContent || '').includes('清理图片缓存'));
        assert.ok(trimBtn);
        click(trimBtn);
        await new Promise((r) => setTimeout(r, 0));
        const confirmDel = findButtons(document.body).find((b) => String(b.textContent || '') === '确认删除');
        assert.ok(confirmDel);
        click(confirmDel);
        await new Promise((r) => setTimeout(r, 0));
        assert.ok(toasts.some((t) => t.level === 'error' && String(t.message).includes('磁盘只读')));
        handle.destroy();
    });
});
