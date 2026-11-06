/**
 * L0 装配 · 唯一 new/工厂调用点：组装 ports 实现并注入用例。
 * 归属：W3-J 装配代理实现。
 *
 * 三处同实例（写错不报错但行为会错）：
 * - llm：tagRecall 与 generateSlots 必须同一实例
 * - tagRecall：generateSlots 与 workbench 必须同一实例（D33）
 * - bus：generateSlots、renderSlot、autoTrigger 必须同一个（D32）
 *
 * createRenderSlotUseCase 必填 host（D36 getCurrentChatId）。
 */

import { createEventBus } from '../infra/event-bus.js';
import { newId } from '../infra/id.js';
import { nowIso } from '../infra/clock.js';

import { createSillyTavernHost } from '../adapters/host/sillytavern.host.js';
import { createStMacroBridge } from '../adapters/host/st-macro.bridge.js';

import { openIdb } from '../adapters/storage/idb.js';
import { createServerFiles } from '../adapters/storage/server-files.js';
import { createMarketCatalogStore } from '../adapters/storage/market-catalog.store.js';
import { createMemoryServerFiles } from '../adapters/storage/memory-server-files.js';
import { createArtistFileUrlResolver } from '../adapters/storage/artist-preview-files.js';
import {
    openServerDocStore,
} from '../adapters/storage/server-doc-store.js';
import { putArtistPreviewPair } from '../adapters/storage/artist-preview-files.js';
import { createChatIndexStore } from '../adapters/storage/chat-index.store.js';
import { createSettingsStore } from '../adapters/storage/settings.store.js';
import { createCharacterRepo } from '../adapters/storage/repos/character.repo.js';
import { createTagRepo } from '../adapters/storage/repos/tag.repo.js';
import { createArtistRepo } from '../adapters/storage/repos/artist.repo.js';
import { createPresetRepo } from '../adapters/storage/repos/preset.repo.js';
import { createLlmConfigRepo, createNaiConfigRepo } from '../adapters/storage/repos/api-config.repo.js';
import { createSlotRepo } from '../adapters/storage/repos/slot.repo.js';
import { createImageRepo } from '../adapters/storage/image.repo.js';

import { createLlmGateway } from '../adapters/llm/llm.gateway.js';
import { createStBackendLlmTransport } from '../adapters/llm/transport/st-backend.js';
import { createLlmSecretsStore } from '../adapters/llm/secrets-store.js';
import { resolveYamlApi } from '../adapters/host/st-yaml.js';

import { createNaiGateway } from '../adapters/nai/nai.gateway.js';
import { createDirectTransport } from '../adapters/nai/transport/direct.js';
import { createStCorsProxyTransport } from '../adapters/nai/transport/st-cors-proxy.js';
import { decodeZip } from '../adapters/nai/decoder/zip.js';
import { decodeJsonBase64 } from '../adapters/nai/decoder/json-base64.js';

import { createContextCollector } from '../application/context-collector.js';
import { createWorldInfoResolver } from '../application/worldinfo-resolver.js';
import { createViewpointBlocksBuilder } from '../application/viewpoint-blocks.js';
import { createTagRecallService } from '../application/tag-recall.service.js';
import { createGenerateSlotsUseCase } from '../application/generate-slots.usecase.js';
import { createGenerateFloorUseCase } from '../application/generate-floor.usecase.js';
import { createImageGenService } from '../application/image-gen.service.js';
import { createRenderSlotUseCase } from '../application/render-slot.usecase.js';
import { createArtistPreviewService } from '../application/artist-preview.service.js';
import { createWorkbenchService } from '../application/workbench.service.js';
import { createWorkbenchArtistDraftService } from '../application/workbench-artist-draft.service.js';
import { createAutoTriggerService } from '../application/auto-trigger.service.js';
import { createStorageCleanupService } from '../application/storage-cleanup.service.js';
import { createImageCacheTrimService } from '../application/image-cache-trim.service.js';
import { createSlotEditorService } from '../application/slot-editor.service.js';
import { APP_EVENTS } from '../application/_helpers.js';
import { scaleImageToCard } from '../adapters/storage/image-scale.js';

/**
 * @typedef {object} AppRepos
 * @property {import('../ports/repository.port.js').CharacterRepository} character
 * @property {import('../ports/repository.port.js').TagRepository} tag
 * @property {import('../ports/repository.port.js').Repository<import('../domain/model/artist.js').ArtistString>} artist
 * @property {import('../ports/repository.port.js').Repository<import('../domain/model/preset.js').Preset>} preset
 * @property {import('../ports/repository.port.js').SlotRepository} slot
 * @property {import('../ports/repository.port.js').Repository<import('../domain/model/api-config.js').LlmApiConfig>} llmConfig
 * @property {import('../ports/repository.port.js').Repository<import('../domain/model/api-config.js').NaiApiConfig>} naiConfig
 * @property {import('../ports/repository.port.js').ImageRepository} image
 */

/**
 * @typedef {object} AppContainer
 * @property {import('../ports/host.port.js').HostPort} host
 * @property {import('../ports/image-gen.port.js').ImageGenPort} imageGenPort
 * @property {import('../ports/llm.port.js').LlmPort} llm
 * @property {AppRepos} repos
 * @property {object} services
 * @property {object} useCases
 * @property {ReturnType<import('../infra/event-bus.js').createEventBus>} bus
 * @property {ReturnType<import('../adapters/storage/settings.store.js').createSettingsStore>} settingsStore
 * @property {() => import('../domain/model/plugin-settings.js').PluginSettings} loadSettings
 * @property {(template: string) => string} runHostMacros
 * @property {{ llm: object, tagRecall: object, bus: object }} shared
 *   三处同实例的显式引用，供测试断言
 * @property {() => void} dispose
 */

/** 应用层工厂必填字段（与「应用层接口交接.md §3」对齐，含 D36 host） */
export const REQUIRED_APP_DEPS = Object.freeze({
    createContextCollector: Object.freeze(['host', 'loadSettings']),
    createWorldInfoResolver: Object.freeze(['host']),
    createTagRecallService: Object.freeze([
        'llm', 'tagRepo', 'presetRepo', 'llmConfigRepo', 'loadSettings', 'runHostMacros',
    ]),
    createGenerateSlotsUseCase: Object.freeze([
        'host', 'llm', 'presetRepo', 'slotRepo', 'llmConfigRepo',
        'viewpointBlocks', 'tagRecall', 'bus',
        'loadSettings', 'runHostMacros', 'newId', 'nowIso', 'newTraceId',
    ]),
    createImageGenService: Object.freeze([
        'imageGenPort', 'artistRepo', 'naiConfigRepo', 'loadSettings', 'newTraceId',
    ]),
    createRenderSlotUseCase: Object.freeze([
        'imageGen', 'slotRepo', 'imageRepo', 'host', 'bus', 'nowIso', 'newTraceId',
    ]),
    createArtistPreviewService: Object.freeze(['imageGen', 'artistRepo', 'savePreviewPair', 'makeCardImage']),
    createWorkbenchService: Object.freeze([
        'llm', 'imageGen', 'characterRepo', 'tagRepo', 'llmConfigRepo',
        'tagRecall', 'loadSettings', 'runHostMacros',
    ]),
    createAutoTriggerService: Object.freeze([
        'host', 'generateSlots', 'renderSlot', 'slotRepo', 'loadSettings', 'bus',
    ]),
    createGenerateFloorUseCase: Object.freeze([
        'host', 'slotRepo', 'generateSlots', 'renderSlot',
    ]),
    createViewpointBlocksBuilder: Object.freeze([
        'host', 'characterRepo', 'tagRepo', 'contextCollector', 'worldInfoResolver', 'loadSettings',
    ]),
});

/**
 * 校验工厂 deps 是否含全部必填键；缺一即抛（装配期早失败）。
 * @param {string} factoryName
 * @param {object} deps
 * @param {readonly string[]} keys
 * @returns {void}
 */
export function assertRequiredDeps(factoryName, deps, keys) {
    if (!deps || typeof deps !== 'object') {
        throw new Error(`${factoryName}: deps 必须是对象`);
    }
    /** @type {string[]} */
    const missing = [];
    for (const key of keys) {
        if (deps[key] == null) {
            missing.push(key);
        }
    }
    if (missing.length > 0) {
        throw new Error(`${factoryName}: 缺少必填 deps：${missing.join(', ')}`);
    }
}

/**
 * @returns {() => any}
 */
function defaultGetContext() {
    return () => {
        const st = globalThis.SillyTavern;
        if (!st || typeof st.getContext !== 'function') {
            throw new Error('找不到 SillyTavern.getContext；请确认在酒馆页面内加载本插件');
        }
        return st.getContext();
    };
}

/**
 * 创建并装配全部依赖。不得在模块顶层自动执行。
 * 须分别调用 createLlmConfigRepo 与 createNaiConfigRepo（裁决 D7），禁止单一 api-config 仓库。
 *
 * @param {object} [opts]
 * @param {() => any} [opts.getContext]
 * @param {import('../ports/host.port.js').HostPort} [opts.host] 测试注入
 * @param {object} [opts.db] 测试注入内存 IDB（楼层图缓存 / slot 索引；若未另传 docDb 且无 serverFiles，库配置也走它）
 * @param {object} [opts.docDb] 测试注入库/配置文档库（IdbClient 形状）
 * @param {ReturnType<import('../adapters/storage/server-files.js').createServerFiles>} [opts.serverFiles] 测试注入
 * @param {object} [opts.idbOpts] 传给 openIdb
 * @param {ReturnType<import('../infra/event-bus.js').createEventBus>} [opts.bus]
 * @param {import('../ports/llm.port.js').LlmPort} [opts.llm]
 * @param {import('../ports/image-gen.port.js').ImageGenPort} [opts.imageGenPort]
 * @param {object} [opts.factories] 可替换应用层工厂（测同实例）
 * @returns {Promise<AppContainer>}
 */
export async function createContainer(opts = {}) {
    const getContext = typeof opts.getContext === 'function'
        ? opts.getContext
        : defaultGetContext();

    const bus = opts.bus ?? createEventBus();

    /** @type {import('../ports/host.port.js').HostPort} */
    const host = opts.host ?? createSillyTavernHost({ getContext, bus });

    const db = opts.db ?? await openIdb(opts.idbOpts);
    const ownsDb = !opts.db;

    /** @type {ReturnType<typeof createServerFiles>} */
    const serverFiles = opts.serverFiles
        ?? (opts.db
            // 测试：注入了内存 IDB 时默认配内存假 serverFiles，避免真实 fetch / CSRF
            ? createMemoryServerFiles()
            : createServerFiles({
                fetch: globalThis.fetch.bind(globalThis),
                getRequestHeaders: () => {
                    const ctx = getContext();
                    if (!ctx || typeof ctx.getRequestHeaders !== 'function') {
                        throw new Error('getContext().getRequestHeaders 不可用');
                    }
                    return ctx.getRequestHeaders();
                },
            }));

    /**
     * 库 / 预设 / API 配置：服务器文档库。
     * 测试：传 docDb；或只传 db（内存 IDB）且未显式要求服务器文档库 → 复用 db。
     * @type {object}
     */
    let docDb;
    let ownsDocDb = false;
    if (opts.docDb) {
        docDb = opts.docDb;
    } else if (opts.db && opts.useServerDocStore !== true) {
        docDb = opts.db;
    } else {
        docDb = await openServerDocStore({ serverFiles });
        ownsDocDb = true;
    }

    const settingsStore = createSettingsStore({ host });
    const loadSettings = () => settingsStore.load();

    const macroBridge = createStMacroBridge({ getContext });
    const runHostMacros = (template) => macroBridge.runHostMacros(template);

    const chatIndex = createChatIndexStore({ serverFiles, nowIso });

    const characterRepo = createCharacterRepo({ db: docDb, bus });
    const tagRepo = createTagRepo({ db: docDb, bus });
    const makeCardImage = (blob) => scaleImageToCard(blob);
    const imageRepo = opts.imageRepo ?? createImageRepo({ db });
    const artistRepoInner = createArtistRepo({
        db: docDb,
        bus,
        imageRepo,
        nowIso,
        newId,
        makeCardImage,
    });
    const artistRepo = wrapArtistRepoPreviewCleanup(artistRepoInner, imageRepo);
    const presetRepo = createPresetRepo({ db: docDb, bus });
    const yaml = opts.yaml ?? await resolveYamlApi({ load: opts.loadYaml });
    const llmConfigRepo = createLlmConfigRepo({ db: docDb, bus, yaml });
    const naiConfigRepo = createNaiConfigRepo({ db: docDb, bus });
    const slotRepo = createSlotRepo({
        serverFiles,
        chatIndex,
        host,
        loadSettings,
        imageRepo,
        bus,
        nowIso,
    });

    const llmSecrets = opts.llmSecrets ?? createLlmSecretsStore({
        getRequestHeaders: () => {
            const ctx = getContext();
            if (!ctx || typeof ctx.getRequestHeaders !== 'function') {
                throw new Error('getContext().getRequestHeaders 不可用');
            }
            return ctx.getRequestHeaders();
        },
    });

    /** @type {import('../ports/llm.port.js').LlmPort} */
    const llm = opts.llm ?? createLlmGateway({
        transports: {
            'st-backend': createStBackendLlmTransport({ getContext, yaml }),
        },
    });

    /** @type {import('../ports/image-gen.port.js').ImageGenPort} */
    const imageGenPort = opts.imageGenPort ?? createNaiGateway({
        transports: {
            direct: createDirectTransport(),
            'st-cors-proxy': createStCorsProxyTransport(),
        },
        decoders: {
            'json-base64': { decode: decodeJsonBase64 },
            zip: { decode: decodeZip },
        },
    });

    const newTraceId = () => newId('trace');

    const factories = {
        createContextCollector,
        createWorldInfoResolver,
        createTagRecallService,
        createGenerateSlotsUseCase,
        createImageGenService,
        createRenderSlotUseCase,
        createArtistPreviewService,
        createWorkbenchService,
        createAutoTriggerService,
        createGenerateFloorUseCase,
        createViewpointBlocksBuilder,
        ...(opts.factories && typeof opts.factories === 'object' ? opts.factories : {}),
    };

    const contextCollectorDeps = { host, loadSettings };
    assertRequiredDeps('createContextCollector', contextCollectorDeps, REQUIRED_APP_DEPS.createContextCollector);
    const contextCollector = factories.createContextCollector(contextCollectorDeps);

    const worldInfoResolverDeps = { host };
    assertRequiredDeps('createWorldInfoResolver', worldInfoResolverDeps, REQUIRED_APP_DEPS.createWorldInfoResolver);
    const worldInfoResolver = factories.createWorldInfoResolver(worldInfoResolverDeps);

    const viewpointBlocksDeps = {
        host,
        characterRepo,
        tagRepo,
        contextCollector,
        worldInfoResolver,
        loadSettings,
    };
    assertRequiredDeps('createViewpointBlocksBuilder', viewpointBlocksDeps, REQUIRED_APP_DEPS.createViewpointBlocksBuilder);
    const viewpointBlocks = factories.createViewpointBlocksBuilder(viewpointBlocksDeps);

    // ── 同实例 #1：llm ──────────────────────────────────────────
    const tagRecallDeps = {
        llm,
        tagRepo,
        presetRepo,
        llmConfigRepo,
        loadSettings,
        runHostMacros,
        host,
    };
    assertRequiredDeps('createTagRecallService', tagRecallDeps, REQUIRED_APP_DEPS.createTagRecallService);
    const tagRecall = factories.createTagRecallService(tagRecallDeps);

    const imageGenDeps = {
        imageGenPort,
        artistRepo,
        naiConfigRepo,
        characterRepo,
        loadSettings,
        newTraceId,
    };
    assertRequiredDeps('createImageGenService', imageGenDeps, REQUIRED_APP_DEPS.createImageGenService);
    const imageGen = factories.createImageGenService(imageGenDeps);

    // ── 同实例 #1+#2+#3：llm / tagRecall / bus 进 generateSlots ──
    let slotEditor;
    const generateSlotsDeps = {
        isEditing: (mid) => slotEditor?.isSaving(mid) === true,
        host,
        llm,
        characterRepo,
        tagRepo,
        presetRepo,
        slotRepo,
        llmConfigRepo,
        contextCollector,
        worldInfoResolver,
        viewpointBlocks,
        tagRecall,
        bus,
        loadSettings,
        runHostMacros,
        newId,
        nowIso,
        newTraceId,
    };
    assertRequiredDeps('createGenerateSlotsUseCase', generateSlotsDeps, REQUIRED_APP_DEPS.createGenerateSlotsUseCase);
    const generateSlots = factories.createGenerateSlotsUseCase(generateSlotsDeps);

    // ── 同实例 #3：bus；D36：host ────────────────────────────────
    const renderSlotDeps = {
        isEditing: (mid) => slotEditor?.isSaving(mid) === true,
        imageGen,
        slotRepo,
        imageRepo,
        host,
        bus,
        nowIso,
        newTraceId,
    };
    assertRequiredDeps('createRenderSlotUseCase', renderSlotDeps, REQUIRED_APP_DEPS.createRenderSlotUseCase);
    const renderSlot = factories.createRenderSlotUseCase(renderSlotDeps);

    const artistPreviewDeps = {
        imageGen,
        artistRepo,
        savePreviewPair: (artistId, referenceBlob, cardBlob, oldRefs) => putArtistPreviewPair(
            { imageRepo },
            artistId,
            referenceBlob,
            cardBlob,
            oldRefs,
        ),
        makeCardImage,
        loadSettings,
    };
    assertRequiredDeps('createArtistPreviewService', artistPreviewDeps, REQUIRED_APP_DEPS.createArtistPreviewService);
    const artistPreview = factories.createArtistPreviewService(artistPreviewDeps);
    const workbenchArtistDraft = createWorkbenchArtistDraftService({
        artistRepo,
        makeCardImage,
        saveCoverPair: (storageKey, referenceBlob, cardBlob) => putArtistPreviewPair(
            { imageRepo },
            storageKey,
            referenceBlob,
            cardBlob,
        ),
        removeCoverImage: (ref) => imageRepo.remove(ref),
        newId,
        nowIso,
    });

    // ── 同实例 #2：tagRecall（D33）────────────────────────────────
    const workbenchDeps = {
        llm,
        imageGen,
        characterRepo,
        tagRepo,
        presetRepo,
        llmConfigRepo,
        tagRecall,
        host,
        viewpointBlocks,
        slotRepo,
        loadSettings,
        runHostMacros,
    };
    assertRequiredDeps('createWorkbenchService', workbenchDeps, REQUIRED_APP_DEPS.createWorkbenchService);
    const workbench = factories.createWorkbenchService(workbenchDeps);

    // ── 同实例 #3：bus（D32）─────────────────────────────────────
    const autoTriggerDeps = {
        host,
        generateSlots,
        renderSlot,
        slotRepo,
        loadSettings,
        bus,
    };
    assertRequiredDeps('createAutoTriggerService', autoTriggerDeps, REQUIRED_APP_DEPS.createAutoTriggerService);
    const autoTrigger = factories.createAutoTriggerService(autoTriggerDeps);

    // ── 同实例：generateSlots / renderSlot 闸门必须共享（D35/D54）──
    const generateFloorDeps = {
        host,
        slotRepo,
        generateSlots,
        renderSlot,
        bus,
    };
    assertRequiredDeps('createGenerateFloorUseCase', generateFloorDeps, REQUIRED_APP_DEPS.createGenerateFloorUseCase);
    const generateFloor = factories.createGenerateFloorUseCase(generateFloorDeps);
    slotEditor = createSlotEditorService({
        host, slotRepo, imageRepo,
        isBusy: (mid, records) => generateSlots.isWriting(mid) || generateFloor.isRunning(mid)
            || records.some((row) => renderSlot.isRendering(mid, row.slotId)
                || renderSlot.hasPendingWrite?.(mid, row.slotId)),
        onSaved: (messageId, records, snapshot) => bus.emit(APP_EVENTS.SLOTS_EDITED, {
            messageId, records, chatId: snapshot.chatId,
            removedIds: snapshot.records.filter((row) => !records.some((record) => record.slotId === row.slotId))
                .map((row) => row.slotId),
        }),
    });

    const storageCleanup = createStorageCleanupService({
        host,
        chatIndex,
        serverFiles,
    });

    const imageCacheTrim = createImageCacheTrimService({
        loadSettings,
        imageRepo,
        bus,
    });

    let disposed = false;

    /** @type {AppContainer} */
    const container = {
        host,
        imageGenPort,
        llm,
        bus,
        settingsStore,
        loadSettings,
        runHostMacros,
        serverFiles,
        marketCatalogStore: createMarketCatalogStore(serverFiles),
        /** 画师串示例图展示 URL（卡片/原图；UI 只经此注入，不直连存储适配器） */
        artistFileUrl: createArtistFileUrlResolver(imageRepo),
        /** 库/配置文档库健康状况（服务器加载失败时 ready=false，禁止种子写入） */
        libraryStorage: {
            ready: typeof docDb.ready === 'boolean' ? docDb.ready : true,
            getLoadReport: typeof docDb.getLoadReport === 'function'
                ? () => docDb.getLoadReport()
                : () => ({ ready: true, errors: [] }),
        },
        repos: {
            character: characterRepo,
            tag: tagRepo,
            artist: artistRepo,
            preset: presetRepo,
            slot: slotRepo,
            llmConfig: llmConfigRepo,
            naiConfig: naiConfigRepo,
            image: imageRepo,
        },
        services: {
            slotEditor,
            contextCollector,
            worldInfoResolver,
            tagRecall,
            imageGen,
            artistPreview,
            workbench,
            workbenchArtistDraft,
            autoTrigger,
            viewpointBlocks,
            storageCleanup,
            imageCacheTrim,
            chatIndex,
            llmSecrets,
        },
        useCases: {
            generateSlots,
            renderSlot,
            generateFloor,
        },
        shared: Object.freeze({ llm, tagRecall, bus }),
        dispose() {
            if (disposed) {
                return;
            }
            disposed = true;
            imageGen.dispose?.();
            try {
                autoTrigger.stop();
            } catch {
                // ignore
            }
            try {
                if (typeof imageRepo.revokeAllUrls === 'function') {
                    imageRepo.revokeAllUrls();
                }
            } catch {
                // ignore
            }
            try {
                bus.clear();
            } catch {
                // ignore
            }
            try {
                host.dispose();
            } catch {
                // ignore
            }
            if (ownsDb && db && typeof db.close === 'function') {
                try {
                    db.close();
                } catch {
                    // ignore
                }
            }
            if (ownsDocDb && docDb && typeof docDb.close === 'function') {
                try {
                    docDb.close();
                } catch {
                    // ignore
                }
            }
        },
    };

    return container;
}

/**
 * 删画师串时顺带删本机示例图（失败不阻断 remove）。
 * @param {import('../ports/repository.port.js').Repository<any>} repo
 * @param {{ remove?: Function }} imageRepo
 */
function wrapArtistRepoPreviewCleanup(repo, imageRepo) {
    return {
        ...repo,
        async remove(id) {
            /** @type {{ referenceImageRef?: string|null, cardImageRef?: string|null }|null} */
            let refs = null;
            try {
                const g = await repo.get(id);
                if (g?.ok && g.value) {
                    refs = {
                        referenceImageRef: g.value.referenceImageRef ?? null,
                        cardImageRef: g.value.cardImageRef ?? null,
                    };
                }
            } catch {
                // ignore
            }
            const r = await repo.remove(id);
            if (r?.ok && refs && typeof imageRepo?.remove === 'function') {
                try {
                    await imageRepo.remove(refs.referenceImageRef);
                    await imageRepo.remove(refs.cardImageRef);
                } catch {
                    // ignore
                }
            }
            return r;
        },
    };
}
