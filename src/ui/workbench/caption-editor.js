/**
 * L5 UI · NaiCaption 结构化编辑器（D13）。
 * base 文本域 + 角色可增删列表；读写结构，绝不拍平再解析。
 */

import {
    createButton,
    createNumberField,
} from '../common/controls.js';
import {
    WORKBENCH_MAX_CHARACTERS,
    captionToEditorState,
    editorStateToCaption,
    emptyCharacterRow,
    cloneCaption,
} from './workbench-logic.js';
import { emptyNaiCaption } from '../../domain/model/nai-params.js';
import { createPromptTextarea, linkTextareaHeights } from '../common/prompt-textarea.js';

/**
 * @param {string} tag
 * @param {string} [className]
 * @returns {HTMLElement}
 */
function el(tag, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
}

/**
 * @param {HTMLElement} node
 * @param {string} text
 */
function setText(node, text) {
    node.textContent = text == null ? '' : String(text);
}

/**
 * @param {Element} root
 * @param {object} [opts]
 * @param {import('../../domain/model/nai-params.js').NaiCaption} [opts.initial]
 * @param {(index: number) => void} [opts.onCharacterRemove]
 * @param {(error: unknown) => void} [opts.onCopyError]
 * @returns {{
 *   el: HTMLElement,
 *   getCaption: () => import('../../domain/model/nai-params.js').NaiCaption,
 *   setCaption: (c: unknown) => void,
 *   destroy: () => void,
 * }}
 */
export function mountCaptionEditor(root, opts) {
    const shell = el('div', 'nd-wb-caption');
    const initial = captionToEditorState(opts?.initial ?? emptyNaiCaption());
    const createTextarea = (settings) => createPromptTextarea({
        ...settings,
        onCopyError: opts?.onCopyError,
    });

    const posBase = createTextarea({
        label: '场景 · 正面',
        value: initial.posBase,
        rows: 5,
    });
    const negBase = createTextarea({
        label: '场景 · 负面',
        value: initial.negBase,
        rows: 5,
    });

    const charsHead = el('div', 'nd-wb-caption__chars-head');
    const charsTitle = el('h4', 'nd-field-group__title');
    setText(charsTitle, '角色');
    const charsList = el('div', 'nd-wb-caption__chars');
    charsHead.appendChild(charsTitle);

    /** @type {Array<{
     *   root: HTMLElement,
     *   positive: ReturnType<typeof createTextarea>,
     *   negative: ReturnType<typeof createTextarea>,
     *   x: ReturnType<typeof createNumberField>,
     *   y: ReturnType<typeof createNumberField>,
     *   unlinkResize: () => void,
     * }>} */
    const rows = [];

    /**
     * @param {{ positive: string, negative: string, x: number, y: number }} data
     */
    function addRow(data) {
        if (rows.length >= WORKBENCH_MAX_CHARACTERS) return;
        const card = el('div', 'nd-wb-caption__char');
        const head = el('div', 'nd-wb-caption__char-head');
        const label = el('strong');
        setText(label, `角色 ${rows.length + 1}`);
        const positive = createTextarea({
            label: '正面',
            value: data.positive,
            rows: 3,
        });
        const negative = createTextarea({
            label: '负面',
            value: data.negative,
            rows: 3,
        });
        const x = createNumberField({
            label: '位置 X',
            value: data.x,
            min: 0,
            max: 1,
            step: 0.01,
        });
        const y = createNumberField({
            label: '位置 Y',
            value: data.y,
            min: 0,
            max: 1,
            step: 0.01,
        });
        const removeBtn = createButton({
            label: '删除',
            variant: 'ghost',
            onClick: () => {
                const idx = rows.findIndex((r) => r.root === card);
                if (idx < 0) return;
                const [removed] = rows.splice(idx, 1);
                removed.unlinkResize();
                removed.positive.destroy();
                removed.negative.destroy();
                removed.x.destroy();
                removed.y.destroy();
                removed.root.remove();
                relabel();
                syncAddEnabled();
                opts?.onCharacterRemove?.(idx);
            },
        });
        const actions = el('div', 'nd-wb-caption__char-actions');
        actions.append(
            createButton({ label: '保存到已有角色', variant: 'ghost', onClick: () => opts?.onSaveCharacter?.('update', { positive: positive.getValue(), negative: negative.getValue() }) }),
            createButton({ label: '新建角色', variant: 'ghost', onClick: () => opts?.onSaveCharacter?.('create', { positive: positive.getValue(), negative: negative.getValue() }) }),
            removeBtn,
        );
        head.append(label, actions);
        const coords = el('div', 'nd-wb-caption__coords');
        coords.append(x.el, y.el);
        const prompts = el('div', 'nd-wb-caption__prompt-pair');
        prompts.append(positive.el, negative.el);
        card.append(head, prompts, coords);
        charsList.appendChild(card);
        const unlinkResize = linkTextareaHeights(positive.input, negative.input);
        rows.push({ root: card, positive, negative, x, y, unlinkResize });
        relabel();
        syncAddEnabled();
    }

    function relabel() {
        rows.forEach((row, i) => {
            const strong = row.root.childNodes[0]?.childNodes?.[0];
            if (strong) setText(/** @type {HTMLElement} */ (strong), `角色 ${i + 1}`);
        });
    }

    const addBtn = createButton({
        label: '＋添加角色',
        variant: 'ghost',
        onClick: () => addRow(emptyCharacterRow()),
    });

    const importBtn = createButton({
        label: '导入角色',
        variant: 'ghost',
        onClick: () => opts?.onImportCharacter?.(),
    });

    function syncAddEnabled() {
        addBtn.disabled = rows.length >= WORKBENCH_MAX_CHARACTERS;
        importBtn.disabled = rows.length >= WORKBENCH_MAX_CHARACTERS;
    }

    const charActions = el('div', 'nd-wb-caption__char-actions');
    charActions.append(addBtn, importBtn);
    charsHead.appendChild(charActions);

    for (const row of initial.characters) {
        addRow(row);
    }

    const scenePrompts = el('div', 'nd-wb-caption__prompt-pair');
    scenePrompts.append(posBase.el, negBase.el);
    shell.append(scenePrompts, charsHead, charsList);
    root.appendChild(shell);
    const unlinkSceneResize = linkTextareaHeights(posBase.input, negBase.input);

    function readState() {
        return {
            posBase: posBase.getValue(),
            negBase: negBase.getValue(),
            characters: rows.map((r) => ({
                positive: r.positive.getValue(),
                negative: r.negative.getValue(),
                x: r.x.getValue(),
                y: r.y.getValue(),
            })),
        };
    }

    /**
     * @param {unknown} caption
     */
    function setCaption(caption) {
        const state = captionToEditorState(caption);
        posBase.setValue(state.posBase);
        negBase.setValue(state.negBase);
        while (rows.length) {
            const removed = rows.pop();
            if (!removed) break;
            removed.unlinkResize();
            removed.positive.destroy();
            removed.negative.destroy();
            removed.x.destroy();
            removed.y.destroy();
            removed.root.remove();
        }
        for (const row of state.characters) {
            addRow(row);
        }
        syncAddEnabled();
    }

    let destroyed = false;
    return {
        el: shell,
        getCaption: () => cloneCaption(editorStateToCaption(readState())),
        getTargetForInput(input) {
            if (input === posBase.input) return 'scene.positive';
            if (input === negBase.input) return 'scene.negative';
            for (let i = 0; i < rows.length; i += 1) {
                if (input === rows[i].positive.input) return `character.${i}.positive`;
                if (input === rows[i].negative.input) return `character.${i}.negative`;
            }
            return null;
        },
        getInputForTarget(target) {
            if (target === 'scene.positive') return posBase.input;
            if (target === 'scene.negative') return negBase.input;
            const match = /^character\.(\d+)\.(positive|negative)$/.exec(String(target));
            const row = match && rows[Number(match[1])];
            return row ? row[match[2]].input : null;
        },
        getCharacterCount: () => rows.length,
        setCaption,
        destroy() {
            if (destroyed) return;
            destroyed = true;
            unlinkSceneResize();
            posBase.destroy();
            negBase.destroy();
            while (rows.length) {
                const removed = rows.pop();
                if (!removed) break;
                removed.unlinkResize();
                removed.positive.destroy();
                removed.negative.destroy();
                removed.x.destroy();
                removed.y.destroy();
                removed.root.remove();
            }
            shell.remove();
        },
    };
}
