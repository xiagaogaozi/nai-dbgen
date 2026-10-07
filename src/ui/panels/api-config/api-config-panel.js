/**
 * L5 UI · LLM / NAI API 库 管理面板。
 * LLM：酒馆「自定义（兼容 OpenAI）」+ API 密钥；生成参数留空不发送。
 */

import {
    createButton,
    createCombobox,
    createDetails,
    createField,
    createSegmentedTabs,
    createSelect,
    createTextarea,
} from '../../common/controls.js';
import {
    createLlmApiConfig,
    createNaiApiConfig,
    DEFAULT_NAI_BASE_URL,
    isOptionalHttpUrl,
    LLM_PARAM_RANGES,
    llmConfigHasKey,
    llmSecretLabel,
} from '../../../domain/model/api-config.js';
import { mountLibraryView } from '../library-view.js';
import { applyFormFields } from '../_lib/library-logic.js';
import {
    el,
    setText,
    idNow,
    settingsApi,
    confirmDanger,
    openImportExportModal,
    openFormModal,
    awaitRepo,
    toast,
    toastError,
} from '../_lib/panel-kit.js';
import { isOk } from '../../../infra/result.js';
import {
    formatBalanceDetail,
    formatBalanceSummary,
} from '../../../domain/nai/subscription-balance.js';

const PARAM_HINT = '留空则不发送，由接口使用默认值';
const API_KIND_STORAGE_KEY = 'nai-dbgen:api-kind';

const REASONING_OPTIONS = [
    { value: '', label: '不发送' },
    { value: 'min', label: '极低' },
    { value: 'low', label: '低' },
    { value: 'medium', label: '中' },
    { value: 'high', label: '高' },
    { value: 'max', label: '极高' },
];

const POST_PROCESSING_OPTIONS = [
    { value: '', label: '未选择' },
    { value: 'merge_tools', label: '合并相同角色连续的发言（含工具）' },
    { value: 'semi_tools', label: '半严格（强制对话角色交替）（含工具）' },
    { value: 'strict_tools', label: '严格（强制对话角色交替、用户最先）（含工具）' },
    { value: 'merge', label: '合并相同角色连续的发言' },
    { value: 'semi', label: '半严格（强制对话角色交替）' },
    { value: 'strict', label: '严格（强制对话角色交替、用户最先）' },
    { value: 'single', label: '单一用户消息（无工具）' },
];

/**
 * @param {Element} root
 * @param {object} deps repos / services / host / bus / llm
 * @returns {{ destroy: () => void }}
 */
export function mountApiConfigPanel(root, deps) {
    if (!(root instanceof Element)) {
        throw new Error('mountApiConfigPanel: root must be an Element');
    }
    const llmRepo = deps?.repos?.llmConfig;
    const naiRepo = deps?.repos?.naiConfig;
    if (!llmRepo || !naiRepo) {
        throw new Error('mountApiConfigPanel: deps.repos.llmConfig / naiConfig required');
    }

    const host = deps.host;
    const llm = deps.llm;
    const imageGenPort = deps.imageGenPort ?? null;
    const llmSecrets = deps.services?.llmSecrets ?? null;
    /** @type {Map<string, { fp: string, summary: string, detail: string }>} */
    const balanceCache = new Map();
    /** @type {Set<string>} */
    const balanceInflight = new Set();
    const ids = idNow(deps);
    const settings = settingsApi(deps);

    const shell = el('div', 'nd-panel nd-panel--api');
    const listHost = el('div', 'nd-subpanel');

    /** @type {ReturnType<typeof mountLibraryView>|null} */
    let view = null;
    /** @type {(() => void)[]} */
    const cleanups = [];
    let destroyed = false;
    let viewEpoch = 0;

    const segments = createSegmentedTabs({
        ariaLabel: 'API 库类型',
        storageKey: API_KIND_STORAGE_KEY,
        items: [
            { id: 'llm', label: 'LLM API 库' },
            { id: 'nai', label: 'NAI API 库' },
        ],
        onChange: () => mountCurrentView(),
    });
    shell.append(segments.el, listHost);
    root.appendChild(shell);

    function mountCurrentView() {
        viewEpoch += 1;
        view?.destroy();
        view = null;
        const kind = segments.getValue() === 'nai' ? 'nai' : 'llm';
        if (kind === 'llm') {
            view = mountLibraryView(listHost, {
                list: async () => {
                    const items = await awaitRepo(host, llmRepo.list(), '读取 LLM API 失败') || [];
                    const s = settings.load();
                    return items.map((item) => ({
                        ...item,
                        __active:
                            (s.recallLlmConfigId != null && String(s.recallLlmConfigId) === String(item.id))
                            || (s.promptGenLlmConfigId != null && String(s.promptGenLlmConfigId) === String(item.id)),
                        __chips: [
                            s.recallLlmConfigId != null && String(s.recallLlmConfigId) === String(item.id)
                                ? '召回'
                                : null,
                            s.promptGenLlmConfigId != null && String(s.promptGenLlmConfigId) === String(item.id)
                                ? '提示词'
                                : null,
                        ].filter(Boolean),
                        __key: llmConfigHasKey(item) ? '已填 Key' : '未填 Key',
                    }));
                },
                onCreate: () => void openLlmEditor(null),
                onEdit: (item) => void openLlmEditor(item),
                onDelete: (idList) => void removeLlm(idList),
                onImport: () => void openImport(llmRepo, 'llm-config', '导入 LLM API', () => view?.refresh(), 'import'),
                onExport: () => void openImport(llmRepo, 'llm-config', '导出 LLM API', () => view?.refresh(), 'export'),
            }, {
                cover: false,
                searchKeys: ['name', 'model', 'baseUrl'],
                cardMeta: (item) => ({
                    subtitle: String(item?.model || '').trim() || undefined,
                    chips: Array.isArray(item?.__chips) ? item.__chips : [],
                    status: item?.__key != null ? String(item.__key) : undefined,
                }),
            });
        } else {
            view = mountLibraryView(listHost, {
                list: async () => {
                    const items = await awaitRepo(host, naiRepo.list(), '读取 NAI API 失败') || [];
                    const activeId = settings.load().activeNaiConfigId;
                    const mapped = items.map((item) => {
                        const cached = balanceCache.get(String(item.id));
                        const fresh = cached && cached.fp === balanceFingerprint(item) ? cached.summary : '';
                        return {
                            ...item,
                            __active: activeId != null && String(activeId) === String(item.id),
                            __chips: [
                                activeId != null && String(activeId) === String(item.id) ? '当前使用' : null,
                                fresh || null,
                            ].filter(Boolean),
                            __key: String(item?.apiKey ?? '').trim() ? '已填 Key' : '未填 Key',
                        };
                    });
                    void ensureBalances(items);
                    return mapped;
                },
                onCreate: () => void openNaiEditor(null),
                onEdit: (item) => void openNaiEditor(item),
                onDelete: (idList) => void removeNai(idList),
                onImport: () => void openImport(naiRepo, 'nai-config', '导入 NAI API', () => view?.refresh(), 'import'),
                onExport: () => void openImport(naiRepo, 'nai-config', '导出 NAI API', () => view?.refresh(), 'export'),
            }, {
                cover: false,
                searchKeys: ['name', 'baseUrl'],
                cardMeta: (item) => {
                    const url = String(item?.baseUrl || '').trim();
                    const transport = item?.transport === 'st-cors-proxy' ? '酒馆 CORS 代理' : '直连';
                    const subtitle = [url, transport].filter(Boolean).join(' · ') || undefined;
                    return {
                        subtitle,
                        chips: Array.isArray(item?.__chips) ? item.__chips : [],
                        status: item?.__key != null ? String(item.__key) : undefined,
                    };
                },
            });
        }
    }

    mountCurrentView();

    /**
     * 打开 NAI 库后查询每条已填密钥的电量与点数。命中缓存则不再请求。
     * @param {object[]} items
     */
    async function ensureBalances(items) {
        if (destroyed) return;
        if (!imageGenPort || typeof imageGenPort.fetchSubscription !== 'function') return;
        const epoch = viewEpoch;
        /** @type {{ item: object, fp: string, key: string }[]} */
        const pending = [];
        for (const item of items) {
            if (!String(item?.apiKey ?? '').trim() || item?.id == null) continue;
            const fp = balanceFingerprint(item);
            const cached = balanceCache.get(String(item.id));
            if (cached && cached.fp === fp) continue;
            const key = `${item.id}:${fp}`;
            if (balanceInflight.has(key)) continue;
            balanceInflight.add(key);
            pending.push({ item, fp, key });
        }
        if (!pending.length) return;
        await Promise.all(pending.map(async ({ item, fp, key }) => {
            try {
                const result = await imageGenPort.fetchSubscription(item);
                if (destroyed || epoch !== viewEpoch) return;
                if (isOk(result)) {
                    balanceCache.set(String(item.id), {
                        fp,
                        summary: formatBalanceSummary(result.value),
                        detail: formatBalanceDetail(result.value),
                    });
                } else {
                    balanceCache.set(String(item.id), {
                        fp,
                        summary: '余额未知',
                        detail: result.error?.message || '查询失败',
                    });
                }
            } catch (error) {
                if (!destroyed && epoch === viewEpoch) {
                    balanceCache.set(String(item.id), {
                        fp,
                        summary: '余额未知',
                        detail: error instanceof Error ? error.message : '查询失败',
                    });
                }
            } finally {
                balanceInflight.delete(key);
            }
        }));
        if (!destroyed && epoch === viewEpoch) await view?.refresh();
    }

    /**
     * @param {object} repo
     * @param {string} expectedKind
     * @param {string} title
     * @param {() => void} onDone
     * @param {'import'|'export'} [mode]
     */
    async function openImport(repo, expectedKind, title, onDone, mode = 'import') {
        await openImportExportModal(
            deps,
            title,
            expectedKind,
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
            onDone,
            { mode },
        );
    }

    /**
     * @param {string[]} idList
     */
    async function removeLlm(idList) {
        const ok = await confirmDanger(deps, `删除 ${idList.length} 条 LLM API？将同时删除对应密钥。`);
        if (!ok) return;
        const s = settings.load();
        for (const id of idList) {
            const existing = await awaitRepo(host, llmRepo.get(id), '读取失败');
            if (existing?.secretId && llmSecrets) {
                const del = await llmSecrets.deleteById(existing.secretId);
                if (!del.ok) {
                    toastError(host, del.error, '删除密钥失败');
                }
            }
            await awaitRepo(host, llmRepo.remove(id), '删除失败');
            /** @type {Record<string, unknown>} */
            const patch = {};
            if (s.recallLlmConfigId != null && String(s.recallLlmConfigId) === String(id)) {
                patch.recallLlmConfigId = null;
            }
            if (s.promptGenLlmConfigId != null && String(s.promptGenLlmConfigId) === String(id)) {
                patch.promptGenLlmConfigId = null;
            }
            if (Object.keys(patch).length) settings.patch(patch);
        }
        await view?.refresh();
    }

    /**
     * @param {string[]} idList
     */
    async function removeNai(idList) {
        const ok = await confirmDanger(deps, `删除 ${idList.length} 条 NAI API？`);
        if (!ok) return;
        for (const id of idList) {
            await awaitRepo(host, naiRepo.remove(id), '删除失败');
            if (settings.load().activeNaiConfigId != null
                && String(settings.load().activeNaiConfigId) === String(id)) {
                settings.patch({ activeNaiConfigId: null });
            }
        }
        await view?.refresh();
    }

    /**
     * @param {object|null} item
     */
    async function openLlmEditor(item) {
        if (!llmSecrets) {
            toast(host, 'error', '无法管理 API 密钥，请确认插件在酒馆页面内加载');
            return;
        }

        /** @type {string|null} */
        let secretId = item?.secretId ? String(item.secretId) : null;
        /** @type {string[]} */
        let sessionCreatedSecretIds = [];
        /** @type {string|null} */
        let pendingDeleteSecretId = null;

        const nameField = createField({ label: '名称', value: item?.name ?? '' });
        const urlField = createField({
            label: '接口地址',
            value: item?.baseUrl ?? '',
            placeholder: '例如 https://api.example.com/v1',
        });
        const keyField = createField({
            label: 'API 密钥',
            value: '',
            placeholder: secretId ? '已保存（留空表示不更换）' : '粘贴 API 密钥',
            type: 'password',
        });
        if (secretId) {
            const masked = await llmSecrets.getMasked(secretId);
            if (isOk(masked) && masked.value?.value) {
                keyField.setValue('');
                keyField.el.querySelector('input')?.setAttribute(
                    'placeholder',
                    `已保存：${masked.value.value}`,
                );
            }
        }

        const fetchModelsBtn = createButton({
            label: '获取模型',
            variant: 'ghost',
            onClick: () => void fetchModels(),
        });
        const modelCombo = createCombobox({
            label: '模型',
            value: item?.model ?? '',
            placeholder: '输入筛选或手填；获取后可从列表选择',
            options: [],
            trailing: fetchModelsBtn,
        });

        const testBtn = createButton({
            label: '测试连接',
            variant: 'ghost',
            onClick: () => void testConnection(),
        });
        const modelActions = el('div', 'nd-form__row');
        modelActions.append(testBtn);

        const statusLine = el('p', 'nd-muted');
        setText(statusLine, '');

        const genHint = el('p', 'nd-muted');
        setText(genHint, PARAM_HINT);

        const tempField = numField('温度', item?.temperature, LLM_PARAM_RANGES.temperature, 0.01);
        const topPField = numField('Top P', item?.topP, LLM_PARAM_RANGES.topP, 0.01);
        const topKField = numField('Top K', item?.topK, LLM_PARAM_RANGES.topK, 1);
        const maxTokField = numField('最大回复长度', item?.maxTokens, LLM_PARAM_RANGES.maxTokens, 1);
        const presField = numField('存在惩罚', item?.presencePenalty, LLM_PARAM_RANGES.presencePenalty, 0.01);
        const freqField = numField('频率惩罚', item?.frequencyPenalty, LLM_PARAM_RANGES.frequencyPenalty, 0.01);
        const seedField = numField('随机种子', item?.seed, LLM_PARAM_RANGES.seed, 1);
        const stopField = createTextarea({
            label: '停止序列',
            value: Array.isArray(item?.stop) ? item.stop.join('\n') : '',
            placeholder: '每行一条；留空则不发送',
            rows: 2,
        });
        const reasoningSelect = createSelect({
            label: '推理强度',
            value: item?.reasoningEffort ?? '',
            options: REASONING_OPTIONS,
        });

        const includeBody = createTextarea({
            label: '追加请求体',
            value: item?.customIncludeBody ?? '',
            placeholder: '示例：\ntop_k: 20\nrepetition_penalty: 1.1',
            rows: 4,
        });
        const excludeBody = createTextarea({
            label: '排除请求体字段',
            value: item?.customExcludeBody ?? '',
            placeholder: '示例：\n- frequency_penalty\n- presence_penalty',
            rows: 3,
        });
        const includeHeaders = createTextarea({
            label: '附加请求头',
            value: item?.customIncludeHeaders ?? '',
            placeholder: '示例：\nX-Custom-Header: value',
            rows: 3,
        });
        const postSelect = createSelect({
            label: '提示词后处理',
            value: item?.customPromptPostProcessing ?? '',
            options: POST_PROCESSING_OPTIONS,
        });

        const connGroup = el('div', 'nd-form__group');
        const connTitle = el('h3', 'nd-form__group-title');
        setText(connTitle, '连接');
        connGroup.append(
            connTitle,
            nameField.el,
            urlField.el,
            keyField.el,
            modelCombo.el,
            modelActions,
            statusLine,
        );

        const genGroup = el('div', 'nd-form__group');
        const genTitle = el('h3', 'nd-form__group-title');
        setText(genTitle, '生成参数');
        genGroup.append(
            genTitle,
            genHint,
            tempField.el,
            topPField.el,
            topKField.el,
            maxTokField.el,
            presField.el,
            freqField.el,
            seedField.el,
            stopField.el,
            reasoningSelect.el,
        );

        const advBody = el('div');
        advBody.append(includeBody.el, excludeBody.el, includeHeaders.el, postSelect.el);
        const adv = createDetails({ summary: '高级', body: advBody, open: false });

        const form = el('div', 'nd-form');
        form.append(connGroup, genGroup, adv.el);

        const modal = await openFormModal(deps, item ? '编辑 LLM API' : '新建 LLM API', form);

        const actions = el('div', 'nd-form__actions');
        actions.append(
            createButton({
                label: '取消',
                variant: 'ghost',
                onClick: () => void cancelEditor(),
            }),
            createButton({
                label: '用于召回',
                variant: 'ghost',
                onClick: async () => {
                    const saved = await saveLlm();
                    if (!saved) return;
                    settings.patch({ recallLlmConfigId: saved.id });
                    toast(host, 'success', '已设为召回用 LLM');
                    await view?.refresh();
                },
            }),
            createButton({
                label: '用于提示词',
                variant: 'ghost',
                onClick: async () => {
                    const saved = await saveLlm();
                    if (!saved) return;
                    settings.patch({ promptGenLlmConfigId: saved.id });
                    toast(host, 'success', '已设为提示词生成用 LLM');
                    await view?.refresh();
                },
            }),
            createButton({
                label: '保存',
                variant: 'primary',
                onClick: async () => {
                    if (await saveLlm()) {
                        sessionCreatedSecretIds = [];
                        modal.destroy();
                        toast(host, 'success', '已保存');
                        await view?.refresh();
                    }
                },
            }),
        );
        form.appendChild(actions);

        /**
         * @param {string} label
         * @param {unknown} value
         * @param {{ min: number, max: number }} range
         * @param {number} step
         */
        function numField(label, value, range, step) {
            return createField({
                label,
                type: 'number',
                value: value == null ? '' : String(value),
                min: range.min,
                max: range.max,
                step,
                placeholder: '留空',
            });
        }

        /**
         * 确保有可用 secretId：表单有新密钥则写入（尽量不切换酒馆主界面当前连接）。
         * @returns {Promise<string|null>}
         */
        async function ensureSecretId() {
            const typed = keyField.getValue().trim();
            if (typed) {
                const label = llmSecretLabel(nameField.getValue().trim() || '未命名配置');
                // 先写新、暂不删旧：取消编辑时可丢掉临时密钥并保留原 Key
                const written = await llmSecrets.writePreservingActive({ value: typed, label });
                if (!written.ok) {
                    modal.setError(written.error?.message || '写入 API 密钥失败');
                    toastError(host, written.error, '写入 API 密钥失败');
                    return null;
                }
                if (written.value.wasFirstSecret) {
                    setText(
                        statusLine,
                        '说明：酒馆「自定义（兼容 OpenAI）」原先没有 API 密钥，现在会使用本条密钥作为该连接的密钥。',
                    );
                }
                if (secretId && secretId !== written.value.id) {
                    pendingDeleteSecretId = secretId;
                }
                secretId = written.value.id;
                sessionCreatedSecretIds.push(secretId);
                keyField.setValue('');
                keyField.el.querySelector('input')?.setAttribute(
                    'placeholder',
                    '已写入 API 密钥（可再填以更换）',
                );
                return secretId;
            }
            if (secretId) {
                return secretId;
            }
            return null;
        }

        /**
         * @returns {Promise<object|null>}
         */
        function currentApiKey() {
            const typed = keyField.getValue().trim();
            if (typed) {
                return typed;
            }
            return String(item?.apiKey || '').trim();
        }

        async function buildDraftConfig() {
            const apiKey = currentApiKey();
            if (!apiKey) {
                modal.setError('请先填写 API 密钥');
                return null;
            }
            const baseUrl = urlField.getValue().trim();
            if (!baseUrl) {
                modal.setError('请填写接口地址');
                return null;
            }
            if (!isOptionalHttpUrl(baseUrl)) {
                modal.setError('接口地址须为 http(s) 绝对地址');
                return null;
            }
            return {
                name: nameField.getValue().trim() || '未命名配置',
                baseUrl,
                apiKey,
                secretId: secretId || item?.secretId || null,
                model: modelCombo.getValue().trim() || 'probe',
                customIncludeHeaders: includeHeaders.getValue().trim() || undefined,
            };
        }

        async function fetchModels() {
            modal.setError('');
            setText(statusLine, '正在获取模型…');
            const draft = await buildDraftConfig();
            if (!draft) return;
            if (!llm || typeof llm.listModels !== 'function') {
                modal.setError('当前环境无法拉取模型列表');
                return;
            }
            const result = await llm.listModels(draft);
            if (!isOk(result)) {
                setText(statusLine, result.error?.message || '获取模型失败');
                toastError(host, result.error, '获取模型失败');
                return;
            }
            modelCombo.setOptions(result.value.models.map((id) => ({ value: id, label: id })));
            setText(statusLine, `已获取 ${result.value.count} 个模型`);
            if (modelCombo.getValue().trim() === 'probe') {
                modelCombo.setValue('');
            }
            modelCombo.open();
        }

        async function testConnection() {
            setText(statusLine, '正在测试连接…');
            const draft = await buildDraftConfig();
            if (!draft) return;
            if (!llm || typeof llm.probe !== 'function') {
                modal.setError('当前环境无法测试连接');
                return;
            }
            const report = await llm.probe(draft);
            if (report.ok) {
                setText(statusLine, report.detail || '连接成功');
                toast(host, 'success', report.detail || '连接成功');
                if (Array.isArray(report.context?.models)) {
                    modelCombo.setOptions(
                        report.context.models.map((id) => ({ value: id, label: id })),
                    );
                }
            } else {
                setText(statusLine, report.detail || report.error?.message || '连接失败');
                toastError(host, report.error || report.detail, '连接失败');
            }
        }

        async function cancelEditor() {
            // 取消时清理本会话写入但未保存到配置的密钥
            const keep = item?.secretId ? String(item.secretId) : null;
            for (const sid of sessionCreatedSecretIds) {
                if (sid && sid !== keep) {
                    const del = await llmSecrets.deleteById(sid);
                    if (!del.ok) {
                        toastError(host, del.error, '清理临时密钥失败');
                    }
                }
            }
            modal.destroy();
        }

        async function saveLlm() {
            const name = nameField.getValue().trim();
            const baseUrl = urlField.getValue().trim();
            const model = modelCombo.getValue().trim();
            const apiKey = currentApiKey();
            if (!name) {
                modal.setError('请填写名称');
                return null;
            }
            if (!isOptionalHttpUrl(baseUrl)) {
                modal.setError('接口地址须为 http(s) 绝对地址');
                return null;
            }

            const sid = await ensureSecretId();
            // 允许先不填密钥保存（调用时再报错）；但若用户填了则必须写入成功
            if (keyField.getValue().trim() && !sid) {
                return null;
            }
            const finalSecretId = sid || secretId || null;

            if (finalSecretId && name) {
                const renamed = await llmSecrets.rename({
                    id: finalSecretId,
                    label: llmSecretLabel(name),
                });
                if (!renamed.ok) {
                    toastError(host, renamed.error, '更新密钥名称失败');
                }
            }

            /** @type {Record<string, unknown>} */
            const fields = {
                name,
                baseUrl,
                apiKey,
                secretId: finalSecretId,
                model,
                temperature: emptyToUndef(tempField.getValue()),
                topP: emptyToUndef(topPField.getValue()),
                topK: emptyToUndef(topKField.getValue()),
                maxTokens: emptyToUndef(maxTokField.getValue()),
                presencePenalty: emptyToUndef(presField.getValue()),
                frequencyPenalty: emptyToUndef(freqField.getValue()),
                seed: emptyToUndef(seedField.getValue()),
                stop: stopField.getValue(),
                reasoningEffort: reasoningSelect.getValue(),
                customIncludeBody: includeBody.getValue().trim(),
                customExcludeBody: excludeBody.getValue().trim(),
                customIncludeHeaders: includeHeaders.getValue().trim(),
                customPromptPostProcessing: postSelect.getValue(),
            };

            const entity = createLlmApiConfig(
                fields,
                {
                    id: item?.id || ids.id('llm'),
                    now: ids.now(),
                },
            );
            if (item) {
                entity.createdAt = item.createdAt || entity.createdAt;
                entity.updatedAt = ids.now();
            }

            const validated = await llmRepo.put(entity);
            if (!validated.ok) {
                modal.setError(validated.error?.message || '保存失败');
                toastError(host, validated.error, '保存失败');
                return null;
            }
            if (pendingDeleteSecretId && pendingDeleteSecretId !== validated.value.secretId) {
                const delOld = await llmSecrets.deleteById(pendingDeleteSecretId);
                if (!delOld.ok) {
                    toastError(host, delOld.error, '删除旧密钥失败');
                }
                pendingDeleteSecretId = null;
            }
            secretId = validated.value.secretId;
            sessionCreatedSecretIds = sessionCreatedSecretIds.filter((id) => id === secretId);
            return validated.value;
        }

        const baseDestroy = modal.destroy.bind(modal);
        modal.destroy = () => {
            nameField.destroy();
            urlField.destroy();
            keyField.destroy();
            modelCombo.destroy();
            fetchModelsBtn.remove();
            testBtn.remove();
            tempField.destroy();
            topPField.destroy();
            topKField.destroy();
            maxTokField.destroy();
            presField.destroy();
            freqField.destroy();
            seedField.destroy();
            stopField.destroy();
            reasoningSelect.destroy();
            includeBody.destroy();
            excludeBody.destroy();
            includeHeaders.destroy();
            postSelect.destroy();
            adv.destroy();
            baseDestroy();
        };
    }

    /**
     * @param {object|null} item
     */
    async function openNaiEditor(item) {
        const nameField = createField({ label: '名称', value: item?.name ?? '' });
        const urlField = createField({
            label: '接口地址',
            value: item?.baseUrl ?? (item ? '' : DEFAULT_NAI_BASE_URL),
        });
        const keyField = createField({ label: 'API 密钥', value: item?.apiKey ?? '' });
        const transport = createSelect({
            label: '传输方式',
            value: item?.transport === 'st-cors-proxy' ? 'st-cors-proxy' : 'direct',
            options: [
                { value: 'direct', label: '直连' },
                { value: 'st-cors-proxy', label: '酒馆 CORS 代理' },
            ],
        });
        const decoder = createSelect({
            label: '解码',
            value: item?.decoder === 'json' || item?.decoder === 'zip' ? item.decoder : 'auto',
            options: [
                { value: 'auto', label: '自动' },
                { value: 'json', label: 'JSON' },
                { value: 'zip', label: 'ZIP' },
            ],
        });
        const balanceBox = el('div', 'nd-field');
        const balanceLabel = el('span', 'nd-field__label');
        setText(balanceLabel, '电量与点数');
        const balanceLine = el('p', 'nd-key-preview');
        balanceLine.setAttribute('aria-live', 'polite');
        const cachedBalance = item?.id != null ? balanceCache.get(String(item.id)) : null;
        setText(
            balanceLine,
            cachedBalance && cachedBalance.fp === balanceFingerprint(item)
                ? cachedBalance.detail
                : '尚未查询',
        );
        const balanceHint = el('span', 'nd-field-hint nd-muted');
        setText(balanceHint, '电量是 Opus 的 V5 用量，点数是 Anlas（订阅剩余 + 购买）。');
        balanceBox.append(balanceLabel, balanceLine, balanceHint);
        const form = el('div', 'nd-form');
        form.append(nameField.el, urlField.el, keyField.el, transport.el, decoder.el, balanceBox);
        const modal = await openFormModal(deps, item ? '编辑 NAI API' : '新建 NAI API', form);
        let querying = false;
        const actions = el('div', 'nd-form__actions');
        actions.append(
            createButton({
                label: '查询电量与点数',
                variant: 'ghost',
                onClick: () => void queryBalance(),
            }),
            createButton({ label: '取消', variant: 'ghost', onClick: () => modal.destroy() }),
            createButton({
                label: '设为当前',
                variant: 'ghost',
                onClick: async () => {
                    const saved = await saveNai();
                    if (!saved) return;
                    settings.patch({ activeNaiConfigId: saved.id });
                    toast(host, 'success', '已设为当前 NAI');
                    await view?.refresh();
                },
            }),
            createButton({
                label: '保存',
                variant: 'primary',
                onClick: async () => {
                    if (await saveNai()) {
                        modal.destroy();
                        toast(host, 'success', '已保存');
                        await view?.refresh();
                    }
                },
            }),
        );
        form.appendChild(actions);

        async function saveNai() {
            const name = nameField.getValue().trim();
            const baseUrl = urlField.getValue().trim();
            if (!name) {
                modal.setError('请填写名称');
                return null;
            }
            if (!isOptionalHttpUrl(baseUrl)) {
                modal.setError('接口地址须为 http(s) 绝对地址');
                return null;
            }
            const entity = item
                ? applyFormFields(item, {
                    name,
                    baseUrl,
                    apiKey: keyField.getValue(),
                    transport: transport.getValue() === 'st-cors-proxy' ? 'st-cors-proxy' : 'direct',
                    decoder: decoder.getValue(),
                    updatedAt: ids.now(),
                })
                : createNaiApiConfig(
                    {
                        name,
                        baseUrl,
                        apiKey: keyField.getValue(),
                        transport: transport.getValue(),
                        decoder: decoder.getValue(),
                    },
                    { id: ids.id('nai'), now: ids.now() },
                );
            return awaitRepo(host, naiRepo.put(entity), '保存失败');
        }

        async function queryBalance() {
            if (querying) return;
            if (!imageGenPort || typeof imageGenPort.fetchSubscription !== 'function') {
                setText(balanceLine, '当前环境无法查询余额');
                return;
            }
            const draft = {
                ...(item || {}),
                name: nameField.getValue().trim() || item?.name || '未命名',
                baseUrl: urlField.getValue().trim(),
                apiKey: keyField.getValue(),
                transport: transport.getValue() === 'st-cors-proxy' ? 'st-cors-proxy' : 'direct',
            };
            querying = true;
            setText(balanceLine, '查询中…');
            modal.setError('');
            try {
                const result = await imageGenPort.fetchSubscription(draft);
                if (!isOk(result)) {
                    setText(balanceLine, result.error?.message || '查询失败');
                    return;
                }
                const detail = formatBalanceDetail(result.value);
                setText(balanceLine, detail);
                if (item?.id != null) {
                    balanceCache.set(String(item.id), {
                        fp: balanceFingerprint(draft),
                        summary: formatBalanceSummary(result.value),
                        detail,
                    });
                    await view?.refresh();
                }
            } finally {
                querying = false;
            }
        }
    }

    if (typeof llmRepo.onChanged === 'function') {
        cleanups.push(llmRepo.onChanged(() => void view?.refresh()));
    }
    if (typeof naiRepo.onChanged === 'function') {
        cleanups.push(naiRepo.onChanged(() => void view?.refresh()));
    }

    return {
        destroy() {
            if (destroyed) return;
            destroyed = true;
            for (const fn of cleanups) fn();
            view?.destroy();
            view = null;
            segments.destroy();
            shell.remove();
        },
    };
}

/**
 * @param {string} raw
 * @returns {string|undefined}
 */
/**
 * 缓存键不含密钥原文。
 * @param {object|null|undefined} config
 * @returns {string}
 */
function balanceFingerprint(config) {
    const key = String(config?.apiKey ?? '');
    let hash = 2166136261;
    for (let i = 0; i < key.length; i += 1) {
        hash ^= key.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return [
        String(config?.baseUrl ?? '').trim(),
        config?.transport === 'st-cors-proxy' ? 'st-cors-proxy' : 'direct',
        String(hash >>> 0),
        String(key.length),
    ].join('\n');
}

function emptyToUndef(raw) {
    const t = String(raw ?? '').trim();
    return t === '' ? undefined : t;
}
