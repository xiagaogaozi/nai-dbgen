import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { installFakeDom } from './fake-dom.js';
import { paintSafeCover } from '../../src/ui/common/safe-url.js';
import { createStyleCard } from '../../src/ui/common/library-chrome.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(__dirname, '../../src/ui/common/components.css'), 'utf8');
const tokens = readFileSync(join(__dirname, '../../src/ui/common/tokens.css'), 'utf8');
const panelsCss = readFileSync(join(__dirname, '../../src/ui/panels/panels.css'), 'utf8');

/**
 * @param {object} root
 * @param {string} className
 * @returns {object|null}
 */
function findByClass(root, className) {
    if (!root) return null;
    if (String(root.className || '').split(/\s+/).includes(className)) return root;
    for (const child of root.childNodes || []) {
        const hit = findByClass(child, className);
        if (hit) return hit;
    }
    return null;
}

describe('D68 library layout (artist card + radius tokens)', () => {
    it('grid / card / cover / actions use card tokens and 832/1216', () => {
        assert.match(
            css,
            /\.nd-style-grid\s*\{[^}]*minmax\(150px,\s*1fr\)/s,
        );
        assert.doesNotMatch(css, /\.nd-style-grid\s*\{[^}]*justify-content:\s*start/s);
        assert.match(css, /\.nd-style-grid\s*\{[^}]*align-items:\s*stretch/s);
        assert.match(css, /\.nd-style-grid--text\s*\{[^}]*align-items:\s*stretch/s);
        assert.match(css, /\.nd-style-card\s*\{[^}]*align-self:\s*stretch/s);
        assert.match(css, /\.nd-style-card__actions\s*\{[^}]*margin-top:\s*auto/s);
        assert.match(css, /\.nd-style-grid\s*\{[^}]*gap:\s*16px/s);
        assert.match(css, /\.nd-style-card\s*\{[^}]*min-height:\s*0/s);
        assert.match(tokens, /--nd-radius-lg:\s*16px/);
        assert.match(tokens, /--nd-radius-md:\s*12px/);
        assert.match(css, /\.nd-style-card\s*\{[^}]*border-radius:\s*var\(--nd-radius-md\)/s);
        assert.match(css, /\.nd-style-card__cover\s*\{[^}]*aspect-ratio:\s*832\s*\/\s*1216/s);
        assert.match(css, /\.nd-style-card__cover\s+img\s*\{[^}]*object-fit:\s*cover/s);
        assert.match(css, /\.nd-style-card__cover\s*\{[^}]*min-height:\s*0\s*!important/s);
        assert.match(
            css,
            /\.nd-cover-monogram\s*\{[^}]*color:\s*var\(--nd-mark\)/s,
        );
        assert.match(css, /\.nd-cover-monogram\s*\{[^}]*font:\s*italic\s+var\(--nd-cover-mono-size\)/s);
        assert.match(tokens, /--nd-cover-mono-size:\s*84px/);
        assert.match(
            css,
            /\.nd-library-toolbar\s*\{[^}]*display:\s*flex/s,
        );
        assert.match(css, /\.nd-library-toolbar\s*\{[^}]*background:\s*transparent/s);
        assert.match(css, /\.nd-library-toolbar\s*\{[^}]*border:\s*0/s);
        assert.match(css, /\.nd-library-toolbar\s*\{[^}]*border-radius:\s*0/s);
        assert.match(css, /\.nd-library-toolbar\s*\{[^}]*box-shadow:\s*none/s);
        assert.match(css, /\.nd-library-toolbar__actions\s*\{[^}]*flex:\s*0\s+0\s+auto/s);
        assert.match(css, /dialog\.nd-popup\.nd-root\s*,\s*dialog\.nd-native-dialog\.nd-root\s*\{[^}]*width:\s*min\(\s*900px\s*,\s*94vw\s*\)/s);
        assert.match(css, /dialog\.nd-popup\.nd-root\s*,\s*dialog\.nd-native-dialog\.nd-root\s*\{[^}]*border-radius:\s*var\(--nd-radius-lg\)\s*!important/s);
        assert.match(css, /\.nd-native-dialog__shell\s*\{[^}]*background:\s*transparent/s);
        assert.match(css, /\.nd-native-dialog__shell\s*\{[^}]*border-radius:\s*0/s);
        assert.match(css, /\.nd-native-dialog__card\s*\{[^}]*border-radius:\s*0/s);
        assert.match(css, /\.nd-style-card__subtitle\s*\{[^}]*color:\s*var\(--nd-muted\)/s);
        assert.match(css, /\.nd-style-card__body\s*\{[^}]*padding:\s*10px\s+12px/s);
        assert.match(
            css,
            /\.nd-style-card__title\s*\{[^}]*font-size:\s*var\(--nd-fs-md\)/s,
        );
        assert.match(
            css,
            /\.nd-style-card__title\s*\{[^}]*font-weight:\s*500/s,
        );
        assert.match(css, /\.nd-style-card__actions\s*\{[^}]*padding:\s*0\s+12px\s+12px/s);
        assert.match(
            css,
            /\.nd-mini-action\s*\{[^}]*height:\s*28px\s*!important/s,
        );
        assert.match(
            css,
            /\.nd-style-card__actions\s+\.nd-mini-action\s*\{[^}]*width:\s*100%\s*!important/s,
        );
        assert.match(css, /\.nd-mini-action--danger\s*\{[^}]*color:\s*#aa455f/s);
        assert.doesNotMatch(css, /\.nd-style-card__action--danger\b/);
        assert.doesNotMatch(css, /\.nd-style-card__actions\s+\.nd-button\s*\{/);
        assert.doesNotMatch(css, /\.nd-style-card__type\b/);
        assert.doesNotMatch(css, /aspect-ratio:\s*4\s*\/\s*3/);
        assert.doesNotMatch(css, /border-radius:\s*28px\s+28px\s+10px\s+28px/);
        assert.match(
            css,
            /@container\s+nd-root\s*\(\s*max-width:\s*540px\s*\)[\s\S]*?\.nd-style-grid\s*\{[^}]*repeat\(\s*2\s*,/s,
        );
        assert.match(
            css,
            /@container\s+nd-root\s*\(\s*max-width:\s*420px\s*\)[\s\S]*?\.nd-style-grid\s*\{[^}]*repeat\(\s*2\s*,/s,
        );
    });

    it('search-field / detail-cover / picker thumb / artist preview ratios', () => {
        assert.match(css, /\.nd-search-field\s*\{[^}]*border-radius:\s*var\(--nd-radius-sm\)/s);
        assert.match(css, /\.nd-detail-cover\s*\{[^}]*border-radius:\s*var\(--nd-radius-md\)/s);
        assert.match(css, /\.nd-mini-cover\s*\{[^}]*width:\s*48px/s);
        assert.match(css, /\.nd-mini-cover\s*\{[^}]*height:\s*60px/s);
        assert.match(css, /\.nd-picker__cover\s*\{[^}]*width:\s*40px/s);
        assert.match(css, /\.nd-picker__cover\s*\{[^}]*height:\s*40px/s);
        assert.match(panelsCss, /\.nd-artist-preview-cover\s*\{[^}]*aspect-ratio:\s*832\s*\/\s*1216/s);
        assert.match(panelsCss, /\.nd-artist-preview-cover\s*\{[^}]*border-radius:\s*var\(--nd-radius-md\)/s);
        assert.match(panelsCss, /\.nd-artist-preview-cover\s+img\s*\{[^}]*object-fit:\s*cover/s);
    });

    it('createStyleCard puts subtitle under title; cover only when url present', () => {
        const fake = installFakeDom();
        try {
            const card = createStyleCard({
                title: '示例角色',
                subtitle: '角色 · 默认',
                cover: true,
                coverUrl: 'https://cdn.example/c.webp',
                actions: [
                    { label: '编辑', action: 'edit' },
                    { label: '删除', action: 'delete', variant: 'danger' },
                ],
            });
            const root = card.el;
            assert.equal(root.className, 'nd-style-card');
            const cover = findByClass(root, 'nd-style-card__cover');
            const body = findByClass(root, 'nd-style-card__body');
            const actions = findByClass(root, 'nd-style-card__actions');
            assert.ok(cover);
            assert.ok(body);
            assert.ok(actions);
            assert.equal(findByClass(cover, 'nd-style-card__subtitle'), null);
            const subtitle = findByClass(body, 'nd-style-card__subtitle');
            assert.ok(subtitle);
            assert.equal(subtitle.textContent, '角色 · 默认');
            card.setSubtitle('更新后的副标题');
            assert.equal(subtitle.textContent, '更新后的副标题');
            assert.equal(actions.style.gridTemplateColumns, 'repeat(2, minmax(0, 1fr))');
            const actionBtns = (actions.childNodes || []).filter(
                (n) => n && String(n.className || '').includes('nd-button'),
            );
            assert.equal(actionBtns.length, 2);
            for (const btn of actionBtns) {
                assert.ok(String(btn.className).includes('nd-mini-action'));
                assert.ok(!String(btn.className).includes('nd-button--danger'));
            }
            assert.ok(String(actionBtns[1].className).includes('nd-mini-action--danger'));
            card.destroy();
        } finally {
            fake.restore();
        }
    });

    it('createStyleCard cover:false omits cover DOM (text-only card)', () => {
        const fake = installFakeDom();
        try {
            const card = createStyleCard({
                title: '召回预设 A',
                subtitle: '召回预设 · 3 段',
                cover: false,
                actions: [
                    { label: '编辑', action: 'edit' },
                    { label: '删除', action: 'delete', variant: 'danger' },
                ],
            });
            const root = card.el;
            assert.ok(String(root.className).includes('nd-style-card--no-cover'));
            assert.equal(findByClass(root, 'nd-style-card__cover'), null);
            assert.equal(findByClass(root, 'nd-cover-monogram'), null);
            const body = findByClass(root, 'nd-style-card__body');
            assert.ok(body);
            assert.equal(findByClass(body, 'nd-style-card__subtitle')?.textContent, '召回预设 · 3 段');
            card.setCover('https://cdn.example/x.png', 'x');
            assert.equal(findByClass(root, 'nd-style-card__cover'), null);
            card.destroy();
        } finally {
            fake.restore();
        }
    });

    it('paintSafeCover uses lazy img or empty mark span', () => {
        const fake = installFakeDom();
        try {
            const el = document.createElement('button');
            paintSafeCover(el, null, '内容');
            assert.equal(el.childNodes.length, 1);
            assert.equal(el.childNodes[0].className, 'nd-cover-empty-mark');
            paintSafeCover(el, 'https://cdn.example/a.png', 'A');
            const img = el.childNodes[0];
            assert.equal(String(img.tagName).toUpperCase(), 'IMG');
            assert.equal(img.loading, 'lazy');
            assert.equal(img.decoding, 'async');
        } finally {
            fake.restore();
        }
    });
});
