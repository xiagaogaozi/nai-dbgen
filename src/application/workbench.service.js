/**
 * L4 应用层 · 生成工作台两个解耦功能：写提示词 / 用当前提示词出图。
 * 归属：W2-F / 代理 A。
 *
 * 裁决 D13：工作台提示词为结构化 NaiCaption（base_caption + char_captions）。
 * 勾选条目：不跑召回，只把勾中条目交给生图预设。
 * 楼内流程：用户输入只通过 {{用户描述}} 进入召回预设和生图预设。模型回了多份就全部留下，工作台编辑框仍显示第一份。
 * 这是工作台调用，预设里勾了「工作台专用」的段会带上。悬浮球双击楼内生图不走这里。
 * 只传 libraryIds、不传 entryIds 时仍按整库已启用条目注入（旧调用）。
 */

import { Ok, Err } from '../infra/result.js';
import { configError, contractError, domainError } from '../infra/errors.js';
import { createLogger } from '../infra/logger.js';
import { newId } from '../infra/id.js';
import { createBlockSet, setBlock } from '../domain/blocks/block-set.js';
import { VARIABLE_NAMES } from '../domain/template/variable-map.js';
import { formatCharacterBlock } from '../domain/blocks/character.block.js';
import { formatCompositionBlock, formatSingleCompositionBlock } from '../domain/blocks/composition.block.js';
import { formatPromptReferenceGroups, formatRecentSlotsBlock } from '../domain/blocks/recent-slots.block.js';
import { selectRecentPromptGroups } from '../domain/blocks/recent-prompt-calls.js';
import { formatFeatureBlock } from '../domain/blocks/feature.block.js';
import { formatConstantBlock } from '../domain/blocks/constant.block.js';
import { activateCharacters } from '../domain/matching/activation.js';
import { normalizeTagLibraryKind } from '../domain/model/tag.js';
import { renderPreset } from '../domain/template/preset-renderer.js';
import { validateNaiCaption, captionHasPromptText } from '../domain/model/nai-params.js';
import { attachReferenceImage } from '../domain/llm/reverse-prompt.js';
import { parseFlatSingleCaption, parseFlatSlotPlans } from '../domain/model/flat-imagegen.js';
import { slotCaptionFromLlmItem } from '../domain/model/slot.js';
import { recordLatestGeneration, recordParseFailure } from './parse-debug-log.js';
import { parseSizeSpec } from '../domain/model/size-spec.js';
import {
    abortErrIfNeeded,
    attachTraceId,
    loadAllCharacters,
    extractSingleCaption,
    extractOptionalSizeAnalysis,
    extractSlotPlanItems,
} from './_helpers.js';

const log = createLogger('application/workbench');

/**
 * 楼内流程：视点块与楼内生图相同。用户输入写入 {{用户描述}}，由预设自己决定放在哪。
 * 不写 slot，不出图。
 * @param {WorkbenchDeps} deps
 * @param {WorkbenchWritePromptInput} input
 * @param {string} traceId
 */
async function writeFloorPrompt(deps, input, traceId) {
    const nl = String(input?.naturalLanguage ?? '').trim();
    if (!nl) {
        return Err(domainError({
            code: 'WORKBENCH_DESC_EMPTY',
            message: '生成内容为空',
            hint: '楼内流程需要填写生成内容',
            traceId,
        }));
    }
    const skipRecall = input?.skipRecall === true;
    if (!deps.viewpointBlocks || !deps.host || (!skipRecall && typeof deps.tagRecall?.recall !== 'function')) {
        return Err(configError({
            code: 'WORKBENCH_FLOOR_UNAVAILABLE',
            message: '楼内流程未接上',
            hint: '请刷新插件后再试',
            traceId,
        }));
    }

    const vpR = await deps.viewpointBlocks.build({
        messageId: input?.messageId,
        signal: input.signal,
        traceId,
    });
    if (!vpR.ok) {
        return attachTraceId(vpR, traceId);
    }
    const mes = deps.host.getMessage(vpR.value.messageId);
    const targetFloorText = String(mes?.text ?? '');
    /** @type {import('../domain/blocks/composition.block.js').CompositionPosition[]} */
    let positions = [];
    /** @type {string[]} */
    let unmatchedKeys = [];
    if (!skipRecall) {
        const tagR = await deps.tagRecall.recall({
            contextText: vpR.value.contextText,
            targetFloorText,
            traceId,
            signal: input.signal,
            userDesc: nl,
            omitWorkbenchOnly: false,
        });
        if (!tagR.ok) {
            return attachTraceId(tagR, traceId);
        }
        positions = tagR.value.positions ?? [];
        unmatchedKeys = tagR.value.unmatchedKeys ?? [];
    }
    const positionIds = new Set(positions.map((pos) => Number(pos && pos.slotId)));
    let recentSlotsText = '';
    if (deps.slotRepo && typeof deps.slotRepo.listRetained === 'function') {
        const retainedR = await deps.slotRepo.listRetained();
        if (!retainedR.ok) {
            return attachTraceId(retainedR, traceId);
        }
        const retainedRows = retainedR.value.filter((row) => row && !positionIds.has(Number(row.slotId)));
        if (typeof deps.slotRepo.listRecentPromptCalls === 'function') {
            const callsR = await deps.slotRepo.listRecentPromptCalls();
            if (!callsR.ok) {
                return attachTraceId(callsR, traceId);
            }
            recentSlotsText = formatPromptReferenceGroups(
                selectRecentPromptGroups(retainedRows, callsR.value),
            );
        } else {
            recentSlotsText = formatRecentSlotsBlock(retainedRows);
        }
    }

    let blocks = createBlockSet();
    blocks = setBlock(blocks, VARIABLE_NAMES.WORLDINFO, vpR.value.worldInfoText);
    blocks = setBlock(blocks, VARIABLE_NAMES.CONTEXT, vpR.value.contextText);
    blocks = setBlock(blocks, VARIABLE_NAMES.CHARACTER, vpR.value.characterText);
    blocks = setBlock(blocks, VARIABLE_NAMES.COMPOSITION, formatCompositionBlock(positions));
    blocks = setBlock(blocks, VARIABLE_NAMES.FEATURE, vpR.value.featureText);
    blocks = setBlock(blocks, VARIABLE_NAMES.CONSTANT, vpR.value.constantText);
    blocks = setBlock(blocks, VARIABLE_NAMES.RECENT_SLOTS, recentSlotsText);
    blocks = setBlock(blocks, VARIABLE_NAMES.USER_DESC, nl);

    const settings = deps.loadSettings();
    if (!settings.promptGenLlmConfigId) {
        return Err(configError({
            code: 'PROMPT_LLM_UNSET',
            message: '未选择提示词生成用的 LLM 配置',
            hint: '请在运行配置中为「提示词生成」选定 LLM',
            traceId,
        }));
    }
    if (!deps.presetRepo || !settings.activeImagegenPresetId) {
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
        }));
    }
    const messages = renderPreset(presetR.value, blocks, {
        runHostMacros: deps.runHostMacros,
        omitWorkbenchOnly: false,
    });
    const aborted = abortErrIfNeeded(input?.signal, traceId);
    if (aborted) {
        return aborted;
    }
    const llmR = await deps.llm.complete({
        messages: input?.imageDataUrl ? attachReferenceImage(messages, input.imageDataUrl) : messages,
        config: llmCfgR.value,
        signal: input.signal,
        traceId,
    });
    if (!llmR.ok) {
        if (llmR.error?.context?.rawText != null) {
            recordParseFailure({
                stage: '生图',
                code: llmR.error.code,
                message: llmR.error.message,
                rawText: llmR.error.context.rawText,
            });
        }
        return attachTraceId(llmR, traceId);
    }

    const imagegenRawText = llmR.value.text;
    const plans = parseFlatSlotPlans(imagegenRawText);
    const jsonItems = plans.length > 0 ? plans : extractSlotPlanItems(llmR.value.json);
    const anchorBySlot = new Map();
    for (const pos of positions) {
        const anchor = String(pos && pos.anchorSentence || '').trim();
        const slotId = Number(pos && pos.slotId);
        if (anchor && Number.isInteger(slotId)) anchorBySlot.set(slotId, anchor);
    }
    /** @type {Array<{ slotId: number, caption: import('../domain/model/nai-params.js').NaiCaption, anchorSentence?: string, width?: number, height?: number, analysis?: string }>} */
    const captions = [];
    const withAnchor = (entry) => {
        const anchor = anchorBySlot.get(entry.slotId);
        if (anchor) entry.anchorSentence = anchor;
        return entry;
    };
    if (jsonItems.length > 0) {
        for (const item of jsonItems) {
            const parsed = slotCaptionFromLlmItem(item);
            if (!parsed.ok) {
                recordParseFailure({
                    stage: '生图',
                    code: parsed.error?.code,
                    message: parsed.error?.message,
                    rawText: imagegenRawText,
                });
                return attachTraceId(parsed, traceId);
            }
            /** @type {{ slotId: number, caption: import('../domain/model/nai-params.js').NaiCaption, anchorSentence?: string, width?: number, height?: number, analysis?: string }} */
            const entry = withAnchor({ slotId: parsed.value.slotId, caption: parsed.value.caption });
            if (parsed.value.size) {
                const sizeR = parseSizeSpec(parsed.value.size);
                if (sizeR.ok) {
                    entry.width = sizeR.value.width;
                    entry.height = sizeR.value.height;
                }
            }
            if (parsed.value.analysis) {
                entry.analysis = parsed.value.analysis;
            }
            captions.push(entry);
        }
    }
    if (captions.length === 0) {
        const flat = parseFlatSingleCaption(imagegenRawText);
        const fromWrapped = extractSingleCaption(llmR.value.json);
        const captionCandidate = flat?.caption ?? (fromWrapped != null ? fromWrapped : llmR.value.json);
        const capR = validateNaiCaption(captionCandidate);
        if (!capR.ok || !captionHasPromptText(capR.value)) {
            recordParseFailure({
                stage: '生图',
                code: 'WORKBENCH_CAPTION_INVALID',
                message: '工作台提示词生成结果格式无效',
                rawText: imagegenRawText,
            });
            return Err(contractError({
                code: 'WORKBENCH_CAPTION_INVALID',
                message: '模型没有按生图格式返回提示词，已停止出图',
                hint: '请检查模型是否按生图提示词结构输出',
                traceId,
                cause: capR.error,
                context: { rawText: imagegenRawText, json: llmR.value.json },
            }));
        }
        /** @type {{ slotId: number, caption: import('../domain/model/nai-params.js').NaiCaption, width?: number, height?: number }} */
        const entry = withAnchor({ slotId: 1, caption: capR.value });
        if (flat?.size) {
            const sizeR = parseSizeSpec(flat.size);
            if (sizeR.ok) {
                entry.width = sizeR.value.width;
                entry.height = sizeR.value.height;
            }
        }
        captions.push(entry);
    }
    if (!captions.some((entry) => captionHasPromptText(entry.caption))) {
        recordParseFailure({
            stage: '生图',
            code: 'WORKBENCH_CAPTION_INVALID',
            message: '工作台提示词生成结果格式无效',
            rawText: imagegenRawText,
        });
        return Err(contractError({
            code: 'WORKBENCH_CAPTION_INVALID',
            message: '模型没有按生图格式返回提示词，已停止出图',
            hint: '请检查模型是否按生图提示词结构输出',
            traceId,
            context: { rawText: imagegenRawText, json: llmR.value.json },
        }));
    }
    const first = captions[0];
    /** @type {WorkbenchWritePromptResult} */
    const result = {
        caption: first.caption,
        captions,
        unmatchedKeys,
        messageId: vpR.value.messageId,
        llmCallCount: skipRecall ? 1 : 2,
    };
    if (first.width != null && first.height != null) {
        result.width = first.width;
        result.height = first.height;
    }
    recordLatestGeneration({
        stage: '生图',
        ok: true,
        message: '已生成',
        rawText: imagegenRawText,
    });
    if (captions.length && deps.slotRepo && typeof deps.slotRepo.recordPromptCall === 'function') {
        const saved = await deps.slotRepo.recordPromptCall({
            items: captions.map((entry) => {
                /** @type {{ slotId: number, caption: import('../domain/model/nai-params.js').NaiCaption, size?: string, analysis?: string }} */
                const item = { slotId: entry.slotId, caption: entry.caption };
                if (entry.analysis) item.analysis = entry.analysis;
                if (entry.width != null && entry.height != null) {
                    item.size = `${entry.width}x${entry.height}`;
                }
                return item;
            }),
        });
        if (!saved.ok) {
            log.warn('recent prompt call was not saved', { traceId, code: saved.error?.code });
        }
    }
    return Ok(result);
}

/**
 * @typedef {import('../domain/model/nai-params.js').NaiCaption} NaiCaption
 * @typedef {import('../domain/model/nai-params.js').NaiParams} NaiParams
 * @typedef {import('../domain/model/artist.js').ArtistString} ArtistString
 * @typedef {import('../domain/model/plugin-settings.js').PluginSettings} PluginSettings
 * @typedef {import('../ports/image-gen.port.js').GeneratedImage} GeneratedImage
 * @typedef {import('../domain/model/tag.js').TagEntry} TagEntry
 */

/**
 * @typedef {object} WorkbenchDeps
 * @property {import('../ports/llm.port.js').LlmPort} llm
 * @property {import('./image-gen.service.js').ImageGenService} imageGen
 * @property {import('../ports/repository.port.js').CharacterRepository} characterRepo
 * @property {import('../ports/repository.port.js').TagRepository} tagRepo
 * @property {import('../ports/repository.port.js').Repository<import('../domain/model/preset.js').Preset>} [presetRepo]
 * @property {import('../ports/repository.port.js').Repository<import('../domain/model/api-config.js').LlmApiConfig>} llmConfigRepo
 * @property {ReturnType<import('./tag-recall.service.js').createTagRecallService>} [tagRecall]
 * @property {import('../ports/host.port.js').HostPort} [host]
 * @property {ReturnType<import('./viewpoint-blocks.js').createViewpointBlocksBuilder>} [viewpointBlocks]
 * @property {import('../ports/repository.port.js').SlotRepository} [slotRepo]
 * @property {() => PluginSettings} loadSettings
 * @property {(template: string) => string} runHostMacros
 */

/**
 * @typedef {object} WorkbenchWritePromptInput
 * @property {string} naturalLanguage
 * @property {string[]} [libraryIds] 只传库 id、不传 entryIds 时，纳入这些库里已启用的全部条目
 * @property {string[]} [entryIds] 本次勾选的条目。传入后只发送这些条目，库开关和条目开关都不再扩大范围
 * @property {'entries'|'floor'} [mode] floor=楼内召回后按生图预设回写，多份全部保留
 * @property {boolean} [includeWorkbenchOnly] 已无作用。工作台楼内流程始终带上工作台专用段
 * @property {number} [messageId] 楼内流程的视点楼；缺省为最新 AI 楼
 * @property {AbortSignal} [signal]
 * @property {string} [traceId]
 * @property {string} [imageDataUrl] 反推时附上的参考图。没有则只按自然语言写提示词
 * @property {boolean} [skipRecall] 为 true 时不跑召回，构图标签留空。缺省照旧先召回
 */

/**
 * @typedef {object} WorkbenchWritePromptResult
 * @property {NaiCaption} caption 第一份。工作台编辑框用这一份
 * @property {Array<{ slotId: number, caption: NaiCaption, anchorSentence?: string, width?: number, height?: number, analysis?: string }>} [captions] 楼内流程回的全部分。anchorSentence 是召回对上正文的生成点，按 slotId 附上；没有则不带这个字段
 * @property {string[]} unmatchedKeys 勾选条目路径恒为空；楼内流程为召回未对上的编号
 * @property {number} [width] 模型回了合法「尺寸」时填入
 * @property {number} [height]
 * @property {number} [messageId] 楼内流程实际使用的视点楼
 * @property {number} [llmCallCount] 楼内流程为召回 + 生图共 2 次
 */

/**
 * @typedef {object} WorkbenchGenerateInput
 * @property {NaiCaption} caption 当前工作台结构化提示词（裁决 D13）
 * @property {ArtistString|null|undefined} [artist] 本次覆盖，不修改全局当前画师串
 * @property {boolean} replaceCharacterKeywords 页面拨档，程序不自判
 * @property {Partial<NaiParams>} [params]
 * @property {AbortSignal} [signal]
 * @property {string} [traceId]
 * @property {{ image: string, strength?: number, noise?: number }} [img2img]
 *   仅图生图按钮传入。反推重绘不传。
 */

/**
 * @param {WorkbenchDeps} deps
 * @returns {{
 *   writePrompt: (input: WorkbenchWritePromptInput) => Promise<import('../infra/result.js').Ok<WorkbenchWritePromptResult>|import('../infra/result.js').Err<import('../infra/errors.js').AppError>>,
 *   generateImage: (input: WorkbenchGenerateInput) => Promise<import('../infra/result.js').Ok<GeneratedImage[]>|import('../infra/result.js').Err<import('../infra/errors.js').AppError>>,
 * }}
 */
export function createWorkbenchService(deps) {
    return {
        /**
         * 只填工作台提示词：不出图、不改 replaceCharacterKeywords、不跑召回。
         * @param {WorkbenchWritePromptInput} input
         */
        async writePrompt(input) {
            const traceId = input?.traceId ?? newId('trace');
            const aborted = abortErrIfNeeded(input?.signal, traceId);
            if (aborted) {
                return aborted;
            }

            const hasReferenceImage = String(input?.imageDataUrl ?? '').startsWith('data:image/');
            const nlEmpty = !String(input?.naturalLanguage ?? '').trim();
            // 反推只传图时不走楼内空文案拦截，直接把图交给生图预设。
            if (input?.mode === 'floor' && !(hasReferenceImage && nlEmpty)) {
                return writeFloorPrompt(deps, input, traceId);
            }

            const settings = deps.loadSettings();
            const nl = String(input?.naturalLanguage ?? '');

            const charsBundle = await loadAllCharacters(deps.characterRepo);
            let characterText = '';
            if (charsBundle.ok) {
                const hit = activateCharacters(
                    charsBundle.value.groups,
                    charsBundle.value.characters,
                    nl,
                    settings.matchDefaults ?? { caseSensitive: false, matchWholeWords: false },
                );
                characterText = formatCharacterBlock(hit);
            } else {
                log.warn('workbench character repo failed', {
                    traceId,
                    code: charsBundle.error?.code,
                });
                return attachTraceId(charsBundle, traceId);
            }

            /** @type {TagEntry[]} */
            const compositionEntries = [];
            /** @type {TagEntry[]} */
            const featureEntries = [];
            /** @type {TagEntry[]} */
            const constantEntries = [];

            const pickEntries = Array.isArray(input.entryIds);
            const entryIdSet = pickEntries
                ? new Set(input.entryIds.map((id) => String(id)))
                : null;
            const libraryIdSet = Array.isArray(input.libraryIds)
                ? new Set(input.libraryIds.map((id) => String(id)))
                : null;
            const shouldLoad = pickEntries
                ? entryIdSet.size > 0
                : libraryIdSet != null && libraryIdSet.size > 0;

            if (shouldLoad) {
                const libsR = await deps.tagRepo.listLibraries();
                if (!libsR.ok) {
                    return attachTraceId(libsR, traceId);
                }
                const selected = libsR.value.filter((lib) => {
                    if (!lib) return false;
                    if (pickEntries && (!libraryIdSet || libraryIdSet.size === 0)) return true;
                    return libraryIdSet != null && libraryIdSet.has(String(lib.id));
                });
                for (const lib of selected) {
                    const er = await deps.tagRepo.listEntries(lib.id);
                    if (!er.ok) {
                        return attachTraceId(er, traceId);
                    }
                    const kind = normalizeTagLibraryKind(lib.kind);
                    const live = er.value.filter((entry) => {
                        if (!entry) return false;
                        if (entryIdSet) return entryIdSet.has(String(entry.id));
                        return entry.active !== false;
                    });
                    if (kind === 'feature') {
                        featureEntries.push(...live);
                    } else if (kind === 'constant') {
                        constantEntries.push(...live);
                    } else {
                        compositionEntries.push(...live);
                    }
                }
            }

            const compositionText = formatSingleCompositionBlock(compositionEntries);
            const featureText = formatFeatureBlock(featureEntries);
            const constantText = formatConstantBlock(constantEntries);

            if (!settings.promptGenLlmConfigId) {
                return Err(configError({
                    code: 'PROMPT_LLM_UNSET',
                    message: '未选择提示词生成用的 LLM 配置',
                    hint: '请在运行配置中为「提示词生成」选定 LLM',
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
                }));
            }

            /** @type {import('../ports/llm.port.js').ChatMessage[]} */
            let messages;

            if (deps.presetRepo && settings.activeImagegenPresetId) {
                const presetR = await deps.presetRepo.get(settings.activeImagegenPresetId);
                if (presetR.ok && presetR.value && presetR.value.kind === 'imagegen') {
                    let blocks = createBlockSet();
                    blocks = setBlock(blocks, VARIABLE_NAMES.WORLDINFO, '');
                    blocks = setBlock(blocks, VARIABLE_NAMES.CONTEXT, nl);
                    blocks = setBlock(blocks, VARIABLE_NAMES.USER_DESC, nl);
                    blocks = setBlock(blocks, VARIABLE_NAMES.CHARACTER, characterText);
                    blocks = setBlock(blocks, VARIABLE_NAMES.COMPOSITION, compositionText);
                    blocks = setBlock(blocks, VARIABLE_NAMES.FEATURE, featureText);
                    blocks = setBlock(blocks, VARIABLE_NAMES.CONSTANT, constantText);
                    // 工作台不走聊天会话，近期生图记录为空
                    blocks = setBlock(blocks, VARIABLE_NAMES.RECENT_SLOTS, '');
                    messages = renderPreset(presetR.value, blocks, {
                        runHostMacros: deps.runHostMacros,
                    });
                }
            }

            if (!messages) {
                messages = [
                    {
                        role: 'system',
                        content: '请根据用户自然语言、角色库注入块、构图标签、特征参考与常驻标签，'
                            + '输出一份生图提示词 JSON（含正负面场景与角色）。'
                            + '不要输出多图数组。',
                    },
                    {
                        role: 'user',
                        content: [
                            `自然语言：\n${nl}`,
                            characterText ? `角色库：\n${characterText}` : '',
                            compositionText ? `构图标签：\n${compositionText}` : '',
                            featureText ? `特征参考：\n${featureText}` : '',
                            constantText ? `常驻标签：\n${constantText}` : '',
                        ].filter(Boolean).join('\n\n'),
                    },
                ];
            }

            const aborted2 = abortErrIfNeeded(input?.signal, traceId);
            if (aborted2) {
                return aborted2;
            }

            const llmR = await deps.llm.complete({
                messages: input?.imageDataUrl ? attachReferenceImage(messages, input.imageDataUrl) : messages,
                config: llmCfgR.value,
                signal: input.signal,
                traceId,
            });
            if (!llmR.ok) {
                if (llmR.error?.context?.rawText != null) {
                    recordParseFailure({
                        stage: '生图',
                        code: llmR.error.code,
                        message: llmR.error.message,
                        rawText: llmR.error.context.rawText,
                    });
                }
                return attachTraceId(llmR, traceId);
            }

            const rawJson = llmR.value.json;
            const imagegenRawText = llmR.value.text;
            const flat = parseFlatSingleCaption(imagegenRawText);
            const fromWrapped = extractSingleCaption(rawJson);
            const captionCandidate = flat?.caption ?? (fromWrapped != null ? fromWrapped : rawJson);
            const capR = validateNaiCaption(captionCandidate);
            if (!capR.ok || !captionHasPromptText(capR.value)) {
                recordParseFailure({
                    stage: '生图',
                    code: 'WORKBENCH_CAPTION_INVALID',
                    message: '工作台提示词生成结果格式无效',
                    rawText: imagegenRawText,
                });
                return Err(contractError({
                    code: 'WORKBENCH_CAPTION_INVALID',
                message: '模型没有按生图格式返回提示词，已停止出图',
                hint: '请检查模型是否按生图提示词结构输出',
                traceId,
                cause: capR.error,
                context: { rawText: imagegenRawText, json: rawJson },
                }));
            }

            /** @type {WorkbenchWritePromptResult} */
            const result = { caption: capR.value, unmatchedKeys: [] };
            const extras = flat
                ? { size: flat.size, analysis: flat.analysis }
                : extractOptionalSizeAnalysis(rawJson);
            if (extras.size) {
                const sizeR = parseSizeSpec(extras.size);
                if (sizeR.ok) {
                    result.width = sizeR.value.width;
                    result.height = sizeR.value.height;
                }
            }
            recordLatestGeneration({
                stage: '生图',
                ok: true,
                message: '已生成',
                rawText: imagegenRawText,
            });
            return Ok(result);
        },

        async generateImage(input) {
            if (!input || typeof input !== 'object') {
                throw new Error('invalid argument: input');
            }
            if (typeof input.replaceCharacterKeywords !== 'boolean') {
                throw new Error('invalid argument: replaceCharacterKeywords');
            }

            const traceId = input.traceId ?? newId('trace');
            /** @type {import('./image-gen.service.js').ImageGenRequest} */
            const request = {
                caption: input.caption,
                params: input.params,
                artist: input.artist,
                replaceCharacterKeywords: input.replaceCharacterKeywords,
                signal: input.signal,
                traceId,
            };
            if (input.img2img) {
                request.img2img = input.img2img;
            }
            return deps.imageGen.generate(request);
        },
    };
}
