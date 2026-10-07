/**
 * W1-C · NAI / LLM 网关：错误映射、重试、代理探测（假 fetch，不联网）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createNaiGateway } from '../../src/adapters/nai/nai.gateway.js';
import { createDirectTransport } from '../../src/adapters/nai/transport/direct.js';
import { createStCorsProxyTransport } from '../../src/adapters/nai/transport/st-cors-proxy.js';
import { decodeJsonBase64 } from '../../src/adapters/nai/decoder/json-base64.js';
import { decodeZip } from '../../src/adapters/nai/decoder/zip.js';
import { createLlmGateway } from '../../src/adapters/llm/llm.gateway.js';
import { createStBackendLlmTransport } from '../../src/adapters/llm/transport/st-backend.js';
import { extractJson } from '../../src/adapters/llm/json-extract.js';
import { isOk, isErr } from '../../src/infra/result.js';
import { ERROR_CATEGORY } from '../../src/infra/errors.js';
import { assertImageGenPort } from '../../src/ports/image-gen.port.js';
import { assertLlmPort } from '../../src/ports/llm.port.js';

function naiConfig(overrides = {}) {
    return {
        schemaVersion: 1,
        id: 'n1',
        name: 'test',
        baseUrl: 'https://image.novelai.net',
        apiKey: 'pst-secret-token-do-not-log',
        transport: 'direct',
        decoder: 'json',
        createdAt: 't',
        updatedAt: 't',
        ...overrides,
    };
}

function llmConfig(overrides = {}) {
    return {
        schemaVersion: 1,
        id: 'l1',
        name: 'test',
        baseUrl: 'https://api.example.com/v1',
        secretId: 'sec-test',
        apiKey: 'sk-test',
        model: 'gpt-test',
        createdAt: 't',
        updatedAt: 't',
        ...overrides,
    };
}

/**
 * @param {(data: object) => Promise<object>} sendRequest
 * @param {object} [extra]
 * @param {typeof fetch} [extra.fetch]
 */
function stBackendGw(sendRequest, extra = {}) {
    return createLlmGateway({
        transports: {
            'st-backend': createStBackendLlmTransport({
                getContext: () => ({
                    getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
                    ChatCompletionService: {
                        createRequestData: (d) => d,
                        sendRequest,
                    },
                }),
                fetch: extra.fetch ?? (async () => new Response(JSON.stringify({
                    data: [{ id: 'm1' }],
                }), { status: 200 })),
            }),
        },
        extractJson,
        ...extra,
    });
}

const samplePngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('createNaiGateway', () => {
    it('assertImageGenPort passes', () => {
        const gw = createNaiGateway({
            transports: {
                direct: createDirectTransport({ fetch: async () => new Response('{}') }),
            },
            decoders: {
                'json-base64': { decode: decodeJsonBase64 },
                zip: { decode: decodeZip },
            },
        });
        const checked = assertImageGenPort(gw);
        assert.equal(isOk(checked), true);
    });

    it('maps 401 via upstreamFromHttpStatus and does not retry', async () => {
        let calls = 0;
        const fetchMock = async () => {
            calls += 1;
            return new Response('{"message":"no"}', { status: 401 });
        };
        const gw = createNaiGateway({
            transports: { direct: createDirectTransport({ fetch: fetchMock }) },
            decoders: {
                'json-base64': { decode: decodeJsonBase64 },
                zip: { decode: decodeZip },
            },
            maxAttempts: 3,
            sleep: async () => {},
        });
        const result = await gw.generate(
            { input: 'a', model: 'm', parameters: {} },
            { config: naiConfig() },
        );
        assert.equal(isErr(result), true);
        assert.equal(result.error.code, 'NAI_401');
        assert.equal(result.error.retryable, false);
        assert.equal(result.error.context.disableConfig, true);
        assert.equal(calls, 1);
        assert.equal(JSON.stringify(result.error).includes('pst-secret'), false);
    });

    it('retries 429 respecting Retry-After', async () => {
        let calls = 0;
        const waits = [];
        const fetchMock = async () => {
            calls += 1;
            if (calls === 1) {
                return new Response('rate', {
                    status: 429,
                    headers: { 'Retry-After': '7' },
                });
            }
            return new Response(JSON.stringify({
                images: [{ image: samplePngB64, seed: 1 }],
            }), { status: 201 });
        };
        const gw = createNaiGateway({
            transports: { direct: createDirectTransport({ fetch: fetchMock }) },
            decoders: {
                'json-base64': { decode: decodeJsonBase64 },
                zip: { decode: decodeZip },
            },
            maxAttempts: 3,
            sleep: async (ms) => { waits.push(ms); },
        });
        const result = await gw.generate(
            { input: 'a', model: 'm', parameters: {} },
            { config: naiConfig() },
        );
        assert.equal(isOk(result), true);
        assert.equal(calls, 2);
        assert.equal(waits[0], 7000);
    });

    it('st-cors-proxy probe reports enableCorsProxy hint when disabled', async () => {
        const fetchMock = async (url) => {
            if (String(url).includes('/proxy/')) {
                return new Response(
                    'CORS proxy is disabled. Enable it in config.yaml or use the --corsProxy flag.',
                    { status: 404 },
                );
            }
            return new Response('unexpected', { status: 500 });
        };
        const proxy = createStCorsProxyTransport({ fetch: fetchMock });
        const gw = createNaiGateway({
            transports: {
                direct: createDirectTransport({
                    fetch: async () => { throw new TypeError('Failed to fetch'); },
                }),
                'st-cors-proxy': proxy,
            },
            decoders: {
                'json-base64': { decode: decodeJsonBase64 },
                zip: { decode: decodeZip },
            },
        });
        const report = await gw.probe(naiConfig({ transport: 'st-cors-proxy' }));
        assert.equal(report.ok, false);
        assert.equal(report.error.code, 'NAI_CORS_PROXY_DISABLED');
        assert.match(report.error.hint, /enableCorsProxy/);
        assert.match(report.error.hint, /config\.yaml/);
    });

    it('does not put apiKey into Authorization log context on success path headers check', async () => {
        /** @type {RequestInit|null} */
        let seenInit = null;
        const fetchMock = async (_url, init) => {
            seenInit = init;
            return new Response(JSON.stringify({
                images: [{ image: samplePngB64 }],
            }), { status: 201 });
        };
        const gw = createNaiGateway({
            transports: { direct: createDirectTransport({ fetch: fetchMock }) },
            decoders: {
                'json-base64': { decode: decodeJsonBase64 },
                zip: { decode: decodeZip },
            },
        });
        const result = await gw.generate(
            { input: 'a', model: 'm', parameters: {} },
            { config: naiConfig() },
        );
        assert.equal(isOk(result), true);
        assert.ok(String(seenInit?.headers?.Authorization).includes('Bearer '));
        // 凭证只在请求头，不在 Result / Error 里
        assert.equal(JSON.stringify(result).includes('pst-secret'), false);
    });

    it('propagates AbortSignal as non-retryable', async () => {
        const ac = new AbortController();
        ac.abort();
        const gw = createNaiGateway({
            transports: {
                direct: createDirectTransport({
                    fetch: async () => new Response('{}', { status: 200 }),
                }),
            },
            decoders: {
                'json-base64': { decode: decodeJsonBase64 },
                zip: { decode: decodeZip },
            },
        });
        const result = await gw.generate(
            { input: 'a', model: 'm', parameters: {} },
            { config: naiConfig(), signal: ac.signal },
        );
        assert.equal(isErr(result), true);
        assert.equal(result.error.retryable, false);
        assert.equal(result.error.code, 'UPSTREAM_ABORTED');
    });

    it('空 Key 时报错且不发网络请求（generate + probe）', async () => {
        let calls = 0;
        const fetchMock = async () => {
            calls += 1;
            return new Response('{}', { status: 200 });
        };
        const gw = createNaiGateway({
            transports: { direct: createDirectTransport({ fetch: fetchMock }) },
            decoders: {
                'json-base64': { decode: decodeJsonBase64 },
                zip: { decode: decodeZip },
            },
        });
        const cfg = naiConfig({ name: '默认 NAI', apiKey: '' });
        const gen = await gw.generate(
            { input: 'a', model: 'm', parameters: {} },
            { config: cfg },
        );
        assert.equal(isErr(gen), true);
        assert.equal(gen.error.code, 'NAI_CONFIG_KEY');
        assert.match(gen.error.message, /默认 NAI/);
        assert.match(gen.error.hint || '', /管理台/);
        const probe = await gw.probe(cfg);
        assert.equal(probe.ok, false);
        assert.equal(probe.error?.code, 'NAI_CONFIG_KEY');
        assert.equal(calls, 0);
    });

    it('GET /user/subscription 读出电量和点数，密钥不进错误文案', async () => {
        /** @type {{ url: string, init: RequestInit }[]} */
        const calls = [];
        const payload = {
            trainingStepsLeft: { fixedTrainingStepsLeft: 9898, purchasedTrainingSteps: 32 },
            usage: { percent: 87, isNegative: false, timeUntilNextPercent: 120 },
        };
        const fetchMock = async (url, init) => {
            calls.push({ url: String(url), init });
            return new Response(JSON.stringify(payload), { status: 200 });
        };
        const gw = createNaiGateway({
            transports: { direct: createDirectTransport({ fetch: fetchMock }) },
            decoders: {
                'json-base64': { decode: decodeJsonBase64 },
                zip: { decode: decodeZip },
            },
        });
        const result = await gw.fetchSubscription(naiConfig({
            baseUrl: 'https://image.novelai.net/ai/generate-image',
            apiKey: 'pst-secret-token-do-not-log',
        }));
        assert.equal(isOk(result), true);
        assert.equal(result.value.points, 9930);
        assert.equal(result.value.energy.percent, 87);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, 'https://image.novelai.net/user/subscription');
        assert.equal(calls[0].init.method, 'GET');
        assert.equal(calls[0].init.headers.Authorization, 'Bearer pst-secret-token-do-not-log');

        const fetchDenied = async () => new Response('{"message":"no"}', { status: 401 });
        const deniedGw = createNaiGateway({
            transports: { direct: createDirectTransport({ fetch: fetchDenied }) },
            decoders: {
                'json-base64': { decode: decodeJsonBase64 },
                zip: { decode: decodeZip },
            },
        });
        const deniedResult = await deniedGw.fetchSubscription(naiConfig());
        assert.equal(isErr(deniedResult), true);
        assert.equal(deniedResult.error.code, 'NAI_401');
        assert.equal(String(deniedResult.error.message).includes('pst-secret'), false);
        assert.equal(String(deniedResult.error.hint || '').includes('停用'), false);
    });
});

describe('createLlmGateway', () => {
    it('assertLlmPort passes', () => {
        const gw = stBackendGw(async () => ({ content: '{}' }));
        assert.equal(isOk(assertLlmPort(gw)), true);
    });

    it('空 Key 时报错且不发网络请求（complete + probe）', async () => {
        let calls = 0;
        const gw = stBackendGw(async () => {
            calls += 1;
            return { content: '{}' };
        });
        const cfg = llmConfig({ name: '默认 LLM', secretId: null, apiKey: '' });
        const result = await gw.complete({
            messages: [{ role: 'user', content: 'hi' }],
            config: cfg,
        });
        assert.equal(isErr(result), true);
        assert.equal(result.error.code, 'LLM_CONFIG_KEY');
        assert.match(result.error.message, /默认 LLM/);
        assert.match(result.error.hint || '', /管理台/);
        const probe = await gw.probe(cfg);
        assert.equal(probe.ok, false);
        assert.equal(probe.error?.code, 'LLM_CONFIG_KEY');
        assert.equal(calls, 0);
    });

    it('st-backend passes the API key on the OpenAI proxy and does not send secret_id', async () => {
        /** @type {object|null} */
        let seenData = null;
        const getContext = () => ({
            getRequestHeaders: () => ({}),
            ChatCompletionService: {
                createRequestData(data) {
                    return { ...data, use_sysprompt: true };
                },
                async sendRequest(data) {
                    seenData = data;
                    return { content: '```json\n{"keys":["a"]}\n```' };
                },
            },
        });
        const gw = createLlmGateway({
            transports: {
                'st-backend': createStBackendLlmTransport({ getContext }),
            },
            extractJson,
        });
        const result = await gw.complete({
            messages: [{ role: 'user', content: 'recall' }],
            config: llmConfig({
                baseUrl: 'https://llm.example.com/v1',
                secretId: 'sec-abc',
                apiKey: 'sk-test',
            }),
            jsonSchema: { name: 'keys', value: { type: 'object' } },
        });
        assert.equal(isOk(result), true);
        assert.equal(seenData.chat_completion_source, 'custom');
        assert.equal(seenData.custom_url, 'https://llm.example.com/v1');
        assert.equal(seenData.custom_include_headers, 'Authorization: "Bearer sk-test"');
        assert.equal('secret_id' in seenData, false);
        assert.equal(seenData.stream, false);
        assert.equal('json_schema' in seenData, false);
        assert.equal('reverse_proxy' in seenData, false);
        assert.deepEqual(result.value.json, { keys: ['a'] });
        assert.equal(JSON.stringify(result).includes('sk-secret'), false);
    });

    it('ContractError preserves raw LLM text when extract fails', async () => {
        const gw = stBackendGw(async () => ({ content: '抱歉我不能输出 JSON' }));
        const result = await gw.complete({
            messages: [{ role: 'user', content: 'x' }],
            config: llmConfig(),
            jsonSchema: { type: 'object' },
        });
        assert.equal(isErr(result), true);
        assert.equal(result.error.category, ERROR_CATEGORY.CONTRACT);
        assert.equal(result.error.context.rawText, '抱歉我不能输出 JSON');
    });

    it('retries retryable upstream then succeeds', async () => {
        let calls = 0;
        const gw = stBackendGw(async () => {
            calls += 1;
            if (calls === 1) {
                throw new Error('Got response status 503');
            }
            return { content: 'done' };
        }, {
            maxAttempts: 3,
            sleep: async () => {},
        });
        const result = await gw.complete({
            messages: [{ role: 'user', content: 'x' }],
            config: llmConfig(),
        });
        assert.equal(isOk(result), true);
        assert.equal(result.value.text, 'done');
        assert.equal(calls, 2);
    });

    it('D26: st-backend keeps Chinese message; English only in cause/preview', async () => {
        let calls = 0;
        const getContext = () => ({
            ChatCompletionService: {
                createRequestData: (d) => d,
                async sendRequest() {
                    calls += 1;
                    throw new Error('Got response status 503');
                },
            },
        });
        const gw = createLlmGateway({
            transports: {
                'st-backend': createStBackendLlmTransport({ getContext }),
            },
            extractJson,
            maxAttempts: 1,
            sleep: async () => {},
        });
        const result = await gw.complete({
            messages: [{ role: 'user', content: 'x' }],
            config: llmConfig(),
            traceId: 't-d26',
        });
        assert.equal(isErr(result), true);
        assert.equal(result.error.code, 'UPSTREAM_503');
        assert.match(result.error.message, /上游服务异常|HTTP 503/);
        assert.equal(/Got response status/i.test(result.error.message), false);
        assert.equal(result.error.context.preview, 'Got response status 503');
        assert.equal(result.error.traceId, 't-d26');
        assert.equal(calls, 1);
    });

    it('D27: Response not OK without status is non-retryable', async () => {
        let calls = 0;
        const getContext = () => ({
            ChatCompletionService: {
                createRequestData: (d) => d,
                async sendRequest() {
                    calls += 1;
                    throw new Error('Response not OK');
                },
            },
        });
        const gw = createLlmGateway({
            transports: {
                'st-backend': createStBackendLlmTransport({ getContext }),
            },
            extractJson,
            maxAttempts: 3,
            sleep: async () => {},
        });
        const result = await gw.complete({
            messages: [{ role: 'user', content: 'x' }],
            config: llmConfig(),
            traceId: 't-d27',
        });
        assert.equal(isErr(result), true);
        assert.equal(result.error.retryable, false);
        assert.equal(result.error.code, 'LLM_ST_BACKEND_FAILED');
        assert.equal(result.error.message, '经酒馆调用大模型失败');
        assert.equal(/Response not OK/.test(result.error.message), false);
        assert.equal(result.error.context.preview, 'Response not OK');
        assert.equal(result.error.traceId, 't-d27');
        assert.equal(calls, 1, 'must not speculative-retry');
    });

    it('D14: traceId propagates on NAI 401 / decode fail / abort', async () => {
        const tid = 'trace-nai-1';
        const gw401 = createNaiGateway({
            transports: {
                direct: createDirectTransport({
                    fetch: async () => new Response('no', { status: 401 }),
                }),
            },
            decoders: {
                'json-base64': { decode: decodeJsonBase64 },
                zip: { decode: decodeZip },
            },
        });
        const r401 = await gw401.generate(
            { input: 'a', model: 'm', parameters: {} },
            { config: naiConfig(), traceId: tid },
        );
        assert.equal(isErr(r401), true);
        assert.equal(r401.error.traceId, tid);

        const gwDecode = createNaiGateway({
            transports: {
                direct: createDirectTransport({
                    fetch: async () => new Response('not-json-or-zip', { status: 201 }),
                }),
            },
            decoders: {
                'json-base64': { decode: decodeJsonBase64 },
                zip: { decode: decodeZip },
            },
        });
        const rDec = await gwDecode.generate(
            { input: 'a', model: 'm', parameters: {} },
            { config: naiConfig({ decoder: 'json' }), traceId: tid },
        );
        assert.equal(isErr(rDec), true);
        assert.equal(rDec.error.traceId, tid);

        const ac = new AbortController();
        ac.abort();
        const gwAbort = createNaiGateway({
            transports: {
                direct: createDirectTransport({
                    fetch: async () => new Response('{}', { status: 200 }),
                }),
            },
            decoders: {
                'json-base64': { decode: decodeJsonBase64 },
                zip: { decode: decodeZip },
            },
        });
        const rAbort = await gwAbort.generate(
            { input: 'a', model: 'm', parameters: {} },
            { config: naiConfig(), signal: ac.signal, traceId: tid },
        );
        assert.equal(isErr(rAbort), true);
        assert.equal(rAbort.error.traceId, tid);
        assert.equal(rAbort.error.code, 'UPSTREAM_ABORTED');
    });
});
