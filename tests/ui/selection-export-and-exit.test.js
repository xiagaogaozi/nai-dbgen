/**
 * 覆盖：
 * 1. buildExportFilename 与各库按所选导出文件命名（画师串 V4 / V5 / V4V5、标签库、角色库、API 库、预设库）
 * 2. 点击空白处自动取消并退出选择界面（点击卡片/批量栏/按钮保持选择）
 * 3. 大列表导入预览分批渲染（首批 ≤100 行，保留全部勾选数据）
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Ok } from '../../src/infra/result.js';
import { installFakeDom } from './fake-dom.js';
import { defaultPluginSettings } from '../../src/domain/model/plugin-settings.js';
import { createArtist } from '../../src/domain/model/artist.js';
import { buildExportFilename, mountImportExport } from '../../src/ui/common/import-export.js';
import { mountArtistPanel } from '../../src/ui/panels/artist/artist-panel.js';
import { mountTagPanel } from '../../src/ui/panels/tag/tag-panel.js';
import { mountPresetPanel } from '../../src/ui/panels/preset/preset-panel.js';

const flush = () => new Promise((r) => setTimeout(r, 15));

function fire(node, type, extra = {}) {
    const list = node._listeners || node._docListeners || [];
    for (const l of list.filter((x) => x.type === type)) {
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

function buttonByText(root, label) {
    return findAll(root, (n) => String(n.tagName || '').toLowerCase() === 'button' && n.textContent === label)[0];
}

describe('export filenames, selection-based export, outside click exit, and chunked import preview', () => {
    let fake;
    /** @type {string[]} */
    let downloadedNames;
    let origCreateObjectURL;
    let origRevokeObjectURL;

    beforeEach(() => {
        fake = installFakeDom();
        downloadedNames = [];
        globalThis.sessionStorage = {
            _m: new Map(),
            getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
            setItem(k, v) { this._m.set(String(k), String(v)); },
            removeItem(k) { this._m.delete(String(k)); },
        };
        origCreateObjectURL = URL.createObjectURL;
        origRevokeObjectURL = URL.revokeObjectURL;
        URL.createObjectURL = () => 'blob:mock-export';
        URL.revokeObjectURL = () => {};

        const origCreateElement = document.createElement.bind(document);
        document.createElement = (tag) => {
            const el = origCreateElement(tag);
            if (String(tag).toLowerCase() === 'a') {
                el.click = () => {
                    downloadedNames.push(String(el.download || ''));
                };
            }
            return el;
        };
    });

    afterEach(() => {
        URL.createObjectURL = origCreateObjectURL;
        URL.revokeObjectURL = origRevokeObjectURL;
        fake?.restore();
        delete globalThis.sessionStorage;
    });

    it('buildExportFilename follows nai-dbgen-<模块>[-版本]-<时间戳>.json', () => {
        assert.equal(buildExportFilename('画师串', 'V5', 1795456982550), 'nai-dbgen-画师串-V5-1795456982550.json');
        assert.equal(buildExportFilename('画师串', 'V4.5', 1795456982550), 'nai-dbgen-画师串-V4.5-1795456982550.json');
        assert.equal(buildExportFilename('画师串', '', 1795456982550), 'nai-dbgen-画师串-1795456982550.json');
        assert.equal(buildExportFilename('标签库', '', 123), 'nai-dbgen-标签库-123.json');
        assert.equal(buildExportFilename('角色库', '', 123), 'nai-dbgen-角色库-123.json');
    });

    it('Artist panel exports V5 / V4.5 / mixed without version, toggles version switch buttons, and exits on blank click inside dialog.nd-popup', async () => {
        const items = [
            createArtist({ name: '画师5', sequence: 0, positivePrompt: 'p5', negativePrompt: '', modelTag: 'v5' }, { id: 'a5', now: '2026-01-01T00:00:00.000Z' }),
            createArtist({ name: '画师4', sequence: 1, positivePrompt: 'p4', negativePrompt: '', modelTag: 'v4.5' }, { id: 'a4', now: '2026-01-01T00:00:00.000Z' }),
        ];
        /** @type {string[][]} */
        const exportedIdBatches = [];
        /** @type {string[]} */
        const toasts = [];
        // 真实管理台嵌套在 dialog.nd-popup 中
        const hostDialog = document.createElement('dialog');
        hostDialog.className = 'nd-root nd-popup';
        const root = document.createElement('div');
        hostDialog.appendChild(root);
        document.body.appendChild(hostDialog);

        const panel = mountArtistPanel(root, {
            repos: {
                artist: {
                    list: async () => Ok(items.map((x) => ({ ...x }))),
                    exportJson: async (opts) => {
                        exportedIdBatches.push([...(opts?.ids || [])]);
                        const set = new Set(opts?.ids || []);
                        return Ok(items.filter((x) => set.has(x.id)));
                    },
                },
            },
            artistFileUrl: { urlOf: async () => null },
            host: { toast: (_lvl, msg) => toasts.push(String(msg)) },
            loadSettings: () => defaultPluginSettings(),
        });

        await flush();
        // 未进入选择模式时「导出」按钮处于隐藏的批量栏
        assert.equal(buttonByText(root, '导出').hidden, true);

        // 进入选择模式：未选时「改为 v4.5」「改为 v5」均隐藏
        fire(buttonByText(root, '选择'), 'click');
        assert.equal(buttonByText(root, '改为 v4.5').hidden, true);
        assert.equal(buttonByText(root, '改为 v5').hidden, true);

        // 只选 V5：只显示「改为 v4.5」，隐藏「改为 v5」；导出文件名含 V5
        const boxes = findAll(root, (n) => String(n.tagName || '').toLowerCase() === 'input' && n.type === 'checkbox');
        assert.equal(boxes.length, 2);
        boxes[0].checked = true;
        fire(boxes[0], 'change');
        assert.equal(buttonByText(root, '改为 v4.5').hidden, false);
        assert.equal(buttonByText(root, '改为 v5').hidden, true);
        fire(buttonByText(root, '导出'), 'click');
        await flush();
        assert.deepEqual(exportedIdBatches[0], ['a5']);
        assert.match(downloadedNames[0], /^nai-dbgen-画师串-V5-\d+\.json$/);

        // 全选后再取消全选，再只选 V4.5：只显示「改为 v5」，隐藏「改为 v4.5」；导出文件名含 V4.5
        fire(buttonByText(root, '全选'), 'click');
        assert.equal(buttonByText(root, '改为 v4.5').hidden, false);
        assert.equal(buttonByText(root, '改为 v5').hidden, false);
        assert.ok(buttonByText(root, '取消全选'));
        fire(buttonByText(root, '取消全选'), 'click');
        assert.ok(buttonByText(root, '全选'));

        const boxes2 = findAll(root, (n) => String(n.tagName || '').toLowerCase() === 'input' && n.type === 'checkbox');
        boxes2[1].checked = true;
        fire(boxes2[1], 'change');
        assert.equal(buttonByText(root, '改为 v4.5').hidden, true);
        assert.equal(buttonByText(root, '改为 v5').hidden, false);
        fire(buttonByText(root, '导出'), 'click');
        await flush();
        assert.deepEqual(exportedIdBatches[1], ['a4']);
        assert.match(downloadedNames[1], /^nai-dbgen-画师串-V4\.5-\d+\.json$/);

        // 全选混合 V4.5 + V5 导出：文件名不带版本号，并弹出混合提示
        fire(buttonByText(root, '全选'), 'click');
        fire(buttonByText(root, '导出'), 'click');
        await flush();
        assert.match(downloadedNames[2], /^nai-dbgen-画师串-\d+\.json$/);
        assert.ok(toasts.some((m) => m.includes('混合导出')));

        // 点上层子确认 dialog 内：保持选择模式不退出
        const childDialog = document.createElement('dialog');
        const childBlank = document.createElement('div');
        childDialog.appendChild(childBlank);
        document.body.appendChild(childDialog);
        fire(document, 'click', { target: childBlank });
        assert.ok(buttonByText(root, '完成'));
        childDialog.remove();

        // 点管理台自身 dialog 内的空白区：自动退出选择模式
        const statusEl = findAll(root, (n) => hasClass(n, 'nd-library-view__status'))[0];
        fire(document, 'click', { target: statusEl });
        assert.ok(buttonByText(root, '选择'));
        assert.equal(buttonByText(root, '完成'), undefined);

        panel.destroy();
    });

    it('Tag panel and Preset panel export selected with Chinese module names and exit on blank click', async () => {
        // 标签库
        const tagRoot = document.createElement('div');
        tagRoot.className = 'nd-root';
        document.body.appendChild(tagRoot);
        const tagPanel = mountTagPanel(tagRoot, {
            host: { toast: () => {} },
            repos: {
                tag: {
                    listLibraries: async () => Ok([{ id: 'lib-1', name: '构图', kind: 'composition', active: true }]),
                    listEntries: async () => Ok([{ id: 'e-1', libraryId: 'lib-1', key: 'k', value: 'v', active: true }]),
                },
            },
        });
        await flush();
        assert.equal(buttonByText(tagRoot, '导出').hidden, false); // 按钮在隐藏的 bulkBar 内
        fire(buttonByText(tagRoot, '选择'), 'click');
        fire(buttonByText(tagRoot, '全选'), 'click');
        assert.ok(buttonByText(tagRoot, '取消全选'));
        fire(buttonByText(tagRoot, '导出'), 'click');
        assert.match(downloadedNames.at(-1) || '', /^nai-dbgen-标签库-\d+\.json$/);

        const listHost = findAll(tagRoot, (n) => hasClass(n, 'nd-panel__list'))[0];
        fire(document, 'click', { target: listHost });
        assert.equal(buttonByText(tagRoot, '选择') != null, true);
        tagPanel.destroy();

        // 预设库
        const presetRoot = document.createElement('div');
        presetRoot.className = 'nd-root';
        document.body.appendChild(presetRoot);
        const settings = defaultPluginSettings();
        const presetPanel = mountPresetPanel(presetRoot, {
            host: { toast: () => {} },
            loadSettings: () => settings,
            saveSettings: (next) => Object.assign(settings, next),
            repos: {
                preset: {
                    list: async () => Ok([{ id: 'pr-1', name: '默认生图', kind: 'imagegen', prompts: [] }]),
                    remove: async () => Ok(undefined),
                    onChanged: () => () => {},
                },
            },
        });
        await flush();
        fire(buttonByText(presetRoot, '选择'), 'click');
        // 无勾选方框
        assert.equal(findAll(presetRoot, (n) => hasClass(n, 'nd-style-card__select')).length, 0);
        fire(buttonByText(presetRoot, '全选'), 'click');
        assert.ok(buttonByText(presetRoot, '取消全选'));
        fire(buttonByText(presetRoot, '导出'), 'click');
        await flush();
        assert.match(downloadedNames.at(-1) || '', /^nai-dbgen-生图预设-\d+\.json$/);

        const presetStatus = findAll(presetRoot, (n) => hasClass(n, 'nd-library-view__status'))[0];
        fire(document, 'click', { target: presetStatus });
        assert.equal(buttonByText(presetRoot, '选择') != null, true);
        presetPanel.destroy();
    });

    it('mountImportExport chunks large preview tables while preserving all checked items on commit', async () => {
        const root = document.createElement('div');
        root.className = 'nd-root';
        document.body.appendChild(root);

        let committedCount = 0;
        const handle = mountImportExport(root, {
            mode: 'import',
            countOverwrite: () => 0,
            importJson: async (data) => {
                committedCount = Array.isArray(data.items) ? data.items.length : 0;
                return { imported: committedCount, skipped: 0, errors: [] };
            },
        });

        const bigPayload = {
            schemaVersion: 1,
            kind: 'preset',
            items: Array.from({ length: 250 }, (_, i) => ({ id: `id-${i}`, name: `条目-${i}` })),
        };
        const textarea = findAll(root, (n) => String(n.tagName || '').toLowerCase() === 'textarea')[0];
        textarea.value = JSON.stringify(bigPayload);
        fire(buttonByText(root, '解析粘贴内容'), 'click');

        // 首批只渲染 100 条数据行 + 1 条「加载更多」行
        const tbody = findAll(root, (n) => String(n.tagName || '').toLowerCase() === 'tbody')[0];
        assert.equal(tbody.childNodes.length, 101);
        assert.ok(hasClass(tbody.childNodes[100], 'nd-import-more'));

        // 未展开全部直接导入，仍应完整导入全部 250 条
        fire(buttonByText(root, '导入已勾选'), 'click');
        await flush();
        assert.equal(committedCount, 250);

        handle.destroy();
    });
});
