/**
 * L5 UI · 常规设置（上下文楼数、自动开关、楼层生图行为、快捷配置显隐）管理面板。
 * 4.13 出图参数在 0.2.45 拆到「出图参数」页（nai-params-panel.js）。
 * 归属：W2-H 面板代理实现。W0 仅冻结签名。
 * 键名严格按 D8；4.13 控件默认值一律取自 defaultNaiParams（D47）。
 */

import {
    createNumberField,
    createToggle,
    createCheckbox,
    createFieldGroup,
    createInlineError,
    createTextarea,
} from '../../common/controls.js';
import { CONTEXT_BODY_PATTERN_HINT, normalizeContextBodyPattern } from '../../../domain/blocks/context-body.js';
import { QUICK_CONFIG_ITEMS, isQuickConfigItemVisible } from '../../../domain/model/plugin-settings.js';
import { el, settingsApi } from '../_lib/panel-kit.js';

/**
 * @param {Element} root
 * @param {object} deps repos / services / host / bus
 * @returns {{ destroy: () => void }}
 */
export function mountTriggerPanel(root, deps) {
    if (!(root instanceof Element)) {
        throw new Error('mountTriggerPanel: root must be an Element');
    }

    const settings = settingsApi(deps);
    const current = settings.load();

    const shell = el('div', 'nd-panel nd-panel--trigger');
    const patternErr = createInlineError();

    /** 改完立即存（0.2.43 删掉了「保存」按钮）。 */
    const save = (partial) => settings.patch(partial);
    /** 数字框：输入中途的空值 / 越界值不存，等用户打完。 */
    const saveNumber = (key, min, max) => (n) => {
        if (!Number.isFinite(n) || n < min || n > max) return;
        save({ [key]: n });
    };

    const hideBall = createToggle({
        label: '隐藏悬浮球',
        hint: '隐藏后从快捷回复栏进入',
        checked: current.hideFloatingBall === true,
        onChange: (v) => save({ hideFloatingBall: v }),
    });
    const enableTagMarket = createToggle({
        label: '启用标签超市',
        hint: '开启后在生成工作台显示；展开后才加载标签',
        checked: current.enableTagMarket === true,
        onChange: (v) => save({ enableTagMarket: v }),
    });
    const contextN = createNumberField({
        label: '上下文楼数',
        value: current.contextWindowSize ?? 5,
        min: 1,
        max: 100,
        step: 1,
        onChange: saveNumber('contextWindowSize', 1, 100),
    });
    const contextBodyPattern = createTextarea({
        label: '上下文正文正则',
        hint: CONTEXT_BODY_PATTERN_HINT,
        value: current.contextBodyPattern ?? '',
        rows: 2,
        onChange: (v) => {
            if (v.trim() !== '' && normalizeContextBodyPattern(v) !== v) {
                patternErr.setMessage('正文正则写错了，未保存');
                return;
            }
            patternErr.clear();
            save({ contextBodyPattern: v });
        },
    });
    const autoWrite = createToggle({
        label: '自动生成提示词',
        hint: '点楼层生图后自动写 slot，无需再点「生成提示词」',
        checked: current.autoWriteSlots === true,
        onChange: (v) => save({ autoWriteSlots: v }),
    });
    const autoRender = createToggle({
        label: '自动出图',
        hint: '写完 slot 后自动出图；已生过的不会重出',
        checked: current.autoRenderSlots === true,
        onChange: (v) => save({ autoRenderSlots: v }),
    });
    const floorImageScale = createNumberField({
        label: '楼层图片显示比例（%）',
        value: current.floorImageScale ?? 100,
        min: 20,
        max: 100,
        step: 5,
        onChange: saveNumber('floorImageScale', 20, 100),
    });
    const naiParallel = createToggle({
        label: '并行出图',
        hint: '关闭时一张完成再请求下一张',
        checked: current.naiParallel === true,
        onChange: (v) => save({ naiParallel: v }),
    });
    const includeWorldInfo = createToggle({
        label: '传入世界书',
        hint: '打开后，接口写提示词和直接楼内生图带上酒馆扫描到的整段世界书',
        checked: current.includeWorldInfo === true,
        onChange: (v) => {
            if (v) includeWorldInfoCharacters.setValue(false);
            save(v ? { includeWorldInfo: true, includeWorldInfoCharacters: false } : { includeWorldInfo: false });
        },
    });
    const includeWorldInfoCharacters = createToggle({
        label: '传入世界书角色',
        hint: '打开后，只带上条目标题包含调用方关键字的已开启条目',
        checked: current.includeWorldInfoCharacters === true,
        onChange: (v) => {
            if (v) includeWorldInfo.setValue(false);
            save(v ? { includeWorldInfoCharacters: true, includeWorldInfo: false } : { includeWorldInfoCharacters: false });
        },
    });
    const omitRecentSlots = createToggle({
        label: '不发近期生图记录',
        hint: '打开后，接口写提示词和直接楼内生图都不带近期生图记录',
        checked: current.omitRecentSlots === true,
        onChange: (v) => save({ omitRecentSlots: v }),
    });
    const doubleTap = createToggle({
        label: '双击图片重新生成',
        hint: '打开后有图的位置不显示重新生成按钮，双击图片重新生成',
        checked: current.slotDoubleTapRegenerate === true,
        onChange: (v) => save({ slotDoubleTapRegenerate: v }),
    });
    const confirmRegen = createToggle({
        label: '重新生成前确认',
        hint: '双击重新生成前先弹窗确认',
        checked: current.confirmSlotRegenerate !== false,
        onChange: (v) => save({ confirmSlotRegenerate: v }),
    });
    const maxImages = createNumberField({
        label: '每层最多生图数（-1 不限）',
        value: current.maxImagesPerFloor ?? -1,
        min: -1,
        max: 99,
        step: 1,
        onChange: (n) => {
            if (!Number.isInteger(n) || n === 0 || n < -1) return;
            save({ maxImagesPerFloor: n });
        },
    });
    const saveMatchDefaults = () => save({
        matchDefaults: {
            caseSensitive: caseSensitive.getValue(),
            matchWholeWords: wholeWords.getValue(),
        },
    });
    const caseSensitive = createCheckbox({
        label: '关键字默认区分大小写',
        checked: current.matchDefaults?.caseSensitive === true,
        onChange: saveMatchDefaults,
    });
    const wholeWords = createCheckbox({
        label: '关键字默认全词匹配',
        checked: current.matchDefaults?.matchWholeWords === true,
        onChange: saveMatchDefaults,
    });

    const basic = createFieldGroup({
        title: '运行开关',
        children: [hideBall.el, enableTagMarket.el, contextN.el, contextBodyPattern.el, patternErr.el, floorImageScale.el, maxImages.el, autoWrite.el, autoRender.el, naiParallel.el, doubleTap.el, confirmRegen.el, includeWorldInfo.el, includeWorldInfoCharacters.el, omitRecentSlots.el, caseSensitive.el, wholeWords.el],
    });

    // 快速配置悬浮窗内容显隐器：眼睛图标列表，点一下立即存
    const visList = el('div', 'nd-quick-vis');
    /** @type {(() => void)[]} */
    const visCleanups = [];
    for (const item of QUICK_CONFIG_ITEMS) {
        const row = el('div', 'nd-quick-vis__row');
        const name = el('span', 'nd-quick-vis__label');
        name.textContent = item.label;
        const btn = /** @type {HTMLButtonElement} */ (el('button', 'nd-quick-vis__eye'));
        btn.type = 'button';
        const icon = el('i', 'fa-solid');
        btn.appendChild(icon);
        const paint = (on) => {
            row.classList.toggle('is-hidden', !on);
            icon.className = on ? 'fa-solid fa-eye' : 'fa-solid fa-eye-slash';
            btn.setAttribute('aria-pressed', on ? 'true' : 'false');
            btn.title = on ? '显示中，点击隐藏' : '已隐藏，点击显示';
            btn.setAttribute('aria-label', `${item.label}：${on ? '显示' : '隐藏'}`);
        };
        paint(isQuickConfigItemVisible(current, item.id));
        const onClick = () => {
            const latest = settings.load();
            const next = !isQuickConfigItemVisible(latest, item.id);
            save({ quickConfigVisibility: { ...(latest.quickConfigVisibility || {}), [item.id]: next } });
            paint(next);
        };
        btn.addEventListener('click', onClick);
        visCleanups.push(() => btn.removeEventListener('click', onClick));
        row.append(name, btn);
        visList.appendChild(row);
    }
    const visGroup = createFieldGroup({
        title: '快速配置悬浮窗内容',
        children: [visList],
    });

    shell.append(basic.el, visGroup.el);
    root.appendChild(shell);

    let destroyed = false;
    return {
        destroy() {
            if (destroyed) return;
            destroyed = true;
            patternErr.destroy();
            hideBall.destroy();
            enableTagMarket.destroy();
            contextN.destroy();
            contextBodyPattern.destroy();
            floorImageScale.destroy();
            autoWrite.destroy();
            autoRender.destroy();
            naiParallel.destroy();
            includeWorldInfo.destroy();
            includeWorldInfoCharacters.destroy();
            omitRecentSlots.destroy();
            doubleTap.destroy();
            confirmRegen.destroy();
            maxImages.destroy();
            caseSensitive.destroy();
            wholeWords.destroy();
            basic.destroy();
            for (const fn of visCleanups) fn();
            visGroup.destroy();
            shell.remove();
        },
    };
}
