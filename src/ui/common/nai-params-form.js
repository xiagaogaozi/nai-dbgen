/**
 * L5 UI · 4.13 出图参数表单（出图参数页与工作台共用）。
 * 模型/采样器/噪声/负面预设下拉；成对字段合一；能力随模型显隐。
 */

import {
    createCombobox,
    createNumberField,
    createSelect,
    createToggle,
    createFieldGroup,
} from './controls.js';
import { defaultNaiParams, normalizeNaiParams } from '../../domain/model/nai-params.js';
import {
    NAI_MODEL_OPTIONS,
    formatNaiModelInput,
    formatNaiModelOption,
    resolveNaiModelInput,
    NAI_SIZE_PRESETS,
    SMEA_MODE_OPTIONS,
    UC_PRESET_NONE,
    coerceNaiParams,
    computeVarietySigma,
    isMultipleOf64,
    matchSizePresetId,
    noiseSchedulesForModel,
    reconcileParamsForModel,
    samplersForModel,
    smeaFlagsFromMode,
    smeaModeFromFlags,
    supportsCfgRescale,
    supportsNoiseScheduleSelect,
    supportsSmea,
    supportsTransparentBackground,
    supportsVariety,
    ucPresetsForModel,
} from '../../domain/nai/param-options.js';

/**
 * @param {string} tag
 * @param {string} [className]
 * @returns {HTMLElement}
 */
function el(tag, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
}

/**
 * @param {HTMLElement} node
 * @param {string} text
 */
function setText(node, text) {
    node.textContent = text == null ? '' : String(text);
}

/**
 * @param {import('../../domain/model/nai-params.js').NaiParams|object} [initial]
 * @param {{ onChange?: (params: import('../../domain/model/nai-params.js').NaiParams) => void, presentation?: 'workbench' }} [opts]
 * @returns {{
 *   el: HTMLElement,
 *   getValue: () => import('../../domain/model/nai-params.js').NaiParams,
 *   setValue: (params: object) => void,
 *   consumeNotices: () => string[],
 *   destroy: () => void,
 * }}
 */
export function createNaiParamsForm(initial, opts) {
    const defaults = defaultNaiParams();
    let state = coerceNaiParams({ ...defaults, ...(initial || {}) });
    /** @type {string[]} */
    let pendingNotices = [];
    /** @type {(params: import('../../domain/model/nai-params.js').NaiParams) => void} */
    const onChange = typeof opts?.onChange === 'function' ? opts.onChange : () => {};
    const workbenchPresentation = opts?.presentation === 'workbench';

    const root = el('div', 'nd-nai-params');
    root.style.containerType = 'inline-size';

    const noticeEl = el('p', 'nd-nai-params__notice');
    noticeEl.hidden = true;

    const model = createCombobox({
        label: '模型',
        value: formatNaiModelInput(state.model),
        placeholder: '选择或填写模型编号',
        options: NAI_MODEL_OPTIONS.map((option) => formatNaiModelOption(option)),
        onChange: () => onModelChange(),
    });

    const sizePresetOptions = [
        { value: 'custom', label: '自定义' },
        ...NAI_SIZE_PRESETS.map((p) => ({ value: p.id, label: p.label })),
    ];
    const sizePreset = createSelect({
        label: '尺寸预设',
        value: matchSizePresetId(state.width, state.height),
        options: sizePresetOptions,
        onChange: () => onSizePresetChange(),
    });

    const width = createNumberField({
        label: '宽',
        value: state.width,
        min: 64,
        max: 2048,
        step: 64,
        onChange: () => onSizeManual(),
    });
    const height = createNumberField({
        label: '高',
        value: state.height,
        min: 64,
        max: 2048,
        step: 64,
        onChange: () => onSizeManual(),
    });
    const sizeHint = el('p', 'nd-nai-params__hint');
    setText(sizeHint, '宽高须为 64 的倍数');

    const steps = createNumberField({
        label: '步数',
        value: state.steps,
        min: 1,
        max: 50,
        step: 1,
        onChange: emit,
    });
    const scale = createNumberField({
        label: '提示词服从',
        value: state.scale,
        min: 0,
        max: 10,
        step: 0.1,
        onChange: emit,
    });
    const sampler = createSelect({
        label: '采样器',
        value: state.sampler,
        options: [...samplersForModel(state.model)],
        onChange: emit,
    });
    const noise = createSelect({
        label: '噪声计划',
        value: state.noise_schedule,
        options: [...noiseSchedulesForModel(state.model)],
        onChange: emit,
    });
    const seed = createNumberField({
        label: '种子（-1 每次随机）',
        value: state.seed,
        min: -1,
        max: 4294967295,
        step: 1,
        onChange: emit,
    });
    const imageFormat = createSelect({
        label: '格式',
        value: state.image_format === 'webp' ? 'webp' : 'png',
        options: [
            { value: 'png', label: 'PNG' },
            { value: 'webp', label: 'WebP' },
        ],
        onChange: emit,
    });

    const quality = createToggle({
        label: '官方质量词',
        hint: '由官方按模型追加质量标签，不写入提示词正文',
        checked: state.qualityToggle !== false,
        onChange: emit,
    });
    const ucPreset = createSelect({
        label: '官方负面预设',
        value: String(state.ucPreset),
        options: ucPresetsForModel(state.model).map((o) => ({
            value: String(o.value),
            label: o.label,
        })),
        onChange: emit,
    });
    const cfgRescale = createNumberField({
        label: 'CFG Rescale',
        value: state.cfg_rescale,
        min: 0,
        max: 1,
        step: 0.01,
        onChange: emit,
    });
    const variety = createToggle({
        label: 'Variety',
        hint: '按画布尺寸调节高噪声阶段引导',
        checked: state.skip_cfg_above_sigma != null,
        onChange: emit,
    });
    const smea = createSelect({
        label: 'SMEA',
        value: smeaModeFromFlags(state.sm === true, state.sm_dyn === true),
        options: [...SMEA_MODE_OPTIONS],
        onChange: emit,
    });
    const transparent = createToggle({
        label: '透明底',
        hint: '生成带透明通道的图片',
        checked: state.straight_alpha === true
            || state.tag_hint_transparent_background === true,
        onChange: emit,
    });

    const modelSizeGroup = createFieldGroup({
        title: workbenchPresentation ? '' : '模型与尺寸',
        children: [
            model.el,
            sizePreset.el,
            width.el,
            height.el,
            sizeHint,
            imageFormat.el,
        ],
    });
    const sampleGroup = createFieldGroup({
        title: workbenchPresentation ? '' : '采样',
        children: [
            steps.el,
            scale.el,
            sampler.el,
            noise.el,
            seed.el,
        ],
    });
    const presetGroup = createFieldGroup({
        title: workbenchPresentation ? '' : '官方预设与开关',
        children: workbenchPresentation ? [
            ucPreset.el,
            quality.el,
            cfgRescale.el,
            variety.el,
            smea.el,
            transparent.el,
        ] : [
            quality.el,
            ucPreset.el,
            cfgRescale.el,
            variety.el,
            smea.el,
            transparent.el,
        ],
    });

    const grid = el('div', 'nd-nai-params__grid');
    grid.append(modelSizeGroup.el, sampleGroup.el, presetGroup.el);
    root.append(noticeEl, grid);

    applyCapabilityUi(state.model);
    syncSizePresetSelect();

    function showNotices(list) {
        pendingNotices = Array.isArray(list) ? list.filter(Boolean) : [];
        if (pendingNotices.length === 0) {
            noticeEl.hidden = true;
            setText(noticeEl, '');
            return;
        }
        noticeEl.hidden = false;
        setText(noticeEl, pendingNotices.join(' '));
    }

    /**
     * @returns {import('../../domain/model/nai-params.js').NaiParams}
     */
    function readRaw() {
        const w = Number(width.getValue());
        const h = Number(height.getValue());
        const qualityOn = quality.getValue();
        const uc = Number(ucPreset.getValue());
        const ucNone = uc === UC_PRESET_NONE;
        // 能力门禁留给 coerce/reconcile：此处原样读控件，换模型才能弹出回退提示
        const varietyOn = variety.getValue();
        const smeaFlags = smeaFlagsFromMode(smea.getValue());
        const transparentOn = transparent.getValue();

        return normalizeNaiParams({
            model: resolveNaiModelInput(model.getValue()) || state.model,
            width: Number.isFinite(w) ? w : defaults.width,
            height: Number.isFinite(h) ? h : defaults.height,
            steps: Number(steps.getValue()),
            scale: Number(scale.getValue()),
            sampler: sampler.getValue(),
            noise_schedule: noise.getValue(),
            seed: Number(seed.getValue()),
            image_format: imageFormat.getValue(),
            qualityToggle: qualityOn,
            tag_hint_qt: qualityOn,
            ucPreset: Number.isFinite(uc) ? uc : defaults.ucPreset,
            tag_hint_uc_preset: !ucNone,
            cfg_rescale: Number(cfgRescale.getValue()),
            skip_cfg_above_sigma: varietyOn
                ? computeVarietySigma(w, h, model.getValue())
                : null,
            sm: smeaFlags.sm,
            sm_dyn: smeaFlags.sm_dyn,
            straight_alpha: transparentOn,
            tag_hint_transparent_background: transparentOn,
            n_samples: 1,
            schemaVersion: defaults.schemaVersion,
        });
    }

    function onModelChange() {
        const nextModel = resolveNaiModelInput(model.getValue());
        if (!nextModel || nextModel === state.model) return;
        // 用切模型前的意图做回退：先按旧 model 读表单，再 reconcile 到新模型
        const draft = readRaw();
        draft.model = state.model;
        const { params, notices } = reconcileParamsForModel(draft, nextModel);
        applyState(params, { silent: true });
        showNotices(notices);
        onChange(getValue());
    }

    function onSizePresetChange() {
        const id = sizePreset.getValue();
        const preset = NAI_SIZE_PRESETS.find((p) => p.id === id);
        if (!preset) {
            emit();
            return;
        }
        width.setValue(preset.width);
        height.setValue(preset.height);
        clearSizeError();
        emit();
    }

    function onSizeManual() {
        syncSizePresetSelect();
        validateSizeFields();
        emit();
    }

    function syncSizePresetSelect() {
        const id = matchSizePresetId(Number(width.getValue()), Number(height.getValue()));
        sizePreset.setValue(id);
    }

    function clearSizeError() {
        width.el.classList.remove('is-invalid');
        height.el.classList.remove('is-invalid');
    }

    function validateSizeFields() {
        const w = Number(width.getValue());
        const h = Number(height.getValue());
        const okW = isMultipleOf64(w);
        const okH = isMultipleOf64(h);
        width.el.classList.toggle('is-invalid', !okW);
        height.el.classList.toggle('is-invalid', !okH);
        return okW && okH;
    }

    /**
     * @param {string} modelId
     */
    function applyCapabilityUi(modelId) {
        const showNoise = supportsNoiseScheduleSelect(modelId);
        noise.setDisabled(!showNoise);
        noise.setOptions([...noiseSchedulesForModel(modelId)], noise.getValue());
        sampler.setOptions([...samplersForModel(modelId)], sampler.getValue());
        ucPreset.setOptions(
            ucPresetsForModel(modelId).map((o) => ({
                value: String(o.value),
                label: o.label,
            })),
            ucPreset.getValue(),
        );

        cfgRescale.el.hidden = !supportsCfgRescale(modelId);
        variety.el.hidden = !supportsVariety(modelId);
        smea.el.hidden = !supportsSmea(modelId);
        transparent.el.hidden = !supportsTransparentBackground(modelId);
    }

    function emit() {
        state = coerceNaiParams(readRaw());
        onChange(state);
    }

    /**
     * @param {object} params
     * @param {{ silent?: boolean }} [flags]
     */
    function applyState(params, flags) {
        state = coerceNaiParams(params);
        model.setValue(formatNaiModelInput(state.model));
        applyCapabilityUi(state.model);
        width.setValue(state.width);
        height.setValue(state.height);
        syncSizePresetSelect();
        steps.setValue(state.steps);
        scale.setValue(state.scale);
        sampler.setValue(state.sampler);
        noise.setValue(state.noise_schedule);
        seed.setValue(state.seed);
        imageFormat.setValue(state.image_format === 'webp' ? 'webp' : 'png');
        quality.setValue(state.qualityToggle !== false);
        ucPreset.setValue(String(state.ucPreset));
        cfgRescale.setValue(state.cfg_rescale);
        variety.setValue(state.skip_cfg_above_sigma != null);
        smea.setValue(smeaModeFromFlags(state.sm === true, state.sm_dyn === true));
        transparent.setValue(
            state.straight_alpha === true || state.tag_hint_transparent_background === true,
        );
        if (!flags?.silent) {
            showNotices([]);
        }
    }

    function getValue() {
        validateSizeFields();
        state = coerceNaiParams(readRaw());
        return state;
    }

    let destroyed = false;
    return {
        el: root,
        getValue,
        setValue: (params) => {
            const { params: next, notices } = reconcileParamsForModel(
                params,
                params?.model ?? state.model,
            );
            applyState(next);
            showNotices(notices);
        },
        consumeNotices: () => {
            const out = pendingNotices.slice();
            pendingNotices = [];
            return out;
        },
        destroy() {
            if (destroyed) return;
            destroyed = true;
            model.destroy();
            sizePreset.destroy();
            width.destroy();
            height.destroy();
            steps.destroy();
            scale.destroy();
            sampler.destroy();
            noise.destroy();
            seed.destroy();
            imageFormat.destroy();
            quality.destroy();
            ucPreset.destroy();
            cfgRescale.destroy();
            variety.destroy();
            smea.destroy();
            transparent.destroy();
            modelSizeGroup.destroy();
            sampleGroup.destroy();
            presetGroup.destroy();
            root.remove();
        },
    };
}
