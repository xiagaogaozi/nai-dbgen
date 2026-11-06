/**
 * L4 应用层 · 画师串手填预览生图（需求 4.2）。
 * 用正在编辑的那一条串 + 手填提示词；预览尺寸用 ARTIST_PREVIEW_SIZE；不写楼。
 * 调用 ImageGenService.generate 时必须传 artist=正在编辑的 ArtistString（裁决 D9），
 * 不得临时改动 PluginSettings.activeArtistId。
 *
 * 示例图只存本机；原图用出图，卡片图由注入的 makeCardImage 生成。
 */

import { Ok, Err } from '../infra/result.js';
import { configError, domainError } from '../infra/errors.js';
import { ARTIST_PREVIEW_SIZE, emptyNaiCaption } from '../domain/model/nai-params.js';
import { nowIso } from '../infra/clock.js';
import { abortErrIfNeeded } from './_helpers.js';
import { boundModelForArtistTag } from '../domain/model/plugin-settings.js';
import { resolveArtistModelTag } from '../domain/model/artist.js';

/**
 * @typedef {object} ArtistPreviewDeps
 * @property {import('./image-gen.service.js').ImageGenService} imageGen
 * @property {import('../ports/repository.port.js').Repository<import('../domain/model/artist.js').ArtistString>} artistRepo
 * @property {(artistId: string, referenceBlob: Blob, cardBlob: Blob, oldRefs?: { referenceImageRef?: string|null, cardImageRef?: string|null }) => Promise<import('../infra/result.js').Ok<{ referenceImageRef: string, cardImageRef: string }>|import('../infra/result.js').Err<import('../infra/errors.js').AppError>>} savePreviewPair
 * @property {(blob: Blob) => Promise<Blob>} makeCardImage
 * @property {() => import('../domain/model/plugin-settings.js').PluginSettings} [loadSettings]
 *   0.2.46：开了「模型跟随模型版本」时，按画师串版本用绑定模型出预览；关了用当前模型。
 */

/**
 * @typedef {object} ArtistPreviewInput
 * @property {string} artistId 正在编辑的画师串（非必须当前激活）
 * @property {string} promptText 用户手填正向提示词
 * @property {string} [negativeText]
 * @property {boolean} [saveAsPreview=true] 是否写回示例图引用
 * @property {AbortSignal} [signal]
 */

/**
 * @param {ArtistPreviewDeps} deps
 * @returns {{ preview: (input: ArtistPreviewInput) => Promise<import('../infra/result.js').Ok<{ image: import('../ports/image-gen.port.js').GeneratedImage, referenceImageRef?: string, cardImageRef?: string }>|import('../infra/result.js').Err<import('../infra/errors.js').AppError>> }}
 */
export function createArtistPreviewService(deps) {
    if (!deps || typeof deps.savePreviewPair !== 'function') {
        throw new Error('createArtistPreviewService requires deps.savePreviewPair');
    }
    if (typeof deps.makeCardImage !== 'function') {
        throw new Error('createArtistPreviewService requires deps.makeCardImage');
    }
    return {
        /**
         * @param {ArtistPreviewInput} input
         */
        async preview(input) {
            if (!input || typeof input.artistId !== 'string' || !input.artistId) {
                throw new Error('invalid argument: artistId');
            }

            const aborted = abortErrIfNeeded(input.signal);
            if (aborted) {
                return aborted;
            }

            const artistR = await deps.artistRepo.get(input.artistId);
            if (!artistR.ok) {
                return artistR;
            }
            if (!artistR.value) {
                return Err(configError({
                    code: 'ARTIST_NOT_FOUND',
                    message: '找不到该画师串',
                    hint: '请确认条目仍存在',
                    context: { artistId: input.artistId },
                }));
            }

            const artist = artistR.value;
            const caption = emptyNaiCaption();
            caption.v4_prompt.caption.base_caption = String(input.promptText ?? '');
            caption.v4_negative_prompt.caption.base_caption = String(input.negativeText ?? '');

            /** @type {Record<string, unknown>} */
            const params = {
                width: ARTIST_PREVIEW_SIZE.width,
                height: ARTIST_PREVIEW_SIZE.height,
            };
            const settings = typeof deps.loadSettings === 'function' ? deps.loadSettings() : null;
            if (settings && settings.naiModelFollowsArtist !== false) {
                params.model = boundModelForArtistTag(settings, resolveArtistModelTag(artist));
            }

            const genR = await deps.imageGen.generate({
                caption,
                replaceCharacterKeywords: false,
                artist,
                params,
                signal: input.signal,
            });
            if (!genR.ok) {
                return genR;
            }
            if (!genR.value.length) {
                return Err(domainError({
                    code: 'ARTIST_PREVIEW_NO_IMAGE',
                    message: '预览生图未返回图片',
                    hint: '请检查 NAI 配置',
                }));
            }

            const image = genR.value[0];
            const saveAsPreview = input.saveAsPreview !== false;

            if (!saveAsPreview) {
                return Ok({ image });
            }

            let cardBlob;
            try {
                cardBlob = await deps.makeCardImage(image.blob);
            } catch (err) {
                return Err(domainError({
                    code: 'ARTIST_CARD_SCALE',
                    message: '卡片图生成失败',
                    cause: err,
                }));
            }

            const putR = await deps.savePreviewPair(
                artist.name,
                image.blob,
                cardBlob,
                {
                    referenceImageRef: artist.referenceImageRef,
                    cardImageRef: artist.cardImageRef,
                },
            );
            if (!putR.ok) {
                return putR;
            }

            const updated = {
                ...artist,
                referenceImageRef: putR.value.referenceImageRef,
                cardImageRef: putR.value.cardImageRef,
                updatedAt: nowIso(),
            };
            const saveR = await deps.artistRepo.put(updated);
            if (!saveR.ok) {
                return saveR;
            }

            return Ok({
                image,
                referenceImageRef: putR.value.referenceImageRef,
                cardImageRef: putR.value.cardImageRef,
            });
        },
    };
}
