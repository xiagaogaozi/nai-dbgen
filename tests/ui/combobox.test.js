/**
 * createCombobox：过滤、键盘、手输、fixed 列表挂到 .nd-root。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom } from './fake-dom.js';
import { createCombobox } from '../../src/ui/common/controls.js';

/**
 * @param {any} el
 * @param {string} type
 * @param {Record<string, unknown>} [props]
 */
function fire(el, type, props = {}) {
    const ev = {
        type,
        preventDefault() {},
        stopPropagation() {},
        target: el,
        ...props,
    };
    for (const l of el._listeners || []) {
        if (l.type === type) l.fn(ev);
    }
}

/**
 * @param {any} node
 * @param {string} className
 * @returns {any[]}
 */
function findByClass(node, className) {
    /** @type {any[]} */
    const out = [];
    (function walk(n) {
        for (const c of n.childNodes || []) {
            if (c.classList?.contains(className)) out.push(c);
            walk(c);
        }
    })(node);
    return out;
}

describe('createCombobox', () => {
    /** @type {ReturnType<typeof installFakeDom>|null} */
    let fake = null;
    /** @type {any} */
    let prevWindow = undefined;

    beforeEach(() => {
        fake = installFakeDom();
        prevWindow = globalThis.window;
        globalThis.window = {
            innerHeight: 800,
            addEventListener() {},
            removeEventListener() {},
        };
        const sample = document.createElement('div');
        const proto = Object.getPrototypeOf(sample);
        proto.getBoundingClientRect = function getBoundingClientRect() {
            return { top: 100, bottom: 132, left: 40, right: 340, width: 300, height: 32 };
        };
        proto.focus = function focus() {};
        proto.scrollIntoView = function scrollIntoView() {};
    });

    afterEach(() => {
        fake?.restore();
        fake = null;
        if (prevWindow === undefined) delete globalThis.window;
        else globalThis.window = prevWindow;
    });

    it('输入过滤、键盘上下回车、Esc 收起、手输有效；列表挂 .nd-root 不被裁切', async () => {
        const host = document.createElement('div');
        host.className = 'nd-root';
        document.body.appendChild(host);

        const models = Array.from({ length: 120 }, (_, i) => `model-${String(i).padStart(3, '0')}`);
        const combo = createCombobox({
            label: '模型',
            value: '',
            options: models,
            placeholder: '筛选',
        });
        host.appendChild(combo.el);

        const input = combo.el.querySelector('input');
        assert.ok(input);

        fire(input, 'focus');
        const lists = findByClass(host, 'nd-combobox__list');
        assert.equal(lists.length, 1);
        const listEl = lists[0];
        assert.equal(listEl.hidden, false);
        assert.equal(listEl.parentNode, host);

        input.value = 'model-11';
        fire(input, 'input');
        await new Promise((r) => setTimeout(r, 320));
        const opts = listEl.querySelectorAll('.nd-combobox__option');
        assert.ok(opts.length >= 1);
        assert.ok(opts.every((n) => String(n.textContent).includes('model-11')));

        fire(input, 'keydown', { key: 'ArrowDown' });
        fire(input, 'keydown', { key: 'Enter' });
        assert.ok(combo.getValue().startsWith('model-11'));

        combo.setValue('hand-typed-model');
        assert.equal(combo.getValue(), 'hand-typed-model');

        combo.open();
        assert.equal(listEl.hidden, false);
        fire(input, 'keydown', { key: 'Escape' });
        assert.equal(listEl.hidden, true);

        combo.setValue('');
        combo.setOptions(models.map((id) => ({ value: id, label: id })));
        combo.open();
        assert.ok(listEl.querySelectorAll('.nd-combobox__option').length > 0);

        combo.destroy();
        assert.equal(listEl.parentNode, null);
    });
});
