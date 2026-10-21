import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseFlatSlotPlans, parseFlatSingleCaption } from '../../src/domain/model/flat-imagegen.js';
import { slotCaptionFromLlmItem } from '../../src/domain/model/slot.js';

const livehouseOutput = readFileSync(new URL('../fixtures/imagegen-slotid-anchor-output.txt', import.meta.url), 'utf8');

describe('flat imagegen fields', () => {
    it('parses the supplied three-slot output without appending 生成点 to slotid', () => {
        const items = parseFlatSlotPlans(livehouseOutput);
        assert.deepEqual(items.map((item) => item.slotid), ['1', '2', '3']);
        const parsed = items.map(slotCaptionFromLlmItem);
        for (const item of parsed) assert.equal(item.ok, true, item.error?.message);
        assert.deepEqual(parsed.map((item) => item.value.slotId), [1, 2, 3]);
        assert.equal(items[0].size, '1408x640');
        for (const item of parsed) {
            const chars = item.value.caption.v4_prompt.caption.char_captions;
            assert.equal(chars.length, 2);
            assert.deepEqual(chars.map((char) => char.centers[0]), [{ x: 0.35, y: 0.5 }, { x: 0.75, y: 0.5 }]);
            assert.match(item.value.analysis, /Foreground:/);
            assert.match(item.value.analysis, /⑥自检/);
            assert.equal('anchorSentence' in item.value, false);
        }
        // 原文末尾未写完的标签保持原样；本修复不补写提示词。
        assert.ok(parsed[2].value.caption.v4_prompt.caption.char_captions[1].char_caption.endsWith('1::dark long-sleeved jack'));
    });

    for (const name of ['生成点', 'anchorSentence', 'anchor']) {
        it(`treats ${name} as ignored metadata after any field, including its continuation`, () => {
            const source = [
                'slotid: 2', `${name}: 错误锚点`, '锚点续行',
                'size: 1408x640', `${name}：错误锚点`,
                'analysis: 正常分析', `${name}: 错误锚点`,
                'scene: livehouse', `${name}: 错误锚点`,
                'scene_uc: blur', `${name}: 错误锚点`,
                'char: 0.35,0.5 | 1girl', `${name}: 错误锚点`,
                'char_uc: hat', `${name}: 错误锚点`, '末尾锚点续行',
            ].join('\n');
            const item = parseFlatSlotPlans(source)[0];
            assert.equal(item.slotid, '2');
            assert.equal(item.size, '1408x640');
            assert.equal(item.analysis, '正常分析');
            assert.equal(JSON.stringify(item).includes('错误锚点'), false);
            assert.equal(JSON.stringify(item).includes('锚点续行'), false);
            const caption = parseFlatSingleCaption(source).caption;
            assert.equal(caption.v4_prompt.caption.base_caption, 'livehouse');
            assert.equal(caption.v4_prompt.caption.char_captions[0].char_caption, '1girl');
            assert.equal(caption.v4_negative_prompt.caption.char_captions[0].char_caption, 'hat');
        });
    }

    it('keeps slotid and size on one line while retaining supported multiline text', () => {
        const [item] = parseFlatSlotPlans([
            'slotid: 2', '额外说明：不能拼进编号',
            'size: 1408x640', '尺寸备注：不能拼进尺寸',
            'analysis: ①分析', 'Foreground: counter',
            'scene: livehouse', 'warm light',
            'scene_uc: blur', 'bad hands',
            'char: 1girl', 'blue eyes',
            'char_uc: hat', 'glasses',
        ].join('\n'));
        assert.equal(item.slotid, '2');
        assert.equal(item.size, '1408x640');
        assert.equal(item.analysis, '①分析\nForeground: counter');
        assert.equal(item.caption.v4_prompt.caption.base_caption, 'livehouse\nwarm light');
        assert.equal(item.caption.v4_negative_prompt.caption.base_caption, 'blur\nbad hands');
        assert.equal(item.caption.v4_prompt.caption.char_captions[0].char_caption, '1girl\nblue eyes');
        assert.equal(item.caption.v4_negative_prompt.caption.char_captions[0].char_caption, 'hat\nglasses');
    });

    it('still rejects invalid inline ids instead of extracting their numeric prefix', () => {
        for (const id of ['0', '-1', '1.5', '2abc', '2 3', 'NaN', '10000']) {
            const [item] = parseFlatSlotPlans(`slotid: ${id}\n生成点: metadata\nscene: livehouse`);
            assert.equal(item.slotid, id);
            const parsed = slotCaptionFromLlmItem(item);
            assert.equal(parsed.ok, false, id);
            assert.equal(parsed.error.code, 'SLOT_PLAN_ID');
        }
    });

    it('builds a caption tree from flat lines', () => {
        const text = [
            'slotid: 2',
            'size: 832x1216',
            'analysis: ①选抓腰后入',
            '第二行仍算解析',
            'scene: sex from behind, on bed',
            'scene_uc: censored',
            'char: 0.4,0.6 | 1girl, looking back',
            'char_uc: open eyes',
            'char: 1boy, hands on hips',
            '---',
            'slotid: 3',
            'scene: hotel room',
        ].join('\n');
        const items = parseFlatSlotPlans(text);
        assert.equal(items.length, 2);
        const parsed = slotCaptionFromLlmItem(items[0]);
        assert.equal(parsed.ok, true);
        assert.equal(parsed.value.slotId, 2);
        assert.equal(parsed.value.size, '832x1216');
        assert.match(parsed.value.analysis, /第二行/);
        const pos = parsed.value.caption.v4_prompt.caption;
        assert.equal(pos.base_caption, 'sex from behind, on bed');
        assert.equal(pos.char_captions[0].centers[0].x, 0.4);
        assert.equal(pos.char_captions[1].centers[0].x, 0.5);
        assert.equal(parsed.value.caption.v4_negative_prompt.caption.char_captions[0].char_caption, 'open eyes');
    });

    it('ignores compact JSON so the old path still applies', () => {
        assert.equal(parseFlatSlotPlans('{"slots":[{"slotid":2}]}').length, 0);
    });

    it('parses a single image without slotid', () => {
        const one = parseFlatSingleCaption('scene: park\nchar: 1girl\nchar_uc: nude');
        assert.equal(one.caption.v4_prompt.caption.base_caption, 'park');
        assert.equal(one.caption.v4_negative_prompt.caption.char_captions[0].char_caption, 'nude');
    });
});
