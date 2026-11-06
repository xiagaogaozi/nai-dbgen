import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { installFakeDom } from './fake-dom.js';
import { openModal, applyNdPopupChrome } from '../../src/ui/common/modal.js';

const here = dirname(fileURLToPath(import.meta.url));
const componentsCss = readFileSync(join(here, '../../src/ui/common/components.css'), 'utf8');

describe('D70 single-layer popup chrome', () => {
    /** @type {ReturnType<typeof installFakeDom>|null} */
    let fake = null;

    beforeEach(() => {
        fake = installFakeDom();
    });

    afterEach(() => {
        fake?.restore();
        fake = null;
    });

    it('CSS: dialog.nd-popup 是唯一画皮容器；shell 无 background/border-radius/box-shadow', () => {
        assert.match(
            componentsCss,
            /dialog\.nd-popup\.nd-root\s*,\s*dialog\.nd-native-dialog\.nd-root\s*\{[^}]*background:\s*var\(--nd-popup-bg\)\s*!important/s,
        );
        assert.match(
            componentsCss,
            /dialog\.nd-popup\.nd-root\s*,\s*dialog\.nd-native-dialog\.nd-root\s*\{[^}]*border-radius:\s*var\(--nd-radius-lg\)\s*!important/s,
        );
        const shellBlock = componentsCss.match(/\.nd-native-dialog__shell\s*\{[^}]+\}/s);
        assert.ok(shellBlock, 'shell rule exists');
        assert.match(shellBlock[0], /background:\s*transparent/);
        assert.match(shellBlock[0], /border-radius:\s*0/);
        assert.match(shellBlock[0], /box-shadow:\s*none/);
        assert.doesNotMatch(shellBlock[0], /background:\s*#fffafd/);
        assert.doesNotMatch(shellBlock[0], /border-radius:\s*var\(--nd-radius-/);
    });

    it('native path: dialog 带 nd-popup；× 在 .nd-popup-header 行内；shell 无容器皮', async () => {
        const content = document.createElement('div');
        content.textContent = 'body';
        const handle = await openModal({ host: null }, { title: 'T', element: content });
        const dlg = content.closest('dialog');
        assert.ok(dlg);
        assert.ok(dlg.classList.contains('nd-popup'));
        assert.ok(dlg.classList.contains('nd-root'));
        assert.ok(dlg.classList.contains('nd-native-dialog'));

        /** @param {Element|null|undefined} root @param {string} className */
        function findClass(root, className) {
            if (!root) return null;
            if (String(root.className || '').split(/\s+/).includes(className)) return root;
            for (const child of root.childNodes || []) {
                const hit = findClass(/** @type {Element} */ (child), className);
                if (hit) return hit;
            }
            return null;
        }

        const shell = findClass(dlg, 'nd-native-dialog__shell');
        assert.ok(shell);
        // 从 dialog 到内容根：只有 dialog 带 nd-popup
        let node = content.parentElement;
        /** @type {Element[]} */
        const chain = [];
        while (node && node !== dlg) {
            chain.push(node);
            node = node.parentElement;
        }
        for (const el of chain) {
            assert.equal(
                el.classList.contains('nd-popup'),
                false,
                `inner ${el.className} must not be nd-popup`,
            );
        }

        const header = findClass(dlg, 'nd-popup-header');
        const closeBtn = findClass(dlg, 'nd-native-dialog__close');
        assert.ok(header);
        assert.ok(closeBtn);
        assert.equal(closeBtn.parentNode, header);
        assert.ok(findClass(header, 'nd-modal-title'));
        handle.destroy();
    });

    it('host popup path: applyNdPopupChrome 挂在 dialog.popup 上并藏酒馆 ×', () => {
        const dlg = document.createElement('dialog');
        dlg.className = 'popup';
        const body = document.createElement('div');
        body.className = 'popup-body';
        const content = document.createElement('div');
        content.className = 'popup-content';
        const wrap = document.createElement('div');
        wrap.className = 'nd-root';
        content.appendChild(wrap);
        body.appendChild(content);
        const stClose = document.createElement('div');
        stClose.className = 'popup-button-close';
        stClose.textContent = '×';
        dlg.append(body, stClose);
        document.body.appendChild(dlg);

        applyNdPopupChrome(dlg);
        assert.ok(dlg.classList.contains('nd-popup'));
        assert.ok(dlg.classList.contains('nd-root'));
        assert.equal(stClose.style.display, 'none');
        /** @param {Element|null|undefined} root @param {string} className */
        function findClass(root, className) {
            if (!root) return null;
            if (String(root.className || '').split(/\s+/).includes(className)) return root;
            for (const child of root.childNodes || []) {
                const hit = findClass(/** @type {Element} */ (child), className);
                if (hit) return hit;
            }
            return null;
        }
        assert.ok(findClass(dlg, 'nd-native-dialog__close'));
        dlg.remove();
    });
});
