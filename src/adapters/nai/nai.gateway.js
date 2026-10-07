/**
 * L2 适配器 · ImageGenPort 实现：传输策略矩阵 + 解码（架构 §6.7）。
 * 归属：W1-C 网关代理实现。W0 仅冻结签名。
 */

import { Ok, Err, isOk, isErr } from '../../infra/result.js';
import {
    configError,
    transportError,
    upstreamFromHttpStatus,
} from '../../infra/errors.js';
import { apiConfigDisplayName } from '../../domain/model/api-config.js';
import {
    parseSubscriptionBalance,
    resolveSubscriptionUrl,
} from '../../domain/nai/subscription-balance.js';

const DEFAULT_MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 60000;

/**
 * @param {unknown} body
 * @returns {string}
 */
function readUpstreamNote(body) {
    let bytes = null;
    if (body instanceof ArrayBuffer) {
        bytes = new Uint8Array(body);
    } else if (ArrayBuffer.isView(body)) {
        bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    }
    if (!bytes || bytes.length === 0) return '';
    if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) return '';
    let text = '';
    try {
        text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    } catch {
        return '';
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (!text || /[\u0000-\u0008]/.test(text)) return '';
    let note = text;
    try {
        const json = JSON.parse(text);
        const msg = json?.message ?? json?.error ?? json?.detail;
        if (typeof msg === 'string') note = msg;
    } catch {
        /* 纯文本 */
    }
    note = String(note).replace(/\s+/g, ' ').trim();
    if (!note) return '';
    return note.length > 160 ? `${note.slice(0, 160)}…` : note;
}

/**
 * @param {unknown} body
 * @returns {Promise<Record<string, unknown>|null>}
 */
async function readJsonObject(body) {
    let text = '';
    if (typeof body === 'string') {
        text = body;
    } else if (body instanceof ArrayBuffer) {
        text = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(body));
    } else if (ArrayBuffer.isView(body)) {
        text = new TextDecoder('utf-8', { fatal: false }).decode(
            new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
        );
    } else if (body && typeof /** @type {{ text?: Function }} */ (body).text === 'function') {
        text = await /** @type {{ text: Function }} */ (body).text();
    }
    if (!String(text).trim()) return null;
    try {
        const json = JSON.parse(text);
        return json && typeof json === 'object' ? json : null;
    } catch {
        return null;
    }
}

/**
 * @typedef {import('../../ports/image-gen.port.js').NaiGatewayDeps} NaiGatewayDeps
 */

/**
 * @param {NaiGatewayDeps} deps
 * @returns {import('../../ports/image-gen.port.js').ImageGenPort}
 */
export function createNaiGateway(deps) {
    if (!deps || typeof deps !== 'object') {
        throw new Error('invalid argument: deps');
    }
    const transports = deps.transports ?? {};
    const decoders = deps.decoders ?? {};
    const maxAttempts = Number(deps.maxAttempts) > 0
        ? Number(deps.maxAttempts)
        : DEFAULT_MAX_ATTEMPTS;
    const sleepFn = typeof deps.sleep === 'function' ? deps.sleep : sleep;

    return {
        async generate(req, opts) {
            const config = opts?.config;
            const signal = opts?.signal;
            const traceId = opts?.traceId ?? null;

            const cfgErr = validateNaiConfig(config);
            if (cfgErr) {
                cfgErr.traceId = traceId;
                return Err(cfgErr);
            }

            const transportName = config.transport === 'st-cors-proxy'
                ? 'st-cors-proxy'
                : 'direct';
            const transport = transports[transportName];
            if (!transport || typeof transport.send !== 'function') {
                return Err(configError({
                    code: 'NAI_TRANSPORT_MISSING',
                    message: `生图传输通道不可用：${transportName}`,
                    hint: '请刷新页面或重新启用插件后重试',
                    traceId,
                    context: { transport: transportName },
                }));
            }

            const url = resolveGenerateUrl(config.baseUrl);
            const accept = preferJsonAccept(config.decoder)
                ? 'application/json'
                : 'application/zip, application/octet-stream';
            const body = JSON.stringify(toWirePayload(req));
            /** @type {Record<string, string>} */
            const headers = {
                'Content-Type': 'application/json',
                Accept: accept,
                Authorization: `Bearer ${config.apiKey}`,
            };

            /** @type {import('../../infra/errors.js').AppError|null} */
            let lastError = null;

            for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
                if (signal?.aborted) {
                    return Err(upstreamFromHttpStatus(0, {
                        cause: abortCause(signal),
                        traceId,
                    }));
                }

                const sent = await transport.send(url, {
                    method: 'POST',
                    headers,
                    body,
                    signal,
                });

                if (isErr(sent)) {
                    const err = stampTrace(sent.error, traceId);
                    // 传输层失败（CORS/代理关闭）：代理关闭等不可重试；其余可重试但受 maxAttempts 限制
                    if (!err.retryable || attempt === maxAttempts - 1) {
                        return Err(err);
                    }
                    lastError = err;
                    const waited = await safeSleep(sleepFn, backoffMs(attempt, null), signal, traceId);
                    if (isErr(waited)) {
                        return waited;
                    }
                    continue;
                }

                const response = sent.value;
                const status = Number(response.status);

                // NAI 文档：成功为 201；部分中转可能回 200
                if (status >= 200 && status < 300) {
                    const decoded = await decodeResponse(response, config.decoder, decoders, traceId);
                    if (isOk(decoded)) {
                        return decoded;
                    }
                    return Err(stampTrace(decoded.error, traceId));
                }

                const retryAfterSec = parseRetryAfterSec(response.headers);
                const upstreamNote = status === 400 ? readUpstreamNote(response.body) : '';
                const upstreamErr = upstreamFromHttpStatus(status, {
                    traceId,
                    cause: null,
                    message: upstreamNote ? `请求不被上游接受（HTTP 400）：${upstreamNote}` : undefined,
                    context: {
                        transport: transportName,
                        ...(retryAfterSec != null ? { retryAfterSec } : {}),
                    },
                });

                if (!upstreamErr.retryable || attempt === maxAttempts - 1) {
                    return Err(upstreamErr);
                }
                lastError = upstreamErr;
                const waited = await safeSleep(sleepFn, backoffMs(attempt, retryAfterSec), signal, traceId);
                if (isErr(waited)) {
                    return waited;
                }
            }

            return Err(stampTrace(lastError, traceId) ?? transportError({
                code: 'NAI_GENERATE_FAILED',
                message: '生图请求失败',
                traceId,
            }));
        },

        async probe(config) {
            const cfgErr = validateNaiConfig(config);
            if (cfgErr) {
                return {
                    ok: false,
                    transport: String(config?.transport ?? ''),
                    decoder: String(config?.decoder ?? 'auto'),
                    detail: cfgErr.message,
                    error: cfgErr,
                };
            }

            const preferred = config.transport === 'st-cors-proxy'
                ? 'st-cors-proxy'
                : 'direct';
            const order = preferred === 'direct'
                ? ['direct', 'st-cors-proxy']
                : ['st-cors-proxy', 'direct'];

            /** @type {import('../../infra/errors.js').AppError|null} */
            let lastError = null;

            for (const name of order) {
                const transport = transports[name];
                if (!transport || typeof transport.send !== 'function') {
                    continue;
                }

                if (name === 'st-cors-proxy' && typeof transport.probeEnabled === 'function') {
                    const enabled = await transport.probeEnabled();
                    if (isErr(enabled)) {
                        lastError = enabled.error;
                        if (preferred === 'st-cors-proxy') {
                            // 用户指定代理但未开：直接给出精确指引，不再假装 direct 一定可用（R-01）
                            return {
                                ok: false,
                                transport: name,
                                decoder: mapDecoderName(config.decoder),
                                detail: enabled.error.message,
                                error: enabled.error,
                            };
                        }
                        continue;
                    }
                }

                // 轻量连通：GET 配置根地址（不触发计费生图）。官方 CORS 是否放行属 R-01，结果以本次探测为准。
                const probeUrl = resolveBaseUrl(config.baseUrl);
                const sent = await transport.send(probeUrl, {
                    method: 'GET',
                    headers: {
                        Accept: 'application/json',
                        Authorization: `Bearer ${config.apiKey}`,
                    },
                });

                if (isErr(sent)) {
                    lastError = sent.error;
                    continue;
                }

                const status = Number(sent.value.status);
                // 2xx/3xx/401/403/404/405 都说明「通道可达」；401 说明鉴权到达对端
                if (status === 0) {
                    lastError = transportError({
                        code: 'NAI_PROBE_NO_STATUS',
                        message: '探测未获得有效 HTTP 状态',
                        context: { transport: name },
                    });
                    continue;
                }

                if (status >= 500) {
                    lastError = upstreamFromHttpStatus(status, {
                        context: { transport: name },
                    });
                    continue;
                }

                return {
                    ok: true,
                    transport: name,
                    decoder: mapDecoderName(config.decoder),
                    detail: `通道 ${name} 可达（HTTP ${status}）。官方 NAI 的 CORS 是否稳定仍取决于对端，请以实际生图为准（风险 R-01）。`,
                };
            }

            return {
                ok: false,
                transport: preferred,
                decoder: mapDecoderName(config.decoder),
                detail: lastError?.message ?? '所有传输通道均不可用',
                error: lastError ?? transportError({
                    code: 'NAI_PROBE_FAILED',
                    message: 'NAI 连通性自检失败',
                    hint: '直连失败时：在 config.yaml 开启 enableCorsProxy 并重启，再把传输方式改为「酒馆 CORS 代理」',
                }),
            };
        },

        async fetchSubscription(config) {
            const cfgErr = validateNaiConfig(config);
            if (cfgErr) return Err(cfgErr);

            const transportName = config.transport === 'st-cors-proxy'
                ? 'st-cors-proxy'
                : 'direct';
            const transport = transports[transportName];
            if (!transport || typeof transport.send !== 'function') {
                return Err(configError({
                    code: 'NAI_TRANSPORT_MISSING',
                    message: `余额查询通道不可用：${transportName}`,
                    hint: '请刷新页面或重新启用插件后重试',
                    context: { transport: transportName },
                }));
            }
            if (transportName === 'st-cors-proxy' && typeof transport.probeEnabled === 'function') {
                const enabled = await transport.probeEnabled();
                if (isErr(enabled)) return enabled;
            }

            const sent = await transport.send(resolveSubscriptionUrl(config.baseUrl), {
                method: 'GET',
                headers: {
                    Accept: 'application/json',
                    Authorization: `Bearer ${config.apiKey}`,
                },
            });
            if (isErr(sent)) return sent;

            const status = Number(sent.value.status);
            if (!(status >= 200 && status < 300)) {
                const note = readUpstreamNote(sent.value.body);
                const mapped = upstreamFromHttpStatus(status, {
                    hint: '请检查 API 密钥或接口地址',
                    context: { transport: transportName },
                });
                if (note && status !== 401 && status !== 403) {
                    mapped.message = `${mapped.message}：${note}`;
                }
                return Err(mapped);
            }

            const json = await readJsonObject(sent.value.body);
            if (!json) {
                return Err(upstreamFromHttpStatus(status, {
                    code: 'NAI_SUBSCRIPTION_BODY',
                    message: '余额响应无法解析',
                    hint: '请确认接口地址指向 NovelAI 图像接口（image.novelai.net）',
                    context: { transport: transportName },
                }));
            }
            return Ok(parseSubscriptionBalance(json));
        },
    };
}

/**
 * 确保 AppError.traceId 不为空（裁决 D14 / 架构 §10）。
 * @template {import('../../infra/errors.js').AppError} E
 * @param {E|null|undefined} err
 * @param {string|null} traceId
 * @returns {E|null|undefined}
 */
function stampTrace(err, traceId) {
    if (err && traceId && !err.traceId) {
        err.traceId = traceId;
    }
    return err;
}

/**
 * @param {import('../../domain/model/api-config.js').NaiApiConfig|null|undefined} config
 * @returns {import('../../infra/errors.js').AppError|null}
 */
function validateNaiConfig(config) {
    if (!config || typeof config !== 'object') {
        return configError({
            code: 'NAI_CONFIG_MISSING',
            message: '未提供 NAI API',
            hint: '请先在 NAI API 库中新增并激活一条配置',
        });
    }
    const label = apiConfigDisplayName(config);
    if (!String(config.baseUrl || '').trim()) {
        return configError({
            code: 'NAI_CONFIG_URL',
            message: `「${label}」还没填接口地址`,
            hint: '请到管理台 → API 库中填写接口地址',
        });
    }
    if (!String(config.apiKey || '').trim()) {
        return configError({
            code: 'NAI_CONFIG_KEY',
            message: `「${label}」还没填 API 密钥`,
            hint: '请到管理台 → API 库中填写 API 密钥',
        });
    }
    return null;
}

/**
 * @param {import('../../domain/model/nai-params.js').NaiRequest} req
 * @returns {Record<string, unknown>}
 */
const NAI_INT_FIELDS = ['tag_hint_qt', 'tag_hint_uc_preset'];

function toWirePayload(req) {
    /** @type {Record<string, unknown>} */
    const parameters = req.parameters && typeof req.parameters === 'object'
        ? { ...req.parameters }
        : req.parameters;
    if (parameters && typeof parameters === 'object') {
        for (const key of NAI_INT_FIELDS) {
            if (typeof parameters[key] === 'boolean') {
                parameters[key] = parameters[key] ? 1 : 0;
            }
        }
    }
    /** @type {Record<string, unknown>} */
    const wire = {
        input: req.input,
        model: req.model,
        action: req.action === 'img2img' ? 'img2img' : 'generate',
        parameters,
    };
    // 顶层 negative_prompt 仅作领域镜像；上游以 parameters.negative_prompt 为准
    if (req.extra && typeof req.extra === 'object') {
        for (const [key, value] of Object.entries(req.extra)) {
            if (!(key in wire)) {
                wire[key] = value;
            }
        }
    }
    return wire;
}

/**
 * @param {string} baseUrl
 * @returns {string}
 */
function resolveGenerateUrl(baseUrl) {
    const trimmed = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (/\/ai\/generate-image$/i.test(trimmed)) {
        return trimmed;
    }
    if (/\/ai$/i.test(trimmed)) {
        return `${trimmed}/generate-image`;
    }
    return `${trimmed}/ai/generate-image`;
}

/**
 * @param {string} baseUrl
 * @returns {string}
 */
function resolveBaseUrl(baseUrl) {
    try {
        const u = new URL(String(baseUrl).trim());
        return `${u.origin}/`;
    } catch {
        return String(baseUrl || '').trim();
    }
}

/**
 * @param {'auto'|'json'|'zip'|string|undefined} decoder
 * @returns {boolean}
 */
function preferJsonAccept(decoder) {
    return decoder !== 'zip';
}

/**
 * @param {'auto'|'json'|'zip'|string|undefined} decoder
 * @returns {string}
 */
function mapDecoderName(decoder) {
    if (decoder === 'zip') {
        return 'zip';
    }
    if (decoder === 'json') {
        return 'json-base64';
    }
    return 'auto';
}

/**
 * @param {import('./transport/direct.js').TransportResponse} response
 * @param {'auto'|'json'|'zip'|string|undefined} decoderPref
 * @param {Record<string, { decode: Function }>} decoders
 * @param {string|null} traceId
 */
async function decodeResponse(response, decoderPref, decoders, traceId) {
    const choice = chooseDecoder(response, decoderPref);
    const decoder = decoders[choice];
    if (!decoder || typeof decoder.decode !== 'function') {
        return Err(configError({
            code: 'NAI_DECODER_MISSING',
            message: `图片解码方式不可用：${choice}`,
            hint: '请刷新页面或重新启用插件后重试',
            traceId,
            context: { decoder: choice },
        }));
    }
    const result = await decoder.decode(response);
    if (isErr(result) && decoderPref === 'auto' && choice === 'json-base64') {
        // auto：JSON 失败再试 zip
        const zipDec = decoders.zip;
        if (zipDec && typeof zipDec.decode === 'function') {
            const zipResult = await zipDec.decode(response);
            if (isErr(zipResult)) {
                stampTrace(zipResult.error, traceId);
            }
            return zipResult;
        }
    }
    if (isErr(result)) {
        stampTrace(result.error, traceId);
    }
    return result;
}

/**
 * @param {import('./transport/direct.js').TransportResponse} response
 * @param {'auto'|'json'|'zip'|string|undefined} decoderPref
 * @returns {'json-base64'|'zip'}
 */
function chooseDecoder(response, decoderPref) {
    if (decoderPref === 'zip') {
        return 'zip';
    }
    if (decoderPref === 'json') {
        return 'json-base64';
    }
    const ct = getHeader(response.headers, 'content-type')?.toLowerCase() ?? '';
    if (ct.includes('json')) {
        return 'json-base64';
    }
    if (ct.includes('zip') || ct.includes('octet-stream')) {
        return 'zip';
    }
    // 魔数嗅探
    const head = peekBytes(response.body, 4);
    if (head) {
        if (head[0] === 0x50 && head[1] === 0x4b) {
            return 'zip';
        }
        if (head[0] === 0x89 && head[1] === 0x50) {
            return 'zip';
        }
        if (head[0] === 0x7b || head[0] === 0x5b) {
            return 'json-base64';
        }
    }
    return 'json-base64';
}

/**
 * @param {Headers|Record<string,string>|undefined} headers
 * @param {string} name
 * @returns {string|null}
 */
function getHeader(headers, name) {
    if (!headers) {
        return null;
    }
    if (typeof /** @type {Headers} */ (headers).get === 'function') {
        return /** @type {Headers} */ (headers).get(name);
    }
    const lower = name.toLowerCase();
    for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() === lower) {
            return String(v);
        }
    }
    return null;
}

/**
 * @param {Headers|Record<string,string>|undefined} headers
 * @returns {number|null}
 */
function parseRetryAfterSec(headers) {
    const raw = getHeader(headers, 'retry-after');
    if (raw == null || raw === '') {
        return null;
    }
    const asNum = Number(raw);
    if (Number.isFinite(asNum)) {
        return Math.max(0, asNum);
    }
    const when = Date.parse(raw);
    if (!Number.isNaN(when)) {
        return Math.max(0, (when - Date.now()) / 1000);
    }
    return null;
}

/**
 * @param {number} attempt 从 0 起
 * @param {number|null|undefined} retryAfterSec
 * @returns {number}
 */
function backoffMs(attempt, retryAfterSec) {
    if (retryAfterSec != null && Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
        return Math.min(MAX_BACKOFF_MS, Math.floor(retryAfterSec * 1000));
    }
    const exp = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * (2 ** attempt));
    const jitter = Math.floor(Math.random() * 500);
    return exp + jitter;
}

/**
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} sleepFn
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @param {string|null} traceId
 * @returns {Promise<import('../../infra/result.js').Ok<true>|import('../../infra/result.js').Err<import('../../infra/errors.js').AppError>>}
 */
async function safeSleep(sleepFn, ms, signal, traceId) {
    try {
        await sleepFn(ms, signal);
        return Ok(true);
    } catch (cause) {
        return Err(upstreamFromHttpStatus(0, {
            cause: isAbortError(cause) ? cause : abortCause(signal),
            traceId,
        }));
    }
}

/**
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(abortCause(signal));
            return;
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, Math.max(0, ms));
        function onAbort() {
            clearTimeout(timer);
            reject(abortCause(signal));
        }
        signal?.addEventListener('abort', onAbort, { once: true });
    });
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
 * @param {AbortSignal} [signal]
 * @returns {Error}
 */
function abortCause(signal) {
    const reason = signal?.reason;
    if (reason instanceof Error) {
        if (reason.name !== 'AbortError') {
            reason.name = 'AbortError';
        }
        return reason;
    }
    const err = new Error('aborted');
    err.name = 'AbortError';
    return err;
}

/**
 * @param {ArrayBuffer|Blob|string|Uint8Array|undefined} body
 * @param {number} n
 * @returns {Uint8Array|null}
 */
function peekBytes(body, n) {
    if (body instanceof Uint8Array) {
        return body.subarray(0, n);
    }
    if (body instanceof ArrayBuffer) {
        return new Uint8Array(body, 0, Math.min(n, body.byteLength));
    }
    if (typeof body === 'string') {
        return new TextEncoder().encode(body.slice(0, n));
    }
    return null;
}
