/**
 * 覆盖：
 * 1. 出图参数页「模型跟随模型版本」默认关闭、隐藏 V5/V4.5 绑定行、开启后显示；关闭时不覆盖画师预览模型
 * 2. API 库、标签库、角色库无复选框高亮选择 / 全选 / 取消选择 / 删除所选
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Ok } from '../../src/infra/result.js';
import { installFakeDom } from './fake-dom.js';
import { defaultPluginSettings } from '../../src/domain/model/plugin-settings.js';
import { mountNaiParamsPanel } from '../../src/ui/panels/nai-params/nai-params-panel.js';
import { mountApiConfigPanel } from '../../src/ui/panels/api-config/api-config-panel.js';
import { mountTagPanel } from '../../src/ui/panels/tag/tag-panel.js';
import { mountCharacterPanel } from '../../src/ui/panels/character/character-panel.js';
import { createArtistPreviewService } from '../../src/application/artist-preview.service.js';

const flush = () => new Promise((r) => setTimeout(r, 10));

function fire(node, type, extra = {}) {
    for (const l of (node._listeners || []).filter((x) => x.type === type)) {
        l.fn({ target: node, preventDefault() {}, stopPropagation() {}, ...extra });
    }
}

function findAll(root, pred) {
    /** @type {object[]} */
    const out = [];
    function walk(node) {
        if (!node) return;
        if (pred(node)) out.push(node);
        for (const child of node.childNodes || []) walk(child);
    }
    walk(root);
    return out;
}

function hasClass(node, cls) {
    return String(node?.className || '').split(/\s+/).includes(cls);
}

function fullText(node) {
    if (!node) return '';
    let out = String(node.textContent || '');
    for (const child of node.childNodes || []) out += fullText(child);
    return out;
}

function buttonByText(root, label) {
    return findAll(root, (n) => String(n.tagName || '').toLowerCase() === 'button' && n.textContent === label)[0];
}

describe('model follow default off + binding rows visibility', () => {
    let fake;

    beforeEach(() => {
        fake = installFakeDom();
    });

    afterEach(() => {
        fake?.restore();
    });

    it('hides V5 and V4.5 binding rows when disabled and shows them when enabled', () => {
        const root = document.createElement('div');
        root.className = 'nd-root';
        document.body.appendChild(root);
        const settings = defaultPluginSettings();

        const handle = mountNaiParamsPanel(root, {
            loadSettings: () => settings,
            saveSettings: (next) => Object.assign(settings, next),
        });

        const toggles = findAll(root, (n) => hasClass(n, 'nd-toggle-row'));
        const followRow = toggles.find((n) => fullText(n).includes('模型跟随模型版本'));
        assert.ok(followRow);
        const followInput = findAll(followRow, (n) => String(n.tagName || '').toLowerCase() === 'input')[0];
        assert.equal(followInput.checked, false);

        const combos = findAll(root, (n) => hasClass(n, 'nd-combobox'));
        const v5Field = combos.find((n) => fullText(n).includes('V5 模型'));
        const v45Field = combos.find((n) => fullText(n).includes('V4.5 模型'));
        assert.ok(v5Field && v45Field);
        assert.equal(v5Field.hidden, true);
        assert.equal(v45Field.hidden, true);

        followInput.checked = true;
        fire(followInput, 'change');
        assert.equal(settings.naiModelFollowsArtist, true);
        assert.equal(v5Field.hidden, false);
        assert.equal(v45Field.hidden, false);

        followInput.checked = false;
        fire(followInput, 'change');
        assert.equal(settings.naiModelFollowsArtist, false);
        assert.equal(v5Field.hidden, true);
        assert.equal(v45Field.hidden, true);

        handle.destroy();
    });

    it('artist preview does not apply bound model when naiModelFollowsArtist is false or omitted', async () => {
        const seenParams = [];
        const svc = createArtistPreviewService({
            artistRepo: {
                get: async () => Ok({ id: 'a1', name: 'A', modelTag: 'v4.5', positivePrompt: 'p', negativePrompt: '' }),
                put: async (v) => Ok(v),
            },
            imageGen: {
                generate: async (req) => {
                    seenParams.push(req.params);
                    return Ok([{ blob: new Blob(['img'], { type: 'image/png' }), mimeType: 'image/png' }]);
                },
            },
            makeCardImage: async (b) => b,
            savePreviewPair: async () => Ok({ referenceImageRef: 'r', cardImageRef: 'c' }),
            loadSettings: () => ({ ...defaultPluginSettings() }),
        });

        const res = await svc.preview({ artistId: 'a1', promptText: '1girl', saveAsPreview: false });
        assert.equal(res.ok, true);
        assert.equal(seenParams.length, 1);
        assert.equal('model' in seenParams[0], false);
    });
});

describe('highlight-only multi-select and bulk delete for API, Tag, Character libraries', () => {
    let fake;

    beforeEach(() => {
        fake = installFakeDom();
        globalThis.sessionStorage = {
            _m: new Map(),
            getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
            setItem(k, v) { this._m.set(String(k), String(v)); },
            removeItem(k) { this._m.delete(String(k)); },
        };
    });

    afterEach(() => {
        fake?.restore();
        delete globalThis.sessionStorage;
    });

    it('API panel supports highlight selection without checkbox, select all, clear, and delete selected', async () => {
        const root = document.createElement('div');
        root.className = 'nd-root';
        document.body.appendChild(root);
        const settings = defaultPluginSettings();
        let llms = [
            { id: 'llm-1', name: '甲', model: 'm1', baseUrl: 'https://a' },
            { id: 'llm-2', name: '乙', model: 'm2', baseUrl: 'https://b' },
        ];
        const removed = [];

        const panel = mountApiConfigPanel(root, {
            host: { toast: () => {} },
            loadSettings: () => settings,
            saveSettings: (next) => Object.assign(settings, next),
            repos: {
                llmConfig: {
                    list: async () => Ok(llms.map((x) => ({ ...x }))),
                    get: async (id) => Ok(llms.find((x) => x.id === id) || null),
                    remove: async (id) => {
                        removed.push(id);
                        llms = llms.filter((x) => x.id !== id);
                        return Ok(undefined);
                    },
                    onChanged: () => () => {},
                },
                naiConfig: {
                    list: async () => Ok([]),
                    get: async () => Ok(null),
                    remove: async () => Ok(undefined),
                    onChanged: () => () => {},
                },
            },
            services: { llmSecrets: null },
        });

        await flush();
        fire(buttonByText(root, '选择'), 'click');

        // 不能出现勾选方框
        const cardCheckboxes = findAll(root, (n) => hasClass(n, 'nd-style-card__select'));
        assert.equal(cardCheckboxes.length, 0);

        const cards = findAll(root, (n) => hasClass(n, 'nd-style-card'));
        assert.equal(cards.length, 2);
        fire(cards[0], 'click');
        assert.equal(cards[0].classList.contains('is-selected'), true);
        assert.equal(buttonByText(root, '删除所选').disabled, false);

        fire(buttonByText(root, '取消选择'), 'click');
        assert.equal(buttonByText(root, '删除所选').disabled, true);

        fire(buttonByText(root, '全选'), 'click');
        assert.equal(buttonByText(root, '删除所选').disabled, false);
        fire(buttonByText(root, '删除所选'), 'click');
        await flush();
        fire(buttonByText(document.body, '确认删除'), 'click');
        await flush();

        assert.deepEqual(removed, ['llm-1', 'llm-2']);
        panel.destroy();
    });

    it('Tag panel supports highlight selection for libraries and entries without checkboxes', async () => {
        const root = document.createElement('div');
        root.className = 'nd-root';
        document.body.appendChild(root);

        let libs = [
            { id: 'lib-1', name: '构图A', kind: 'composition', active: true },
            { id: 'lib-2', name: '特征B', kind: 'feature', active: true },
        ];
        let entries = [
            { id: 'e-1', libraryId: 'lib-1', key: 'k1', value: 'v1', active: true },
            { id: 'e-2', libraryId: 'lib-1', key: 'k2', value: 'v2', active: true },
        ];
        const removedLibs = [];
        const removedEntries = [];

        const panel = mountTagPanel(root, {
            host: { toast: () => {} },
            repos: {
                tag: {
                    listLibraries: async () => Ok(libs.map((x) => ({ ...x }))),
                    listEntries: async (lid) => Ok(entries.filter((e) => e.libraryId === lid)),
                    removeLibrary: async (id) => {
                        removedLibs.push(id);
                        libs = libs.filter((x) => x.id !== id);
                        entries = entries.filter((e) => e.libraryId !== id);
                        return Ok(undefined);
                    },
                    remove: async (id) => {
                        removedEntries.push(id);
                        entries = entries.filter((e) => e.id !== id);
                        return Ok(undefined);
                    },
                },
            },
        });

        await flush();
        // 先展开第一个库，再进入选择模式，展开态应保持
        const expandBtns = findAll(root, (n) => hasClass(n, 'nd-nested-list__expand'));
        fire(expandBtns[0], 'click');
        fire(buttonByText(root, '选择'), 'click');

        // 选中第一个子条目（点行高亮）
        const childRows = findAll(root, (n) => hasClass(n, 'nd-nested-list__child'));
        assert.equal(childRows.length, 2);
        fire(childRows[0], 'click');
        assert.equal(childRows[0].classList.contains('is-selected'), true);
        assert.equal(buttonByText(root, '删除所选').disabled, false);

        fire(buttonByText(root, '删除所选'), 'click');
        await flush();
        fire(buttonByText(document.body, '确认删除'), 'click');
        await flush();
        assert.deepEqual(removedEntries, ['e-1']);
        assert.deepEqual(removedLibs, []);

        // 全选删除全部可见库
        fire(buttonByText(root, '全选'), 'click');
        fire(buttonByText(root, '删除所选'), 'click');
        await flush();
        fire(buttonByText(document.body, '确认删除'), 'click');
        await flush();
        assert.deepEqual(removedLibs.sort(), ['lib-1', 'lib-2']);

        panel.destroy();
    });

    it('Character panel supports highlight selection for groups and characters without checkboxes', async () => {
        const root = document.createElement('div');
        root.className = 'nd-root';
        document.body.appendChild(root);

        let groups = [
            { id: 'g-1', name: '主角组', active: true, order: 0 },
            { id: 'g-2', name: '配角组', active: true, order: 1 },
        ];
        let chars = [
            { id: 'c-1', groupId: 'g-1', name: '甲', keywords: ['a'], fixedFeatures: '' },
            { id: 'c-2', groupId: 'g-1', name: '乙', keywords: ['b'], fixedFeatures: '' },
        ];
        const removedGroups = [];
        const removedChars = [];

        const panel = mountCharacterPanel(root, {
            host: { toast: () => {} },
            repos: {
                character: {
                    listGroups: async () => Ok(groups.map((x) => ({ ...x }))),
                    listByGroup: async (gid) => Ok(chars.filter((c) => c.groupId === gid)),
                    removeGroup: async (id) => {
                        removedGroups.push(id);
                        groups = groups.filter((x) => x.id !== id);
                        chars = chars.filter((c) => c.groupId !== id);
                        return Ok(undefined);
                    },
                    remove: async (id) => {
                        removedChars.push(id);
                        chars = chars.filter((c) => c.id !== id);
                        return Ok(undefined);
                    },
                },
            },
        });

        await flush();
        const expandBtns = findAll(root, (n) => hasClass(n, 'nd-nested-list__expand'));
        fire(expandBtns[0], 'click');
        fire(buttonByText(root, '选择'), 'click');

        // 选中一个角色
        const childRows = findAll(root, (n) => hasClass(n, 'nd-nested-list__child'));
        assert.equal(childRows.length, 2);
        fire(childRows[1], 'click');
        assert.equal(childRows[1].classList.contains('is-selected'), true);

        // 取消选择后按钮禁用
        fire(buttonByText(root, '取消选择'), 'click');
        assert.equal(buttonByText(root, '删除所选').disabled, true);

        // 选第二个组（点 header 高亮）
        const headers = findAll(root, (n) => hasClass(n, 'nd-nested-list__header'));
        const parents = findAll(root, (n) => hasClass(n, 'nd-nested-list__parent'));
        fire(headers[1], 'click');
        assert.equal(parents[1].classList.contains('is-selected'), true);

        fire(buttonByText(root, '删除所选'), 'click');
        await flush();
        fire(buttonByText(document.body, '确认删除'), 'click');
        await flush();
        assert.deepEqual(removedGroups, ['g-2']);
        assert.deepEqual(removedChars, []);

        panel.destroy();
    });
});
