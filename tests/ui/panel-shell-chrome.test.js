import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { installFakeDom } from './fake-dom.js';
import { openModal, applyNdPopupChrome } from '../../src/ui/common/modal.js';
import { createStyleCard, createLibraryToolbar } from '../../src/ui/common/library-chrome.js';
import { t } from '../../src/ui/i18n/zh-CN.js';

const here = dirname(fileURLToPath(import.meta.url));
const tokensCss = readFileSync(join(here, '../../src/ui/common/tokens.css'), 'utf8');
const componentsCss = readFileSync(join(here, '../../src/ui/common/components.css'), 'utf8');
const panelsCss = readFileSync(join(here, '../../src/ui/panels/panels.css'), 'utf8');

/**
 * @param {object|null|undefined} root
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

describe('management shell chrome (padding / header close / toolbar / empty cover)', () => {
    /** @type {ReturnType<typeof installFakeDom>|null} */
    let fake = null;

    beforeEach(() => {
        fake = installFakeDom();
    });

    afterEach(() => {
        fake?.restore();
        fake = null;
    });

    it('tokens define --nd-space-panel and --nd-space-stack', () => {
        assert.match(tokensCss, /--nd-space-panel:\s*20px/);
        assert.match(tokensCss, /--nd-space-stack:\s*12px/);
        assert.match(componentsCss, /\.nd-modal-root\s*\{[^}]*padding:\s*var\(--nd-space-panel\)/s);
        assert.match(panelsCss, /\.nd-shell\s*\{[^}]*gap:\s*var\(--nd-space-stack\)/s);
        assert.match(panelsCss, /\.nd-library-view\s*\{[^}]*gap:\s*var\(--nd-space-stack\)/s);
    });

    it('modal title uses inherit sans + --nd-fs-title / 600 (not serif display)', () => {
        assert.match(
            componentsCss,
            /\.nd-modal-title\s*\{[^}]*font-family:\s*inherit\s*!important/s,
        );
        assert.match(
            componentsCss,
            /\.nd-modal-title\s*\{[^}]*font-size:\s*var\(--nd-fs-title\)\s*!important/s,
        );
        assert.match(
            componentsCss,
            /\.nd-modal-title\s*\{[^}]*font-weight:\s*600/s,
        );
        assert.doesNotMatch(
            componentsCss,
            /\.nd-modal-title\s*\{[^}]*font-family:\s*var\(--nd-serif\)/s,
        );
    });

    it('× lives in .nd-popup-header row (not a dialog flex column sibling)', async () => {
        const body = document.createElement('div');
        body.textContent = 'panel';
        const handle = await openModal({ host: null }, { title: '酒馆数据库生图', element: body });
        const dlg = body.closest('dialog');
        assert.ok(dlg);
        const header = findByClass(dlg, 'nd-popup-header');
        const closeBtn = findByClass(dlg, 'nd-native-dialog__close');
        const title = findByClass(dlg, 'nd-modal-title');
        assert.ok(header);
        assert.ok(closeBtn);
        assert.ok(title);
        assert.equal(closeBtn.parentNode, header);
        assert.equal(title.parentNode, header);
        assert.equal(title.textContent, '酒馆数据库生图');
        // × 不是 dialog 的直接子节点（避免占整列）
        assert.notEqual(closeBtn.parentNode, dlg);
        handle.destroy();
    });

    it('host popup path also mounts × into existing .nd-popup-header', () => {
        const dlg = document.createElement('dialog');
        dlg.className = 'popup';
        const body = document.createElement('div');
        body.className = 'popup-body';
        const content = document.createElement('div');
        content.className = 'popup-content';
        const wrap = document.createElement('div');
        wrap.className = 'nd-root nd-modal-root';
        const header = document.createElement('div');
        header.className = 'nd-popup-header';
        const title = document.createElement('h3');
        title.className = 'nd-modal-title';
        title.textContent = '酒馆数据库生图';
        header.appendChild(title);
        wrap.appendChild(header);
        content.appendChild(wrap);
        body.appendChild(content);
        const stClose = document.createElement('div');
        stClose.className = 'popup-button-close';
        stClose.textContent = '×';
        dlg.append(body, stClose);
        document.body.appendChild(dlg);

        applyNdPopupChrome(dlg);
        const closeBtn = findByClass(dlg, 'nd-native-dialog__close');
        assert.ok(closeBtn);
        assert.equal(closeBtn.parentNode, header);
        assert.equal(stClose.style.display, 'none');
        dlg.remove();
    });

    it('toolbar selector has no box chrome; create button label has no leading symbol', () => {
        const block = componentsCss.match(/\.nd-library-toolbar\s*\{[^}]+\}/s);
        assert.ok(block);
        assert.match(block[0], /background:\s*transparent/);
        assert.match(block[0], /border:\s*0/);
        assert.match(block[0], /border-radius:\s*0/);
        assert.match(block[0], /box-shadow:\s*none/);
        assert.doesNotMatch(block[0], /backdrop-filter/);

        assert.equal(t('library.create'), '新建');
        assert.doesNotMatch(t('library.create'), /[＋+]/);

        const tb = createLibraryToolbar({
            onCreate: () => {},
            onImport: () => {},
            onExport: () => {},
            sortOptions: [{ value: 'name-asc', label: '名称' }],
        });
        assert.ok(findByClass(tb.el, 'nd-library-toolbar__actions'));
        tb.destroy();
    });

    it('artist cover:true without url keeps 同比例 empty cover placeholder', () => {
        const card = createStyleCard({ title: '24新画风', cover: true });
        const cover = findByClass(card.el, 'nd-style-card__cover');
        assert.ok(cover);
        assert.ok(String(cover.className).includes('nd-style-card__cover--empty'));
        assert.equal(findByClass(cover, 'nd-style-card__cover-empty')?.textContent, '无示例图');
        assert.match(
            componentsCss,
            /\.nd-style-card__cover\s*\{[^}]*aspect-ratio:\s*832\s*\/\s*1216/s,
        );
        assert.match(componentsCss, /\.nd-style-card__cover--empty\s*\{/);
        assert.match(componentsCss, /\.nd-style-card__cover-empty\s*\{[^}]*font-size:\s*var\(--nd-fs-sm\)/s);
        card.destroy();
    });
});
