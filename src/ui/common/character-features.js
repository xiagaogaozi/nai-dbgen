/** 按固定特征中的行首标题拆分；没有标题的文字归正面。 */
export function parseCharacterFeatures(text) {
    const parts = { positive: [], negative: [] };
    let section = 'positive';
    for (const line of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
        const match = line.match(/^\s*(?:[-*•]\s*)?(正面提示词|负面提示词|正向提示词|负向提示词|正面|负面|正向|负向|char_uc|char)(?:\s*[:：]\s*|\s*$)(.*)$/i);
        if (match) {
            section = /^(负面|负向|char_uc)/i.test(match[1]) ? 'negative' : 'positive';
            if (match[2]) parts[section].push(match[2]);
        } else {
            parts[section].push(line);
        }
    }
    return { positive: parts.positive.join('\n').trim(), negative: parts.negative.join('\n').trim() };
}

/** 工作台保存到角色库的固定特征格式。 */
export function formatCharacterFeatures({ positive, negative }) {
    return `- char: ${String(positive ?? '').trim()}\n\n- char_uc: ${String(negative ?? '').trim()}`;
}