/**
 * L5 UI · 夜间模式（0.2.45）。
 * 只在 <html> 上写 data-nd-theme；配色变量在 theme-dark.css，仅作用于插件自己的根。
 */

/**
 * @param {unknown} mode
 * @returns {'light'|'dark'}
 */
export function normalizeThemeMode(mode) {
    return mode === 'dark' ? 'dark' : 'light';
}

/**
 * @param {unknown} mode
 */
export function applyTheme(mode) {
    const html = globalThis.document?.documentElement;
    if (!html || !html.dataset) return;
    html.dataset.ndTheme = normalizeThemeMode(mode);
}

/** dispose 时撤掉标记，不残留在宿主页面上。 */
export function clearTheme() {
    const html = globalThis.document?.documentElement;
    if (!html || !html.dataset) return;
    delete html.dataset.ndTheme;
}

/**
 * 管理台右上角的日 / 夜切换钮。
 * @param {{ getMode: () => unknown, setMode: (mode: 'light'|'dark') => void }} opts
 * @returns {HTMLButtonElement}
 */
export function createThemeToggle(opts) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'nd-theme-toggle';
    const icon = document.createElement('i');
    btn.appendChild(icon);
    const paint = () => {
        const dark = normalizeThemeMode(opts.getMode()) === 'dark';
        icon.className = `fa-solid ${dark ? 'fa-sun' : 'fa-moon'}`;
        const label = dark ? '切换到日间模式' : '切换到夜间模式';
        btn.title = label;
        btn.setAttribute('aria-label', label);
    };
    btn.addEventListener('click', (event) => {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        const next = normalizeThemeMode(opts.getMode()) === 'dark' ? 'light' : 'dark';
        opts.setMode(next);
        applyTheme(next);
        paint();
    });
    paint();
    return btn;
}