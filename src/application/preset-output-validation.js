/** 校验模型输出；允许额外字段，必填字段缺失不能通过补默认值掩盖。 */
import { Ok, Err } from '../infra/result.js';
import { contractError } from '../infra/errors.js';
import { validateNaiCaption } from '../domain/model/nai-params.js';
import { slotCaptionFromLlmItem } from '../domain/model/slot.js';
import { parseSizeSpec } from '../domain/model/size-spec.js';
import { findAnchorInsertIndex } from '../domain/slot/slot-placer.js';
import { inspectFlatImagegenFields, parseFlatSlotPlans, parseFlatSingleCaption } from '../domain/model/flat-imagegen.js';
import { extractRecalledPositions, extractSlotPlanItems, extractSingleCaption } from './_helpers.js';

function invalid(code, message, issues, context = {}) {
    return Err(contractError({ code, message: issues.length ? `${message}：${issues.join('；')}` : message,
        hint: code === 'RECALL_LEGACY_FORMAT' ? '请改用内置召回预设，或按同样格式输出生成位置' : null,
        context: { ...context, issues } }));
}

export function validateRecallOutput(response, { targetFloorText = '' } = {}) {
    const extracted = extractRecalledPositions(response.json, response.text);
    if (extracted.status === 'legacy-key-list') {
        return invalid('RECALL_LEGACY_FORMAT', '召回预设输出格式已过时', ['须输出 {"positions":[{"anchor":"目标楼原句","key":[候选编号]}]}，不能只返回候选列表']);
    }
    if (extracted.status === 'invalid') {
        return invalid('RECALL_FORMAT_INVALID', '标签召回结果格式无效', extracted.issues || ['每个 positions 项必须包含非空生成点 anchor 和 key 数组']);
    }
    if (extracted.status === 'empty' || extracted.positions.length === 0) {
        return invalid('RECALL_NO_POSITIONS', '标签召回未产出任何生成位置', ['缺少非空 positions 数组及生成点 anchor、候选编号数组 key']);
    }
    const discardedAnchors = extracted.positions.filter((p) => findAnchorInsertIndex(targetFloorText, p.anchorSentence).index < 0)
        .map((p) => p.anchorSentence);
    if (discardedAnchors.length === extracted.positions.length) {
        return invalid('RECALL_ALL_POSITIONS_DISCARDED', '召回的全部生成点都无法在目标楼正文中匹配',
            discardedAnchors.map((anchor) => `生成点无法在目标楼正文中匹配：${anchor}；请逐字引用目标楼某段最后一句`),
            { discardedAnchors, unmatchedKeys: [] });
    }
    return Ok(extracted);
}

function captionIssues(caption, label) {
    const issues = [];
    const pos = caption?.v4_prompt?.caption;
    const neg = caption?.v4_negative_prompt?.caption;
    if (typeof pos?.base_caption !== 'string' || !pos.base_caption.trim()) issues.push(`${label}缺少非空 scene（v4_prompt.caption.base_caption）`);
    if (!Array.isArray(pos?.char_captions)) issues.push(`${label}缺少 char_captions 数组`);
    if (typeof neg?.base_caption !== 'string') issues.push(`${label}缺少 scene_uc（v4_negative_prompt.caption.base_caption，可为空字符串）`);
    if (!Array.isArray(neg?.char_captions)) issues.push(`${label}缺少 char_uc 数组`);
    if (Array.isArray(pos?.char_captions) && Array.isArray(neg?.char_captions) && pos.char_captions.length !== neg.char_captions.length) {
        issues.push(`${label}的角色正向、负向条数不一致`);
    }
    for (const [i, char] of (Array.isArray(pos?.char_captions) ? pos.char_captions : []).entries()) {
        if (typeof char?.char_caption !== 'string') issues.push(`${label}的 char[${i}] 缺少 char_caption`);
    }
    for (const [i, char] of (Array.isArray(neg?.char_captions) ? neg.char_captions : []).entries()) {
        if (typeof char?.char_caption !== 'string') issues.push(`${label}的 char_uc[${i}] 缺少 char_caption`);
    }
    const validated = validateNaiCaption(caption);
    if (!validated.ok && !issues.length) issues.push(`${label}：${validated.error.message}`);
    return issues;
}

/** expectedSlotIds 仅用于楼层写 slot；工作台/外部接口仍保留模型返回的多张图。 */
export function validateImagegenOutput(response, { multiple = true, expectedSlotIds } = {}) {
    const inspected = inspectFlatImagegenFields(response.text, { requireSlotId: multiple });
    const issues = [...inspected.issues];
    const items = multiple
        ? (inspected.recognized ? parseFlatSlotPlans(response.text) : extractSlotPlanItems(response.json))
        : [];
    let code = multiple ? 'IMAGEGEN_OUTPUT_INVALID' : 'WORKBENCH_CAPTION_INVALID';
    let mismatch = {};
    if (multiple && (inspected.recognized || items.length)) {
        if (!items.length) issues.push('没有读取到带有 slotid 的生图段落');
        const ids = [];
        for (const [index, item] of items.entries()) {
            const label = `第 ${index + 1} 段`;
            const parsed = slotCaptionFromLlmItem(item);
            if (!parsed.ok) {
                issues.push(`${label}：${parsed.error.message}`);
                if (parsed.error.code === 'SLOT_PLAN_ID') code = 'SLOT_PLAN_ID';
            }
            else ids.push(parsed.value.slotId);
            issues.push(...captionIssues(item.caption ?? item['生图内容'], label));
            const size = item.size ?? item['尺寸'];
            if (size != null && String(size).trim() && !parseSizeSpec(size).ok) issues.push(`${label}的 size 须为宽x高，如 832x1216`);
        }
        const duplicate = ids.filter((id, i) => ids.indexOf(id) !== i);
        if (duplicate.length) issues.push(`slotid 重复：${[...new Set(duplicate)].join('、')}`);
        if (Array.isArray(expectedSlotIds)) {
            const missing = expectedSlotIds.filter((id) => !ids.includes(id));
            const extra = ids.filter((id) => !expectedSlotIds.includes(id));
            mismatch = { missingSlotIds: missing, extraSlotIds: extra, expectedSlotIds };
            if (ids.length && !ids.some((id) => expectedSlotIds.includes(id))) code = 'SLOT_PLAN_NO_VALID';
            if (missing.length) issues.push(`缺少召回指定的 slotid：${missing.join('、')}`);
            if (extra.length) issues.push(`出现召回之外的 slotid：${extra.join('、')}`);
        }
    } else {
        const flat = inspected.recognized ? parseFlatSingleCaption(response.text) : null;
        const caption = flat?.caption ?? extractSingleCaption(response.json) ?? response.json;
        if (!inspected.recognized) code = Array.isArray(expectedSlotIds) ? 'SLOT_PLAN_EMPTY' : 'WORKBENCH_CAPTION_INVALID';
        issues.push(...captionIssues(caption, '生图结果'));
        if (multiple) issues.push('缺少必填字段 slotid：须为每张图输出编号，不能只返回单图内容');
        const size = flat?.size ?? response.json?.size ?? response.json?.['尺寸'];
        if (size != null && String(size).trim() && !parseSizeSpec(size).ok) issues.push('size 须为宽x高，如 832x1216');
    }
    return issues.length ? invalid(code, '模型没有按生图格式返回完整提示词：缺少必填字段或格式无效', issues, mismatch) : Ok(response);
}
