/**
 * 分段标签 + API 库单库渲染 + 卡片无偏移阴影回归。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ok } from '../../src/infra/result.js';
import { installFakeDom } from './fake-dom.js';
import { createSegmentedTabs } from '../../src/ui/common/controls.js';
import { createStyleCard } from '../../src/ui/common/library-chrome.js';
import { mountApiConfigPanel } from '../../src/ui/panels/api-config/api-config-panel.js';
import { defaultPluginSettings } from '../../src/domain/model/plugin-settings.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const componentsCss = readFileSync(join(__dirname, '../../src/ui/common/components.css'), 'utf8');

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
        if (String(node.className || '').split(/\s+/).includes(className)) out.push(node);
        for (const child of node.childNodes || []) walk(child);
    }
    walk(root);
    return out;
}

/**
 * @param {object} root
 * @param {string} className
 * @returns {object|null}
 */
function findByClass(root, className) {
    return findAllByClass(root, className)[0] ?? null;
}

describe('createSegmentedTabs', () => {
    /** @type {ReturnType<typeof installFakeDom>|null} */
    let fake = null;

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
        fake = null;
        delete globalThis.sessionStorage;
    });

    it('role=tablist/tab，左右键切换，记住上次选中', () => {
        /** @type {string[]} */
        const changes = [];
        const segs = createSegmentedTabs({
            storageKey: 'test-seg',
            items: [
                { id: 'a', label: '甲' },
                { id: 'b', label: '乙' },
            ],
            onChange: (id) => changes.push(id),
        });
        document.body.appendChild(segs.el);
        assert.equal(segs.el.getAttribute('role'), 'tablist');
        const tabs = [...(segs.el.childNodes || [])];
        assert.equal(tabs.length, 2);
        assert.equal(tabs[0].getAttribute('role'), 'tab');
        assert.equal(tabs[0].getAttribute('aria-selected'), 'true');
        assert.ok(String(tabs[0].className).includes('is-active'));

        tabs[0].dispatchEvent?.({ type: 'keydown', key: 'ArrowRight', preventDefault() {} });
        // fake-dom may not fire via dispatchEvent — call listeners
        for (const l of tabs[0]._listeners || []) {
            if (l.type === 'keydown') {
                l.fn({ key: 'ArrowRight', preventDefault() {} });
            }
        }
        assert.equal(segs.getValue(), 'b');
        assert.deepEqual(changes, ['b']);
        assert.equal(sessionStorage.getItem('test-seg'), 'b');

        segs.destroy();
        const again = createSegmentedTabs({
            storageKey: 'test-seg',
            items: [
                { id: 'a', label: '甲' },
                { id: 'b', label: '乙' },
            ],
        });
        assert.equal(again.getValue(), 'b');
        again.destroy();
    });
});

describe('API panel segmented + single library', () => {
    /** @type {ReturnType<typeof installFakeDom>|null} */
    let fake = null;

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
        fake = null;
        delete globalThis.sessionStorage;
    });

    it('只挂一套工具栏；切换分段后仍只有一个库视图', async () => {
        const root = document.createElement('div');
        document.body.appendChild(root);
        const settings = { ...defaultPluginSettings(), recallLlmConfigId: 'llm-1' };
        const api = mountApiConfigPanel(root, {
            host: {
                toast: () => {},
                openModal: async () => ({ destroy: () => {} }),
            },
            loadSettings: () => settings,
            saveSettings: (next) => Object.assign(settings, next),
            repos: {
                llmConfig: {
                    list: async () => Ok([{
                        id: 'llm-1', name: '默认 LLM', model: 'preview-model',
                        secretId: 's1', baseUrl: 'https://x',
                    }]),
                    get: async () => Ok(null),
                    remove: async () => Ok(undefined),
                    onChanged: () => () => {},
                    exportJson: async () => Ok({}),
                    importJson: async () => Ok({}),
                },
                naiConfig: {
                    list: async () => Ok([{
                        id: 'nai-1', name: '默认 NAI',
                        baseUrl: 'https://image.novelai.net',
                        transport: 'direct', apiKey: 'k',
                    }]),
                    get: async () => Ok(null),
                    remove: async () => Ok(undefined),
                    onChanged: () => () => {},
                    exportJson: async () => Ok({}),
                    importJson: async () => Ok({}),
                },
            },
            services: { llmSecrets: null },
            newId: () => 'x',
            nowIso: () => '2026-01-01T00:00:00.000Z',
        });

        await new Promise((r) => setTimeout(r, 20));
        assert.equal(findAllByClass(root, 'nd-segment').length, 1);
        assert.equal(findAllByClass(root, 'nd-library-toolbar').length, 1);
        assert.equal(findAllByClass(root, 'nd-library-view').length, 1);

        const chip = findByClass(root, 'nd-style-card__chip');
        assert.equal(chip?.textContent, '召回');
        const status = findByClass(root, 'nd-style-card__status');
        assert.equal(status?.textContent, '已填 Key');
        const sub = findByClass(root, 'nd-style-card__subtitle');
        assert.equal(sub?.textContent, 'preview-model');

        const seg = findByClass(root, 'nd-segment');
        const naiTab = [...(seg.childNodes || [])].find((n) => n.textContent === 'NAI API 库');
        for (const l of naiTab?._listeners || []) {
            if (l.type === 'click') l.fn({ preventDefault() {} });
        }
        await new Promise((r) => setTimeout(r, 20));
        assert.equal(findAllByClass(root, 'nd-library-toolbar').length, 1);
        assert.equal(findAllByClass(root, 'nd-library-view').length, 1);
        assert.equal(findByClass(root, 'nd-style-card__subtitle')?.textContent?.includes('image.novelai.net'), true);

        api.destroy();
    });

    it('NAI 卡片显示电量和点数', async () => {
        const root = document.createElement('div');
        document.body.appendChild(root);
        const settings = { ...defaultPluginSettings() };
        sessionStorage.setItem('nai-dbgen:api-kind', 'nai');
        const api = mountApiConfigPanel(root, {
            host: { toast: () => {}, openModal: async () => ({ destroy: () => {} }) },
            loadSettings: () => settings,
            saveSettings: (next) => Object.assign(settings, next),
            imageGenPort: {
                fetchSubscription: async () => Ok({
                    energy: { percent: 87, unavailable: false, refillSeconds: 120 },
                    fixedAnlas: 9898,
                    purchasedAnlas: 32,
                    points: 9930,
                }),
            },
            repos: {
                llmConfig: {
                    list: async () => Ok([]),
                    onChanged: () => () => {},
                },
                naiConfig: {
                    list: async () => Ok([{
                        id: 'nai-1',
                        name: '默认 NAI',
                        baseUrl: 'https://image.novelai.net',
                        transport: 'direct',
                        apiKey: 'pst-test',
                    }]),
                    onChanged: () => () => {},
                },
            },
            services: { llmSecrets: null },
            newId: () => 'x',
            nowIso: () => '2026-01-01T00:00:00.000Z',
        });

        let chip = null;
        for (let i = 0; i < 20 && !chip; i += 1) {
            await new Promise((r) => setTimeout(r, 10));
            chip = findAllByClass(root, 'nd-style-card__chip')
                .find((node) => String(node.textContent || '').includes('电量'));
        }
        assert.equal(chip?.textContent, '电量 87% · 点数 9,930');
        api.destroy();
    });
});

describe('style card chrome regression', () => {
    it('卡片无大偏移阴影 / 无 active outline 底板', () => {
        assert.match(
            componentsCss,
            /\.nd-style-card\s*\{[^}]*box-shadow:\s*none/s,
        );
        assert.match(
            componentsCss,
            /\.nd-style-card--no-cover\s*\{[^}]*box-shadow:\s*none/s,
        );
        assert.match(
            componentsCss,
            /\.nd-style-card:hover\s*\{[^}]*transform:\s*none/s,
        );
        assert.match(
            componentsCss,
            /\.nd-style-card\.is-active[^}]*outline:\s*none/s,
        );
        assert.match(
            componentsCss,
            /\.nd-style-card\.is-selected[^}]*outline:\s*none/s,
        );
        assert.match(
            componentsCss,
            /\.nd-style-card\.is-active[^}]*border-color:\s*var\(--nd-accent\)/s,
        );
        assert.match(
            componentsCss,
            /\.nd-style-card\.is-selected[^}]*border-color:\s*var\(--nd-accent\)/s,
        );
        assert.match(
            componentsCss,
            /\.nd-style-card__chip\s*\{[^}]*border-radius:\s*var\(--nd-radius-pill\)/s,
        );
        assert.match(
            componentsCss,
            /\.nd-style-grid\s*\{[^}]*align-items:\s*stretch/s,
        );
        assert.match(
            componentsCss,
            /\.nd-style-grid--text\s*\{[^}]*align-items:\s*stretch/s,
        );
        assert.doesNotMatch(
            componentsCss,
            /\.nd-style-card\s*\{[^}]*box-shadow:\s*0\s+18px\s+50px/s,
        );
        assert.doesNotMatch(
            componentsCss,
            /\.nd-style-card[^{]*\{[^}]*box-shadow:\s*var\(--nd-shadow-card\)/s,
        );
        assert.doesNotMatch(
            componentsCss,
            /\.nd-style-card:hover\s*\{[^}]*translateY\(-4px\)/s,
        );
        /* 粉底板曾来自 outline + accent-wash，禁止再叠伪元素底板 */
        assert.doesNotMatch(componentsCss, /\.nd-style-card::(before|after)\s*\{/);
        assert.doesNotMatch(
            componentsCss,
            /\.nd-style-card\.is-active[^}]*outline:\s*2px\s+solid\s+var\(--nd-accent-ring\)/s,
        );
        assert.doesNotMatch(
            componentsCss,
            /\.nd-style-card\.is-active[^}]*background:\s*var\(--nd-accent-wash\)/s,
        );
    });

    it('createStyleCard 渲染芯片行且不截断用途', () => {
        const fake = installFakeDom();
        try {
            const card = createStyleCard({
                title: '默认 LLM',
                subtitle: 'preview-model',
                chips: ['召回', '提示词'],
                status: '已填 Key',
                cover: false,
                actions: [{ label: '编辑' }],
            });
            const chips = findByClass(card.el, 'nd-style-card__chips');
            assert.ok(chips);
            const labels = [...(chips.childNodes || [])].map((n) => n.textContent);
            assert.deepEqual(labels, ['召回', '提示词', '已填 Key']);
            card.destroy();
        } finally {
            fake.restore();
        }
    });
});
