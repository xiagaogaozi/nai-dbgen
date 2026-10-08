/**
 * L4 应用层 · 最近 N 条 AI 回复楼 + 剥 slot（需求 4.6 / 4.16）。
 * 归属：W2-F 用例代理实现。W0 仅冻结签名。
 *
 * 可选 `messageId`：以该楼为视点，取该楼起往前最近 N 条 AI 回复楼。
 * 缺省行为不变（仍走 host.getRecentAiMessages）。
 */

import { stripSlotTokens } from '../domain/slot/slot-token.js';
import { formatContextBlock } from '../domain/blocks/context.block.js';

/**
 * @typedef {import('../domain/model/plugin-settings.js').PluginSettings} PluginSettings
 */

/**
 * @typedef {object} ContextCollectorDeps
 * @property {import('../ports/host.port.js').HostPort} host
 * @property {() => PluginSettings} loadSettings 读 contextWindowSize（默认 5）
 */

/**
 * @typedef {object} ContextWindow
 * @property {import('../ports/host.port.js').HostMessage[]} messages 已剥 slot 的副本
 * @property {string} text 格式化前的拼接用文本（或由 block 层格式化）
 */

/**
 * @typedef {object} ContextCollectOpts
 * @property {number} [n] 覆盖 settings.contextWindowSize
 * @property {number} [messageId] 视点楼；缺省 = 最新 AI 回复窗（getRecentAiMessages）
 */

/**
 * @param {ContextCollectorDeps} deps
 * @returns {{ collect: (opts?: ContextCollectOpts) => ContextWindow }}
 */
export function createContextCollector(deps) {
    return {
        /**
         * @param {ContextCollectOpts} [opts]
         * @returns {ContextWindow}
         */
        collect(opts) {
            const settings = deps.loadSettings();
            const n = typeof opts?.n === 'number' && opts.n >= 0
                ? opts.n
                : (Number(settings.contextWindowSize) || 5);

            /** @type {import('../ports/host.port.js').HostMessage[]} */
            let raw;
            if (opts?.messageId != null && Number.isInteger(Number(opts.messageId))) {
                raw = collectFromViewpoint(deps.host, Number(opts.messageId), n);
            } else {
                raw = deps.host.getRecentAiMessages(n) ?? [];
            }

            /** @type {import('../ports/host.port.js').HostMessage[]} */
            const messages = raw.map((m) => ({
                ...m,
                text: stripSlotTokens(m?.text ?? ''),
            }));
            // messages 保持新→旧，世界书扫描要最新楼在前。
            // 写进「当前上下文」的正文按时间从早到晚，最新楼在最后。
            const text = formatContextBlock([...messages].reverse());
            return { messages, text };
        },
    };
}

/**
 * 以 messageId 为视点，往前取最近 n 条 AI 回复楼（含视点楼若其为 AI），新→旧。
 * @param {import('../ports/host.port.js').HostPort} host
 * @param {number} messageId
 * @param {number} n
 * @returns {import('../ports/host.port.js').HostMessage[]}
 */
function collectFromViewpoint(host, messageId, n) {
    const limit = Math.max(0, Math.floor(n));
    if (limit === 0) {
        return [];
    }
    const all = host.getMessages() ?? [];
    /** @type {Map<number, import('../ports/host.port.js').HostMessage>} */
    const byId = new Map();
    for (const m of all) {
        if (m && Number.isInteger(m.messageId)) {
            byId.set(m.messageId, m);
        }
    }
    // 若 getMessages 按下标存，也尝试按下标取
    if (!byId.has(messageId) && messageId >= 0 && messageId < all.length) {
        const indexed = all[messageId];
        if (indexed) {
            byId.set(messageId, { ...indexed, messageId });
        }
    }
    if (!byId.has(messageId) && typeof host.getMessage === 'function') {
        const one = host.getMessage(messageId);
        if (one) {
            byId.set(messageId, one);
        }
    }
    if (!byId.has(messageId)) {
        return [];
    }

    /** @type {import('../ports/host.port.js').HostMessage[]} */
    const out = [];
    for (let i = messageId; i >= 0 && out.length < limit; i -= 1) {
        const m = byId.get(i) ?? (i < all.length ? all[i] : null);
        if (!m) {
            continue;
        }
        if (m.isUser || m.isSystem) {
            continue;
        }
        out.push({
            ...m,
            messageId: Number.isInteger(m.messageId) ? m.messageId : i,
        });
    }
    return out;
}
