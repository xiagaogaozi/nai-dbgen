import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildPipeline, makeCaption, makePreset } from './_fakes.js';
import { Ok } from '../../src/infra/result.js';

const valid = ['slotid: 1', 'analysis: 完整分析', 'scene: garden', 'scene_uc: blur', 'char: 1girl', 'char_uc: hat'].join('\n');
const recallPreset = (retryCount) => ({ ...makePreset('preset-recall', 'recall', 'C={{当前上下文}} keys={{候选 key}}'), retryCount });
const imagePreset = (retryCount) => ({ ...makePreset('preset-imagegen', 'imagegen', 'T={{构图标签}} U={{用户描述}}'), retryCount });
const recalled = { positions: [{ anchor: 'Alice walked into the garden.', key: [1] }] };

describe('independent preset retries through generation services', () => {
    it('corrects recall once and imagegen twice using separate limits and accurate call counts', async () => {
        let recalls = 0;
        let images = 0;
        const p = buildPipeline({
            presets: [recallPreset(1), imagePreset(2)],
            llmComplete: async (req) => {
                if (req.config.id === 'llm-recall') {
                    recalls++;
                    return Ok({ json: recalls === 1 ? { positions: [{ anchor: 'Alice walked into the garden.' }] } : recalled, text: '' });
                }
                images++;
                return Ok({ text: images < 3 ? valid.replace('scene: garden\n', '') : valid, json: null });
            },
        });
        const r = await p.generateSlots.execute(2);
        assert.equal(r.ok, true, r.error?.message);
        assert.equal(recalls, 2);
        assert.equal(images, 3);
        assert.equal(r.value.llmCallCount, 5);
        assert.equal(p.llmCalls.length, 5);
        assert.match(p.llmCalls[1].messages.at(-1).content, /positions\[0\].key/);
        assert.match(p.llmCalls[3].messages.at(-1).content, /缺少必填字段 scene/);
        assert.equal(r.value.records.length, 1);
        assert.equal(p.naiCalls.length, 0);
    });

    it('retryCount zero stops recall before imagegen and does not write slots', async () => {
        const p = buildPipeline({
            presets: [recallPreset(0), imagePreset(8)],
            llmComplete: async () => Ok({ text: '', json: { positions: [{ key: [] }] } }),
        });
        const r = await p.generateSlots.execute(2);
        assert.equal(r.ok, false);
        assert.match(r.error.context.issues.join('\n'), /anchor/);
        assert.equal(p.llmCalls.length, 1);
        assert.equal(p.host.getMessage(2).text.includes('<IMG>'), false);
        assert.equal(p.naiCalls.length, 0);
    });

    it('exhausted imagegen retries never write a partially valid batch', async () => {
        const p = buildPipeline({
            presets: [recallPreset(0), imagePreset(2)],
            llmComplete: async (req) => req.config.id === 'llm-recall'
                ? Ok({ text: '', json: recalled }) : Ok({ text: 'slotid: 1\nscene: garden', json: null }),
        });
        const r = await p.generateSlots.execute(2);
        assert.equal(r.ok, false);
        assert.equal(p.llmCalls.length, 4);
        assert.equal(r.error.context.llmCallCount, 3);
        assert.equal(p.host.getMessage(2).text.includes('<IMG>'), false);
        assert.equal(p.naiCalls.length, 0);
    });

    it('the service behind generateSinglePrompt corrects the supplied missing final char_uc', async () => {
        const raw = readFileSync(new URL('../fixtures/imagegen-slotid-anchor-output.txt', import.meta.url), 'utf8');
        let calls = 0;
        const p = buildPipeline({
            presets: [recallPreset(0), imagePreset(1)],
            llmComplete: async () => Ok({ text: ++calls === 1 ? raw : `${raw}\nchar_uc: hat`, json: null }),
        });
        const r = await p.workbench.writePrompt({
            mode: 'floor', naturalLanguage: '三个镜头', messageId: 2, skipRecall: true,
        });
        assert.equal(r.ok, true, r.error?.message);
        assert.deepEqual(r.value.captions.map((entry) => entry.slotId), [1, 2, 3]);
        assert.equal(r.value.llmCallCount, 2);
        assert.match(p.llmCalls[1].messages.at(-1).content, /第 3 段.*char_uc/);
        assert.equal(p.naiCalls.length, 0);
    });

    it('workbench mode also respects its imagegen preset and supports JSON captions', async () => {
        let calls = 0;
        const p = buildPipeline({
            presets: [recallPreset(0), imagePreset(1)],
            llmComplete: async () => Ok({ text: '', json: ++calls === 1 ? {} : makeCaption('garden') }),
        });
        const r = await p.workbench.writePrompt({ mode: 'workbench', naturalLanguage: '花园' });
        assert.equal(r.ok, true, r.error?.message);
        assert.equal(p.llmCalls.length, 2);
        assert.match(p.llmCalls[1].messages.at(-1).content, /scene/);
    });
});
