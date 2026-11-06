/**
 * W2-G · mountSlotWidget：闸门查询、D43 invalid、SLOT_ALREADY_RENDERED、chat 隔离。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom } from './fake-dom.js';
import { createEventBus } from '../../src/infra/event-bus.js';
import { APP_EVENTS } from '../../src/application/_helpers.js';
import { mountSlotWidget } from '../../src/ui/slot-widget/slot-widget.js';
import {
    clearSlotInflight,
    peekSlotInflight,
} from '../../src/ui/slot-widget/slot-mount.js';
import { safeImageUrl } from '../../src/ui/common/safe-url.js';
import { buildImageViewerElement } from '../../src/ui/common/image-viewer.js';

describe('ui/slot mountSlotWidget', () => {
    /** @type {ReturnType<typeof installFakeDom>|null} */
    let fake = null;
    /** @type {string} */
    let chatId = 'chat-test';

    beforeEach(() => {
        fake = installFakeDom();
        clearSlotInflight();
        chatId = 'chat-test';
    });

    afterEach(() => {
        clearSlotInflight();
        fake?.restore();
        fake = null;
    });

    /**
     * @param {number} slotId
     */
    function makeRoot(slotId) {
        const root = document.createElement('div');
        root.setAttribute('data-slot', String(slotId));
        root.className = 'custom-nai-slot';
        const btn = document.createElement('button');
        btn.className = 'custom-nai-slot-btn';
        const img = document.createElement('div');
        img.className = 'custom-nai-slot-img';
        root.append(btn, img);
        document.body.appendChild(root);
        return root;
    }

    /**
     * @param {Element} root
     */
    function btnOf(root) {
        return [...root.childNodes].find(
            (n) => String(n.tagName).toUpperCase() === 'BUTTON',
        );
    }

    /**
     * @param {Element} root
     */
    async function clickBtn(root) {
        const btn = btnOf(root);
        await btn._listeners.find((l) => l.type === 'click').fn({
            preventDefault() {},
            stopPropagation() {},
        });
        await new Promise((r) => setTimeout(r, 0));
    }

    it('恶意 URL 被拦', () => {
        assert.equal(safeImageUrl('javascript:alert(1)'), null);
        assert.equal(safeImageUrl('data:text/html,x'), null);
        const el = buildImageViewerElement('https://cdn.example/a.png', 'x');
        assert.equal(el.childNodes[0].src, 'https://cdn.example/a.png');
    });

    it('从持久层恢复：已出图 remount 仍是 done', async () => {
        const root = makeRoot(1);
        const record = { images: [{ imageRef: 'ref-done' }] };
        const handle = mountSlotWidget(root, 0, {
            getChatId: () => chatId,
            onGenerateClick: async () => ({ ok: true, value: {} }),
            getRecord: () => /** @type {any} */ (record),
            getImageUrl: async () => 'https://cdn.example/done.png',
        });
        await new Promise((r) => setTimeout(r, 0));
        assert.ok(root.className.includes('nd-slot--done'), root.className);
        handle.destroy();

        const root2 = makeRoot(1);
        const handle2 = mountSlotWidget(root2, 0, {
            getChatId: () => chatId,
            onGenerateClick: async () => ({ ok: true, value: {} }),
            getRecord: () => /** @type {any} */ (record),
            getImageUrl: async () => 'https://cdn.example/done.png',
        });
        await new Promise((r) => setTimeout(r, 0));
        assert.ok(root2.className.includes('nd-slot--done'), root2.className);
        handle2.destroy();
    });

    it('重挂时优先问 isRendering / hasPendingWrite', async () => {
        let rendering = true;
        let pending = false;
        const root = makeRoot(3);
        const handle = mountSlotWidget(root, 9, {
            getChatId: () => chatId,
            isRendering: () => rendering,
            hasPendingWrite: () => pending,
            onGenerateClick: async () => ({ ok: true, value: {} }),
            getRecord: () => null,
            getImageUrl: async () => null,
        });
        await new Promise((r) => setTimeout(r, 0));
        assert.ok(root.className.includes('nd-slot--generating'), root.className);
        // 本地表为空也能显示 generating（权威在应用层）
        assert.equal(peekSlotInflight(chatId, 9, 3), null);

        rendering = false;
        pending = true;
        handle.refresh();
        await new Promise((r) => setTimeout(r, 0));
        assert.ok(root.className.includes('nd-slot--generating'), root.className);

        pending = false;
        handle.refresh();
        await new Promise((r) => setTimeout(r, 0));
        assert.ok(root.className.includes('nd-slot--idle'), root.className);
        handle.destroy();
    });

    it('切 chat 后同一 (messageId,slotId) 不误认为同一任务', async () => {
        const rootA = makeRoot(1);
        /** @type {(() => void)|null} */
        let release = null;
        const handleA = mountSlotWidget(rootA, 5, {
            getChatId: () => 'chat-a',
            onGenerateClick: () => new Promise((resolve) => {
                release = () => resolve({ ok: true, value: {} });
            }),
            getRecord: () => null,
            getImageUrl: async () => null,
        });
        await clickBtn(rootA);
        assert.ok(peekSlotInflight('chat-a', 5, 1)?.status === 'generating');

        // 切到 chat-b：同下标不应看见 A 的 generating
        chatId = 'chat-b';
        const rootB = makeRoot(1);
        const chatListeners = [];
        const handleB = mountSlotWidget(rootB, 5, {
            getChatId: () => 'chat-b',
            host: {
                getCurrentChatId: () => 'chat-b',
                onChatChanged(fn) {
                    chatListeners.push(fn);
                    return () => {};
                },
            },
            onGenerateClick: async () => ({ ok: true, value: {} }),
            getRecord: () => null,
            getImageUrl: async () => null,
        });
        await new Promise((r) => setTimeout(r, 0));
        // mount 时 clearOtherChats('chat-b') 清掉 chat-a
        assert.equal(peekSlotInflight('chat-a', 5, 1), null);
        assert.ok(rootB.className.includes('nd-slot--idle'), rootB.className);

        release?.();
        handleA.destroy();
        handleB.destroy();
        void chatListeners;
    });

    it('error 条目切 chat 后被清理', async () => {
        const root = makeRoot(2);
        const handle = mountSlotWidget(root, 1, {
            getChatId: () => 'chat-a',
            onGenerateClick: async () => ({
                ok: false,
                error: { message: '炸了', traceId: 't1' },
            }),
            getRecord: () => null,
            getImageUrl: async () => null,
        });
        await clickBtn(root);
        assert.ok(peekSlotInflight('chat-a', 1, 2)?.status === 'error');

        /** @type {((id: string|null) => void)|null} */
        let onChange = null;
        const root2 = makeRoot(2);
        const handle2 = mountSlotWidget(root2, 1, {
            getChatId: () => 'chat-b',
            host: {
                getCurrentChatId: () => 'chat-b',
                onChatChanged(fn) {
                    onChange = fn;
                    return () => {};
                },
            },
            onGenerateClick: async () => ({ ok: true, value: {} }),
            getRecord: () => null,
            getImageUrl: async () => null,
        });
        await new Promise((r) => setTimeout(r, 0));
        assert.equal(peekSlotInflight('chat-a', 1, 2), null);

        onChange?.('chat-c');
        assert.equal(peekSlotInflight('chat-b', 1, 2), null);

        handle.destroy();
        handle2.destroy();
    });

    it('onGenerateClick 返回 undefined → 不清表、不判成功', async () => {
        const root = makeRoot(4);
        const handle = mountSlotWidget(root, 1, {
            getChatId: () => chatId,
            onGenerateClick: async () => /** @type {any} */ (undefined),
            getRecord: () => null,
            getImageUrl: async () => null,
        });
        await clickBtn(root);
        assert.ok(
            peekSlotInflight(chatId, 1, 4)?.status === 'generating',
            'invalid 结算必须保持 generating',
        );
        assert.ok(root.className.includes('nd-slot--generating'), root.className);
        handle.destroy();
    });

    it('SLOT_ALREADY_RENDERED → 不进 error 红态', async () => {
        const root = makeRoot(5);
        const record = { images: [{ imageRef: 'existing' }] };
        const handle = mountSlotWidget(root, 2, {
            getChatId: () => chatId,
            onGenerateClick: async () => ({
                ok: false,
                error: { code: 'SLOT_ALREADY_RENDERED', message: 'slot #5 已有图片' },
            }),
            getRecord: () => /** @type {any} */ (record),
            getImageUrl: async () => 'https://cdn.example/e.png',
        });
        await clickBtn(root);
        assert.equal(peekSlotInflight(chatId, 2, 5), null);
        assert.ok(root.className.includes('nd-slot--done'), root.className);
        assert.equal(root.className.includes('nd-slot--error'), false);
        const errEl = [...root.childNodes].find(
            (n) => String(n.className || '').includes('nd-slot__error'),
        );
        assert.ok(errEl);
        assert.equal(errEl.hidden, true);
        handle.destroy();
    });

    it('失败态展示中文 message 与 traceId', async () => {
        const root = makeRoot(2);
        const handle = mountSlotWidget(root, 3, {
            getChatId: () => chatId,
            onGenerateClick: async () => ({
                ok: false,
                error: { message: '接口鉴权失败（Key 无效或过期）', traceId: 'trace-xyz' },
            }),
            getRecord: () => null,
            getImageUrl: async () => null,
        });
        await clickBtn(root);
        assert.ok(root.className.includes('nd-slot--error'), root.className);
        const errEl = [...root.childNodes].find(
            (n) => String(n.className || '').includes('nd-slot__error'),
        );
        const texts = [...errEl.childNodes].map((n) => n.textContent).join('\n');
        assert.match(texts, /接口鉴权失败/);
        assert.match(texts, /trace-xyz/);
        handle.destroy();
    });

    it('Abort 结算不进 error 态', async () => {
        const root = makeRoot(4);
        const handle = mountSlotWidget(root, 1, {
            getChatId: () => chatId,
            onGenerateClick: async () => ({
                ok: false,
                error: { code: 'UPSTREAM_ABORTED', message: '请求已取消' },
            }),
            getRecord: () => null,
            getImageUrl: async () => null,
        });
        await clickBtn(root);
        assert.ok(root.className.includes('nd-slot--idle'), root.className);
        assert.equal(peekSlotInflight(chatId, 1, 4), null);
        handle.destroy();
    });

    it('dispose 后退订 bus；getImageUrl 坏 URL 不写入', async () => {
        const bus = createEventBus();
        const root = makeRoot(7);
        let clicks = 0;
        /** @type {(() => void)|null} */
        let release = null;
        const handle = mountSlotWidget(root, 2, {
            bus,
            getChatId: () => chatId,
            onGenerateClick: () => new Promise((resolve) => {
                clicks += 1;
                release = () => resolve({ ok: true, value: {} });
            }),
            getRecord: () => null,
            getImageUrl: async () => null,
        });
        await clickBtn(root);
        assert.equal(clicks, 1);
        handle.destroy();
        bus.emit(APP_EVENTS.SLOT_RENDERED, { messageId: 2, slotId: 7, imageRef: 'r' });
        assert.equal(clicks, 1);
        release?.();

        const root2 = makeRoot(8);
        const handle2 = mountSlotWidget(root2, 0, {
            getChatId: () => chatId,
            onGenerateClick: async () => ({ ok: true, value: {} }),
            getRecord: () => ({ images: [{ imageRef: 'evil' }] }),
            getImageUrl: async () => 'javascript:alert(1)',
        });
        await new Promise((r) => setTimeout(r, 0));
        const imgBox = [...root2.childNodes].find(
            (n) => String(n.className || '').includes('nd-slot__img'),
        );
        assert.equal(imgBox.childNodes.length, 0);
        handle2.destroy();
    });

    it('外部出图：挂载时 isRendering → SLOT_RENDERED 后变为已出图', async () => {
        const bus = createEventBus();
        let rendering = true;
        /** @type {{ images?: Array<{ imageRef: string }> }|null} */
        let record = null;
        const root = makeRoot(1);
        const handle = mountSlotWidget(root, 3, {
            bus,
            getChatId: () => chatId,
            isRendering: () => rendering,
            hasPendingWrite: () => false,
            onGenerateClick: async () => ({ ok: true, value: {} }),
            getRecord: () => /** @type {any} */ (record),
            getImageUrl: async () => 'https://cdn.example/ext.png',
        });
        await new Promise((r) => setTimeout(r, 0));
        assert.ok(root.className.includes('nd-slot--generating'), root.className);
        const btnBusy = btnOf(root);
        assert.equal(btnBusy.disabled, true);
        assert.equal(btnBusy.getAttribute('aria-busy'), 'true');
        assert.match(String(btnBusy.textContent), /正在生图/);

        // 模拟 usecase：先清 inflight，再更新权威记录并发 SLOT_RENDERED
        rendering = false;
        record = { images: [{ imageRef: 'ref-ext' }] };
        bus.emit(APP_EVENTS.SLOT_RENDERED, {
            messageId: 3,
            slotId: 1,
            chatId,
            imageRef: 'ref-ext',
            record,
        });
        await new Promise((r) => setTimeout(r, 0));

        assert.ok(root.className.includes('nd-slot--done'), root.className);
        const btnDone = btnOf(root);
        assert.equal(btnDone.disabled, false);
        assert.equal(btnDone.getAttribute('aria-busy'), 'false');
        assert.equal(String(btnDone.textContent).includes('正在生图'), false);
        handle.destroy();
    });

    it('外部出图失败：SLOT_RENDER_FAILED → 可重试 error 态', async () => {
        const bus = createEventBus();
        let rendering = true;
        const root = makeRoot(2);
        const handle = mountSlotWidget(root, 3, {
            bus,
            getChatId: () => chatId,
            isRendering: () => rendering,
            hasPendingWrite: () => false,
            onGenerateClick: async () => ({ ok: true, value: {} }),
            getRecord: () => null,
            getImageUrl: async () => null,
        });
        await new Promise((r) => setTimeout(r, 0));
        assert.ok(root.className.includes('nd-slot--generating'), root.className);

        rendering = false;
        bus.emit(APP_EVENTS.SLOT_RENDER_FAILED, {
            messageId: 3,
            slotId: 2,
            chatId,
            error: { message: '上游超时', traceId: 'tr-fail' },
        });
        await new Promise((r) => setTimeout(r, 0));

        assert.ok(root.className.includes('nd-slot--error'), root.className);
        const btn = btnOf(root);
        assert.equal(btn.disabled, false);
        assert.equal(btn.textContent, '重试');
        const errEl = [...root.childNodes].find(
            (n) => String(n.className || '').includes('nd-slot__error'),
        );
        assert.ok(errEl);
        assert.equal(errEl.hidden, false);
        const texts = [...errEl.childNodes].map((n) => n.textContent).join('\n');
        assert.match(texts, /上游超时/);
        assert.match(texts, /tr-fail/);
        handle.destroy();
    });

    it('IMAGE_CACHE_TRIMMED：被删图立刻变未生图', async () => {
        const bus = createEventBus();
        const root = makeRoot(9);
        /** @type {Set<string>} */
        const missing = new Set();
        const handle = mountSlotWidget(root, 5, {
            bus,
            getChatId: () => chatId,
            onGenerateClick: async () => ({ ok: true, value: {} }),
            getRecord: () => ({ images: [{ imageRef: 'img-keep-me' }] }),
            getImageUrl: async (ref) => (missing.has(String(ref)) ? null : 'https://cdn.example/ok.png'),
        });
        await new Promise((r) => setTimeout(r, 0));
        assert.ok(root.className.includes('nd-slot--done'), root.className);

        missing.add('img-keep-me');
        bus.emit(APP_EVENTS.IMAGE_CACHE_TRIMMED, {
            removed: 1,
            removedRefs: ['img-keep-me'],
            limit: 3,
        });
        await new Promise((r) => setTimeout(r, 0));
        assert.ok(root.className.includes('nd-slot--idle'), root.className);
        assert.equal(btnOf(root).textContent, '生图');
        handle.destroy();
    });
});
