/**
 * L5 UI · 标签库（多库 → 条目） 管理面板。
 * 归属：W2-H 面板代理实现。W0 仅冻结签名。
 * 与角色库共用 mountNestedList（D7）。
 */

import { createLibraryToolbar } from '../../common/library-chrome.js';
import { createButton, createMiniAction, createField, createToggle, createInlineError, createSelect } from '../../common/controls.js';
import { buildExportFilename, downloadJson } from '../../common/import-export.js';
import {
    mountNestedList,
    paintNestedChildTexts,
    NESTED_CHILD_ROW_HEIGHT,
} from '../../common/nested-list.js';
import { createStore } from '../../common/store.js';
import { TAG_SCHEMA_VERSION, createTagLibrary, createTagEntry, normalizeTagLibraryKind, normalizeTagEntrySecondary } from '../../../domain/model/tag.js';
import { buildExportEnvelope } from '../../../adapters/storage/import-export.js';
import {
    parseCompositionKey,
    composeCompositionKey,
} from '../../../domain/model/composition-key.js';
import { validateTagEntryWriting } from '../../../domain/model/tag-writing.js';
import { filterNestedLibrary, applyFormFields } from '../_lib/library-logic.js';
import {
    el,
    setText,
    labeledTextarea,
    idNow,
    bindSelectionOutsideExit,
    countOverwriteByIds,
    confirmDanger,
    openImportExportModal,
    openFormModal,
    awaitRepo,
    toast,
} from '../_lib/panel-kit.js';

/**
 * @param {string} kind
 * @returns {string}
 */
function kindLabel(kind) {
    const k = normalizeTagLibraryKind(kind);
    if (k === 'feature') {
        return '特征库';
    }
    if (k === 'constant') {
        return '常驻库';
    }
    return '构图库';
}

/**
 * @param {string} kind
 * @returns {string}
 */
function keyFieldLabel(kind) {
    const k = normalizeTagLibraryKind(kind);
    if (k === 'feature') {
        return '触发关键字';
    }
    if (k === 'constant') {
        return '条目名';
    }
    return '构图关键字';
}

/**
 * @param {Element} root
 * @param {object} deps repos / services / host / bus
 * @returns {{ destroy: () => void }}
 */
export function mountTagPanel(root, deps) {
    if (!(root instanceof Element)) {
        throw new Error('mountTagPanel: root must be an Element');
    }
    const repo = deps?.repos?.tag;
    if (!repo) throw new Error('mountTagPanel: deps.repos.tag required');

    const host = deps.host;
    const ids = idNow(deps);
    const store = createStore({
        query: '',
        activeOnly: false,
        libraries: /** @type {object[]} */ ([]),
        /** @type {Map<string, object[]>} */
        byLib: new Map(),
    });

    /** @type {Set<string>} */
    const expandedIds = new Set();
    /** @type {Set<string>} */
    const selectedLibIds = new Set();
    /** @type {Set<string>} */
    const selectedEntryIds = new Set();
    let selectionMode = false;

    const bulkCount = el('span', 'nd-artist-bulk__count');
    setText(bulkCount, '已选 0');
    const selectAllToggleBtn = createButton({
        label: '全选',
        variant: 'ghost',
        onClick: () => {
            if (isAllVisibleSelected()) clearSelection();
            else selectVisibleAll();
        },
    });
    const exportSelectedBtn = createButton({
        label: '导出',
        variant: 'ghost',
        onClick: () => exportSelected(),
    });
    exportSelectedBtn.disabled = true;
    const deleteSelectedBtn = createButton({
        label: '删除',
        variant: 'danger',
        onClick: () => void removeSelected(),
    });
    deleteSelectedBtn.disabled = true;
    for (const btn of [selectAllToggleBtn, exportSelectedBtn, deleteSelectedBtn]) {
        btn.classList.add('nd-artist-bulk__btn');
    }
    const bulkBar = el('div', 'nd-bulk-bar');
    bulkBar.hidden = true;
    bulkBar.append(selectAllToggleBtn, exportSelectedBtn, deleteSelectedBtn, bulkCount);

    function setSelectionModeUi(next) {
        selectionMode = Boolean(next);
        if (!selectionMode) {
            selectedLibIds.clear();
            selectedEntryIds.clear();
        }
        bulkBar.hidden = !selectionMode;
        setText(selectModeBtn, selectionMode ? '完成' : '选择');
        selectModeBtn.setAttribute('aria-pressed', selectionMode ? 'true' : 'false');
        syncBulk();
        nested?.refresh();
    }

    const selectModeBtn = createButton({
        label: '选择',
        variant: 'ghost',
        onClick: () => setSelectionModeUi(!selectionMode),
    });
    selectModeBtn.setAttribute('aria-pressed', 'false');

    const shell = el('div', 'nd-panel nd-panel--tag');
    const toolbar = createLibraryToolbar({
        searchPlaceholder: '搜索库或条目',
        onSearch: (q) => store.set((s) => ({ ...s, query: q })),
        onCreate: () => void openLibraryEditor(null),
        leading: [selectModeBtn],
        onImport: () => void openImport('import'),
        extra: (() => {
            const wrap = el('label', 'nd-checkbox-row');
            const input = document.createElement('input');
            input.type = 'checkbox';
            const text = el('span');
            setText(text, '仅看已激活库');
            input.addEventListener('change', () => {
                store.set((s) => ({ ...s, activeOnly: input.checked }));
            });
            wrap.append(input, text);
            return [wrap];
        })(),
    });
    const listHost = el('div', 'nd-panel__list');
    const err = createInlineError();
    shell.append(toolbar.el, bulkBar, err.el, listHost);
    root.appendChild(shell);

    /** @type {{ destroy: () => void, refresh: () => void }|null} */
    let nested = null;
    /** @type {(() => void)[]} */
    const cleanups = [];
    let destroyed = false;

    function resolveSelectionTargets() {
        const s = store.get();
        const libById = new Map(s.libraries.map((lib) => [String(lib.id), lib]));
        /** @type {object[]} */
        const libs = [];
        for (const id of selectedLibIds) {
            const lib = libById.get(id);
            if (lib) libs.push(lib);
        }
        /** @type {object[]} */
        const entries = [];
        for (const [libId, list] of s.byLib.entries()) {
            if (selectedLibIds.has(libId)) continue;
            for (const entry of list || []) {
                if (selectedEntryIds.has(String(entry.id))) entries.push(entry);
            }
        }
        return { libs, entries };
    }

    function isAllVisibleSelected() {
        const q = store.get().query.trim().toLowerCase();
        const vis = visible();
        if (!vis.parents.length) return false;
        let targetCount = 0;
        for (const lib of vis.parents) {
            const libId = String(lib.id);
            const children = vis.childrenByParentId.get(libId) || [];
            const nameHit = !q || String(lib.name ?? '').toLowerCase().includes(q);
            if (nameHit) {
                targetCount += 1;
                if (!selectedLibIds.has(libId)) return false;
            } else {
                for (const entry of children) {
                    targetCount += 1;
                    if (!selectedLibIds.has(libId) && !selectedEntryIds.has(String(entry.id))) return false;
                }
            }
        }
        return targetCount > 0;
    }

    function syncBulk() {
        const { libs, entries } = resolveSelectionTargets();
        const parts = [];
        if (libs.length) parts.push(`${libs.length} 个库`);
        if (entries.length) parts.push(`${entries.length} 条`);
        setText(bulkCount, parts.length ? `已选 ${parts.join('、')}` : '已选 0');
        const empty = libs.length === 0 && entries.length === 0;
        exportSelectedBtn.disabled = empty;
        deleteSelectedBtn.disabled = empty;
        setText(selectAllToggleBtn, isAllVisibleSelected() ? '取消全选' : '全选');
    }

    function exportSelected() {
        const s = store.get();
        const { libs, entries } = resolveSelectionTargets();
        if (!libs.length && !entries.length) return;
        const libById = new Map(s.libraries.map((l) => [String(l.id), l]));
        /** @type {Map<string, object>} */
        const outLibs = new Map();
        /** @type {object[]} */
        const outEntries = [];
        for (const lib of libs) {
            const lid = String(lib.id);
            outLibs.set(lid, lib);
            for (const entry of s.byLib.get(lid) || []) {
                outEntries.push(entry);
            }
        }
        for (const entry of entries) {
            const lid = String(entry.libraryId ?? '');
            const parent = libById.get(lid);
            if (parent) outLibs.set(lid, parent);
            outEntries.push(entry);
        }
        const payload = buildExportEnvelope({
            kind: 'tag',
            schemaVersion: TAG_SCHEMA_VERSION,
            payload: {
                libraries: [...outLibs.values()],
                entries: outEntries,
            },
        });
        try {
            downloadJson(payload, buildExportFilename('标签库'));
            toast(host, 'success', `已导出 ${outLibs.size} 个标签库，共 ${outEntries.length} 条`);
        } catch (cause) {
            toast(host, 'error', cause instanceof Error ? cause.message : '导出标签库失败');
        }
    }

    function pruneSelection() {
        const s = store.get();
        const aliveLibs = new Set(s.libraries.map((l) => String(l.id)));
        const aliveEntries = new Set();
        for (const list of s.byLib.values()) {
            for (const entry of list || []) aliveEntries.add(String(entry.id));
        }
        for (const id of [...selectedLibIds]) {
            if (!aliveLibs.has(id)) selectedLibIds.delete(id);
        }
        for (const id of [...selectedEntryIds]) {
            if (!aliveEntries.has(id)) selectedEntryIds.delete(id);
        }
        syncBulk();
    }

    function selectVisibleAll() {
        if (!selectionMode) return;
        const q = store.get().query.trim().toLowerCase();
        const vis = visible();
        for (const lib of vis.parents) {
            const libId = String(lib.id);
            const children = vis.childrenByParentId.get(libId) || [];
            const nameHit = !q || String(lib.name ?? '').toLowerCase().includes(q);
            if (nameHit) {
                selectedLibIds.add(libId);
                for (const entry of children) selectedEntryIds.delete(String(entry.id));
            } else {
                for (const entry of children) selectedEntryIds.add(String(entry.id));
            }
        }
        syncBulk();
        nested?.refresh();
    }

    function clearSelection() {
        selectedLibIds.clear();
        selectedEntryIds.clear();
        syncBulk();
        nested?.refresh();
    }

    async function removeSelected() {
        const { libs, entries } = resolveSelectionTargets();
        if (!libs.length && !entries.length) return;
        const parts = [];
        if (libs.length) parts.push(`${libs.length} 个标签库（及其全部条目）`);
        if (entries.length) parts.push(`${entries.length} 条标签条目`);
        const ok = await confirmDanger(deps, `将删除所选 ${parts.join('和')}。此操作不可撤销，确定继续？`);
        if (!ok || destroyed) return;
        for (const lib of libs) {
            await awaitRepo(host, repo.removeLibrary(lib.id), '删除标签库失败');
        }
        for (const entry of entries) {
            await awaitRepo(host, repo.remove(entry.id), '删除条目失败');
        }
        selectedLibIds.clear();
        selectedEntryIds.clear();
        syncBulk();
        await refresh();
    }

    function visible() {
        const s = store.get();
        return filterNestedLibrary(s.libraries, s.byLib, {
            query: s.query,
            activeOnly: s.activeOnly,
            parentSearchKeys: ['name'],
            childSearchKeys: ['key', 'value'],
        });
    }

    function remountList() {
        nested?.destroy();
        nested = mountNestedList(listHost, {
            getParents: () => visible().parents,
            getChildren: (parent) => visible().childrenByParentId.get(String(parent.id)) || [],
            getParentLabel: (parent) => String(parent.name ?? parent.id),
            isParentEnabled: (p) => p.active !== false,
            onParentEnabledChange: (parent, enabled) => void toggleLibrary(parent, enabled),
            isExpanded: (id) => expandedIds.has(id),
            onExpandedChange: (id, open) => {
                if (open) expandedIds.add(id);
                else expandedIds.delete(id);
            },
            isSelectionMode: () => selectionMode,
            isParentSelected: (parent) => selectedLibIds.has(String(parent.id)),
            onParentSelectToggle: (parent, block) => {
                const id = String(parent.id);
                const next = !selectedLibIds.has(id);
                if (next) selectedLibIds.add(id);
                else selectedLibIds.delete(id);
                block.classList.toggle('is-selected', next);
                syncBulk();
            },
            isChildSelected: (child) => selectedEntryIds.has(String(child.id)),
            onChildSelectToggle: (child, _parent, row) => {
                const id = String(child.id);
                const next = !selectedEntryIds.has(id);
                if (next) selectedEntryIds.add(id);
                else selectedEntryIds.delete(id);
                row.classList.toggle('is-selected', next);
                syncBulk();
            },
            renderParentMeta: (parent, metaEl) => {
                const badge = el('span', 'nd-muted');
                setText(badge, kindLabel(parent.kind));
                metaEl.append(
                    badge,
                    createMiniAction({
                        label: '＋条目',
                        onClick: () => void openEntryEditor(null, String(parent.id), parent),
                    }),
                    createMiniAction({
                        label: '编辑库',
                        onClick: () => void openLibraryEditor(parent),
                    }),
                    createMiniAction({
                        label: '删除库',
                        danger: true,
                        onClick: () => void removeLibrary(parent),
                    }),
                );
            },
            renderChild: (child, row) => {
                if (child.active === false) {
                    row.classList.add('is-disabled');
                }
                const entryToggle = createToggle({
                    label: '',
                    checked: child.active !== false,
                    onChange: (enabled) => void toggleEntry(child, enabled),
                });
                entryToggle.el.classList.add('nd-nested-list__enable');
                const entryInput = entryToggle.el.querySelector('input');
                if (entryInput) {
                    entryInput.setAttribute('aria-label', '启用条目');
                }
                row.appendChild(entryToggle.el);
                paintNestedChildTexts(row, {
                    primary: String(child.key ?? ''),
                    secondary: String(child.value ?? ''),
                });
                const actions = el('div', 'nd-row-actions');
                const parent = store.get().libraries.find((l) => String(l.id) === String(child.libraryId));
                actions.append(
                    createMiniAction({
                        label: '编辑',
                        onClick: () => void openEntryEditor(child, String(child.libraryId), parent),
                    }),
                    createMiniAction({
                        label: '删除',
                        danger: true,
                        onClick: () => void removeEntry(child),
                    }),
                );
                row.append(actions);
            },
            virtualizeChildren: true,
            virtualThreshold: 48,
            childRowHeight: NESTED_CHILD_ROW_HEIGHT,
            virtualListHeight: 320,
        });
    }

    async function refresh() {
        if (destroyed) return;
        const libraries = await awaitRepo(host, repo.listLibraries(), '读取标签库失败');
        if (!libraries) return;
        /** @type {Map<string, object[]>} */
        const byLib = new Map();
        for (const lib of libraries) {
            const entries = await awaitRepo(host, repo.listEntries(lib.id), '读取条目失败') || [];
            byLib.set(String(lib.id), entries);
        }
        store.set((s) => ({ ...s, libraries, byLib }));
        pruneSelection();
        remountList();
    }

    async function toggleEntry(entry, enabled) {
        const next = applyFormFields(entry, {
            active: Boolean(enabled),
            updatedAt: ids.now(),
        });
        if (await awaitRepo(host, repo.put(next), '保存失败')) await refresh();
    }

    async function toggleLibrary(lib, enabled) {
        const next = applyFormFields(lib, {
            active: Boolean(enabled),
            updatedAt: ids.now(),
        });
        if (await awaitRepo(host, repo.putLibrary(next), '保存失败')) await refresh();
    }

    async function removeLibrary(lib) {
        const ok = await confirmDanger(deps, `删除标签库「${lib.name}」及全部条目？`);
        if (!ok) return;
        await awaitRepo(host, repo.removeLibrary(lib.id), '删除失败');
        await refresh();
    }

    async function removeEntry(entry) {
        const ok = await confirmDanger(deps, `删除条目「${entry.key}」？`);
        if (!ok) return;
        await awaitRepo(host, repo.remove(entry.id), '删除失败');
        await refresh();
    }

    /**
     * @param {object|null} lib
     */
    async function openLibraryEditor(lib) {
        const nameField = createField({ label: '库名称', value: lib?.name ?? '' });
        const kindSelect = createSelect({
            label: '库类型',
            value: normalizeTagLibraryKind(lib?.kind),
            options: [
                { value: 'composition', label: '构图库' },
                { value: 'feature', label: '特征库' },
                { value: 'constant', label: '常驻库' },
            ],
        });
        const activeToggle = createToggle({
            label: '激活',
            checked: lib ? lib.active !== false : true,
        });
        const form = el('div', 'nd-form');
        form.append(nameField.el, kindSelect.el, activeToggle.el);
        const modal = await openFormModal(deps, lib ? '编辑标签库' : '新建标签库', form);
        const actions = el('div', 'nd-form__actions');
        actions.append(
            createButton({ label: '取消', variant: 'ghost', onClick: () => modal.destroy() }),
            createButton({
                label: '保存',
                variant: 'primary',
                onClick: async () => {
                    const name = nameField.getValue().trim();
                    if (!name) {
                        modal.setError('请填写库名称');
                        return;
                    }
                    const kind = normalizeTagLibraryKind(kindSelect.getValue());
                    const entity = lib
                        ? applyFormFields(lib, {
                            name,
                            kind,
                            active: activeToggle.getValue(),
                            updatedAt: ids.now(),
                        })
                        : createTagLibrary(
                            { name, kind, active: activeToggle.getValue() },
                            { id: ids.id('tl'), now: ids.now() },
                        );
                    if (await awaitRepo(host, repo.putLibrary(entity), '保存失败')) {
                        modal.destroy();
                        toast(host, 'success', '已保存');
                        await refresh();
                    }
                },
            }),
        );
        (modal.footer || form).appendChild(actions);
    }

    /**
     * @param {object|null} entry
     * @param {string} libraryId
     * @param {object} [library]
     */
    async function openEntryEditor(entry, libraryId, library) {
        const lib = library
            || store.get().libraries.find((l) => String(l.id) === String(libraryId));
        const kind = normalizeTagLibraryKind(lib?.kind);
        const form = el('div', 'nd-form');
        const activeToggle = createToggle({
            label: '启用',
            checked: entry ? entry.active !== false : true,
        });
        const valueField = labeledTextarea('内容', entry?.value ?? '', 4);

        /** @type {(() => { ok: true, value: string } | { ok: false, error: { message: string } })|null} */
        let resolveKey = null;
        /** @type {(() => { ok: true, value: Record<string, string> } | { ok: false, error: { message: string } })|null} */
        let resolveSecondary = null;
        /** @type {(() => void)|null} */
        let refreshKeyPreview = null;

        if (kind === 'composition') {
            const parsed = entry?.key ? parseCompositionKey(entry.key) : null;
            const fields = parsed?.ok
                ? parsed.value
                : { category: '', name: '' };

            const categoryField = createField({
                label: '分类',
                value: fields.category,
                onChange: () => refreshKeyPreview?.(),
            });
            const nameField = createField({
                label: '名称',
                value: fields.name,
                onChange: () => refreshKeyPreview?.(),
            });

            const keyPreview = el('div', 'nd-field');
            const keyLabel = el('span', 'nd-field__label');
            setText(keyLabel, 'key');
            const keyText = el('div', 'nd-key-preview');
            keyPreview.append(keyLabel, keyText);

            resolveKey = () => composeCompositionKey({
                category: categoryField.getValue(),
                name: nameField.getValue(),
            });
            refreshKeyPreview = () => {
                const composed = resolveKey();
                if (composed.ok) {
                    keyText.classList.remove('nd-key-preview--error');
                    setText(keyText, composed.value);
                } else {
                    keyText.classList.add('nd-key-preview--error');
                    setText(keyText, composed.error.message);
                }
            };
            refreshKeyPreview();
            form.append(
                categoryField.el,
                nameField.el,
                keyPreview,
                valueField.el,
            );
        } else {
            const keyField = createField({
                label: keyFieldLabel(kind),
                value: entry?.key ?? '',
            });
            resolveKey = () => {
                const key = keyField.getValue().trim();
                if (!key) {
                    return {
                        ok: false,
                        error: {
                            message: kind === 'feature' ? '请填写触发关键字' : '请填写条目名',
                        },
                    };
                }
                return { ok: true, value: key };
            };
            form.append(keyField.el);

            if (kind === 'feature') {
                const secondaryKeyField = createField({
                    label: '次要关键字',
                    value: entry?.secondaryKey ?? '',
                    placeholder: '可选，写法同触发关键字',
                    onChange: () => syncSecondaryLogic(),
                });
                const secondaryLogicSelect = createSelect({
                    label: '方式',
                    value: entry?.secondaryLogic === 'all' ? 'all' : 'any',
                    options: [
                        { value: 'any', label: '且涉及任意' },
                        { value: 'all', label: '且涉及全部' },
                    ],
                });
                function syncSecondaryLogic() {
                    const has = secondaryKeyField.getValue().trim().length > 0;
                    secondaryLogicSelect.setDisabled(!has);
                }
                syncSecondaryLogic();
                resolveSecondary = () => {
                    const secondaryKey = secondaryKeyField.getValue();
                    if (!secondaryKey.trim()) {
                        return { ok: true, value: {} };
                    }
                    const secondary = normalizeTagEntrySecondary({
                        secondaryKey,
                        secondaryLogic: secondaryLogicSelect.getValue(),
                    });
                    if (!secondary.ok) {
                        return { ok: false, error: { message: secondary.error.message } };
                    }
                    return { ok: true, value: secondary.value };
                };
                form.append(secondaryKeyField.el, secondaryLogicSelect.el);
            }

            form.append(valueField.el);
        }
        form.append(activeToggle.el);

        const modal = await openFormModal(deps, entry ? '编辑标签条目' : '新建标签条目', form);
        const actions = el('div', 'nd-form__actions');
        actions.append(
            createButton({ label: '取消', variant: 'ghost', onClick: () => modal.destroy() }),
            createButton({
                label: '保存',
                variant: 'primary',
                onClick: async () => {
                    const keyResult = resolveKey ? resolveKey() : { ok: false, error: { message: '请填写 key' } };
                    if (!keyResult.ok) {
                        modal.setError(keyResult.error.message);
                        return;
                    }
                    const writing = validateTagEntryWriting(kind, keyResult.value, valueField.getValue());
                    if (!writing.ok) {
                        modal.setError(writing.error.message);
                        return;
                    }
                    /** @type {Record<string, string>} */
                    let secondaryFields = {};
                    if (resolveSecondary) {
                        const secondaryResult = resolveSecondary();
                        if (!secondaryResult.ok) {
                            modal.setError(secondaryResult.error.message);
                            return;
                        }
                        secondaryFields = secondaryResult.value;
                    }
                    const entity = entry
                        ? (() => {
                            const next = applyFormFields(entry, {
                                key: writing.value.key,
                                value: writing.value.value,
                                active: activeToggle.getValue(),
                                updatedAt: ids.now(),
                                ...secondaryFields,
                            });
                            if (!secondaryFields.secondaryKey) {
                                delete next.secondaryKey;
                                delete next.secondaryLogic;
                            }
                            return next;
                        })()
                        : createTagEntry(
                            {
                                libraryId,
                                key: writing.value.key,
                                value: writing.value.value,
                                active: activeToggle.getValue(),
                                ...secondaryFields,
                            },
                            { id: ids.id('te'), now: ids.now() },
                        );
                    if (await awaitRepo(host, repo.put(entity), '保存失败')) {
                        modal.destroy();
                        toast(host, 'success', '已保存');
                        await refresh();
                    }
                },
            }),
        );
        (modal.footer || form).appendChild(actions);
    }

    /**
     * @param {'import'|'export'} [mode]
     */
    async function openImport(mode = 'import') {
        await openImportExportModal(
            deps,
            mode === 'export' ? '导出标签库' : '导入标签库',
            'tag',
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
            typeof repo.onChanged === 'function' ? undefined : () => void refresh(),
            {
                mode,
                exportCategory: '标签库',
                countOverwrite: (rows) => countOverwriteByIds(rows, () => {
                    const ids = [];
                    for (const list of store.get().byLib.values()) {
                        for (const entry of list || []) {
                            if (entry?.id != null) ids.push(String(entry.id));
                        }
                    }
                    return ids;
                }),
            },
        );
    }

    cleanups.push(bindSelectionOutsideExit(shell, {
        isActive: () => selectionMode,
        onExit: () => setSelectionModeUi(false),
    }));

    if (typeof repo.onChanged === 'function') {
        cleanups.push(repo.onChanged(() => void refresh()));
    }
    cleanups.push(store.subscribe(() => {
        if (!destroyed) remountList();
    }));

    void refresh();

    return {
        destroy() {
            if (destroyed) return;
            destroyed = true;
            for (const fn of cleanups) fn();
            nested?.destroy();
            toolbar.destroy();
            err.destroy();
            shell.remove();
        },
    };
}
