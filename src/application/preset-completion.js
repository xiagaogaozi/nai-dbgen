/** 预设结果校验与纠错重试；HTTP 传输故障仍由 LLM 网关处理。 */
import { Ok, Err } from '../infra/result.js';
import { configError, ERROR_CATEGORY } from '../infra/errors.js';
import { presetRetryCount } from '../domain/model/preset.js';
import { abortErrIfNeeded } from './_helpers.js';
import { recordParseFailure } from './parse-debug-log.js';

/**
 * @param {{ llm: object, preset?: object, stage: string, request: object, validate: Function }} args
 */
export async function completePresetRequest({ llm, preset, stage, request, validate }) {
    const retryCount = presetRetryCount(preset);
    if (!Number.isSafeInteger(retryCount) || retryCount < 0) {
        return Err(configError({ code: 'PRESET_RETRY_COUNT', message: '结果纠错重试次数必须是大于或等于 0 的整数',
            context: { llmCallCount: 0, llmCalled: false } }));
    }
    const originalMessages = structuredClone(request.messages);
    let messages = originalMessages;
    let llmCallCount = 0;
    for (let attempt = 0; attempt <= retryCount; attempt += 1) {
        const aborted = abortErrIfNeeded(request.signal, request.traceId);
        if (aborted) {
            aborted.error.context = { ...aborted.error.context, llmCallCount, llmCalled: llmCallCount > 0 };
            return aborted;
        }
        const response = await llm.complete({ ...request, messages: structuredClone(messages) });
        llmCallCount += 1;
        const cancelledAfterRequest = abortErrIfNeeded(request.signal, request.traceId);
        if (cancelledAfterRequest) {
            cancelledAfterRequest.error.context = { ...cancelledAfterRequest.error.context, llmCallCount, llmCalled: true };
            return cancelledAfterRequest;
        }
        let checked;
        let rawText;
        if (response.ok) {
            rawText = String(response.value.text ?? '');
            if (!rawText && response.value.json != null) rawText = JSON.stringify(response.value.json);
            checked = await validate(response.value);
        } else {
            const error = response.error;
            const isOutputError = error?.category === ERROR_CATEGORY.CONTRACT;
            if (!isOutputError) {
                error.context = { ...error.context, llmCallCount, llmCalled: true };
                return response;
            }
            rawText = String(error.context?.rawText ?? '');
            checked = response;
        }
        if (checked.ok) {
            const cancelledAfterValidation = abortErrIfNeeded(request.signal, request.traceId);
            if (cancelledAfterValidation) {
                cancelledAfterValidation.error.context = { ...cancelledAfterValidation.error.context, llmCallCount, llmCalled: true };
                return cancelledAfterValidation;
            }
            return Ok({ ...response.value, llmCallCount });
        }
        const error = checked.error;
        error.traceId = error.traceId ?? request.traceId ?? null;
        error.context = {
            ...error.context, rawText, llmCallCount, llmCalled: true,
            retryCount, retriesUsed: attempt,
            outputValidationRecorded: true,
        };
        recordParseFailure({ stage, code: error.code, message: error.message, rawText });
        if (attempt === retryCount) {
            error.hint = [error.hint, `已执行 ${llmCallCount} 次，达到预设的纠错重试上限 ${retryCount}`].filter(Boolean).join('；');
            return Err(error);
        }
        const abortedAfter = abortErrIfNeeded(request.signal, request.traceId);
        if (abortedAfter) {
            abortedAfter.error.context = { ...abortedAfter.error.context, llmCallCount, llmCalled: true };
            return abortedAfter;
        }
        const issues = Array.isArray(error.context?.issues) ? error.context.issues : [];
        const details = issues.length ? issues.map((issue) => `- ${issue}`).join('\n') : `- ${error.message}`;
        // 只带本轮失败回文及问题，保留最初预设和上下文；不无限累积纠错历史。
        messages = [
            ...originalMessages,
            { role: 'assistant', content: rawText || '（上一轮返回为空）' },
            { role: 'user', content: `上一次${stage}结果未通过程序校验（${error.code}）：\n${details}\n${error.hint || ''}\n请按原预设要求重新输出完整结果，补齐以上必填字段并修正格式。不要只返回修改片段，不要解释错误。` },
        ];
    }
}
