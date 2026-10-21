/**
 * L4 应用层 · 步骤 4–5：视点块 + 构图召回 + 提示词 LLM + 写 slot。
 * 归属：W2-F / 代理 A。
 *
 * 裁决：
 * - D31：返回 unmatchedKeys / discardedAnchors
 * - D37：先 slotRepo.put，再 replaceMessageText（避免孤儿 token）
 * - D38：put 时保留已有 images，绝不抹掉已出图记录
 * - D41：用 tagRecall.llmCalled 计数，禁止改写共享 llm.complete
 * - D54：写锁在本 usecase（键 chatId:messageId）；同键并发共享 Promise；导出 isWriting
 *
 * 无纠错时为召回、提示词各 1 次；校验失败后的追加调用由各自预设配置。
 * 无构图候选仍调召回；召回失败不降级。
 */

import { Ok, Err } from '../infra/result.js';
import { configError, contractError, domainError } from '../infra/errors.js';
import { createLogger } from '../infra/logger.js';
import { createBlockSet, setBlock } from '../domain/blocks/block-set.js';
import { VARIABLE_NAMES } from '../domain/template/variable-map.js';
import { formatCompositionBlock } from '../domain/blocks/composition.block.js';
import { formatRecentSlotsBlock } from '../domain/blocks/recent-slots.block.js';
import { renderPreset } from '../domain/template/preset-renderer.js';
import { placeSlots } from '../domain/slot/slot-placer.js';
import { createSlotRecord, slotCaptionFromLlmItem } from '../domain/model/slot.js';
import { parseFlatSlotPlans } from '../domain/model/flat-imagegen.js';
import { completePresetRequest } from './preset-completion.js';
import { validateImagegenOutput } from './preset-output-validation.js';
import { recordLatestGeneration, recordParseFailure } from './parse-debug-log.js';
import {
    abortErrIfNeeded,
    attachTraceId,
    extractSlotPlanItems,
    APP_EVENTS,
} from './_helpers.js';
import { writeGateKey } from './_gate-key.js';

const log = createLogger('application/generate-slots');

/**
 * @typedef {import('../domain/model/plugin-settings.js').PluginSettings} PluginSettings
 */

/**
 * @typedef {object} GenerateSlotsDeps
 * @property {import('../ports/host.port.js').HostPort} host
 * @property {import('../ports/llm.port.js').LlmPort} llm
 * @property {import('../ports/repository.port.js').CharacterRepository} [characterRepo]
 * @property {import('../ports/repository.port.js').TagRepository} [tagRepo]
 * @property {import('../ports/repository.port.js').Repository<import('../domain/model/preset.js').Preset>} presetRepo
 * @property {import('../ports/repository.port.js').SlotRepository} slotRepo
 * @property {import('../ports/repository.port.js').Repository<import('../domain/model/api-config.js').LlmApiConfig>} llmConfigRepo
 * @property {ReturnType<import('./context-collector.js').createContextCollector>} [contextCollector]
 * @property {ReturnType<import('./worldinfo-resolver.js').createWorldInfoResolver>} [worldInfoResolver]
 * @property {ReturnType<import('./viewpoint-blocks.js').createViewpointBlocksBuilder>} viewpointBlocks
 * @property {ReturnType<import('./tag-recall.service.js').createTagRecallService>} tagRecall
 * @property {ReturnType<import('../infra/event-bus.js').createEventBus>} bus
 * @property {() => PluginSettings} loadSettings
 * @property {(template: string) => string} runHostMacros
 * @property {() => string} newId
 * @property {() => string} nowIso
 * @property {() => string} newTraceId
 */

/**
 * @typedef {object} GenerateSlotsOptions
 * @property {AbortSignal} [signal]
 * @property {string} [traceId]
 */

/**
 * @typedef {object} GenerateSlotsResult
 * @property {import('../domain/model/slot.js').SlotRecord[]} records
 * @property {string} traceId
 * @property {number} llmCallCount
 * @property {string[]} unmatchedKeys
 * @property {string[]} discardedAnchors
 * @property {number[]} extraSlotIds 提示词多出的 slotid（已丢弃）
 * @property {number[]} missingSlotIds 召回有、提示词缺少的 slotid（未写）
 */

/**
 * @param {GenerateSlotsDeps} deps
 * @returns {{
 *   execute: (messageId: number, opts?: GenerateSlotsOptions) => Promise<import('../infra/result.js').Ok<GenerateSlotsResult>|import('../infra/result.js').Err<import('../infra/errors.js').AppError>>,
 *   isWriting: (messageId: number) => boolean,
 * }}
 */
export function createGenerateSlotsUseCase(deps) {
    /** @type {Map<string, Promise<import('../infra/result.js').Ok<GenerateSlotsResult>|import('../infra/result.js').Err<import('../infra/errors.js').AppError>>>} */
    const inflight = new Map();

    /**
     * @param {number} messageId
     * @returns {string}
     */
    function currentWriteKey(messageId) {
        return writeGateKey(deps.host.getCurrentChatId(), messageId);
    }

    /**
     * @param {number} messageId
     * @param {GenerateSlotsOptions} [opts]
     */
    async function runOnce(messageId, opts) {
            const traceId = opts?.traceId ?? deps.newTraceId();
            const signal = opts?.signal;
            /** @type {number} */
            let llmCallCount = 0;
            const chatIdAtStart = deps.host.getCurrentChatId();
            const sessionIdAtStart = typeof deps.host.getSessionId === 'function'
                ? deps.host.getSessionId()
                : null;
            const messagesAtStart = typeof deps.host.getMessages === 'function'
                ? deps.host.getMessages()
                : [];
            const locationAtStart = typeof deps.host.getChatLocation === 'function'
                ? deps.host.getChatLocation()
                : null;

            const aborted0 = abortErrIfNeeded(signal, traceId);
            if (aborted0) {
                return aborted0;
            }

            const settings = deps.loadSettings();

            // ── 1–3. 视点块（世界书 / 上下文 / 角色库 / 特征参考 / 常驻标签）──
            const vpR = await deps.viewpointBlocks.build({
                messageId,
                signal,
                traceId,
            });
            if (!vpR.ok) {
                return attachTraceId(vpR, traceId);
            }
            const {
                worldInfoText,
                contextText,
                characterText,
                featureText,
                constantText,
            } = vpR.value;
            const worldInfoSnapshot = worldInfoText;

            const mes = deps.host.getMessage(messageId);
            if (!mes) {
                return Err(domainError({
                    code: 'MESSAGE_NOT_FOUND',
                    message: `找不到楼层 #${messageId}`,
                    hint: '请确认当前聊天仍打开且该楼存在',
                    traceId,
                    context: { messageId },
                }));
            }
            const targetFloorText = String(mes.text ?? '');

            const aborted1 = abortErrIfNeeded(signal, traceId);
            if (aborted1) {
                return aborted1;
            }

            // ── 4. 构图召回 ★LLM #1（无候选也必须调；失败不降级）──
            const tagR = await deps.tagRecall.recall({
                contextText,
                targetFloorText,
                traceId,
                signal,
            });
            if (!tagR.ok) {
                if (tagR.error?.context?.llmCalled === true) {
                    llmCallCount += tagR.error.context.llmCallCount ?? 1;
                }
                return attachTraceId(tagR, traceId);
            }
            if (tagR.value.llmCalled) {
                llmCallCount += tagR.value.llmCallCount ?? 1;
            }

            const positions = tagR.value.positions ?? [];
            /** @type {string[]} */
            const unmatchedKeys = tagR.value.unmatchedKeys ?? [];
            /** @type {string[]} */
            const discardedAnchors = tagR.value.discardedAnchors ?? [];

            if (unmatchedKeys.length > 0 || discardedAnchors.length > 0) {
                deps.bus.emit(APP_EVENTS.TAG_RECALL_UNMATCHED, {
                    messageId,
                    traceId,
                    unmatchedKeys,
                    discardedAnchors,
                    matchedCount: positions.reduce((n, p) => n + (p.entries?.length ?? 0), 0),
                    positionCount: positions.length,
                });
            }

            const compositionText = formatCompositionBlock(positions);

            // 近期生图记录：保留范围内已有 slot，排除本轮召回将写的 slotid
            const excludeIds = new Set(positions.map((p) => Number(p.slotId)));
            let recentSlotsText = '';
            const retainedR = await deps.slotRepo.listRetained();
            if (!retainedR.ok) {
                return attachTraceId(retainedR, traceId);
            }
            recentSlotsText = formatRecentSlotsBlock(
                retainedR.value.filter((r) => r && !excludeIds.has(Number(r.slotId))),
            );

            let blocks = createBlockSet();
            blocks = setBlock(blocks, VARIABLE_NAMES.WORLDINFO, worldInfoText);
            blocks = setBlock(blocks, VARIABLE_NAMES.CONTEXT, contextText);
            blocks = setBlock(blocks, VARIABLE_NAMES.CHARACTER, characterText);
            blocks = setBlock(blocks, VARIABLE_NAMES.COMPOSITION, compositionText);
            blocks = setBlock(blocks, VARIABLE_NAMES.FEATURE, featureText);
            blocks = setBlock(blocks, VARIABLE_NAMES.CONSTANT, constantText);
            blocks = setBlock(blocks, VARIABLE_NAMES.RECENT_SLOTS, recentSlotsText);

            // ── 5. 生图预设 + 提示词 LLM ★LLM #2 ─────────────────────
            if (!settings.promptGenLlmConfigId) {
                return Err(configError({
                    code: 'PROMPT_LLM_UNSET',
                    message: '未选择提示词生成用的 LLM 配置',
                    hint: '请在运行配置中为「提示词生成」选定 LLM',
                    traceId,
                }));
            }
            if (!settings.activeImagegenPresetId) {
                return Err(configError({
                    code: 'IMAGEGEN_PRESET_UNSET',
                    message: '未选择生图预设',
                    hint: '请先编写并选中一份生图预设',
                    traceId,
                }));
            }

            const llmCfgR = await deps.llmConfigRepo.get(settings.promptGenLlmConfigId);
            if (!llmCfgR.ok) {
                return attachTraceId(llmCfgR, traceId);
            }
            if (!llmCfgR.value) {
                return Err(configError({
                    code: 'PROMPT_LLM_MISSING',
                    message: '提示词生成 LLM 配置不存在',
                    hint: '请重新选择提示词生成用的 LLM',
                    traceId,
                    context: { id: settings.promptGenLlmConfigId },
                }));
            }

            const presetR = await deps.presetRepo.get(settings.activeImagegenPresetId);
            if (!presetR.ok) {
                return attachTraceId(presetR, traceId);
            }
            if (!presetR.value || presetR.value.kind !== 'imagegen') {
                return Err(configError({
                    code: 'IMAGEGEN_PRESET_MISSING',
                    message: '生图预设不存在或类型不对',
                    hint: '请选择一份生图预设',
                    traceId,
                    context: { id: settings.activeImagegenPresetId },
                }));
            }

            const messages = renderPreset(presetR.value, blocks, {
                runHostMacros: deps.runHostMacros,
                omitWorkbenchOnly: true,
            });

            const aborted2 = abortErrIfNeeded(signal, traceId);
            if (aborted2) {
                return aborted2;
            }

            const promptR = await completePresetRequest({
                llm: deps.llm, preset: presetR.value, stage: '生图',
                validate: (response) => validateImagegenOutput(response, { expectedSlotIds: positions.map((p) => p.slotId) }),
                request: {
                    messages,
                    config: llmCfgR.value,
                    signal,
                    traceId,
                },
            });
            llmCallCount += promptR.ok ? promptR.value.llmCallCount : (promptR.error.context?.llmCallCount ?? 0);
            if (!promptR.ok) {
                if (promptR.error?.context?.rawText != null && !promptR.error.context.outputValidationRecorded) {
                    recordParseFailure({
                        stage: '生图',
                        code: promptR.error.code,
                        message: promptR.error.message,
                        rawText: promptR.error.context.rawText,
                    });
                }
                return attachTraceId(promptR, traceId);
            }

            const imagegenRawText = promptR.value.text;
            const flatItems = parseFlatSlotPlans(imagegenRawText);
            const items = flatItems.length > 0
                ? flatItems
                : extractSlotPlanItems(promptR.value.json);
            if (items.length === 0) {
                recordParseFailure({
                    stage: '生图',
                    code: 'SLOT_PLAN_EMPTY',
                    message: '提示词生成未产出有效的生图计划',
                    rawText: imagegenRawText,
                });
                return Err(contractError({
                    code: 'SLOT_PLAN_EMPTY',
                    message: '提示词生成未产出有效的生图计划',
                    hint: '请检查生图预设与模型是否按约定输出 JSON 数组',
                    traceId,
                    context: { rawText: imagegenRawText, json: promptR.value.json },
                }));
            }

            /** @type {Map<number, string>} */
            const anchorBySlot = new Map();
            for (const pos of positions) {
                anchorBySlot.set(Number(pos.slotId), String(pos.anchorSentence ?? ''));
            }
            const expectedIds = new Set(anchorBySlot.keys());

            /** @type {import('../domain/model/slot.js').SlotPlan[]} */
            const plans = [];
            /** @type {number[]} */
            const extraSlotIds = [];
            /** @type {Set<number>} */
            const seenSlotIds = new Set();

            for (const item of items) {
                const cr = slotCaptionFromLlmItem(item);
                if (!cr.ok) {
                    recordParseFailure({
                        stage: '生图',
                        code: cr.error?.code,
                        message: cr.error?.message,
                        rawText: imagegenRawText,
                    });
                    return attachTraceId(cr, traceId);
                }
                const { slotId, caption, size, analysis } = cr.value;
                if (!expectedIds.has(slotId)) {
                    extraSlotIds.push(slotId);
                    continue;
                }
                if (seenSlotIds.has(slotId)) {
                    continue;
                }
                seenSlotIds.add(slotId);
                // 模型即使回了生成点也忽略；anchor 一律取召回结果
                /** @type {import('../domain/model/slot.js').SlotPlan} */
                const plan = {
                    slotId,
                    anchorSentence: anchorBySlot.get(slotId) ?? '',
                    caption,
                };
                if (size != null) {
                    plan.size = size;
                }
                if (analysis != null) {
                    plan.analysis = analysis;
                }
                plans.push(plan);
            }

            /** @type {number[]} */
            const missingSlotIds = [...expectedIds].filter((id) => !seenSlotIds.has(id));

            if (plans.length === 0) {
                recordParseFailure({
                    stage: '生图',
                    code: 'SLOT_PLAN_NO_VALID',
                    message: '提示词未能对应到任何召回结果',
                    rawText: imagegenRawText,
                });
                return Err(contractError({
                    code: 'SLOT_PLAN_NO_VALID',
                    message: '提示词未能对应到任何召回结果',
                    hint: '模型应按召回结果写提示词，不得增减张数',
                    traceId,
                    context: {
                        rawText: imagegenRawText,
                        extraSlotIds,
                        missingSlotIds,
                        expectedSlotIds: [...expectedIds],
                    },
                }));
            }

            recordLatestGeneration({
                stage: '生图',
                ok: true,
                message: '已生成',
                rawText: imagegenRawText,
            });

            if (extraSlotIds.length > 0 || missingSlotIds.length > 0) {
                log.warn('slot plan slotid mismatch', {
                    traceId,
                    extraSlotIds,
                    missingSlotIds,
                });
            }

            // D38：读取已有记录，保留 images（绝不用空数组抹掉）
            /** @type {Map<number, import('../domain/model/slot.js').SlotRecord>} */
            const existingById = new Map();
            const existingR = await deps.slotRepo.getByMessage(messageId);
            if (!existingR.ok) {
                log.warn('getByMessage failed before put; abort write', {
                    traceId,
                    messageId,
                    code: existingR.error?.code,
                });
                return attachTraceId(existingR, traceId);
            }
            for (const rec of existingR.value) {
                existingById.set(rec.slotId, rec);
            }

            const now = deps.nowIso();
            /** @type {import('../domain/model/slot.js').SlotRecord[]} */
            const records = plans.map((plan) => {
                const prev = existingById.get(plan.slotId);
                /** @type {Parameters<typeof createSlotRecord>[0]} */
                const input = {
                    messageId,
                    slotId: plan.slotId,
                    caption: plan.caption,
                    anchorSentence: plan.anchorSentence,
                    images: prev?.images ?? [],
                    presetId: settings.activeImagegenPresetId,
                    llmConfigId: settings.promptGenLlmConfigId,
                    worldInfoSnapshot,
                    traceId,
                };
                if (plan.size != null) {
                    input.size = plan.size;
                }
                if (plan.analysis != null) {
                    input.analysis = plan.analysis;
                }
                return createSlotRecord(input, { now });
            });

            // D37：先写权威记录，再改正文；切会话时仍落到发起时的会话文件
            const putOpts = sessionIdAtStart
                ? {
                    sessionId: String(sessionIdAtStart),
                    messagesForTrim: messagesAtStart,
                    chatLocation: locationAtStart,
                }
                : { messagesForTrim: messagesAtStart, chatLocation: locationAtStart };
            const putR = await deps.slotRepo.put(messageId, records, putOpts);
            if (!putR.ok) {
                return attachTraceId(putR, traceId);
            }

            const chatNow = deps.host.getCurrentChatId();
            const sessionNow = typeof deps.host.getSessionId === 'function'
                ? deps.host.getSessionId()
                : null;
            const stillSameChat = chatNow === chatIdAtStart
                && (sessionIdAtStart == null || sessionNow === sessionIdAtStart);

            /** @type {ReturnType<typeof placeSlots>|null} */
            let placed = null;
            if (stillSameChat) {
                placed = placeSlots(mes.text ?? '', plans);
                const replaceR = await deps.host.replaceMessageText(messageId, placed.text);
                if (!replaceR.ok) {
                    return attachTraceId(replaceR, traceId);
                }
            } else {
                log.warn('chat/session changed after put; records saved, body not updated', {
                    traceId,
                    chatIdAtStart,
                    chatNow,
                    sessionIdAtStart,
                    sessionNow,
                    messageId,
                });
            }

            deps.bus.emit(APP_EVENTS.SLOTS_WRITTEN, {
                messageId,
                records,
                traceId,
                llmCallCount,
                unmatchedKeys,
                discardedAnchors,
                extraSlotIds,
                missingSlotIds,
                placements: placed?.placements ?? [],
                chatChanged: !stillSameChat,
            });

            if (llmCallCount !== 2) {
                log.info('generation completed with output corrections', { traceId, llmCallCount });
            }

            return Ok({
                records,
                traceId,
                llmCallCount,
                unmatchedKeys,
                discardedAnchors,
                extraSlotIds,
                missingSlotIds,
                chatChanged: !stillSameChat,
            });
    }

    return {
        /**
         * D54：同键并发共享同一 Promise（手点 + 自动写只跑一轮 LLM）。
         * @param {number} messageId
         * @param {GenerateSlotsOptions} [opts]
         */
        execute(messageId, opts) {
            if (deps.isEditing?.(messageId)) return Promise.resolve(Err(domainError({
                code: 'SLOT_EDITOR_BUSY', message: '本楼提示词正在保存，请稍后再试',
            })));
            const key = currentWriteKey(messageId);
            const existing = inflight.get(key);
            if (existing) {
                return existing;
            }
            const promise = runOnce(messageId, opts).finally(() => {
                if (inflight.get(key) === promise) {
                    inflight.delete(key);
                }
            });
            inflight.set(key, promise);
            return promise;
        },

        /**
         * 供 UI / 装配层禁用「生图」按钮（D54）。
         * @param {number} messageId
         * @returns {boolean}
         */
        isWriting(messageId) {
            return inflight.has(currentWriteKey(messageId));
        },
    };
}
