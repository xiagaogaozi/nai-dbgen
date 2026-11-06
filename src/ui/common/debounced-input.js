/**
 * L5 UI · 搜索框防抖：停止输入 delay 毫秒后再执行。
 * 输入法拼字中不触发，拼字结束后重新计时；按回车立即执行。
 */

/**
 * @param {HTMLInputElement|HTMLTextAreaElement} input
 * @param {() => void} fn
 * @param {{ delay?: number, runOnEnter?: boolean }} [opts] runOnEnter 默认 true；调用方自己处理回车时传 false
 * @returns {{ flush: () => void, cancel: () => void, dispose: () => void }}
 */
export function bindDebouncedInput(input, fn, opts) {
    const delay = Number.isFinite(opts?.delay) ? Number(opts.delay) : 300;
    const runOnEnter = opts?.runOnEnter !== false;
    /** @type {ReturnType<typeof setTimeout>|null} */
    let timer = null;
    let composing = false;
    let disposed = false;

    const cancel = () => {
        if (timer != null) {
            clearTimeout(timer);
            timer = null;
        }
    };
    const run = () => {
        cancel();
        if (!disposed) fn();
    };
    const schedule = () => {
        cancel();
        if (composing || disposed) return;
        timer = setTimeout(run, delay);
    };
    const onInput = (event) => {
        if (composing || event?.isComposing) return;
        schedule();
    };
    const onCompStart = () => {
        composing = true;
        cancel();
    };
    const onCompEnd = () => {
        composing = false;
        schedule();
    };
    const onKeyDown = (event) => {
        if (runOnEnter && event.key === 'Enter' && !event.isComposing && !composing) run();
    };

    input.addEventListener('input', onInput);
    input.addEventListener('compositionstart', onCompStart);
    input.addEventListener('compositionend', onCompEnd);
    input.addEventListener('keydown', onKeyDown);

    return {
        flush: () => {
            if (timer != null) run();
        },
        cancel,
        dispose: () => {
            if (disposed) return;
            disposed = true;
            cancel();
            input.removeEventListener('input', onInput);
            input.removeEventListener('compositionstart', onCompStart);
            input.removeEventListener('compositionend', onCompEnd);
            input.removeEventListener('keydown', onKeyDown);
        },
    };
}
