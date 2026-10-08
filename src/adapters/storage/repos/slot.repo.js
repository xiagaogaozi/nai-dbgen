/**
 * L2 适配器 · 每会话一份生图记录（服务器文件）。
 * 权威记录按会话文件存储。主键为会话内 slotId。
 *
 * 读失败（非 404）→ Err，且不得用空数据覆盖服务器文件。
 * 写操作可指定 sessionId：切会话后仍落到发起时的会话文件，且不污染当前内存缓存。
 */

import { Ok, Err, isErr } from '../../../infra/result.js';
import { configError, hostError } from '../../../infra/errors.js';
import { nowIso as defaultNowIso } from '../../../infra/clock.js';
import {
    appendSlotImage,
    validateSlotRecord,
} from '../../../domain/model/slot.js';
import {
    chatSlotFileName,
    createChatSlotFile,
    parseChatSlotFile,
} from '../../../domain/slot/session-files.js';
import {
    retainedAiMessageIds,
    trimRecordsByMessageIds,
} from '../../../domain/slot/session-retain.js';
import { appendPromptCall, normalizePromptCalls } from '../../../domain/blocks/recent-prompt-calls.js';
import { catchToResult, createChangeEmitter } from '../import-export.js';

/**
 * @typedef {import('../../../domain/model/slot.js').SlotRecord} SlotRecord
 * @typedef {import('../../../domain/model/slot.js').ImageRef} ImageRef
 */

/**
 * @param {object} deps
 * @param {{ readJson: Function, writeJson: Function, remove: Function }} deps.serverFiles
 * @param {ReturnType<import('../chat-index.store.js').createChatIndexStore>} deps.chatIndex
 * @param {import('../../../ports/host.port.js').HostPort} deps.host
 * @param {() => import('../../../domain/model/plugin-settings.js').PluginSettings} deps.loadSettings
 * @param {{ clearSlot?: Function, collectLiveImageRefs?: Function, linkSlot?: Function }} [deps.imageRepo]
 * @param {() => string} [deps.nowIso]
 * @param {object} [deps.bus]
 * @returns {import('../../../ports/repository.port.js').SlotRepository & {
 *   ensureLoaded: () => Promise<import('../../../infra/result.js').Ok<void>|import('../../../infra/result.js').Err<import('../../../infra/errors.js').AppError>>,
 *   getLoadError: () => import('../../../infra/errors.js').AppError|null,
 *   getSessionId: () => string|null,
 *   listRetained: () => Promise<import('../../../infra/result.js').Ok<SlotRecord[]>|import('../../../infra/result.js').Err<import('../../../infra/errors.js').AppError>>,
 *   deleteSessionFile: (sessionId: string) => Promise<import('../../../infra/result.js').Ok<void>|import('../../../infra/result.js').Err<import('../../../infra/errors.js').AppError>>,
 * }}
 */
export function createSlotRepo(deps) {
    const serverFiles = deps?.serverFiles;
    const chatIndex = deps?.chatIndex;
    const host = deps?.host;
    const loadSettings = deps?.loadSettings;
    if (!serverFiles || typeof serverFiles.readJson !== 'function') {
        throw new Error('createSlotRepo requires deps.serverFiles');
    }
    if (!chatIndex || typeof chatIndex.register !== 'function') {
        throw new Error('createSlotRepo requires deps.chatIndex');
    }
    if (!host || typeof host.getSessionId !== 'function') {
        throw new Error('createSlotRepo requires deps.host with getSessionId');
    }
    if (typeof loadSettings !== 'function') {
        throw new Error('createSlotRepo requires deps.loadSettings');
    }

    const nowIso = typeof deps.nowIso === 'function' ? deps.nowIso : defaultNowIso;
    const imageRepo = deps.imageRepo || null;
    const changes = createChangeEmitter();

    /** @type {string|null} */
    let sessionId = null;
    /** @type {Map<number, SlotRecord>} */
    let slotsById = new Map();
    /** @type {ReturnType<typeof appendPromptCall>} */
    let promptCalls = [];
    /** @type {import('../../../infra/errors.js').AppError|null} */
    let loadError = null;
    /** @type {boolean} */
    let loaded = false;
    /** 会话切换代数：使进行中的异步写在落盘后跳过污染当前缓存 */
    let loadGeneration = 0;
    /** 串行化 ensureLoaded，避免 A/B 并行 load 交错写缓存 */
    /** @type {Promise<unknown>} */
    let loadChain = Promise.resolve();
    let mutationChain = Promise.resolve();

    /**
     * @param {unknown} err
     */
    function mapErr(err) {
        if (err && typeof err === 'object' && 'category' in err && 'code' in err) {
            return /** @type {import('../../../infra/errors.js').AppError} */ (err);
        }
        return hostError({
            code: 'SLOT_REPO_ERROR',
            message: err instanceof Error ? err.message : String(err ?? 'slot 仓库错误'),
            cause: err,
        });
    }

    /**
     * @returns {string|null}
     */
    function readHostSessionId() {
        const sidResult = host.getSessionId();
        const sid = sidResult && typeof sidResult === 'object' && 'ok' in sidResult
            ? (sidResult.ok ? sidResult.value : null)
            : sidResult;
        if (sid == null || sid === '') {
            return null;
        }
        return String(sid);
    }

    /**
     * @returns {number}
     */
    function retainWindow() {
        try {
            const n = Number(loadSettings()?.contextWindowSize);
            return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 5;
        } catch {
            return 5;
        }
    }

    /**
     * @param {SlotRecord[]} records
     * @param {import('../../../ports/host.port.js').HostMessage[]|null|undefined} messages
     * @returns {SlotRecord[]}
     */
    function applyTrim(records, messages) {
        const msgs = Array.isArray(messages)
            ? messages
            : (typeof host.getMessages === 'function' ? host.getMessages() : []);
        const keep = retainedAiMessageIds(msgs, retainWindow());
        return trimRecordsByMessageIds(records, keep).kept;
    }

    /**
     * @param {SlotRecord[]} records
     */
    function setCache(records) {
        slotsById = new Map();
        for (const rec of records) {
            slotsById.set(Number(rec.slotId), rec);
        }
    }

    /**
     * @returns {SlotRecord[]}
     */
    function allRecords() {
        return [...slotsById.values()].sort((a, b) => a.slotId - b.slotId);
    }

    /**
     * @param {unknown} rawSlots
     * @returns {SlotRecord[]}
     */
    function validateSlotList(rawSlots) {
        /** @type {SlotRecord[]} */
        const validated = [];
        if (!Array.isArray(rawSlots)) {
            return validated;
        }
        for (const raw of rawSlots) {
            const v = validateSlotRecord(raw);
            if (v.ok) {
                validated.push(v.value);
            }
        }
        return validated;
    }

    /**
     * 只读某会话文件记录（不改当前缓存）。404 → []；损坏 / 读失败 → throw AppError。
     * @param {string} sid
     * @returns {Promise<SlotRecord[]>}
     */
    async function readSessionRecords(sid) {
        const fileName = chatSlotFileName(sid);
        const r = await serverFiles.readJson(fileName);
        if (isErr(r)) {
            throw r.error;
        }
        if (r.value == null) {
            return [];
        }
        const parsed = parseChatSlotFile(r.value);
        if (!parsed.ok) {
            throw hostError({
                code: 'CHAT_SLOT_FILE_CORRUPT',
                message: '会话生图记录文件损坏',
                hint: '请勿手动编辑该文件；读取失败时不会清空已有数据',
                context: { sessionId: sid, reason: parsed.reason },
            });
        }
        return validateSlotList(parsed.value.slots);
    }

    /**
     * 先登记目录，再写会话文件。
     * @param {string} sid
     * @param {SlotRecord[]} records
     * @param {{ chatFileName?: string|null, avatarUrl?: string|null, groupId?: string|null }|null} [locationOverride]
     */
    async function persist(sid, records, locationOverride) {
        const fileName = chatSlotFileName(sid);
        const updatedAt = nowIso();

        /** @type {{ chatFileName: string|null, avatarUrl: string|null, groupId: string|null }} */
        let location = { chatFileName: null, avatarUrl: null, groupId: null };
        if (locationOverride && typeof locationOverride === 'object') {
            location = {
                chatFileName: locationOverride.chatFileName ?? null,
                avatarUrl: locationOverride.avatarUrl ?? null,
                groupId: locationOverride.groupId ?? null,
            };
        } else if (sessionId === sid && typeof host.getChatLocation === 'function') {
            const cur = host.getChatLocation();
            location = {
                chatFileName: cur?.chatFileName ?? null,
                avatarUrl: cur?.avatarUrl ?? null,
                groupId: cur?.groupId ?? null,
            };
        } else {
            const existing = await chatIndex.findBySessionId(sid);
            if (!isErr(existing) && existing.value) {
                location = {
                    chatFileName: existing.value.chatFileName ?? null,
                    avatarUrl: existing.value.avatarUrl ?? null,
                    groupId: existing.value.groupId ?? null,
                };
            }
        }

        const reg = await chatIndex.register({
            sessionId: sid,
            fileName,
            updatedAt,
            chatFileName: location.chatFileName,
            avatarUrl: location.avatarUrl,
            groupId: location.groupId,
        });
        if (isErr(reg)) {
            throw reg.error;
        }

        const payload = createChatSlotFile({
            sessionId: sid,
            updatedAt,
            slots: records,
            promptCalls,
        });
        const w = await serverFiles.writeJson(fileName, payload);
        if (isErr(w)) {
            throw w.error;
        }
    }

    /**
     * @param {string} sid
     * @param {number} expectedGen
     */
    async function loadSession(sid, expectedGen) {
        const fileName = chatSlotFileName(sid);
        const r = await serverFiles.readJson(fileName);
        if (expectedGen !== loadGeneration) {
            return Ok(undefined);
        }
        if (isErr(r)) {
            loadError = r.error;
            loaded = true;
            sessionId = sid;
            slotsById = new Map();
            promptCalls = [];
            return Err(r.error);
        }
        if (r.value == null) {
            loadError = null;
            loaded = true;
            sessionId = sid;
            slotsById = new Map();
            promptCalls = [];
            return Ok(undefined);
        }
        const parsed = parseChatSlotFile(r.value);
        if (!parsed.ok) {
            const err = hostError({
                code: 'CHAT_SLOT_FILE_CORRUPT',
                message: '会话生图记录文件损坏',
                hint: '请勿手动编辑该文件；读取失败时不会清空已有数据',
                context: { sessionId: sid, reason: parsed.reason },
            });
            if (expectedGen !== loadGeneration) {
                return Ok(undefined);
            }
            loadError = err;
            loaded = true;
            sessionId = sid;
            slotsById = new Map();
            promptCalls = [];
            return Err(err);
        }

        const validated = validateSlotList(parsed.value.slots);
        promptCalls = normalizePromptCalls(parsed.value.promptCalls);
        if (expectedGen !== loadGeneration) {
            return Ok(undefined);
        }

        const trimmed = applyTrim(validated);
        const removed = validated.filter((a) => !trimmed.some((b) => b.slotId === a.slotId));
        setCache(trimmed);
        loadError = null;
        loaded = true;
        sessionId = sid;

        if (removed.length > 0) {
            try {
                await persist(sid, trimmed);
            } catch (err) {
                void err;
            }
        }

        return Ok(undefined);
    }

    async function ensureLoaded() {
        const nextId = readHostSessionId();
        if (nextId == null) {
            loadGeneration += 1;
            loadError = hostError({
                code: 'SESSION_ID_MISSING',
                message: '当前没有可用的会话 id',
                hint: '请先打开一个聊天',
            });
            loaded = true;
            sessionId = null;
            slotsById = new Map();
            promptCalls = [];
            return Err(loadError);
        }

        const run = async () => {
            if (loaded && sessionId === nextId && !loadError) {
                return Ok(undefined);
            }
            if (sessionId !== nextId) {
                loadGeneration += 1;
                loaded = false;
                loadError = null;
                slotsById = new Map();
                promptCalls = [];
                sessionId = nextId;
            }
            const myGen = loadGeneration;
            return loadSession(nextId, myGen);
        };

        const task = loadChain.then(run, run);
        loadChain = task.then(() => undefined, () => undefined);
        return task;
    }

    /**
     * 编号复用：清掉旧记录对应缓存图。
     * @param {number} slotId
     * @param {string} sid
     */
    async function clearReusedSlotCache(slotId, sid) {
        if (imageRepo && typeof imageRepo.clearSlot === 'function') {
            try {
                await imageRepo.clearSlot(sid, slotId);
            } catch {
                // ignore
            }
        }
    }

    /**
     * @param {string} sid
     * @returns {Promise<Map<number, SlotRecord>>}
     */
    async function baseMapForSession(sid) {
        if (loaded && sessionId === sid && !loadError) {
            return new Map(slotsById);
        }
        const records = await readSessionRecords(sid);
        /** @type {Map<number, SlotRecord>} */
        const map = new Map();
        for (const rec of records) {
            map.set(Number(rec.slotId), rec);
        }
        return map;
    }

    /**
     * @param {string} sid
     * @param {SlotRecord[]} trimmed
     * @param {number} genAtStart
     */
    function applyCacheIfCurrent(sid, trimmed, genAtStart) {
        if (sessionId === sid && loadGeneration === genAtStart && loaded) {
            setCache(trimmed);
            loadError = null;
        }
    }

    /**
     * 同一楼多张图只写一次会话文件。
     * @param {number} messageId
     * @param {Array<{ slotId: number, imageRef: string, meta?: object }>} entries
     * @param {{ sessionId?: string, messagesForTrim?: import('../../../ports/host.port.js').HostMessage[], chatLocation?: { chatFileName?: string|null, avatarUrl?: string|null, groupId?: string|null } }} [opts]
     */
    async function commitSlotImages(messageId, entries, opts) {
        const list = Array.isArray(entries) ? entries : [];
        if (!list.length) {
            return Ok([]);
        }
        for (const entry of list) {
            if (entry?.imageRef == null || entry.imageRef === '') {
                return Err(configError({
                    code: 'SLOT_IMAGE_REF',
                    message: '缺少图片引用',
                }));
            }
        }
        return catchToResult(async () => {
            const sidOverride = opts?.sessionId != null && String(opts.sessionId) !== ''
                ? String(opts.sessionId)
                : null;
            const messagesSnap = Array.isArray(opts?.messagesForTrim)
                ? opts.messagesForTrim
                : null;
            const locationSnap = opts?.chatLocation ?? null;

            let sid = sidOverride;
            if (!sid) {
                const ready = await ensureLoaded();
                if (isErr(ready)) {
                    throw ready.error;
                }
                if (loadError) {
                    throw loadError;
                }
                sid = sessionId;
            }
            if (!sid) {
                throw hostError({
                    code: 'SESSION_ID_MISSING',
                    message: '当前没有可用的会话 id',
                });
            }
            const genAtStart = loadGeneration;
            const nextMap = await baseMapForSession(sid);
            /** @type {import('../../../domain/model/slot.js').SlotRecord[]} */
            const persisted = [];
            for (const entry of list) {
                const id = Number(entry.slotId);
                const cur = nextMap.get(id);
                if (!cur) {
                    throw hostError({
                        code: 'SLOT_NOT_FOUND',
                        message: '找不到对应生图记录',
                        hint: '请先生成生图提示词',
                        context: { messageId, slotId: id, sessionId: sid },
                    });
                }
                const imageEntry = {
                    imageRef: String(entry.imageRef),
                    createdAt: nowIso(),
                    naiConfigId: entry.meta?.naiConfigId == null ? null : String(entry.meta.naiConfigId),
                    artistId: entry.meta?.artistId == null ? null : String(entry.meta.artistId),
                };
                const next = appendSlotImage(cur, imageEntry);
                nextMap.set(id, next);
            }
            const trimmed = applyTrim(
                [...nextMap.values()].sort((a, b) => a.slotId - b.slotId),
                messagesSnap,
            );
            await persist(sid, trimmed, locationSnap);
            applyCacheIfCurrent(sid, trimmed, genAtStart);
            for (const entry of list) {
                const id = Number(entry.slotId);
                const row = trimmed.find((r) => r.slotId === id);
                if (!row) {
                    throw hostError({
                        code: 'SLOT_TRIMMED',
                        message: '该图已超出保留范围，图片未写入记录',
                        context: { messageId, slotId: id, sessionId: sid },
                    });
                }
                persisted.push(row);
                if (imageRepo && typeof imageRepo.linkSlot === 'function') {
                    await imageRepo.linkSlot(sid, id, String(entry.imageRef));
                }
            }
            changes.emit({ type: 'recordImage', messageId: Number(messageId), sessionId: sid });
            return persisted;
        }, mapErr, Ok, Err);
    }

    const repo = {
        ensureLoaded,
        getLoadError() {
            return loadError;
        },
        getSessionId() {
            return sessionId;
        },

        async listRetained() {
            const ready = await ensureLoaded();
            if (isErr(ready)) {
                return ready;
            }
            if (loadError) {
                return Err(loadError);
            }
            return Ok(applyTrim(allRecords()));
        },

        async listRecentPromptCalls() {
            const ready = await ensureLoaded();
            if (isErr(ready)) {
                return ready;
            }
            if (loadError) {
                return Err(loadError);
            }
            return Ok(promptCalls.map((call) => ({
                at: call.at,
                items: call.items.map((item) => ({ ...item })),
            })));
        },

        /**
         * @param {{ items?: Array<{ slotId: number, caption: object, size?: string, analysis?: string }> }} input
         */
        async recordPromptCall(input) {
            return catchToResult(async () => {
                const ready = await ensureLoaded();
                if (isErr(ready)) {
                    throw ready.error;
                }
                if (loadError) {
                    throw loadError;
                }
                const sid = sessionId;
                if (!sid) {
                    throw hostError({
                        code: 'SESSION_ID_MISSING',
                        message: '当前没有可用的会话 id',
                        hint: '请先打开一个聊天',
                    });
                }
                promptCalls = appendPromptCall(promptCalls, {
                    at: nowIso(),
                    items: input?.items,
                });
                await persist(sid, allRecords());
                return promptCalls;
            }, mapErr, Ok, Err);
        },

        async deleteSessionFile(targetSessionId) {
            const sid = String(targetSessionId ?? '');
            if (!sid) {
                return Ok(undefined);
            }
            const fileName = chatSlotFileName(sid);
            const rm = await serverFiles.remove(fileName);
            if (isErr(rm)) {
                return rm;
            }
            const un = await chatIndex.unregister(sid);
            if (isErr(un)) {
                return un;
            }
            if (sessionId === sid) {
                slotsById = new Map();
                promptCalls = [];
                loaded = false;
                loadError = null;
                loadGeneration += 1;
            }
            return Ok(undefined);
        },

        /**
         * 删掉这一楼的全部生图记录，并清掉对应图片。
         * @param {number} messageId
         */
        async removeByMessage(messageId) {
            return catchToResult(async () => {
                const ready = await ensureLoaded();
                if (isErr(ready)) {
                    throw ready.error;
                }
                if (loadError) {
                    throw loadError;
                }
                const sid = sessionId;
                if (!sid) {
                    throw hostError({
                        code: 'SESSION_ID_MISSING',
                        message: '当前没有可用的会话 id',
                    });
                }
                const genAtStart = loadGeneration;
                const mid = Number(messageId);
                const nextMap = await baseMapForSession(sid);
                /** @type {SlotRecord[]} */
                const removed = [];
                for (const [slotId, rec] of nextMap) {
                    if (rec && rec.messageId === mid) {
                        removed.push(rec);
                        nextMap.delete(slotId);
                    }
                }
                const trimmed = applyTrim(
                    [...nextMap.values()].sort((a, b) => a.slotId - b.slotId),
                    null,
                );
                await persist(sid, trimmed, null);
                applyCacheIfCurrent(sid, trimmed, genAtStart);
                for (const rec of removed) {
                    await clearReusedSlotCache(rec.slotId, sid);
                    const images = Array.isArray(rec.images) ? rec.images : [];
                    for (const entry of images) {
                        if (entry?.imageRef && imageRepo && typeof imageRepo.remove === 'function') {
                            await imageRepo.remove(entry.imageRef);
                        }
                    }
                }
                changes.emit({ type: 'remove', messageId: mid, sessionId: sid });
            }, mapErr, Ok, Err);
        },

        async getByMessage(messageId) {
            return catchToResult(async () => {
                const ready = await ensureLoaded();
                if (isErr(ready)) {
                    throw ready.error;
                }
                if (loadError) {
                    throw loadError;
                }
                const mid = Number(messageId);
                return allRecords().filter((r) => r.messageId === mid);
            }, mapErr, Ok, Err);
        },

        async get(messageId, slotId) {
            return catchToResult(async () => {
                const ready = await ensureLoaded();
                if (isErr(ready)) {
                    throw ready.error;
                }
                if (loadError) {
                    throw loadError;
                }
                const rec = slotsById.get(Number(slotId)) || null;
                if (!rec) {
                    return null;
                }
                // 端口保留 messageId 参数：若记录存在但楼号不符仍返回（会话内 slotId 唯一）
                void messageId;
                return rec;
            }, mapErr, Ok, Err);
        },

        /**
         * @param {number} messageId
         * @param {SlotRecord[]} records
         * @param {{ sessionId?: string, messagesForTrim?: import('../../../ports/host.port.js').HostMessage[], chatLocation?: { chatFileName?: string|null, avatarUrl?: string|null, groupId?: string|null } }} [opts]
         */
        async put(messageId, records, opts) {
            if (!Array.isArray(records)) {
                return Err(configError({
                    code: 'SLOT_PUT_SHAPE',
                    message: 'Slot 写入必须是数组',
                }));
            }
            return catchToResult(async () => {
                const sidOverride = opts?.sessionId != null && String(opts.sessionId) !== ''
                    ? String(opts.sessionId)
                    : null;
                const messagesSnap = Array.isArray(opts?.messagesForTrim)
                    ? opts.messagesForTrim
                    : null;
                const locationSnap = opts?.chatLocation ?? null;

                let sid = sidOverride;
                if (!sid) {
                    const ready = await ensureLoaded();
                    if (isErr(ready)) {
                        throw ready.error;
                    }
                    if (loadError) {
                        throw loadError;
                    }
                    sid = sessionId;
                }
                if (!sid) {
                    throw hostError({
                        code: 'SESSION_ID_MISSING',
                        message: '当前没有可用的会话 id',
                    });
                }
                const genAtStart = loadGeneration;

                const mid = Number(messageId);
                /** @type {SlotRecord[]} */
                const validated = [];
                for (const raw of records) {
                    const withMsg = { ...raw, messageId: mid };
                    const v = validateSlotRecord(withMsg);
                    if (!v.ok) {
                        throw v.error;
                    }
                    validated.push(v.value);
                }

                const nextMap = await baseMapForSession(sid);
                for (const rec of validated) {
                    const prev = nextMap.get(rec.slotId);
                    if (prev && prev.messageId !== rec.messageId) {
                        // 编号复用：旧记录属于别的楼 → 清缓存图
                        await clearReusedSlotCache(rec.slotId, sid);
                    }
                    nextMap.set(rec.slotId, rec);
                }

                const trimmed = applyTrim(
                    [...nextMap.values()].sort((a, b) => a.slotId - b.slotId),
                    messagesSnap,
                );
                await persist(sid, trimmed, locationSnap);
                applyCacheIfCurrent(sid, trimmed, genAtStart);
                changes.emit({ type: 'put', messageId: mid, sessionId: sid });
            }, mapErr, Ok, Err);
        },

        /**
         * @param {number} messageId
         * @param {number} slotId
         * @param {string} imageRef
         * @param {object} [meta]
         * @param {{ sessionId?: string, messagesForTrim?: import('../../../ports/host.port.js').HostMessage[], chatLocation?: { chatFileName?: string|null, avatarUrl?: string|null, groupId?: string|null } }} [opts]
         */
        async recordImage(messageId, slotId, imageRef, meta, opts) {
            const written = await commitSlotImages(
                messageId,
                [{ slotId, imageRef, meta }],
                opts,
            );
            if (!written.ok) {
                return written;
            }
            return Ok(written.value[0]);
        },

        recordImages(messageId, entries, opts) {
            return commitSlotImages(messageId, entries, opts);
        },

        async replaceMessageRecords(messageId, records, opts = {}) {
            return catchToResult(async () => {
                const sid = String(opts.sessionId || readHostSessionId() || '');
                if (!sid) throw hostError({ code: 'SESSION_ID_MISSING', message: '当前没有可用的会话 id' });
                const mid = Number(messageId);
                const gen = loadGeneration;
                const nextMap = await baseMapForSession(sid);
                const previous = [...nextMap.values()].filter((row) => row.messageId === mid)
                    .sort((a, b) => a.slotId - b.slotId);
                if (opts.expectedRecords
                    && JSON.stringify(previous) !== JSON.stringify(opts.expectedRecords)) {
                    throw hostError({ code: 'SLOT_EDIT_CONFLICT', message: '提示词或图片记录已变化，请重新打开编辑器' });
                }
                for (const row of previous) nextMap.delete(row.slotId);
                const seen = new Set();
                for (const record of records) {
                    const checked = validateSlotRecord({ ...record, messageId: mid });
                    if (!checked.ok) throw checked.error;
                    const row = checked.value;
                    if (seen.has(row.slotId) || nextMap.has(row.slotId)) {
                        throw hostError({ code: 'SLOT_EDIT_ID', message: '图片编号重复或属于其他楼层' });
                    }
                    seen.add(row.slotId);
                    nextMap.set(row.slotId, row);
                }
                const next = [...nextMap.values()].sort((a, b) => a.slotId - b.slotId);
                await persist(sid, next, opts.chatLocation);
                applyCacheIfCurrent(sid, next, gen);
                changes.emit({ type: 'edit', messageId: mid, sessionId: sid });
                return next.filter((row) => row.messageId === mid);
            }, mapErr, Ok, Err);
        },

        onChanged(fn) {
            return changes.subscribe(fn);
        },
    };
    // Serialize the whole read-modify-write transaction, not merely the final upload.
    for (const name of ['put', 'recordImage', 'recordImages', 'replaceMessageRecords', 'removeByMessage', 'deleteSessionFile']) {
        const method = repo[name];
        repo[name] = (...args) => {
            const task = mutationChain.then(() => method(...args));
            mutationChain = task.then(() => undefined, () => undefined);
            return task;
        };
    }
    return repo;
}
