import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom } from './fake-dom.js';
import { createArtist } from '../../src/domain/model/artist.js';
import { mountArtistPanel } from '../../src/ui/panels/artist/artist-panel.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

function fire(node, type) {
    for (const listener of node._listeners.filter((item) => item.type === type)) {
        listener.fn({ target: node, preventDefault() {}, stopPropagation() {} });
    }
}

function buttonByText(root, label) {
    return [...root.querySelectorAll('button')].find((node) => node.textContent === label);
}

function checkboxes(root) {
    return [...root.querySelectorAll('input')].filter((node) => node.type === 'checkbox');
}

/**
 * @param {object[]} seed
 */
function harness(seed) {
    /** @type {object[]} */
    const artists = seed.map((item) => ({ ...item }));
    /** @type {object[]} */
    const puts = [];
    /** @type {string[]} */
    const removed = [];
    /** @type {string[]} */
    const toasts = [];
    const repo = {
        async list() {
            return { ok: true, value: artists.map((item) => ({ ...item })) };
        },
        async put(entity) {
            const next = { ...entity };
            const index = artists.findIndex((item) => item.id === entity.id);
            if (index >= 0) artists[index] = { ...artists[index], ...next };
            else artists.push(next);
            puts.push(next);
            return { ok: true, value: next };
        },
        async remove(id) {
            const index = artists.findIndex((item) => item.id === id);
            if (index >= 0) artists.splice(index, 1);
            removed.push(String(id));
            return { ok: true, value: true };
        },
    };
    const root = document.createElement('div');
    root.className = 'nd-root';
    document.body.appendChild(root);
    const panel = mountArtistPanel(root, {
        repos: { artist: repo },
        artistFileUrl: { urlOf: async () => null },
        host: { toast: (_level, message) => { toasts.push(String(message)); } },
        loadSettings: () => ({ activeArtistId: null }),
        nowIso: () => '2026-10-07T00:00:00.000Z',
    });
    return { root, panel, artists, puts, removed, toasts };
}

/**
 * @param {object} partial
 */
function artist(partial) {
    return createArtist({
        name: partial.name,
        sequence: partial.sequence ?? 0,
        positivePrompt: partial.positivePrompt ?? 'pos',
        negativePrompt: partial.negativePrompt ?? 'neg',
        modelTag: partial.modelTag,
    }, { id: partial.id, now: '2026-01-01T00:00:00.000Z' });
}

describe('artist library batch version switch and delete', () => {
    let fake;

    beforeEach(() => {
        fake = installFakeDom();
    });

    afterEach(() => {
        fake.restore();
    });

    it('switches the checked artist string to v4.5 without rewriting its text', async () => {
        const { root, panel, puts, toasts } = harness([
            artist({ id: 'a', name: '甲', sequence: 0, modelTag: 'v5', positivePrompt: 'keep-me' }),
        ]);
        await flush();

        const boxes = checkboxes(root);
        assert.equal(boxes.length, 1);
        assert.equal(buttonByText(root, '改为 v4.5').disabled, true);
        assert.equal(buttonByText(root, '删除所选').disabled, true);

        boxes[0].checked = true;
        fire(boxes[0], 'change');
        assert.equal(root.querySelector('.nd-artist-bulk__count').textContent, '已选 1');
        assert.equal(buttonByText(root, '改为 v4.5').disabled, false);

        fire(buttonByText(root, '改为 v4.5'), 'click');
        fire(buttonByText(document.body, '确认切换'), 'click');
        await flush();

        assert.equal(puts.length, 1);
        assert.equal(puts[0].modelTag, 'v4.5');
        assert.equal(puts[0].name, '甲');
        assert.equal(puts[0].positivePrompt, 'keep-me');
        assert.equal(puts[0].negativePrompt, 'neg');
        assert.equal(toasts.at(-1), '已把 1 条改为 v4.5');
        panel.destroy();
    });

    it('skips a name that already has the target version', async () => {
        const { root, panel, puts, toasts } = harness([
            artist({ id: 'a', name: '同名', sequence: 0, modelTag: 'v4.5' }),
            artist({ id: 'b', name: '同名', sequence: 1, modelTag: 'v5' }),
        ]);
        await flush();

        const boxes = checkboxes(root);
        boxes[0].checked = true;
        fire(boxes[0], 'change');
        fire(buttonByText(root, '改为 v5'), 'click');
        fire(buttonByText(document.body, '确认切换'), 'click');
        await flush();

        assert.equal(puts.length, 0);
        assert.match(toasts.at(-1), /跳过 1 条同名：同名/);
        panel.destroy();
    });

    it('deletes every checked artist string', async () => {
        const { root, panel, removed } = harness([
            artist({ id: 'a', name: '甲', sequence: 0, modelTag: 'v5' }),
            artist({ id: 'b', name: '乙', sequence: 1, modelTag: 'v4.5' }),
        ]);
        await flush();

        fire(buttonByText(root, '全选'), 'click');
        assert.equal(root.querySelector('.nd-artist-bulk__count').textContent, '已选 2');
        fire(buttonByText(root, '删除所选'), 'click');
        fire(buttonByText(document.body, '确认删除'), 'click');
        await flush();

        assert.deepEqual(removed, ['a', 'b']);
        assert.equal(buttonByText(root, '删除所选').disabled, true);
        panel.destroy();
    });
});
