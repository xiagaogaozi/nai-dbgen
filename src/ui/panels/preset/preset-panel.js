/**
 * L5 UI · 生图/召回/单图预设 管理面板。
 * 四种预设按子标签分开展示；cover:false（无图类型）。
 */

import { createButton, createField, createNumberField, createSegmentedTabs, createSelect, createCheckbox } from '../../common/controls.js';
import { createPreset, importFromSillyTavernPreset, presetRetryCount } from '../../../domain/model/preset.js';
import { listRegisteredVariables } from '../../../domain/template/variable-map.js';
import { mountLibraryView } from '../library-view.js';
import { applyFormFields, mergePresetPrompt } from '../_lib/library-logic.js';
import {
    el,
    setText,
    labeledTextarea,
    idNow,
    settingsApi,
    confirmDanger,
    openImportExportModal,
    openFormModal,
    awaitRepo,
    toast,
} from '../_lib/panel-kit.js';

/** @typedef {'imagegen'|'recall'} PresetKindTab */

/** @type {{ id: PresetKindTab, label: string, activeKey: string }[]} */
const PRESET_TABS = Object.freeze([
    { id: 'imagegen', label: '生图预设', activeKey: 'activeImagegenPresetId' },
    { id: 'recall', label: '召回预设', activeKey: 'activeRecallPresetId' },
]);

const KIND_LABEL = Object.freeze({
    imagegen: '生图预设',
    recall: '召回预设',
    'single-imagegen': '单图生图预设',
    'single-recall': '单图召回预设',
});

const PRESET_KIND_STORAGE_KEY = 'nai-dbgen:preset-kind';

/**
 * @param {string} kind
 * @returns {string}
 */
function activeKeyForKind(kind) {
    const tab = PRESET_TABS.find((t) => t.id === kind);
    return tab ? tab.activeKey : 'activeImagegenPresetId';
}

/**
 * @param {Element} root
 * @param {object} deps repos / services / host / bus
 * @returns {{ destroy: () => void }}
 */
export function mountPresetPanel(root, deps) {
    if (!(root instanceof Element)) {
        throw new Error('mountPresetPanel: root must be an Element');
    }
    const repo = deps?.repos?.preset;
    if (!repo) throw new Error('mountPresetPanel: deps.repos.preset required');

    const host = deps.host;
    const ids = idNow(deps);
    const settings = settingsApi(deps);

    const shell = el('div', 'nd-panel nd-panel--preset');
    const listHost = el('div', 'nd-subpanel');

    /** @type {(() => void)[]} */
    const cleanups = [];
    let destroyed = false;

    const segments = createSegmentedTabs({
        ariaLabel: '预设类型',
        storageKey: PRESET_KIND_STORAGE_KEY,
        items: PRESET_TABS.map((t) => ({ id: t.id, label: t.label })),
        onChange: () => void view.refresh(),
    });
    shell.append(segments.el, listHost);
    root.appendChild(shell);

    /** @type {PresetKindTab} */
    function currentKind() {
        const v = segments.getValue();
        return /** @type {PresetKindTab} */ (
            PRESET_TABS.some((t) => t.id === v) ? v : 'imagegen'
        );
    }

    const view = mountLibraryView(listHost, {
        list: async () => {
            const kind = currentKind();
            const items = await awaitRepo(host, repo.list(), '读取预设失败') || [];
            const s = settings.load();
            const activeKey = activeKeyForKind(kind);
            const activeId = s[activeKey];
            return items
                .filter((item) => item && item.kind === kind)
                .map((item) => ({
                    ...item,
                    __active: activeId != null && String(activeId) === String(item.id),
                    __chips: activeId != null && String(activeId) === String(item.id)
                        ? ['当前使用']
                        : [],
                }));
        },
        onCreate: () => void openEditor(null),
        onEdit: (item) => void openEditor(item),
        onDelete: (idList) => void removeItems(idList),
        onImport: () => void openImport('import'),
        onExport: () => void openImport('export'),
    }, {
        cover: false,
        searchKeys: ['name', 'kind'],
        cardMeta: (item) => ({
            subtitle: `${KIND_LABEL[item.kind] || item.kind || '—'} · ${
                Array.isArray(item.prompts) ? item.prompts.length : 0
            } 段`,
            chips: Array.isArray(item.__chips) ? item.__chips : [],
        }),
    });

    /**
     * @param {string[]} idList
     */
    async function removeItems(idList) {
        const ok = await confirmDanger(deps, `删除 ${idList.length} 条预设？`);
        if (!ok) return;
        for (const id of idList) {
            const existing = await awaitRepo(host, repo.get(id));
            await awaitRepo(host, repo.remove(id), '删除失败');
            if (!existing) continue;
            const key = activeKeyForKind(existing.kind);
            const cur = settings.load()[key];
            if (cur != null && String(cur) === String(id)) {
                settings.patch({ [key]: null });
            }
        }
        await view.refresh();
    }

    /**
     * @param {object|null} item
     */
    async function openEditor(item) {
        const nameField = createField({ label: '名称', value: item?.name ?? '' });
        const retryField = createNumberField({
            label: '结果纠错重试次数', value: presetRetryCount(item), min: 0, step: 1,
        });
        const retryHint = el('p', 'nd-preset-vars-hint');
        setText(retryHint, '缺少必填字段或结果格式错误时，反馈具体问题后重试。3 表示首轮失败后再试 3 次，0 为不重试。');
        const defaultKind = item?.kind && KIND_LABEL[item.kind] ? item.kind : currentKind();
        const kindSelect = createSelect({
            label: '类型',
            value: defaultKind,
            options: PRESET_TABS.map((t) => ({
                value: t.id,
                label: KIND_LABEL[t.id],
            })),
        });

        // D45：整段对象保留；表单只改展示字段，injection_* 等原样带回
        /** @type {object[]} */
        let prompts = Array.isArray(item?.prompts)
            ? item.prompts.map((p) => ({ ...p }))
            : [{
                identifier: 'main',
                name: '主提示',
                role: 'system',
                content: '',
                enabled: true,
                injection_position: 0,
                injection_depth: 0,
                injection_order: 100,
            }];

        /** @type {object[]} */
        let promptOrder = Array.isArray(item?.prompt_order)
            ? item.prompt_order.map((o) => ({ ...o }))
            : [];
        prompts = orderPrompts(prompts, promptOrder);

        /**
         * 编辑列表按 prompt_order 排，和发给模型的顺序一致。
         * @param {object[]} list
         * @param {object[]} order
         */
        function orderPrompts(list, order) {
            if (!Array.isArray(order) || !order.length) return list;
            const byId = new Map(list.map((p) => [String(p.identifier), p]));
            /** @type {object[]} */
            const out = [];
            const used = new Set();
            for (const row of order) {
                const id = String(row?.identifier ?? '');
                const prompt = byId.get(id);
                if (!prompt || used.has(id)) continue;
                out.push(prompt);
                used.add(id);
            }
            for (const prompt of list) {
                const id = String(prompt?.identifier ?? '');
                if (!used.has(id)) out.push(prompt);
            }
            return out;
        }

        const promptsHost = el('div', 'nd-preset-prompts');
        /** @type {{ name: ReturnType<typeof createField>, content: ReturnType<typeof labeledTextarea>, enabled: ReturnType<typeof createCheckbox>, workbenchOnly: ReturnType<typeof createCheckbox>, role: ReturnType<typeof createSelect> }[]} */
        let promptControls = [];

        function paintPrompts() {
            promptsHost.replaceChildren();
            const title = el('h4', 'nd-field-group__title');
            setText(title, '提示词段');
            promptsHost.appendChild(title);
            promptControls = [];
            prompts.forEach((p, index) => {
                const block = el('div', 'nd-preset-prompt');
                const name = createField({
                    label: '段名',
                    value: p.name != null ? String(p.name) : '',
                });
                const roleVal = p.role === 'user' || p.role === 'assistant' ? p.role : 'system';
                const role = createSelect({
                    label: '角色',
                    value: roleVal,
                    options: [
                        { value: 'system', label: '系统' },
                        { value: 'user', label: '用户' },
                        { value: 'assistant', label: '助手' },
                    ],
                });
                const enabled = createCheckbox({
                    label: '启用',
                    checked: p.enabled !== false,
                });
                const workbenchOnly = createCheckbox({
                    label: '工作台专用',
                    checked: p.workbenchOnly === true,
                });
                const content = labeledTextarea(
                    '内容',
                    p.content != null ? String(p.content) : '',
                    6,
                );
                promptControls.push({ name, content, enabled, workbenchOnly, role });
                block.append(name.el, role.el, enabled.el, workbenchOnly.el, content.el);
                const moveRow = el('div', 'nd-form__actions');
                if (index > 0) {
                    moveRow.appendChild(createButton({
                        label: '上移',
                        variant: 'ghost',
                        onClick: () => movePrompt(index, -1),
                    }));
                }
                if (index < prompts.length - 1) {
                    moveRow.appendChild(createButton({
                        label: '下移',
                        variant: 'ghost',
                        onClick: () => movePrompt(index, 1),
                    }));
                }
                moveRow.append(
                    createButton({
                        label: '在上方插入',
                        variant: 'ghost',
                        onClick: () => insertPrompt(index, 0),
                    }),
                    createButton({
                        label: '在下方插入',
                        variant: 'ghost',
                        onClick: () => insertPrompt(index, 1),
                    }),
                );
                block.appendChild(moveRow);
                block.appendChild(createButton({
                    label: '删除段',
                    variant: 'danger',
                    onClick: () => {
                        prompts = readPrompts().filter((_, i) => i !== index);
                        if (!prompts.length) {
                            prompts = [{
                                identifier: 'main',
                                name: '主提示',
                                role: 'system',
                                content: '',
                                enabled: true,
                                injection_position: 0,
                                injection_depth: 0,
                                injection_order: 100,
                            }];
                        }
                        paintPrompts();
                    },
                }));
                promptsHost.appendChild(block);
            });
            promptsHost.appendChild(createButton({
                label: '＋添加段',
                variant: 'ghost',
                onClick: () => insertPrompt(readPrompts().length, 0),
            }));
        }

        /**
         * @param {number} index 插入点。offset 0 插在该段前面，1 插在后面。index 等于长度时追加到末尾。
         * @param {number} offset
         */
        function insertPrompt(index, offset) {
            const next = readPrompts();
            const at = Math.max(0, Math.min(next.length, index + offset));
            next.splice(at, 0, {
                identifier: ids.id('pp'),
                name: '新段',
                role: 'system',
                content: '',
                enabled: true,
                injection_position: 0,
                injection_depth: 0,
                injection_order: 100 + next.length,
            });
            prompts = next;
            promptOrder = next.map((p) => ({
                identifier: p.identifier,
                enabled: p.enabled !== false,
            }));
            paintPrompts();
        }

        /**
         * @param {number} index
         * @param {number} delta
         */
        function movePrompt(index, delta) {
            const next = readPrompts();
            const target = index + delta;
            if (target < 0 || target >= next.length) return;
            const current = next[index];
            next[index] = next[target];
            next[target] = current;
            prompts = next;
            promptOrder = next.map((p) => ({
                identifier: p.identifier,
                enabled: p.enabled !== false,
            }));
            paintPrompts();
        }

        function readPrompts() {
            return promptControls.map((c, i) => mergePresetPrompt(prompts[i], {
                identifier: prompts[i]?.identifier || ids.id('pp'),
                name: c.name.getValue(),
                role: c.role.getValue(),
                content: c.content.getValue(),
                enabled: c.enabled.getValue(),
                workbenchOnly: c.workbenchOnly.getValue(),
            }));
        }

        /**
         * @param {object[]} promptList
         * @returns {object[]}
         */
        function mergePromptOrder(promptList) {
            return promptList.map((p, i) => {
                const prev = promptOrder.find((o) => String(o.identifier) === String(p.identifier))
                    || promptOrder[i]
                    || null;
                return applyFormFields(prev, {
                    identifier: p.identifier,
                    enabled: p.enabled !== false,
                });
            });
        }
        paintPrompts();

        const stPaste = labeledTextarea('从酒馆预设粘贴', '', 4);
        const varsHint = el('p', 'nd-preset-vars-hint');
        setText(
            varsHint,
            `可用变量：${listRegisteredVariables().map((n) => `{{${n}}}`).join(' ')}`,
        );
        const form = el('div', 'nd-form');
        form.append(nameField.el, kindSelect.el, retryField.el, retryHint, varsHint, promptsHost, stPaste.el);
        const modal = await openFormModal(deps, item ? '编辑预设' : '新建预设', form);

        const actions = el('div', 'nd-form__actions');
        actions.append(
            createButton({ label: '取消', variant: 'ghost', onClick: () => modal.destroy() }),
            createButton({
                label: '解析粘贴',
                variant: 'ghost',
                onClick: () => {
                    try {
                        const raw = JSON.parse(stPaste.getValue());
                        const selectedKind = /** @type {PresetKindTab} */ (kindSelect.getValue());
                        const imported = importFromSillyTavernPreset(
                            raw,
                            {
                                kind: KIND_LABEL[selectedKind] ? selectedKind : 'imagegen',
                                name: nameField.getValue() || undefined,
                            },
                            { id: ids.id('pr'), now: ids.now() },
                        );
                        if (!imported.ok) {
                            modal.setError(imported.error);
                            return;
                        }
                        nameField.setValue(imported.value.name);
                        kindSelect.setValue(imported.value.kind);
                        retryField.setValue(imported.value.retryCount);
                        prompts = imported.value.prompts.map((p) => ({ ...p }));
                        promptOrder = Array.isArray(imported.value.prompt_order)
                            ? imported.value.prompt_order.map((o) => ({ ...o }))
                            : [];
                        prompts = orderPrompts(prompts, promptOrder);
                        paintPrompts();
                        toast(host, 'success', '已解析酒馆预设');
                    } catch (e) {
                        modal.setError(e instanceof Error ? e.message : String(e));
                    }
                },
            }),
            createButton({
                label: '设为当前',
                variant: 'ghost',
                onClick: async () => {
                    const saved = await save();
                    if (!saved) return;
                    const key = activeKeyForKind(saved.kind);
                    settings.patch({ [key]: saved.id });
                    toast(host, 'success', '已设为当前预设');
                    await view.refresh();
                },
            }),
            createButton({
                label: '保存',
                variant: 'primary',
                onClick: async () => {
                    if (await save()) {
                        modal.destroy();
                        toast(host, 'success', '已保存');
                        await view.refresh();
                    }
                },
            }),
        );
        form.appendChild(actions);

        async function save() {
            const name = nameField.getValue().trim();
            if (!name) {
                modal.setError('请填写预设名称');
                return null;
            }
            const selected = /** @type {PresetKindTab} */ (kindSelect.getValue());
            const nextKind = KIND_LABEL[selected] ? selected : 'imagegen';
            const retryCount = Number(retryField.getValue());
            if (!Number.isSafeInteger(retryCount) || retryCount < 0) {
                modal.setError('结果纠错重试次数必须是大于或等于 0 的整数');
                return null;
            }
            const promptList = readPrompts();
            const orderList = mergePromptOrder(promptList);
            promptOrder = orderList;
            prompts = promptList;
            const entity = item
                ? applyFormFields(item, {
                    name,
                    kind: nextKind,
                    retryCount,
                    prompts: promptList,
                    prompt_order: orderList,
                    updatedAt: ids.now(),
                })
                : createPreset(
                    { name, kind: nextKind, retryCount, prompts: promptList, prompt_order: orderList },
                    { id: ids.id('pr'), now: ids.now() },
                );
            return awaitRepo(host, repo.put(entity), '保存失败');
        }
    }

    /**
     * @param {'import'|'export'} [mode]
     */
    async function openImport(mode = 'import') {
        await openImportExportModal(
            deps,
            mode === 'export' ? '导出预设' : '导入预设',
            'preset',
            async (data, strategy, progress) => {
                const r = await repo.importJson(data, {
                    strategy,
                    onProgress: progress?.onProgress,
                });
                if (!r.ok) throw new Error(r.error?.message || '导入失败');
                return r.value;
            },
            async () => {
                const r = await repo.exportJson();
                if (!r.ok) throw new Error(r.error?.message || '导出失败');
                return r.value;
            },
            () => void view.refresh(),
            { mode },
        );
    }

    if (typeof repo.onChanged === 'function') {
        cleanups.push(repo.onChanged(() => void view.refresh()));
    }

    return {
        destroy() {
            if (destroyed) return;
            destroyed = true;
            for (const fn of cleanups) fn();
            view.destroy();
            segments.destroy();
            shell.remove();
        },
    };
}
