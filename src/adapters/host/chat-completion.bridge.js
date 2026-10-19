/**
 * 与酒馆主回复共用发送前的提示词处理事件。
 *
 * ChatCompletionService.sendRequest 只负责 HTTP，不触发此事件。
 * shujuku 在 CHAT_COMPLETION_SETTINGS_READY 的 makeLast 监听器中执行
 * random/calc/db/sql/script/if；必须等最终消息完成注入后再 await emit。
 * 不在这里复制其解析器：cell、db、sql 等依赖 shujuku 的当前运行时数据。
 */

import { Ok, Err } from '../../infra/result.js';
import { hostError } from '../../infra/errors.js';

/**
 * @param {any} ctx SillyTavern.getContext()
 * @param {Record<string, any>} requestData 已构造的最终请求体
 * @param {string|null} [traceId]
 */
export async function prepareChatCompletionPrompt(ctx, requestData, traceId = null) {
    let prepared;
    try {
        // 事件监听器原地改写消息；不得污染用例数据或下一次重试的输入。
        prepared = { ...requestData, messages: structuredClone(requestData.messages) };
        const event = ctx?.eventTypes?.CHAT_COMPLETION_SETTINGS_READY;
        if (event && typeof ctx?.eventSource?.emit === 'function') {
            await ctx.eventSource.emit(event, prepared);
        }
    } catch (cause) {
        return Err(hostError({
            code: 'LLM_PROMPT_TEMPLATE_FAILED',
            message: '处理发送前的提示词模板失败，已停止发送',
            hint: '请检查 shujuku 和酒馆提示词模板扩展的报错',
            cause,
            traceId,
        }));
    }

    // 未加载、未启用或解析失败时，绝不能把条件的所有分支原样发给模型。
    const unresolved = findUnresolvedAcuConditions(prepared.messages);
    if (unresolved.count > 0) {
        return Err(hostError({
            code: 'LLM_ACU_IF_UNRESOLVED',
            message: 'shujuku 的 if 条件仍未解析，已停止发送',
            hint: '请确认 shujuku 已加载并启用「提示词模板」功能，且 if 语法完整',
            traceId,
            context: unresolved,
        }));
    }
    return Ok(prepared);
}

/** 只检查 shujuku 支持的条件类型；不把提示词正文写进错误日志。 */
function findUnresolvedAcuConditions(messages) {
    let count = 0;
    const types = new Set();
    for (const message of Array.isArray(messages) ? messages : []) {
        const texts = typeof message?.content === 'string'
            ? [message.content]
            : (Array.isArray(message?.content) ? message.content : [])
                .filter((part) => part?.type === 'text' && typeof part.text === 'string')
                .map((part) => part.text);
        for (const text of texts) {
            for (const match of text.matchAll(/<if\s+(seed|cell|cond|db|sql)\s*=/gi)) {
                count += 1;
                types.add(match[1].toLowerCase());
            }
        }
    }
    return { count, types: [...types] };
}
