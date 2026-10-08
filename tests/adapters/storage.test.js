/**
 * W1-D · 存储适配层：导入导出、重复策略、对账、GC 安全、settings（假 IDB）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryIdb } from '../../src/adapters/storage/memory-idb.js';
import {
    buildExportEnvelope,
    parseImportEnvelope,
    resolveDuplicate,
} from '../../src/adapters/storage/import-export.js';
import { mapIdbError, IDB_STORES, IDB_NAME, IDB_VERSION } from '../../src/adapters/storage/idb.js';
import { createCharacterRepo } from '../../src/adapters/storage/repos/character.repo.js';
import { createTagRepo } from '../../src/adapters/storage/repos/tag.repo.js';
import { createArtistRepo } from '../../src/adapters/storage/repos/artist.repo.js';
import { createPresetRepo } from '../../src/adapters/storage/repos/preset.repo.js';
import { createLlmConfigRepo, createNaiConfigRepo } from '../../src/adapters/storage/repos/api-config.repo.js';
import { createSlotRepo } from '../../src/adapters/storage/repos/slot.repo.js';
import { createChatIndexStore } from '../../src/adapters/storage/chat-index.store.js';
import { createMemoryServerFiles } from '../../src/adapters/storage/memory-server-files.js';
import { createImageRepo, collectLiveRefsFromRecords } from '../../src/adapters/storage/image.repo.js';
import { createSettingsStore } from '../../src/adapters/storage/settings.store.js';
import {
    assertCharacterRepository,
    assertTagRepository,
    assertRepository,
    assertSlotRepository,
    assertImageRepository,
} from '../../src/ports/repository.port.js';
import { isOk, isErr } from '../../src/infra/result.js';
import { emptyNaiCaption } from '../../src/domain/model/nai-params.js';
import { defaultPluginSettings } from '../../src/domain/model/plugin-settings.js';
import { chatSlotFileName } from '../../src/domain/slot/session-files.js';

function sampleGroup(overrides = {}) {
    return {
        schemaVersion: 1,
        id: 'g1',
        name: '组A',
        active: true,
        order: 0,
        createdAt: 't0',
        updatedAt: 't0',
        ...overrides,
    };
}

function sampleChar(overrides = {}) {
    return {
        schemaVersion: 1,
        id: 'c1',
        groupId: 'g1',
        name: '角色',
        keywords: ['alice'],
        fixedFeatures: 'dna',
        variableFeatures: [],
        matchOverrides: null,
        createdAt: 't0',
        updatedAt: 't0',
        ...overrides,
    };
}

function sampleSlot(overrides = {}) {
    return {
        schemaVersion: 1,
        messageId: 3,
        slotId: 1,
        caption: emptyNaiCaption(),
        anchorSentence: '一句。',
        images: [],
        createdAt: 't0',
        presetId: null,
        llmConfigId: null,
        ...overrides,
    };
}

function fakeSessionHost(opts = {}) {
    const sessionId = opts.sessionId ?? 'sess-1';
    /** @type {import('../../src/ports/host.port.js').HostMessage[]} */
    const messages = opts.messages ?? [
        { messageId: 0, name: 'U', text: 'hi', isUser: true, isSystem: false },
        { messageId: 1, name: 'B', text: 'ai1', isUser: false, isSystem: false },
        { messageId: 2, name: 'B', text: 'ai2', isUser: false, isSystem: false },
        { messageId: 3, name: 'B', text: 'ai3', isUser: false, isSystem: false },
        { messageId: 4, name: 'B', text: 'ai4', isUser: false, isSystem: false },
        { messageId: 5, name: 'B', text: 'ai5', isUser: false, isSystem: false },
        { messageId: 6, name: 'B', text: 'ai6', isUser: false, isSystem: false },
        { messageId: 7, name: 'B', text: 'ai7', isUser: false, isSystem: false },
    ];
    return {
        getSessionId: () => sessionId,
        getMessages: () => messages,
        getChatLocation: () => ({
            chatFileName: 'ChatA',
            avatarUrl: 'a.png',
            groupId: null,
        }),
        getCurrentChatId: () => 'ChatA',
        getMessage: (id) => messages.find((m) => m.messageId === id) || null,
        getMessageSwipeTexts: (id) => {
            const m = messages.find((x) => x.messageId === id);
            return m ? [m.text] : [];
        },
    };
}

function makeSlotRepo(opts = {}) {
    const serverFiles = opts.serverFiles ?? createMemoryServerFiles();
    const chatIndex = createChatIndexStore({
        serverFiles,
        nowIso: () => 't-now',
    });
    const host = opts.host ?? fakeSessionHost(opts);
    const loadSettings = () => ({
        ...defaultPluginSettings(),
        contextWindowSize: opts.contextWindowSize ?? 5,
    });
    const db = opts.db ?? createMemoryIdb();
    const imageRepo = opts.imageRepo ?? createImageRepo({ db });
    const slots = createSlotRepo({
        serverFiles,
        chatIndex,
        host,
        loadSettings,
        imageRepo,
        nowIso: () => 't-now',
    });
    return { slots, serverFiles, chatIndex, host, imageRepo, db };
}

describe('session slot repo', () => {
    it('parallel history appends do not lose records; editor conflicts preserve the newer history', async () => {
        const { slots } = makeSlotRepo();
        await slots.put(7, [sampleSlot({ messageId: 7 })]);
        const original = (await slots.getByMessage(7)).value;
        await Promise.all(['one', 'two', 'three'].map((ref) => slots.recordImage(7, 1, ref)));
        assert.equal((await slots.get(7, 1)).value.images.length, 3);
        const conflict = await slots.replaceMessageRecords(7, [], { expectedRecords: original });
        assert.equal(conflict.ok, false);
        assert.equal((await slots.get(7, 1)).value.images.length, 3);
    });

    it('deleting one message keeps records on other messages', async () => {
        const { slots } = makeSlotRepo();
        await slots.put(6, [sampleSlot({ slotId: 1, messageId: 6 })]);
        await slots.put(7, [sampleSlot({ slotId: 2, messageId: 7 })]);
        const original = (await slots.getByMessage(7)).value;
        assert.equal((await slots.replaceMessageRecords(7, [], { expectedRecords: original })).ok, true);
        assert.equal((await slots.getByMessage(7)).value.length, 0);
        assert.equal((await slots.getByMessage(6)).value.length, 1);
    });
    it('put/get/recordImage 写服务器会话文件；404=空', async () => {
        const { slots, serverFiles } = makeSlotRepo();
        assert.equal(isOk(assertSlotRepository(slots)), true);

        const rec = sampleSlot({ slotId: 1, messageId: 7 });
        assert.equal(isOk(await slots.put(7, [rec])), true);
        const got = await slots.get(7, 1);
        assert.equal(isOk(got), true);
        assert.equal(got.value?.slotId, 1);

        const fileName = chatSlotFileName('sess-1');
        const raw = await serverFiles.readJson(fileName);
        assert.equal(isOk(raw), true);
        assert.ok(raw.value);
        assert.equal(raw.value.slots.length, 1);

        const img = await slots.recordImage(7, 1, 'img_x', { naiConfigId: 'n1' });
        assert.equal(isOk(img), true);
        assert.equal(img.value.images[0].imageRef, 'img_x');
    });

    it('外部写词只保留本聊天最近 3 次生图内容，写 slot 不会清掉', async () => {
        const { slots, serverFiles } = makeSlotRepo();
        for (const name of ['一', '二', '三', '四']) {
            const saved = await slots.recordPromptCall({
                items: [{ slotId: 1, caption: { ...emptyNaiCaption(), note: name } }],
            });
            assert.equal(saved.ok, true);
        }
        const listed = await slots.listRecentPromptCalls();
        assert.equal(listed.ok, true);
        assert.deepEqual(listed.value.map((call) => call.items[0].caption.note), ['二', '三', '四']);

        assert.equal((await slots.put(7, [sampleSlot({ messageId: 7 })])).ok, true);
        const again = await slots.listRecentPromptCalls();
        assert.deepEqual(again.value.map((call) => call.items[0].caption.note), ['二', '三', '四']);

        const raw = await serverFiles.readJson(chatSlotFileName('sess-1'));
        assert.equal(raw.value.promptCalls.length, 3);
        assert.equal(raw.value.slots.length, 1);
    });

    it('读失败（非 404）→ Err，且不覆盖服务器文件', async () => {
        const serverFiles = createMemoryServerFiles({
            seed: {
                [chatSlotFileName('sess-1')]: { not: 'valid chat slot file' },
            },
        });
        // 损坏：slots 不是数组
        await serverFiles.writeJson(chatSlotFileName('sess-1'), { schemaVersion: 1, sessionId: 'sess-1', slots: 'bad' });
        const { slots } = makeSlotRepo({ serverFiles });
        const r = await slots.get(1, 1);
        assert.equal(isErr(r), true);
        assert.equal(r.error.code, 'CHAT_SLOT_FILE_CORRUPT');
        const still = await serverFiles.readJson(chatSlotFileName('sess-1'));
        assert.equal(still.value.slots, 'bad');
    });

    it('编号复用时清掉旧缓存图', async () => {
        const db = createMemoryIdb();
        const imageRepo = createImageRepo({ db });
        const blob = new Blob(['x'], { type: 'image/png' });
        const put = await imageRepo.put(blob);
        assert.equal(isOk(put), true);
        await imageRepo.linkSlot('sess-1', 1, put.value);

        const { slots } = makeSlotRepo({ db, imageRepo });
        await slots.put(7, [sampleSlot({ slotId: 1, messageId: 7, images: [
            { imageRef: put.value, createdAt: 't', naiConfigId: null, artistId: null },
        ] })]);
        // 复用 slotId=1 到另一楼
        await slots.put(5, [sampleSlot({ slotId: 1, messageId: 5 })]);
        const cached = await imageRepo.getSlotImageRef('sess-1', 1);
        assert.equal(isOk(cached), true);
        assert.equal(cached.value, null);
    });

    it('保留范围修剪：超出最近 N 条 AI 楼的记录删除', async () => {
        const { slots, serverFiles } = makeSlotRepo({ contextWindowSize: 2 });
        await slots.put(1, [sampleSlot({ slotId: 1, messageId: 1 })]);
        await slots.put(7, [sampleSlot({ slotId: 2, messageId: 7 })]);
        const list = await slots.listRetained();
        assert.equal(isOk(list), true);
        assert.equal(list.value.every((r) => r.messageId === 7 || r.messageId === 6), true);
        assert.equal(list.value.some((r) => r.slotId === 1), false);
        const raw = await serverFiles.readJson(chatSlotFileName('sess-1'));
        assert.equal(raw.value.slots.every((s) => s.slotId !== 1), true);
    });

    it('D37：正文尚无 IMG 时 put 当前楼记录不被修剪掉', async () => {
        const host = fakeSessionHost({
            messages: [
                { messageId: 0, name: 'U', text: 'hi', isUser: true, isSystem: false },
                { messageId: 1, name: 'B', text: 'no tokens yet', isUser: false, isSystem: false },
            ],
        });
        const { slots } = makeSlotRepo({ host, contextWindowSize: 5 });
        const put = await slots.put(1, [sampleSlot({ slotId: 9, messageId: 1 })]);
        assert.equal(isOk(put), true);
        const list = await slots.listRetained();
        assert.equal(isOk(list), true);
        assert.equal(list.value.some((r) => r.slotId === 9), true);
    });

    it('切会话后 put(sessionId) 仍写入原会话文件且不污染当前缓存', async () => {
        let sessionId = 'sess-A';
        const host = {
            getSessionId: () => sessionId,
            getMessages: () => [
                { messageId: 0, name: 'U', text: 'hi', isUser: true, isSystem: false },
                { messageId: 1, name: 'B', text: 'ai', isUser: false, isSystem: false },
            ],
            getChatLocation: () => ({
                chatFileName: sessionId === 'sess-A' ? 'ChatA' : 'ChatB',
                avatarUrl: 'a.png',
                groupId: null,
            }),
        };
        const serverFiles = createMemoryServerFiles();
        const chatIndex = createChatIndexStore({ serverFiles });
        const slots = createSlotRepo({
            serverFiles,
            chatIndex,
            host,
            loadSettings: () => ({ ...defaultPluginSettings(), contextWindowSize: 5 }),
            nowIso: () => 't1',
        });

        await slots.put(1, [sampleSlot({ slotId: 1, messageId: 1 })], {
            sessionId: 'sess-A',
            messagesForTrim: host.getMessages(),
            chatLocation: { chatFileName: 'ChatA', avatarUrl: 'a.png', groupId: null },
        });

        sessionId = 'sess-B';
        await slots.ensureLoaded();
        assert.equal(slots.getSessionId(), 'sess-B');

        await slots.put(1, [sampleSlot({ slotId: 2, messageId: 1, anchorSentence: 'fromA' })], {
            sessionId: 'sess-A',
            messagesForTrim: [
                { messageId: 0, name: 'U', text: 'hi', isUser: true, isSystem: false },
                { messageId: 1, name: 'B', text: 'ai', isUser: false, isSystem: false },
            ],
            chatLocation: { chatFileName: 'ChatA', avatarUrl: 'a.png', groupId: null },
        });

        const fileA = await serverFiles.readJson(chatSlotFileName('sess-A'));
        assert.equal(isOk(fileA), true);
        assert.ok(fileA.value.slots.some((s) => s.slotId === 2));

        const cur = await slots.get(1, 2);
        assert.equal(isOk(cur), true);
        assert.equal(cur.value, null, 'B 会话内存不应出现 A 的 slot');

        const index = await chatIndex.findBySessionId('sess-A');
        assert.equal(isOk(index), true);
        assert.equal(index.value.chatFileName, 'ChatA');
    });
});

describe('image repo D22 / slot cache', () => {
    it('覆盖同一 id 后 getUrl 换成新图', async () => {
        const prevUrl = globalThis.URL;
        const revoked = [];
        let n = 0;
        globalThis.URL = {
            createObjectURL() {
                n += 1;
                return `blob:artist-${n}`;
            },
            revokeObjectURL(url) {
                revoked.push(url);
            },
        };
        try {
            const db = createMemoryIdb();
            const images = createImageRepo({ db });
            const id = 'artist-card:demo';
            assert.equal((await images.put(new Blob(['old'], { type: 'image/png' }), { id })).ok, true);
            const first = await images.getUrl(id);
            assert.equal(first.ok, true);
            assert.equal(first.value, 'blob:artist-1');
            assert.equal((await images.put(new Blob(['new-preview'], { type: 'image/png' }), { id })).ok, true);
            const second = await images.getUrl(id);
            assert.equal(second.ok, true);
            assert.equal(second.value, 'blob:artist-2');
            assert.equal(revoked.includes('blob:artist-1'), true);
            const again = await images.getUrl(id);
            assert.equal(again.value, 'blob:artist-2');
        } finally {
            globalThis.URL = prevUrl;
        }
    });

    it('gc([]) and gc(undefined) return Err and keep all blobs', async () => {
        const db = createMemoryIdb();
        const images = createImageRepo({ db });
        assert.equal(isOk(assertImageRepository(images)), true);
        const blob = new Blob(['abc'], { type: 'image/png' });
        const put1 = await images.put(blob);
        const put2 = await images.put(blob);
        assert.equal(isOk(put1) && isOk(put2), true);

        const empty = await images.gc([]);
        assert.equal(isErr(empty), true);
        assert.equal(empty.error.code, 'IMAGE_GC_EMPTY_LIVE_REFS');
        assert.equal((await db.getAll(IDB_STORES.IMAGES)).length, 2);

        const bad = await images.gc(/** @type {any} */ (undefined));
        assert.equal(isErr(bad), true);
        assert.equal(bad.error.code, 'IMAGE_GC_INVALID_LIVE_REFS');
        assert.equal((await db.getAll(IDB_STORES.IMAGES)).length, 2);
    });

    it('gc([], { force: true }) clears all', async () => {
        const db = createMemoryIdb();
        const images = createImageRepo({ db });
        const blob = new Blob(['x'], { type: 'image/png' });
        await images.put(blob);
        await images.put(blob);
        const cleared = await images.gc([], { force: true });
        assert.equal(isOk(cleared), true);
        assert.equal(cleared.value.removed, 2);
        assert.equal((await db.getAll(IDB_STORES.IMAGES)).length, 0);
    });

    it('put/gc with liveRefs keeps listed', async () => {
        const db = createMemoryIdb();
        const images = createImageRepo({ db });
        const blob = new Blob(['abc'], { type: 'image/png' });
        const put1 = await images.put(blob);
        const put2 = await images.put(blob);
        const gc = await images.gc([put1.value]);
        assert.equal(isOk(gc), true);
        assert.equal(gc.value.removed, 1);
        assert.equal((await db.getAll(IDB_STORES.IMAGES)).length, 1);
        void put2;
    });

    it('collectLiveRefsFromRecords + cache index', async () => {
        const db = createMemoryIdb();
        const images = createImageRepo({ db });
        const blob = new Blob(['a'], { type: 'image/png' });
        const a = await images.put(blob);
        const b = await images.put(blob);
        await images.linkSlot('sess-1', 9, b.value);
        const fromRecords = collectLiveRefsFromRecords([
            sampleSlot({
                images: [{ imageRef: a.value, createdAt: 't', naiConfigId: null, artistId: null }],
            }),
        ]);
        assert.deepEqual(fromRecords, [a.value]);
        const live = await images.collectLiveRefs(
            [sampleSlot({
                images: [{ imageRef: a.value, createdAt: 't', naiConfigId: null, artistId: null }],
            })],
            'sess-1',
        );
        assert.equal(isOk(live), true);
        assert.ok(live.value.includes(a.value));
        assert.ok(live.value.includes(b.value));
    });

    it('getSlotImageRef returns null when blob missing', async () => {
        const db = createMemoryIdb();
        const images = createImageRepo({ db });
        await db.put(IDB_STORES.SLOT_IMAGE_CACHE, {
            sessionId: 'sess-1',
            slotId: 1,
            imageRef: 'missing',
            updatedAt: 't',
        });
        const r = await images.getSlotImageRef('sess-1', 1);
        assert.equal(isOk(r), true);
        assert.equal(r.value, null);
    });

    it('trimToLimit deletes oldest by createdAt and syncs slot cache', async () => {
        const db = createMemoryIdb();
        const images = createImageRepo({ db });
        const blob = new Blob(['x'], { type: 'image/png' });
        await db.put(IDB_STORES.IMAGES, {
            id: 'img-old', blob, mimeType: 'image/png', size: 1,
            createdAt: '2020-01-01T00:00:00.000Z',
        });
        await db.put(IDB_STORES.IMAGES, {
            id: 'img-mid', blob, mimeType: 'image/png', size: 1,
            createdAt: '2021-01-01T00:00:00.000Z',
        });
        await db.put(IDB_STORES.IMAGES, {
            id: 'img-new', blob, mimeType: 'image/png', size: 1,
            createdAt: '2022-01-01T00:00:00.000Z',
        });
        await images.linkSlot('sess-a', 1, 'img-old');
        await images.linkSlot('sess-b', 2, 'img-mid');
        await images.linkSlot('sess-c', 3, 'img-new');

        const under = await images.trimToLimit(5);
        assert.equal(isOk(under), true);
        assert.equal(under.value.removed, 0);
        assert.equal((await db.getAll(IDB_STORES.IMAGES)).length, 3);

        const trimmed = await images.trimToLimit(2);
        assert.equal(isOk(trimmed), true);
        assert.equal(trimmed.value.removed, 1);
        assert.deepEqual(trimmed.value.removedRefs, ['img-old']);
        const left = (await db.getAll(IDB_STORES.IMAGES)).map((r) => r.id).sort();
        assert.deepEqual(left, ['img-mid', 'img-new']);
        assert.equal(await db.get(IDB_STORES.SLOT_IMAGE_CACHE, ['sess-a', 1]), undefined);
        assert.ok(await db.get(IDB_STORES.SLOT_IMAGE_CACHE, ['sess-b', 2]));
        assert.ok(await db.get(IDB_STORES.SLOT_IMAGE_CACHE, ['sess-c', 3]));
    });

    it('trimToLimit rejects non-positive limit', async () => {
        const db = createMemoryIdb();
        const images = createImageRepo({ db });
        const bad = await images.trimToLimit(0);
        assert.equal(isErr(bad), true);
        assert.equal(bad.error.code, 'IMAGE_CACHE_LIMIT');
    });
});


describe('idb schema constants', () => {
    it('exports stable db name/version/stores', () => {
        assert.equal(IDB_NAME, 'nai-dbgen');
        assert.equal(IDB_VERSION, 3);
        assert.ok(IDB_STORES.CHARACTERS);
        assert.ok(IDB_STORES.IMAGES);
        assert.ok(IDB_STORES.SLOT_IMAGE_CACHE);
        assert.equal(IDB_STORES.SLOT_INDEX, undefined);
    });

    it('maps QuotaExceededError with actionable hint', () => {
        const err = mapIdbError(Object.assign(new Error('quota'), { name: 'QuotaExceededError' }));
        assert.equal(err.code, 'IDB_QUOTA_EXCEEDED');
        assert.match(err.hint || '', /GC|清理/);
    });

    it('maps missing IndexedDB to IDB_UNAVAILABLE', () => {
        const err = mapIdbError(Object.assign(new Error('denied'), { name: 'InvalidStateError' }));
        assert.equal(err.code, 'IDB_UNAVAILABLE');
    });
});

describe('import-export helpers', () => {
    it('buildExportEnvelope includes schemaVersion and kind', () => {
        const env = buildExportEnvelope({
            kind: 'artist',
            schemaVersion: 1,
            payload: { items: [] },
        });
        assert.equal(env.kind, 'artist');
        assert.equal(env.schemaVersion, 1);
        assert.ok(env.exportedAt);
        assert.deepEqual(env.items, []);
    });

    it('parseImportEnvelope rejects wrong kind', () => {
        const r = parseImportEnvelope({ kind: 'tag', schemaVersion: 1 }, 'artist');
        assert.equal(r.ok, false);
    });

    it('resolveDuplicate skip/overwrite/rename', () => {
        const incoming = { id: 'a', name: 'A', createdAt: 'new' };
        const existing = { id: 'a', name: 'Old', createdAt: 'old' };
        assert.equal(resolveDuplicate({ incoming, existing, strategy: 'skip' }).action, 'skip');
        const ow = resolveDuplicate({ incoming, existing, strategy: 'overwrite' });
        assert.equal(ow.action, 'write');
        assert.equal(ow.entity.id, 'a');
        assert.equal(ow.entity.createdAt, 'old');
        const rn = resolveDuplicate({ incoming, existing, strategy: 'rename', idPrefix: 'x' });
        assert.equal(rn.action, 'write');
        assert.notEqual(rn.entity.id, 'a');
        assert.match(rn.entity.name, /导入副本/);
    });
});

describe('character repo', () => {
    it('crud + cascade removeGroup + import strategies', async () => {
        const db = createMemoryIdb();
        const repo = createCharacterRepo({ db });
        assert.equal(isOk(assertCharacterRepository(repo)), true);

        assert.equal(isOk(await repo.putGroup(sampleGroup())), true);
        assert.equal(isOk(await repo.put(sampleChar())), true);
        const listed = await repo.listByGroup('g1');
        assert.equal(isOk(listed), true);
        assert.equal(listed.value.length, 1);

        const exported = await repo.exportJson();
        assert.equal(isOk(exported), true);
        assert.equal(exported.value.kind, 'character');
        assert.equal(exported.value.schemaVersion, 1);

        const skip = await repo.importJson(exported.value, { strategy: 'skip' });
        assert.equal(isOk(skip), true);
        assert.equal(skip.value.skipped >= 1, true);

        const owPayload = {
            ...exported.value,
            groups: [{ ...sampleGroup(), name: '组改名' }],
            characters: [{ ...sampleChar(), name: '角色改名' }],
        };
        const ow = await repo.importJson(owPayload, { strategy: 'overwrite' });
        assert.equal(isOk(ow), true);
        const g = await repo.getGroup('g1');
        assert.equal(g.value.name, '组改名');

        await repo.removeGroup('g1');
        const after = await repo.listByGroup('g1');
        assert.equal(after.value.length, 0);
        assert.equal((await repo.getGroup('g1')).value, null);
    });

    it('export→import overwrite is deep-equal lossless', async () => {
        const db = createMemoryIdb();
        const repo = createCharacterRepo({ db });
        await repo.putGroup(sampleGroup());
        await repo.put(sampleChar({
            keywords: ['alice', '/foo,bar/i'],
            variableFeatures: [{ name: '衣', prompt: 'dress' }],
        }));
        const before = await repo.exportJson();
        const db2 = createMemoryIdb();
        const repo2 = createCharacterRepo({ db: db2 });
        const imp = await repo2.importJson(before.value, { strategy: 'overwrite' });
        assert.equal(isOk(imp), true);
        const after = await repo2.exportJson();
        assert.deepEqual(after.value.groups, before.value.groups);
        assert.deepEqual(after.value.characters, before.value.characters);
    });

    it('onChanged unsubscribe is idempotent', async () => {
        const db = createMemoryIdb();
        const repo = createCharacterRepo({ db });
        let n = 0;
        const off = repo.onChanged(() => { n += 1; });
        await repo.putGroup(sampleGroup({ id: 'g2', name: 'B' }));
        assert.equal(n, 1);
        off();
        off();
        await repo.putGroup(sampleGroup({ id: 'g3', name: 'C' }));
        assert.equal(n, 1);
    });
});

describe('tag repo', () => {
    it('listEntries filters by libraryId', async () => {
        const db = createMemoryIdb();
        const repo = createTagRepo({ db });
        assert.equal(isOk(assertTagRepository(repo)), true);

        await repo.putLibrary({
            schemaVersion: 1, id: 'l1', name: '库1', active: true, kind: 'composition', createdAt: 't', updatedAt: 't',
        });
        await repo.putLibrary({
            schemaVersion: 1, id: 'l2', name: '库2', active: true, kind: 'composition', createdAt: 't', updatedAt: 't',
        });
        await repo.put({
            schemaVersion: 1, id: 'e1', libraryId: 'l1',
            key: '背景：浴室', value: 'bathroom', createdAt: 't', updatedAt: 't',
        });
        await repo.put({
            schemaVersion: 1, id: 'e2', libraryId: 'l2',
            key: '背景：卧室', value: 'bedroom', createdAt: 't', updatedAt: 't',
        });

        const onlyL1 = await repo.listEntries('l1');
        assert.equal(onlyL1.value.length, 1);
        assert.equal(onlyL1.value[0].id, 'e1');
        const all = await repo.listEntries();
        assert.equal(all.value.length, 2);
    });

    it('export→import overwrite is deep-equal lossless', async () => {
        const db = createMemoryIdb();
        const repo = createTagRepo({ db });
        await repo.putLibrary({
            schemaVersion: 1, id: 'l1', name: '库1', active: true, kind: 'composition', createdAt: 't', updatedAt: 't',
        });
        await repo.put({
            schemaVersion: 1, id: 'e1', libraryId: 'l1',
            key: '背景：浴室', value: 'bathroom', createdAt: 't', updatedAt: 't',
        });
        const before = await repo.exportJson();
        const db2 = createMemoryIdb();
        const repo2 = createTagRepo({ db: db2 });
        assert.equal(isOk(await repo2.importJson(before.value, { strategy: 'overwrite' })), true);
        const after = await repo2.exportJson();
        assert.deepEqual(after.value.libraries, before.value.libraries);
        assert.deepEqual(after.value.entries, before.value.entries);
    });

    it('exportJson / listEntries keep save order (not sorted by key)', async () => {
        const db = createMemoryIdb();
        const repo = createTagRepo({ db });
        await repo.putLibrary({
            schemaVersion: 1, id: 'l1', name: '库1', active: true, kind: 'constant',
            createdAt: 't', updatedAt: 't',
        });
        await repo.put({
            schemaVersion: 1, id: 'e-z', libraryId: 'l1', key: 'zebra', value: 'z',
            createdAt: 't', updatedAt: 't',
        });
        await repo.put({
            schemaVersion: 1, id: 'e-a', libraryId: 'l1', key: 'apple', value: 'a',
            createdAt: 't', updatedAt: 't',
        });
        const listed = await repo.listEntries('l1');
        assert.deepEqual(listed.value.map((e) => e.key), ['zebra', 'apple']);
        const exported = await repo.exportJson();
        assert.deepEqual(exported.value.entries.map((e) => e.key), ['zebra', 'apple']);
    });
});

describe('artist / preset / api-config repos', () => {
    it('artist export→import overwrite deep-equal', async () => {
        const db = createMemoryIdb();
        const serverFiles = createMemoryServerFiles();
        const repo = createArtistRepo({ db, serverFiles });
        assert.equal(isOk(assertRepository(repo)), true);
        const artist = {
            schemaVersion: 1,
            id: 'a1',
            name: '串',
            sequence: 0,
            positivePrompt: 'p',
            negativePrompt: 'n',
            referenceImageRef: null,
            cardImageRef: null,
            createdAt: 't',
            updatedAt: 't',
        };
        await repo.put(artist);
        const before = await repo.exportJson();
        assert.equal(before.ok, true);
        assert.ok(Array.isArray(before.value));
        const db2 = createMemoryIdb();
        const serverFiles2 = createMemoryServerFiles();
        const repo2 = createArtistRepo({ db: db2, serverFiles: serverFiles2 });
        assert.equal(isOk(await repo2.importJson(before.value, { strategy: 'overwrite' })), true);
        const after = await repo2.exportJson();
        assert.deepEqual(after.value, before.value);
    });

    it('preset export→import overwrite deep-equal', async () => {
        const db = createMemoryIdb();
        const repo = createPresetRepo({ db });
        const preset = {
            schemaVersion: 1,
            id: 'p1',
            name: '生图',
            kind: 'imagegen',
            prompts: [{
                identifier: 'main', name: 'Main', role: 'system', content: 'hi',
                enabled: true, injection_position: 0, injection_depth: 0, injection_order: 100,
            }],
            prompt_order: [{ identifier: 'main', enabled: true }],
            createdAt: 't',
            updatedAt: 't',
        };
        await repo.put(preset);
        const before = await repo.exportJson();
        const db2 = createMemoryIdb();
        const repo2 = createPresetRepo({ db: db2 });
        assert.equal(isOk(await repo2.importJson(before.value, { strategy: 'overwrite' })), true);
        const after = await repo2.exportJson();
        assert.deepEqual(after.value.items, before.value.items);
    });

    it('artist export/import rename', async () => {
        const db = createMemoryIdb();
        const serverFiles = createMemoryServerFiles();
        const repo = createArtistRepo({ db, serverFiles });
        await repo.put({
            schemaVersion: 1, id: 'a1', name: '串', sequence: 0,
            positivePrompt: 'p', negativePrompt: 'n',
            referenceImageRef: null, cardImageRef: null,
            createdAt: 't', updatedAt: 't',
        });
        const exp = await repo.exportJson();
        assert.equal(exp.ok, true);
        const r = await repo.importJson(exp.value, { strategy: 'rename' });
        assert.equal(r.ok, true);
        assert.equal(r.value.imported, 1);
        const list = await repo.list();
        assert.equal(list.value.length, 2);
        assert.ok(list.value.some((a) => a.name.includes('导入副本')));
    });

    it('llm and nai repos are separate stores', async () => {
        const db = createMemoryIdb();
        const llm = createLlmConfigRepo({ db });
        const nai = createNaiConfigRepo({ db });
        await llm.put({
            schemaVersion: 1, id: 'l1', name: 'L', baseUrl: 'https://x', secretId: 'sec-1',
            model: 'm', createdAt: 't', updatedAt: 't',
        });
        await nai.put({
            schemaVersion: 1, id: 'n1', name: 'N', baseUrl: 'https://y', apiKey: 'k',
            transport: 'direct', decoder: 'auto', createdAt: 't', updatedAt: 't',
        });
        assert.equal((await llm.list()).value[0].secretId, 'sec-1');
        assert.equal((await nai.list()).value[0].transport, 'direct');
        assert.equal((await llm.list()).value.length, 1);
        assert.equal((await nai.list()).value.length, 1);
        assert.equal((await llm.get('n1')).value, null);

        const exported = await llm.exportJson();
        assert.equal(exported.ok, true);
        assert.equal('secretId' in exported.value.items[0], false);
    });
});

describe('settings store D15', () => {
    it('load/save via host only; merge drops unknown keys', () => {
        /** @type {ReturnType<typeof defaultPluginSettings>} */
        let stored = {
            ...defaultPluginSettings(),
            activeArtistId: 'a1',
        };
        /** @type {any} */
        stored = { ...stored, unknownKeyShouldDrop: true };

        let saveCount = 0;
        const store = createSettingsStore({
            host: {
                loadSettings() {
                    return stored;
                },
                saveSettings(settings) {
                    saveCount += 1;
                    stored = settings;
                },
            },
        });

        const loaded = store.load();
        assert.equal(loaded.activeArtistId, 'a1');
        assert.equal('unknownKeyShouldDrop' in loaded, false);

        store.set('autoWriteSlots', true);
        assert.equal(store.get('autoWriteSlots'), true);
        assert.equal(saveCount >= 1, true);
        assert.equal(stored.autoWriteSlots, true);
        assert.equal('unknownKeyShouldDrop' in stored, false);
    });

    it('rejects missing host', () => {
        assert.throws(() => createSettingsStore(/** @type {any} */ ({ getContext: () => ({}) })));
    });
});
