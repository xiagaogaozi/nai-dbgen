/**
 * 往酒馆自带的快捷回复栏（输入框正上方那一排）加按钮。
 * 不自己画一排。走 quickReplyApi：建预设「酒馆数据库生图」，再挂进全局预设，栏才会显示。
 * 快捷回复扩展把接口赋给 globalThis.quickReplyApi 之后才挂按钮。不等时钟。
 */

const TRACE = '[nai-dbgen][quick-reply]';

/**
 * 浏览器控制台里直接可见，不走插件日志级别。
 * @param {string} step
 * @param {unknown} [detail]
 */
function trace(step, detail) {
    if (detail === undefined) console.log(TRACE, step);
    else console.log(TRACE, step, detail);
}

/** 快捷回复预设名，出现在酒馆的快捷回复设置里。 */
export const QR_SET_NAME = '酒馆数据库生图';

/**
 * 曾经单独挂过、现在不该出现在栏上的按钮。只删我们写过的命令。
 * @type {ReadonlyArray<{ label: string, message: string }>}
 */
const RETIRED_BUTTONS = Object.freeze([
    { label: '数据库生图', message: '/naimgr' },
    { label: '工作台', message: '/naiwb' },
    { label: '画师串', message: '/naiartist' },
    { label: '配置', message: '/naicfg' },
]);

/**
 * 三个：双击悬浮球的本楼生图、单击悬浮球的配置面板、管理台（隐藏悬浮球后从这里进）。
 * @type {ReadonlyArray<{ label: string, message: string, title: string, icon: string }>}
 */
export const QR_BUTTONS = Object.freeze([
    {
        label: '本楼生图',
        message: '/naifloor',
        title: '写提示词并出图，和悬浮球双击相同',
        icon: 'fa-image',
    },
    {
        label: '快捷配置',
        message: '/naicfg',
        title: '打开快捷配置面板，和单击悬浮球相同',
        icon: 'fa-sliders',
    },
    {
        label: '管理台',
        message: '/naimgr',
        title: '打开管理台',
        icon: 'fa-table-columns',
    },
]);

/**
 * @param {object} [api] 默认读 globalThis.quickReplyApi
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function ensureQuickReplyEntry(api) {
    const qr = api ?? globalThis.quickReplyApi;
    trace('ensure', {
        passedApi: api != null,
        hasGlobalApi: !!globalThis.quickReplyApi,
        getSetByName: typeof qr?.getSetByName,
        createSet: typeof qr?.createSet,
        createQuickReply: typeof qr?.createQuickReply,
        addGlobalSet: typeof qr?.addGlobalSet,
        listSets: typeof qr?.listSets === 'function' ? qr.listSets() : null,
    });
    if (!qr || typeof qr.getSetByName !== 'function' || typeof qr.createSet !== 'function') {
        trace('ensure stop', 'api missing');
        return { ok: false, reason: 'missing' };
    }

    let set = qr.getSetByName(QR_SET_NAME);
    trace('getSetByName', { name: QR_SET_NAME, found: !!set });
    if (!set) {
        trace('createSet start', QR_SET_NAME);
        set = await qr.createSet(QR_SET_NAME, { disableSend: false });
        trace('createSet done', { name: set?.name ?? null, disableSend: set?.disableSend ?? null });
    } else if (set.disableSend === true && typeof qr.updateSet === 'function') {
        trace('updateSet disableSend', true);
        await qr.updateSet(QR_SET_NAME, {
            disableSend: false,
            placeBeforeInput: set.placeBeforeInput === true,
            injectInput: set.injectInput === true,
        });
    }

    if (typeof qr.getQrByLabel === 'function' && typeof qr.deleteQuickReply === 'function') {
        for (const retired of RETIRED_BUTTONS) {
            const existing = qr.getQrByLabel(QR_SET_NAME, retired.label);
            if (existing && existing.message === retired.message) {
                trace('delete retired', retired.label);
                qr.deleteQuickReply(QR_SET_NAME, retired.label);
            }
        }
    }

    for (const button of QR_BUTTONS) {
        const existing = typeof qr.getQrByLabel === 'function'
            ? qr.getQrByLabel(QR_SET_NAME, button.label)
            : null;
        trace('button', { label: button.label, exists: !!existing, message: existing?.message ?? null });
        if (!existing && typeof qr.createQuickReply === 'function') {
            qr.createQuickReply(QR_SET_NAME, button.label, {
                message: button.message,
                title: button.title,
                showLabel: true,
                icon: button.icon,
                isHidden: false,
            });
        } else if (
            existing
            && existing.message !== button.message
            && typeof qr.updateQuickReply === 'function'
        ) {
            qr.updateQuickReply(QR_SET_NAME, button.label, {
                message: button.message,
                title: button.title,
                showLabel: true,
                icon: button.icon,
            });
        }
    }

    attachGlobalSet(qr, qr.getSetByName(QR_SET_NAME) ?? set);
    trace('ensure ok', {
        globalSets: typeof qr.listGlobalSets === 'function' ? qr.listGlobalSets() : null,
        buttons: typeof qr.listQuickReplies === 'function' ? qr.listQuickReplies(QR_SET_NAME) : null,
    });
    return { ok: true };
}

/**
 * 挂进全局快捷回复栏。设置面板的 DOM 没挂上时，addGlobalSet 会在写进列表后抛错，
 * 这时再调 update，让栏刷新并保存。
 * @param {object} qr
 * @param {object} set
 */
function attachGlobalSet(qr, set) {
    const config = qr.settings?.config;
    trace('attach', {
        hasSetObject: !!set,
        hasConfig: !!config,
        hasHasSet: typeof config?.hasSet,
        hasAddGlobalSet: typeof qr.addGlobalSet,
        already: typeof config?.hasSet === 'function' ? config.hasSet(set) : null,
        setListDom: !!config?.setListDom,
    });
    if (!set || !config || typeof config.hasSet !== 'function' || typeof qr.addGlobalSet !== 'function') {
        trace('attach stop', 'missing config or addGlobalSet');
        return;
    }
    if (config.hasSet(set)) {
        trace('attach already linked');
        if (typeof qr.settings.onSave === 'function') qr.settings.onSave();
        return;
    }
    try {
        qr.addGlobalSet(QR_SET_NAME, true);
        trace('addGlobalSet done', typeof qr.listGlobalSets === 'function' ? qr.listGlobalSets() : null);
    } catch (cause) {
        console.error(TRACE, 'addGlobalSet threw', cause);
        if (config.hasSet(set) && typeof config.update === 'function') {
            trace('attach update after throw');
            config.update();
        }
    }
}

/**
 * 接口已经在就立刻挂。还没有就守住 globalThis.quickReplyApi 的赋值，
 * 快捷回复扩展执行 `globalThis.quickReplyApi = ...` 时再挂。不轮询。
 * @returns {void}
 */
export function installQuickReplyEntry() {
    trace('install start', {
        hasSillyTavern: !!globalThis.SillyTavern,
        hasQuickReplyApi: !!globalThis.quickReplyApi,
    });
    if (globalThis.quickReplyApi) {
        void runInstall();
        return;
    }
    if (!globalThis.SillyTavern) {
        trace('install stop', 'no SillyTavern and no quickReplyApi');
        return;
    }
    trace('install wait', 'quickReplyApi 尚未赋值');
    watchQuickReplyApi(() => {
        trace('quickReplyApi assigned');
        void runInstall();
    });
}

/**
 * @returns {Promise<void>}
 */
async function runInstall() {
    try {
        const result = await ensureQuickReplyEntry();
        trace('install done', result);
        if (!result.ok) {
            console.error(TRACE, 'install not ok', result);
        }
    } catch (cause) {
        console.error(TRACE, 'install threw', cause);
        const toast = globalThis.toastr;
        const message = cause instanceof Error ? cause.message : String(cause);
        if (toast && typeof toast.error === 'function') {
            toast.error(message, '酒馆数据库生图');
        }
    }
}

/**
 * @param {() => void} onAssigned
 */
function watchQuickReplyApi(onAssigned) {
    let value = globalThis.quickReplyApi;
    let notified = false;
    const notify = () => {
        if (notified || !value) return;
        notified = true;
        onAssigned();
    };
    try {
        Object.defineProperty(globalThis, 'quickReplyApi', {
            configurable: true,
            enumerable: true,
            get() {
                return value;
            },
            set(next) {
                value = next;
                notify();
            },
        });
    } catch (cause) {
        console.error(TRACE, 'cannot watch quickReplyApi', cause);
        return;
    }
    if (value) notify();
}
