/**
 * 插件唯一入口：仅 bootstrap，不含业务。
 * 归属：W3-J 装配代理实现。W0 仅冻结签名。
 * manifest hooks.activate / disable 指向本模块导出。
 *
 * 酒馆有时只执行本文件、不调用 activate。脚本加载后自己启动一次。
 * 同一页再次调用（含酒馆钩子）共用这一次，停用后再启动才会重来。
 */

import { setLoadBanner } from './src/bootstrap/load-banner.js';

/** @type {Promise<void>|null} */
let boot = null;

/**
 * @param {object} [opts]
 * @returns {Promise<void>}
 */
export function activate(opts) {
    if (boot) {
        return boot;
    }
    boot = run(opts);
    return boot;
}

/**
 * @param {object} [opts]
 * @returns {Promise<void>}
 */
async function run(opts) {
    // 0.2.45：启动过程不再弹提示，只在失败时显示
    try {
        const mod = await import('./src/bootstrap/lifecycle.js');
        await mod.activate(opts);
    } catch (err) {
        boot = null;
        const message = err instanceof Error ? err.message : String(err);
        setLoadBanner(`酒馆数据库生图启动失败：${message}`, 'error');
        throw err;
    }
}

export async function dispose() {
    const mod = await import('./src/bootstrap/lifecycle.js');
    try {
        await mod.dispose();
    } finally {
        boot = null;
    }
}

activate().catch(() => {});
