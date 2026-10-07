import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planArtistModelTagBatch } from '../../src/domain/model/artist.js';

describe('planArtistModelTagBatch', () => {
    it('switches selected artist strings to the target version', () => {
        const plan = planArtistModelTagBatch([
            { id: 'a', name: '甲', modelTag: 'v5' },
            { id: 'b', name: '乙', modelTag: 'v5' },
        ], ['a'], 'v4.5');
        assert.equal(plan.tag, 'v4.5');
        assert.deepEqual(plan.updateIds, ['a']);
        assert.deepEqual(plan.skippedNames, []);
    });

    it('skips a name that already exists on the target version', () => {
        const plan = planArtistModelTagBatch([
            { id: 'a', name: '同名', modelTag: 'v4.5' },
            { id: 'b', name: '同名', modelTag: 'v5' },
        ], ['a'], 'v5');
        assert.deepEqual(plan.updateIds, []);
        assert.deepEqual(plan.skippedNames, ['同名']);
    });

    it('keeps the earlier row when two selected strings share a name', () => {
        const plan = planArtistModelTagBatch([
            { id: 'a', name: '同名', modelTag: 'v5' },
            { id: 'b', name: '同名', modelTag: 'v5' },
        ], ['b', 'a'], 'v4.5');
        assert.deepEqual(plan.updateIds, ['a']);
        assert.deepEqual(plan.skippedNames, ['同名']);
    });

    it('does not write a string that is already the target version', () => {
        const plan = planArtistModelTagBatch([
            { id: 'old', name: '旧串' },
            { id: 'a', name: '甲', modelTag: 'v4.5' },
        ], ['old', 'a'], 'v5');
        assert.deepEqual(plan.updateIds, ['a']);
        assert.deepEqual(plan.skippedNames, []);
    });

    it('treats an unknown target as a no-op', () => {
        const plan = planArtistModelTagBatch([
            { id: 'a', name: '甲', modelTag: 'v5' },
        ], ['a'], 'v3');
        assert.deepEqual(plan.updateIds, []);
        assert.deepEqual(plan.skippedNames, []);
    });
});
