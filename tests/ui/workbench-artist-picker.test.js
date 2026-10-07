import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom } from './fake-dom.js';
import { mountWorkbench } from '../../src/ui/workbench/workbench.js';
import { mountDrawer } from '../../src/ui/drawer/drawer.js';
import { createSettingsStore } from '../../src/adapters/storage/settings.store.js';
import { defaultPluginSettings } from '../../src/domain/model/plugin-settings.js';
import { emptyNaiCaption } from '../../src/domain/model/nai-params.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

function fire(node, type, extra = {}) {
    assert.ok(node, `missing ${type} target`);
    for (const listener of node._listeners.filter((item) => item.type === type)) {
        listener.fn({ target: node, preventDefault() {}, ...extra });
    }
}

function button(root, label) {
    return root.querySelectorAll('button').find((node) => node.textContent === label);
}

describe('workbench artist picker and inline status', () => {
    let fake;
    let handles;

    beforeEach(() => {
        fake = installFakeDom();
        handles = [];
    });

    afterEach(() => {
        for (const handle of handles) handle.destroy();
        fake.restore();
    });

    function setup({ subscribe = true, service, items: initialItems, coverUrl, artistDraftService } = {}) {
        let settings = {
            ...defaultPluginSettings(),
            activeArtistId: 'a1',
            activeNaiConfigId: 'nai-existing',
        };
        let items = initialItems ?? [
            { id: 'a1', name: 'Alpha', cardImageRef: 'alpha.webp' },
            { id: 'a2', name: 'Beta', cardImageRef: 'beta.webp' },
        ];
        const repositoryListeners = new Set();
        let settingsSubscriptions = 0;
        const generatedWith = [];
        const generatedArtists = [];
        const store = createSettingsStore({
            host: {
                loadSettings: () => settings,
                saveSettings: (next) => { settings = next; },
            },
        });
        const artistRepo = {
            list: async () => ({ ok: true, value: items }),
            get: async (id) => ({ ok: true, value: items.find((item) => item.id === id) ?? null }),
            onChanged(fn) {
                repositoryListeners.add(fn);
                return () => repositoryListeners.delete(fn);
            },
        };
        const deps = {
            artistRepo,
            repos: { artist: artistRepo },
            loadSettings: store.load,
            saveSettings: store.save,
            subscribeSettings(fn) {
                settingsSubscriptions += 1;
                const unsubscribe = store.onChange(fn);
                return () => {
                    settingsSubscriptions -= 1;
                    unsubscribe();
                };
            },
            artistFileUrl: {
                cardUrl: (item) => item
                    ? coverUrl ?? `/user/files/nai-dbgen_${item.id}_card.webp?v=1`
                    : null,
            },
            workbenchService: service ?? {
                async writePrompt() {
                    return { ok: true, value: { caption: emptyNaiCaption(), unmatchedKeys: [] } };
                },
                async generateImage(req) {
                    generatedWith.push(req.artist === null ? null : req.artist?.id ?? store.load().activeArtistId);
                    generatedArtists.push(req.artist);
                    return { ok: true, value: [] };
                },
            },
            artistDraftService,
        };
        const root = document.createElement('div');
        document.body.appendChild(root);
        const handle = mountWorkbench(root, {
            ...deps,
            subscribeSettings: subscribe ? deps.subscribeSettings : undefined,
        });
        handles.push(handle);
        const field = root.querySelector('.nd-wb-artist');
        return {
            root, field, handle, deps, store, generatedWith, generatedArtists,
            input: field.querySelector('input'),
            subscriptions: () => ({
                settings: settingsSubscriptions,
                repository: repositoryListeners.size,
            }),
            updateItems(next) {
                items = next;
                for (const fn of repositoryListeners) fn();
            },
        };
    }

    it('shows the active artist and safe thumbnail above the current caption', async () => {
        const ctx = setup();
        await flush();
        assert.ok(ctx.field.parentNode.className.includes('nd-wb-artist-slot'));
        assert.equal(ctx.input.value, 'Alpha');
        const image = ctx.field.querySelector('.nd-picker__cover').querySelector('img');
        assert.equal(image.src, '/user/files/nai-dbgen_a1_card.webp?v=1');
        assert.equal(ctx.field.querySelector('.nd-field__label').textContent, '当前画师串');
    });

    it('hydrates prompt drafts from the selected artist and generates from unsaved workbench text', async () => {
        const ctx = setup({ items: [
            { id: 'a1', name: 'Alpha', positivePrompt: 'saved positive', negativePrompt: 'saved negative' },
            { id: 'a2', name: 'Beta', positivePrompt: 'beta positive', negativePrompt: 'beta negative' },
        ] });
        await flush();
        const promptFields = ctx.root.querySelector('.nd-wb-artist-prompts').querySelectorAll('.nd-field');
        const positive = promptFields[0].querySelector('textarea');
        const negative = promptFields[1].querySelector('textarea');
        assert.equal(promptFields[0].querySelector('.nd-field__label').textContent, '画师串 · 正面');
        assert.equal(promptFields[1].querySelector('.nd-field__label').textContent, '画师串 · 负面');
        assert.ok(positive && negative);
        assert.equal(positive.value, 'saved positive');
        assert.equal(negative.value, 'saved negative');

        fire(ctx.input, 'focus');
        const betaOption = ctx.field.querySelectorAll('.nd-picker-option')
            .find((option) => option.querySelector('strong')?.textContent === 'Beta');
        assert.ok(betaOption);
        fire(betaOption, 'click');
        await flush();
        assert.equal(positive.value, 'beta positive');
        assert.equal(negative.value, 'beta negative');

        const shell = ctx.root.querySelector('.nd-workbench');
        const input = (target) => {
            for (const listener of shell._listeners.filter((item) => item.type === 'input')) {
                listener.fn({ target });
            }
        };
        positive.value = 'edited positive';
        negative.value = 'edited negative';
        input(positive);
        input(negative);
        fire(button(ctx.root, '出图'), 'click');
        await flush();
        assert.equal(ctx.generatedArtists[0].id, 'a2');
        assert.equal(ctx.generatedArtists[0].positivePrompt, 'edited positive');
        assert.equal(ctx.generatedArtists[0].negativePrompt, 'edited negative');
        assert.equal(ctx.store.load().activeArtistId, 'a1');

        fire(ctx.field.querySelector('.nd-picker__clear'), 'click');
        await flush();
        positive.value = 'temporary positive';
        negative.value = 'temporary negative';
        input(positive);
        input(negative);
        fire(button(ctx.root, '出图'), 'click');
        await flush();
        assert.equal(ctx.generatedArtists[1].name, '工作台临时画师串');
        assert.equal(ctx.generatedArtists[1].positivePrompt, 'temporary positive');
        assert.equal(ctx.generatedArtists[1].negativePrompt, 'temporary negative');
        assert.equal(ctx.store.load().activeArtistId, 'a1');
    });

    it('keeps workbench artist selection separate from the drawer and global settings', async () => {
        const ctx = setup();
        const drawerRoot = document.createElement('div');
        document.body.appendChild(drawerRoot);
        const drawer = mountDrawer(drawerRoot, {
            ...ctx.deps,
            openManagementShell() {},
        });
        handles.push(drawer);
        await flush();
        const drawerInput = drawerRoot.querySelector('.nd-picker').querySelector('input');

        fire(ctx.input, 'focus');
        ctx.input.value = 'bet';
        fire(ctx.input, 'input');
        const options = ctx.field.querySelectorAll('.nd-picker-option');
        assert.equal(options.length, 1);
        assert.equal(options[0].querySelector('strong').textContent, 'Beta');
        fire(options[0], 'click');
        await flush();
        assert.equal(ctx.store.load().activeArtistId, 'a1');
        assert.equal(ctx.input.value, 'Beta');
        assert.equal(drawerInput.value, 'Alpha');
        assert.equal(ctx.store.load().activeNaiConfigId, 'nai-existing');

        fire(button(ctx.root, '出图'), 'click');
        await flush();
        assert.deepEqual(ctx.generatedWith, ['a2']);

        fire(drawerInput, 'focus');
        fire(drawerRoot.querySelectorAll('.nd-picker-option')[0], 'click');
        await flush();
        assert.equal(ctx.input.value, 'Beta');

        fire(ctx.field.querySelector('.nd-picker__clear'), 'click');
        await flush();
        assert.equal(ctx.store.load().activeArtistId, 'a1');
        assert.equal(ctx.input.value, '');
        assert.equal(drawerInput.value, 'Alpha');
        fire(button(ctx.root, '出图'), 'click');
        await flush();
        assert.deepEqual(ctx.generatedWith, ['a2', null]);
    });

    it('refreshes names and search results after artist-library changes', async () => {
        const ctx = setup();
        await flush();
        ctx.updateItems([
            { id: 'a1', name: 'Alpha renamed' },
            { id: 'a3', name: 'Gamma' },
        ]);
        await flush();
        assert.equal(ctx.input.value, 'Alpha renamed');
        fire(ctx.input, 'focus');
        assert.equal(ctx.field.querySelectorAll('.nd-picker-option').length, 2);

        ctx.updateItems([]);
        await flush();
        assert.equal(ctx.field.querySelectorAll('.nd-picker-option').length, 0);
        assert.ok(ctx.field.querySelector('.nd-empty-lab'));
    });

    it('omits the removed paste prompt button without hiding the artist picker', async () => {
        const ctx = setup();
        await flush();
        assert.equal(button(ctx.root, '粘贴提示词'), undefined);
        assert.ok(ctx.field.querySelector('.nd-picker'));
        assert.equal(ctx.input.value, 'Alpha');
    });

    it('supports an empty artist library and rejects unsafe cover URLs', async () => {
        const empty = setup({ items: [] });
        const unsafe = setup({ coverUrl: 'javascript:alert(1)' });
        await flush();
        assert.equal(empty.input.value, '');
        fire(empty.input, 'focus');
        assert.ok(empty.field.querySelector('.nd-empty-lab'));
        assert.equal(unsafe.field.querySelector('img'), null);
    });

    it('keeps the existing status next to write/cancel buttons while requests run', async () => {
        let finishWrite;
        let finishGenerate;
        const ctx = setup({
            service: {
                writePrompt: () => new Promise((resolve) => { finishWrite = resolve; }),
                generateImage: () => new Promise((resolve) => { finishGenerate = resolve; }),
            },
        });
        const status = ctx.root.querySelector('.nd-status-pill');
        const write = button(ctx.root, '写提示词');
        assert.equal(status.parentNode, write.parentNode);
        assert.equal(status.parentNode, button(ctx.root, '取消').parentNode);
        assert.equal(ctx.root.querySelector('.nd-wb-header'), null);
        assert.equal(ctx.root.querySelectorAll('.nd-status-pill').length, 1);
        assert.equal(status.querySelector('span').textContent, '空闲');

        fire(write, 'click');
        await flush();
        assert.equal(status.querySelector('span').textContent, '正在写提示词…');
        finishWrite({ ok: true, value: { caption: emptyNaiCaption(), unmatchedKeys: [] } });
        await flush();
        assert.equal(status.querySelector('span').textContent, '空闲');

        fire(button(ctx.root, '出图'), 'click');
        await flush();
        assert.equal(status.querySelector('span').textContent, '正在出图…');
        finishGenerate({ ok: true, value: [] });
        await flush();
        assert.equal(status.querySelector('span').textContent, '空闲');
    });

    it('keeps replace-preview beside generate and writes that image onto the selected artist', async () => {
        const blob = new Blob(['png-bytes'], { type: 'image/png' });
        /** @type {object[]} */
        const replaced = [];
        const ctx = setup({
            items: [{
                id: 'a1',
                name: 'Alpha',
                positivePrompt: 'keep positive',
                negativePrompt: 'keep negative',
                cardImageRef: 'old-card',
            }],
            service: {
                async writePrompt() {
                    return { ok: true, value: { caption: emptyNaiCaption(), unmatchedKeys: [] } };
                },
                async generateImage() {
                    return { ok: true, value: [{ blob, mimeType: 'image/png' }] };
                },
            },
            artistDraftService: {
                async replacePreview(input) {
                    replaced.push(input);
                    return {
                        ok: true,
                        value: {
                            id: input.artistId,
                            name: 'Alpha',
                            positivePrompt: 'keep positive',
                            negativePrompt: 'keep negative',
                        },
                    };
                },
            },
        });
        await flush();
        const genRow = ctx.root.querySelector('.nd-wb-actions--generate');
        const replaceBtn = button(genRow, '替换画师串预览');
        assert.ok(replaceBtn);
        assert.equal(button(ctx.root.querySelector('.nd-wb-artist-actions'), '替换画师串预览'), undefined);
        const labels = [...genRow.querySelectorAll('button')].map((node) => node.textContent);
        assert.deepEqual(labels.slice(0, 2), ['出图', '替换画师串预览']);

        fire(button(ctx.root, '出图'), 'click');
        await flush();
        fire(replaceBtn, 'click');
        await flush();
        assert.equal(replaced.length, 1);
        assert.equal(replaced[0].artistId, 'a1');
        assert.equal(replaced[0].coverBlob, blob);
    });

    it('unsubscribes the picker on destroy, including repeated destroy calls', async () => {
        const before = document._docListeners.length;
        const ctx = setup();
        await flush();
        assert.deepEqual(ctx.subscriptions(), { settings: 1, repository: 1 });
        ctx.handle.destroy();
        ctx.handle.destroy();
        assert.deepEqual(ctx.subscriptions(), { settings: 0, repository: 0 });
        assert.equal(document._docListeners.length, before);
        assert.equal(ctx.root.childNodes.length, 0);
        ctx.store.set('activeArtistId', 'a2');
        ctx.updateItems([]);
        await flush();
        assert.equal(ctx.root.childNodes.length, 0);
    });

    it('falls back to settings polling and clears its timer on destroy', async (t) => {
        let tick;
        let cleared = false;
        const token = {};
        t.mock.method(globalThis, 'setInterval', (fn, ms) => {
            assert.equal(ms, 400);
            tick = fn;
            return token;
        });
        t.mock.method(globalThis, 'clearInterval', (timer) => {
            assert.equal(timer, token);
            cleared = true;
        });
        const ctx = setup({ subscribe: false });
        await flush();
        ctx.store.set('activeArtistId', 'a2');
        tick();
        await flush();
        assert.equal(ctx.input.value, 'Beta');
        ctx.handle.destroy();
        assert.equal(cleared, true);
    });
});
