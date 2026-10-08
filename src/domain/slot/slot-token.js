/**
 * L3 领域层 · &lt;IMG&gt;n&lt;/IMG&gt; 的唯一解析/生成处。
 * 展示正则与出站剥离必须共用本定义，防止漂移。
 * 归属：W1-A 领域代理实现。W0 仅冻结签名。
 */

/** 与 assets/regex 及剥离逻辑共用的源模式（实现导出编译后的 RegExp 与模板）。 */
export const SLOT_TOKEN_PATTERN_SOURCE = '<IMG>\\s*(\\d+)\\s*</IMG>';

/**
 * @returns {RegExp} 全局正则，用于匹配正文中的 slot
 */
export function createSlotTokenRegex() {
    return new RegExp(SLOT_TOKEN_PATTERN_SOURCE, 'gi');
}

/**
 * @param {number} slotId
 * @returns {string} `<IMG>\n{n}\n</IMG>` 规范形态
 */
export function formatSlotToken(slotId) {
    const id = Number(slotId);
    if (!Number.isInteger(id) || id < 1) {
        throw new Error('invalid argument: slotId');
    }
    return `<IMG>\n${id}\n</IMG>`;
}

/**
 * @param {string} text
 * @returns {number[]} 正文中出现的全部 slotId（保序）
 */
export function parseSlotIds(text) {
    if (typeof text !== 'string' || text.length === 0) {
        return [];
    }
    const re = createSlotTokenRegex();
    /** @type {number[]} */
    const ids = [];
    let m = re.exec(text);
    while (m) {
        ids.push(Number(m[1]));
        m = re.exec(text);
    }
    return ids;
}

/**
 * 从文本中删除全部 slot 标记（正文保留）。用于上下文块与出站兜底。
 * @param {string} text
 * @returns {string}
 */
export function stripSlotTokens(text) {
    if (typeof text !== 'string') {
        return '';
    }
    return text.replace(createSlotTokenRegex(), '');
}

/**
 * 正则 1 的 replaceString（含 $1）；由宿主安装器写入。
 * 必须是 ```html 围栏里的完整文档。JS-Slash-Runner 只把这种围栏画成 iframe，
 * 光有围栏或只有一段 div，按钮都出不来。
 * @returns {string}
 */
export function slotWidgetReplaceTemplate() {
    const buttonStyle = [
        'appearance:none !important',
        '-webkit-appearance:none !important',
        'display:inline-flex !important',
        'align-items:center !important',
        'justify-content:center !important',
        'box-sizing:border-box !important',
        'width:auto !important',
        'min-width:0 !important',
        'height:36px !important',
        'min-height:36px !important',
        'margin:0.45em 0 !important',
        'padding:0 16px !important',
        'border:0 !important',
        'border-radius:8px !important',
        'background:#c13d75 !important',
        'color:#fff !important',
        'font-size:14px !important',
        'font-weight:700 !important',
        'line-height:1 !important',
        'letter-spacing:0 !important',
        'text-transform:none !important',
        'box-shadow:none !important',
        'cursor:pointer !important',
    ].join(';');
    const page = [
        '<!DOCTYPE html>',
        '<html lang="zh-CN">',
        '<head>',
        '<meta charset="UTF-8">',
        '<meta name="viewport" content="width=device-width,initial-scale=1">',
        '<style>',
        'html,body{margin:0!important;padding:0!important;width:100%!important;height:auto!important;background:transparent!important;overflow:hidden!important}',
        '</style>',
        '</head>',
        '<body>',
        '<div class="nai-slot" data-slot="$1">',
        `<button type="button" class="nai-slot-btn" style="${buttonStyle}" onclick="top.postMessage({source:'nai-dbgen',action:'generate',slot:'$1'},'*')">生成</button>`,
        '<div class="nai-slot-img"></div>',
        '</div>',
        '<script>',
        '(() => {',
        '  try {',
        '    const frame = window.frameElement;',
        '    const root = document.querySelector("[data-slot]");',
        '    if (!frame || !root) return;',
        '    const height = Math.max(1, Math.ceil(root.getBoundingClientRect().height || root.scrollHeight));',
        '    frame.style.height = height + "px";',
        '    frame.style.border = "0";',
        '    frame.style.background = "transparent";',
        '    frame.style.overflow = "hidden";',
        '    frame.setAttribute("scrolling", "no");',
        '  } catch (_e) {}',
        '})();',
        '</script>',
        '</body>',
        '</html>',
    ].join('\n');
    return '```html\n' + page + '\n\n```';
}
