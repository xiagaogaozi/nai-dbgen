/**
 * L2 适配器 · 经 ST ChatCompletionService，来源 custom（兼容 OpenAI）。
 *
 * @see ref/SillyTavern/public/scripts/custom-request.js:428-469（createRequestData 透传 ...props，含 secret_id / custom_*）
 * @see ref/SillyTavern/src/endpoints/backends/chat-completions.js:1778+ /status、2394+ /generate
 *
 * 裁决 D26：AppError.message 必须是中文用户文案；英文宿主信息只进 cause / context.preview。
 * 裁决 D27：无法从宿主异常中解析出真实 HTTP 状态码时，默认不可重试。
 */

import { Ok, Err } from '../../../infra/result.js';
import {
    configError,
    hostError,
    transportError,
    upstreamFromHttpStatus,
} from '../../../infra/errors.js';
import { apiConfigDisplayName, llmConfigHasKey } from '../../../domain/model/api-config.js';
import { prepareChatCompletionPrompt } from '../../host/chat-completion.bridge.js';
import {
    buildCustomChatCompletionRequest,
    buildCustomStatusRequest,
    extractModelIdsFromStatus,
} from '../request-data.js';

/**
 * @param {object} deps
 * @param {() => any} deps.getContext
 * @param {import('../../host/st-yaml.js').YamlApi} [deps.yaml]
 * @param {typeof fetch} [deps.fetch]
 * @returns {{
 *   name: string,
 *   complete: (req: import('../../../ports/llm.port.js').LlmCompleteRequest) => Promise<import('../../../infra/result.js').Ok<import('../../../ports/llm.port.js').LlmCompleteResult>|import('../../../infra/result.js').Err<import('../../../infra/errors.js').AppError>>,
 *   listModels: (config: import('../../../domain/model/api-config.js').LlmApiConfig) => Promise<import('../../../infra/result.js').Ok<{ models: string[], count: number }>|import('../../../infra/result.js').Err<import('../../../infra/errors.js').AppError>>,
 * }}
 */
export function createStBackendLlmTransport(deps) {
    if (!deps || typeof deps.getContext !== 'function') {
        throw new Error('invalid argument: deps.getContext');
    }
    const getContext = deps.getContext;
    const yaml = deps.yaml;
    const fetchFn = deps.fetch ?? globalThis.fetch.bind(globalThis);

    return {
        name: 'st-backend',

        /**
         * @param {import('../../../ports/llm.port.js').LlmCompleteRequest} req
         */
        async complete(req) {
            const config = req?.config;
            const traceId = req?.traceId ?? null;
            const label = apiConfigDisplayName(config);

            const ready = assertLlmConfigForComplete(config, label, traceId);
            if (!ready.ok) {
                return ready;
            }
            if (!Array.isArray(req.messages) || req.messages.length === 0) {
                return Err(configError({
                    code: 'LLM_MESSAGES_EMPTY',
                    message: '没有可发送的聊天消息',
                    traceId,
                }));
            }
            return completeWithSecret(req);
        },

        async listModels(config) {
            const label = apiConfigDisplayName(config);
            const ready = assertConfigReady(config, label, null);
            if (!ready.ok) {
                return ready;
            }
            return listModelsWithSecret(config);
        },
    };

    /**
     * @param {import('../../../ports/llm.port.js').LlmCompleteRequest} req
     */
    async function completeWithSecret(req) {
            const config = req?.config;
            const traceId = req?.traceId ?? null;

            let ctx;
            try {
                ctx = getContext();
            } catch (cause) {
                return Err(hostError({
                    code: 'LLM_ST_CONTEXT',
                    message: '无法获取酒馆上下文',
                    hint: '请确认插件在酒馆页面内加载',
                    cause,
                    traceId,
                }));
            }

            const Service = ctx?.ChatCompletionService;
            if (!Service || typeof Service.sendRequest !== 'function') {
                return Err(hostError({
                    code: 'LLM_ST_CCS_MISSING',
                    message: '当前酒馆版本缺少大模型调用能力',
                    hint: '请升级酒馆',
                    traceId,
                }));
            }

            const payload = buildCustomChatCompletionRequest(config, {
                messages: req.messages,
                jsonSchema: req.jsonSchema,
                stream: false,
                yaml,
            });

            /** @type {Record<string, unknown>} */
            const requestData = typeof Service.createRequestData === 'function'
                ? Service.createRequestData(payload)
                : { ...payload, use_sysprompt: true };

            const prepared = await prepareChatCompletionPrompt(ctx, requestData, traceId);
            if (!prepared.ok) {
                return prepared;
            }
            // 与现有非流式响应解析保持一致；模板事件之后再固定此传输约定。
            prepared.value.stream = false;
            if (req.signal?.aborted) {
                return Err(upstreamFromHttpStatus(0, {
                    cause: toAbort(req.signal.reason),
                    traceId,
                }));
            }

            try {
                const result = await Service.sendRequest(prepared.value, true, req.signal ?? null);
                const content = result?.content;
                let text;
                if (typeof content === 'string') {
                    text = content;
                } else if (content != null) {
                    text = JSON.stringify(content);
                } else {
                    text = '';
                }

                /** @type {import('../../../ports/llm.port.js').LlmCompleteResult} */
                const out = { text };
                if (content != null && typeof content === 'object') {
                    out.json = content;
                }
                return Ok(out);
            } catch (cause) {
                if (isAbortError(cause) || req.signal?.aborted) {
                    return Err(upstreamFromHttpStatus(0, {
                        cause: toAbort(cause),
                        traceId,
                    }));
                }
                const preview = (cause instanceof Error ? cause.message : String(cause)).slice(0, 300);
                const status = parseHttpStatusFromMessage(preview);
                if (status != null) {
                    return Err(upstreamFromHttpStatus(status, {
                        cause,
                        traceId,
                        context: {
                            transport: 'st-backend',
                            preview,
                        },
                    }));
                }
                return Err(transportError({
                    code: 'LLM_ST_BACKEND_FAILED',
                    message: '经酒馆调用大模型失败',
                    hint: '请检查接口配置与模型可用性',
                    retryable: false,
                    cause,
                    traceId,
                    context: {
                        transport: 'st-backend',
                        preview,
                    },
                }));
            }
    }

    /**
     * 插件自己要模型名单：地址和密钥原文放进请求，酒馆只转发 GET /models。
     * @param {import('../../../domain/model/api-config.js').LlmApiConfig} config
     */
    async function listModelsWithSecret(config) {
            const apiKey = String(config.apiKey || '').trim();
            if (!apiKey) {
                return Err(configError({
                    code: 'LLM_CONFIG_KEY',
                    message: '请先填写 API 密钥',
                    hint: '获取模型会把输入框里的密钥原文放进请求',
                }));
            }

            let headers;
            try {
                const ctx = getContext();
                if (!ctx || typeof ctx.getRequestHeaders !== 'function') {
                    return Err(hostError({
                        code: 'LLM_ST_HEADERS',
                        message: '无法获取酒馆请求头',
                        hint: '请确认插件在酒馆页面内加载',
                    }));
                }
                headers = {
                    ...ctx.getRequestHeaders(),
                    'Content-Type': 'application/json',
                };
            } catch (cause) {
                return Err(hostError({
                    code: 'LLM_ST_CONTEXT',
                    message: '无法获取酒馆上下文',
                    cause,
                }));
            }

            const body = buildCustomStatusRequest({
                baseUrl: config.baseUrl,
                apiKey,
                customIncludeHeaders: config.customIncludeHeaders,
            });

            let res;
            try {
                res = await fetchFn('/api/backends/chat-completions/status', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(body),
                    cache: 'no-cache',
                });
            } catch (cause) {
                return Err(transportError({
                    code: 'LLM_STATUS_NETWORK',
                    message: '拉取模型列表失败',
                    hint: '请检查网络与接口地址',
                    cause,
                    retryable: true,
                }));
            }

            const text = await res.text();
            let json = null;
            try {
                json = text ? JSON.parse(text) : null;
            } catch {
                json = null;
            }

            if (!res.ok || json?.error === true) {
                const reason = extractStatusErrorMessage(json, text, res.status);
                return Err(upstreamFromHttpStatus(res.status || 502, {
                    message: reason,
                    hint: '请检查接口地址与 API 密钥',
                    context: {
                        transport: 'st-backend',
                        preview: text.slice(0, 300),
                        status: res.status,
                    },
                }));
            }

            const models = extractModelIdsFromStatus(json);
            return Ok({ models, count: models.length });
    }
}

/**
 * @param {import('../../../domain/model/api-config.js').LlmApiConfig|null|undefined} config
 * @param {string} label
 * @param {string|null} traceId
 */
function assertConfigReady(config, label, traceId) {
    if (!config || !String(config.baseUrl || '').trim()) {
        return Err(configError({
            code: 'LLM_CONFIG_URL',
            message: `「${label}」还没填接口地址`,
            hint: '请到管理台 → API 库中填写接口地址',
            traceId,
        }));
    }
    if (!llmConfigHasKey(config)) {
        return Err(configError({
            code: 'LLM_CONFIG_KEY',
            message: `「${label}」还没填 API 密钥`,
            hint: '请到管理台 → API 库中填写 API 密钥',
            traceId,
        }));
    }
    return Ok(true);
}

/**
 * complete 额外要求已填模型名。
 * @param {import('../../../domain/model/api-config.js').LlmApiConfig|null|undefined} config
 * @param {string} label
 * @param {string|null} traceId
 */
function assertLlmConfigForComplete(config, label, traceId) {
    const base = assertConfigReady(config, label, traceId);
    if (!base.ok) {
        return base;
    }
    if (!String(config?.model || '').trim()) {
        return Err(configError({
            code: 'LLM_CONFIG_MODEL',
            message: `「${label}」还没填模型名`,
            hint: '请到管理台 → API 库中获取或填写模型名',
            traceId,
        }));
    }
    return Ok(true);
}

/**
 * @param {unknown} json
 * @param {string} text
 * @param {number} status
 * @returns {string}
 */
function extractStatusErrorMessage(json, text, status) {
    const msg = json?.error?.message
        || (typeof json?.error === 'string' ? json.error : null)
        || json?.message
        || null;
    if (msg) {
        return `拉取模型列表失败：${String(msg).slice(0, 200)}`;
    }
    if (json?.error === true) {
        return '拉取模型列表失败：接口没有返回模型名单，请核对地址和密钥';
    }
    if (text && text.trim() && text.length < 200) {
        return `拉取模型列表失败：${text.trim()}`;
    }
    return `拉取模型列表失败（HTTP ${status || '?'}）`;
}

/**
 * @param {string} message
 * @returns {number|null}
 */
function parseHttpStatusFromMessage(message) {
    const m = String(message);
    const digit = m.match(/\b([45]\d{2})\b/);
    if (digit) {
        return Number(digit[1]);
    }
    if (/unauthorized/i.test(m)) {
        return 401;
    }
    if (/forbidden/i.test(m)) {
        return 403;
    }
    return null;
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isAbortError(err) {
    if (err == null || typeof err !== 'object') {
        return false;
    }
    const e = /** @type {{ name?: string, code?: string }} */ (err);
    return e.name === 'AbortError' || e.code === 'ABORT_ERR';
}

/**
 * @param {unknown} cause
 * @returns {Error}
 */
function toAbort(cause) {
    if (cause instanceof Error) {
        if (cause.name !== 'AbortError') {
            cause.name = 'AbortError';
        }
        return cause;
    }
    const err = new Error('aborted');
    err.name = 'AbortError';
    return err;
}
