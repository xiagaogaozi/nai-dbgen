/**
 * 尺寸 / 解析可选字段 + 近期生图记录 + 尺寸覆盖出图。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    slotCaptionFromLlmItem,
    createSlotRecord,
    validateSlotRecord,
} from '../../src/domain/model/slot.js';
import { emptyNaiCaption, defaultNaiParams } from '../../src/domain/model/nai-params.js';
import { parseSizeSpec } from '../../src/domain/model/size-spec.js';
import { formatRecentSlotsBlock } from '../../src/domain/blocks/recent-slots.block.js';
import { mergeNaiParamsForGenerate } from '../../src/domain/nai/param-options.js';
import {
    buildPipeline,
    makeCaption,
} from './_fakes.js';
import { Ok } from '../../src/infra/result.js';

const NOW = '2026-01-01T00:00:00.000Z';

describe('parseSizeSpec', () => {
    it('parses 宽x高', () => {
        const r = parseSizeSpec('1216x832');
        assert.equal(r.ok, true);
        assert.deepEqual(r.value, { width: 1216, height: 832, spec: '1216x832' });
    });

    it('rejects non WxH text', () => {
        const r = parseSizeSpec('landscape');
        assert.equal(r.ok, false);
        assert.equal(r.error.code, 'SIZE_SPEC_FORMAT');
        assert.match(r.error.message, /宽x高/);
    });
});

describe('slot LLM optional 尺寸 / 解析', () => {
    it('parses and stores both; empty string omitted', () => {
        const withBoth = slotCaptionFromLlmItem({
            slotid: 1,
            生图内容: emptyNaiCaption(),
            尺寸: '832x1216',
            解析: ' 竖图角色特写 ',
        });
        assert.equal(withBoth.ok, true);
        assert.equal(withBoth.value.size, '832x1216');
        assert.equal(withBoth.value.analysis, '竖图角色特写');

        const emptyOpt = slotCaptionFromLlmItem({
            slotid: 2,
            生图内容: emptyNaiCaption(),
            尺寸: '  ',
            解析: '',
        });
        assert.equal(emptyOpt.ok, true);
        assert.equal('size' in emptyOpt.value, false);
        assert.equal('analysis' in emptyOpt.value, false);

        const rec = createSlotRecord({
            messageId: 9,
            slotId: 1,
            caption: emptyNaiCaption(),
            size: '832x1216',
            analysis: '竖图角色特写',
        }, { now: NOW });
        assert.equal(rec.size, '832x1216');
        assert.equal(rec.analysis, '竖图角色特写');

        const bare = createSlotRecord({
            messageId: 9,
            slotId: 2,
            caption: emptyNaiCaption(),
            size: '',
            analysis: '   ',
        }, { now: NOW });
        assert.equal('size' in bare, false);
        assert.equal('analysis' in bare, false);

        const validated = validateSlotRecord({
            ...rec,
            schemaVersion: 1,
        });
        assert.equal(validated.ok, true);
        assert.equal(validated.value.size, '832x1216');
        assert.equal(validated.value.analysis, '竖图角色特写');
    });

    it('reads English size / analysis / caption keys from LLM', () => {
        const r = slotCaptionFromLlmItem({
            slotid: 1,
            caption: emptyNaiCaption(),
            size: '832x1216',
            analysis: '英文键生效',
        });
        assert.equal(r.ok, true);
        assert.equal(r.value.size, '832x1216');
        assert.equal(r.value.analysis, '英文键生效');
    });

    it('record create/validate only read size / analysis', () => {
        const fromZh = createSlotRecord({
            messageId: 9,
            slotId: 1,
            caption: emptyNaiCaption(),
            尺寸: '832x1216',
            解析: '中文键不应写入记录',
        }, { now: NOW });
        assert.equal('size' in fromZh, false);
        assert.equal('analysis' in fromZh, false);

        const validated = validateSlotRecord({
            schemaVersion: 1,
            messageId: 9,
            slotId: 1,
            caption: emptyNaiCaption(),
            anchorSentence: '',
            images: [],
            createdAt: NOW,
            presetId: null,
            llmConfigId: null,
            尺寸: '832x1216',
            解析: '中文键不应读出',
        });
        assert.equal(validated.ok, true);
        assert.equal('size' in validated.value, false);
        assert.equal('analysis' in validated.value, false);

        const fromEn = createSlotRecord({
            messageId: 9,
            slotId: 2,
            caption: emptyNaiCaption(),
            size: '1216x832',
            analysis: '记录只用英文键',
        }, { now: NOW });
        assert.equal(fromEn.size, '1216x832');
        assert.equal(fromEn.analysis, '记录只用英文键');
        const roundTrip = validateSlotRecord({ ...fromEn });
        assert.equal(roundTrip.ok, true);
        assert.equal(roundTrip.value.size, '1216x832');
        assert.equal(roundTrip.value.analysis, '记录只用英文键');
    });
});

describe('formatRecentSlotsBlock', () => {
    it('orders by slotid, omits missing lines, blank line between slots', () => {
        const capA = makeCaption('scene A');
        const capB = makeCaption('scene B');
        const text = formatRecentSlotsBlock([
            {
                schemaVersion: 1,
                messageId: 1,
                slotId: 5,
                caption: capB,
                anchorSentence: 'b',
                images: [],
                createdAt: NOW,
                presetId: null,
                llmConfigId: null,
                size: '1024x1024',
            },
            {
                schemaVersion: 1,
                messageId: 1,
                slotId: 3,
                caption: capA,
                anchorSentence: 'a',
                images: [],
                createdAt: NOW,
                presetId: null,
                llmConfigId: null,
                analysis: '上一轮竖图',
                size: '832x1216',
            },
        ]);
        assert.equal(
            text,
            [
                'slotid: 3',
                '解析: 上一轮竖图',
                '尺寸: 832x1216',
                `生图内容: ${JSON.stringify(capA)}`,
                '',
                'slotid: 5',
                '尺寸: 1024x1024',
                `生图内容: ${JSON.stringify(capB)}`,
            ].join('\n'),
        );
        assert.equal(formatRecentSlotsBlock([]), '');
    });
});

describe('size override on render / invalid size skips NAI', () => {
    it('slot size overrides runtime width/height', async () => {
        const p = buildPipeline();
        await p.slotRepo.put(2, [
            createSlotRecord({
                messageId: 2,
                slotId: 1,
                caption: makeCaption('landscape'),
                size: '1216x832',
            }, { now: NOW }),
        ]);
        const r = await p.renderSlot.execute(2, 1);
        assert.equal(r.ok, true);
        assert.equal(p.naiCalls.length, 1);
        assert.equal(p.naiCalls[0].payload.parameters.width, 1216);
        assert.equal(p.naiCalls[0].payload.parameters.height, 832);
    });

    it('invalid size 1000x1000 → Err, NAI not called', async () => {
        const p = buildPipeline();
        await p.slotRepo.put(2, [
            createSlotRecord({
                messageId: 2,
                slotId: 1,
                caption: makeCaption('bad size'),
                size: '1000x1000',
            }, { now: NOW }),
        ]);
        const r = await p.renderSlot.execute(2, 1);
        assert.equal(r.ok, false);
        assert.equal(r.error.code, 'NAI_PARAMS_INVALID');
        assert.match(r.error.message, /1000/);
        assert.equal(p.naiCalls.length, 0);

        const merged = mergeNaiParamsForGenerate(defaultNaiParams(), { width: 1000, height: 1000 });
        assert.equal(merged.ok, false);
        assert.equal(merged.error.code, 'NAI_PARAMS_INVALID');
        assert.match(merged.error.message, /须为 64–4096 且为 64 的倍数/);
    });

    it('malformed size string → Err before NAI', async () => {
        const p = buildPipeline();
        await p.slotRepo.put(2, [
            createSlotRecord({
                messageId: 2,
                slotId: 1,
                caption: makeCaption('bad format'),
                size: 'not-a-size',
            }, { now: NOW }),
        ]);
        const r = await p.renderSlot.execute(2, 1);
        assert.equal(r.ok, false);
        assert.equal(r.error.code, 'SIZE_SPEC_FORMAT');
        assert.equal(p.naiCalls.length, 0);
    });
});

describe('近期生图记录 in generate-slots', () => {
    it('excludes current-round slotids; ordered text in prompt; persists 尺寸/解析', async () => {
        const p = buildPipeline({
            llmComplete: async (req) => {
                if (req.config.id === 'llm-recall') {
                    const positions = [{
                        生成点: 'Alice walked into the garden.',
                        key: ['1'],
                    }];
                    return Ok({ text: JSON.stringify(positions), json: positions });
                }
                return Ok({
                    text: '[]',
                    json: [{
                        slotid: 1,
                        生图内容: makeCaption('new'),
                        尺寸: '1216x832',
                        解析: '本轮横图',
                    }],
                });
            },
        });

        const prevCap = makeCaption('prev scene');
        await p.slotRepo.put(1, [
            createSlotRecord({
                messageId: 1,
                slotId: 3,
                caption: prevCap,
                size: '832x1216',
                analysis: '上一轮竖图',
            }, { now: NOW }),
        ]);
        await p.slotRepo.put(2, [
            createSlotRecord({
                messageId: 2,
                slotId: 1,
                caption: makeCaption('old same id'),
                analysis: '不应出现',
            }, { now: NOW }),
        ]);

        const r = await p.generateSlots.execute(2);
        assert.equal(r.ok, true, r.ok ? '' : r.error?.message);
        assert.equal(p.llmCalls.length, 2);
        const promptMsg = p.llmCalls[1].messages.map((m) => m.content).join('\n');
        assert.match(promptMsg, /Recent=slotid: 3/);
        assert.match(promptMsg, /解析: 上一轮竖图/);
        assert.match(promptMsg, /尺寸: 832x1216/);
        assert.equal(promptMsg.includes('不应出现'), false);

        const stored = await p.slotRepo.get(2, 1);
        assert.equal(stored.ok, true);
        assert.equal(stored.value.size, '1216x832');
        assert.equal(stored.value.analysis, '本轮横图');
    });

    it('omitRecentSlots drops recent records for floor generation and the floor API', async () => {
        const prevCap = makeCaption('prev scene');
        async function seed(p) {
            await p.slotRepo.put(1, [
                createSlotRecord({
                    messageId: 1,
                    slotId: 3,
                    caption: prevCap,
                    analysis: '上一轮竖图',
                }, { now: NOW }),
            ]);
        }

        const off = buildPipeline();
        await seed(off);
        const directOff = await off.generateSlots.execute(2);
        assert.equal(directOff.ok, true, directOff.ok ? '' : directOff.error?.message);
        const offPrompt = off.llmCalls[1].messages.map((m) => m.content).join('\n');
        assert.match(offPrompt, /Recent=slotid: 3/);
        assert.match(offPrompt, /上一轮竖图/);

        const on = buildPipeline({ settingsPatch: { omitRecentSlots: true } });
        await seed(on);
        on.slotRepo.failListRetained = true;
        const directOn = await on.generateSlots.execute(2);
        assert.equal(directOn.ok, true, directOn.ok ? '' : directOn.error?.message);
        const onPrompt = on.llmCalls[1].messages.map((m) => m.content).join('\n');
        assert.equal(onPrompt.includes('上一轮竖图'), false);
        assert.equal(onPrompt.includes('slotid: 3'), false);
        assert.match(onPrompt, /Recent=\s*U=/);

        on.slotRepo.failListRetained = true;
        const api = await on.workbench.writePrompt({
            naturalLanguage: '只要花园',
            mode: 'floor',
            skipRecall: true,
        });
        assert.equal(api.ok, true, api.ok ? '' : api.error?.message);
        const apiPrompt = on.llmCalls.at(-1).messages.map((m) => m.content).join('\n');
        assert.equal(apiPrompt.includes('上一轮竖图'), false);
        assert.match(apiPrompt, /Recent=\s*U=只要花园/);
    });
});

describe('workbench writePrompt fills width/height from 尺寸', () => {
    it('parses wrapped 生图内容 + 尺寸 into result width/height', async () => {
        const p = buildPipeline({
            llmComplete: async () => Ok({
                text: '',
                json: {
                    生图内容: makeCaption('wb'),
                    尺寸: '1216x832',
                    解析: '工作台横图',
                },
            }),
        });
        const r = await p.workbench.writePrompt({
            naturalLanguage: '画一张横图',
            libraryIds: [],
        });
        assert.equal(r.ok, true, r.ok ? '' : r.error?.message);
        assert.equal(r.value.width, 1216);
        assert.equal(r.value.height, 832);
        assert.equal(p.naiCalls.length, 0);
    });
});
