import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { prepareChatCompletionPrompt } from '../../src/adapters/host/chat-completion.bridge.js';
import { createStBackendLlmTransport } from '../../src/adapters/llm/transport/st-backend.js';
import { createLlmGateway } from '../../src/adapters/llm/llm.gateway.js';
import { renderPreset } from '../../src/domain/template/preset-renderer.js';

const EVENT = 'chat_completion_settings_ready';
const config = {
    name: 'test', model: 'test-model', baseUrl: 'https://example.com/v1',
    apiKey: 'sk-test', temperature: 0,
};

function setup(listener) {
    const sent = [];
    const ctx = {
        eventTypes: { CHAT_COMPLETION_SETTINGS_READY: EVENT },
        eventSource: {
            async emit(event, data) {
                assert.equal(this, ctx.eventSource);
                assert.equal(event, EVENT);
                if (listener) await listener(data);
            },
        },
        ChatCompletionService: {
            createRequestData: (data) => data,
            async sendRequest(data) {
                sent.push(structuredClone(data));
                return { content: 'ok' };
            },
        },
    };
    const transport = createStBackendLlmTransport({ getContext: () => ctx });
    return { ctx, sent, transport };
}

describe('发送前的宿主模板事件', () => {
    it('在世界书和上下文注入后等待异步监听器，再发送处理后的完整请求', async () => {
        const worldbook = '<if seed="战斗">战斗设定<else>日常设定</if>';
        const context = '<if cell="状态/主角/体力 > 0">正文</if>';
        const messages = renderPreset({
            prompts: [{ identifier: 'p', role: 'user', content: '{{世界书}}\n{{当前上下文}}' }],
        }, new Map([['世界书', worldbook], ['当前上下文', context]]), {
            runHostMacros: (text) => text,
        });
        const original = structuredClone(messages);
        const order = [];
        const { transport, sent } = setup(async (data) => {
            order.push('template-start');
            assert.equal(data.messages[0].content, `${worldbook}\n${context}`);
            assert.equal(data.model, config.model);
            assert.equal(data.chat_completion_source, 'custom');
            assert.equal(data.temperature, 0);
            await Promise.resolve();
            data.messages[0].content = '战斗设定\n正文';
            order.push('template-end');
        });
        const r = await transport.complete({ config, messages });
        order.push('complete');
        assert.equal(r.ok, true);
        assert.deepEqual(order, ['template-start', 'template-end', 'complete']);
        assert.equal(sent.length, 1);
        assert.equal(sent[0].messages[0].content, '战斗设定\n正文');
        assert.equal(sent[0].stream, false);
        assert.deepEqual(messages, original);
    });

    it('保留多模态图片，监听器对消息和文本分段的修改不污染调用方', async () => {
        const messages = [{ role: 'user', content: [
            { type: 'text', text: '<if db="inventory.count() > 0">有物品</if>' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA', detail: 'high' } },
        ] }];
        const original = structuredClone(messages);
        const { transport, sent } = setup(async (data) => {
            data.messages[0].content[0].text = '有物品';
        });
        const r = await transport.complete({ config, messages });
        assert.equal(r.ok, true);
        assert.equal(sent[0].messages[0].content[0].text, '有物品');
        assert.deepEqual(sent[0].messages[0].content[1], original[0].content[1]);
        assert.deepEqual(messages, original);
    });

    it('所有消息按原角色、原顺序交给同一个事件，也接受监听器替换消息数组', async () => {
        const messages = [
            { role: 'system', content: 'rules' },
            { role: 'user', content: '<if sql="SELECT 1">资料</if>' },
            { role: 'assistant', content: '收到' },
        ];
        const { transport, sent } = setup(async (data) => {
            assert.deepEqual(data.messages, messages);
            data.messages = data.messages.map((m, i) => i === 1 ? { ...m, content: '资料' } : m);
        });
        assert.equal((await transport.complete({ config, messages })).ok, true);
        assert.deepEqual(sent[0].messages.map((m) => m.role), ['system', 'user', 'assistant']);
        assert.equal(sent[0].messages[1].content, '资料');
    });

    it('无宿主模板事件时，普通提示词仍能发送且不改写未知模板', async () => {
        const { ctx, transport, sent } = setup();
        delete ctx.eventSource;
        const messages = [{ role: 'user', content: '普通正文 <if other="x">自定义内容</if> {{unknown}}' }];
        assert.equal((await transport.complete({ config, messages })).ok, true);
        assert.deepEqual(sent[0].messages, messages);
    });

    for (const type of ['seed', 'cell', 'cond', 'db', 'sql']) {
        it(`shujuku 未处理 ${type} 条件时，阻止包含大分支的请求`, async () => {
            const huge = '不应发送的未选分支'.repeat(60_000);
            const { transport, sent } = setup();
            const r = await transport.complete({
                config, traceId: 'trace-template',
                messages: [{ role: 'user', content: `<if ${type}="x">${huge}<else>实际分支</if>` }],
            });
            assert.equal(r.ok, false);
            assert.equal(r.error.code, 'LLM_ACU_IF_UNRESOLVED');
            assert.equal(r.error.retryable, false);
            assert.equal(r.error.traceId, 'trace-template');
            assert.deepEqual(r.error.context, { count: 1, types: [type] });
            assert.equal(sent.length, 0);
            assert.ok(JSON.stringify(r.error.context).length < 100, '错误日志不含大段提示词');
        });
    }

    it('事件不存在或模板功能关闭时，均不允许残留 if 通过', async () => {
        for (const unavailable of ['eventTypes', 'eventSource']) {
            const { ctx, transport, sent } = setup();
            delete ctx[unavailable];
            const r = await transport.complete({
                config, messages: [{ role: 'user', content: '<if cond="seed:战斗">secret</if>' }],
            });
            assert.equal(r.error.code, 'LLM_ACU_IF_UNRESOLVED');
            assert.equal(sent.length, 0);
        }
    });

    it('检查处理后新产生或仅部分解析的多模态条件块，包括大小写和不完整标签', async () => {
        const { transport, sent } = setup(async (data) => {
            data.messages[0].content[0].text = '已处理';
            data.messages[0].content[1].text = '<IF SQL="SELECT 1">嵌套<if cell="broken"';
        });
        const r = await transport.complete({ config, messages: [{ role: 'user', content: [
            { type: 'text', text: '<if seed="x">first</if>' },
            { type: 'text', text: 'script output' },
        ] }] });
        assert.equal(r.error.code, 'LLM_ACU_IF_UNRESOLVED');
        assert.deepEqual(r.error.context, { count: 2, types: ['sql', 'cell'] });
        assert.equal(sent.length, 0);
    });

    it('监听器失败时返回明确错误，网关不自动重试也不发请求', async () => {
        let events = 0;
        const { transport, sent } = setup(async () => {
            events += 1;
            throw new Error('template failed');
        });
        const gateway = createLlmGateway({
            transports: { 'st-backend': transport }, maxAttempts: 3,
            sleep: async () => assert.fail('模板错误不得重试'),
        });
        const r = await gateway.complete({ config, messages: [{ role: 'user', content: 'test' }] });
        assert.equal(r.error.code, 'LLM_PROMPT_TEMPLATE_FAILED');
        assert.equal(events, 1);
        assert.equal(sent.length, 0);
    });

    it('HTTP 重试重新处理原始消息，不累计上次监听器的改写', async () => {
        const { ctx, transport, sent } = setup(async (data) => {
            data.messages[0].content = `processed:${data.messages[0].content}`;
        });
        let attempts = 0;
        ctx.ChatCompletionService.sendRequest = async (data) => {
            sent.push(structuredClone(data));
            if (attempts++ === 0) throw new Error('HTTP 503');
            return { content: 'ok' };
        };
        const gateway = createLlmGateway({
            transports: { 'st-backend': transport }, sleep: async () => {},
        });
        const messages = [{ role: 'user', content: 'original' }];
        assert.equal((await gateway.complete({ config, messages })).ok, true);
        assert.deepEqual(sent.map((data) => data.messages[0].content), ['processed:original', 'processed:original']);
        assert.equal(messages[0].content, 'original');
    });

    it('模板处理期间取消时，不再发送请求', async () => {
        const controller = new AbortController();
        const { transport, sent } = setup(async () => { controller.abort(); });
        const r = await transport.complete({
            config, messages: [{ role: 'user', content: 'test' }], signal: controller.signal,
        });
        assert.equal(r.ok, false);
        assert.equal(r.error.code, 'UPSTREAM_ABORTED');
        assert.equal(sent.length, 0);
    });

    it('没有处理器时，原条件块不会被静默删除或作为成功结果返回', async () => {
        const r = await prepareChatCompletionPrompt({}, {
            messages: [{ role: 'user', content: '<if seed="x">a<else>b</if>' }],
        });
        assert.equal(r.error.code, 'LLM_ACU_IF_UNRESOLVED');
    });
});
