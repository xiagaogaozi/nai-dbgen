/**
 * 提示词面板：挂载即加载、有记录楼分组、读失败隔离、空态、搜索、destroy 竞态。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom } from '../fake-dom.js';
import { Ok, Err } from '../../../src/infra/result.js';
import { mountPromptsPanel } from '../../../src/ui/panels/prompts/prompts-panel.js';
import {
    buildCopyPromptText,
    extractCaptionParts,
    filterFloorGroups,
    foldSummarySnippet,
    summarizeMessageText,
} from '../../../src/ui/panels/prompts/prompts-logic.js';
import { formatPromptText } from '../../../src/ui/common/prompt-text.js';

/**
 * @param {any} root
 * @param {(n: any) => boolean} pred
 * @returns {any|null}
 */
function findNode(root, pred) {
    /** @type {any[]} */
    const stack = [root];
    while (stack.length) {
        const node = stack.pop();
        if (!node) continue;
        if (pred(node)) return node;
        for (const c of node.childNodes || []) stack.push(c);
    }
    return null;
}

/**
 * @param {any} root
 * @param {(n: any) => boolean} pred
 * @returns {any[]}
 */
function findAll(root, pred) {
    /** @type {any[]} */
    const out = [];
    /**
     * @param {any} node
     */
    function walk(node) {
        if (!node) return;
        if (pred(node)) out.push(node);
        for (const c of node.childNodes || []) walk(c);
    }
    walk(root);
    return out;
}

/**
 * @param {any} root
 * @returns {string}
 */
function collectText(root) {
    /** @type {string[]} */
    const parts = [];
    /**
     * @param {any} node
     */
    function walk(node) {
        if (!node) return;
        if (node._text) parts.push(String(node._text));
        for (const c of node.childNodes || []) walk(c);
    }
    walk(root);
    return parts.join('\n');
}

/**
 * 块文本用：拼接子节点 _text（含内嵌换行），不额外插分隔符。
 * @param {any} root
 * @returns {string}
 */
function collectTextRaw(root) {
    /** @type {string[]} */
    const parts = [];
    /**
     * @param {any} node
     */
    function walk(node) {
        if (!node) return;
        if (node._text) parts.push(String(node._text));
        for (const c of node.childNodes || []) walk(c);
    }
    walk(root);
    return parts.join('');
}

/**
 * @param {object} [opts]
 */
function makeCaption(opts = {}) {
    return {
        v4_prompt: {
            caption: {
                base_caption: opts.positive ?? 'a girl, red dress',
                char_captions: opts.chars ?? [],
            },
        },
        v4_negative_prompt: {
            caption: {
                base_caption: opts.negative ?? 'lowres',
                char_captions: [],
            },
        },
    };
}

/**
 * @param {object} [overrides]
 */
function makeRecord(overrides = {}) {
    return {
        schemaVersion: 1,
        messageId: overrides.messageId ?? 10,
        slotId: overrides.slotId ?? 1,
        caption: overrides.caption ?? makeCaption(),
        anchorSentence: '',
        images: overrides.images ?? [],
        createdAt: '2026-01-01T00:00:00.000Z',
        presetId: null,
        llmConfigId: null,
        traceId: overrides.traceId ?? 'should-not-show',
    };
}

describe('ui/panels/prompts logic', () => {
    it('summarizeMessageText strips slot markers and truncates', () => {
        const text = '前言 <IMG>1</IMG> 中段文字继续很长很长很长很长很长很长很长很长';
        const s = summarizeMessageText(text, 20);
        assert.ok(!s.includes('<IMG>'));
        assert.ok(s.includes('前言'));
        assert.ok(s.endsWith('…') || s.length <= 21);
    });

    it('extractCaptionParts reads v4 caption fields', () => {
        const parts = extractCaptionParts(makeCaption({
            positive: 'pos',
            negative: 'neg',
            chars: [{ char_caption: 'charA', centers: [{ x: 0.5, y: 0.5 }] }],
        }));
        assert.equal(parts.positive, 'pos');
        assert.equal(parts.negative, 'neg');
        assert.equal(parts.characters, 'charA');
        assert.equal(parts.charCount, 1);
    });

    it('foldSummarySnippet truncates long text', () => {
        assert.equal(foldSummarySnippet('short'), 'short');
        assert.equal(foldSummarySnippet('abcdefghij', 5), 'abcde…');
        assert.equal(foldSummarySnippet('  a   b  '), 'a b');
    });

    it('filterFloorGroups keeps newest floors and matches prompt text', () => {
        const groups = [
            {
                messageId: 5,
                summary: 'a',
                status: /** @type {'ok'} */ ('ok'),
                records: [makeRecord({ messageId: 5, caption: makeCaption({ positive: 'cat ears' }) })],
            },
            {
                messageId: 3,
                summary: 'b',
                status: /** @type {'error'} */ ('error'),
                errorMessage: '读取失败',
            },
            {
                messageId: 2,
                summary: 'c',
                status: /** @type {'ok'} */ ('ok'),
                records: [makeRecord({ messageId: 2, caption: makeCaption({ positive: 'blue sky' }) })],
            },
        ];
        const hit = filterFloorGroups(groups, 'cat');
        assert.equal(hit.length, 1);
        assert.equal(hit[0].messageId, 5);
        assert.equal(filterFloorGroups(groups, '').length, 3);
    });
});

describe('ui/panels/prompts mountPromptsPanel', () => {
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
     * @param {object} [opts]
     */
    function mount(opts = {}) {
        const root = document.createElement('div');
        document.body.appendChild(root);

        /** @type {Map<number, any>} */
        const byMessage = opts.byMessage instanceof Map
            ? opts.byMessage
            : new Map(opts.byMessage || []);

        /** @type {number} */
        let listRetainedCalls = 0;

        const slotRepo = {
            async listRetained() {
                listRetainedCalls += 1;
                if (opts.hold) await opts.hold;
                if (typeof opts.listRetained === 'function') {
                    return opts.listRetained();
                }
                /** @type {any[]} */
                const all = [];
                for (const [messageId, v] of byMessage) {
                    if (v && typeof v === 'object' && 'ok' in v) {
                        if (v.ok === true && Array.isArray(v.value)) {
                            all.push(...v.value);
                        }
                        continue;
                    }
                    if (Array.isArray(v)) {
                        all.push(...v.map((r) => ({ ...r, messageId: r.messageId ?? messageId })));
                    }
                }
                return Ok(all);
            },
        };

        const imageRepo = {
            async getUrl(ref) {
                return Ok(`https://cdn.example/${ref}.png`);
            },
        };

        /** @type {Array<[string, string]>} */
        const toasts = [];
        /** @type {Map<number, any>} */
        const messageById = new Map();
        for (const m of opts.messages || []) {
            if (m && Number.isFinite(Number(m.messageId))) {
                messageById.set(Number(m.messageId), m);
            }
        }
        const host = {
            getMessage(messageId) {
                return messageById.get(Number(messageId)) ?? null;
            },
            toast(level, message) {
                toasts.push([level, message]);
            },
            ...(opts.host || {}),
        };

        const loadSettings = opts.loadSettings || (() => ({
            naiParams: { width: 832, height: 1216 },
            activeArtistId: opts.activeArtistId ?? null,
        }));

        /** @type {Map<string, any>} */
        const artists = opts.artists instanceof Map
            ? opts.artists
            : new Map(opts.artists || []);

        const artistRepo = {
            async get(id) {
                if (artists.has(id)) return Ok(artists.get(id));
                return Err({ code: 'NOT_FOUND', message: 'missing', category: 'Storage' });
            },
        };

        const handle = mountPromptsPanel(root, {
            host,
            loadSettings,
            repos: {
                slot: slotRepo,
                image: imageRepo,
                artist: artistRepo,
                ...(opts.repos || {}),
            },
        });

        return {
            root,
            handle,
            get listRetainedCalls() { return listRetainedCalls; },
            toasts,
            async settle() {
                await Promise.resolve();
                await Promise.resolve();
                await Promise.resolve();
                await Promise.resolve();
                await Promise.resolve();
                await Promise.resolve();
            },
        };
    }

    it('loads on mount without messageId / traceId inputs or Load button', async () => {
        const ctx = mount({
            messages: [
                { messageId: 12, text: '你好 <IMG>1</IMG> 世界', isUser: false, isSystem: false, name: 'AI' },
            ],
            byMessage: new Map([
                [12, [makeRecord({ messageId: 12, slotId: 1 })]],
            ]),
        });
        await ctx.settle();

        const text = collectTextRaw(ctx.root);
        assert.match(text, /第 12 楼/);
        assert.match(text, /场景/);
        assert.match(text, /正面/);
        assert.match(text, /a girl, red dress/);
        assert.match(text, /lowres/);
        assert.ok(!text.includes('image###'));
        assert.ok(!text.includes('Scene:'));
        assert.ok(!text.includes('Scene UC:'));
        assert.ok(!text.includes('Char1:'));
        assert.ok(!text.includes('楼层 messageId'));
        assert.ok(!text.includes('traceId'));
        assert.ok(!text.includes('should-not-show'));
        assert.equal(
            findNode(ctx.root, (n) => n.tagName === 'BUTTON' && n.textContent === '加载'),
            null,
        );
        assert.ok(
            findNode(ctx.root, (n) => n.tagName === 'BUTTON' && n.textContent === '刷新'),
        );
        assert.equal(ctx.listRetainedCalls >= 1, true);
    });

    it('shows only floors with slot records, newest first', async () => {
        const ctx = mount({
            messages: [
                { messageId: 30, text: '最新', isUser: false, isSystem: false, name: 'AI' },
                { messageId: 20, text: '中间无记录', isUser: false, isSystem: false, name: 'AI' },
                { messageId: 10, text: '较旧', isUser: false, isSystem: false, name: 'AI' },
            ],
            byMessage: new Map([
                [30, [makeRecord({ messageId: 30, slotId: 1, caption: makeCaption({ positive: 'new-prompt' }) })]],
                [20, []],
                [10, [makeRecord({ messageId: 10, slotId: 1, caption: makeCaption({ positive: 'old-prompt' }) })]],
            ]),
        });
        await ctx.settle();

        const floors = findAll(ctx.root, (n) => {
            const parts = String(n.className || '').split(/\s+/);
            return parts.includes('nd-prompts-floor');
        });
        assert.equal(floors.length, 2);
        const titles = floors.map((f) => {
            const t = findNode(f, (n) => String(n.className || '').includes('nd-prompts-floor__title'));
            return t?.textContent;
        });
        assert.deepEqual(titles, ['第 30 楼', '第 10 楼']);
        const blob = collectTextRaw(ctx.root);
        assert.match(blob, /new-prompt/);
        assert.match(blob, /old-prompt/);
        assert.ok(!blob.includes('中间无记录') || blob.indexOf('new-prompt') < blob.indexOf('old-prompt'));
    });

    it('listRetained Err toasts and shows empty state', async () => {
        const ctx = mount({
            messages: [
                { messageId: 8, text: 'ok楼', isUser: false, isSystem: false, name: 'AI' },
            ],
            listRetained() {
                return Err({ code: 'X', message: 'boom', category: 'Storage' });
            },
        });
        await ctx.settle();

        assert.ok(ctx.toasts.some(([level, msg]) => level === 'error' && String(msg).includes('boom')));
        assert.match(collectText(ctx.root), /当前会话还没有生图提示词/);
    });

    it('empty state copy when no slots', async () => {
        const ctx = mount({
            messages: [
                { messageId: 1, text: '空', isUser: false, isSystem: false, name: 'AI' },
            ],
            byMessage: new Map([[1, []]]),
        });
        await ctx.settle();

        const blob = collectText(ctx.root);
        assert.match(blob, /当前会话还没有生图提示词/);
        assert.match(blob, /悬浮球/);
        assert.match(blob, /生图/);
    });

    it('search filters by prompt content without requiring input to see all', async () => {
        const ctx = mount({
            messages: [
                { messageId: 4, text: 'a', isUser: false, isSystem: false, name: 'AI' },
                { messageId: 3, text: 'b', isUser: false, isSystem: false, name: 'AI' },
            ],
            byMessage: new Map([
                [4, [makeRecord({ messageId: 4, caption: makeCaption({ positive: 'alpha wolf' }) })]],
                [3, [makeRecord({ messageId: 3, caption: makeCaption({ positive: 'beta fish' }) })]],
            ]),
        });
        await ctx.settle();
        assert.match(collectTextRaw(ctx.root), /alpha wolf/);
        assert.match(collectTextRaw(ctx.root), /beta fish/);

        const input = findNode(ctx.root, (n) => n.tagName === 'INPUT' && n.type === 'search');
        assert.ok(input);
        input.value = 'wolf';
        const listener = (input._listeners || []).find((l) => l.type === 'input');
        listener?.fn();
        await new Promise((r) => setTimeout(r, 320));

        const after = collectTextRaw(ctx.root);
        assert.match(after, /alpha wolf/);
        assert.ok(!after.includes('beta fish'));
    });

    it('destroy prevents late listRetained from writing DOM', async () => {
        let release;
        const hold = new Promise((r) => { release = r; });
        const ctx = mount({
            hold,
            messages: [
                { messageId: 9, text: '晚到', isUser: false, isSystem: false, name: 'AI' },
            ],
            byMessage: new Map([
                [9, [makeRecord({ messageId: 9, caption: makeCaption({ positive: 'late-prompt' }) })]],
            ]),
        });

        ctx.handle.destroy();
        assert.equal(ctx.root.childNodes.length, 0);
        release();
        await ctx.settle();
        assert.equal(ctx.root.childNodes.length, 0);
        assert.ok(!collectText(ctx.root).includes('late-prompt'));
    });

    it('shows 未出图 placeholder when slot has no images', async () => {
        const ctx = mount({
            messages: [
                { messageId: 2, text: 'x', isUser: false, isSystem: false, name: 'AI' },
            ],
            byMessage: new Map([
                [2, [makeRecord({ messageId: 2, images: [] })]],
            ]),
        });
        await ctx.settle();
        assert.match(collectText(ctx.root), /未出图/);
    });

    it('shows layered labels without raw image### field headers', async () => {
        const caption = makeCaption({
            positive: 'scene',
            negative: 'lowres, blurry, worst quality',
            chars: [
                { char_caption: '1girl, silver hair', centers: [{ x: 0.4, y: 0.5 }] },
                { char_caption: '1boy, brown hair', centers: [{ x: 0.7, y: 0.5 }] },
            ],
        });
        caption.v4_negative_prompt.caption.char_captions = [
            { char_caption: 'bad hands', centers: [{ x: 0.4, y: 0.5 }] },
            { char_caption: 'extra fingers', centers: [{ x: 0.7, y: 0.5 }] },
        ];

        const artist = {
            id: 'art-1',
            name: 'A',
            positive: 'artist:example',
            negative: 'lowres',
        };

        /** @type {string[]} */
        const copied = [];
        const navDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
        Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            writable: true,
            value: {
                clipboard: {
                    async writeText(text) {
                        copied.push(String(text));
                    },
                },
            },
        });

        try {
            const ctx = mount({
                activeArtistId: 'art-1',
                artists: new Map([['art-1', artist]]),
                messages: [
                    { messageId: 5, text: 'x', isUser: false, isSystem: false, name: 'AI' },
                ],
                byMessage: new Map([
                    [5, [makeRecord({ messageId: 5, caption })]],
                ]),
            });
            await ctx.settle();

            const blob = collectText(ctx.root);
            assert.match(blob, /画师串/);
            assert.match(blob, /场景/);
            assert.match(blob, /角色/);
            assert.match(blob, /角色1/);
            assert.match(blob, /角色2/);
            assert.match(blob, /artist:example/);
            assert.match(blob, /1girl, silver hair/);
            assert.match(blob, /连画师串一起复制/);
            assert.ok(!blob.includes('image###'));
            assert.ok(!blob.includes('Scene:'));
            assert.ok(!blob.includes('Char1:'));
            assert.ok(!blob.includes('Char1 UC:'));
            assert.ok(!blob.includes('|centers:'));
            assert.ok(!blob.includes('size:'));
            assert.ok(!blob.includes('展开'));

            const layers = findNode(ctx.root, (n) => {
                const parts = String(n.className || '').split(/\s+/);
                return parts.includes('nd-prompt-card__layers');
            });
            assert.ok(layers);

            assert.equal(
                findNode(ctx.root, (n) => {
                    const parts = String(n.className || '').split(/\s+/);
                    return parts.includes('nd-prompt-card__head')
                        || parts.includes('nd-prompt-card__title');
                }),
                null,
            );
            assert.ok(!blob.includes('图 1'));
            assert.ok(!blob.includes('图 2'));

            const foot = findNode(ctx.root, (n) => {
                const parts = String(n.className || '').split(/\s+/);
                return parts.includes('nd-prompt-card__foot');
            });
            assert.ok(foot);
            const copyBtn = findNode(foot, (n) => n.tagName === 'BUTTON' && n.textContent === '复制');
            assert.ok(copyBtn);
            assert.ok(String(copyBtn.className || '').includes('nd-prompt-card__copy'));
            const checkbox = findNode(foot, (n) => n.tagName === 'INPUT' && n.type === 'checkbox');
            assert.ok(checkbox);
            assert.equal(checkbox.disabled, false);
            assert.equal(checkbox.checked, false);

            const pills = findAll(ctx.root, (n) => {
                const parts = String(n.className || '').split(/\s+/);
                return parts.includes('nd-prompt-card__pill');
            });
            assert.ok(pills.some((n) => String(n.className).includes('nd-prompt-card__pill--pos')));
            assert.ok(pills.some((n) => String(n.className).includes('nd-prompt-card__pill--neg')));
            assert.ok(findNode(ctx.root, (n) => {
                const parts = String(n.className || '').split(/\s+/);
                return parts.includes('nd-prompt-card__chars');
            }));

            const click = (copyBtn._listeners || []).find((l) => l.type === 'click');
            await click?.fn({ preventDefault() {} });
            assert.deepEqual(copied, [
                buildCopyPromptText(caption, {
                    artist,
                    includeArtist: false,
                }),
            ]);

            checkbox.checked = true;
            await click?.fn({ preventDefault() {} });
            assert.equal(copied[1], buildCopyPromptText(caption, {
                artist,
                includeArtist: true,
            }));
            assert.match(copied[1], /^画师串\n正面：artist:example\n负面：lowres\n\n场景\n正面：scene\n/s);
            assert.ok(!copied[1].includes('artist:example, scene'));
            assert.equal(copied[0], formatPromptText(caption, { includeArtist: false }));
            assert.ok(!copied[0].includes('画师串'));
            assert.ok(!copied[0].includes('image###'));
            assert.ok(!copied[1].includes('image###'));
            assert.ok(!copied[1].includes('Scene:'));
            assert.ok(!copied[1].includes('centers:'));
        } finally {
            if (navDesc) {
                Object.defineProperty(globalThis, 'navigator', navDesc);
            } else {
                delete globalThis.navigator;
            }
        }
    });

    it('clickable thumb opens image viewer; empty placeholder is not clickable; no 图 N title', async () => {
        /** @type {any[]} */
        const modalCalls = [];
        const ctx = mount({
            messages: [
                { messageId: 21, text: 'with-img', isUser: false, isSystem: false, name: 'AI' },
                { messageId: 20, text: 'no-img', isUser: false, isSystem: false, name: 'AI' },
            ],
            byMessage: new Map([
                [21, [makeRecord({
                    messageId: 21,
                    slotId: 1,
                    images: [{
                        imageRef: 'img-ok',
                        createdAt: '2026-01-01T00:00:00.000Z',
                        naiConfigId: null,
                        artistId: null,
                    }],
                })]],
                [20, [makeRecord({
                    messageId: 20,
                    slotId: 2,
                    images: [],
                })]],
            ]),
            host: {
                openModal: async (opts) => {
                    modalCalls.push(opts);
                    return { destroy() {} };
                },
            },
        });
        await ctx.settle();
        await ctx.settle();

        const blob = collectText(ctx.root);
        assert.ok(!/\b图\s*\d+\b/.test(blob));

        const thumbs = findAll(ctx.root, (n) => {
            const parts = String(n.className || '').split(/\s+/);
            return parts.includes('nd-prompt-card__thumb');
        });
        assert.equal(thumbs.length, 2);

        const clickable = thumbs.find((n) => String(n.className).includes('nd-prompt-card__thumb--clickable'));
        const empty = thumbs.find((n) => !String(n.className).includes('nd-prompt-card__thumb--clickable'));
        assert.ok(clickable);
        assert.ok(empty);
        assert.match(collectText(empty), /未出图/);
        assert.equal((empty._listeners || []).filter((l) => l.type === 'click').length, 0);

        const click = (clickable._listeners || []).find((l) => l.type === 'click');
        assert.ok(click);
        await click.fn({ preventDefault() {} });
        // openModal 内部有 setTimeout(0)；等它跑完再断言，避免 afterEach 拆假 DOM 后残留 rejection
        await new Promise((r) => setTimeout(r, 20));
        assert.equal(modalCalls.length, 1);
        assert.equal(modalCalls[0]?.wide, true);
        assert.equal(modalCalls[0]?.large, true);
        assert.ok(modalCalls[0]?.element);
        const viewerImg = findNode(modalCalls[0].element, (n) => n.tagName === 'IMG');
        assert.ok(viewerImg);
        assert.match(String(viewerImg.src || ''), /cdn\.example\/img-ok\.png/);
    });

    it('hides artist section and disables checkbox when artist missing', async () => {
        const ctx = mount({
            activeArtistId: null,
            messages: [
                { messageId: 6, text: 'x', isUser: false, isSystem: false, name: 'AI' },
            ],
            byMessage: new Map([
                [6, [makeRecord({
                    messageId: 6,
                    caption: makeCaption({ positive: 'only-scene', negative: '' }),
                })]],
            ]),
        });
        await ctx.settle();
        const sectionTitles = findAll(ctx.root, (n) => {
            const parts = String(n.className || '').split(/\s+/);
            return parts.includes('nd-prompt-card__section-title');
        }).map((n) => n.textContent);
        assert.ok(!sectionTitles.includes('画师串'));
        assert.ok(sectionTitles.includes('场景'));
        assert.match(collectText(ctx.root), /only-scene/);
        assert.match(collectText(ctx.root), /连画师串一起复制/);
        const checkbox = findNode(ctx.root, (n) => n.tagName === 'INPUT' && n.type === 'checkbox');
        assert.ok(checkbox);
        assert.equal(checkbox.disabled, true);
    });

    it('prefers latest image artistId over activeArtistId', async () => {
        const ctx = mount({
            activeArtistId: 'active',
            artists: new Map([
                ['active', { id: 'active', positive: 'ACTIVE_POS', negative: 'ACTIVE_NEG' }],
                ['saved', { id: 'saved', positive: 'SAVED_POS', negative: 'SAVED_NEG' }],
            ]),
            messages: [
                { messageId: 11, text: 'x', isUser: false, isSystem: false, name: 'AI' },
            ],
            byMessage: new Map([
                [11, [makeRecord({
                    messageId: 11,
                    images: [{
                        imageRef: 'img-1',
                        createdAt: '2026-01-01T00:00:00.000Z',
                        naiConfigId: null,
                        artistId: 'saved',
                    }],
                })]],
            ]),
        });
        await ctx.settle();
        const blob = collectText(ctx.root);
        assert.match(blob, /SAVED_POS/);
        assert.match(blob, /SAVED_NEG/);
        assert.ok(!blob.includes('ACTIVE_POS'));
    });
});
