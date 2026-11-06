/**
 * W3 · lifecycle：activate 失败回滚、dispose 再 activate、D54/D56/D58。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    activate,
    dispose,
    _runtimeForTest,
    PUBLIC_API_NAME,
    formatUserMessage,
    ensureFloorGenerateButton,
} from '../../src/bootstrap/lifecycle.js';
import { createContainer } from '../../src/bootstrap/container.js';
import { createMemoryIdb } from '../../src/adapters/storage/memory-idb.js';
import { createSillyTavernHost, PLUGIN_NS } from '../../src/adapters/host/sillytavern.host.js';
import { GENERATE_INTERCEPTOR_GLOBAL_NAME } from '../../src/adapters/host/generate-interceptor.js';
import { installFakeDom } from '../ui/fake-dom.js';
import { emptyNaiCaption } from '../../src/domain/model/nai-params.js';
import { probeCapabilities } from '../../src/bootstrap/capabilities.js';
import { Ok, Err } from '../../src/infra/result.js';

function makeFakeContext(overrides = {}) {
    /** @type {object[]} */
    const slashCommands = [];
    const listeners = new Map();
    const ctx = {
        chat: [
            { name: 'User', mes: 'hi', is_user: true, is_system: false, extra: {} },
            { name: 'Char', mes: 'hello', is_user: false, is_system: false, extra: {} },
        ],
        chatId: 'chat-life',
        chatMetadata: { integrity: 'sess-life-1' },
        maxContext: 4096,
        extensionSettings: {
            regex: [],
            disabledExtensions: [],
            [PLUGIN_NS]: undefined,
        },
        extensionPrompts: {},
        powerUserSettings: { encode_tags: false },
        eventTypes: {
            CHAT_CHANGED: 'chat_id_changed',
            CHAT_DELETED: 'chat_deleted',
            GROUP_CHAT_DELETED: 'group_chat_deleted',
            CHAT_RENAMED: 'chat_renamed',
            CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
            MESSAGE_UPDATED: 'message_updated',
            MORE_MESSAGES_LOADED: 'more_messages_loaded',
        },
        eventSource: {
            on(event, handler) {
                if (!listeners.has(event)) listeners.set(event, new Set());
                listeners.get(event).add(handler);
            },
            removeListener(event, handler) {
                listeners.get(event)?.delete(handler);
            },
        },
        getCurrentChatId: () => 'chat-life',
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        characters: [],
        groups: [],
        saveSettingsDebounced() {},
        saveMetadataDebounced() {},
        async saveChat() {},
        updateMessageBlock() {},
        async getWorldInfoPrompt() {
            return { worldInfoString: '' };
        },
        setExtensionPrompt() {},
        SlashCommandParser: {
            addCommandObject(cmd) {
                const name = cmd?.name ?? '';
                const idx = slashCommands.findIndex((c) => c.name === name);
                if (idx >= 0) slashCommands[idx] = cmd;
                else slashCommands.push(cmd);
            },
        },
        SlashCommand: {
            fromProps(spec) {
                return spec;
            },
        },
        substituteParams: (t) => t,
        callGenericPopup: async () => {},
        _slashCommands: slashCommands,
        _slashRegistry: slashCommands, // 占位；下方 defineProperty 提供 .includes 视图
        ...overrides,
    };
    // 让 _slashRegistry.includes 仍可用：代理成名字数组视图
    Object.defineProperty(ctx, '_slashRegistry', {
        get() {
            return slashCommands.map((c) => c.name);
        },
        enumerable: true,
    });
    return ctx;
}

async function boot(ctx) {
    const getContext = () => ctx;
    await activate({
        getContext,
        createContainer: (opts) => createContainer({
            ...opts,
            getContext,
            host: createSillyTavernHost({ getContext }),
            db: createMemoryIdb(),
        }),
    });
}

describe('bootstrap/formatUserMessage · D58', () => {
    it('有 hint 时拼进文案', () => {
        const text = formatUserMessage({
            message: '未选择生图预设',
            hint: '请先编写并选中一份生图预设',
        });
        assert.match(text, /未选择生图预设/);
        assert.match(text, /请先编写并选中一份生图预设/);
    });

    it('Result 形状取 error.hint', () => {
        const text = formatUserMessage({
            ok: false,
            error: { message: '失败', hint: '下一步去设置' },
        });
        assert.match(text, /下一步去设置/);
    });
});

describe('bootstrap/lifecycle', () => {
    /** @type {ReturnType<typeof installFakeDom>|null} */
    let fakeDom = null;
    /** @type {Array<[string, string]>} */
    let toasts = [];

    beforeEach(async () => {
        await dispose();
        toasts = [];
        globalThis.toastr = {
            info: (m) => { toasts.push(['info', m]); },
            success: (m) => { toasts.push(['success', m]); },
            warning: (m) => { toasts.push(['warning', m]); },
            error: (m) => { toasts.push(['error', m]); },
        };
        fakeDom = installFakeDom();
        const settings = fakeDom.document.createElement('div');
        settings.id = 'extensions_settings2';
        fakeDom.document.body.appendChild(settings);
        const chat = fakeDom.document.createElement('div');
        chat.id = 'chat';
        fakeDom.document.body.appendChild(chat);
    });

    afterEach(async () => {
        await dispose();
        fakeDom?.restore();
        fakeDom = null;
        delete globalThis.toastr;
        delete globalThis[PUBLIC_API_NAME];
        delete globalThis[GENERATE_INTERCEPTOR_GLOBAL_NAME];
    });

    it('activate 成功：挂上对外入口与 interceptor', async () => {
        const ctx = makeFakeContext();
        await boot(ctx);

        const rt = _runtimeForTest();
        assert.ok(rt.container);
        assert.equal(typeof globalThis[PUBLIC_API_NAME].generate, 'function');
        assert.equal(typeof globalThis[PUBLIC_API_NAME].generateSinglePrompt, 'function');
        assert.equal(typeof globalThis[GENERATE_INTERCEPTOR_GLOBAL_NAME], 'function');
        assert.ok(ctx._slashRegistry.includes('naigen'));
        assert.ok(ctx._slashRegistry.includes('naiwb'));
        assert.ok(ctx._slashRegistry.includes('naimgr'));
        assert.ok(ctx._slashRegistry.includes('naifloor'));
        assert.ok(ctx._slashRegistry.includes('naicfg'));
        assert.ok(ctx._slashRegistry.includes('naiartist'));
    });

    it('/naiwb wires the shared artist picker and releases it when the dialog closes', async () => {
        const ctx = makeFakeContext();
        await boot(ctx);
        const container = _runtimeForTest().container;
        let unsubscribeCount = 0;
        let coverCalls = 0;
        const originalOnChange = container.settingsStore.onChange;
        container.settingsStore.onChange = (fn) => {
            const unsubscribe = originalOnChange(fn);
            return () => {
                unsubscribeCount += 1;
                unsubscribe();
            };
        };
        container.repos.artist.list = async () => Ok([
            { id: 'a1', name: 'Alpha' },
            { id: 'a2', name: 'Beta' },
        ]);
        container.artistFileUrl.cardUrl = (item) => {
            coverCalls += 1;
            return item ? `/user/files/nai-dbgen_${item.id}.webp` : null;
        };
        container.settingsStore.set('activeArtistId', 'a1');
        const command = ctx._slashCommands.find((cmd) => cmd.name === 'naiwb');
        await command.callback({}, '');
        await new Promise((resolve) => setImmediate(resolve));

        const workbench = fakeDom.document.body.querySelector('.nd-workbench');
        assert.ok(workbench);
        const picker = workbench.querySelector('.nd-wb-artist');
        assert.equal(picker.querySelector('input').value, 'Alpha');
        assert.ok(coverCalls > 0);
        container.settingsStore.set('activeArtistId', 'a2');
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(picker.querySelector('input').value, 'Beta');

        const dialog = workbench.closest('dialog');
        assert.ok(dialog);
        for (const listener of [...dialog._listeners].filter((item) => item.type === 'close')) {
            listener.fn({ target: dialog });
        }
        assert.equal(unsubscribeCount, 1);
        assert.equal(fakeDom.document.body.querySelector('.nd-workbench'), null);
        _runtimeForTest().panelShell.destroy();
        assert.equal(unsubscribeCount, 1);
    });

    it('activate 后触发图片缓存裁剪；失败只记日志不抛', async () => {
        const ctx = makeFakeContext();
        const getContext = () => ctx;
        let trimCalls = 0;
        await activate({
            getContext,
            createContainer: async (opts) => {
                const c = await createContainer({
                    ...opts,
                    getContext,
                    host: createSillyTavernHost({ getContext }),
                    db: createMemoryIdb(),
                });
                const orig = c.services.imageCacheTrim.trim.bind(c.services.imageCacheTrim);
                c.services.imageCacheTrim.trim = async () => {
                    trimCalls += 1;
                    return Err({ code: 'TRIM_FAIL', message: '模拟失败', category: 'storage' });
                };
                // keep orig referenced for lint silence in case needed
                void orig;
                return c;
            },
        });
        await new Promise((r) => setTimeout(r, 20));
        assert.equal(trimCalls, 1);
        assert.ok(_runtimeForTest().container);
    });

    it('对外入口缺 replaceCharacterKeywords → 报错', async () => {
        const ctx = makeFakeContext();
        await boot(ctx);

        await assert.rejects(
            () => globalThis[PUBLIC_API_NAME].generate({ caption: emptyNaiCaption() }),
            /replaceCharacterKeywords/,
        );
    });

    it('4.16 generateSinglePrompt 空描述 → Result Err（与 4.14 同为 resolve Result）', async () => {
        const ctx = makeFakeContext();
        await boot(ctx);

        const r = await globalThis[PUBLIC_API_NAME].generateSinglePrompt({ description: '  ' });
        assert.equal(r.ok, false);
        assert.equal(r.error.code, 'WORKBENCH_DESC_EMPTY');
    });

    it('activate 中途失败 → 已建资源被回收、不抛到宿主', async () => {
        const ctx = makeFakeContext();
        const getContext = () => ctx;
        let disposed = false;

        await activate({
            getContext,
            createContainer: async (opts) => {
                const c = await createContainer({
                    ...opts,
                    getContext,
                    host: createSillyTavernHost({ getContext }),
                    db: createMemoryIdb(),
                });
                const origDispose = c.dispose.bind(c);
                c.dispose = () => {
                    disposed = true;
                    origDispose();
                };
                c.services.autoTrigger.start = () => {
                    throw new Error('模拟自动触发启动失败');
                };
                return c;
            },
        });

        const rt = _runtimeForTest();
        assert.equal(rt.container, null);
        assert.equal(globalThis[PUBLIC_API_NAME], undefined);
        assert.equal(disposed, true);
        assert.ok(toasts.some((t) => t[0] === 'error' && /启动失败/.test(t[1])));
        // D56：失败发生在斜杠注册之前 → 本次未注册
        assert.equal(ctx._slashRegistry.includes('naigen'), false);
    });

    it('D56：dispose 后敲 /naigen →「未成功加载」而非死容器报错', async () => {
        const ctx = makeFakeContext();
        await boot(ctx);
        const cmd = ctx._slashCommands.find((c) => c.name === 'naigen');
        assert.ok(cmd && typeof cmd.callback === 'function');

        await dispose();
        assert.equal(_runtimeForTest().container, null);
        toasts.length = 0;

        const out = await cmd.callback({}, '');
        assert.equal(out, '');
        assert.ok(toasts.some((t) => /未成功加载/.test(t[1])));
    });

    it('D56：activate 失败后（曾成功过）敲 /naigen →「未成功加载」', async () => {
        const ctx = makeFakeContext();
        await boot(ctx);
        const cmd = ctx._slashCommands.find((c) => c.name === 'naigen');
        assert.ok(cmd);

        // 再 activate 并在 autoTrigger 失败
        const getContext = () => ctx;
        await activate({
            getContext,
            createContainer: async (opts) => {
                const c = await createContainer({
                    ...opts,
                    getContext,
                    host: createSillyTavernHost({ getContext }),
                    db: createMemoryIdb(),
                });
                c.services.autoTrigger.start = () => {
                    throw new Error('二次启动失败');
                };
                return c;
            },
        });

        assert.equal(_runtimeForTest().container, null);
        toasts.length = 0;
        await cmd.callback({}, '1');
        assert.ok(toasts.some((t) => /未成功加载/.test(t[1])));
    });

    it('dispose 后再 activate → 不泄漏、斜杠仍可用', async () => {
        const ctx = makeFakeContext();
        await boot(ctx);
        await dispose();
        assert.equal(_runtimeForTest().container, null);
        assert.equal(globalThis[PUBLIC_API_NAME], undefined);

        await boot(ctx);
        assert.ok(_runtimeForTest().container);
        const cmd = ctx._slashCommands.find((c) => c.name === 'naigen');
        assert.ok(cmd);
        // 活查应指向新容器（不 toast 未加载）
        toasts.length = 0;
        // execute 会因缺配置失败，但不应是「未成功加载」
        await cmd.callback({}, '1');
        assert.equal(toasts.some((t) => /未成功加载/.test(t[1])), false);
    });

    it('宿主缺关键 API → 优雅降级并报中文错误', async () => {
        await activate({
            getContext: () => {
                throw new Error('no ctx');
            },
            createContainer: async () => {
                throw new Error('找不到 SillyTavern.getContext；请确认在酒馆页面内加载本插件');
            },
        });

        assert.equal(_runtimeForTest().container, null);
        assert.ok(toasts.some((t) => t[0] === 'error' && /启动失败|找不到/.test(t[1])));
    });

    it('probeCapabilities：缺 eventSource 标为不可用', async () => {
        const host = {
            getCurrentChatId: () => null,
            ensureSlotRegexInstalled: async () => ({ ok: true }),
            toast() {},
            dispose() {},
        };
        const report = await probeCapabilities(/** @type {any} */ (host), {
            getContext: () => ({
                extensionSettings: {},
            }),
            assume: { indexedDB: true },
        });
        const item = report.items.find((i) => i.id === 'eventSource');
        assert.equal(item?.available, false);
        assert.ok(/自动生成提示词/.test(item?.detail || ''));
    });

    it('D54：楼层按钮进行中再点 → execute 只进入一次（共享 Promise）', async () => {
        const ctx = makeFakeContext();
        await boot(ctx);
        const container = _runtimeForTest().container;
        assert.ok(container);

        let enterCount = 0;
        const origExecute = container.useCases.generateSlots.execute.bind(container.useCases.generateSlots);
        const origIsWriting = container.useCases.generateSlots.isWriting.bind(container.useCases.generateSlots);

        let release;
        const blocker = new Promise((resolve) => { release = resolve; });
        /** @type {Promise<any>|null} */
        let shared = null;

        container.useCases.generateSlots.isWriting = () => !!shared;
        container.useCases.generateSlots.execute = async () => {
            if (shared) {
                return shared;
            }
            enterCount += 1;
            shared = (async () => {
                await blocker;
                return Ok({
                    records: [],
                    traceId: 't',
                    llmCallCount: 0,
                    unmatchedKeys: [],
                });
            })();
            return shared;
        };

        // fake-dom 的 querySelector/getElementById 是空实现 → 手持引用
        const mes = fakeDom.document.createElement('div');
        mes.className = 'mes';
        mes.setAttribute('mesid', '1');
        // 让 ensureFloorGenerateButton 走 messageEl 兜底挂载（querySelector 恒 null）
        const beforeCount = mes.childNodes.length;
        ensureFloorGenerateButton(mes, 1, container);
        assert.equal(mes.childNodes.length, beforeCount + 1);
        const btn = mes.childNodes[mes.childNodes.length - 1];
        assert.equal(btn.getAttribute('data-nai-dbgen-floor-btn'), '1');

        const click = () => {
            const listeners = btn._listeners?.filter((l) => l.type === 'click') ?? [];
            return Promise.all(listeners.map((l) => l.fn({
                preventDefault() {},
                stopPropagation() {},
            })));
        };

        const p1 = click();
        await Promise.resolve();
        assert.equal(enterCount, 1);
        assert.equal(btn.getAttribute('aria-disabled'), 'true');

        const p2 = click();
        await Promise.resolve();
        assert.equal(enterCount, 1);

        release();
        await p1;
        await p2;
        assert.equal(enterCount, 1);

        container.useCases.generateSlots.execute = origExecute;
        container.useCases.generateSlots.isWriting = origIsWriting;
    });

    it('D58：错误 toast 含 hint', async () => {
        const ctx = makeFakeContext();
        await boot(ctx);
        const cmd = ctx._slashCommands.find((c) => c.name === 'naigen');
        toasts.length = 0;
        // 未配预设 → 应用层 Err 带 hint
        await cmd.callback({}, '1');
        const errToast = toasts.find((t) => t[0] === 'error');
        assert.ok(errToast, `应有 error toast，实际：${JSON.stringify(toasts)}`);
        // hint 常见文案：请先… / 请在…
        assert.ok(
            /。/.test(errToast[1]) || /请/.test(errToast[1]),
            `toast 应含指引：${errToast[1]}`,
        );
    });

    it('activate 成功后 body 下有且仅有一个悬浮球根', async () => {
        const ctx = makeFakeContext();
        await boot(ctx);

        const rt = _runtimeForTest();
        assert.ok(rt.floatingBallHandle);
        assert.ok(rt.floatingBallRoot);
        assert.equal(rt.floatingBallRoot.parentNode, fakeDom.document.body);
        assert.ok(rt.floatingBallRoot.classList.contains('nd-root'));
        assert.equal(countFloatingBallRoots(fakeDom.document.body), 1);
        assert.equal(countFabButtons(fakeDom.document.body), 1);
    });

    it('dispose 后悬浮球从 body 移除', async () => {
        const ctx = makeFakeContext();
        await boot(ctx);
        assert.equal(countFloatingBallRoots(fakeDom.document.body), 1);

        await dispose();
        const rt = _runtimeForTest();
        assert.equal(rt.floatingBallHandle, null);
        assert.equal(rt.floatingBallRoot, null);
        assert.equal(countFloatingBallRoots(fakeDom.document.body), 0);
        assert.equal(countFabButtons(fakeDom.document.body), 0);
    });

    it('activate → dispose → activate 不重复挂球', async () => {
        const ctx = makeFakeContext();
        await boot(ctx);
        await dispose();
        await boot(ctx);

        assert.equal(countFloatingBallRoots(fakeDom.document.body), 1);
        assert.equal(countFabButtons(fakeDom.document.body), 1);
        assert.ok(_runtimeForTest().floatingBallHandle);
    });

    it('activate 在挂球前失败 → 无悬浮球残留', async () => {
        const ctx = makeFakeContext();
        const getContext = () => ctx;

        await activate({
            getContext,
            createContainer: async (opts) => {
                const c = await createContainer({
                    ...opts,
                    getContext,
                    host: createSillyTavernHost({ getContext }),
                    db: createMemoryIdb(),
                });
                // 失败点在斜杠/挂球之前（与现有 D56 测例同位置）
                c.services.autoTrigger.start = () => {
                    throw new Error('挂球前失败');
                };
                return c;
            },
        });

        assert.equal(_runtimeForTest().container, null);
        assert.equal(_runtimeForTest().floatingBallHandle, null);
        assert.equal(countFloatingBallRoots(fakeDom.document.body), 0);
        assert.equal(countFabButtons(fakeDom.document.body), 0);
    });
});

/**
 * 宿主容器：body 直系 `.nd-root` 且含 `.nd-fab` 子节点。
 * @param {any} body
 * @returns {number}
 */
function countFloatingBallRoots(body) {
    let n = 0;
    for (const child of body?.childNodes || []) {
        if (!child?.classList?.contains('nd-root')) {
            continue;
        }
        const hasFab = (child.childNodes || []).some(
            (c) => c?.classList?.contains('nd-fab'),
        );
        if (hasFab) {
            n += 1;
        }
    }
    return n;
}

/**
 * @param {any} root
 * @returns {number}
 */
function countFabButtons(root) {
    let n = 0;
    /**
     * @param {any} node
     */
    function walk(node) {
        if (!node) {
            return;
        }
        if (node.classList?.contains('nd-fab')) {
            n += 1;
        }
        for (const c of node.childNodes || []) {
            walk(c);
        }
    }
    walk(root);
    return n;
}
