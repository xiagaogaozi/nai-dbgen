import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPreset, validatePreset, importFromSillyTavernPreset } from '../../src/domain/model/preset.js';
import { createPresetRepo } from '../../src/adapters/storage/repos/preset.repo.js';
import { createMemoryIdb } from '../../src/adapters/storage/memory-idb.js';

const deps = { id: 'preset-test', now: '2026-10-21T00:00:00.000Z' };
const input = { name: '预设', kind: 'imagegen', prompts: [] };

describe('per-preset correction retry count', () => {
    it('defaults old and new presets to three retries while retaining zero', () => {
        const preset = createPreset(input, deps);
        assert.equal(preset.retryCount, 3);
        delete preset.retryCount;
        assert.equal(validatePreset(preset).value.retryCount, 3);
        assert.equal(validatePreset({ ...preset, retryCount: 0 }).value.retryCount, 0);
    });

    it('rejects invalid retry counts instead of silently changing them', () => {
        for (const retryCount of [-1, 1.5, '3', NaN, Infinity]) {
            const r = validatePreset({ ...createPreset(input, deps), retryCount });
            assert.equal(r.ok, false);
            assert.equal(r.error.code, 'PRESET_RETRY_COUNT');
        }
    });

    it('keeps imported counts when parsing a SillyTavern preset', () => {
        const r = importFromSillyTavernPreset({ name: '导入', prompts: [], retryCount: 7 }, { kind: 'recall' }, deps);
        assert.equal(r.ok, true);
        assert.equal(r.value.retryCount, 7);
    });

    it('preserves independent counts through repository save, export and import', async () => {
        const repo = createPresetRepo({ db: createMemoryIdb() });
        for (const [kind, retryCount] of [['imagegen', 0], ['recall', 5], ['single-imagegen', 2], ['single-recall', 4]]) {
            const preset = createPreset({ ...input, kind, retryCount }, { ...deps, id: kind });
            assert.equal((await repo.put(preset)).ok, true);
        }
        const envelope = await repo.exportJson();
        assert.equal(envelope.ok, true);
        const importedRepo = createPresetRepo({ db: createMemoryIdb() });
        const imported = await importedRepo.importJson(JSON.parse(JSON.stringify(envelope.value)));
        assert.equal(imported.ok, true);
        assert.equal(imported.value.imported, 4);
        assert.equal((await importedRepo.get('imagegen')).value.retryCount, 0);
        assert.equal((await importedRepo.get('recall')).value.retryCount, 5);
        assert.equal((await importedRepo.get('single-imagegen')).value.retryCount, 2);
    });
});
