import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cssPath = join(__dirname, '../../src/ui/common/components.css');
const css = readFileSync(cssPath, 'utf8');

/** @param {string} prop */
function importantProps(prop) {
    const re = new RegExp(`${prop}\\s*:[^;{]+!important`, 'gi');
    return [...css.matchAll(re)].map((m) => m[0]);
}

describe('D61 components.css harden coverage', () => {
    it('scopes catch-all native controls under :is(#nai-dbgen-root, .nd-root)', () => {
        assert.match(
            css,
            /:is\(#nai-dbgen-root,\s*\.nd-root\)\s+button[\s\S]*?:is\(#nai-dbgen-root,\s*\.nd-root\)\s+input[\s\S]*?:is\(#nai-dbgen-root,\s*\.nd-root\)\s+select[\s\S]*?:is\(#nai-dbgen-root,\s*\.nd-root\)\s+textarea/,
        );
    });

    it('hardens createToggle track and knob via .nd-toggle-row i and i::after', () => {
        assert.match(css, /\.nd-toggle-row\s+i\s*\{[^}]*box-sizing:\s*border-box\s*!important/s);
        assert.match(css, /\.nd-toggle-row\s+i\s*\{[^}]*width:\s*var\(--nd-toggle-w\)\s*!important/s);
        assert.match(css, /\.nd-toggle-row\s+i\s*\{[^}]*height:\s*var\(--nd-toggle-h\)\s*!important/s);
        assert.match(css, /\.nd-toggle-row\s+i::after\s*\{[^}]*box-sizing:\s*border-box\s*!important/s);
        assert.match(css, /\.nd-toggle-row\s+i::after\s*\{[^}]*width:\s*var\(--nd-toggle-knob-size\)\s*!important/s);
        assert.match(css, /\.nd-toggle-row\s+i::after\s*\{[^}]*height:\s*var\(--nd-toggle-knob-size\)\s*!important/s);
    });

    it('hardens createToggle bare input via .nd-toggle-row input', () => {
        assert.match(css, /\.nd-toggle-row\s+input\s*\{[^}]*appearance:\s*none\s*!important/s);
        assert.match(css, /\.nd-toggle-row\s+input\s*\{[^}]*width:\s*var\(--nd-toggle-w\)\s*!important/s);
        assert.match(css, /\.nd-toggle-row\s+input\s*\{[^}]*height:\s*var\(--nd-toggle-h\)\s*!important/s);
        assert.match(css, /\.nd-toggle-row\s+input\s*\{[^}]*padding:\s*0\s*!important/s);
        assert.match(css, /\.nd-toggle-row\s+input\s*\{[^}]*background:\s*transparent\s*!important/s);
        assert.match(css, /\.nd-toggle-row\s+input\s*\{[^}]*border:\s*0\s*!important/s);
    });

    it('hardens createCheckbox bare input via .nd-checkbox-row input', () => {
        assert.match(css, /\.nd-checkbox-row\s+input\s*\{[^}]*appearance:\s*none\s*!important/s);
        assert.match(css, /\.nd-checkbox-row\s+input\s*\{[^}]*width:\s*16px\s*!important/s);
        assert.match(css, /\.nd-checkbox-row\s+input\s*\{[^}]*height:\s*16px\s*!important/s);
        assert.match(css, /\.nd-checkbox-row\s+input\s*\{[^}]*padding:\s*0\s*!important/s);
        assert.match(css, /\.nd-checkbox-row\s+input\s*\{[^}]*border-radius:\s*var\(--nd-radius-xs\)\s*!important/s);
        assert.match(css, /\.nd-checkbox-row\s+input\s*\{[^}]*background:[^;]+!important/s);
    });

    it('hardens bare search inputs in picker and library toolbar', () => {
        assert.match(css, /\.nd-picker__control\s+input\s*\{[^}]*background:\s*transparent\s*!important/s);
        assert.match(css, /\.nd-picker__control\s+input\s*\{[^}]*padding:\s*0\s*!important/s);
        assert.match(css, /\.nd-search-field\s+input\s*\{[^}]*background:\s*transparent\s*!important/s);
        assert.match(css, /\.nd-search-field\s+input\s*\{[^}]*border:\s*0\s*!important/s);
    });

    it('hardens import-table bare checkboxes', () => {
        assert.match(css, /\.nd-table-scroll\s+input\[type="checkbox"\]/);
        assert.match(css, /\.nd-import\s+input\[type="checkbox"\]/);
        assert.match(
            css,
            /\.nd-table-scroll\s+input\[type="checkbox"\][\s\S]*?height:\s*16px\s*!important/,
        );
    });

    it('hardens classed controls used by factories', () => {
        for (const sel of [
            '.nd-button',
            '.nd-input',
            '.nd-select',
            '.nd-textarea',
            '.nd-range',
            '.nd-chip',
            '.nd-picker__clear',
            '.nd-picker-option',
            '.nd-nested-list__expand',
            '.nd-native-dialog__close',
            '.nd-style-card__cover',
        ]) {
            assert.match(css, new RegExp(sel.replace(/\./g, '\\.')), `missing ${sel}`);
            assert.match(
                css,
                new RegExp(`${sel.replace(/\./g, '\\.')}[^{]*\\{[^}]*(?:background|color|border|font-size|padding|height|border-radius)\\s*:[^;]*!important`, 's'),
                `${sel} should use !important on a key visual/box prop`,
            );
        }
    });

    it('nd-button / nd-input / nd-range use D61 box-model !important', () => {
        assert.match(css, /\.nd-button\s*\{[^}]*padding:\s*0 14px\s*!important/s);
        assert.match(css, /\.nd-button\s*\{[^}]*border-radius:\s*var\(--nd-radius-sm\)\s*!important/s);
        assert.match(css, /\.nd-button\s*\{[^}]*height:\s*var\(--nd-h\)\s*!important/s);
        assert.match(css, /\.nd-input[\s\S]*?height:\s*var\(--nd-h-primary\)\s*!important/);
        assert.match(css, /\.nd-input[\s\S]*?padding:\s*0 12px\s*!important/);
        assert.match(css, /\.nd-range\s*\{[^}]*height:\s*5px\s*!important/s);
        assert.match(css, /\.nd-range\s*\{[^}]*padding:\s*0\s*!important/s);
        assert.match(css, /\.nd-textarea\s*\{[^}]*height:\s*auto\s*;/s);
        assert.doesNotMatch(css, /\.nd-textarea\s*\{[^}]*height:\s*auto\s*!important/s,
            'native vertical resizing must override the initial height');
        assert.match(css, /\.nd-textarea\s*\{[^}]*min-height:\s*88px\s*!important/s);
        assert.match(css, /\.nd-textarea\s*\{[^}]*resize:\s*vertical/s);
    });

    it('!important only on D61-allowed properties', () => {
        const allowed = new Set([
            'appearance',
            '-webkit-appearance',
            '-moz-appearance',
            'box-sizing',
            'font-family',
            'font-size',
            'line-height',
            'color',
            'background',
            'border',
            'border-color',
            'border-bottom',
            'border-radius',
            'padding',
            'width',
            'height',
            'min-height',
            // 滚动条滑块最小尺寸（压过酒馆全局 ::-webkit-scrollbar）
            'min-width',
            'position',
            'inset',
            'max-width',
            'max-height',
            'margin',
            // D70：压过酒馆 popup.css 的阴影与 overflow:visible，才能单层圆角裁切
            'box-shadow',
            'overflow',
        ]);
        const all = [...css.matchAll(/([a-zA-Z-]+)\s*:\s*[^;{}]+!important/g)];
        assert.ok(all.length > 20, 'expected many !important declarations');
        for (const m of all) {
            const prop = m[1].toLowerCase();
            assert.ok(
                allowed.has(prop),
                `disallowed !important property: ${prop} in "${m[0].slice(0, 80)}"`,
            );
        }
    });

    it('does not put !important on host selectors', () => {
        assert.doesNotMatch(css, /(?:^|})\s*:root[^{]*\{[^}]*!important/s);
        assert.doesNotMatch(css, /(?:^|})\s*body[^{]*\{[^}]*!important/s);
        assert.doesNotMatch(css, /(?:^|})\s*html[^{]*\{[^}]*!important/s);
        assert.doesNotMatch(css, /(?:^|})\s*\.mes[^{]*\{[^}]*!important/s);
        assert.doesNotMatch(css, /(?:^|})\s*\.mes_text[^{]*\{[^}]*!important/s);
        assert.doesNotMatch(css, /(?:^|})\s*#chat[^{]*\{[^}]*!important/s);
    });

    it('documents allowed important props via helper scan', () => {
        assert.ok(importantProps('appearance').length >= 1);
        assert.ok(importantProps('box-sizing').length >= 1);
        assert.ok(importantProps('background').length >= 1);
        assert.ok(importantProps('width').length >= 1);
        assert.ok(importantProps('padding').length >= 1);
        assert.ok(importantProps('height').length >= 1);
        assert.ok(importantProps('border-radius').length >= 1);
        assert.ok(importantProps('line-height').length >= 1);
    });
});
