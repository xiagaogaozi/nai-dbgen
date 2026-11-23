/**
 * 图片缓存上限裁剪服务（需求 4.17）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryIdb } from '../../src/adapters/storage/memory-idb.js';
import { createImageRepo } from '../../src/adapters/storage/image.repo.js';
import { IDB_STORES } from '../../src/adapters/storage/idb.js';
import { createImageCacheTrimService } from '../../src/application/image-cache-trim.service.js';
import { APP_EVENTS } from '../../src/application/_helpers.js';
import { createEventBus } from '../../src/infra/event-bus.js';
import { isOk, isErr } from '../../src/infra/result.js';

describe('image-cache-trim.service', () => {
    it('reads limit, trims oldest, emits IMAGE_CACHE_TRIMMED', async () => {
        const db = createMemoryIdb();
        const imageRepo = createImageRepo({ db });
        const blob = new Blob(['x'], { type: 'image/png' });
        await db.put(IDB_STORES.IMAGES, {
            id: 'a', blob, mimeType: 'image/png', size: 1,
            createdAt: '2020-01-01T00:00:00.000Z',
        });
        await db.put(IDB_STORES.IMAGES, {
            id: 'b', blob, mimeType: 'image/png', size: 1,
            createdAt: '2021-01-01T00:00:00.000Z',
        });
        await db.put(IDB_STORES.IMAGES, {
            id: 'c', blob, mimeType: 'image/png', size: 1,
            createdAt: '2022-01-01T00:00:00.000Z',
        });
        await imageRepo.linkSlot('s', 1, 'a');

        const bus = createEventBus();
        /** @type {unknown[]} */
        const events = [];
        bus.on(APP_EVENTS.IMAGE_CACHE_TRIMMED, (p) => events.push(p));

        const svc = createImageCacheTrimService({
            loadSettings: () => ({ imageCacheLimit: 2 }),
            imageRepo,
            bus,
        });
        const r = await svc.trim();
        assert.equal(isOk(r), true);
        assert.equal(r.value.removed, 1);
        assert.deepEqual(r.value.removedRefs, ['a']);
        assert.equal(r.value.limit, 2);
        assert.equal(events.length, 1);
        assert.deepEqual(/** @type {any} */ (events[0]).removedRefs, ['a']);
        assert.equal(await db.get(IDB_STORES.SLOT_IMAGE_CACHE, ['s', 1]), undefined);
    });

    it('under limit does not emit', async () => {
        const db = createMemoryIdb();
        const imageRepo = createImageRepo({ db });
        const blob = new Blob(['x'], { type: 'image/png' });
        await imageRepo.put(blob);

        const bus = createEventBus();
        let emitted = false;
        bus.on(APP_EVENTS.IMAGE_CACHE_TRIMMED, () => {
            emitted = true;
        });

        const svc = createImageCacheTrimService({
            loadSettings: () => ({ imageCacheLimit: 500 }),
            imageRepo,
            bus,
        });
        const r = await svc.trim();
        assert.equal(isOk(r), true);
        assert.equal(r.value.removed, 0);
        assert.equal(emitted, false);
    });

    it('defaults to 500 when settings omit limit', async () => {
        const db = createMemoryIdb();
        const imageRepo = createImageRepo({ db });
        /** @type {number|null} */
        let seenLimit = null;
        const wrapped = {
            trimToLimit: async (limit) => {
                seenLimit = limit;
                return imageRepo.trimToLimit(limit);
            },
        };
        const svc = createImageCacheTrimService({
            loadSettings: () => ({}),
            imageRepo: wrapped,
        });
        const r = await svc.trim();
        assert.equal(isOk(r), true);
        assert.equal(seenLimit, 500);
    });

    it('propagates repo errors without throwing', async () => {
        const svc = createImageCacheTrimService({
            loadSettings: () => ({ imageCacheLimit: 3 }),
            imageRepo: {
                trimToLimit: async () => ({
                    ok: false,
                    error: { code: 'X', message: 'boom', category: 'config' },
                }),
            },
        });
        const r = await svc.trim();
        assert.equal(isErr(r), true);
        assert.equal(r.error.code, 'X');
    });

    it('clearAll and removeRefs delete images and emit IMAGE_CACHE_TRIMMED', async () => {
        const db = createMemoryIdb();
        const imageRepo = createImageRepo({ db });
        const blob = new Blob(['x'], { type: 'image/png' });
        await db.put(IDB_STORES.IMAGES, {
            id: 'a', blob, mimeType: 'image/png', size: 1,
            createdAt: '2020-01-01T00:00:00.000Z', pinned: true,
        });
        await db.put(IDB_STORES.IMAGES, {
            id: 'b', blob, mimeType: 'image/png', size: 1,
            createdAt: '2021-01-01T00:00:00.000Z',
        });

        const bus = createEventBus();
        /** @type {unknown[]} */
        const events = [];
        bus.on(APP_EVENTS.IMAGE_CACHE_TRIMMED, (p) => events.push(p));

        const svc = createImageCacheTrimService({
            loadSettings: () => ({ imageCacheLimit: 500 }),
            imageRepo,
            bus,
        });
        const r1 = await svc.removeRefs(['a']);
        assert.equal(isOk(r1), true);
        assert.deepEqual(r1.value.removedRefs, ['a']);
        assert.equal(events.length, 1);

        const r2 = await svc.clearAll();
        assert.equal(isOk(r2), true);
        assert.deepEqual(r2.value.removedRefs, ['b']);
        assert.equal(events.length, 2);
        assert.equal((await db.getAll(IDB_STORES.IMAGES)).length, 0);
    });
});
