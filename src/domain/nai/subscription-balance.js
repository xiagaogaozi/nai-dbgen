/**
 * GET /user/subscription 的余额解读。
 * 文档：docs/nai-official/接口文档.md · `user.SubscriptionResponse`
 * - 电量：`usage`（Opus V5 用量）。`percent` 为当前电量 [0-100+]；
 *   `isNegative === true` 表示不可用；`timeUntilNextPercent` 为距下次 +1% 的秒数，
 *   0 表示已满、暂停回充。
 * - 点数：Anlas = `trainingStepsLeft.fixedTrainingStepsLeft`（订阅，按月重置）
 *   + `trainingStepsLeft.purchasedTrainingSteps`（购买）。
 */

/**
 * @typedef {object} SubscriptionEnergy
 * @property {number|null} percent
 * @property {boolean} unavailable
 * @property {number|null} refillSeconds
 */

/**
 * @typedef {object} SubscriptionBalance
 * @property {SubscriptionEnergy|null} energy
 * @property {number} fixedAnlas
 * @property {number} purchasedAnlas
 * @property {number} points
 */

/**
 * 把接口根地址收成 `GET /user/subscription`。
 * 接受官方根地址，也接受已经写成 `/ai` 或 `/ai/generate-image` 的地址。
 * @param {string} baseUrl
 * @returns {string}
 */
export function resolveSubscriptionUrl(baseUrl) {
    const trimmed = String(baseUrl || '').trim().replace(/\/+$/, '')
        .replace(/\/ai\/generate-image$/i, '')
        .replace(/\/ai$/i, '');
    return `${trimmed}/user/subscription`;
}

/**
 * @param {unknown} body `/user/subscription` JSON；兼容包在 `subscription` 里的 `/user/data` 形状
 * @returns {SubscriptionBalance}
 */
export function parseSubscriptionBalance(body) {
    const raw = body && typeof body === 'object' ? /** @type {Record<string, unknown>} */ (body) : {};
    const nested = raw.subscription && typeof raw.subscription === 'object'
        ? /** @type {Record<string, unknown>} */ (raw.subscription)
        : null;
    const source = (raw.trainingStepsLeft || raw.usage) ? raw : (nested || raw);
    const steps = source.trainingStepsLeft && typeof source.trainingStepsLeft === 'object'
        ? /** @type {Record<string, unknown>} */ (source.trainingStepsLeft)
        : {};
    const fixedAnlas = nonNegInt(steps.fixedTrainingStepsLeft);
    const purchasedAnlas = nonNegInt(steps.purchasedTrainingSteps);
    const usage = source.usage && typeof source.usage === 'object'
        ? /** @type {Record<string, unknown>} */ (source.usage)
        : null;
    return {
        energy: usage ? parseEnergy(usage) : null,
        fixedAnlas,
        purchasedAnlas,
        points: fixedAnlas + purchasedAnlas,
    };
}

/**
 * 卡片短文案：电量 87% · 点数 9,930
 * @param {SubscriptionBalance} balance
 * @returns {string}
 */
export function formatBalanceSummary(balance) {
    return `电量 ${formatEnergy(balance)} · 点数 ${formatCount(balance?.points)}`;
}

/**
 * 编辑框详情：含回充时间，以及订阅 / 购买拆分。
 * @param {SubscriptionBalance} balance
 * @returns {string}
 */
export function formatBalanceDetail(balance) {
    const energy = formatEnergy(balance);
    let extra = '';
    if (balance?.energy && !balance.energy.unavailable) {
        if (balance.energy.refillSeconds === 0) {
            extra = '（已满，暂停回充）';
        } else if (balance.energy.refillSeconds != null && balance.energy.refillSeconds > 0) {
            extra = `（约 ${formatDuration(balance.energy.refillSeconds)}后 +1%）`;
        }
    }
    const fixed = formatCount(balance?.fixedAnlas);
    const purchased = formatCount(balance?.purchasedAnlas);
    return `电量 ${energy}${extra} · 点数 ${formatCount(balance?.points)}（订阅 ${fixed} · 购买 ${purchased}）`;
}

/**
 * @param {Record<string, unknown>} usage
 * @returns {SubscriptionEnergy}
 */
function parseEnergy(usage) {
    const percent = Number(usage.percent);
    const refill = Number(usage.timeUntilNextPercent);
    return {
        percent: Number.isFinite(percent) ? Math.max(0, Math.trunc(percent)) : null,
        unavailable: usage.isNegative === true,
        refillSeconds: Number.isFinite(refill) ? Math.max(0, Math.trunc(refill)) : null,
    };
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function nonNegInt(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.trunc(n));
}

/**
 * @param {SubscriptionBalance|null|undefined} balance
 * @returns {string}
 */
function formatEnergy(balance) {
    if (!balance?.energy) return '—';
    if (balance.energy.unavailable) return '不可用';
    if (balance.energy.percent == null) return '—';
    return `${balance.energy.percent}%`;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function formatCount(value) {
    const n = nonNegInt(value);
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * @param {number} seconds
 * @returns {string}
 */
function formatDuration(seconds) {
    const s = Math.max(0, Math.trunc(seconds));
    if (s < 60) return `${s} 秒`;
    const minutes = Math.round(s / 60);
    if (minutes < 60) return `${minutes} 分钟`;
    const hours = Math.floor(s / 3600);
    const remainMinutes = Math.round((s % 3600) / 60);
    return remainMinutes ? `${hours} 小时 ${remainMinutes} 分钟` : `${hours} 小时`;
}
