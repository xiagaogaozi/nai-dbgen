/**
 * L5 UI · 存储管理：会话记录清理 + 图片缓存上限（需求 4.17）。
 */

import { createButton, createInlineError, createNumberField } from '../../common/controls.js';
import { openSlotImageViewer } from '../../common/image-viewer.js';
import { readPngCaption } from '../../common/png-caption.js';
import { matchImageArtist } from '../../common/image-artist-match.js';
import { confirmDanger, el, setText, toast, settingsApi } from '../_lib/panel-kit.js';

/**
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) {
        return `${n} B`;
    }
    if (n < 1024 * 1024) {
        return `${(n / 1024).toFixed(1)} KB`;
    }
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * @param {Element} root
 * @param {object} deps
 * @returns {{ destroy: () => void, refresh: () => Promise<void> }}
 */
export function mountStoragePanel(root, deps) {
    if (!(root instanceof Element)) {
        throw new Error('mountStoragePanel: root must be an Element');
    }

    const host = deps?.host;
    const cleanupService = deps?.services?.storageCleanup
        || deps?.storageCleanup;
    const trimService = deps?.services?.imageCacheTrim
        || deps?.imageCacheTrim;
    const imageRepo = deps?.repos?.image
        || deps?.imageRepo;
    const settings = settingsApi(deps);

    const shell = el('div', 'nd-panel nd-panel--storage');

    // ── 会话记录 ──────────────────────────────────────────────
    const sessionBlock = el('div', 'nd-storage-block');
    const sessionTitle = el('h3', 'nd-storage-block__title');
    setText(sessionTitle, '会话生图记录');
    const sessionErr = createInlineError();
    const sessionHint = el('p', 'nd-muted');
    setText(
        sessionHint,
        '清理已从酒馆删除的会话对应的生图记录。此操作不可撤销。',
    );
    const sessionResult = el('p', 'nd-storage-result nd-muted');
    sessionResult.hidden = true;
    const cleanBtn = createButton({
        label: '清理',
        variant: 'danger',
        onClick: () => void runSessionCleanup(),
    });
    sessionBlock.append(sessionTitle, sessionErr.el, sessionHint, cleanBtn, sessionResult);

    // ── 图片缓存 ──────────────────────────────────────────────
    const cacheBlock = el('div', 'nd-storage-block');
    const cacheTitle = el('h3', 'nd-storage-block__title');
    setText(cacheTitle, '图片缓存');
    const cacheErr = createInlineError();
    const cacheHint = el('p', 'nd-muted');
    setText(
        cacheHint,
        '楼层出的图保存在本机浏览器。超过上限时从最旧的开始删，腾出空间；不影响服务器上的生图记录。',
    );
    const statsEl = el('p', 'nd-storage-stats');
    setText(statsEl, '当前：—');

    const limitField = createNumberField({
        label: '缓存上限（张）',
        value: Number(settings.load()?.imageCacheLimit) || 500,
        min: 1,
        step: 1,
        onChange: (v) => {
            const n = Number(v);
            if (!Number.isInteger(n) || n < 1) {
                cacheErr.setMessage('上限必须是 ≥1 的整数');
                return;
            }
            cacheErr.clear();
            settings.patch({ imageCacheLimit: n });
        },
    });

    const cacheResult = el('p', 'nd-storage-result nd-muted');
    cacheResult.hidden = true;
    const gallery = el('div', 'nd-cache-gallery');
    const trimBtn = createButton({
        label: '清理图片缓存',
        variant: 'danger',
        onClick: () => void runImageTrim(),
    });
    cacheBlock.append(
        cacheTitle,
        cacheErr.el,
        cacheHint,
        statsEl,
        gallery,
        limitField.el,
        trimBtn,
        cacheResult,
    );

    shell.append(sessionBlock, cacheBlock);
    root.appendChild(shell);

    let destroyed = false;

    async function refreshStats() {
        if (destroyed) {
            return;
        }
        if (!imageRepo || typeof imageRepo.estimateUsage !== 'function') {
            setText(statsEl, '当前：暂不可用');
            return;
        }
        try {
            const r = await imageRepo.estimateUsage();
            if (destroyed) {
                return;
            }
            if (!r?.ok) {
                setText(statsEl, '当前：读取失败');
                return;
            }
            const { count, bytes } = r.value;
            setText(statsEl, `当前：${count} 张，约 ${formatBytes(bytes)}`);
            await paintGallery();
        } catch {
            if (!destroyed) {
                setText(statsEl, '当前：读取失败');
            }
        }
    }

    async function paintGallery() {
        gallery.replaceChildren();
        if (!imageRepo || typeof imageRepo.listMeta !== 'function' || typeof imageRepo.getUrl !== 'function') {
            return;
        }
        const listed = await imageRepo.listMeta();
        if (destroyed || !listed?.ok) {
            return;
        }
        if (!listed.value.length) {
            const empty = el('p', 'nd-muted');
            setText(empty, '没有缓存图片');
            gallery.appendChild(empty);
            return;
        }
        for (const row of listed.value) {
            const card = document.createElement('div');
            card.className = 'nd-cache-card';
            card.tabIndex = 0;
            const img = document.createElement('img');
            img.alt = '';
            img.className = 'nd-cache-card__img';
            card.appendChild(img);
            const cap = el('span', 'nd-cache-card__cap');
            const title = `${row.pinned ? '画师参考 · ' : ''}${formatBytes(row.size)}`;
            setText(cap, title);
            card.appendChild(cap);
            const reuse = document.createElement('button');
            reuse.type = 'button';
            reuse.className = 'nd-button nd-button--primary nd-cache-card__reuse';
            reuse.textContent = '复用到工作台';
            reuse.addEventListener('click', async (event) => {
                event.stopPropagation();
                if (reuse.disabled) return;
                reuse.disabled = true;
                try {
                    if (!deps.importToWorkbench || !imageRepo.getBlob) throw new Error('工作台或图片读取功能不可用');
                    const result = await imageRepo.getBlob(row.id);
                    if (!result?.ok || !result.value) throw new Error('读取图片失败');
                    const caption = await readPngCaption(result.value);
                    const listedArtists = await deps.repos?.artist?.list?.();
                    if (listedArtists && !listedArtists.ok) throw new Error('画师串库读取失败，未导入图片');
                    const matched = matchImageArtist(caption, listedArtists?.value || []);
                    if (destroyed) return;
                    await deps.importToWorkbench(matched.artist
                        ? { artistId: matched.artist.id, caption: matched.caption }
                        : { caption });
                    if (!matched.artist) {
                        toast(host, 'warning', '未匹配到唯一的画师串，已将完整提示词导入场景。工作台原有画师串未改变，请检查是否重复。');
                    }
                } catch (error) {
                    toast(host, 'error', error?.message || '图片提示词导入失败');
                } finally {
                    reuse.disabled = false;
                }
            });
            reuse.addEventListener('keydown', (event) => event.stopPropagation());
            card.appendChild(reuse);
            gallery.appendChild(card);
            const urlR = await imageRepo.getUrl(row.id);
            if (destroyed) return;
            const url = urlR?.ok ? urlR.value : null;
            if (url) {
                img.src = url;
                const open = () => {
                    void openSlotImageViewer({ host }, { url, title, alt: title });
                };
                card.addEventListener('click', open);
                card.addEventListener('keydown', (event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        open();
                    }
                });
            }
        }
    }

    async function runSessionCleanup() {
        if (destroyed) {
            return;
        }
        sessionErr.clear();
        sessionResult.hidden = true;
        if (!cleanupService || typeof cleanupService.cleanup !== 'function') {
            sessionErr.setMessage('清理功能暂不可用，请刷新后重试');
            return;
        }
        const confirmed = await confirmDanger(
            deps,
            '将删除已不在酒馆中的会话生图记录。此操作不可撤销，确定继续？',
        );
        if (!confirmed || destroyed) {
            return;
        }
        cleanBtn.disabled = true;
        try {
            const r = await cleanupService.cleanup();
            if (!r?.ok) {
                const msg = r?.error?.message || '清理失败';
                sessionErr.setMessage(msg);
                toast(host, 'error', msg);
                return;
            }
            const { removedSessions, removedMissingFiles } = r.value;
            const text = `清理完成：删除无效会话 ${removedSessions} 个，清理无效登记 ${removedMissingFiles} 个。`;
            setText(sessionResult, text);
            sessionResult.hidden = false;
            toast(host, 'success', text);
        } catch (cause) {
            const msg = cause instanceof Error ? cause.message : '清理失败';
            sessionErr.setMessage(msg);
            toast(host, 'error', msg);
        } finally {
            cleanBtn.disabled = false;
        }
    }

    async function runImageTrim() {
        if (destroyed) {
            return;
        }
        cacheErr.clear();
        cacheResult.hidden = true;
        if (!trimService || typeof trimService.trim !== 'function') {
            cacheErr.setMessage('清理图片缓存暂不可用，请刷新后重试');
            return;
        }
        const limit = limitField.getValue();
        if (!Number.isInteger(limit) || limit < 1) {
            cacheErr.setMessage('上限必须是 ≥1 的整数');
            return;
        }
        settings.patch({ imageCacheLimit: limit });
        trimBtn.disabled = true;
        try {
            const r = await trimService.trim();
            if (!r?.ok) {
                const msg = r?.error?.message || '清理图片缓存失败';
                cacheErr.setMessage(msg);
                toast(host, 'error', msg);
                return;
            }
            const removed = Number(r.value?.removed) || 0;
            const text = removed > 0
                ? `已清理 ${removed} 张超出上限的旧图。`
                : '未超出上限，无需清理。';
            setText(cacheResult, text);
            cacheResult.hidden = false;
            toast(host, removed > 0 ? 'success' : 'info', text);
            await refreshStats();
        } catch (cause) {
            const msg = cause instanceof Error ? cause.message : '清理图片缓存失败';
            cacheErr.setMessage(msg);
            toast(host, 'error', msg);
        } finally {
            trimBtn.disabled = false;
        }
    }

    void refreshStats();

    return {
        async refresh() {
            const current = Number(settings.load()?.imageCacheLimit) || 500;
            limitField.setValue(current);
            await refreshStats();
        },
        destroy() {
            destroyed = true;
            try {
                limitField.destroy?.();
            } catch {
                // ignore
            }
            shell.remove();
        },
    };
}
