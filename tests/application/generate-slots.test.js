import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isOk, Ok } from '../../src/infra/result.js';
import { ARTIST_PREVIEW_SIZE } from '../../src/domain/model/nai-params.js';
import { stripSlotTokens } from '../../src/domain/slot/slot-token.js';
import { createContextCollector } from '../../src/application/context-collector.js';
import { createWorldInfoResolver } from '../../src/application/worldinfo-resolver.js';
import { APP_EVENTS } from '../../src/application/_helpers.js';
import {
    buildPipeline,
    createFakeHost,
    baseSettings,
    makeCaption,
    makePreset,
} from './_fakes.js';

describe('context-collector', () => {
    it('strips <IMG> slots from window text', () => {
        const host = createFakeHost({
            aiMessages: [{
                messageId: 1,
                name: 'Bot',
                text: 'Hello <IMG>\n3\n</IMG> world',
                isUser: false,
                isSystem: false,
            }],
        });
        const collector = createContextCollector({
            host,
            loadSettings: () => baseSettings({ contextWindowSize: 5 }),
        });
        const win = collector.collect();
        assert.equal(win.messages.length, 1);
        assert.equal(win.messages[0].text.includes('<IMG>'), false);
        assert.equal(win.text.includes('<IMG>'), false);
        assert.match(win.text, /Hello\s+world/);
    });

    it('uses PluginSettings.contextWindowSize', () => {
        const host = createFakeHost({
            aiMessages: [
                { messageId: 3, name: 'B', text: 'a', isUser: false, isSystem: false },
                { messageId: 2, name: 'B', text: 'b', isUser: false, isSystem: false },
                { messageId: 1, name: 'B', text: 'c', isUser: false, isSystem: false },
            ],
        });
        let nCalls = 0;
        const orig = host.getRecentAiMessages.bind(host);
        host.getRecentAiMessages = (n) => {
            nCalls += 1;
            assert.equal(n, 2);
            return orig(n);
        };
        const collector = createContextCollector({
            host,
            loadSettings: () => baseSettings({ contextWindowSize: 2 }),
        });
        collector.collect();
        assert.equal(nCalls, 1);
    });
});

describe('generateSlots seven-step pipeline', () => {
    it('runs end-to-end with fake ports and writes slot', async () => {
        const p = buildPipeline();
        const r = await p.generateSlots.execute(2);
        assert.equal(isOk(r), true, r.ok ? '' : r.error?.message);
        assert.equal(r.value.traceId, 'trace-fixed');
        assert.equal(r.value.llmCallCount, 2);
        assert.equal(r.value.records.length, 1);
        assert.equal(r.value.records[0].slotId, 1);

        const mes = p.host.getMessage(2);
        assert.ok(mes.text.includes('<IMG>'));
        assert.ok(mes.text.includes('1'));
        assert.equal(mes.text.includes('a garden scene'), false);

        const stored = await p.slotRepo.get(2, 1);
        assert.equal(isOk(stored) && stored.value != null, true);
    });

    it('derives all four blocks from the same contextWindow', async () => {
        const p = buildPipeline();
        const r = await p.generateSlots.execute(2);
        assert.equal(isOk(r), true);

        // 世界书只被要了一次窗口
        assert.equal(p.host.resolveWorldInfoCalls.length, 1);
        const wiWindow = p.host.resolveWorldInfoCalls[0];
        assert.ok(Array.isArray(wiWindow));
        assert.ok(wiWindow.every((m) => !String(m.text).includes('<IMG>')));

        // 召回与提示词 LLM 看到的上下文同源（剥 slot 后）
        assert.equal(p.llmCalls.length, 2);
        const recallMsg = p.llmCalls[0].messages.map((m) => m.content).join('\n');
        const promptMsg = p.llmCalls[1].messages.map((m) => m.content).join('\n');
        assert.ok(recallMsg.includes('Alice walked into the garden.'));
        assert.ok(!recallMsg.includes('<IMG>'));
        assert.ok(promptMsg.includes('Alice walked into the garden.'));
        assert.ok(promptMsg.includes('WORLD_INFO_TEXT'));
        assert.ok(promptMsg.includes('Alice：') || promptMsg.includes('black hair'));
        assert.ok(promptMsg.includes('flower garden'));
        // 未激活组角色不得出现
        assert.equal(promptMsg.includes('should-not-appear'), false);
        // 未激活库不得进入召回候选
        assert.equal(recallMsg.includes('night'), false);
    });

    it('threads one traceId through both LLM calls', async () => {
        const p = buildPipeline();
        const r = await p.generateSlots.execute(2, { traceId: 'my-trace' });
        assert.equal(isOk(r), true);
        assert.equal(r.value.traceId, 'my-trace');
        assert.equal(p.llmCalls.length, 2);
        assert.equal(p.llmCalls[0].traceId, 'my-trace');
        assert.equal(p.llmCalls[1].traceId, 'my-trace');
        assert.equal(p.llmCalls[0].config.id, 'llm-recall');
        assert.equal(p.llmCalls[1].config.id, 'llm-prompt');
    });

    it('degrades when worldinfo fails but continues other blocks', async () => {
        const p = buildPipeline({
            hostOpts: { worldInfoFail: true },
        });

        const r = await p.generateSlots.execute(2);
        assert.equal(isOk(r), true, r.ok ? '' : r.error?.message);
        assert.equal(p.llmCalls.length, 2);
        const promptMsg = p.llmCalls[1].messages.map((m) => m.content).join('\n');
        // 世界书空，但角色/标签/上下文仍在
        assert.ok(promptMsg.includes('Alice walked into the garden.'));
        assert.ok(promptMsg.includes('flower garden') || promptMsg.includes('black hair'));
        assert.equal(promptMsg.includes('WORLD_INFO_TEXT'), false);
    });
});

describe('renderSlot + imageGen', () => {
    it('renders with replaceCharacterKeywords=false always', async () => {
        const p = buildPipeline();
        const gen = await p.generateSlots.execute(2);
        assert.equal(isOk(gen), true);

        const r = await p.renderSlot.execute(2, 1);
        assert.equal(isOk(r), true);
        assert.ok(r.value.traceId);
        // 出图用独立 trace，不强制等于 generate 的
        assert.equal(p.naiCalls.length, 1);
        // 装配后不应做关键字替换：caption 保持模型原文（画师串会前置）
        const input = p.naiCalls[0].payload.input;
        assert.ok(typeof input === 'string');
        assert.ok(r.value.record.images.length >= 1);
    });

    it('replaceCharacterKeywords both modes; never inferred from caption source', async () => {
        const p = buildPipeline();

        // 显式 false
        let r = await p.imageGen.generate({
            caption: makeCaption('Alice in garden'),
            replaceCharacterKeywords: false,
        });
        assert.equal(isOk(r), true);
        const payloadOff = p.naiCalls[p.naiCalls.length - 1].payload;
        assert.ok(String(payloadOff.input).includes('Alice'));

        // 显式 true：关键字换固定特征
        r = await p.imageGen.generate({
            caption: makeCaption('Alice in garden'),
            replaceCharacterKeywords: true,
        });
        assert.equal(isOk(r), true);
        const payloadOn = p.naiCalls[p.naiCalls.length - 1].payload;
        assert.ok(String(payloadOn.input).includes('black hair'));
        assert.equal(String(payloadOn.input).includes('Alice'), false);

        // 缺省布尔 → 抛编程错误（绝不推断）
        await assert.rejects(
            async () => p.imageGen.generate({
                caption: makeCaption('hand-filled Alice'),
                // @ts-expect-error intentional
                replaceCharacterKeywords: undefined,
            }),
            /replaceCharacterKeywords/,
        );
    });

    it('explicit illegal NAI params → Err before NAI; inherited fallback after model switch', async () => {
        const p = buildPipeline();
        p.patchSettings({
            naiParams: {
                ...p.loadSettings().naiParams,
                model: 'nai-diffusion-4-5-full',
                skip_cfg_above_sigma: 58,
                noise_schedule: 'native',
            },
        });

        const bad = await p.imageGen.generate({
            caption: makeCaption('x'),
            replaceCharacterKeywords: false,
            params: { sampler: 'not-a-sampler' },
        });
        assert.equal(bad.ok, false);
        assert.equal(bad.error.code, 'NAI_PARAMS_INVALID');
        assert.equal(p.naiCalls.length, 0);

        const ok = await p.imageGen.generate({
            caption: makeCaption('x'),
            replaceCharacterKeywords: false,
            params: { model: 'nai-diffusion-5-full' },
        });
        assert.equal(ok.ok, true);
        assert.equal(p.naiCalls.length, 1);
        assert.equal(p.naiCalls[0].payload.model, 'nai-diffusion-5-full');
        assert.equal(p.naiCalls[0].payload.parameters.noise_schedule, 'karras');
        assert.equal(p.naiCalls[0].payload.parameters.skip_cfg_above_sigma, null);
    });
});

describe('artist preview', () => {
    it('uses the editing artist string not the global active one; size 832×1216', async () => {
        const p = buildPipeline();
        const r = await p.artistPreview.preview({
            artistId: 'artist-editing',
            promptText: 'preview prompt',
            saveAsPreview: true,
        });
        assert.equal(isOk(r), true, r.ok ? '' : r.error?.message);
        assert.equal(p.naiCalls.length, 1);
        const { payload } = p.naiCalls[0];
        assert.equal(payload.parameters.width, ARTIST_PREVIEW_SIZE.width);
        assert.equal(payload.parameters.height, ARTIST_PREVIEW_SIZE.height);
        assert.equal(ARTIST_PREVIEW_SIZE.width, 832);
        assert.equal(ARTIST_PREVIEW_SIZE.height, 1216);
        // 正在编辑串前置，而非激活串
        assert.ok(String(payload.input).startsWith('EDIT_POS'));
        assert.equal(String(payload.input).includes('ACTIVE_POS'), false);
        // 未改全局激活
        assert.equal(p.loadSettings().activeArtistId, 'artist-active');
        assert.ok(r.value.referenceImageRef);
    });
});

describe('workbench', () => {
    it('writePrompt does not call NAI and does not touch replace switch', async () => {
        const p = buildPipeline({
            llmComplete: async (req) => {
                // 工作台不跑召回，只应打提示词 LLM
                assert.equal(req.config.id, 'llm-prompt');
                return Ok({
                    text: '{}',
                    json: makeCaption('workbench scene'),
                });
            },
        });
        const beforeArtist = p.loadSettings().activeArtistId;
        const r = await p.workbench.writePrompt({
            naturalLanguage: 'Alice in a garden',
            libraryIds: ['lib1', 'lib-feat'],
        });
        assert.equal(isOk(r), true, r.ok ? '' : r.error?.message);
        assert.equal(r.value.caption.v4_prompt.caption.base_caption, 'workbench scene');
        assert.ok(Array.isArray(r.value.unmatchedKeys));
        assert.equal(r.value.unmatchedKeys.length, 0);
        assert.equal(p.naiCalls.length, 0);
        assert.equal(p.llmCalls.length, 1, '工作台写提示词恰好 1 次 LLM（不召回）');
        assert.equal(p.loadSettings().activeArtistId, beforeArtist);
        const promptMsg = p.llmCalls[0].messages.map((m) => m.content).join('\n');
        assert.ok(promptMsg.includes('flower garden') || promptMsg.includes('garden'));
        assert.ok(promptMsg.includes('silver hair feature ref') || promptMsg.includes('Alice'));
        assert.ok(promptMsg.includes('U=Alice in a garden'));
    });

    it('writePrompt rejects a model error body instead of an empty caption', async () => {
        const banned = [
            'finishReason: PROHIBITED_CONTENT',
            'finishMessage: The model output could not be generated. This output contains sensitive words.',
        ].join('\n');
        const p = buildPipeline({
            llmComplete: async () => Ok({ text: banned }),
        });
        const r = await p.workbench.writePrompt({
            naturalLanguage: '画一张',
            libraryIds: ['lib1'],
        });
        assert.equal(r.ok, false);
        assert.equal(r.error.code, 'WORKBENCH_CAPTION_INVALID');
        assert.equal(p.naiCalls.length, 0);
    });

    it('writePrompt entryIds sends only the checked entries', async () => {
        const p = buildPipeline({
            llmComplete: async () => Ok({
                text: '{}',
                json: makeCaption('picked'),
            }),
        });
        const r = await p.workbench.writePrompt({
            naturalLanguage: '只带花园',
            libraryIds: ['lib1', 'lib-feat'],
            entryIds: ['t1'],
        });
        assert.equal(isOk(r), true, r.ok ? '' : r.error?.message);
        const promptMsg = p.llmCalls[0].messages.map((m) => m.content).join('\n');
        assert.ok(promptMsg.includes('flower garden'));
        assert.equal(promptMsg.includes('silver hair feature ref'), false);
    });

    it('floor mode puts the user text in {{用户描述}} for both presets', async () => {
        const recall = makePreset('preset-recall', 'recall', 'ctx={{当前上下文}}\nkeys={{候选 key}}\nuser={{用户描述}}');
        const imagegen = makePreset(
            'preset-imagegen',
            'imagegen',
            'W={{世界书}} C={{当前上下文}} R={{角色库}} T={{构图标签}} F={{特征参考}} K={{常驻标签}} Recent={{近期生图记录}} U={{用户描述}}',
        );
        for (const preset of [recall, imagegen]) {
            preset.prompts.push({
                identifier: 'wb',
                name: 'wb',
                role: 'system',
                content: '工作台专用段',
                enabled: true,
                workbenchOnly: true,
                injection_position: 0,
                injection_depth: 0,
                injection_order: 1,
            });
            preset.prompt_order.push({ identifier: 'wb', enabled: true });
        }
        const p = buildPipeline({
            presets: [recall, imagegen],
            llmComplete: async (req) => {
                const joined = req.messages.map((m) => m.content).join('\n');
                if (joined.includes('keys=')) {
                    return Ok({
                        text: '',
                        json: {
                            positions: [{
                                anchor: 'Alice walked into the garden.',
                                key: [1],
                            }],
                        },
                    });
                }
                return Ok({
                    text: 'slotid: 1\nscene: one garden shot\nscene_uc: bad hands',
                    json: null,
                });
            },
        });
        const r = await p.workbench.writePrompt({
            naturalLanguage: '只要花园这一张',
            mode: 'floor',
        });
        assert.equal(isOk(r), true, r.ok ? '' : r.error?.message);
        assert.equal(p.llmCalls.length, 2);
        assert.equal(p.naiCalls.length, 0);
        const recallJoined = p.llmCalls[0].messages.map((m) => m.content).join('\n');
        assert.ok(recallJoined.includes('user=只要花园这一张'));
        assert.ok(recallJoined.includes('工作台专用段'));
        const imageJoined = p.llmCalls[1].messages.map((m) => m.content).join('\n');
        assert.ok(imageJoined.includes('flower garden'));
        assert.ok(imageJoined.includes('U=只要花园这一张'));
        assert.ok(imageJoined.includes('工作台专用段'));
        assert.equal(r.value.caption.v4_prompt.caption.base_caption, 'one garden shot');
        assert.equal(r.value.captions.length, 1);
        assert.equal(r.value.captions[0].slotId, 1);
    });

    it('floor mode skipRecall does not call recall and still writes the imagegen prompt', async () => {
        const recall = makePreset('preset-recall', 'recall', 'user={{用户描述}}\nkeys={{候选 key}}');
        const imagegen = makePreset(
            'preset-imagegen',
            'imagegen',
            'T={{构图标签}} U={{用户描述}}',
        );
        const p = buildPipeline({
            presets: [recall, imagegen],
            llmComplete: async () => Ok({
                text: 'slotid: 1\nscene: joy\nscene_uc: bad hands\n---\nslotid: 2\nscene: anger\nscene_uc: blur',
                json: null,
            }),
        });
        const r = await p.workbench.writePrompt({
            naturalLanguage: '写表情差分',
            mode: 'floor',
            skipRecall: true,
        });
        assert.equal(isOk(r), true, r.ok ? '' : r.error?.message);
        assert.equal(p.llmCalls.length, 1);
        assert.equal(r.value.llmCallCount, 1);
        const imageJoined = p.llmCalls[0].messages.map((m) => m.content).join('\n');
        assert.equal(imageJoined.includes('keys='), false);
        assert.ok(imageJoined.includes('U=写表情差分'));
        assert.match(imageJoined, /T=\s*U=/);
        assert.equal(r.value.captions.length, 2);
    });

    it('floor mode keeps every caption the model returned', async () => {
        const recall = makePreset('preset-recall', 'recall', 'user={{用户描述}}');
        const imagegen = makePreset('preset-imagegen', 'imagegen', 'T={{构图标签}}');
        const p = buildPipeline({
            presets: [recall, imagegen],
            llmComplete: async (req) => {
                const joined = req.messages.map((m) => m.content).join('\n');
                if (joined.includes('user=')) {
                    return Ok({
                        text: '',
                        json: {
                            positions: [
                                { anchor: 'Alice walked into the garden.', key: [1] },
                            ],
                        },
                    });
                }
                return Ok({
                    text: 'slotid: 1\nscene: first shot\nscene_uc: bad hands\n---\nslotid: 2\nscene: second shot\nscene_uc: blur',
                    json: null,
                });
            },
        });
        const r = await p.workbench.writePrompt({
            naturalLanguage: '两个镜头',
            mode: 'floor',
        });
        assert.equal(isOk(r), true, r.ok ? '' : r.error?.message);
        const imageJoined = p.llmCalls[1].messages.map((m) => m.content).join('\n');
        assert.ok(imageJoined.includes('slotid: 1'));
        assert.equal(r.value.captions.length, 2);
        assert.equal(r.value.caption.v4_prompt.caption.base_caption, 'first shot');
        assert.deepEqual(r.value.captions.map((item) => item.caption.v4_prompt.caption.base_caption), ['first shot', 'second shot']);
        assert.deepEqual(r.value.captions.map((item) => item.slotId), [1, 2]);
        assert.equal(r.value.captions[0].anchorSentence, 'Alice walked into the garden.');
        assert.equal(r.value.captions[1].anchorSentence, undefined);
    });

    it('workbench artist override keeps positive and negative strings separate', async () => {
        const p = buildPipeline();
        const result = await p.workbench.generateImage({
            caption: makeCaption('garden'),
            replaceCharacterKeywords: false,
            artist: {
                id: 'artist-session', name: 'Session', sequence: 1,
                positivePrompt: 'artist-session-positive',
                negativePrompt: 'artist-session-negative',
            },
        });
        assert.equal(isOk(result), true, result.ok ? '' : result.error?.message);
        const payload = p.naiCalls.at(-1).payload;
        assert.ok(JSON.stringify(payload).includes('artist-session-positive'));
        assert.ok(JSON.stringify(payload).includes('artist-session-negative'));
    });

    it('generateImage passes explicit replaceCharacterKeywords through', async () => {
        const p = buildPipeline();
        const rFalse = await p.workbench.generateImage({
            caption: makeCaption('Alice'),
            replaceCharacterKeywords: false,
        });
        assert.equal(isOk(rFalse), true);
        const rTrue = await p.workbench.generateImage({
            caption: makeCaption('Alice'),
            replaceCharacterKeywords: true,
        });
        assert.equal(isOk(rTrue), true);
        await assert.rejects(
            async () => p.workbench.generateImage({
                caption: makeCaption('x'),
                // @ts-expect-error
                replaceCharacterKeywords: undefined,
            }),
            /replaceCharacterKeywords/,
        );
    });
});

describe('D31 unmatchedKeys observability', () => {
    it('propagates unmatched from tagRecall to generateSlots result and events', async () => {
        const p = buildPipeline({
            llmComplete: async (req) => {
                if (req.config.id === 'llm-recall') {
                    // garden 命中；fabricated / Night 未命中（大小写也不行）
                    const positions = [{
                        生成点: 'Alice walked into the garden.',
                        key: ['1', 'fabricated', 'Night'],
                    }];
                    return Ok({ text: JSON.stringify(positions), json: positions });
                }
                return Ok({
                    text: '[]',
                    json: [{
                        slotid: 1,
                        生图内容: makeCaption('a garden scene'),
                    }],
                });
            },
        });

        /** @type {any[]} */
        const unmatchedEvents = [];
        /** @type {any[]} */
        const writtenEvents = [];
        p.bus.on('tag-recall:unmatched', (payload) => unmatchedEvents.push(payload));
        p.bus.on('slots:written', (payload) => writtenEvents.push(payload));

        const r = await p.generateSlots.execute(2);
        assert.equal(isOk(r), true, r.ok ? '' : r.error?.message);
        assert.deepEqual(r.value.unmatchedKeys, ['fabricated', 'Night']);

        assert.equal(unmatchedEvents.length, 1);
        assert.deepEqual(unmatchedEvents[0].unmatchedKeys, ['fabricated', 'Night']);
        assert.equal(unmatchedEvents[0].traceId, 'trace-fixed');

        assert.equal(writtenEvents.length, 1);
        assert.deepEqual(writtenEvents[0].unmatchedKeys, ['fabricated', 'Night']);

        // 注入块仍只用 matched：提示词应含 garden value，不含 fabricated
        const promptMsg = p.llmCalls[1].messages.map((m) => m.content).join('\n');
        assert.ok(promptMsg.includes('flower garden'));
        assert.equal(promptMsg.includes('fabricated'), false);
    });
});

describe('auto-trigger idempotency', () => {
    it('D32: autoRender only + manual generate uses slots:written event (no execute wrap)', async () => {
        const p = buildPipeline();
        p.patchSettings({ autoWriteSlots: false, autoRenderSlots: true });
        p.autoTrigger.start();

        const rendered = new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('timeout')), 2000);
            p.bus.on(APP_EVENTS.SLOT_RENDERED, (payload) => {
                clearTimeout(t);
                resolve(payload);
            });
        });
        const executeRef = p.generateSlots.execute;
        const r = await executeRef(2);
        assert.equal(isOk(r), true);
        await rendered;
        assert.ok(p.naiCalls.length >= 1, 'auto-render via bus after manual generate');
        const rec = await p.slotRepo.get(2, 1);
        assert.ok(rec.ok && latestHasImage(rec.value));
    });

    it('D32: already-rendered slots skip; duplicate slots:written does not re-bill', async () => {
        const p = buildPipeline();
        p.patchSettings({ autoWriteSlots: false, autoRenderSlots: true });
        p.autoTrigger.start();

        const rendered = new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('timeout')), 2000);
            p.bus.on(APP_EVENTS.SLOT_RENDERED, (payload) => {
                clearTimeout(t);
                resolve(payload);
            });
        });
        const gen = await p.generateSlots.execute(2);
        assert.equal(isOk(gen), true);
        await rendered;
        const naiAfterFirst = p.naiCalls.length;
        assert.ok(naiAfterFirst >= 1);

        const slotBefore = await p.slotRepo.get(2, 1);
        assert.ok(slotBefore.ok && latestHasImage(slotBefore.value));

        p.bus.emit(APP_EVENTS.SLOTS_WRITTEN, {
            messageId: 2,
            records: [slotBefore.value],
            traceId: 'dup',
            unmatchedKeys: [],
        });
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(p.naiCalls.length, naiAfterFirst, 'duplicate slots:written must not re-bill');

        p.host.emitSettled(2);
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(p.naiCalls.length, naiAfterFirst, 'settled must not re-bill rendered slots');
    });

    it('autoWriteSlots only writes; both on writes then renders via event', async () => {
        const p = buildPipeline();
        p.patchSettings({ autoWriteSlots: true, autoRenderSlots: false });
        p.autoTrigger.start();
        const written = new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('timeout')), 2000);
            p.bus.on(APP_EVENTS.SLOTS_WRITTEN, (payload) => {
                clearTimeout(t);
                resolve(payload);
            });
        });
        p.host.emitSettled(2);
        await written;
        const slots = await p.slotRepo.getByMessage(2);
        assert.equal(isOk(slots) && slots.value.length >= 1, true);
        assert.equal(p.naiCalls.length, 0);

        const p2 = buildPipeline();
        p2.patchSettings({ autoWriteSlots: true, autoRenderSlots: true });
        p2.autoTrigger.start();
        const rendered2 = new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('timeout')), 2000);
            p2.bus.on(APP_EVENTS.SLOT_RENDERED, (payload) => {
                clearTimeout(t);
                resolve(payload);
            });
        });
        p2.host.emitSettled(2);
        await rendered2;
        assert.ok(p2.naiCalls.length >= 1);
        const rec = await p2.slotRepo.get(2, 1);
        assert.ok(rec.ok && latestHasImage(rec.value));
    });
});

describe('worldinfo-resolver', () => {
    it('forwards the exact contextWindow to host', async () => {
        const host = createFakeHost();
        const resolver = createWorldInfoResolver({ host });
        const window = [
            { messageId: 1, name: 'B', text: 'stripped', isUser: false, isSystem: false },
        ];
        const r = await resolver.resolve({ contextWindow: window, messageId: 9 });
        assert.equal(isOk(r), true);
        assert.equal(host.resolveWorldInfoCalls.length, 1);
        assert.strictEqual(host.resolveWorldInfoCalls[0], window);
        assert.equal(r.value.source, 'host');
    });
});

describe('slot strip helper sanity', () => {
    it('stripSlotTokens removes markers', () => {
        assert.equal(stripSlotTokens('a<IMG>\n2\n</IMG>b'), 'ab');
    });
});

/**
 * @param {any} record
 */
function latestHasImage(record) {
    return Array.isArray(record?.images) && record.images.length > 0;
}
