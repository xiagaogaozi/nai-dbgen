import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Ok } from '../../src/infra/result.js';
import { parseSlotIds } from '../../src/domain/slot/slot-token.js';
import { buildPipeline } from './_fakes.js';

const raw = readFileSync(new URL('../fixtures/imagegen-slotid-anchor-output.txt', import.meta.url), 'utf8');
const anchors = ['Alice walked into the garden.', 'The band began rehearsing.', 'They checked the guitar pedals.'];

function pipelineWithSuppliedOutput() {
    const p = buildPipeline({
        llmComplete: async (req) => req.config.id === 'llm-recall'
            ? Ok({ text: '', json: { positions: anchors.map((anchor) => ({ anchor, key: [1] })) } })
            : Ok({ text: `${raw}\nchar_uc:`, json: null }),
    });
    p.host.byId.set(2, { ...p.host.getMessage(2), text: anchors.join('\n') });
    return p;
}

describe('supplied flat imagegen output through application paths', () => {
    it('writes all three slots and keeps recalled anchors authoritative', async () => {
        const p = pipelineWithSuppliedOutput();
        const result = await p.generateSlots.execute(2);
        assert.equal(result.ok, true, result.error?.message);
        assert.deepEqual(result.value.records.map((record) => record.slotId), [1, 2, 3]);
        assert.deepEqual(result.value.records.map((record) => record.anchorSentence), anchors);
        assert.deepEqual(parseSlotIds(p.host.getMessage(2).text), [1, 2, 3]);
        assert.equal(result.value.records[0].size, '1408x640');
        assert.equal(p.llmCalls.length, 2);
        assert.equal(p.naiCalls.length, 0);
    });

    it('returns all three captions through the service used by generateSinglePrompt', async () => {
        const p = pipelineWithSuppliedOutput();
        const result = await p.workbench.writePrompt({
            mode: 'floor', includeWorkbenchOnly: true,
            naturalLanguage: '三个排练镜头', messageId: 2,
        });
        assert.equal(result.ok, true, result.error?.message);
        assert.deepEqual(result.value.captions.map((caption) => caption.slotId), [1, 2, 3]);
        assert.deepEqual(result.value.captions.map((caption) => caption.anchorSentence), anchors);
        assert.equal(result.value.captions[0].width, 1408);
        assert.equal(result.value.captions[0].height, 640);
        assert.equal(p.llmCalls.length, 2);
        assert.equal(p.naiCalls.length, 0);
    });
});
