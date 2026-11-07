/**
 * W2-I · mountWorkbench：解耦接线、开关透传、禁连点、Abort、dispose。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom } from './fake-dom.js';
import { mountWorkbench } from '../../src/ui/workbench/workbench.js';
import { createNaiParamsForm } from '../../src/ui/common/nai-params-form.js';
import { defaultNaiParams, emptyNaiCaption } from '../../src/domain/model/nai-params.js';

describe('ui/workbench mountWorkbench', () => {
    /** @type {ReturnType<typeof installFakeDom>|null} */
    let fake = null;

    beforeEach(() => {
        fake = installFakeDom();
    });

    afterEach(() => {
        fake?.restore();
        fake = null;
    });

    /**
     * @param {object} [overrides]
     */
    function mount(overrides = {}) {
        const root = document.createElement('div');
        document.body.appendChild(root);

        /** @type {object[]} */
        const writeCalls = [];
        /** @type {object[]} */
        const genCalls = [];
        /** @type {Array<[string, string]>} */
        const toasts = [];

        let writeResolve;
        /** @type {Promise<any>|null} */
        let writeGate = null;
        let genResolve;
        /** @type {Promise<any>|null} */
        let genGate = null;

        const workbenchService = {
            async writePrompt(input) {
                writeCalls.push(input);
                if (writeGate) await writeGate;
                return {
                    ok: true,
                    value: {
                        caption: {
                            v4_prompt: {
                                caption: {
                                    base_caption: 'llm-base',
                                    char_captions: [
                                        {
                                            char_caption: 'char-pos',
                                            centers: [{ x: 0.3, y: 0.7 }],
                                        },
                                    ],
                                },
                            },
                            v4_negative_prompt: {
                                caption: {
                                    base_caption: 'llm-neg',
                                    char_captions: [
                                        {
                                            char_caption: 'char-neg',
                                            centers: [{ x: 0.3, y: 0.7 }],
                                        },
                                    ],
                                },
                            },
                        },
                        unmatchedKeys: ['fabricated-key'],
                    },
                };
            },
            async generateImage(input) {
                genCalls.push(input);
                if (genGate) await genGate;
                return {
                    ok: true,
                    value: [{
                        blob: typeof Blob !== 'undefined'
                            ? new Blob(['png'], { type: 'image/png' })
                            : /** @type {any} */ ({}),
                        mimeType: 'image/png',
                    }],
                };
            },
        };

        Object.assign(workbenchService, overrides.service || {});

        const handle = mountWorkbench(root, {
            workbenchService,
            loadSettings: () => ({
                naiParams: defaultNaiParams(),
            }),
            host: {
                toast(level, message) {
                    toasts.push([level, message]);
                },
            },
            tagRepo: {
                async listLibraries() {
                    return {
                        ok: true,
                        value: [
                            { id: 'lib1', name: '风景', active: true },
                            { id: 'lib2', name: '服饰', active: false },
                        ],
                    };
                },
            },
            ...overrides.deps,
        });

        return {
            root,
            handle,
            writeCalls,
            genCalls,
            toasts,
            holdWrite() {
                writeGate = new Promise((r) => { writeResolve = r; });
            },
            releaseWrite() {
                writeResolve?.();
                writeGate = null;
            },
            holdGen() {
                genGate = new Promise((r) => { genResolve = r; });
            },
            releaseGen() {
                genResolve?.();
                genGate = null;
            },
        };
    }

    /**
     * 在假 DOM 上按按钮文案找按钮并点它。
     * @param {Element} root
     * @param {string} label
     */
    async function clickButton(root, label) {
        /** @type {any[]} */
        const stack = [root];
        while (stack.length) {
            const node = stack.pop();
            if (!node) continue;
            if (String(node.tagName).toUpperCase() === 'BUTTON'
                && node.textContent === label) {
                const listeners = (node._listeners || []).filter((l) => l.type === 'click');
                assert.ok(listeners.length >= 1, `no click listener on ${label}`);
                for (const l of listeners) {
                    await l.fn({ preventDefault() {} });
                }
                return node;
            }
            if (Array.isArray(node.childNodes)) {
                for (const c of node.childNodes) stack.push(c);
            }
        }
        throw new Error(`button not found: ${label}`);
    }

    /**
     * @param {Element} root
     * @param {string} label
     * @param {boolean} checked
     */
    /**
     * @param {any} node
     * @returns {string}
     */
    function deepText(node) {
        if (!node) return '';
        const own = String(node._text || node.textContent || '');
        const kids = Array.isArray(node.childNodes)
            ? node.childNodes.map((c) => deepText(c)).join('')
            : '';
        return own + kids;
    }

    /**
     * @param {Element} root
     * @param {string} label
     * @param {boolean} checked
     */
    function setCheckboxByLabel(root, label, checked) {
        /** @type {any[]} */
        const stack = [root];
        while (stack.length) {
            const node = stack.pop();
            if (!node) continue;
            const cls = String(node.className || '');
            const isRow = /(^|\s)nd-checkbox-row(\s|$)/.test(cls)
                || /(^|\s)nd-toggle-row(\s|$)/.test(cls);
            if (isRow && deepText(node).includes(label)) {
                /** @type {any[]} */
                const inner = [node];
                let input = null;
                while (inner.length) {
                    const n = inner.pop();
                    if (!n) continue;
                    if (String(n.tagName).toUpperCase() === 'INPUT') {
                        input = n;
                        break;
                    }
                    if (Array.isArray(n.childNodes)) {
                        for (const c of n.childNodes) inner.push(c);
                    }
                }
                assert.ok(input, `checkbox input missing for ${label}`);
                input.checked = checked;
                const change = (input._listeners || []).find((l) => l.type === 'change');
                change?.fn();
                return;
            }
            if (Array.isArray(node.childNodes)) {
                for (const c of node.childNodes) stack.push(c);
            }
        }
        throw new Error(`checkbox not found: ${label}`);
    }

    /**
     * @param {Element} root
     * @param {string} label
     * @param {string|number} value
     */
    function setNumberByLabel(root, label, value) {
        /** @type {any[]} */
        const stack = [root];
        while (stack.length) {
            const node = stack.pop();
            if (!node) continue;
            if (String(node.className || '').includes('nd-field')) {
                const labelEl = (node.childNodes || []).find(
                    (c) => c && String(c.className || '').includes('nd-field__label'),
                );
                if (labelEl && String(labelEl.textContent || '') === label) {
                    const input = (node.childNodes || []).find(
                        (c) => c && String(c.tagName).toUpperCase() === 'INPUT',
                    );
                    assert.ok(input, `number input missing for ${label}`);
                    input.value = String(value);
                    const handler = (input._listeners || []).find((l) => l.type === 'input');
                    handler?.fn();
                    return;
                }
            }
            if (Array.isArray(node.childNodes)) {
                for (const c of node.childNodes) stack.push(c);
            }
        }
        throw new Error(`number field not found: ${label}`);
    }

    /**
     * @param {Element} root
     * @param {string} label
     * @param {string} value
     */
    function findTag(root, tag) {
        /** @type {any[]} */
        const stack = [root];
        while (stack.length) {
            const node = stack.pop();
            if (!node) continue;
            if (String(node.tagName || '').toUpperCase() === tag) return node;
            if (Array.isArray(node.childNodes)) {
                for (const c of node.childNodes) stack.push(c);
            }
        }
        return null;
    }

    function setSelectByLabel(root, label, value) {
        /** @type {any[]} */
        const stack = [root];
        while (stack.length) {
            const node = stack.pop();
            if (!node) continue;
            if (String(node.className || '').includes('nd-field')) {
                const labelEl = (node.childNodes || []).find(
                    (c) => c && String(c.className || '').includes('nd-field__label'),
                );
                if (labelEl && String(labelEl.textContent || '') === label) {
                    const select = (node.childNodes || []).find(
                        (c) => c && String(c.tagName).toUpperCase() === 'SELECT',
                    );
                    if (select) {
                        select.value = String(value);
                        const handler = (select._listeners || []).find((l) => l.type === 'change');
                        handler?.fn();
                        return;
                    }
                    const input = findTag(node, 'INPUT');
                    assert.ok(input, `control missing for ${label}`);
                    input.value = String(value);
                    const handler = (input._listeners || []).find((l) => l.type === 'input');
                    handler?.fn();
                    return;
                }
            }
            if (Array.isArray(node.childNodes)) {
                for (const c of node.childNodes) stack.push(c);
            }
        }
        throw new Error(`select not found: ${label}`);
    }

    /**
     * @param {Element} root
     * @param {string} label
     * @returns {any}
     */
    function findButton(root, label) {
        /** @type {any[]} */
        const stack = [root];
        while (stack.length) {
            const node = stack.pop();
            if (!node) continue;
            if (String(node.tagName).toUpperCase() === 'BUTTON'
                && node.textContent === label) {
                return node;
            }
            if (Array.isArray(node.childNodes)) {
                for (const c of node.childNodes) stack.push(c);
            }
        }
        return null;
    }

    it('写提示词只调 writePrompt，不调 generateImage；展示 unmatchedKeys', async () => {
        const ctx = mount();
        await new Promise((r) => setTimeout(r, 0)); // 等库列表
        await clickButton(ctx.root, '写提示词');
        await new Promise((r) => setTimeout(r, 0));

        assert.equal(ctx.writeCalls.length, 1);
        assert.equal(ctx.genCalls.length, 0);

        // unmatchedKeys 可见
        /** @type {any[]} */
        const stack = [ctx.root];
        let unmatchedText = '';
        while (stack.length) {
            const node = stack.pop();
            if (!node) continue;
            if (String(node.className || '').includes('nd-wb-unmatched')) {
                unmatchedText = String(node.textContent || '');
            }
            if (Array.isArray(node.childNodes)) {
                for (const c of node.childNodes) stack.push(c);
            }
        }
        assert.match(unmatchedText, /fabricated-key/);
        assert.match(unmatchedText, /未匹配的构图标签/);
        ctx.handle.destroy();
    });

    it('反推重绘和图生图分成两个按钮', () => {
        const ctx = mount();
        const reverse = findButton(ctx.root, '反推重绘');
        const img2img = findButton(ctx.root, '图生图');
        const gen = findButton(ctx.root, '出图');
        assert.ok(reverse);
        assert.ok(img2img);
        assert.notEqual(reverse, img2img);
        assert.notEqual(reverse.parentNode, gen.parentNode);
        assert.match(reverse.title, /没有也可以/);
        assert.match(reverse.title, /不自动出图/);
        assert.equal(reverse.closest('.nd-wb-column--right'), null);
        assert.ok(reverse.closest('.nd-wb-source'));
        assert.match(img2img.title, /不先反推/);
        ctx.handle.destroy();
    });

    it('出图只调 generateImage；replaceCharacterKeywords 来自开关', async () => {
        const ctx = mount();
        await clickButton(ctx.root, '出图');
        await new Promise((r) => setTimeout(r, 0));

        assert.equal(ctx.genCalls.length, 1);
        assert.equal(ctx.writeCalls.length, 0);
        assert.equal(ctx.genCalls[0].replaceCharacterKeywords, false);
        assert.ok(ctx.genCalls[0].caption);
        assert.equal(
            ctx.genCalls[0].params.model,
            defaultNaiParams().model,
            '参数默认来自 domain',
        );
        ctx.handle.destroy();
    });

    it('places each current-image download next to 出图 and clears those links with the preview', async () => {
        const ctx = mount();
        await clickButton(ctx.root, '出图');
        await new Promise((r) => setTimeout(r, 0));
        const actions = ctx.root.querySelector('.nd-wb-actions--generate');
        const downloads = actions.querySelector('.nd-wb-preview__downloads');
        assert.equal(actions.childNodes[0].textContent, '出图');
        assert.equal(actions.childNodes[1], downloads);
        const links = downloads.querySelectorAll('a');
        assert.equal(links.length, 1);
        assert.equal(links[0].textContent, '下载');
        assert.equal(ctx.root.querySelector('.nd-wb-preview__card').querySelector('a'), null);
        await clickButton(ctx.root, '清空');
        assert.equal(downloads.querySelectorAll('a').length, 0);
        ctx.handle.destroy();
    });

    it('开关拨开后，无论 caption 如何，透传 true', async () => {
        const ctx = mount();
        setCheckboxByLabel(ctx.root, '替换角色关键词', true);

        await clickButton(ctx.root, '出图');
        await new Promise((r) => setTimeout(r, 0));
        assert.equal(ctx.genCalls[0].replaceCharacterKeywords, true);
        ctx.handle.destroy();
    });

    it('出图进行中禁按钮，重复点击不重复计费', async () => {
        const ctx = mount();
        ctx.holdGen();

        const p1 = clickButton(ctx.root, '出图');
        await new Promise((r) => setTimeout(r, 0));

        const btn = findButton(ctx.root, '出图');
        assert.ok(btn);
        assert.equal(btn.disabled, true, '进行中必须禁用');

        // 再点一次应被门禁吞掉
        await clickButton(ctx.root, '出图');
        assert.equal(ctx.genCalls.length, 1, '不得连点连发');

        ctx.releaseGen();
        await p1;
        await new Promise((r) => setTimeout(r, 0));
        assert.equal(btn.disabled, false);
        ctx.handle.destroy();
    });

    it('Abort 出图不弹错误 toast', async () => {
        /** @type {object[]} */
        const genCalls = [];
        /** @type {Array<[string, string]>} */
        const toasts = [];
        const root = document.createElement('div');
        document.body.appendChild(root);
        const handle = mountWorkbench(root, {
            workbenchService: {
                async writePrompt() {
                    return { ok: true, value: { caption: emptyNaiCaption(), unmatchedKeys: [] } };
                },
                async generateImage(input) {
                    genCalls.push(input);
                    return {
                        ok: false,
                        error: { code: 'UPSTREAM_ABORTED', message: '请求已取消' },
                    };
                },
            },
            loadSettings: () => ({ naiParams: defaultNaiParams() }),
            host: {
                toast(level, message) {
                    toasts.push([level, message]);
                },
            },
        });

        await clickButton(root, '出图');
        await new Promise((r) => setTimeout(r, 0));
        assert.equal(genCalls.length, 1);
        assert.equal(toasts.filter((t) => t[0] === 'error').length, 0);
        handle.destroy();
    });

    it('dispose 后可再次挂载，无残留监听泄漏（按钮可销毁）', () => {
        const ctx = mount();
        ctx.handle.destroy();
        assert.equal(ctx.root.childNodes.length, 0);
        const ctx2 = mount();
        assert.ok(findButton(ctx2.root, '写提示词'));
        assert.ok(findButton(ctx2.root, '出图'));
        ctx2.handle.destroy();
    });

    it('D47: Variety / 透明底经 readParams 透传给出图', async () => {
        const ctx = mount();
        // Variety：4.5 开关；值由程序按尺寸计算
        setCheckboxByLabel(ctx.root, 'Variety', true);
        // 透明底：仅 V5 显示
        setSelectByLabel(ctx.root, '模型', 'nai-diffusion-5-full');
        setCheckboxByLabel(ctx.root, '透明底', true);

        await clickButton(ctx.root, '出图');
        await new Promise((r) => setTimeout(r, 0));

        assert.equal(ctx.genCalls.length, 1);
        const params = ctx.genCalls[0].params;
        // 切到 V5 后 Variety 被 coerce 关掉
        assert.equal(params.skip_cfg_above_sigma, null);
        assert.equal(params.tag_hint_transparent_background, true);
        assert.equal(params.straight_alpha, true);
        assert.equal(params.n_samples, defaultNaiParams().n_samples);
        assert.equal(params.model, 'nai-diffusion-5-full');
        ctx.handle.destroy();
    });

    it('D47b: 4.5 开启 Variety 按尺寸写入 skip_cfg_above_sigma', async () => {
        const ctx = mount();
        setCheckboxByLabel(ctx.root, 'Variety', true);
        await clickButton(ctx.root, '出图');
        await new Promise((r) => setTimeout(r, 0));
        const params = ctx.genCalls[0].params;
        assert.equal(params.model, 'nai-diffusion-4-5-full');
        assert.equal(params.skip_cfg_above_sigma, 58);
        assert.equal(params.tag_hint_qt, params.qualityToggle);
        ctx.handle.destroy();
    });

    it('D52: 双实例各自出图互不串扰（无 document 级定位）', async () => {
        const a = mount();
        const b = mount();
        await clickButton(b.root, '出图');
        await new Promise((r) => setTimeout(r, 0));
        assert.equal(a.genCalls.length, 0, '实例 A 不应被 B 的点击触发');
        assert.equal(b.genCalls.length, 1);
        a.handle.destroy();
        b.handle.destroy();
    });

    it('searches tag entries and hides the ones that do not match', async () => {
        const ctx = mount({
            deps: {
                tagRepo: {
                    async listLibraries() {
                        return {
                            ok: true,
                            value: [{ id: 'comp', name: '构图', kind: 'composition' }],
                        };
                    },
                    async listEntries() {
                        return {
                            ok: true,
                            value: [
                                { id: 'e1', key: '饮食：吃西瓜', value: 'holding a melon slice', active: true },
                                { id: 'e2', key: '饮食：吃苹果', value: 'holding an apple', active: true },
                                { id: 'e3', key: '镜头：仰视', value: 'from below', active: true },
                            ],
                        };
                    },
                },
            },
        });
        await new Promise((r) => setTimeout(r, 0));

        /**
         * @param {string} text
         * @returns {any}
         */
        function rowByLabel(text) {
            /** @type {any[]} */
            const stack = [ctx.root.querySelector('.nd-wb-libraries')];
            while (stack.length) {
                const node = stack.pop();
                if (!node) continue;
                if (node.textContent === text && node.parentNode) return node.parentNode;
                if (Array.isArray(node.childNodes)) {
                    for (const child of node.childNodes) stack.push(child);
                }
            }
            return null;
        }

        /** @type {any} */
        let input = null;
        /** @type {any[]} */
        const stack = [ctx.root];
        while (stack.length) {
            const node = stack.pop();
            if (!node) continue;
            if (node.tagName === 'INPUT' && node.placeholder === '搜索名称或正文') input = node;
            if (Array.isArray(node.childNodes)) {
                for (const child of node.childNodes) stack.push(child);
            }
        }
        assert.ok(input);
        input.value = 'melon slice';
        for (const listener of input._listeners || []) {
            if (listener.type === 'input') listener.fn();
        }
        await new Promise((r) => setTimeout(r, 320));

        const melon = rowByLabel('吃西瓜');
        const apple = rowByLabel('吃苹果');
        const camera = rowByLabel('镜头');
        const melonText = rowByLabel('holding a melon slice');
        assert.ok(melonText);
        assert.equal(melon.parentNode.hidden, false);
        assert.equal(apple.parentNode.hidden, true);
        assert.equal(camera.parentNode.hidden, true);

        input.value = '';
        for (const listener of input._listeners || []) {
            if (listener.type === 'input') listener.fn();
        }
        await new Promise((r) => setTimeout(r, 320));
        assert.equal(melon.parentNode.hidden, false);
        assert.equal(apple.parentNode.hidden, false);
        assert.equal(camera.parentNode.hidden, false);
        ctx.handle.destroy();
    });

    it('only shows checked tag entries when the filter is on', async () => {
        const ctx = mount({
            deps: {
                tagRepo: {
                    async listLibraries() {
                        return {
                            ok: true,
                            value: [{ id: 'comp', name: '构图', kind: 'composition' }],
                        };
                    },
                    async listEntries() {
                        return {
                            ok: true,
                            value: [
                                { id: 'e1', key: '饮食：吃西瓜', value: 'holding a melon slice', active: true },
                                { id: 'e2', key: '饮食：吃苹果', value: 'holding an apple', active: true },
                                { id: 'e3', key: '镜头：仰视', value: 'from below', active: true },
                            ],
                        };
                    },
                },
            },
        });
        await new Promise((r) => setTimeout(r, 0));

        /**
         * @param {string} text
         * @returns {any}
         */
        function rowByLabel(text) {
            /** @type {any[]} */
            const stack = [ctx.root.querySelector('.nd-wb-libraries')];
            while (stack.length) {
                const node = stack.pop();
                if (!node) continue;
                if (node.textContent === text && node.parentNode) return node.parentNode;
                if (Array.isArray(node.childNodes)) {
                    for (const child of node.childNodes) stack.push(child);
                }
            }
            return null;
        }

        /**
         * @param {any} box
         * @param {boolean} on
         */
        function setChecked(box, on) {
            const input = (box.childNodes || []).find((node) => node.tagName === 'INPUT');
            assert.ok(input);
            input.checked = on;
            for (const listener of input._listeners || []) {
                if (listener.type === 'change') listener.fn();
            }
        }

        /** @type {any[]} */
        const expanders = [];
        /** @type {any[]} */
        const stack = [ctx.root];
        while (stack.length) {
            const node = stack.pop();
            if (!node) continue;
            if (node.tagName === 'BUTTON' && node.getAttribute?.('aria-label') === '展开') expanders.push(node);
            if (Array.isArray(node.childNodes)) {
                for (const child of node.childNodes) stack.push(child);
            }
        }
        for (const button of expanders) {
            for (const listener of button._listeners || []) {
                if (listener.type === 'click') {
                    listener.fn({ preventDefault() {}, stopPropagation() {} });
                }
            }
        }

        const melon = rowByLabel('吃西瓜');
        const apple = rowByLabel('吃苹果');
        const camera = rowByLabel('镜头');
        assert.ok(melon);
        setChecked(melon, true);
        setChecked(rowByLabel('只看已勾选'), true);
        assert.equal(melon.parentNode.hidden, false);
        assert.equal(apple.parentNode.hidden, true);
        assert.equal(camera.parentNode.hidden, true);

        const dietHead = rowByLabel('饮食').parentNode;
        const collapse = (dietHead.childNodes || []).find((node) => node.tagName === 'BUTTON');
        assert.equal(collapse.getAttribute('aria-label'), '收起');
        for (const listener of collapse._listeners || []) {
            if (listener.type === 'click') {
                listener.fn({ preventDefault() {}, stopPropagation() {} });
            }
        }
        const dietBody = dietHead.parentNode.childNodes[
            dietHead.parentNode.childNodes.indexOf(dietHead) + 1
        ];
        assert.equal(dietBody.hidden, true);
        assert.equal(collapse.getAttribute('aria-label'), '展开');

        setChecked(rowByLabel('只看已勾选'), false);
        assert.equal(apple.parentNode.hidden, false);
        assert.equal(camera.parentNode.hidden, false);
        ctx.handle.destroy();
    });
    it('uses independent market catalog and inserts only into the focused caption field', async () => {
        const catalog = {
            schemaVersion: 1,
            kind: 'tag',
            libraries: [{ id: 'lib-1', name: '常用库' }],
            entries: [{ id: 'market-1', libraryId: 'lib-1', key: '性格·温柔', value: 'gentle expression' }],
        };
        const ctx = mount({ deps: { loadSettings: () => ({ naiParams: defaultNaiParams(), enableTagMarket: true }), marketCatalogStore: {
            async load() { return { ok: true, value: catalog }; },
            async replace(d) { return { ok: true, value: d }; },
        } } });
        const market = ctx.root.querySelector('.nd-wb-market');
        for (const listener of market.querySelector('.nd-wb-market__title')._listeners || []) {
            if (listener.type === 'click') listener.fn();
        }
        await new Promise((r) => setTimeout(r, 0));
        const catTab = market.querySelectorAll('.nd-wb-market__tab').find((tab) => tab.textContent === '性格');
        assert.ok(catTab, 'renders category tab');
        for (const l of catTab._listeners.filter((item) => item.type === 'click')) l.fn();
        let tag = market.querySelector('.nd-wb-market__tag');
        assert.equal(tag.childNodes[0].textContent, '温柔');
        assert.equal(tag.childNodes[1].textContent, 'gentle expression');
        const sceneField = ctx.root.querySelectorAll('.nd-field').find((field) =>
            field.querySelector('.nd-field__label')?.textContent === '场景 · 正面');
        const scene = sceneField.querySelector('textarea');
        scene.value = 'base';
        scene.selectionStart = scene.selectionEnd = 0;
        scene.setRangeText = (value, start, end) => { scene.value = scene.value.slice(0, start) + value + scene.value.slice(end); };
        scene.setSelectionRange = (start, end) => { scene.selectionStart = start; scene.selectionEnd = end; };
        scene.dispatchEvent = () => {};
        for (const l of tag._listeners.filter((item) => item.type === 'click')) l.fn();
        assert.equal(scene.value, 'base, gentle expression', 'no caret inserts at the end of scene positive');
        tag = market.querySelector('.nd-wb-market__tag');
        assert.equal(tag.getAttribute('aria-pressed'), 'true');
        assert.equal(ctx.toasts.some((entry) => entry[1].includes('先将光标')), false);
        for (const l of tag._listeners.filter((item) => item.type === 'click')) l.fn();
        assert.equal(scene.value, 'base', 'a second click removes the unchanged insertion');
        scene.selectionStart = scene.selectionEnd = 4;
        document.activeElement = scene;
        tag = market.querySelector('.nd-wb-market__tag');
        for (const l of tag._listeners.filter((item) => item.type === 'click')) l.fn();
        assert.equal(scene.value, 'base, gentle expression');
        tag = market.querySelector('.nd-wb-market__tag');
        for (const l of tag._listeners.filter((item) => item.type === 'click')) l.fn();
        assert.equal(scene.value, 'base', 'focused caret insertion still toggles off safely');
        ctx.handle.destroy();
    });

    it('keeps all category rows visible and shows direct leaves alongside deeper categories', async () => {
        const catalog = {
            schemaVersion: 1,
            kind: 'tag',
            libraries: [{ id: 'lib-1', name: 'ignored library name' }],
            entries: [
                { id: 'root-leaf', libraryId: 'lib-1', key: '一级·根级标签', value: 'root_tag' },
                { id: 'level-two-leaf', libraryId: 'lib-1', key: '一级·二级·二级直属标签', value: 'level_two_tag' },
                { id: 'level-three-leaf', libraryId: 'lib-1', key: '一级·二级·三级·三级直属标签', value: 'level_three_tag' },
                { id: 'deep-leaf', libraryId: 'lib-1', key: '一级·二级·三级·四级·五级·六级·七级·八级·深层标签', value: 'deep_tag' },
                { id: 'other-leaf', libraryId: 'lib-1', key: '另一个·支线·额外标签', value: 'other_tag' },
            ],
        };
        const ctx = mount({ deps: { loadSettings: () => ({ naiParams: defaultNaiParams(), enableTagMarket: true }), marketCatalogStore: {
            async load() { return { ok: true, value: catalog }; },
            async replace(data) { return { ok: true, value: data }; },
        } } });
        const market = ctx.root.querySelector('.nd-wb-market');
        for (const listener of market.querySelector('.nd-wb-market__title')._listeners || []) {
            if (listener.type === 'click') listener.fn();
        }
        await new Promise((r) => setTimeout(r, 0));
        const clickCategory = (label) => {
            const button = market.querySelectorAll('.nd-wb-market__tab').find((item) => item.textContent === label);
            assert.ok(button, `category ${label} is visible`);
            for (const listener of button._listeners || []) {
                if (listener.type === 'click') listener.fn();
            }
        };
        const hasTag = (label) => market.querySelectorAll('.nd-wb-market__tag')
            .some((tag) => tag.childNodes[0]?.textContent === label);

        assert.equal(market.querySelectorAll('.nd-wb-market__level-row').length, 2);
        assert.equal(market.querySelector('.nd-wb-market__level-row').childNodes[0].textContent, '一级');
        assert.equal(market.querySelector('.nd-wb-market__level-row').querySelectorAll('.nd-wb-market__tab')
            .some((button) => button.textContent === '全部'), false);
        for (const leaf of ['根级标签', '二级直属标签', '三级直属标签', '深层标签']) {
            assert.equal(hasTag(leaf), true, `the first root category shows ${leaf}`);
        }
        assert.equal(hasTag('额外标签'), false, 'other root categories are hidden by default');
        assert.equal(market.querySelectorAll('.nd-wb-market__level-row')[1].childNodes[0].textContent, '全部');
        assert.equal(market.querySelectorAll('.nd-wb-market__level-row')[1].childNodes[0].getAttribute('aria-pressed'), 'true');
        assert.equal(hasTag('根级标签'), true);
        assert.equal(hasTag('深层标签'), true);
        assert.equal(market.querySelector('.nd-wb-market__empty').hidden, true);

        clickCategory('二级');
        assert.equal(market.querySelectorAll('.nd-wb-market__level-row').length, 3);
        assert.equal(market.querySelectorAll('.nd-wb-market__level-row')[2].childNodes[0].getAttribute('aria-pressed'), 'true');
        assert.equal(hasTag('根级标签'), false);
        assert.equal(hasTag('二级直属标签'), true);
        assert.equal(hasTag('深层标签'), true);

        clickCategory('三级');
        assert.equal(market.querySelectorAll('.nd-wb-market__level-row').length, 4);
        assert.equal(hasTag('三级直属标签'), true, 'a terminal tag remains visible while a deeper branch is present');
        assert.equal(market.querySelector('.nd-wb-market__empty').hidden, true);

        for (const label of ['四级', '五级', '六级', '七级', '八级']) clickCategory(label);
        assert.equal(market.querySelectorAll('.nd-wb-market__level-row').length, 8);
        assert.equal(hasTag('深层标签'), true);
        assert.equal(market.querySelector('.nd-wb-market__empty').hidden, true);
        const rows = market.querySelectorAll('.nd-wb-market__level-row');
        for (let depth = 1; depth <= 8; depth += 1) {
            const active = rows[depth - 1].querySelectorAll('.nd-wb-market__tab')
                .find((button) => button.classList.contains('is-active'));
            assert.ok(active, `ancestor row ${depth} keeps an active category`);
            if (depth > 1) assert.equal(rows[depth - 1].childNodes[0].textContent, '全部');
        }

        const levelTwoAll = rows[1].childNodes[0];
        for (const listener of levelTwoAll._listeners.filter((item) => item.type === 'click')) listener.fn();
        assert.equal(hasTag('根级标签'), true, 'level All restores its branch leaves');
        clickCategory('另一个');
        assert.equal(hasTag('额外标签'), true, 'another root category has its own All view');
        assert.equal(hasTag('根级标签'), false);
        clickCategory('一级');
        assert.equal(hasTag('深层标签'), true);
        assert.equal(hasTag('额外标签'), false);

        const header = market.querySelector('.nd-wb-market__header');
        assert.equal(header.childNodes[0].textContent, '标签超市');
        assert.equal(header.childNodes[1].classList.contains('nd-wb-market__actions'), true);
        assert.equal(ctx.root.querySelector('.nd-wb-caption-toolbar'), null, 'paste button is removed from the workbench');
        ctx.handle.destroy();
    });

    it('uses the compact workbench parameter presentation without changing the shared default form', () => {
        const workbenchRoot = document.createElement('div');
        const workbenchForm = createNaiParamsForm(defaultNaiParams(), { presentation: 'workbench' });
        workbenchRoot.appendChild(workbenchForm.el);
        assert.equal(workbenchRoot.querySelectorAll('.nd-field-group__title').length, 0);
        const groups = workbenchRoot.querySelectorAll('.nd-field-group');
        const workbenchPresetControls = groups[2].childNodes;
        assert.equal(workbenchPresetControls[0].querySelector('.nd-field__label').textContent, '官方负面预设');
        assert.equal(workbenchPresetControls[1].querySelector('.nd-toggle-row__text').childNodes[0].textContent, '官方质量词');
        workbenchForm.destroy();

        const defaultRoot = document.createElement('div');
        const defaultForm = createNaiParamsForm(defaultNaiParams());
        defaultRoot.appendChild(defaultForm.el);
        assert.deepEqual(
            defaultRoot.querySelectorAll('.nd-field-group__title').map((title) => title.textContent),
            ['模型与尺寸', '采样', '官方预设与开关'],
        );
        const defaultPresetControls = defaultRoot.querySelectorAll('.nd-field-group')[2].childNodes;
        assert.equal(defaultPresetControls[1].querySelector('.nd-toggle-row__text').childNodes[0].textContent, '官方质量词');
        assert.equal(defaultPresetControls[2].querySelector('.nd-field__label').textContent, '官方负面预设');
        defaultForm.destroy();
    });
});

/**
 * 从假 DOM 的 caption 编辑器读出当前值（按 label 找 textarea / number）。
 * @param {Element} root
 * @returns {import('../../src/domain/model/nai-params.js').NaiCaption}
 */
function readCaptionFromEditor(root) {
    /**
     * @param {string} label
     * @returns {any}
     */
    function fieldByLabel(label) {
        /** @type {any[]} */
        const stack = [root];
        while (stack.length) {
            const node = stack.pop();
            if (!node) continue;
            const parts = String(node.className || '').split(/\s+/);
            if (parts.includes('nd-field')) {
                const lab = (node.childNodes || []).find((c) => {
                    const p = String(c.className || '').split(/\s+/);
                    return p.includes('nd-field__label') && c.textContent === label;
                });
                if (lab) {
                    return node.querySelector('textarea') || node.querySelector('input');
                }
            }
            if (Array.isArray(node.childNodes)) {
                for (const c of node.childNodes) stack.push(c);
            }
        }
        return null;
    }

    const posBase = fieldByLabel('场景 · 正面');
    const negBase = fieldByLabel('场景 · 负面');
    const charPos = fieldByLabel('正面');
    const charNeg = fieldByLabel('负面');
    const x = fieldByLabel('位置 X');
    const y = fieldByLabel('位置 Y');
    return {
        v4_prompt: {
            caption: {
                base_caption: String(posBase?.value ?? ''),
                char_captions: charPos ? [{
                    char_caption: String(charPos.value ?? ''),
                    centers: [{
                        x: Number(x?.value),
                        y: Number(y?.value),
                    }],
                }] : [],
            },
        },
        v4_negative_prompt: {
            caption: {
                base_caption: String(negBase?.value ?? ''),
                char_captions: charNeg ? [{
                    char_caption: String(charNeg.value ?? ''),
                    centers: [{
                        x: Number(x?.value),
                        y: Number(y?.value),
                    }],
                }] : [],
            },
        },
    };
}
