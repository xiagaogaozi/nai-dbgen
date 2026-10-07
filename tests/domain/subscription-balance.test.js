import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    formatBalanceDetail,
    formatBalanceSummary,
    parseSubscriptionBalance,
    resolveSubscriptionUrl,
} from '../../src/domain/nai/subscription-balance.js';

describe('subscription balance', () => {
    it('电量读 usage，点数是订阅 Anlas 与购买 Anlas 之和', () => {
        const balance = parseSubscriptionBalance({
            tier: 3,
            active: true,
            trainingStepsLeft: {
                fixedTrainingStepsLeft: 9898,
                purchasedTrainingSteps: 32,
            },
            usage: {
                percent: 87,
                isNegative: false,
                timeUntilNextPercent: 120,
            },
        });
        assert.equal(balance.energy?.percent, 87);
        assert.equal(balance.energy?.unavailable, false);
        assert.equal(balance.energy?.refillSeconds, 120);
        assert.equal(balance.fixedAnlas, 9898);
        assert.equal(balance.purchasedAnlas, 32);
        assert.equal(balance.points, 9930);
        assert.equal(formatBalanceSummary(balance), '电量 87% · 点数 9,930');
        assert.equal(
            formatBalanceDetail(balance),
            '电量 87%（约 2 分钟后 +1%） · 点数 9,930（订阅 9,898 · 购买 32）',
        );
    });

    it('兼容包在 subscription 里的响应，电量耗尽与已满暂停回充', () => {
        const depleted = parseSubscriptionBalance({
            subscription: {
                trainingStepsLeft: { fixedTrainingStepsLeft: 10, purchasedTrainingSteps: 0 },
                usage: { percent: 0, isNegative: true, timeUntilNextPercent: 30 },
            },
        });
        assert.equal(formatBalanceSummary(depleted), '电量 不可用 · 点数 10');

        const full = parseSubscriptionBalance({
            trainingStepsLeft: { fixedTrainingStepsLeft: 1000, purchasedTrainingSteps: 0 },
            usage: { percent: 100, isNegative: false, timeUntilNextPercent: 0 },
        });
        assert.match(formatBalanceDetail(full), /已满，暂停回充/);
        assert.match(formatBalanceDetail(full), /订阅 1,000/);
    });

    it('没有 usage 时电量留空，接口地址收成 /user/subscription', () => {
        const balance = parseSubscriptionBalance({
            trainingStepsLeft: { fixedTrainingStepsLeft: 5, purchasedTrainingSteps: 1 },
        });
        assert.equal(balance.energy, null);
        assert.equal(formatBalanceSummary(balance), '电量 — · 点数 6');
        assert.equal(
            resolveSubscriptionUrl('https://image.novelai.net'),
            'https://image.novelai.net/user/subscription',
        );
        assert.equal(
            resolveSubscriptionUrl('https://image.novelai.net/ai/generate-image/'),
            'https://image.novelai.net/user/subscription',
        );
        assert.equal(
            resolveSubscriptionUrl('https://proxy.example/nai/ai'),
            'https://proxy.example/nai/user/subscription',
        );
    });
});
