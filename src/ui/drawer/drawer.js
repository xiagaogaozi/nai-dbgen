/**
 * L5 UI · 酒馆设置抽屉内精简面板（高频开关与当前选择）。
 * 归属：W2-H 面板代理实现。W0 仅冻结签名。
 *
 * D60：外部改了激活项（管理台 / 空配置起步）后，须刷新全部 current-picker。
 * - 可选 deps.subscribeSettings(fn) → unsubscribe
 * - 无订阅时：指纹轮询 loadSettings（destroy 清 interval）
 * - 管理台关闭（dialog close 捕获）与 repos.onChanged 也会触发 refresh
 */

import { createNumberField, createTextarea, createToggle, createButton, createFieldGroup } from '../common/controls.js';
import {
    NAI_MODEL_OPTIONS,
    reconcileParamsForModel,
} from '../../domain/nai/param-options.js';
import { CONTEXT_BODY_PATTERN_HINT, normalizeContextBodyPattern } from '../../domain/blocks/context-body.js';
import { mountCurrentPicker } from '../common/current-picker.js';
import { safeImageUrl } from '../common/safe-url.js';
import { mergePluginSettings, isQuickConfigItemVisible } from '../../domain/model/plugin-settings.js';
import { llmConfigHasKey, naiConfigHasKey } from '../../domain/model/api-config.js';
import { pickAllowedSettingsPatch } from '../panels/_lib/library-logic.js';
import { el, setText } from '../panels/_lib/panel-kit.js';

/**
 * @typedef {import('../domain/model/plugin-settings.js').PluginSettings} PluginSettings
 */

/**
 * @typedef {object} DrawerDeps
 * @property {() => PluginSettings} loadSettings
 * @property {(settings: PluginSettings) => void} saveSettings
 * @property {() => void|Promise<void>} openManagementShell
 * @property {object} repos
 * @property {{
 *   urlOf: (ref: string|null|undefined, version?: string|number|null) => string|null,
 *   cardUrl: (item: object|null|undefined) => string|null,
 *   referenceUrl: (item: object|null|undefined) => string|null,
 * }} [artistFileUrl]
 *   画师串卡片图 URL（服务端文件 + ?v=）；有封面的 picker 必须注入。
 * @property {(fn: () => void) => () => void} [subscribeSettings]
 *   D60：外部设置变更时回调；未提供则退化为指纹轮询。
 * @property {(anyVisible: boolean) => void} [onVisibilityApplied]
 *   每次按 quickConfigVisibility 应用显隐后回调；参数为抽屉内是否还有可见项。
 */

/** 参与 D60 同步的激活项键（抽屉 picker 所依赖的） */
const ACTIVE_PICKER_KEYS = Object.freeze([
    'activeArtistId',
    'activeNaiConfigId',
    'recallLlmConfigId',
    'promptGenLlmConfigId',
    'activeImagegenPresetId',
    'activeRecallPresetId',
]);

/**
 * @param {PluginSettings|null|undefined} settings
 * @returns {string}
 */
function activePickerFingerprint(settings) {
    if (!settings || typeof settings !== 'object') {
        return '';
    }
    return ACTIVE_PICKER_KEYS.map((k) => String(/** @type {any} */ (settings)[k] ?? '')).join('\0');
}

/**
 * @param {Element} root 挂到 #extensions_settings2 内的容器
 * @param {DrawerDeps} deps
 * @returns {{ destroy: () => void, refresh: () => Promise<void> }}
 */
export function mountDrawer(root, deps) {
    if (!(root instanceof Element)) {
        throw new Error('mountDrawer: root must be an Element');
    }
    if (typeof deps?.loadSettings !== 'function' || typeof deps?.saveSettings !== 'function') {
        throw new Error('mountDrawer: loadSettings/saveSettings required');
    }

    const shell = el('div', 'nd-drawer nd-root');
    shell.id = 'nai-dbgen-drawer';

    const title = el('h3', 'nd-drawer__title');
    setText(title, '酒馆数据库生图');

    function load() {
        return deps.loadSettings();
    }

    /**
     * @param {object} partial
     */
    function patch(partial) {
        const allowed = pickAllowedSettingsPatch(partial);
        const next = mergePluginSettings(load(), /** @type {any} */ (allowed));
        deps.saveSettings(next);
        return next;
    }

    const current = load();
    const hideBall = createToggle({
        label: '隐藏悬浮球',
        hint: '隐藏后从快捷回复栏进入',
        checked: current.hideFloatingBall === true,
        onChange: (v) => patch({ hideFloatingBall: v }),
    });
    const contextN = createNumberField({
        label: '上下文楼数',
        value: current.contextWindowSize ?? 5,
        min: 1,
        max: 100,
        step: 1,
        onChange: (v) => patch({ contextWindowSize: v }),
    });
    const contextBodyPattern = createTextarea({
        label: '上下文正文正则',
        hint: CONTEXT_BODY_PATTERN_HINT,
        value: current.contextBodyPattern ?? '',
        rows: 2,
        onChange: (v) => {
            const next = String(v ?? '');
            if (next.trim() !== '' && normalizeContextBodyPattern(next) !== next) {
                return;
            }
            patch({ contextBodyPattern: next });
        },
    });
    const autoWrite = createToggle({
        label: '自动生成提示词',
        checked: current.autoWriteSlots === true,
        onChange: (v) => patch({ autoWriteSlots: v }),
    });
    const autoRender = createToggle({
        label: '自动出图',
        checked: current.autoRenderSlots === true,
        onChange: (v) => patch({ autoRenderSlots: v }),
    });
    const floorImageScale = createNumberField({
        label: '楼层图片显示比例（%）',
        value: current.floorImageScale ?? 100,
        min: 20,
        max: 100,
        step: 5,
        onChange: (v) => {
            if (!Number.isInteger(v) || v < 20 || v > 100) return;
            patch({ floorImageScale: v });
        },
    });
    const naiParallel = createToggle({
        label: '并行出图',
        checked: current.naiParallel === true,
        onChange: (v) => patch({ naiParallel: v }),
    });
    const includeWorldInfo = createToggle({
        label: '传入世界书',
        hint: '打开后，接口写提示词和直接楼内生图带上酒馆扫描到的整段世界书',
        checked: current.includeWorldInfo === true,
        onChange: (v) => {
            if (v) {
                includeWorldInfoCharacters.setValue(false);
            }
            patch({
                includeWorldInfo: v,
                ...(v ? { includeWorldInfoCharacters: false } : {}),
            });
        },
    });
    const includeWorldInfoCharacters = createToggle({
        label: '传入世界书角色',
        hint: '打开后，只带上条目标题包含调用方关键字的已开启条目',
        checked: current.includeWorldInfoCharacters === true,
        onChange: (v) => {
            if (v) {
                includeWorldInfo.setValue(false);
            }
            patch({
                includeWorldInfoCharacters: v,
                ...(v ? { includeWorldInfo: false } : {}),
            });
        },
    });
    const omitRecentSlots = createToggle({
        label: '不发近期生图记录',
        hint: '打开后，接口写提示词和直接楼内生图都不带近期生图记录',
        checked: current.omitRecentSlots === true,
        onChange: (v) => patch({ omitRecentSlots: v }),
    });

    const pickers = el('div', 'nd-drawer__pickers');
    const repos = deps.repos || {};

    /**
     * 画师串封面：经注入的 artistFileUrl.cardUrl（服务器文件 + ?v=），再过白名单。
     * @param {object|null|undefined} item
     * @returns {string|null}
     */
    function resolveArtistCover(item) {
        const resolver = deps.artistFileUrl;
        if (!resolver || typeof resolver.cardUrl !== 'function') {
            return null;
        }
        return Promise.resolve(resolver.cardUrl(item)).then((url) => safeImageUrl(url));
    }

    /**
     * @param {string} label
     * @param {() => Promise<object[]>} listFn
     * @param {() => string|null} getId
     * @param {(id: string|null) => void} setId
     * @param {{
     *   cover?: boolean,
     *   resolveCover?: (item: object|null|undefined) => Promise<string|null>|string|null,
 *   getLabel?: (item: object) => string,
 *   modelTagFilter?: boolean,
 * }} [pickerOpts]
 */
    function addPicker(id, label, listFn, getId, setId, pickerOpts) {
        const wrap = el('div', 'nd-drawer__picker');
        pickerWraps.set(id, wrap);
        const lab = el('span', 'nd-field__label');
        setText(lab, label);
        const host = el('div');
        wrap.append(lab, host);
        pickers.appendChild(wrap);
        return mountCurrentPicker(host, {
            list: listFn,
            getActiveId: getId,
            setActiveId: setId,
            cover: pickerOpts?.cover === true,
            resolveCover: pickerOpts?.resolveCover,
            getLabel: pickerOpts?.getLabel,
            modelTagFilter: pickerOpts?.modelTagFilter === true,
            // 选择器创建时抽屉尚未挂载，用已挂载的 root 查找悬浮窗。
            portalPanel: root.closest?.('.nd-fab-panel') || null,
        });
    }

    /**
     * @param {object|null|undefined} item
     * @param {(item: object) => boolean} hasKey
     * @returns {string}
     */
    function configLabelWithKey(item, hasKey) {
        if (!item) return '';
        const name = String(item.name ?? item.id ?? '');
        if (!hasKey(item)) {
            return name ? `${name} · 未填 Key` : '未填 Key';
        }
        return name;
    }

    /** @type {{ destroy: () => void, refresh: () => Promise<void> }[]} */
    const pickerHandles = [];
    /** @type {Map<string, HTMLElement>} 快速配置显隐 id → picker 外层 */
    const pickerWraps = new Map();

    if (repos.artist) {
        pickerHandles.push(addPicker(
            'artist', '当前画师串',
            async () => {
                const r = await repos.artist.list();
                return r?.ok ? r.value : [];
            },
            () => load().activeArtistId,
            (id) => patch({ activeArtistId: id }),
            { cover: true, resolveCover: resolveArtistCover, modelTagFilter: true },
        ));
    }
    if (repos.naiConfig) {
        pickerHandles.push(addPicker(
            'nai', '当前 NAI',
            async () => {
                const r = await repos.naiConfig.list();
                return r?.ok ? r.value : [];
            },
            () => load().activeNaiConfigId,
            (id) => patch({ activeNaiConfigId: id }),
            { cover: false, getLabel: (item) => configLabelWithKey(item, naiConfigHasKey) },
        ));
    }
    // 0.2.49：生图模型改用和其他选择器同一个 current-picker（同控件、同下拉）
    const modelHandle = addPicker(
        'naiModel', '生图模型',
        async () => NAI_MODEL_OPTIONS.map((o) => ({ id: o.value, name: o.label })),
        () => load().naiParams?.model ?? null,
        (id) => {
            if (!id) return;
            const cur = load().naiParams || {};
            if (cur.model === id) return;
            patch({ naiParams: reconcileParamsForModel(cur, id).params });
        },
        { cover: false },
    );
    pickerHandles.push(modelHandle);
    if (repos.llmConfig) {
        pickerHandles.push(addPicker(
            'recallLlm', '召回 LLM',
            async () => {
                const r = await repos.llmConfig.list();
                return r?.ok ? r.value : [];
            },
            () => load().recallLlmConfigId,
            (id) => patch({ recallLlmConfigId: id }),
            { cover: false, getLabel: (item) => configLabelWithKey(item, llmConfigHasKey) },
        ));
        pickerHandles.push(addPicker(
            'promptLlm', '提示词 LLM',
            async () => {
                const r = await repos.llmConfig.list();
                return r?.ok ? r.value : [];
            },
            () => load().promptGenLlmConfigId,
            (id) => patch({ promptGenLlmConfigId: id }),
            { cover: false, getLabel: (item) => configLabelWithKey(item, llmConfigHasKey) },
        ));
    }
    if (repos.preset) {
        pickerHandles.push(addPicker(
            'imagegenPreset', '生图预设',
            async () => {
                const r = await repos.preset.list();
                const items = r?.ok ? r.value : [];
                return (items || []).filter((p) => p && p.kind === 'imagegen');
            },
            () => load().activeImagegenPresetId,
            (id) => patch({ activeImagegenPresetId: id }),
            { cover: false },
        ));
        pickerHandles.push(addPicker(
            'recallPreset', '召回预设',
            async () => {
                const r = await repos.preset.list();
                const items = r?.ok ? r.value : [];
                return (items || []).filter((p) => p && p.kind === 'recall');
            },
            () => load().activeRecallPresetId,
            (id) => patch({ activeRecallPresetId: id }),
            { cover: false },
        ));
    }

    let destroyed = false;
    /** @type {Promise<void>|null} */
    let refreshInflight = null;

    /**
     * 重新同步全部 picker（封面 + 关闭态搜索框文案）。
     * @returns {Promise<void>}
     */
    async function refreshAllPickers() {
        if (destroyed) return;
        const run = Promise.all(pickerHandles.map((h) => h.refresh())).then(() => undefined);
        refreshInflight = run;
        try {
            await run;
        } finally {
            if (refreshInflight === run) {
                refreshInflight = null;
            }
        }
    }

    const openBtn = createButton({
        label: '打开管理台',
        variant: 'primary',
        onClick: () => {
            if (typeof deps.openManagementShell !== 'function') {
                return;
            }
            // 管理台打开后 / 关闭后都尝试刷新：面板内「设为当前」会改 settings
            void Promise.resolve(deps.openManagementShell())
                .catch(() => undefined)
                .then(() => refreshAllPickers());
        },
    });

    const group = createFieldGroup({
        children: [hideBall.el, contextN.el, contextBodyPattern.el, floorImageScale.el, autoWrite.el, autoRender.el, naiParallel.el, includeWorldInfo.el, includeWorldInfoCharacters.el, omitRecentSlots.el],
    });

    /** 快速配置显隐 id → 开关行 */
    const switchItems = new Map([
        ['hideFloatingBall', hideBall.el],
        ['contextWindowSize', contextN.el],
        ['contextBodyPattern', contextBodyPattern.el],
        ['floorImageScale', floorImageScale.el],
        ['autoWriteSlots', autoWrite.el],
        ['autoRenderSlots', autoRender.el],
        ['naiParallel', naiParallel.el],
        ['includeWorldInfo', includeWorldInfo.el],
        ['includeWorldInfoCharacters', includeWorldInfoCharacters.el],
        ['omitRecentSlots', omitRecentSlots.el],
    ]);

    /**
     * 按 quickConfigVisibility 切换各项 hidden；整组都隐藏时隐藏整组。
     */
    function applyVisibility() {
        const s = load();
        let anySwitch = false;
        for (const [id, node] of switchItems) {
            const on = isQuickConfigItemVisible(s, id);
            node.hidden = !on;
            if (on) anySwitch = true;
        }
        group.el.hidden = !anySwitch;
        let anyPicker = false;
        for (const [id, node] of pickerWraps) {
            const on = isQuickConfigItemVisible(s, id);
            node.hidden = !on;
            if (on) anyPicker = true;
        }
        pickers.hidden = !anyPicker;
        hideBall.setValue(s.hideFloatingBall === true);
        if (typeof deps.onVisibilityApplied === 'function') {
            deps.onVisibilityApplied(anySwitch || anyPicker);
        }
    }

    shell.append(title, group.el, pickers, openBtn);
    root.appendChild(shell);
    applyVisibility();

    /** @type {Array<() => void>} */
    const cleanups = [];

    // —— D60：设置变更订阅（或指纹轮询兜底） ——
    let lastFp = activePickerFingerprint(load());

    /**
     * @returns {void}
     */
    function onSettingsMaybeChanged() {
        if (destroyed) return;
        applyVisibility();
        // 模型变化不改指纹，单独刷新模型选择器
        void modelHandle.refresh();
        const nextFp = activePickerFingerprint(load());
        if (nextFp === lastFp) return;
        lastFp = nextFp;
        void refreshAllPickers();
    }

    if (typeof deps.subscribeSettings === 'function') {
        const unsub = deps.subscribeSettings(() => {
            onSettingsMaybeChanged();
        });
        if (typeof unsub === 'function') {
            cleanups.push(unsub);
        }
    } else {
        // 无外部订阅时：轻量轮询 loadSettings，覆盖「空配置起步」等外部直写
        const timer = setInterval(onSettingsMaybeChanged, 400);
        cleanups.push(() => clearInterval(timer));
    }

    // 管理台关闭（原生 dialog close）→ 刷新
    /**
     * @param {Event} event
     */
    function onDialogClose(event) {
        if (destroyed) return;
        const target = event.target;
        if (!(target instanceof HTMLDialogElement)) return;
        // 抽屉自身不在 dialog 内；任意管理台 dialog 关闭都跟一次
        lastFp = activePickerFingerprint(load());
        void refreshAllPickers();
    }
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        document.addEventListener('close', onDialogClose, true);
        cleanups.push(() => document.removeEventListener('close', onDialogClose, true));
    }

    // 库列表变更 → picker 候选项可能变了
    for (const key of ['artist', 'naiConfig', 'llmConfig', 'preset']) {
        const repo = repos[key];
        if (repo && typeof repo.onChanged === 'function') {
            const unsub = repo.onChanged(() => {
                if (destroyed) return;
                void refreshAllPickers();
            });
            if (typeof unsub === 'function') {
                cleanups.push(unsub);
            }
        }
    }

    return {
        refresh: () => refreshAllPickers(),
        destroy() {
            if (destroyed) return;
            destroyed = true;
            for (const fn of cleanups) {
                try {
                    fn();
                } catch {
                    // ignore
                }
            }
            cleanups.length = 0;
            for (const h of pickerHandles) h.destroy();
            hideBall.destroy();
            contextN.destroy();
            contextBodyPattern.destroy();
            floorImageScale.destroy();
            autoWrite.destroy();
            autoRender.destroy();
            naiParallel.destroy();
            includeWorldInfo.destroy();
            includeWorldInfoCharacters.destroy();
            omitRecentSlots.destroy();
            group.destroy();
            shell.remove();
        },
    };
}
