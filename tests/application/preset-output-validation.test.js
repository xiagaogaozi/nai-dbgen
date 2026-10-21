import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateImagegenOutput, validateRecallOutput } from '../../src/application/preset-output-validation.js';
import { parseFlatSlotPlans } from '../../src/domain/model/flat-imagegen.js';
import { makeCaption } from './_fakes.js';

const validLines = ['slotid: 1', 'analysis: 检查完成', 'scene: garden', 'scene_uc:', 'char: 1girl', 'char_uc:'];

describe('required output fields and extra metadata', () => {
    it('isolates unknown metadata between fields while retaining layered analysis', () => {
        const text = [
            '**SLOTID:** 1', 'plan_note: ignore', 'SIZE：1408x640', '说明: ignore',
            'Analysis: 检查完成', 'Foreground: counter', 'Middle ground: person', 'Background: hall',
            'unexpected_metadata: ignore', '这行是附带字段的续行',
            'SCENE: garden', 'extra_scene: ignore', 'scene_uc:',
            'char: 1girl', 'pose_note: ignore', 'char_uc:',
        ].join('\n');
        assert.equal(validateImagegenOutput({ text }).ok, true);
        const [item] = parseFlatSlotPlans(text);
        assert.equal(item.slotid, '1');
        assert.equal(item.size, '1408x640');
        assert.equal(item.caption.v4_prompt.caption.base_caption, 'garden');
        assert.equal(item.caption.v4_prompt.caption.char_captions[0].char_caption, '1girl');
        assert.match(item.analysis, /Foreground: counter/);
        assert.equal(JSON.stringify(item).includes('ignore'), false);
    });

    for (const field of ['slotid', 'analysis', 'scene', 'scene_uc', 'char', 'char_uc']) {
        it(`reports missing ${field} instead of accepting a synthesized empty value`, () => {
            const text = validLines.filter((line) => !line.startsWith(`${field}:`)).join('\n');
            const r = validateImagegenOutput({ text });
            assert.equal(r.ok, false);
            assert.ok(r.error.context.issues.some((issue) => issue.includes(field)));
        });
    }

    it('allows explicitly empty negatives and optional size', () => {
        assert.equal(validateImagegenOutput({ text: validLines.join('\n') }).ok, true);
        assert.equal(validateImagegenOutput({ text: 'slotid: 1\nanalysis: 纯背景\nscene: scenery, no humans\nscene_uc:' }).ok, true);
    });

    it('detects the missing final char_uc in the user-supplied three-slot response', () => {
        const text = readFileSync(new URL('../fixtures/imagegen-slotid-anchor-output.txt', import.meta.url), 'utf8');
        const r = validateImagegenOutput({ text });
        assert.equal(r.ok, false);
        assert.ok(r.error.context.issues.some((issue) => issue.includes('第 3 段') && issue.includes('char_uc')));
        assert.equal(validateImagegenOutput({ text: `${text}\nchar_uc:` }).ok, true);
    });

    it('keeps malformed or missing blocks visible even if other blocks are valid', () => {
        const r = validateImagegenOutput({ text: `${validLines.join('\n')}\n---\nscene: second` });
        assert.equal(r.ok, false);
        assert.match(r.error.context.issues.join('\n'), /第 2 段.*slotid/);
    });

    it('checks complete slot coverage and duplicate ids', () => {
        const one = validLines.join('\n');
        const missing = validateImagegenOutput({ text: one }, { expectedSlotIds: [1, 2] });
        assert.equal(missing.ok, false);
        assert.match(missing.error.context.issues.join('\n'), /缺少召回指定的 slotid：2/);
        const duplicate = validateImagegenOutput({ text: `${one}\n---\n${one}` });
        assert.equal(duplicate.ok, false);
        assert.match(duplicate.error.context.issues.join('\n'), /slotid 重复/);
    });

    it('validates JSON caption fields before defaults conceal missing data', () => {
        const caption = makeCaption('garden');
        assert.equal(validateImagegenOutput({ json: [{ slotid: 1, caption }] }).ok, true);
        assert.equal(validateImagegenOutput({ json: caption }).ok, false, '多图接口不能凭空补 slotid');
        assert.equal(validateImagegenOutput({ json: caption }, { multiple: false }).ok, true);
        delete caption.v4_negative_prompt.caption.base_caption;
        const r = validateImagegenOutput({ json: [{ slotid: 1, caption }] });
        assert.equal(r.ok, false);
        assert.match(r.error.context.issues.join('\n'), /scene_uc/);
    });

    it('single-image responses require the same content fields while omitting slotid', () => {
        const text = validLines.slice(1).join('\n');
        assert.equal(validateImagegenOutput({ text }, { multiple: false }).ok, true);
        assert.equal(validateImagegenOutput({ text: 'scene: garden' }, { multiple: false }).ok, false);
    });
});

describe('recall output validation', () => {
    it('requires key to exist even when empty is a valid choice', () => {
        const targetFloorText = '目标原文。';
        const missing = validateRecallOutput({ json: { positions: [{ anchor: targetFloorText }] } }, { targetFloorText });
        assert.equal(missing.ok, false);
        assert.match(missing.error.context.issues.join('\n'), /positions\[0\].key/);
        assert.equal(validateRecallOutput({ json: { positions: [{ anchor: targetFloorText, key: [] }] } }, { targetFloorText }).ok, true);
    });

    it('does not discard malformed entries when another entry has all required fields', () => {
        const r = validateRecallOutput({ json: { positions: [{ anchor: '目标。', key: [] }, { key: [] }] } }, { targetFloorText: '目标。' });
        assert.equal(r.ok, false);
        assert.match(r.error.context.issues.join('\n'), /positions\[1\].anchor/);
    });
});
