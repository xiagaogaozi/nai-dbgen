/**
 * 画师串导入导出（五字段裸数组 + presets 格式、按 name 判重、示例图在本机固定路径）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createMemoryIdb } from '../../src/adapters/storage/memory-idb.js';
import { createMemoryServerFiles } from '../../src/adapters/storage/memory-server-files.js';
import { createArtistRepo } from '../../src/adapters/storage/repos/artist.repo.js';
import { createImageRepo } from '../../src/adapters/storage/image.repo.js';
import { IDB_STORES } from '../../src/adapters/storage/idb.js';
import {
    createArtist,
    nextArtistSequence,
    sortArtistsBySequence,
    validateArtist,
} from '../../src/domain/model/artist.js';
import {
    ARTIST_EXPORT_FIELD_ORDER,
    buildArtistExportRow,
    convertPresetsArtistImport,
    normalizeArtistImportPayload,
} from '../../src/adapters/storage/artist-io.js';
import {
    artistCardFileName,
    artistLocalImageId,
    artistPreviewDisplayUrl,
    artistPreviewFileName,
    removeArtistPreviewFiles,
} from '../../src/adapters/storage/artist-preview-files.js';
import { createServerFiles, SERVER_FILE_PREFIX } from '../../src/adapters/storage/server-files.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(
    readFileSync(join(__dirname, '../fixtures/artists-import-sample.json'), 'utf8'),
);
const PRESETS_SAMPLE = JSON.parse(
    readFileSync(join(__dirname, '../fixtures/artists-presets-sample.json'), 'utf8'),
);
const PRESETS_EXTRA = JSON.parse(
    readFileSync(join(__dirname, '../fixtures/artists-presets-extra.json'), 'utf8'),
);

const TINY_PNG = FIXTURE[0].referenceImage;
const TINY_CARD = new Blob([Uint8Array.from([1, 2, 3])], { type: 'image/webp' });

/**
 * @param {object} [opts]
 */
function makeRepo(opts = {}) {
    const serverFiles = opts.serverFiles || createMemoryServerFiles();
    const db = opts.db || createMemoryIdb({ [IDB_STORES.ARTISTS]: opts.seed || [] });
    const imageDb = opts.imageDb || createMemoryIdb();
    const imageRepo = opts.imageRepo || createImageRepo({ db: imageDb });
    let seq = 0;
    const repo = createArtistRepo({
        db,
        imageRepo,
        nowIso: () => '2026-01-01T00:00:00.000Z',
        newId: () => `ar-test-${seq++}`,
        makeCardImage: opts.makeCardImage || (async () => TINY_CARD),
    });
    return { repo, serverFiles, db, imageRepo, imageDb };
}

describe('artist model', () => {
    it('createArtist / validate / next sequence / sort', () => {
        const a = createArtist({
            name: 'x',
            positivePrompt: 'p',
            negativePrompt: 'n',
            sequence: 3,
        }, { id: 'ar1', now: 't0' });
        assert.equal(a.positivePrompt, 'p');
        assert.equal(a.referenceImageRef, null);
        assert.equal(a.cardImageRef, null);
        assert.equal(validateArtist(a).ok, true);
        assert.equal(validateArtist({ ...a, name: '' }).ok, false);
        assert.equal(nextArtistSequence([a, { sequence: 7 }]), 8);
        assert.equal(nextArtistSequence([]), 0);
        const sorted = sortArtistsBySequence([
            { ...a, sequence: 5, name: 'b' },
            { ...a, id: '2', sequence: 1, name: 'a' },
        ]);
        assert.deepEqual(sorted.map((x) => x.sequence), [1, 5]);
    });

    it('export row field order is fixed five keys', () => {
        const row = buildArtistExportRow({
            name: 'n',
            sequence: 1,
            positivePrompt: 'p',
            negativePrompt: 'q',
            referenceImage: null,
        });
        assert.deepEqual(Object.keys(row), [...ARTIST_EXPORT_FIELD_ORDER]);
        assert.equal('thumbnail' in row, false);
    });
});

describe('artist import/export', () => {
    it('round-trip five fields; strips thumbnail and extra keys', async () => {
        const { repo } = makeRepo();
        const imp = await repo.importJson(FIXTURE, { strategy: 'skip' });
        assert.equal(imp.ok, true);
        assert.equal(imp.value.imported, 3);
        assert.equal(imp.value.errors.length, 0);

        const exp = await repo.exportJson();
        assert.equal(exp.ok, true);
        assert.equal(exp.value.length, 3);
        assert.deepEqual(exp.value.map((r) => r.sequence), [5, 10, 20]);
        assert.deepEqual(exp.value.map((r) => r.name), [
            'fixture-gamma-null-image',
            'fixture-alpha',
            'fixture-beta',
        ]);

        for (const row of exp.value) {
            assert.deepEqual(Object.keys(row), [...ARTIST_EXPORT_FIELD_ORDER]);
            assert.equal('thumbnail' in row, false);
            assert.equal('extraJunk' in row, false);
            assert.equal('legacyField' in row, false);
        }

        const byName = Object.fromEntries(exp.value.map((r) => [r.name, r]));
        const srcAlpha = FIXTURE.find((r) => r.name === 'fixture-alpha');
        assert.equal(byName['fixture-alpha'].positivePrompt, srcAlpha.positivePrompt);
        assert.equal(byName['fixture-alpha'].negativePrompt, srcAlpha.negativePrompt);
        assert.equal(byName['fixture-alpha'].referenceImage, srcAlpha.referenceImage);
        assert.equal(byName['fixture-gamma-null-image'].referenceImage, null);

        const list = await repo.list();
        const alpha = list.value.find((a) => a.name === 'fixture-alpha');
        assert.equal(alpha.cardImageRef, artistLocalImageId('fixture-alpha', 'card'));
    });

    it('duplicate by name: skip / overwrite / rename', async () => {
        const { repo } = makeRepo();
        await repo.importJson([FIXTURE[0]], { strategy: 'skip' });

        const skip = await repo.importJson([{
            ...FIXTURE[0],
            positivePrompt: 'CHANGED',
        }], { strategy: 'skip' });
        assert.equal(skip.value.skipped, 1);
        assert.equal(skip.value.imported, 0);

        const over = await repo.importJson([{
            ...FIXTURE[0],
            positivePrompt: 'OVERWRITTEN',
            referenceImage: TINY_PNG,
        }], { strategy: 'overwrite' });
        assert.equal(over.value.imported, 1);
        const list2 = await repo.list();
        assert.equal(list2.value[0].positivePrompt, 'OVERWRITTEN');

        const ren = await repo.importJson([{
            ...FIXTURE[0],
            positivePrompt: 'RENAMED_COPY',
            referenceImage: TINY_PNG,
        }], { strategy: 'rename' });
        assert.equal(ren.value.imported, 1);
        const list3 = await repo.list();
        assert.equal(list3.value.length, 2);
    });

    it('overwrites an illustrated artist with a missing or blank image', async () => {
        for (const imageField of ['missing', 'null', 'empty', 'whitespace']) {
            const { repo, imageRepo } = makeRepo();
            const first = await repo.importJson([FIXTURE[0]], { strategy: 'skip' });
            assert.equal(first.value.imported, 1);
            const original = (await repo.list()).value[0];
            const row = {
                name: original.name,
                sequence: original.sequence,
                positivePrompt: 'new positive',
                negativePrompt: 'new negative',
            };
            if (imageField !== 'missing') {
                row.referenceImage = imageField === 'null' ? null : imageField === 'empty' ? '' : '  ';
            }

            const result = await repo.importJson([row], { strategy: 'overwrite' });
            assert.equal(result.ok, true, imageField);
            assert.deepEqual(result.value, { imported: 1, skipped: 0, errors: [] }, imageField);
            const updated = (await repo.list()).value[0];
            assert.equal(updated.id, original.id);
            assert.equal(updated.positivePrompt, 'new positive');
            assert.equal(updated.negativePrompt, 'new negative');
            assert.equal(updated.referenceImageRef, null);
            assert.equal(updated.cardImageRef, null);
            assert.equal((await imageRepo.getBlob(original.referenceImageRef)).value, null);
            assert.equal((await imageRepo.getBlob(original.cardImageRef)).value, null);
        }
    });

    it('card gen failure on one row keeps others', async () => {
        const imageDb = createMemoryIdb();
        const imageRepo = createImageRepo({ db: imageDb });
        const origPut = imageRepo.put.bind(imageRepo);
        let puts = 0;
        imageRepo.put = async (blob, opts) => {
            puts += 1;
            if (puts === 2) {
                return {
                    ok: false,
                    error: {
                        category: 'host',
                        code: 'LOCAL_FAIL',
                        message: 'simulated card fail',
                    },
                };
            }
            return origPut(blob, opts);
        };
        const { repo } = makeRepo({ imageRepo, imageDb });
        const r = await repo.importJson(FIXTURE, { strategy: 'skip' });
        assert.equal(r.ok, true);
        assert.ok(r.value.imported >= 1);
        assert.ok(r.value.errors.length >= 1);
        assert.ok(r.value.errors.some((e) => /fixture-/.test(e)));
    });

    it('再次导入同一名称，示例图路径不变', async () => {
        const { repo, imageRepo } = makeRepo();
        await repo.importJson([FIXTURE[0]], { strategy: 'skip' });
        const list1 = await repo.list();
        const a = list1.value[0];
        const name = FIXTURE[0].name;
        assert.equal(a.referenceImageRef, artistLocalImageId(name, 'ref'));
        assert.equal(a.cardImageRef, artistLocalImageId(name, 'card'));

        await repo.importJson([{
            ...FIXTURE[0],
            referenceImage: TINY_PNG,
        }], { strategy: 'overwrite' });
        const list2 = await repo.list();
        const b = list2.value[0];
        assert.equal(b.referenceImageRef, a.referenceImageRef);
        assert.equal(b.cardImageRef, a.cardImageRef);
        const blob = await imageRepo.getBlob(b.referenceImageRef);
        assert.ok(blob.value);
        const cached = await imageRepo.listMeta();
        assert.equal(cached.ok, true);
        assert.equal(cached.value.some((row) => row.id === b.referenceImageRef), false);
    });

    it('export errors when referenced image file is missing', async () => {
        const { repo, imageRepo } = makeRepo();
        await repo.importJson([FIXTURE[0]], { strategy: 'skip' });
        const list = await repo.list();
        await imageRepo.remove(list.value[0].referenceImageRef);
        const exp = await repo.exportJson();
        assert.equal(exp.ok, false);
        assert.match(exp.error.message, /原图|不存在|无法读取/);
    });

    it('removeArtistPreviewFiles deletes both reference and card', async () => {
        const serverFiles = createMemoryServerFiles();
        const id = 'ar-del';
        const ref = artistPreviewFileName(id, 'png');
        const card = artistCardFileName(id);
        await serverFiles.writeBase64(ref, 'aa');
        await serverFiles.writeBase64(card, 'bb');
        const r = await removeArtistPreviewFiles(
            { serverFiles },
            { referenceImageRef: ref, cardImageRef: card },
        );
        assert.equal(r.ok, true);
        const ex = await serverFiles.exists([ref, card]);
        assert.equal(ex.value[ref], false);
        assert.equal(ex.value[card], false);
    });
});

describe('artist presets import format', () => {
    it('sample fixtures: name/prompts match character-for-character', () => {
        const converted = convertPresetsArtistImport(PRESETS_SAMPLE);
        assert.equal(converted.ok, true);
        assert.equal(converted.format, 'presets');
        assert.equal(converted.value.length, 1);
        const row = converted.value[0];
        const name = Object.keys(PRESETS_SAMPLE.presets)[0];
        const preset = PRESETS_SAMPLE.presets[name];
        assert.equal(row.name, name);
        assert.equal(row.positivePrompt, preset.fixedPrompt);
        assert.equal(row.negativePrompt, preset.negativePrompt);
        assert.equal(row.referenceImage, null);
    });

    it('fixedPrompt_end appends; images data URL / non-string; sequence continues', async () => {
        const converted = convertPresetsArtistImport(PRESETS_EXTRA);
        assert.equal(converted.ok, true);
        assert.equal(converted.value.length, 3);
        const byName = Object.fromEntries(converted.value.map((r) => [r.name, r]));
        assert.equal(byName['alpha-end'].positivePrompt, 'base prompt, trail weight');
        assert.equal(byName['beta-img'].referenceImage, PRESETS_EXTRA.images['beta-img']);
        assert.equal(byName['gamma-bad-img'].referenceImage, null);

        const seed = [createArtist({
            name: 'existing',
            positivePrompt: '',
            negativePrompt: '',
            sequence: 40,
        }, { id: 'seed', now: 't0' })];
        const { repo } = makeRepo({ seed });
        const imp = await repo.importJson(PRESETS_EXTRA, { strategy: 'skip' });
        assert.equal(imp.ok, true);
        assert.equal(imp.value.imported, 3);
        const list = await repo.list();
        const imported = list.value.filter((a) => a.name !== 'existing').sort((a, b) => a.sequence - b.sequence);
        assert.deepEqual(imported.map((a) => a.sequence), [41, 42, 43]);
        assert.ok(imported.find((a) => a.name === 'beta-img')?.cardImageRef);
        assert.equal(imported.find((a) => a.name === 'gamma-bad-img')?.cardImageRef, null);
    });

    it('unrecognized format errors clearly', () => {
        const bad = normalizeArtistImportPayload({ foo: 1 });
        assert.equal(bad.ok, false);
        assert.match(bad.error, /无法识别/);
        const bad2 = normalizeArtistImportPayload(null);
        assert.equal(bad2.ok, false);
    });

    it('repo importJson accepts presets sample end-to-end', async () => {
        const { repo } = makeRepo();
        const imp = await repo.importJson(PRESETS_SAMPLE, { strategy: 'skip' });
        assert.equal(imp.ok, true);
        assert.equal(imp.value.imported, 1);
        const list = await repo.list();
        const name = Object.keys(PRESETS_SAMPLE.presets)[0];
        assert.equal(list.value[0].name, name);
        assert.equal(list.value[0].positivePrompt, PRESETS_SAMPLE.presets[name].fixedPrompt);
        assert.equal(list.value[0].negativePrompt, PRESETS_SAMPLE.presets[name].negativePrompt);
        const exp = await repo.exportJson();
        assert.equal(exp.ok, true);
        assert.deepEqual(Object.keys(exp.value[0]), [...ARTIST_EXPORT_FIELD_ORDER]);
    });

    it('import N 条：IDB 只开 1 次事务，onChanged 只触发 1 次（不随 N 增长）', async () => {
        const serverFiles = createMemoryServerFiles();
        const db = createMemoryIdb({ [IDB_STORES.ARTISTS]: [] });
        let txCount = 0;
        const origTx = db.runTransaction.bind(db);
        db.runTransaction = async (...args) => {
            txCount += 1;
            return origTx(...args);
        };
        let seq = 0;
        const repo = createArtistRepo({
            db,
            imageRepo: createImageRepo({ db: createMemoryIdb() }),
            nowIso: () => '2026-01-01T00:00:00.000Z',
            newId: () => `ar-perf-${seq++}`,
            makeCardImage: async () => TINY_CARD,
        });
        let changeCount = 0;
        repo.onChanged(() => {
            changeCount += 1;
        });

        const N = 24;
        /** @type {object[]} */
        const rows = [];
        for (let i = 0; i < N; i += 1) {
            rows.push({
                name: `perf-${i}`,
                sequence: i,
                positivePrompt: 'p',
                negativePrompt: 'n',
                referenceImage: TINY_PNG,
            });
        }
        const imp = await repo.importJson(rows, { strategy: 'skip' });
        assert.equal(imp.ok, true);
        assert.equal(imp.value.imported, N);
        assert.equal(txCount, 1, `期望 1 次事务，实际 ${txCount}`);
        assert.equal(changeCount, 1, `期望 1 次 onChanged，实际 ${changeCount}`);
    });

    it('500 条带图导入在 2s 内完成（锁住逐条 timer / 整表重写回归）', async () => {
        const { performance } = await import('node:perf_hooks');
        let seq = 0;
        const repo = createArtistRepo({
            db: createMemoryIdb({ [IDB_STORES.ARTISTS]: [] }),
            imageRepo: createImageRepo({ db: createMemoryIdb() }),
            nowIso: () => '2026-01-01T00:00:00.000Z',
            newId: () => `ar-bulk-${seq++}`,
            makeCardImage: async () => TINY_CARD,
        });
        const N = 500;
        /** @type {object[]} */
        const rows = [];
        for (let i = 0; i < N; i += 1) {
            rows.push({
                name: `bulk-${i}`,
                sequence: i,
                positivePrompt: `pos-${i}`,
                negativePrompt: 'neg',
                referenceImage: TINY_PNG,
            });
        }
        const t0 = performance.now();
        const imp = await repo.importJson(rows, { strategy: 'skip' });
        const ms = performance.now() - t0;
        assert.equal(imp.ok, true);
        assert.equal(imp.value.imported, N);
        assert.equal(imp.value.skipped, 0);
        assert.equal(imp.value.errors.length, 0);
        const listed = await repo.list();
        assert.equal(listed.value.length, N);
        // 旧实现：逐条 setTimeout + 大图逐片 timer 可达数分钟；健康路径应远低于 2s
        assert.ok(ms < 2000, `500 条导入过慢: ${ms.toFixed(0)}ms`);
    });
});

describe('image URL versioning vs JSON read cache-bust', () => {
    it('urlOf uses stable ?v=; same version yields same url; JSON read still busts', async () => {
        /** @type {string[]} */
        const fetched = [];
        const sf = createServerFiles({
            getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
            fetch: async (url) => {
                fetched.push(String(url));
                return {
                    ok: true,
                    status: 200,
                    text: async () => 'null',
                    arrayBuffer: async () => new ArrayBuffer(0),
                };
            },
        });
        const name = `${SERVER_FILE_PREFIX}artist-preview_x_card.webp`;
        const u1 = sf.urlOf(name, '2026-01-01T00:00:00.000Z');
        const u2 = sf.urlOf(name, '2026-01-01T00:00:00.000Z');
        const u3 = sf.urlOf(name, '2026-01-02T00:00:00.000Z');
        assert.equal(u1, u2);
        assert.match(u1, /\?v=2026-01-01T00%3A00%3A00\.000Z$/);
        assert.notEqual(u1, u3);
        assert.equal(sf.urlOf(name), `/user/files/${name}`);

        const display = artistPreviewDisplayUrl(sf, name, 'v1');
        assert.equal(display, `/user/files/${name}?v=v1`);

        await sf.readJson(`${SERVER_FILE_PREFIX}artists.json`);
        assert.ok(fetched.some((u) => /\?t=\d+/.test(u)));
    });
});
