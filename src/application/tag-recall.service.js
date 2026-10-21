/**
 * L4 应用层 · 构图库召回：传构图 key，回位置数组（生成点 + key），校验失败按预设纠错重试。
 * 张数与生成点由召回决定；无构图候选时仍必须调 LLM（模型只定位置）。
 * 召回失败 / 全部位置丢弃 → Err（不降级）。无纠错时为楼中两阶段 LLM 的第 1 次。
 *
 * 裁决 D31：unmatchedKeys + discardedAnchors 上浮到结果与 bus 事件。
 */

import { Ok, Err } from '../infra/result.js';
import { configError, contractError } from '../infra/errors.js';
import { createLogger } from '../infra/logger.js';
import { createBlockSet, setBlock } from '../domain/blocks/block-set.js';
import { VARIABLE_NAMES } from '../domain/template/variable-map.js';
import { renderPreset } from '../domain/template/preset-renderer.js';
import { recordLatestGeneration, recordParseFailure } from './parse-debug-log.js';
import { completePresetRequest } from './preset-completion.js';
import { validateRecallOutput } from './preset-output-validation.js';
import { formatRecallCandidateLines, reconcileRecalledIds } from '../domain/matching/tag-recall.js';
import { findAnchorInsertIndex } from '../domain/slot/slot-placer.js';
import {
    allocateSlotIdsAfterMax,
    findLatestFloorMaxSlotId,
} from '../domain/slot/slot-id.js';
import { normalizeTagLibraryKind } from '../domain/model/tag.js';
import {
    abortErrIfNeeded,
    attachTraceId,
    extractRecalledPositions,
    RECALL_CANDIDATE_KEYS_VAR,
    RECALL_POSITIONS_JSON_SCHEMA,
} from './_helpers.js';

const log = createLogger('application/tag-recall');

/**
 * @typedef {import('../domain/model/plugin-settings.js').PluginSettings} PluginSettings
 * @typedef {import('../domain/model/tag.js').TagEntry} TagEntry
 * @typedef {import('../domain/blocks/composition.block.js').CompositionPosition} CompositionPosition
 */

/**
 * @typedef {object} TagRecallDeps
 * @property {import('../ports/llm.port.js').LlmPort} llm
 * @property {import('../ports/repository.port.js').TagRepository} tagRepo
 * @property {import('../ports/repository.port.js').Repository<import('../domain/model/preset.js').Preset>} presetRepo
 * @property {import('../ports/repository.port.js').Repository<import('../domain/model/api-config.js').LlmApiConfig>} llmConfigRepo
 * @property {() => PluginSettings} loadSettings
 * @property {(template: string) => string} runHostMacros
 * @property {import('../ports/host.port.js').HostPort} [host]
 *   有则按需求 4.7 从最新带 slot 的楼（含全部 swipe）取 max+1 分配；无则从 1 起（单测兜底）
 */

/**
 * @typedef {object} TagRecallInput
 * @property {string} contextText 当前上下文
 * @property {string} targetFloorText 目标楼正文（校验生成点；与 placeSlots 同源）
 * @property {string[]} [libraryIds] 工作台可覆盖本次勾选的库；缺省用全局已激活构图库
 * @property {string} [userDesc] 楼内流程的用户输入，替换预设里的 {{用户描述}}
 * @property {boolean} [omitWorkbenchOnly] 缺省跳过工作台专用段；对外接口传 false 则带上
 * @property {string} [traceId]
 * @property {AbortSignal} [signal]
 */

/**
 * 裁决 D31：召回结果。注入只用 positions；unmatchedKeys / discardedAnchors 必须交给上层。
 * @typedef {object} TagRecallResult
 * @property {CompositionPosition[]} positions 已分配会话内唯一 slotid
 * @property {string[]} unmatchedKeys
 * @property {string[]} discardedAnchors 生成点在目标楼匹配不到而被丢弃的原文
 * @property {number} llmCallCount 本阶段调用次数，含结果纠错重试
 * @property {boolean} llmCalled
 *   裁决 D41：是否实际调用了 llm.complete（供 generateSlots 计数，禁止改写 port）
 */

/**
 * 从宿主取新→旧楼层的全部 swipe 正文，供编号分配。
 * @param {import('../ports/host.port.js').HostPort|undefined} host
 * @returns {Array<{ texts: string[] }>}
 */
function floorsNewestFirstFromHost(host) {
    if (!host || typeof host.getMessages !== 'function') {
        return [];
    }
    const messages = host.getMessages();
    /** @type {Array<{ texts: string[] }>} */
    const floors = [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const m = messages[i];
        if (!m) {
            continue;
        }
        let texts;
        if (typeof host.getMessageSwipeTexts === 'function') {
            texts = host.getMessageSwipeTexts(m.messageId);
        } else {
            texts = [String(m.text ?? '')];
        }
        floors.push({ texts });
    }
    return floors;
}

/**
 * @param {TagRecallDeps} deps
 * @returns {{ recall: (input: TagRecallInput) => Promise<import('../infra/result.js').Ok<TagRecallResult>|import('../infra/result.js').Err<import('../infra/errors.js').AppError>> }}
 */
export function createTagRecallService(deps) {
    return {
        /**
         * @param {TagRecallInput} input
         */
        async recall(input) {
            const traceId = input?.traceId;
            const aborted = abortErrIfNeeded(input?.signal, traceId);
            if (aborted) {
                return aborted;
            }

            const settings = deps.loadSettings();
            const libsR = await deps.tagRepo.listLibraries();
            if (!libsR.ok) {
                return attachTraceId(libsR, traceId);
            }

            /** @type {Set<string>|null} */
            let overrideIds = null;
            if (Array.isArray(input.libraryIds)) {
                overrideIds = new Set(input.libraryIds.map(String));
            }

            // 候选只取 active && kind==='composition'；特征库不进请求
            const activeLibs = libsR.value.filter((lib) => {
                if (!lib) {
                    return false;
                }
                if (normalizeTagLibraryKind(lib.kind) !== 'composition') {
                    return false;
                }
                if (overrideIds) {
                    return overrideIds.has(lib.id);
                }
                return lib.active === true;
            });

            /** @type {TagEntry[]} */
            const activeEntries = [];
            for (const lib of activeLibs) {
                const er = await deps.tagRepo.listEntries(lib.id);
                if (!er.ok) {
                    return attachTraceId(er, traceId);
                }
                activeEntries.push(...er.value.filter((entry) => entry && entry.active !== false));
            }

            const { lines: candidateLines, ordered: orderedEntries } = formatRecallCandidateLines(activeEntries);

            // 无候选也必须调召回：张数与生成点由模型决定（需求 §3 / 4.11）
            if (!settings.recallLlmConfigId) {
                return Err(configError({
                    code: 'RECALL_LLM_UNSET',
                    message: '未选择标签召回用的 LLM 配置',
                    hint: '请在运行配置中为「标签召回」选定 LLM',
                    traceId: traceId ?? null,
                }));
            }
            if (!settings.activeRecallPresetId) {
                return Err(configError({
                    code: 'RECALL_PRESET_UNSET',
                    message: '未选择召回预设',
                    hint: '请先编写并选中一份召回预设',
                    traceId: traceId ?? null,
                }));
            }

            const configR = await deps.llmConfigRepo.get(settings.recallLlmConfigId);
            if (!configR.ok) {
                return attachTraceId(configR, traceId);
            }
            if (!configR.value) {
                return Err(configError({
                    code: 'RECALL_LLM_MISSING',
                    message: '标签召回 LLM 配置不存在',
                    hint: '请重新选择召回用的 LLM 配置',
                    traceId: traceId ?? null,
                    context: { id: settings.recallLlmConfigId },
                }));
            }

            const presetR = await deps.presetRepo.get(settings.activeRecallPresetId);
            if (!presetR.ok) {
                return attachTraceId(presetR, traceId);
            }
            if (!presetR.value || presetR.value.kind !== 'recall') {
                return Err(configError({
                    code: 'RECALL_PRESET_MISSING',
                    message: '召回预设不存在或类型不对',
                    hint: '请选择一份召回预设',
                    traceId: traceId ?? null,
                    context: { id: settings.activeRecallPresetId },
                }));
            }

            let blocks = createBlockSet();
            blocks = setBlock(blocks, VARIABLE_NAMES.CONTEXT, String(input.contextText ?? ''));
            blocks = setBlock(blocks, '最后一楼', String(input.targetFloorText ?? ''));
            blocks = setBlock(blocks, VARIABLE_NAMES.USER_DESC, String(input.userDesc ?? ''));
            blocks = setBlock(blocks, RECALL_CANDIDATE_KEYS_VAR, candidateLines.join('\n'));

            const messages = renderPreset(presetR.value, blocks, {
                runHostMacros: deps.runHostMacros,
                omitWorkbenchOnly: input?.omitWorkbenchOnly !== false,
            });

            const aborted2 = abortErrIfNeeded(input?.signal, traceId);
            if (aborted2) {
                return aborted2;
            }

            const llmR = await completePresetRequest({
                llm: deps.llm, preset: presetR.value, stage: '召回',
                validate: (response) => validateRecallOutput(response, { targetFloorText: String(input.targetFloorText ?? '') }),
                request: {
                    messages,
                    config: configR.value,
                    jsonSchema: RECALL_POSITIONS_JSON_SCHEMA,
                    signal: input?.signal,
                    traceId,
                },
            });
            if (!llmR.ok) {
                const err = attachTraceId(llmR, traceId);
                if (err.error?.context?.rawText != null && !err.error.context.outputValidationRecorded) {
                    recordParseFailure({
                        stage: '召回',
                        code: err.error.code,
                        message: err.error.message,
                        rawText: err.error.context.rawText,
                    });
                }
                if (err.error) {
                    err.error.context = {
                        ...(err.error.context ?? {}),
                        llmCalled: true,
                    };
                }
                return err;
            }

            const recallRawText = llmR.value.text;
            const extracted = extractRecalledPositions(llmR.value.json, recallRawText);
            if (extracted.status === 'legacy-key-list') {
                recordParseFailure({
                    stage: '召回',
                    code: 'RECALL_LEGACY_FORMAT',
                    message: '召回预设输出格式已过时',
                    rawText: recallRawText,
                });
                return Err(contractError({
                    code: 'RECALL_LEGACY_FORMAT',
                    message: '召回预设输出格式已过时',
                    hint: '请改用内置召回预设，或按同样格式输出生成位置',
                    traceId: traceId ?? null,
                    context: { rawText: llmR.value.text, json: llmR.value.json, llmCalled: true },
                }));
            }
            if (extracted.status === 'empty' || extracted.positions.length === 0) {
                recordParseFailure({
                    stage: '召回',
                    code: 'RECALL_NO_POSITIONS',
                    message: '标签召回未产出任何生成位置',
                    rawText: recallRawText,
                });
                return Err(contractError({
                    code: 'RECALL_NO_POSITIONS',
                    message: '标签召回未产出任何生成位置',
                    hint: '请检查召回预设是否要求模型输出生成位置',
                    traceId: traceId ?? null,
                    context: { rawText: llmR.value.text, json: llmR.value.json, llmCalled: true },
                }));
            }
            if (extracted.status === 'invalid') {
                recordParseFailure({
                    stage: '召回',
                    code: 'RECALL_FORMAT_INVALID',
                    message: '标签召回结果格式无效',
                    rawText: recallRawText,
                });
                return Err(contractError({
                    code: 'RECALL_FORMAT_INVALID',
                    message: '标签召回结果格式无效',
                    hint: '请检查召回预设与模型输出是否包含生成点与构图关键字',
                    traceId: traceId ?? null,
                    context: { rawText: llmR.value.text, json: llmR.value.json, llmCalled: true },
                }));
            }

            const targetFloorText = String(input.targetFloorText ?? '');
            /** @type {CompositionPosition[]} */
            const positions = [];
            /** @type {string[]} */
            const unmatchedKeys = [];
            /** @type {string[]} */
            const discardedAnchors = [];

            for (const raw of extracted.positions) {
                const anchor = String(raw.anchorSentence ?? '');
                const found = findAnchorInsertIndex(targetFloorText, anchor);
                if (found.index < 0) {
                    discardedAnchors.push(anchor);
                    continue;
                }
                const { matched, unmatched } = reconcileRecalledIds(raw.keys, orderedEntries);
                unmatchedKeys.push(...unmatched);
                positions.push({
                    slotId: 0, // 稍后按会话唯一规则分配
                    anchorSentence: anchor,
                    entries: matched,
                });
            }

            if (discardedAnchors.length > 0 || unmatchedKeys.length > 0) {
                log.warn('tag recall discarded / unmatched', {
                    traceId,
                    discardedAnchors,
                    unmatchedKeys,
                    keptPositions: positions.length,
                });
            }

            if (positions.length === 0) {
                recordParseFailure({
                    stage: '召回',
                    code: 'RECALL_ALL_POSITIONS_DISCARDED',
                    message: '召回的全部生成点都无法在目标楼正文中匹配',
                    rawText: recallRawText,
                });
                return Err(contractError({
                    code: 'RECALL_ALL_POSITIONS_DISCARDED',
                    message: '召回的全部生成点都无法在目标楼正文中匹配',
                    hint: '生成点必须是目标楼某一段的最后一句原文；请检查召回预设与楼层正文',
                    traceId: traceId ?? null,
                    context: {
                        discardedAnchors,
                        unmatchedKeys,
                        llmCalled: true,
                    },
                }));
            }

            const maxExisting = findLatestFloorMaxSlotId(floorsNewestFirstFromHost(deps.host));
            const ids = allocateSlotIdsAfterMax(maxExisting, positions.length);
            for (let i = 0; i < positions.length; i += 1) {
                positions[i].slotId = ids[i];
            }

            recordLatestGeneration({
                stage: '召回',
                ok: true,
                message: '已生成',
                rawText: recallRawText,
            });
            return Ok({
                positions,
                unmatchedKeys,
                discardedAnchors,
                llmCalled: true,
                llmCallCount: llmR.value.llmCallCount,
            });
        },
    };
}
