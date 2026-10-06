/**
 * 画师串模型版本：导入勾选，以及选择时的 v4.5 / v5 过滤。
 */

import {
    ARTIST_MODEL_TAGS,
    artistHasModelTag,
    resolveArtistModelTag,
} from '../../domain/model/artist.js';
import { createChip } from './controls.js';

/**
 * @param {unknown} source 画师对象或版本字符串
 * @returns {string}
 */
export function formatArtistModelTag(source) {
    return resolveArtistModelTag(source);
}

/**
 * 单选过滤：全部 / v4.5 / v5。空字符串表示全部。
 * @param {{ value?: string, onChange: (tag: string) => void }} opts
 * @returns {{ el: HTMLElement, getValue: () => string, destroy: () => void }}
 */
export function createArtistModelTagFilter(opts) {
    const row = document.createElement('div');
    row.className = 'nd-model-tag-filter';
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', '按模型版本过滤画师串');

    /** @type {{ value: string, btn: HTMLButtonElement }[]} */
    const chips = [];
    let current = opts?.value != null ? String(opts.value) : '';
    const options = [
        { value: '', label: '全部' },
        ...ARTIST_MODEL_TAGS.map((tag) => ({ value: tag, label: tag })),
    ];

    function paint() {
        for (const chip of chips) {
            chip.btn.classList.toggle('is-active', chip.value === current);
            chip.btn.setAttribute('aria-pressed', chip.value === current ? 'true' : 'false');
        }
    }

    for (const option of options) {
        const btn = createChip({
            label: option.label,
            active: option.value === current,
            onClick: () => {
                if (current === option.value) return;
                current = option.value;
                paint();
                opts.onChange(current);
            },
        });
        btn.setAttribute('aria-pressed', option.value === current ? 'true' : 'false');
        chips.push({ value: option.value, btn });
        row.appendChild(btn);
    }

    return {
        el: row,
        getValue: () => current,
        destroy() {
            row.remove();
        },
    };
}

/**
 * 导入 / 编辑时选定一个版本。点中的那个就是这条串的唯一标签。
 * @param {{ modelTag?: unknown, modelTags?: unknown, label?: string, hint?: string, onChange?: (tag: string) => void }} [opts]
 * @returns {{ el: HTMLElement, getTag: () => string, destroy: () => void }}
 */
export function createArtistModelTagChecks(opts) {
    let current = resolveArtistModelTag(opts?.modelTag != null ? opts.modelTag : opts?.modelTags);
    const root = document.createElement('div');
    root.className = 'nd-model-tag-checks';
    const label = document.createElement('span');
    label.className = 'nd-field__label';
    label.textContent = opts?.label != null ? String(opts.label) : '模型版本';
    const checks = document.createElement('div');
    checks.className = 'nd-model-tag-checks__row';
    checks.setAttribute('role', 'radiogroup');
    checks.setAttribute('aria-label', label.textContent);

    /** @type {{ tag: string, btn: HTMLButtonElement }[]} */
    const chips = [];

    function paint() {
        for (const chip of chips) {
            const on = chip.tag === current;
            chip.btn.classList.toggle('is-active', on);
            chip.btn.setAttribute('aria-checked', on ? 'true' : 'false');
        }
    }

    for (const tag of ARTIST_MODEL_TAGS) {
        const btn = createChip({
            label: tag,
            active: tag === current,
            onClick: () => {
                if (current === tag) return;
                current = tag;
                paint();
                if (typeof opts?.onChange === 'function') opts.onChange(current);
            },
        });
        btn.setAttribute('role', 'radio');
        btn.setAttribute('aria-checked', tag === current ? 'true' : 'false');
        chips.push({ tag, btn });
        checks.appendChild(btn);
    }

    root.append(label, checks);
    if (opts?.hint) {
        const hint = document.createElement('p');
        hint.className = 'nd-muted nd-model-tag-checks__hint';
        hint.textContent = String(opts.hint);
        root.appendChild(hint);
    }

    return {
        el: root,
        getTag: () => current,
        destroy() {
            root.remove();
        },
    };
}

/**
 * @param {{ modelTag?: unknown, modelTags?: unknown }|null|undefined} artist
 * @param {string} tag 空字符串表示不过滤
 * @returns {boolean}
 */
export function artistMatchesModelFilter(artist, tag) {
    const want = tag == null ? '' : String(tag);
    if (!want) return true;
    return artistHasModelTag(artist, want);
}
