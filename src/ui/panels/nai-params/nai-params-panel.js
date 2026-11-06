/**
 * L5 UI · 出图参数页（0.2.45 从常规设置拆出）。
 * 改完立即存；模型兼容提示由表单自带提示区显示。
 * 0.2.46：加「模型跟随模型版本」开关和 V5 / V4.5 绑定模型。
 */

import { createCombobox, createFieldGroup, createToggle } from '../../common/controls.js';
import { createNaiParamsForm } from '../../common/nai-params-form.js';
import { defaultNaiParams } from '../../../domain/model/nai-params.js';
import {
    NAI_MODEL_OPTIONS,
    classifyNaiModel,
    formatNaiModelInput,
    formatNaiModelOption,
    resolveNaiModelInput,
} from '../../../domain/nai/param-options.js';
import { boundModelForArtistTag } from '../../../domain/model/plugin-settings.js';
import { applyFormFields } from '../_lib/library-logic.js';
import { el, settingsApi } from '../_lib/panel-kit.js';

/**
 * @param {Element} root
 * @param {object} deps
 * @returns {{ destroy: () => void }}
 */
export function mountNaiParamsPanel(root, deps) {
    if (!(root instanceof Element)) {
        throw new Error('mountNaiParamsPanel: root must be an Element');
    }
    const settings = settingsApi(deps);
    const current = settings.load();
    const nai = applyFormFields(defaultNaiParams(), current.naiParams || {});
    const form = createNaiParamsForm(nai, {
        onChange: (params) => settings.patch({ naiParams: params }),
    });

    const follow = createToggle({
        label: '模型跟随模型版本',
        hint: '切换画师串时，版本系列不同就换成下面绑定的模型；画师串库生成预览也用绑定模型',
        checked: current.naiModelFollowsArtist !== false,
        onChange: (v) => settings.patch({ naiModelFollowsArtist: v }),
    });

    /**
     * @param {'v5'|'v4.5'} tag
     * @param {string} label
     */
    const makeBinding = (tag, label) => {
        const family = tag === 'v5' ? 'v5' : 'v45';
        return createCombobox({
            label,
            value: formatNaiModelInput(boundModelForArtistTag(current, tag)),
            options: NAI_MODEL_OPTIONS
                .filter((o) => classifyNaiModel(o.value) === family)
                .map((o) => formatNaiModelOption(o)),
            onChange: (raw) => {
                const id = resolveNaiModelInput(raw);
                if (!NAI_MODEL_OPTIONS.some((o) => o.value === id) || classifyNaiModel(id) !== family) return;
                const binding = { ...(settings.load().artistModelBinding || {}), [tag]: id };
                settings.patch({ artistModelBinding: binding });
            },
        });
    };
    const bindV5 = makeBinding('v5', 'V5 模型');
    const bindV45 = makeBinding('v4.5', 'V4.5 模型');

    const shell = el('div', 'nd-panel nd-panel--nai-params');
    const followGroup = createFieldGroup({
        title: '模型版本绑定',
        children: [follow.el, bindV5.el, bindV45.el],
    });
    const group = createFieldGroup({ title: '出图参数', children: [form.el] });
    shell.append(followGroup.el, group.el);
    root.appendChild(shell);
    return {
        destroy() {
            form.destroy();
            follow.destroy();
            bindV5.destroy();
            bindV45.destroy();
            followGroup.destroy();
            group.destroy();
            shell.remove();
        },
    };
}