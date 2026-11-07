/** 对插件生成时拼接在场景前的原样画师串做保守匹配，不猜测语义。 */
function removeUniquePart(text, part, prefixOnly = false) {
    const input = String(text ?? '');
    const needle = String(part ?? '').trim();
    if (!needle) return { text: input, matched: true };
    let found = -1;
    let from = 0;
    while (from <= input.length - needle.length) {
        const at = input.indexOf(needle, from);
        if (at < 0) break;
        const before = input.slice(0, at);
        const after = input.slice(at + needle.length);
        const leftOK = !before.trim() || /,\s*$/.test(before);
        const rightOK = !after.trim() || /^\s*,/.test(after) || /,$/.test(needle);
        if (leftOK && rightOK && (!prefixOnly || !before.trim())) {
            if (found >= 0) return { text: input, matched: false };
            found = at;
        }
        from = at + 1;
    }
    if (found < 0) return { text: input, matched: false };
    let left = input.slice(0, found).replace(/,\s*$/, '');
    let right = input.slice(found + needle.length).replace(/^\s*,\s*/, '');
    left = left.trim();
    right = right.trim();
    return { text: left && right ? `${left}, ${right}` : left || right, matched: true };
}

export function matchImageArtist(caption, artists) {
    const positive = caption?.v4_prompt?.caption?.base_caption ?? '';
    const negative = caption?.v4_negative_prompt?.caption?.base_caption ?? '';
    const matches = [];
    for (const artist of Array.isArray(artists) ? artists : []) {
        if (!artist?.id || !String(artist.positivePrompt ?? '').trim()) continue;
        const pos = removeUniquePart(positive, artist.positivePrompt, true);
        const neg = removeUniquePart(negative, artist.negativePrompt, false);
        if (pos.matched && neg.matched) matches.push({ artist, pos: pos.text, neg: neg.text });
    }
    if (matches.length !== 1) return { artist: null, caption };
    const { artist, pos, neg } = matches[0];
    return {
        artist,
        caption: {
            ...caption,
            v4_prompt: { ...caption.v4_prompt, caption: { ...caption.v4_prompt.caption, base_caption: pos } },
            v4_negative_prompt: { ...caption.v4_negative_prompt, caption: { ...caption.v4_negative_prompt.caption, base_caption: neg } },
        },
    };
}