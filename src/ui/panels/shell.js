/**
 * L5 UI · 管理台 Popup 外壳 + 标签页路由。
 * 归属：W2-H 面板代理实现。W0 仅冻结签名。
 *
 * 生成工作台是其中一个标签：首次进入才挂载，切走只隐藏不销毁（保留进行中的请求与草稿），
 * 管理台关闭时才销毁。其余标签切换即销毁。
 */

import { openModal } from '../common/modal.js';
import { createButton } from '../common/controls.js';
import { mountCharacterPanel } from './character/character-panel.js';
import { mountTagPanel } from './tag/tag-panel.js';
import { mountArtistPanel } from './artist/artist-panel.js';
import { mountApiConfigPanel } from './api-config/api-config-panel.js';
import { mountPresetPanel } from './preset/preset-panel.js';
import { mountPromptsPanel } from './prompts/prompts-panel.js';
import { mountTriggerPanel } from './trigger/trigger-panel.js';
import { mountNaiParamsPanel } from './nai-params/nai-params-panel.js';
import { mountStoragePanel } from './storage/storage-panel.js';
import { mountDebugPanel } from './debug/debug-panel.js';
import { mountWorkbench } from '../workbench/workbench.js';
import { createThemeToggle } from '../common/theme.js';
import { settingsApi } from './_lib/panel-kit.js';

/**
 * @typedef {object} PanelShellDeps
 * @property {import('../../ports/host.port.js').HostPort} host
 * @property {object} repos
 * @property {object} services
 * @property {object} [workbenchDeps] mountWorkbench 的依赖；缺省时工作台标签显示不可用
 */

/** 工作台标签 id；入口按此直达工作台。 */
export const WORKBENCH_TAB_ID = 'workbench';

/** 上次停留的标签。 */
export const LAST_TAB_STORAGE_KEY = 'nai-dbgen:management-last-tab';

/**
 * @param {Element} root
 * @param {object} deps
 * @returns {{ destroy: () => void }}
 */
function mountWorkbenchTab(root, deps) {
    if (!deps?.workbenchDeps) {
        const note = document.createElement('p');
        note.className = 'nd-muted';
        note.textContent = '生成工作台不可用';
        root.appendChild(note);
        return { destroy: () => note.remove() };
    }
    return mountWorkbench(root, deps.workbenchDeps);
}

/** @type {{ id: string, label: string, keepAlive?: boolean, mount: (root: Element, deps: object) => { destroy: () => void, onShow?: () => void } }[]} */
const TABS = [
    { id: 'character', label: '角色库', mount: mountCharacterPanel },
    { id: 'tag', label: '标签库', mount: mountTagPanel },
    { id: 'artist', label: '画师串库', keepAlive: true, mount: mountArtistPanel },
    { id: 'api', label: 'API 库', mount: mountApiConfigPanel },
    { id: 'preset', label: '预设', mount: mountPresetPanel },
    { id: 'trigger', label: '常规设置', mount: mountTriggerPanel },
    { id: 'naiParams', label: '出图参数', mount: mountNaiParamsPanel },
    { id: WORKBENCH_TAB_ID, label: '生成工作台', keepAlive: true, mount: mountWorkbenchTab },
    { id: 'prompts', label: '生图提示词', mount: mountPromptsPanel },
    { id: 'storage', label: '存储管理', mount: mountStoragePanel },
    { id: 'debug', label: '解析调试', mount: mountDebugPanel },
];

/** @returns {string|null} */
function readLastTab() {
    try {
        return globalThis.localStorage?.getItem(LAST_TAB_STORAGE_KEY) ?? null;
    } catch {
        return null;
    }
}

/** @param {string} tabId */
function writeLastTab(tabId) {
    try {
        globalThis.localStorage?.setItem(LAST_TAB_STORAGE_KEY, tabId);
    } catch {
        // 隐私模式等写不进就算了
    }
}

/**
 * 打开管理台；返回句柄以便 dispose 时关闭。
 * @param {PanelShellDeps} deps
 * @param {string} [initialTab] 指定则直达；缺省打开上次停留的标签
 * @returns {Promise<{ destroy: () => void }>}
 */
export async function openPanelShell(deps, initialTab) {
    const shell = document.createElement('div');
    shell.className = 'nd-shell nd-root';
    // D52：作用域根用 class .nd-root，不再赋 #nai-dbgen-root id
    const root = document.createElement('div');
    root.className = 'nd-root';
    root.appendChild(shell);

    const tabBar = document.createElement('div');
    tabBar.className = 'nd-shell__tabs';
    tabBar.setAttribute('role', 'tablist');

    const body = document.createElement('div');
    body.className = 'nd-shell__body';

    shell.append(tabBar, body);

    /** @type {{ destroy: () => void }|null} 非常驻标签的当前实例 */
    let activePanel = null;
    /** @type {HTMLElement|null} */
    let activePanelRoot = null;
    /** @type {Map<string, { root: HTMLElement, handle: { destroy: () => void } }>} 常驻标签实例 */
    const keptPanels = new Map();

    const isKnown = (id) => TABS.some((t) => t.id === id);
    const lastTab = readLastTab();
    /** @type {string} */
    let current = isKnown(initialTab)
        ? String(initialTab)
        : (isKnown(lastTab) ? String(lastTab) : TABS[0].id);
    /** @type {HTMLButtonElement[]} */
    const tabButtons = [];

    const panelDeps = {
        ...deps,
        async importToWorkbench(payload) {
            activate(WORKBENCH_TAB_ID);
            const handle = keptPanels.get(WORKBENCH_TAB_ID)?.handle;
            if (!handle?.importFromPanel) throw new Error('生成工作台不可用');
            return handle.importFromPanel(payload);
        },
    };

    /**
     * @param {string} tabId
     */
    function activate(tabId) {
        const tab = TABS.find((t) => t.id === tabId) || TABS[0];
        current = tab.id;
        writeLastTab(current);
        for (const btn of tabButtons) {
            const on = btn.dataset.tab === current;
            btn.classList.toggle('is-active', on);
            btn.setAttribute('aria-selected', on ? 'true' : 'false');
        }
        activePanel?.destroy();
        activePanel = null;
        activePanelRoot?.remove();
        activePanelRoot = null;
        for (const [id, kept] of keptPanels) {
            kept.root.hidden = id !== current;
        }
        if (tab.keepAlive) {
            if (!keptPanels.has(tab.id)) {
                const panelRoot = document.createElement('div');
                panelRoot.className = `nd-shell__panel nd-shell__panel--${tab.id}`;
                body.appendChild(panelRoot);
                keptPanels.set(tab.id, { root: panelRoot, handle: tab.mount(panelRoot, panelDeps) });
            } else {
                const kept = keptPanels.get(tab.id);
                try {
                    kept?.handle?.onShow?.();
                } catch {
                    // ignore
                }
            }
            return;
        }
        const panelRoot = document.createElement('div');
        panelRoot.className = `nd-shell__panel nd-shell__panel--${tab.id}`;
        body.appendChild(panelRoot);
        activePanelRoot = panelRoot;
        activePanel = tab.mount(panelRoot, panelDeps);
    }

    for (const tab of TABS) {
        const btn = createButton({
            label: tab.label,
            variant: 'ghost',
            onClick: () => activate(tab.id),
        });
        btn.classList.add('nd-shell__tab');
        btn.dataset.tab = tab.id;
        btn.setAttribute('role', 'tab');
        tabBar.appendChild(btn);
        tabButtons.push(btn);
    }

    activate(current);

    let destroyed = false;
    /** 只销毁面板（含常驻工作台）；弹窗由调用方或用户关闭。 */
    function destroyPanels() {
        activePanel?.destroy();
        activePanel = null;
        for (const kept of keptPanels.values()) {
            try {
                kept.handle.destroy();
            } catch {
                // ignore
            }
        }
        keptPanels.clear();
    }

    const modal = await openModal(
        { host: deps?.host },
        {
            title: '酒馆数据库生图',
            element: root,
            dialogClass: 'nd-manager-popup',
            wide: true,
            large: true,
            allowVerticalScrolling: true,
        },
    );

    // 用户点 × / 按 Esc 关闭：同样销毁面板，中止工作台未完成请求
    const dialog = typeof root.closest === 'function' ? root.closest('dialog') : null;
    // 0.2.45：夜间模式切换钮放在 × 左边
    const header = dialog?.querySelector?.('.nd-popup-header');
    if (header) {
        const settings = settingsApi(deps);
        const toggle = createThemeToggle({
            getMode: () => settings.load()?.themeMode,
            setMode: (mode) => settings.patch({ themeMode: mode }),
        });
        const closeBtn = header.querySelector?.('.nd-native-dialog__close');
        if (closeBtn && closeBtn.parentNode === header && typeof header.insertBefore === 'function') {
            header.insertBefore(toggle, closeBtn);
        } else {
            header.appendChild?.(toggle);
        }
    }
    const onDialogClose = () => {
        if (destroyed) return;
        destroyed = true;
        destroyPanels();
    };
    dialog?.addEventListener('close', onDialogClose, { once: true });

    return {
        /**
         * 切到指定标签（已打开时复用）。
         * @param {string} tabId
         */
        activate(tabId) {
            if (!destroyed && isKnown(tabId)) activate(tabId);
        },
        isOpen() {
            return !destroyed;
        },
        destroy() {
            if (destroyed) return;
            destroyed = true;
            dialog?.removeEventListener('close', onDialogClose);
            destroyPanels();
            modal.destroy();
        },
    };
}
