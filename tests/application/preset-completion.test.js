import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { completePresetRequest } from '../../src/application/preset-completion.js';
import { Ok, Err } from '../../src/infra/result.js';
import { contractError, hostError, upstreamFromHttpStatus } from '../../src/infra/errors.js';
import { createLlmGateway } from '../../src/adapters/llm/llm.gateway.js';

const request = { messages: [{ role: 'user', content: '原预设与上下文' }], config: {}, traceId: 'retry-trace' };
const invalid = (text = '缺少 scene') => Err(contractError({
    code: 'OUTPUT_MISSING', message: text, context: { issues: [text] },
}));

describe('preset result correction retries', () => {
    it('feeds the previous result and precise validation issue back before succeeding', async () => {
        const calls = [];
        const withImage = { ...request, messages: [
            { role: 'user', content: [
                { type: 'text', text: '原预设与上下文' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
            ] },
        ] };
        const r = await completePresetRequest({
            stage: '生图', request: withImage,
            llm: { complete: async (req) => {
                calls.push(structuredClone(req));
                return Ok({ text: calls.length === 1 ? '坏回文' : '完整回文' });
            } },
            validate: (value) => value.text === '完整回文' ? Ok(value) : invalid(),
        });
        assert.equal(r.ok, true);
        assert.equal(r.value.llmCallCount, 2);
        assert.deepEqual(calls[1].messages.slice(0, -2), withImage.messages);
        assert.equal(calls[1].messages[0].content[1].image_url.url, 'data:image/png;base64,AAAA');
        assert.deepEqual(calls[1].messages.at(-2), { role: 'assistant', content: '坏回文' });
        assert.match(calls[1].messages.at(-1).content, /缺少 scene/);
        assert.match(calls[1].messages.at(-1).content, /完整结果/);
        assert.equal(calls[1].traceId, 'retry-trace');
        assert.deepEqual(request.messages, [{ role: 'user', content: '原预设与上下文' }]);
    });

    for (const retryCount of [undefined, 0, 1, 5]) {
        it(`respects retryCount=${retryCount ?? 'default 3'} and preserves final raw output`, async () => {
            let calls = 0;
            const r = await completePresetRequest({
                stage: '召回', preset: retryCount === undefined ? {} : { retryCount }, request,
                llm: { complete: async () => Ok({ text: `bad-${++calls}` }) }, validate: () => invalid(),
            });
            assert.equal(r.ok, false);
            assert.equal(calls, (retryCount ?? 3) + 1);
            assert.equal(r.error.code, 'OUTPUT_MISSING');
            assert.equal(r.error.context.rawText, `bad-${calls}`);
            assert.equal(r.error.context.llmCallCount, calls);
            assert.equal(r.error.context.retriesUsed, retryCount ?? 3);
            assert.equal(r.error.traceId, 'retry-trace');
        });
    }

    it('keeps only the last failed response in the correction conversation', async () => {
        const calls = [];
        const r = await completePresetRequest({
            stage: '生图', request, preset: { retryCount: 3 },
            llm: { complete: async (req) => {
                calls.push(structuredClone(req.messages));
                return Ok({ text: `bad-${calls.length}` });
            } }, validate: () => invalid(),
        });
        assert.equal(r.ok, false);
        assert.deepEqual(calls.map((messages) => messages.length), [1, 3, 3, 3]);
        assert.equal(calls[3].at(-2).content, 'bad-3');
    });

    it('JSON extraction errors also receive correction feedback through the real LLM gateway', async () => {
        const calls = [];
        const gateway = createLlmGateway({ transports: { 'st-backend': {
            async complete(req) {
                calls.push(structuredClone(req.messages));
                return Ok({ text: calls.length === 1 ? '{not json' : '{"positions":[]}' });
            },
        } } });
        const r = await completePresetRequest({
            llm: gateway, stage: '召回', request: { ...request, jsonSchema: {} },
            validate: (response) => Ok(response),
        });
        assert.equal(r.ok, true);
        assert.equal(calls.length, 2);
        assert.equal(calls[1].at(-2).content, '{not json');
        assert.match(calls[1].at(-1).content, /JSON/i);
    });

    for (const error of [
        hostError({ code: 'LLM_ACU_IF_UNRESOLVED', message: '未解析 if' }),
        upstreamFromHttpStatus(401), upstreamFromHttpStatus(429),
    ]) {
        it(`does not turn ${error.code} into an output correction request`, async () => {
            let calls = 0;
            const r = await completePresetRequest({
                stage: '生图', request,
                llm: { complete: async () => { calls++; return Err(error); } },
                validate: () => assert.fail('网络/宿主错误不应校验结果'),
            });
            assert.equal(r.ok, false);
            assert.equal(calls, 1);
        });
    }

    it('cancels before a correction request is sent', async () => {
        const controller = new AbortController();
        let calls = 0;
        const r = await completePresetRequest({
            stage: '生图', request: { ...request, signal: controller.signal },
            llm: { complete: async () => { calls++; return Ok({ text: 'bad' }); } },
            validate: () => { controller.abort(); return invalid(); },
        });
        assert.equal(r.ok, false);
        assert.equal(r.error.code, 'UPSTREAM_ABORTED');
        assert.equal(calls, 1);
    });

    it('does not return success after cancellation during a completed model request', async () => {
        const controller = new AbortController();
        const r = await completePresetRequest({
            stage: '生图', request: { ...request, signal: controller.signal },
            llm: { complete: async () => { controller.abort(); return Ok({ text: 'valid' }); } },
            validate: () => assert.fail('取消后不应继续处理结果'),
        });
        assert.equal(r.error.code, 'UPSTREAM_ABORTED');
    });

    it('can correct an empty result without sending an empty assistant message', async () => {
        let calls = 0;
        const r = await completePresetRequest({
            stage: '生图', request,
            llm: { complete: async (req) => {
                if (++calls === 1) return Ok({ text: '' });
                assert.ok(req.messages.at(-2).content.length > 0);
                return Ok({ text: 'valid' });
            } },
            validate: (response) => response.text ? Ok(response) : invalid('缺少 scene，返回为空'),
        });
        assert.equal(r.ok, true);
        assert.equal(calls, 2);
    });
});
