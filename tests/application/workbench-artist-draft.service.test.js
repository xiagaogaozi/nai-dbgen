import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createArtist } from '../../src/domain/model/artist.js';
import { createWorkbenchArtistDraftService } from '../../src/application/workbench-artist-draft.service.js';
import { Ok, Err } from '../../src/infra/result.js';

function artist(id, sequence, referenceImageRef = null, cardImageRef = null) {
    return {
        ...createArtist({
            name: 'Existing',
            sequence,
            positivePrompt: 'old positive',
            negativePrompt: 'old negative',
        }, { id, now: '2026-09-27T00:00:00.000Z' }),
        referenceImageRef,
        cardImageRef,
    };
}

function serviceFor({ stored, events, putResult = null }) {
    let current = stored;
    let id = 0;
    return {
        service: createWorkbenchArtistDraftService({
            artistRepo: {
                async get(key) { return Ok(current?.id === key ? current : null); },
                async list() { return Ok(current ? [current] : []); },
                async put(entity) {
                    events.push('artist-put');
                    if (putResult) return putResult;
                    current = entity;
                    return Ok(entity);
                },
            },
            makeCardImage: async (blob) => {
                events.push('scale-card');
                return new Blob([await blob.arrayBuffer()], { type: 'image/webp' });
            },
            saveCoverPair: async (key, original, card) => {
                events.push('stage-cover-pair');
                assert.ok(key);
                assert.ok(original instanceof Blob);
                assert.ok(card instanceof Blob);
                return Ok({ referenceImageRef: 'new-original', cardImageRef: 'new-card' });
            },
            removeCoverImage: async (ref) => { events.push(`remove:${ref}`); return Ok(undefined); },
            newId: (prefix = 'id') => `${prefix}-${++id}`,
            nowIso: () => '2026-09-27T01:00:00.000Z',
        }),
        get current() { return current; },
    };
}

describe('workbench artist draft save service', () => {
    it('updates the same artist and retains its order and existing cover when no new cover is chosen', async () => {
        const current = artist('artist-1', 9, 'old-original', 'old-card');
        const events = [];
        const ctx = serviceFor({ stored: current, events });
        const result = await ctx.service.save({
            mode: 'update',
            artistId: current.id,
            name: 'Renamed',
            positivePrompt: 'draft positive',
            negativePrompt: 'draft negative',
        });

        assert.equal(result.ok, true);
        assert.equal(result.value.id, current.id);
        assert.equal(result.value.sequence, 9);
        assert.equal(result.value.name, 'Renamed');
        assert.equal(result.value.positivePrompt, 'draft positive');
        assert.equal(result.value.negativePrompt, 'draft negative');
        assert.equal(result.value.referenceImageRef, 'old-original');
        assert.equal(result.value.cardImageRef, 'old-card');
        assert.deepEqual(events, ['artist-put']);
    });

    it('stages an independent cover pair before update and removes old references only after entity success', async () => {
        const current = artist('artist-1', 9, 'old-original', 'old-card');
        const events = [];
        const ctx = serviceFor({ stored: current, events });
        const result = await ctx.service.save({
            mode: 'update',
            artistId: current.id,
            name: 'With cover',
            positivePrompt: 'positive',
            negativePrompt: 'negative',
            coverBlob: new Blob(['preview'], { type: 'image/png' }),
        });

        assert.equal(result.ok, true);
        assert.equal(result.value.referenceImageRef, 'new-original');
        assert.equal(result.value.cardImageRef, 'new-card');
        assert.deepEqual(events, [
            'scale-card',
            'stage-cover-pair',
            'artist-put',
            'remove:old-original',
            'remove:old-card',
        ]);
    });

    it('cleans a staged cover pair when the artist entity write fails', async () => {
        const current = artist('artist-1', 9, 'old-original', 'old-card');
        const events = [];
        const ctx = serviceFor({
            stored: current,
            events,
            putResult: Err({ message: 'simulated write failure' }),
        });
        const result = await ctx.service.save({
            mode: 'update',
            artistId: current.id,
            name: 'Not saved',
            positivePrompt: 'positive',
            negativePrompt: 'negative',
            coverBlob: new Blob(['preview'], { type: 'image/png' }),
        });

        assert.equal(result.ok, false);
        assert.equal(ctx.current, current);
        assert.deepEqual(events, [
            'scale-card',
            'stage-cover-pair',
            'artist-put',
            'remove:new-original',
            'remove:new-card',
        ]);
    });

    it('creates a new artist using the next existing sequence', async () => {
        const current = artist('artist-1', 12);
        const events = [];
        const ctx = serviceFor({ stored: current, events });
        const result = await ctx.service.save({
            mode: 'create',
            name: 'New artist',
            positivePrompt: 'new positive',
            negativePrompt: 'new negative',
        });

        assert.equal(result.ok, true);
        assert.equal(result.value.id, 'ar-1');
        assert.equal(result.value.sequence, 13);
        assert.equal(result.value.name, 'New artist');
        assert.equal(result.value.referenceImageRef, null);
        assert.equal(result.value.cardImageRef, null);
    });

    it('replaces only the preview image and keeps the artist text', async () => {
        const current = artist('artist-1', 9, 'old-original', 'old-card');
        const events = [];
        const ctx = serviceFor({ stored: current, events });
        const coverBlob = new Blob(['preview'], { type: 'image/png' });
        const result = await ctx.service.replacePreview({
            artistId: current.id,
            coverBlob,
        });

        assert.equal(result.ok, true);
        assert.equal(result.value.id, current.id);
        assert.equal(result.value.name, 'Existing');
        assert.equal(result.value.positivePrompt, 'old positive');
        assert.equal(result.value.negativePrompt, 'old negative');
        assert.equal(result.value.sequence, 9);
        assert.equal(result.value.referenceImageRef, 'new-original');
        assert.equal(result.value.cardImageRef, 'new-card');
        assert.deepEqual(events, [
            'scale-card',
            'stage-cover-pair',
            'artist-put',
            'remove:old-original',
            'remove:old-card',
        ]);
    });
});
