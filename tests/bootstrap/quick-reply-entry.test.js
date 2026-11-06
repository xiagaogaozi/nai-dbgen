import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    QR_BUTTONS,
    QR_SET_NAME,
    ensureQuickReplyEntry,
} from '../../src/bootstrap/quick-reply-entry.js';

/**
 * @param {object} [seed]
 */
function fakeApi(seed = {}) {
    /** @type {Map<string, { name: string, disableSend: boolean, placeBeforeInput: boolean, injectInput: boolean, buttons: object[] }>} */
    const sets = new Map();
    if (seed.set) {
        sets.set(seed.set.name, seed.set);
    }
    const links = seed.linked ? [{ set: seed.set }] : [];
    const calls = {
        createSet: 0,
        createQuickReply: 0,
        addGlobalSet: 0,
        updateSet: 0,
        updateQuickReply: 0,
        deleteQuickReply: 0,
    };
    const api = {
        settings: {
            config: {
                setListDom: {},
                hasSet(set) {
                    return links.some((link) => link.set === set);
                },
            },
        },
        getSetByName(name) {
            return sets.get(name);
        },
        async createSet(name, props) {
            calls.createSet += 1;
            const set = {
                name,
                disableSend: props?.disableSend === true,
                placeBeforeInput: false,
                injectInput: false,
                buttons: [],
            };
            sets.set(name, set);
            return set;
        },
        async updateSet(name, props) {
            calls.updateSet += 1;
            const set = sets.get(name);
            if (set) set.disableSend = props?.disableSend === true;
            return set;
        },
        getQrByLabel(setName, label) {
            return sets.get(setName)?.buttons.find((btn) => btn.label === label);
        },
        createQuickReply(setName, label, props) {
            calls.createQuickReply += 1;
            const btn = { label, ...props };
            sets.get(setName).buttons.push(btn);
            return btn;
        },
        updateQuickReply(setName, label, props) {
            calls.updateQuickReply += 1;
            const btn = sets.get(setName)?.buttons.find((item) => item.label === label);
            if (btn) Object.assign(btn, props);
            return btn;
        },
        deleteQuickReply(setName, label) {
            calls.deleteQuickReply += 1;
            const set = sets.get(setName);
            if (!set) return;
            set.buttons = set.buttons.filter((item) => item.label !== label);
        },
        addGlobalSet(name) {
            calls.addGlobalSet += 1;
            links.push({ set: sets.get(name) });
        },
        calls,
    };
    return api;
}

describe('quick reply entry', () => {
    it('没有快捷回复接口时跳过', async () => {
        const result = await ensureQuickReplyEntry(null);
        assert.deepEqual(result, { ok: false, reason: 'missing' });
    });

    it('第一次只挂本楼生图和配置面板', async () => {
        const api = fakeApi();
        const result = await ensureQuickReplyEntry(api);
        assert.equal(result.ok, true);
        assert.equal(api.calls.createSet, 1);
        assert.equal(api.calls.createQuickReply, QR_BUTTONS.length);
        assert.equal(api.calls.addGlobalSet, 1);
        for (const button of QR_BUTTONS) {
            const created = api.getQrByLabel(QR_SET_NAME, button.label);
            assert.equal(created.message, button.message);
            assert.equal(created.showLabel, true);
        }
    });

    it('已有按钮时不重复创建，命令被改过会改回', async () => {
        const set = {
            name: QR_SET_NAME,
            disableSend: false,
            placeBeforeInput: false,
            injectInput: false,
            buttons: QR_BUTTONS.map((button) => ({
                label: button.label,
                message: button.label === '本楼生图' ? '/custom' : button.message,
            })),
        };
        const api = fakeApi({ set, linked: true });
        await ensureQuickReplyEntry(api);
        assert.equal(api.calls.createSet, 0);
        assert.equal(api.calls.createQuickReply, 0);
        assert.equal(api.calls.addGlobalSet, 0);
        assert.equal(api.calls.updateQuickReply, 1);
        assert.equal(api.getQrByLabel(QR_SET_NAME, '本楼生图').message, '/naifloor');
    });

    it('删掉多出来的工作台、画师串，管理台保留', async () => {
        const set = {
            name: QR_SET_NAME,
            disableSend: false,
            placeBeforeInput: false,
            injectInput: false,
            buttons: [
                { label: '数据库生图', message: '/naimgr' },
                { label: '本楼生图', message: '/naifloor' },
                { label: '工作台', message: '/naiwb' },
                { label: '管理台', message: '/naimgr' },
                { label: '画师串', message: '/naiartist' },
            ],
        };
        const api = fakeApi({ set, linked: true });
        await ensureQuickReplyEntry(api);
        assert.equal(api.calls.deleteQuickReply, 3);
        assert.equal(api.getQrByLabel(QR_SET_NAME, '数据库生图'), undefined);
        assert.equal(api.getQrByLabel(QR_SET_NAME, '工作台'), undefined);
        assert.equal(api.getQrByLabel(QR_SET_NAME, '管理台').message, '/naimgr');
        assert.equal(api.getQrByLabel(QR_SET_NAME, '画师串'), undefined);
        assert.equal(api.getQrByLabel(QR_SET_NAME, '本楼生图').message, '/naifloor');
        assert.equal(api.getQrByLabel(QR_SET_NAME, '快捷配置').message, '/naicfg');
    });

    it('设置面板没挂上时仍然调用挂到全局栏', async () => {
        const api = fakeApi();
        api.settings.config.setListDom = null;
        const result = await ensureQuickReplyEntry(api);
        assert.equal(result.ok, true);
        assert.equal(api.calls.addGlobalSet, 1);
    });

    it('预设禁止发送时改回可执行斜杠', async () => {
        const set = {
            name: QR_SET_NAME,
            disableSend: true,
            placeBeforeInput: true,
            injectInput: false,
            buttons: QR_BUTTONS.map((button) => ({ ...button })),
        };
        const api = fakeApi({ set, linked: true });
        await ensureQuickReplyEntry(api);
        assert.equal(api.calls.updateSet, 1);
        assert.equal(api.getSetByName(QR_SET_NAME).disableSend, false);
    });
});
