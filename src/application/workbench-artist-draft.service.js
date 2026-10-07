/**
 * L4 应用层 · 工作台画师串草稿保存。
 * 只持久化画师实体与可选的本机封面副本，不生成图片、不修改全局激活画师串。
 */
import { Err } from '../infra/result.js';
import { configError } from '../infra/errors.js';
import { createArtist, nextArtistSequence } from '../domain/model/artist.js';

/**
 * @param {{
 *   artistRepo: { get: Function, list: Function, put: Function },
 *   makeCardImage: (blob: Blob) => Promise<Blob>,
 *   saveCoverPair: (storageKey: string, referenceBlob: Blob, cardBlob: Blob) => Promise<{ ok: boolean, value?: { referenceImageRef: string, cardImageRef: string }, error?: unknown }>,
 *   removeCoverImage: (ref: string|null|undefined) => Promise<unknown>,
 *   newId: (prefix?: string) => string,
 *   nowIso: () => string,
 * }} deps
 */
export function createWorkbenchArtistDraftService(deps) {
    if (!deps?.artistRepo || typeof deps.artistRepo.get !== 'function'
        || typeof deps.artistRepo.list !== 'function' || typeof deps.artistRepo.put !== 'function') {
        throw new Error('createWorkbenchArtistDraftService requires artistRepo');
    }
    const idFn = typeof deps.newId === 'function' ? deps.newId : () => `ar-${Math.random().toString(36).slice(2)}`;
    const now = typeof deps.nowIso === 'function' ? deps.nowIso : () => new Date().toISOString();

    async function removeRefs(refs) {
        if (typeof deps.removeCoverImage !== 'function') return;
        for (const ref of refs) {
            if (!ref) continue;
            try {
                await deps.removeCoverImage(ref);
            } catch {
                // Image cleanup is best-effort; the artist record is already authoritative.
            }
        }
    }

    return {
        /**
         * @param {{ mode: 'update'|'create', artistId?: string|null, name: string, positivePrompt: string, negativePrompt: string, coverBlob?: Blob|null }} input
         */
        async save(input) {
            const name = String(input?.name ?? '').trim();
            if (!name) {
                return Err(configError({
                    code: 'WORKBENCH_ARTIST_NAME_REQUIRED',
                    message: '请填写画师串名称',
                }));
            }
            if (input.mode !== 'update' && input.mode !== 'create') {
                return Err(configError({
                    code: 'WORKBENCH_ARTIST_MODE',
                    message: '画师串保存方式无效',
                }));
            }

            let current = null;
            let entity;
            if (input.mode === 'update') {
                const artistId = String(input.artistId ?? '').trim();
                if (!artistId) {
                    return Err(configError({
                        code: 'WORKBENCH_ARTIST_TARGET_REQUIRED',
                        message: '先选择要保存到的画师串',
                    }));
                }
                const found = await deps.artistRepo.get(artistId);
                if (!found?.ok) return found;
                if (!found.value) {
                    return Err(configError({
                        code: 'WORKBENCH_ARTIST_NOT_FOUND',
                        message: '当前画师串已不存在，请重新选择',
                    }));
                }
                current = found.value;
                entity = {
                    ...current,
                    name,
                    positivePrompt: String(input.positivePrompt ?? ''),
                    negativePrompt: String(input.negativePrompt ?? ''),
                    updatedAt: now(),
                };
            } else {
                const listed = await deps.artistRepo.list();
                if (!listed?.ok) return listed;
                const createdAt = now();
                entity = createArtist({
                    name,
                    sequence: nextArtistSequence(Array.isArray(listed.value) ? listed.value : []),
                    positivePrompt: String(input.positivePrompt ?? ''),
                    negativePrompt: String(input.negativePrompt ?? ''),
                }, { id: idFn('ar'), now: createdAt });
            }

            /** @type {string[]} */
            const stagedRefs = [];
            const coverBlob = input.coverBlob ?? null;
            if (coverBlob != null) {
                if (typeof Blob === 'undefined' || !(coverBlob instanceof Blob)
                    || typeof deps.makeCardImage !== 'function' || typeof deps.saveCoverPair !== 'function') {
                    return Err(configError({
                        code: 'WORKBENCH_ARTIST_COVER_UNAVAILABLE',
                        message: '当前预览图无法保存为画师串封面',
                    }));
                }
                let pair;
                try {
                    const cardBlob = await deps.makeCardImage(coverBlob);
                    const storageKey = `${entity.id}-${idFn('cover')}`;
                    pair = await deps.saveCoverPair(storageKey, coverBlob, cardBlob);
                } catch (error) {
                    return Err(configError({
                        code: 'WORKBENCH_ARTIST_COVER_SAVE_FAILED',
                        message: '画师串封面处理失败',
                        cause: error,
                    }));
                }
                if (!pair?.ok || !pair.value) {
                    return pair?.ok === false ? pair : Err(configError({
                        code: 'WORKBENCH_ARTIST_COVER_SAVE_FAILED',
                        message: '画师串封面保存失败',
                    }));
                }
                stagedRefs.push(pair.value.referenceImageRef, pair.value.cardImageRef);
                entity = {
                    ...entity,
                    referenceImageRef: pair.value.referenceImageRef,
                    cardImageRef: pair.value.cardImageRef,
                };
            }

            const saved = await deps.artistRepo.put(entity);
            if (!saved?.ok) {
                await removeRefs(stagedRefs);
                return saved;
            }
            if (stagedRefs.length && current) {
                await removeRefs([current.referenceImageRef, current.cardImageRef]);
            }
            return saved;
        },

        /**
         * 只用工作台这张图替换画师串预览，不改名称和提示词。
         * @param {{ artistId?: string|null, coverBlob?: Blob|null }} input
         */
        async replacePreview(input) {
            const artistId = String(input?.artistId ?? '').trim();
            if (!artistId) {
                return Err(configError({
                    code: 'WORKBENCH_ARTIST_TARGET_REQUIRED',
                    message: '请先选择画师串',
                }));
            }
            const coverBlob = input?.coverBlob ?? null;
            if (typeof Blob === 'undefined' || !(coverBlob instanceof Blob)) {
                return Err(configError({
                    code: 'WORKBENCH_ARTIST_COVER_REQUIRED',
                    message: '请先出图，再用这张图替换预览',
                }));
            }
            if (typeof deps.makeCardImage !== 'function' || typeof deps.saveCoverPair !== 'function') {
                return Err(configError({
                    code: 'WORKBENCH_ARTIST_COVER_UNAVAILABLE',
                    message: '当前预览图无法保存为画师串封面',
                }));
            }
            const found = await deps.artistRepo.get(artistId);
            if (!found?.ok) return found;
            if (!found.value) {
                return Err(configError({
                    code: 'WORKBENCH_ARTIST_NOT_FOUND',
                    message: '当前画师串已不存在，请重新选择',
                }));
            }
            const current = found.value;
            /** @type {string[]} */
            const stagedRefs = [];
            let pair;
            try {
                const cardBlob = await deps.makeCardImage(coverBlob);
                const storageKey = `${current.id}-${idFn('cover')}`;
                pair = await deps.saveCoverPair(storageKey, coverBlob, cardBlob);
            } catch (error) {
                return Err(configError({
                    code: 'WORKBENCH_ARTIST_COVER_SAVE_FAILED',
                    message: '画师串封面处理失败',
                    cause: error,
                }));
            }
            if (!pair?.ok || !pair.value) {
                return pair?.ok === false ? pair : Err(configError({
                    code: 'WORKBENCH_ARTIST_COVER_SAVE_FAILED',
                    message: '画师串封面保存失败',
                }));
            }
            stagedRefs.push(pair.value.referenceImageRef, pair.value.cardImageRef);
            const saved = await deps.artistRepo.put({
                ...current,
                referenceImageRef: pair.value.referenceImageRef,
                cardImageRef: pair.value.cardImageRef,
                updatedAt: now(),
            });
            if (!saved?.ok) {
                await removeRefs(stagedRefs);
                return saved;
            }
            await removeRefs([current.referenceImageRef, current.cardImageRef]);
            return saved;
        },
    };
}
