/**
 * L4 应用层 · 视点楼注入块构建（需求 §3 步骤 4 前半 + 4.16）。
 *
 * 抽出世界书 / 当前上下文 / 角色库 / 特征参考 / 常驻标签（不含构图召回、近期生图记录与提示词 LLM）。
 * 「近期生图记录」由 generate-slots / single-prompt 各自按会话保留范围组装。
 * 读仓库失败返回 Err（D39 / 4.16：读错误不得当成没有数据）。
 */

import { Ok, Err } from '../infra/result.js';
import { domainError } from '../infra/errors.js';
import { activateCharacters } from '../domain/matching/activation.js';
import { activateFeatureEntries } from '../domain/matching/feature-activation.js';
import { formatCharacterBlock } from '../domain/blocks/character.block.js';
import { formatFeatureBlock } from '../domain/blocks/feature.block.js';
import {
    collectConstantEntries,
    formatConstantBlock,
} from '../domain/blocks/constant.block.js';
import {
    abortErrIfNeeded,
    attachTraceId,
    loadAllCharacters,
} from './_helpers.js';

/**
 * @typedef {import('../domain/model/plugin-settings.js').PluginSettings} PluginSettings
 * @typedef {import('../domain/model/tag.js').TagEntry} TagEntry
 * @typedef {import('../ports/host.port.js').HostMessage} HostMessage
 */

/**
 * @typedef {object} ViewpointBlocksDeps
 * @property {import('../ports/host.port.js').HostPort} host
 * @property {import('../ports/repository.port.js').CharacterRepository} characterRepo
 * @property {import('../ports/repository.port.js').TagRepository} tagRepo
 * @property {ReturnType<import('./context-collector.js').createContextCollector>} contextCollector
 * @property {ReturnType<import('./worldinfo-resolver.js').createWorldInfoResolver>} worldInfoResolver
 * @property {() => PluginSettings} loadSettings
 */

/**
 * @typedef {object} ViewpointBlocksBuildOpts
 * @property {number} [messageId] 视点楼；缺省 = 最新 AI 回复楼
 * @property {string} [extraScanText] 追加到关键字扫描文本（如单图用户描述）
 * @property {AbortSignal} [signal]
 * @property {string} [traceId]
 */

/**
 * @typedef {object} ViewpointBlocksResult
 * @property {number} messageId
 * @property {string} worldInfoText
 * @property {string} contextText
 * @property {HostMessage[]} contextMessages
 * @property {string} characterText
 * @property {string} featureText
 * @property {TagEntry[]} featureEntries
 * @property {string} constantText
 * @property {TagEntry[]} constantEntries
 */

/**
 * @param {ViewpointBlocksDeps} deps
 * @returns {{ build: (opts?: ViewpointBlocksBuildOpts) => Promise<import('../infra/result.js').Ok<ViewpointBlocksResult>|import('../infra/result.js').Err<import('../infra/errors.js').AppError>> }}
 */
export function createViewpointBlocksBuilder(deps) {
    return {
        /**
         * @param {ViewpointBlocksBuildOpts} [opts]
         */
        async build(opts = {}) {
            const traceId = opts.traceId;
            const signal = opts.signal;

            const aborted0 = abortErrIfNeeded(signal, traceId);
            if (aborted0) {
                return aborted0;
            }

            const settings = deps.loadSettings();
            const messageId = resolveViewpointMessageId(deps.host, opts.messageId);
            if (messageId == null) {
                return attachTraceId(Err(domainError({
                    code: 'VIEWPOINT_NOT_FOUND',
                    message: '找不到视点楼',
                    hint: '请确认当前聊天有 AI 回复，或传入有效的 messageId',
                    context: { messageId: opts.messageId ?? null },
                })), traceId);
            }

            // ── 1. 同一窗口（剥 slot），以视点楼为锚 ─────────────────
            const window = deps.contextCollector.collect({ messageId });
            const contextWindow = window.messages;
            const contextText = window.text;

            // ── 2. 世界书：开关关闭时不扫描、不传入（接口与直接楼内生图共用）──
            let worldInfoText = '';
            if (settings.includeWorldInfo === true) {
                const wiR = await deps.worldInfoResolver.resolve({
                    contextWindow,
                    messageId,
                });
                if (!wiR.ok) {
                    return attachTraceId(wiR, traceId);
                }
                worldInfoText = wiR.value.text;
            }

            const aborted1 = abortErrIfNeeded(signal, traceId);
            if (aborted1) {
                return aborted1;
            }

            const scanText = typeof opts.extraScanText === 'string' && opts.extraScanText.length > 0
                ? `${contextText}\n${opts.extraScanText}`
                : contextText;

            const matchDefaults = settings.matchDefaults ?? {
                caseSensitive: false,
                matchWholeWords: false,
            };

            // ── 3. 角色库（读失败 → Err，不降级为空）────────────────
            const charsBundle = await loadAllCharacters(deps.characterRepo);
            if (!charsBundle.ok) {
                return attachTraceId(charsBundle, traceId);
            }
            const hitChars = activateCharacters(
                charsBundle.value.groups,
                charsBundle.value.characters,
                scanText,
                matchDefaults,
            );
            const characterText = formatCharacterBlock(hitChars);

            // ── 4. 特征库 + 常驻库（读失败 → Err）───────────────────
            const libsR = await deps.tagRepo.listLibraries();
            if (!libsR.ok) {
                return attachTraceId(libsR, traceId);
            }
            /** @type {Map<string, TagEntry[]>} */
            const featureByLibrary = new Map();
            /** @type {Map<string, TagEntry[]>} */
            const constantByLibrary = new Map();
            for (const lib of libsR.value) {
                if (!lib) {
                    continue;
                }
                if (lib.kind !== 'feature' && lib.kind !== 'constant') {
                    continue;
                }
                const er = await deps.tagRepo.listEntries(lib.id);
                if (!er.ok) {
                    return attachTraceId(er, traceId);
                }
                if (lib.kind === 'feature') {
                    featureByLibrary.set(lib.id, er.value);
                } else {
                    constantByLibrary.set(lib.id, er.value);
                }
            }
            const featureEntries = activateFeatureEntries(
                libsR.value,
                featureByLibrary,
                scanText,
                matchDefaults,
            );
            const featureText = formatFeatureBlock(featureEntries);
            const constantEntries = collectConstantEntries(libsR.value, constantByLibrary);
            const constantText = formatConstantBlock(constantEntries);

            return Ok({
                messageId,
                worldInfoText,
                contextText,
                contextMessages: contextWindow,
                characterText,
                featureText,
                featureEntries,
                constantText,
                constantEntries,
            });
        },
    };
}

/**
 * @param {import('../ports/host.port.js').HostPort} host
 * @param {number} [explicitId]
 * @returns {number|null}
 */
function resolveViewpointMessageId(host, explicitId) {
    if (explicitId != null && Number.isInteger(Number(explicitId))) {
        const id = Number(explicitId);
        const msg = typeof host.getMessage === 'function' ? host.getMessage(id) : null;
        if (msg) {
            return id;
        }
        // 宽松：getMessages 里有该 id 也算
        const all = host.getMessages() ?? [];
        if (all.some((m) => m && m.messageId === id)) {
            return id;
        }
        if (id >= 0 && id < all.length && all[id]) {
            return id;
        }
        return null;
    }
    const recent = host.getRecentAiMessages(1) ?? [];
    if (recent.length === 0) {
        return null;
    }
    const mid = recent[0].messageId;
    return Number.isInteger(mid) ? mid : null;
}
