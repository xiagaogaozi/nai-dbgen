import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom } from './fake-dom.js';
import { mountCurrentPicker } from '../../src/ui/common/current-picker.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

function fire(node, type) {
    for (const listener of node._listeners.filter((item) => item.type === type)) {
        listener.fn({ target: node, preventDefault() {} });
    }
}

function buttonByText(root, label) {
    return [...root.querySelectorAll('button')].find((node) => node.textContent === label);
}

describe('artist model tag filter on the picker', () => {
    let fake;

    beforeEach(() => {
        fake = installFakeDom();
    });

    afterEach(() => {
        fake.restore();
    });

    it('filters v4.5 and v5 artist strings, treating missing tags as v5', async () => {
        const root = document.createElement('div');
        document.body.appendChild(root);
        const api = mountCurrentPicker(root, {
            modelTagFilter: true,
            cover: true,
            list: async () => [
                { id: 'old', name: '旧串' },
                { id: 'v45', name: '同名', modelTag: 'v4.5' },
                { id: 'v5', name: '同名', modelTag: 'v5' },
            ],
            getActiveId: () => null,
            setActiveId: () => {},
        });
        await api.refresh();
        await flush();

        const input = root.querySelector('input');
        fire(input, 'focus');

        const names = () => [...root.querySelectorAll('.nd-picker-option')].map((node) => node.querySelector('strong').textContent);
        assert.deepEqual(names(), ['旧串', '同名', '同名']);
        assert.equal(root.querySelector('.nd-picker-option').querySelector('small').textContent, 'v5');

        fire(buttonByText(root, 'v4.5'), 'click');
        assert.deepEqual(names(), ['同名']);
        assert.equal(root.querySelector('.nd-picker-option').querySelector('small').textContent, 'v4.5');

        fire(buttonByText(root, 'v5'), 'click');
        assert.deepEqual(names(), ['旧串', '同名']);

        fire(buttonByText(root, '全部'), 'click');
        assert.deepEqual(names(), ['旧串', '同名', '同名']);

        api.destroy();
    });
});
