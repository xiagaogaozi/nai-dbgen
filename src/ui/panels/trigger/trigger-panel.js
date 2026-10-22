/**
 * L5 UI · 运行配置（上下文楼数、自动开关、4.13 参数） 管理面板。
 * 归属：W2-H 面板代理实现。W0 仅冻结签名。
 * 键名严格按 D8；4.13 控件默认值一律取自 defaultNaiParams（D47）。
 */

import {
    createNumberField,
    createToggle,
    createCheckbox,
    createFieldGroup,
    createDetails,
    createButton,
    createInlineError,
} from '../../common/controls.js';
import { createNaiParamsForm } from '../../common/nai-params-form.js';
import { defaultNaiParams } from '../../../domain/model/nai-params.js';
import { pickAllowedSettingsPatch, applyFormFields } from '../_lib/library-logic.js';
import { el, settingsApi, toast } from '../_lib/panel-kit.js';

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
    const host = deps?.host;
    const current = settings.load();
    const defaults = defaultNaiParams();
    const nai = applyFormFields(defaults, current.naiParams || {});

    const shell = el('div', 'nd-panel nd-panel--trigger');
    const err = createInlineError();

    const contextN = createNumberField({
        label: '上下文楼数',
        value: current.contextWindowSize ?? 5,
        min: 1,
        max: 100,
        step: 1,
    });
    const autoWrite = createToggle({
        label: '自动生成提示词',
        hint: '点楼层生图后自动写 slot，无需再点「生成提示词」',
        checked: current.autoWriteSlots === true,
    });
    const autoRender = createToggle({
        label: '自动出图',
        hint: '写完 slot 后自动出图；已生过的不会重出',
        checked: current.autoRenderSlots === true,
    });
    const floorImageScale = createNumberField({
        label: '楼层图片显示比例（%）',
        value: current.floorImageScale ?? 100,
        min: 20,
        max: 100,
        step: 5,
    });
    const naiParallel = createToggle({
        label: '并行出图',
        hint: '关闭时一张完成再请求下一张',
        checked: current.naiParallel === true,
    });
    const includeWorldInfo = createToggle({
        label: '传入世界书',
        hint: '打开后，接口写提示词和直接楼内生图都会带上世界书',
        checked: current.includeWorldInfo === true,
    });
    const caseSensitive = createCheckbox({
        label: '关键字默认区分大小写',
        checked: current.matchDefaults?.caseSensitive === true,
    });
    const wholeWords = createCheckbox({
        label: '关键字默认全词匹配',
        checked: current.matchDefaults?.matchWholeWords === true,
    });

    const paramsForm = createNaiParamsForm(nai);

    const basic = createFieldGroup({
        title: '运行开关',
        children: [contextN.el, floorImageScale.el, autoWrite.el, autoRender.el, naiParallel.el, includeWorldInfo.el, caseSensitive.el, wholeWords.el],
    });
    const naiGroup = createDetails({
        summary: '出图参数',
        open: true,
        body: [paramsForm.el],
    });

    const saveBtn = createButton({
        label: '保存',
        variant: 'primary',
        onClick: () => {
            err.clear();
            const notices = paramsForm.consumeNotices();
            const patch = pickAllowedSettingsPatch({
                contextWindowSize: contextN.getValue(),
                floorImageScale: floorImageScale.getValue(),
                autoWriteSlots: autoWrite.getValue(),
                autoRenderSlots: autoRender.getValue(),
                naiParallel: naiParallel.getValue(),
                includeWorldInfo: includeWorldInfo.getValue(),
                matchDefaults: {
                    caseSensitive: caseSensitive.getValue(),
                    matchWholeWords: wholeWords.getValue(),
                },
                naiParams: paramsForm.getValue(),
            });
            settings.patch(patch);
            if (notices.length > 0) {
                toast(host, 'warning', notices.join(' '));
            }
            toast(host, 'success', '运行配置已保存');
        },
    });

    shell.append(err.el, basic.el, naiGroup.el, saveBtn);
    root.appendChild(shell);

    let destroyed = false;
    return {
        destroy() {
            if (destroyed) return;
            destroyed = true;
            err.destroy();
            contextN.destroy();
            floorImageScale.destroy();
            autoWrite.destroy();
            autoRender.destroy();
            naiParallel.destroy();
            includeWorldInfo.destroy();
            caseSensitive.destroy();
            wholeWords.destroy();
            paramsForm.destroy();
            basic.destroy();
            naiGroup.destroy();
            shell.remove();
        },
    };
}
