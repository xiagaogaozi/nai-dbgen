import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    appendPromptCall,
    selectRecentPromptGroups,
} from '../../src/domain/blocks/recent-prompt-calls.js';
import { formatPromptReferenceGroups } from '../../src/domain/blocks/recent-slots.block.js';

const caption = (text) => ({ v4_prompt: { caption: { base_caption: text } } });

describe('recent prompt calls', () => {
    it('keeps only the latest three calls', () => {
        let calls = [];
        for (const name of ['一', '二', '三', '四']) {
            calls = appendPromptCall(calls, {
                at: `2026-10-0${name === '一' ? 1 : name === '二' ? 2 : name === '三' ? 3 : 4}T00:00:00.000Z`,
                items: [{ slotId: 1, caption: caption(name) }],
            });
        }
        assert.deepEqual(calls.map((call) => call.items[0].caption.v4_prompt.caption.base_caption), ['二', '三', '四']);
    });

    it('uses the latest three calls in this chat, slots and external writes together', () => {
        const groups = selectRecentPromptGroups([
            {
                messageId: 1,
                slotId: 2,
                createdAt: '2026-10-01T00:00:00.000Z',
                traceId: 'floor-a',
                caption: caption('旧楼'),
            },
            {
                messageId: 1,
                slotId: 1,
                createdAt: '2026-10-01T00:00:00.000Z',
                traceId: 'floor-a',
                caption: caption('旧楼甲'),
            },
            {
                messageId: 2,
                slotId: 3,
                createdAt: '2026-10-03T00:00:00.000Z',
                traceId: 'floor-b',
                caption: caption('新楼'),
            },
        ], [
            {
                at: '2026-10-02T00:00:00.000Z',
                items: [{ slotId: 1, caption: caption('外部') }],
            },
            {
                at: '2026-10-04T00:00:00.000Z',
                items: [
                    { slotId: 1, caption: caption('外部甲'), analysis: '近景' },
                    { slotId: 2, caption: caption('外部乙') },
                ],
            },
        ]);
        const text = formatPromptReferenceGroups(groups);
        assert.equal(text.includes('旧楼'), false);
        assert.match(text, /外部甲/);
        assert.match(text, /解析: 近景/);
        assert.ok(text.indexOf('外部') < text.indexOf('新楼'));
        assert.ok(text.indexOf('新楼') < text.indexOf('外部甲'));
        assert.ok(text.indexOf('旧楼甲') === -1);
        assert.ok(text.indexOf('slotid: 1') < text.indexOf('slotid: 2'));
    });
});
