/**
 * L0 装配 · activate / dispose（manifest hooks）。
 * 归属：W3-J 装配代理实现。
 *
 * activate：装配 → 装正则 → 挂抽屉 → 挂 slot 观察器 → 自动触发 → 对外入口 → 斜杠（最后，D56）
 * dispose：全部倒序拆干净（D28）。中途失败须回收已建资源，不抛到宿主。
 *
 * D56：斜杠回调不闭包死容器，一律读 runtime.container；未加载时提示「未成功加载」。
 * D54：楼层写 slot 按钮跟 generateSlots.isWriting 禁用。
 * D58：toast 拼上 AppError.hint。
 */

import { newId } from '../infra/id.js';
import { nowIso } from '../infra/clock.js';
import { createContainer } from './container.js';
import { probeCapabilities, capabilityWarningMessages } from './capabilities.js';
import { installSeedAssets } from './seed.js';
import { APP_EVENTS } from '../application/_helpers.js';
import { createLogger } from '../infra/logger.js';
import { setLoadBanner } from './load-banner.js';
import { createSlotMountObserver, findSlotInMessage } from '../adapters/host/slot-mount.observer.js';
import { GENERATE_INTERCEPTOR_GLOBAL_NAME } from '../adapters/host/generate-interceptor.js';
import { mountFloatingBall, formatGenerateFloorToast } from '../ui/floating-ball/floating-ball.js';
import { isOk } from '../infra/result.js';
import { openPanelShell } from '../ui/panels/shell.js';
import { mountWorkbench } from '../ui/workbench/workbench.js';
import { mountSlotWidget } from '../ui/slot-widget/slot-widget.js';
import { openModal } from '../ui/common/modal.js';
import { removeDeletedSlotElements } from '../ui/slot-editor/slot-editor.js';
import { installQuickReplyEntry } from './quick-reply-entry.js';

const log = createLogger('bootstrap/lifecycle');

/** @type {string} */
export const PLUGIN_VERSION = '0.2.40';

/** @type {string} */
export const PUBLIC_API_NAME = 'NaiDbGen';

/** 楼层「写 slot」按钮标记 */
const FLOOR_BTN_ATTR = 'data-nai-dbgen-floor-btn';

/**
 * 出图按钮画在前端代码块的 iframe 里。从消息来源窗口找到父页面上的那层 iframe。
 * @param {Window|null} win
 * @param {Document|null} doc
 * @returns {Element|null}
 */
function findHostIframe(win, doc) {
    if (!win || !doc || typeof doc.querySelectorAll !== 'function') {
        return null;
    }
    const frames = doc.querySelectorAll('iframe');
    for (const frame of frames) {
        if (frame.contentWindow === win) {
            return frame;
        }
        try {
            if (findHostIframe(win, frame.contentDocument)) {
                return frame;
            }
        } catch {
            // 跨域 iframe 读不到
        }
    }
    return null;
}

/** 楼层按钮 busy 轮询间隔（跟 isWriting，含自动写） */
const FLOOR_BUSY_POLL_MS = 200;

/**
 * @typedef {object} RuntimeState
 * @property {Awaited<ReturnType<typeof createContainer>>|null} container
 * @property {{ destroy: () => void }|null} drawerHandle
 * @property {{ destroy: () => void }|null} floatingBallHandle
 * @property {Element|null} floatingBallRoot
 * @property {{ start: () => void, stop: () => void, reconcile: () => void }|null} slotObserver
 * @property {Map<string, { destroy: () => void }>} slotWidgets
 * @property {(() => void)|null} unsubUnmatched
 * @property {(() => void)|null} unsubImageCacheTrimmed
 * @property {(() => void)|null} unsubDomReady
 * @property {(() => void)|null} unsubChatChanged
 * @property {(() => void)|null} unsubSlotRenderedCache
 * @property {(() => void)|null} unsubSlotsWrittenCache
 * @property {{ destroy: () => void }|null} panelShell
 * @property {{ destroy: () => void }|null} workbenchModal
 * @property {ReturnType<typeof setInterval>|null} floorBusyTimer
 * @property {boolean} activating
 * @property {boolean} slashRegistered
 */

/** @type {RuntimeState} */
const runtime = {
    editorCleanup: null,
    container: null,
    drawerHandle: null,
    floatingBallHandle: null,
    floatingBallRoot: null,
    slotObserver: null,
    slotWidgets: new Map(),
    unsubUnmatched: null,
    unsubImageCacheTrimmed: null,
    unsubDomReady: null,
    unsubChatChanged: null,
    unsubSlotRenderedCache: null,
    unsubSlotsWrittenCache: null,
    panelShell: null,
    workbenchModal: null,
    floorBusyTimer: null,
    activating: false,
    slashRegistered: false,
};

/** messageId::slotId → SlotRecord 同步缓存（控件 getRecord 是同步的） */
const recordCache = new Map();

/** messageId::slotId → 展示元数据（超出保留 / 缓存图 / 加载失败） */
const slotMetaCache = new Map();

/**
 * @typedef {object} SlotViewMeta
 * @property {boolean} [beyondRetain]
 * @property {boolean} [hasCachedImage]
 * @property {string|null} [cachedImageRef]
 * @property {boolean} [loadError]
 * @property {string|null} [loadErrorMessage]
 */

/**
 * 面向用户的错误文案：message + hint（D58）。
 * @param {unknown} err
 * @returns {string}
 */
export function formatUserMessage(err) {
    if (err == null) {
        return '操作失败';
    }
    if (typeof err === 'string') {
        return err;
    }
    if (typeof err !== 'object') {
        return String(err);
    }
    const rec = /** @type {{ message?: unknown, hint?: unknown, error?: unknown }} */ (err);
    // Result 形状：{ ok:false, error }
    if (rec.error && typeof rec.error === 'object') {
        return formatUserMessage(rec.error);
    }
    const message = typeof rec.message === 'string' && rec.message
        ? rec.message
        : '操作失败';
    const hint = typeof rec.hint === 'string' && rec.hint.trim()
        ? rec.hint.trim()
        : '';
    if (hint) {
        return `${message}。${hint}`;
    }
    return message;
}

/**
 * @returns {() => any}
 */
function resolveGetContext() {
    return () => {
        const st = globalThis.SillyTavern;
        if (!st || typeof st.getContext !== 'function') {
            throw new Error('找不到 SillyTavern.getContext');
        }
        return st.getContext();
    };
}

/**
 * @param {import('../ports/host.port.js').HostPort|null|undefined} host
 * @param {'info'|'success'|'warning'|'error'} level
 * @param {string} message
 */
function safeToast(host, level, message) {
    const text = String(message ?? '');
    if (!text) {
        return;
    }
    try {
        if (host && typeof host.toast === 'function') {
            host.toast(level, text);
            return;
        }
    } catch {
        // fall through
    }
    try {
        const toastr = globalThis.toastr;
        if (!toastr) {
            return;
        }
        if (level === 'error') toastr.error(text);
        else if (level === 'warning') toastr.warning(text);
        else if (level === 'success') toastr.success(text);
        else toastr.info(text);
    } catch {
        // ignore
    }
}

/**
 * @param {number} messageId
 * @param {number} slotId
 * @returns {string}
 */
function recordKey(messageId, slotId) {
    return `${messageId}::${slotId}`;
}

/**
 * @returns {Awaited<ReturnType<typeof createContainer>>|null}
 */
function liveContainer() {
    return runtime.container;
}

/**
 * @param {Awaited<ReturnType<typeof createContainer>>} container
 * @returns {void}
 */
function exposePublicApi(container) {
    const api = {
        version: PLUGIN_VERSION,
        getVersion() {
            return PLUGIN_VERSION;
        },
        /**
         * 4.14 对外生图。replaceCharacterKeywords 必填，绝不推断（验收 #13/#14）。
         *
         * `params` 合并规则：
         * - 未传字段用运行配置 4.13；若因换模型等导致继承项对新模型不合法 → 回退该模型默认，不报错。
         * - 显式传入且与模型不匹配（非法模型 / 不支持的采样器·噪声·负面预设 / 宽高非 64 倍数 /
         *   该模型不支持的 Variety·CFG Rescale·透明底·SMEA 等）→ 返回
         *   `Err`（`DomainError`，code=`NAI_PARAMS_INVALID`），**不调用 NAI**。
         *
         * @param {import('../application/image-gen.service.js').ImageGenRequest} req
         */
        async generate(req) {
            const c = liveContainer();
            if (!c) {
                throw new Error('酒馆数据库生图未成功加载');
            }
            if (!req || typeof req !== 'object') {
                throw new Error('invalid argument: req');
            }
            if (typeof req.replaceCharacterKeywords !== 'boolean') {
                throw new Error('invalid argument: replaceCharacterKeywords');
            }
            return c.services.imageGen.generate(req);
        },
        /**
         * 对外写提示词：当前楼的召回预设和生图预设。用户输入只替换 {{用户描述}}。
         * 算工作台调用：工作台专用段会带上。模型回了多份就全部放在 captions 里，caption 仍是第一份。召回到的生成点按 slotId 写在 captions[].anchorSentence 上，没有则不带。不出图、不写 slot。
         * @param {{ description: string, messageId?: number, signal?: AbortSignal, skipRecall?: boolean }} req
         */
        async generateSinglePrompt(req) {
            const c = liveContainer();
            if (!c) {
                throw new Error('酒馆数据库生图未成功加载');
            }
            if (!req || typeof req !== 'object') {
                throw new Error('invalid argument: req');
            }
            return c.services.workbench.writePrompt({
                mode: 'floor',
                includeWorkbenchOnly: true,
                naturalLanguage: req.description,
                ...(req.skipRecall === true && { skipRecall: true }),
                messageId: req.messageId,
                signal: req.signal,
            });
        },
        async getActiveArtist() {
            const c = liveContainer();
            if (!c) {
                throw new Error('酒馆数据库生图未成功加载');
            }
            return c.services.imageGen.getActiveArtist();
        },
        async listNaiConfigs() {
            const c = liveContainer();
            if (!c) {
                return [];
            }
            const r = await c.repos.naiConfig.list();
            return r?.ok ? r.value : [];
        },
        openWorkbench() {
            const c = liveContainer();
            if (!c) {
                safeToast(null, 'warning', '酒馆数据库生图未成功加载');
                return Promise.resolve();
            }
            return openWorkbenchUi(c);
        },
        /**
         * @param {string|{ tab?: string }|undefined} [tabOrOpts]
         */
        openManagement(tabOrOpts) {
            const c = liveContainer();
            if (!c) {
                safeToast(null, 'warning', '酒馆数据库生图未成功加载');
                return Promise.resolve();
            }
            const tab = typeof tabOrOpts === 'string'
                ? tabOrOpts
                : (tabOrOpts && typeof tabOrOpts === 'object' ? tabOrOpts.tab : undefined);
            return openManagementUi(c, tab);
        },
    };
    globalThis[PUBLIC_API_NAME] = api;
    try {
        if (typeof window !== 'undefined') {
            window[PUBLIC_API_NAME] = api;
        }
    } catch {
        // Node / 无 window
    }
}

/**
 * @returns {void}
 */
function clearPublicApi() {
    try {
        if (globalThis[PUBLIC_API_NAME]) {
            delete globalThis[PUBLIC_API_NAME];
        }
    } catch {
        // ignore
    }
    try {
        if (typeof window !== 'undefined' && window[PUBLIC_API_NAME]) {
            delete window[PUBLIC_API_NAME];
        }
    } catch {
        // ignore
    }
}

/**
 * @param {Awaited<ReturnType<typeof createContainer>>} container
 * @returns {object}
 */
function panelDeps(container) {
    return {
        host: container.host,
        repos: container.repos,
        services: container.services,
        bus: container.bus,
        llm: container.llm,
        imageGenPort: container.imageGenPort,
        loadSettings: container.loadSettings,
        saveSettings: (s) => container.settingsStore.save(s),
        serverFiles: container.serverFiles,
        artistFileUrl: container.artistFileUrl,
        newId,
        nowIso,
    };
}

/**
 * @param {Awaited<ReturnType<typeof createContainer>>} container
 * @param {string} [initialTab]
 * @returns {Promise<void>}
 */
async function openManagementUi(container, initialTab) {
    try {
        runtime.panelShell?.destroy();
    } catch {
        // ignore
    }
    runtime.panelShell = await openPanelShell(panelDeps(container), initialTab);
}

/**
 * @param {Awaited<ReturnType<typeof createContainer>>} container
 * @returns {Promise<void>}
 */
async function openWorkbenchUi(container) {
    try {
        runtime.workbenchModal?.destroy();
    } catch {
        // ignore
    }
    if (typeof document === 'undefined') {
        return;
    }
    const root = document.createElement('div');
    root.className = 'nd-root';
    const handle = mountWorkbench(root, {
        host: container.host,
        workbenchService: container.services.workbench,
        artistDraftService: container.services.workbenchArtistDraft,
        tagRepo: container.repos.tag,
        marketCatalogStore: container.marketCatalogStore,
        artistRepo: container.repos.artist,
        artistFileUrl: container.artistFileUrl,
        loadSettings: container.loadSettings,
        subscribeSettings: (fn) => container.settingsStore.onChange(fn),
        imageRepo: container.repos.image,
    });
    const modal = await openModal(
        { host: container.host },
        {
            title: '生成工作台',
            element: root,
            dialogClass: 'nd-workbench-popup',
            wide: true,
            large: true,
            allowVerticalScrolling: true,
        },
    );
    const dialog = root.closest('dialog');
    const onClose = () => handle.destroy();
    dialog?.addEventListener('close', onClose, { once: true });
    runtime.workbenchModal = {
        destroy() {
            dialog?.removeEventListener('close', onClose);
            try {
                handle.destroy();
            } catch {
                // ignore
            }
            try {
                modal.destroy();
            } catch {
                // ignore
            }
        },
    };
}

/**
 * D56：回调活查 runtime.container，绝不闭包已 dispose 的容器。
 * @param {import('../ports/host.port.js').HostPort} host
 * @returns {void}
 */
function registerSlashCommands(host) {
    host.registerSlashCommand({
        name: 'naigen',
        aliases: ['nai-dbgen'],
        helpString: '对指定楼（或最近一条 AI 回复）生成生图提示词。用法：/naigen [messageId]',
        callback: async (_args, value) => {
            const container = liveContainer();
            if (!container) {
                safeToast(null, 'warning', '酒馆数据库生图未成功加载');
                return '';
            }
            const h = container.host;
            const raw = typeof value === 'string' ? value.trim() : '';
            let messageId = Number(raw);
            if (!Number.isInteger(messageId) || messageId < 0) {
                const recent = h.getRecentAiMessages(1);
                if (!recent?.length) {
                    safeToast(h, 'warning', '没有可用的 AI 楼');
                    return '';
                }
                messageId = recent[0].messageId;
            }
            if (container.useCases.generateSlots.isWriting(messageId)) {
                safeToast(h, 'info', `第 ${messageId} 楼正在生成提示词，请稍候…`);
            } else {
                safeToast(h, 'info', `正在为第 ${messageId} 楼生成提示词…`);
            }
            const result = await container.useCases.generateSlots.execute(messageId);
            if (!result.ok) {
                safeToast(h, 'error', formatUserMessage(result));
                return '';
            }
            const unmatched = Array.isArray(result.value.unmatchedKeys)
                ? result.value.unmatchedKeys
                : [];
            if (unmatched.length) {
                safeToast(h, 'warning', `召回未命中：${unmatched.join(', ')}`);
            }
            safeToast(h, 'success', `已生成 ${result.value.records.length} 条生图提示词`);
            return '';
        },
    });

    host.registerSlashCommand({
        name: 'naimgr',
        aliases: ['nai-panel'],
        helpString: '打开酒馆数据库生图',
        callback: async () => {
            const container = liveContainer();
            if (!container) {
                safeToast(null, 'warning', '酒馆数据库生图未成功加载');
                return '';
            }
            await openManagementUi(container);
            return '';
        },
    });

    host.registerSlashCommand({
        name: 'naifloor',
        aliases: ['nai-floor'],
        helpString: '对本楼生图，和悬浮球双击相同',
        callback: () => runManualFloorFromEntry(),
    });

    host.registerSlashCommand({
        name: 'naicfg',
        aliases: ['nai-config'],
        helpString: '打开配置面板，和单击悬浮球相同',
        callback: async () => {
            if (typeof runtime.floatingBallHandle?.openConfigPanel !== 'function') {
                safeToast(null, 'warning', '酒馆数据库生图未成功加载');
                return '';
            }
            runtime.floatingBallHandle.openConfigPanel();
            return '';
        },
    });

    host.registerSlashCommand({
        name: 'naiartist',
        aliases: ['nai-artist'],
        helpString: '打开画师串选择，和悬浮球长按相同',
        callback: async () => {
            const container = liveContainer();
            if (!container) {
                safeToast(null, 'warning', '酒馆数据库生图未成功加载');
                return '';
            }
            if (typeof runtime.floatingBallHandle?.openArtistPanel === 'function') {
                runtime.floatingBallHandle.openArtistPanel();
                return '';
            }
            await openManagementUi(container, 'artist');
            return '';
        },
    });

    host.registerSlashCommand({
        name: 'naiwb',
        aliases: ['nai-workbench'],
        helpString: '打开酒馆数据库生图 · 生成工作台',
        callback: async () => {
            const container = liveContainer();
            if (!container) {
                safeToast(null, 'warning', '酒馆数据库生图未成功加载');
                return '';
            }
            await openWorkbenchUi(container);
            return '';
        },
    });

    runtime.slashRegistered = true;
}

/**
 * D54：楼层按钮进行中视觉 + 禁用。
 * @param {Element} btn
 * @param {boolean} busy
 */
function setFloorBtnBusy(btn, busy) {
    if (!btn) {
        return;
    }
    try {
        btn.setAttribute('aria-busy', busy ? 'true' : 'false');
        btn.setAttribute('aria-disabled', busy ? 'true' : 'false');
        if (btn.classList) {
            if (busy) btn.classList.add('is-busy');
            else btn.classList.remove('is-busy');
        }
        btn.title = busy ? '正在生成提示词…' : '生成生图提示词';
        if (btn.style) {
            btn.style.opacity = busy ? '0.45' : '';
            btn.style.pointerEvents = busy ? 'none' : '';
            btn.style.cursor = busy ? 'wait' : '';
        }
    } catch {
        // ignore
    }
}

/**
 * @param {Element} btn
 * @param {number} messageId
 * @param {Awaited<ReturnType<typeof createContainer>>} container
 */
function syncFloorBtnBusy(btn, messageId, container) {
    const writing = typeof container.useCases.generateSlots.isWriting === 'function'
        && container.useCases.generateSlots.isWriting(messageId);
    setFloorBtnBusy(btn, writing);
}

/**
 * 轮询可见楼层按钮的 isWriting（覆盖自动写路径）。
 * @param {Awaited<ReturnType<typeof createContainer>>} container
 */
function startFloorBusyWatch(container) {
    stopFloorBusyWatch();
    runtime.floorBusyTimer = setInterval(() => {
        const c = liveContainer();
        if (!c || c !== container) {
            stopFloorBusyWatch();
            return;
        }
        if (typeof document === 'undefined') {
            return;
        }
        try {
            document.querySelectorAll(`[${FLOOR_BTN_ATTR}]`).forEach((btn) => {
                const mes = typeof btn.closest === 'function'
                    ? btn.closest('.mes[mesid]')
                    : null;
                if (!mes) {
                    return;
                }
                const mid = Number(mes.getAttribute('mesid'));
                if (Number.isInteger(mid)) {
                    syncFloorBtnBusy(btn, mid, c);
                }
            });
        } catch {
            // ignore
        }
    }, FLOOR_BUSY_POLL_MS);
}

function stopFloorBusyWatch() {
    if (runtime.floorBusyTimer != null) {
        clearInterval(runtime.floorBusyTimer);
        runtime.floorBusyTimer = null;
    }
}

/**
 * @param {Element} messageEl
 * @param {number} messageId
 * @param {Awaited<ReturnType<typeof createContainer>>} container
 */
export function ensureFloorGenerateButton(messageEl, messageId, container) {
    if (!messageEl || typeof messageEl.querySelector !== 'function') {
        return;
    }
    if (messageEl.querySelector(`[${FLOOR_BTN_ATTR}]`)) {
        const existing = messageEl.querySelector(`[${FLOOR_BTN_ATTR}]`);
        if (existing) {
            syncFloorBtnBusy(existing, messageId, container);
        }
        return;
    }
    const msg = container.host.getMessage(messageId);
    if (!msg || msg.isUser || msg.isSystem) {
        return;
    }

    const hostEl = messageEl.querySelector('.extraMesButtons')
        || messageEl.querySelector('.mes_buttons')
        || messageEl;

    const btn = document.createElement('div');
    btn.setAttribute(FLOOR_BTN_ATTR, '1');
    btn.className = 'mes_button fa-solid fa-palette';
    btn.title = '生成生图提示词';
    btn.setAttribute('role', 'button');
    btn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const c = liveContainer();
        if (!c) {
            safeToast(null, 'warning', '酒馆数据库生图未成功加载');
            return;
        }
        const host = c.host;
        // D54：进行中再点不发起第二次（execute 会共享 Promise；UI 也拒）
        if (c.useCases.generateSlots.isWriting(messageId)) {
            setFloorBtnBusy(btn, true);
            // 仍 await 同一 Promise，避免用户以为没点上
            const result = await c.useCases.generateSlots.execute(messageId);
            syncFloorBtnBusy(btn, messageId, c);
            if (!result.ok) {
                safeToast(host, 'error', formatUserMessage(result));
            }
            return;
        }
        setFloorBtnBusy(btn, true);
        safeToast(host, 'info', `正在为第 ${messageId} 楼生成提示词…`);
        try {
            const result = await c.useCases.generateSlots.execute(messageId);
            if (!result.ok) {
                safeToast(host, 'error', formatUserMessage(result));
                return;
            }
            const unmatched = Array.isArray(result.value.unmatchedKeys)
                ? result.value.unmatchedKeys
                : [];
            if (unmatched.length) {
                safeToast(host, 'warning', `召回未命中：${unmatched.join(', ')}`);
            }
            safeToast(host, 'success', `已生成 ${result.value.records.length} 条生图提示词`);
        } finally {
            syncFloorBtnBusy(btn, messageId, c);
        }
    });
    hostEl.appendChild(btn);
    syncFloorBtnBusy(btn, messageId, container);
}

/**
 * 挂悬浮球到 document.body（自建 `.nd-root` 容器，D52）。
 * 所有回调活查 liveContainer（D56）；formatError 收 AppError / Result（D58）。
 * @returns {void}
 */
function mountFloatingBallUi() {
    if (typeof document === 'undefined' || !document.body) {
        return;
    }
    destroyFloatingBallUi();

    const root = document.createElement('div');
    root.className = 'nd-root';
    document.body.appendChild(root);

    const handle = mountFloatingBall(root, {
        loadSettings: () => {
            const c = liveContainer();
            if (!c) {
                safeToast(null, 'warning', '酒馆数据库生图未成功加载');
                return /** @type {any} */ ({});
            }
            return c.loadSettings();
        },
        saveSettings: (s) => {
            const c = liveContainer();
            if (!c) {
                safeToast(null, 'warning', '酒馆数据库生图未成功加载');
                return;
            }
            c.settingsStore.save(s);
        },
        repos: {
            get character() { return liveContainer()?.repos?.character; },
            get tag() { return liveContainer()?.repos?.tag; },
            get artist() { return liveContainer()?.repos?.artist; },
            get preset() { return liveContainer()?.repos?.preset; },
            get slot() { return liveContainer()?.repos?.slot; },
            get llmConfig() { return liveContainer()?.repos?.llmConfig; },
            get naiConfig() { return liveContainer()?.repos?.naiConfig; },
            get image() { return liveContainer()?.repos?.image; },
        },
        /**
         * @param {string|{ tab?: string }|undefined} [tabOrOpts]
         */
        openManagement: (tabOrOpts) => {
            const c = liveContainer();
            if (!c) {
                safeToast(null, 'warning', '酒馆数据库生图未成功加载');
                return;
            }
            const tab = typeof tabOrOpts === 'string'
                ? tabOrOpts
                : (tabOrOpts && typeof tabOrOpts === 'object' ? tabOrOpts.tab : undefined);
            return openManagementUi(c, tab);
        },
        openWorkbench: () => {
            const c = liveContainer();
            if (!c) {
                safeToast(null, 'warning', '酒馆数据库生图未成功加载');
                return;
            }
            return openWorkbenchUi(c);
        },
        generateFloor: async () => {
            const c = liveContainer();
            if (!c) {
                safeToast(null, 'warning', '酒馆数据库生图未成功加载');
                return /** @type {any} */ ({
                    ok: false,
                    error: {
                        message: '酒馆数据库生图未成功加载',
                        hint: '请重新启用扩展后再试',
                    },
                });
            }
            return c.useCases.generateFloor.execute(undefined, { manual: true });
        },
        isFloorBusy: () => {
            try {
                const c = liveContainer();
                if (!c) {
                    return false;
                }
                const floor = c.useCases.generateFloor;
                if (typeof floor?.isRunning === 'function' && floor.isRunning()) {
                    return true;
                }
                const recent = c.host.getRecentAiMessages?.(1);
                const mid = recent?.[0]?.messageId;
                if (typeof mid === 'number'
                    && typeof c.useCases.generateSlots?.isWriting === 'function'
                    && c.useCases.generateSlots.isWriting(mid)) {
                    return true;
                }
                return false;
            } catch {
                return false;
            }
        },
        toast: (level, message) => {
            const c = liveContainer();
            safeToast(c?.host ?? null, /** @type {any} */ (level), message);
        },
        // 组件 Err 路径传 result.error（AppError）；catch 传 thrown；两者 formatUserMessage 均带 hint
        formatError: (err) => formatUserMessage(err),
        get artistFileUrl() {
            return liveContainer()?.artistFileUrl;
        },
    });

    runtime.floatingBallRoot = root;
    runtime.floatingBallHandle = {
        openArtistPanel() {
            try {
                handle.openArtistPanel();
            } catch {
                // ignore
            }
        },
        openConfigPanel() {
            try {
                handle.openConfigPanel();
            } catch {
                // ignore
            }
        },
        destroy() {
            try {
                handle.destroy();
            } catch {
                // ignore
            }
            try {
                root.remove();
            } catch {
                // ignore
            }
        },
    };
}

/**
 * 和悬浮球双击同一条路：已有图先警告，确认后从写提示词重跑再出图。
 * @returns {Promise<string>}
 */
async function runManualFloorFromEntry() {
    const container = liveContainer();
    if (!container) {
        safeToast(null, 'warning', '酒馆数据库生图未成功加载');
        return '';
    }
    const floor = container.useCases.generateFloor;
    if (typeof floor?.isRunning === 'function' && floor.isRunning()) {
        safeToast(container.host, 'info', '本楼正在生图，请稍候…');
        return '';
    }
    /** @type {any} */
    let result;
    try {
        result = await floor.execute(undefined, { manual: true });
    } catch (err) {
        safeToast(container.host, 'error', formatUserMessage(err));
        return '';
    }
    if (result == null || (typeof result === 'object' && !('ok' in result))) {
        safeToast(container.host, 'error', '本楼生图失败，请重试');
        return '';
    }
    if (isOk(result)) {
        const toast = formatGenerateFloorToast(result.value);
        safeToast(container.host, toast.level, toast.message);
    } else {
        safeToast(container.host, 'error', formatUserMessage(result.error));
    }
    return '';
}

/**
 * @returns {void}
 */
function destroyFloatingBallUi() {
    try {
        runtime.floatingBallHandle?.destroy();
    } catch {
        // ignore
    }
    runtime.floatingBallHandle = null;
    runtime.floatingBallRoot = null;
}

/**
 * 预热 recordCache 后再挂控件，避免 remount 闪「未生图」。
 * @param {Awaited<ReturnType<typeof createContainer>>} container
 * @param {Element} messageEl
 * @param {number} messageId
 * @param {number} slotId
 */
async function mountOneSlot(container, slotEl, messageId, slotId) {
    const mes = typeof document !== 'undefined'
        ? document.querySelector(`.mes[mesid="${messageId}"]`)
        : null;
    const slotRoot = (mes && findSlotInMessage(mes, slotId))
        || (slotEl?.getAttribute?.('data-slot') === String(slotId) ? slotEl : null);
    if (!slotRoot) {
        slotEl?.removeAttribute?.('data-nai-mounted');
        return;
    }

    const key = `${container.host.getCurrentChatId() ?? ''}::${messageId}::${slotId}`;
    const prev = runtime.slotWidgets.get(key);
    if (prev) {
        try {
            prev.destroy();
        } catch {
            // ignore
        }
        runtime.slotWidgets.delete(key);
    }

    // 预热：先读权威记录再挂载；无记录则查缓存图 → 超出保留范围态
    try {
        const loadErr = typeof container.repos.slot.getLoadError === 'function'
            ? container.repos.slot.getLoadError()
            : null;
        if (loadErr) {
            slotMetaCache.set(recordKey(messageId, slotId), {
                loadError: true,
                loadErrorMessage: loadErr.message || '生图记录加载失败，请刷新后重试',
            });
        } else {
            const r = await container.repos.slot.get(messageId, slotId);
            if (r?.ok && r.value) {
                recordCache.set(recordKey(messageId, slotId), r.value);
                slotMetaCache.delete(recordKey(messageId, slotId));
            } else if (r?.ok && !r.value) {
                const sessionId = typeof container.repos.slot.getSessionId === 'function'
                    ? container.repos.slot.getSessionId()
                    : (typeof container.host.getSessionId === 'function'
                        ? container.host.getSessionId()
                        : null);
                let cachedRef = null;
                if (sessionId && typeof container.repos.image.getSlotImageRef === 'function') {
                    const cr = await container.repos.image.getSlotImageRef(sessionId, slotId);
                    if (cr?.ok && cr.value) {
                        cachedRef = cr.value;
                    }
                }
                slotMetaCache.set(recordKey(messageId, slotId), {
                    beyondRetain: true,
                    hasCachedImage: cachedRef != null,
                    cachedImageRef: cachedRef,
                });
            } else if (r && r.ok === false) {
                slotMetaCache.set(recordKey(messageId, slotId), {
                    loadError: true,
                    loadErrorMessage: r.error?.message || '生图记录加载失败，请刷新后重试',
                });
            }
        }
    } catch {
        // 读失败不阻断挂载
    }

    // 激活期间被 dispose
    if (liveContainer() !== container) {
        return;
    }

    let handle;
    try {
        handle = mountSlotWidget(slotRoot, messageId, {
            host: container.host,
            bus: container.bus,
            getChatId: () => container.host.getCurrentChatId(),
            isRendering: (mid, sid) => container.useCases.renderSlot.isRendering(mid, sid),
            hasPendingWrite: (mid, sid) => container.useCases.renderSlot.hasPendingWrite(mid, sid),
            onGenerateClick: (mid, sid, opts) => container.useCases.renderSlot.execute(mid, sid, {
                signal: opts?.signal,
                force: opts?.force === true,
            }),
            getRecord: (mid, sid) => recordCache.get(recordKey(mid, sid)) ?? null,
            getSlotMeta: (mid, sid) => slotMetaCache.get(recordKey(mid, sid)) ?? null,
            getImageUrl: async (imageRef) => {
                const r = await container.repos.image.getUrl(imageRef);
                return r?.ok ? (r.value ?? null) : null;
            },
            getFloorImageScale: () => {
                const n = Number(container.loadSettings()?.floorImageScale);
                return Number.isInteger(n) ? n : 100;
            },
        });
    } catch {
        slotRoot.removeAttribute?.('data-nai-mounted');
        return;
    }

    runtime.slotWidgets.set(key, handle);
}

/**
 * 预热某楼全部 slot 记录（切聊天 / 楼层就绪时）。
 * @param {Awaited<ReturnType<typeof createContainer>>} container
 * @param {number} messageId
 */
async function warmupMessageRecords(container, messageId) {
    try {
        const r = await container.repos.slot.getByMessage(messageId);
        if (!r?.ok || !Array.isArray(r.value)) {
            return;
        }
        for (const rec of r.value) {
            if (rec && rec.slotId != null) {
                recordCache.set(recordKey(messageId, rec.slotId), rec);
            }
        }
    } catch {
        // ignore
    }
}

/**
 * 插件激活：能力探测、装正则、挂 UI、启动观察器与自动开关。
 * 任何一步抛错都会捕住、中文 toast、回收已建资源，不抛到宿主。
 * @param {object} [opts] 测试注入
 * @param {() => any} [opts.getContext]
 * @param {typeof createContainer} [opts.createContainer]
 * @param {object} [opts.containerOpts]
 * @param {object} [opts.seedOpts] 透传给 installSeedAssets（测试用 envelopes/storage）
 * @returns {Promise<void>}
 */
export async function activate(opts = {}) {
    if (runtime.activating) {
        return;
    }
    if (runtime.container) {
        await dispose();
    }

    runtime.activating = true;
    /** @type {Array<() => void|Promise<void>>} */
    const rollback = [];

    try {
        const getContext = typeof opts.getContext === 'function'
            ? opts.getContext
            : resolveGetContext();
        const create = typeof opts.createContainer === 'function'
            ? opts.createContainer
            : createContainer;

        const container = await create({ getContext, ...(opts.containerOpts || {}) });
        runtime.container = container;
        rollback.push(() => {
            try {
                container.dispose();
            } catch {
                // ignore
            }
            runtime.container = null;
        });

        const report = await probeCapabilities(container.host, {
            getContext,
            assume: { indexedDB: true },
        });
        for (const msg of capabilityWarningMessages(report)) {
            safeToast(container.host, 'warning', msg);
        }
        if (!report.ok) {
            const fatal = report.items.find((it) => (
                !it.available && ['getContext', 'indexedDB', 'hostPort'].includes(it.id)
            ));
            throw new Error(fatal?.detail || '宿主关键能力缺失，插件无法启动');
        }

        // 库/配置必须先成功加载到内存才跑种子；读失败绝不当成空、也不写服务器
        const libReady = container.libraryStorage?.ready !== false;
        if (!libReady) {
            const report = container.libraryStorage?.getLoadReport?.();
            const detail = Array.isArray(report?.errors) && report.errors.length
                ? report.errors.map((e) => e.error?.message || e.store).join('；')
                : '服务器库文件读取失败';
            safeToast(container.host, 'error', `库与配置未能加载：${detail}。已跳过内置数据写入，避免空数据覆盖。`);
            log.warn('skip seed: library storage not ready', { report });
        } else {
            try {
                const seedResult = await installSeedAssets({
                    repos: container.repos,
                    loadSettings: container.loadSettings,
                    saveSettings: (s) => container.settingsStore.save(s),
                    getContext,
                    ...(opts.seedOpts && typeof opts.seedOpts === 'object' ? opts.seedOpts : {}),
                });
                if (seedResult.errors?.length) {
                    log.warn('seed install reported errors', {
                        errors: seedResult.errors,
                        imported: seedResult.imported,
                    });
                }
            } catch (seedErr) {
                log.warn('seed install threw; continuing activate', {
                    message: seedErr instanceof Error ? seedErr.message : String(seedErr),
                });
            }
        }

        const regexResult = await container.host.ensureSlotRegexInstalled();
        if (regexResult && regexResult.ok === false) {
            safeToast(container.host, 'warning', formatUserMessage(regexResult));
        }

        const slotObserver = createSlotMountObserver({
            getChatRoot: () => (typeof document !== 'undefined'
                ? document.getElementById('chat')
                : null),
            mountSlot: (slotEl, messageId, slotId) => {
                void mountOneSlot(container, slotEl, messageId, slotId);
            },
        });
        slotObserver.start();
        runtime.slotObserver = slotObserver;
        if (typeof container.settingsStore.onChange === 'function') {
            const unsubScale = container.settingsStore.onChange(() => {
                for (const handle of runtime.slotWidgets.values()) {
                    try {
                        handle.refresh?.();
                    } catch {
                        // ignore
                    }
                }
            });
            rollback.push(() => {
                try {
                    unsubScale();
                } catch {
                    // ignore
                }
            });
        }
        const onSlotFrameMessage = (event) => {
            const data = event?.data;
            if (!data || data.source !== 'nai-dbgen' || data.action !== 'generate') {
                return;
            }
            const slotId = Number(data.slot);
            if (!Number.isInteger(slotId) || slotId < 1) {
                return;
            }
            const iframe = findHostIframe(event.source, document);
            const mes = iframe?.closest?.('.mes[mesid]');
            const messageId = Number(mes?.getAttribute?.('mesid'));
            if (!Number.isInteger(messageId) || messageId < 0) {
                return;
            }
            void container.useCases.renderSlot.execute(messageId, slotId, {});
        };
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            window.addEventListener('message', onSlotFrameMessage);
            rollback.push(() => window.removeEventListener('message', onSlotFrameMessage));
        }
        rollback.push(() => {
            try {
                slotObserver.stop();
            } catch {
                // ignore
            }
            runtime.slotObserver = null;
        });

        runtime.unsubDomReady = container.host.onMessageDomReady((messageEl, messageId) => {
            const c = liveContainer();
            if (!c) {
                return;
            }
            void warmupMessageRecords(c, messageId).then(() => {
                ensureFloorGenerateButton(messageEl, messageId, c);
                try {
                    runtime.slotObserver?.reconcile();
                } catch {
                    // ignore
                }
            });
        });
        rollback.push(() => {
            try {
                runtime.unsubDomReady?.();
            } catch {
                // ignore
            }
            runtime.unsubDomReady = null;
        });

        runtime.unsubChatChanged = container.host.onChatChanged(() => {
            for (const h of runtime.slotWidgets.values()) {
                try {
                    h.destroy();
                } catch {
                    // ignore
                }
            }
            runtime.slotWidgets.clear();
            recordCache.clear();
            slotMetaCache.clear();
            void (async () => {
                try {
                    if (typeof container.repos.slot.ensureLoaded === 'function') {
                        await container.repos.slot.ensureLoaded();
                    }
                } catch {
                    // ignore
                }
                try {
                    runtime.slotObserver?.reconcile();
                } catch {
                    // ignore
                }
            })();
        });
        rollback.push(() => {
            try {
                runtime.unsubChatChanged?.();
            } catch {
                // ignore
            }
            runtime.unsubChatChanged = null;
        });

        const unsubChatDeleted = container.host.onChatDeleted?.(async (chatFileName) => {
            try {
                const index = container.services?.chatIndex;
                if (!index || typeof index.findByChatFileName !== 'function') {
                    return;
                }
                const found = await index.findByChatFileName(String(chatFileName ?? ''));
                if (!found?.ok || !Array.isArray(found.value)) {
                    return;
                }
                for (const entry of found.value) {
                    if (typeof container.repos.slot.deleteSessionFile === 'function') {
                        await container.repos.slot.deleteSessionFile(entry.sessionId);
                    }
                }
            } catch {
                // ignore
            }
        });
        if (typeof unsubChatDeleted === 'function') {
            rollback.push(() => {
                try {
                    unsubChatDeleted();
                } catch {
                    // ignore
                }
            });
        }

        const unsubGroupDeleted = container.host.onGroupChatDeleted?.(async (groupChatId) => {
            try {
                const index = container.services?.chatIndex;
                if (!index || typeof index.findByChatFileName !== 'function') {
                    return;
                }
                const found = await index.findByChatFileName(String(groupChatId ?? ''));
                if (!found?.ok || !Array.isArray(found.value)) {
                    return;
                }
                for (const entry of found.value) {
                    if (typeof container.repos.slot.deleteSessionFile === 'function') {
                        await container.repos.slot.deleteSessionFile(entry.sessionId);
                    }
                }
            } catch {
                // ignore
            }
        });
        if (typeof unsubGroupDeleted === 'function') {
            rollback.push(() => {
                try {
                    unsubGroupDeleted();
                } catch {
                    // ignore
                }
            });
        }

        const unsubRenamed = container.host.onChatRenamed?.(async (info) => {
            try {
                const index = container.services?.chatIndex;
                if (!index || typeof index.findByChatFileName !== 'function') {
                    return;
                }
                const oldName = String(info?.oldFileName ?? '');
                const newName = String(info?.newFileName ?? '');
                if (!oldName || !newName) {
                    return;
                }
                const found = await index.findByChatFileName(oldName, {
                    avatarUrl: info?.avatarId ?? undefined,
                    groupId: info?.groupId ?? undefined,
                });
                if (!found?.ok) {
                    return;
                }
                for (const entry of found.value || []) {
                    await index.updateMeta(entry.sessionId, { chatFileName: newName });
                }
            } catch {
                // ignore
            }
        });
        if (typeof unsubRenamed === 'function') {
            rollback.push(() => {
                try {
                    unsubRenamed();
                } catch {
                    // ignore
                }
            });
        }

        runtime.unsubSlotRenderedCache = container.bus.on(APP_EVENTS.SLOT_RENDERED, (payload) => {
            if (payload?.chatId != null && payload.chatId !== container.host.getCurrentChatId()) return;
            if (payload?.record && payload.messageId != null && payload.slotId != null) {
                recordCache.set(recordKey(payload.messageId, payload.slotId), payload.record);
            }
        });
        rollback.push(() => {
            try {
                runtime.unsubSlotRenderedCache?.();
            } catch {
                // ignore
            }
            runtime.unsubSlotRenderedCache = null;
        });

        runtime.unsubSlotsWrittenCache = container.bus.on(APP_EVENTS.SLOTS_WRITTEN, (payload) => {
            if (!payload || !Array.isArray(payload.records)) {
                return;
            }
            for (const rec of payload.records) {
                if (rec && rec.messageId != null && rec.slotId != null) {
                    recordCache.set(recordKey(rec.messageId, rec.slotId), rec);
                }
            }
        });
        const offEdited = container.bus.on(APP_EVENTS.SLOTS_EDITED, (payload) => {
            if (payload.chatId !== container.host.getCurrentChatId()) return;
            const prefix = `${payload.messageId}::`;
            for (const key of recordCache.keys()) if (key.startsWith(prefix)) recordCache.delete(key);
            for (const key of slotMetaCache.keys()) if (key.startsWith(prefix)) slotMetaCache.delete(key);
            for (const [key, widget] of runtime.slotWidgets) {
                if (!key.startsWith(prefix)) continue;
                widget.destroy();
                runtime.slotWidgets.delete(key);
            }
            for (const record of payload.records) recordCache.set(recordKey(record.messageId, record.slotId), record);
            removeDeletedSlotElements(document, payload.messageId, payload.removedIds || []);
            container.host.rerenderMessage?.(payload.messageId);
        });
        runtime.editorCleanup = () => {
            offEdited();
        };
        rollback.push(() => {
            try {
                runtime.unsubSlotsWrittenCache?.();
            } catch {
                // ignore
            }
            runtime.unsubSlotsWrittenCache = null;
        });

        runtime.unsubUnmatched = container.bus.on(APP_EVENTS.TAG_RECALL_UNMATCHED, (payload) => {
            const keys = Array.isArray(payload?.unmatchedKeys) ? payload.unmatchedKeys : [];
            if (!keys.length) {
                return;
            }
            safeToast(container.host, 'warning', `标签召回未命中：${keys.join(', ')}`);
        });
        rollback.push(() => {
            try {
                runtime.unsubUnmatched?.();
            } catch {
                // ignore
            }
            runtime.unsubUnmatched = null;
        });

        runtime.unsubImageCacheTrimmed = container.bus.on(APP_EVENTS.IMAGE_CACHE_TRIMMED, (payload) => {
            const refs = Array.isArray(payload?.removedRefs)
                ? payload.removedRefs.map((r) => String(r))
                : [];
            if (!refs.length) {
                return;
            }
            const removed = new Set(refs);
            for (const [key, meta] of slotMetaCache.entries()) {
                if (!meta || typeof meta !== 'object') {
                    continue;
                }
                const cached = meta.cachedImageRef != null ? String(meta.cachedImageRef) : '';
                if (cached && removed.has(cached)) {
                    slotMetaCache.set(key, {
                        ...meta,
                        hasCachedImage: false,
                        cachedImageRef: null,
                    });
                }
            }
        });
        rollback.push(() => {
            try {
                runtime.unsubImageCacheTrimmed?.();
            } catch {
                // ignore
            }
            runtime.unsubImageCacheTrimmed = null;
        });

        // 可能失败的启动步骤放在斜杠注册之前（D56）
        container.services.autoTrigger.start();
        rollback.push(() => {
            try {
                container.services.autoTrigger.stop();
            } catch {
                // ignore
            }
        });

        startFloorBusyWatch(container);
        rollback.push(() => stopFloorBusyWatch());

        exposePublicApi(container);
        rollback.push(() => clearPublicApi());

        if (typeof globalThis[GENERATE_INTERCEPTOR_GLOBAL_NAME] !== 'function') {
            safeToast(container.host, 'warning', '发历史时隐藏生图标记未生效，请检查扩展配置');
        }

        // D56：斜杠放在所有可能失败步骤之后；回调仍活查 container 防 dispose 僵尸
        registerSlashCommands(container.host);
        installQuickReplyEntry();

        // 悬浮球：放在可能失败步骤之后；仍挂 rollback 防后续扩展踩坑
        mountFloatingBallUi();
        rollback.push(() => destroyFloatingBallUi());

        // 图片缓存上限裁剪：启动后一次，不阻塞、失败只记日志
        const trimSvc = container.services?.imageCacheTrim;
        if (trimSvc && typeof trimSvc.trim === 'function') {
            void Promise.resolve()
                .then(() => trimSvc.trim())
                .then((r) => {
                    if (r && r.ok === false) {
                        log.warn('image cache trim on activate failed', {
                            code: r.error?.code,
                            message: r.error?.message,
                        });
                    }
                })
                .catch((cause) => {
                    log.warn('image cache trim on activate threw', {
                        message: cause instanceof Error ? cause.message : String(cause),
                    });
                });
        }

        rollback.length = 0;
        setLoadBanner('酒馆数据库生图：已启动', 'ok');
    } catch (err) {
        const message = formatUserMessage(err);
        const host = runtime.container?.host;
        setLoadBanner(`酒馆数据库生图启动失败：${message}`, 'error');
        safeToast(host, 'error', `酒馆数据库生图启动失败：${message}`);

        for (let i = rollback.length - 1; i >= 0; i -= 1) {
            try {
                await rollback[i]();
            } catch {
                // ignore
            }
        }
        rollback.length = 0;
        await disposeInternal();
    } finally {
        runtime.activating = false;
    }
}

/**
 * @returns {Promise<void>}
 */
async function disposeInternal() {
    stopFloorBusyWatch();
    runtime.editorCleanup?.();
    runtime.editorCleanup = null;

    try {
        runtime.workbenchModal?.destroy();
    } catch {
        // ignore
    }
    runtime.workbenchModal = null;

    try {
        runtime.panelShell?.destroy();
    } catch {
        // ignore
    }
    runtime.panelShell = null;

    try {
        runtime.unsubUnmatched?.();
    } catch {
        // ignore
    }
    runtime.unsubUnmatched = null;

    try {
        runtime.unsubImageCacheTrimmed?.();
    } catch {
        // ignore
    }
    runtime.unsubImageCacheTrimmed = null;

    try {
        runtime.unsubSlotRenderedCache?.();
    } catch {
        // ignore
    }
    runtime.unsubSlotRenderedCache = null;

    try {
        runtime.unsubSlotsWrittenCache?.();
    } catch {
        // ignore
    }
    runtime.unsubSlotsWrittenCache = null;

    try {
        runtime.unsubDomReady?.();
    } catch {
        // ignore
    }
    runtime.unsubDomReady = null;

    try {
        runtime.unsubChatChanged?.();
    } catch {
        // ignore
    }
    runtime.unsubChatChanged = null;

    try {
        runtime.container?.services?.autoTrigger?.stop();
    } catch {
        // ignore
    }

    try {
        runtime.slotObserver?.stop();
    } catch {
        // ignore
    }
    runtime.slotObserver = null;

    for (const h of runtime.slotWidgets.values()) {
        try {
            h.destroy();
        } catch {
            // ignore
        }
    }
    runtime.slotWidgets.clear();
    recordCache.clear();
    slotMetaCache.clear();

    try {
        runtime.drawerHandle?.destroy();
    } catch {
        // ignore
    }
    runtime.drawerHandle = null;

    destroyFloatingBallUi();

    clearPublicApi();

    try {
        runtime.container?.dispose();
    } catch {
        // ignore
    }
    runtime.container = null;
    // slashRegistered 保持：宿主无卸载；回调活查 container===null →「未成功加载」

    try {
        if (typeof document !== 'undefined') {
            document.querySelectorAll(`[${FLOOR_BTN_ATTR}]`).forEach((el) => {
                try {
                    el.remove();
                } catch {
                    // ignore
                }
            });
        }
    } catch {
        // ignore
    }
}

/**
 * 插件停用：销毁 UI、取消订阅、释放 blob URL。须可重复调用。
 * @returns {Promise<void>}
 */
export async function dispose() {
    await disposeInternal();
}

/**
 * 测试用：读取当前运行时快照。
 * @returns {Readonly<RuntimeState>}
 */
export function _runtimeForTest() {
    return runtime;
}

/**
 * 测试用：读 recordCache。
 * @returns {Map<string, import('../domain/model/slot.js').SlotRecord>}
 */
export function _recordCacheForTest() {
    return recordCache;
}
