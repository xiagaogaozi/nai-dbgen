/**
 * L3 领域层 · 会话生图记录 / 目录文件名与 JSON 形状（纯函数）。
 */

import { isPlainObject, requireArg } from '../../infra/validate.js';
import { normalizePromptCalls } from '../blocks/recent-prompt-calls.js';

/** 目录文件固定名 */
export const CHAT_INDEX_FILE_NAME = 'nai-dbgen_index.json';

/** 会话文件名前缀 */
export const CHAT_SLOT_FILE_PREFIX = 'nai-dbgen_chat_';

export const CHAT_SLOT_SCHEMA_VERSION = 1;
export const CHAT_INDEX_SCHEMA_VERSION = 1;

/**
 * 将会话 id（integrity）安全化为文件名片段。
 * @param {string} sessionId
 * @returns {string}
 */
export function sanitizeSessionIdForFile(sessionId) {
    const raw = String(sessionId ?? '');
    const cleaned = raw.replace(/[^A-Za-z0-9_\-.]+/g, '_').replace(/_+/g, '_');
    if (!cleaned || cleaned === '.' || cleaned === '..') {
        throw new Error('invalid sessionId for file name');
    }
    return cleaned.slice(0, 120);
}

/**
 * @param {string} sessionId
 * @returns {string} 如 nai-dbgen_chat_<id>.json
 */
export function chatSlotFileName(sessionId) {
    return `${CHAT_SLOT_FILE_PREFIX}${sanitizeSessionIdForFile(sessionId)}.json`;
}

/**
 * @typedef {object} ChatSlotFile
 * @property {number} schemaVersion
 * @property {string} sessionId
 * @property {string} updatedAt
 * @property {import('../model/slot.js').SlotRecord[]} slots
 * @property {ReturnType<typeof normalizePromptCalls>} promptCalls 外部写词最近几次的生图内容
 */

/**
 * @typedef {object} ChatIndexEntry
 * @property {string} sessionId
 * @property {string} fileName
 * @property {string} updatedAt
 * @property {string|null} chatFileName 酒馆聊天文件名（无 .jsonl）
 * @property {string|null} avatarUrl 角色头像（单聊）
 * @property {string|null} groupId 群组 id
 */

/**
 * @typedef {object} ChatIndexFile
 * @property {number} schemaVersion
 * @property {ChatIndexEntry[]} chats
 */

/**
 * @param {object} input
 * @returns {ChatSlotFile}
 */
export function createChatSlotFile(input) {
    requireArg(isPlainObject(input), 'input');
    return {
        schemaVersion: CHAT_SLOT_SCHEMA_VERSION,
        sessionId: String(input.sessionId ?? ''),
        updatedAt: String(input.updatedAt ?? ''),
        slots: Array.isArray(input.slots) ? input.slots : [],
        promptCalls: normalizePromptCalls(input.promptCalls),
    };
}

/**
 * @param {unknown} raw
 * @returns {{ ok: true, value: ChatSlotFile } | { ok: false, reason: string }}
 */
export function parseChatSlotFile(raw) {
    if (raw == null) {
        return { ok: false, reason: 'null' };
    }
    if (!isPlainObject(raw)) {
        return { ok: false, reason: 'not_object' };
    }
    if (raw.slots != null && !Array.isArray(raw.slots)) {
        return { ok: false, reason: 'slots_not_array' };
    }
    return {
        ok: true,
        value: createChatSlotFile(raw),
    };
}

/**
 * @param {object} [input]
 * @returns {ChatIndexFile}
 */
export function createChatIndexFile(input) {
    const src = isPlainObject(input) ? input : {};
    return {
        schemaVersion: CHAT_INDEX_SCHEMA_VERSION,
        chats: Array.isArray(src.chats) ? src.chats.map(normalizeIndexEntry).filter(Boolean) : [],
    };
}

/**
 * @param {unknown} raw
 * @returns {ChatIndexEntry|null}
 */
function normalizeIndexEntry(raw) {
    if (!isPlainObject(raw) || raw.sessionId == null || raw.sessionId === '') {
        return null;
    }
    return {
        sessionId: String(raw.sessionId),
        fileName: String(raw.fileName ?? chatSlotFileName(String(raw.sessionId))),
        updatedAt: String(raw.updatedAt ?? ''),
        chatFileName: raw.chatFileName == null || raw.chatFileName === ''
            ? null
            : String(raw.chatFileName),
        avatarUrl: raw.avatarUrl == null || raw.avatarUrl === ''
            ? null
            : String(raw.avatarUrl),
        groupId: raw.groupId == null || raw.groupId === ''
            ? null
            : String(raw.groupId),
    };
}

/**
 * @param {unknown} raw
 * @returns {{ ok: true, value: ChatIndexFile } | { ok: false, reason: string }}
 */
export function parseChatIndexFile(raw) {
    if (raw == null) {
        return { ok: true, value: createChatIndexFile() };
    }
    if (!isPlainObject(raw)) {
        return { ok: false, reason: 'not_object' };
    }
    if (raw.chats != null && !Array.isArray(raw.chats)) {
        return { ok: false, reason: 'chats_not_array' };
    }
    return { ok: true, value: createChatIndexFile(raw) };
}

/**
 * 在目录中登记或更新一条（按 sessionId upsert）。
 * @param {ChatIndexFile} index
 * @param {ChatIndexEntry} entry
 * @returns {ChatIndexFile}
 */
export function upsertIndexEntry(index, entry) {
    const base = createChatIndexFile(index);
    const next = normalizeIndexEntry(entry);
    if (!next) {
        return base;
    }
    const chats = base.chats.filter((c) => c.sessionId !== next.sessionId);
    chats.push(next);
    return { schemaVersion: CHAT_INDEX_SCHEMA_VERSION, chats };
}

/**
 * @param {ChatIndexFile} index
 * @param {string} sessionId
 * @returns {ChatIndexFile}
 */
export function removeIndexEntry(index, sessionId) {
    const base = createChatIndexFile(index);
    const id = String(sessionId ?? '');
    return {
        schemaVersion: CHAT_INDEX_SCHEMA_VERSION,
        chats: base.chats.filter((c) => c.sessionId !== id),
    };
}
