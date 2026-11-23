/**
 * L2 适配器 · Character / CharacterGroup 两层仓库（裁决 D7）。
 * 归属：W1-D 存储代理实现。W0 仅冻结签名。
 */

import { Ok, Err } from '../../../infra/result.js';
import { yieldMain } from '../../../infra/yield-main.js';
import { configError } from '../../../infra/errors.js';
import { mapIdbError, IDB_STORES } from '../idb.js';
import {
    CHARACTER_SCHEMA_VERSION,
    validateCharacter,
    validateCharacterGroup,
} from '../../../domain/model/character.js';
import {
    buildExportEnvelope,
    catchToResult,
    createChangeEmitter,
    parseImportEnvelope,
    resolveDuplicate,
} from '../import-export.js';

/**
 * @param {{ db: object, bus?: object }} deps
 * @returns {import('../../../ports/repository.port.js').CharacterRepository}
 */
export function createCharacterRepo(deps) {
    const db = deps?.db;
    if (!db) {
        throw new Error('createCharacterRepo requires deps.db');
    }
    const changes = createChangeEmitter();
    const GROUPS = IDB_STORES.CHARACTER_GROUPS;
    const CHARS = IDB_STORES.CHARACTERS;

    /**
     * @param {unknown} err
     */
    function mapErr(err) {
        if (err && typeof err === 'object' && 'category' in err && 'code' in err) {
            return /** @type {import('../../../infra/errors.js').AppError} */ (err);
        }
        return mapIdbError(err);
    }

    return {
        async listGroups() {
            return catchToResult(async () => {
                const rows = await db.getAll(GROUPS);
                return rows
                    .map((r) => validateCharacterGroup(r))
                    .filter((r) => r.ok)
                    .map((r) => r.value)
                    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
            }, mapErr, Ok, Err);
        },

        async getGroup(id) {
            return catchToResult(async () => {
                const row = await db.get(GROUPS, id);
                if (!row) {
                    return null;
                }
                const v = validateCharacterGroup(row);
                return v.ok ? v.value : null;
            }, mapErr, Ok, Err);
        },

        async putGroup(group) {
            const validated = validateCharacterGroup(group);
            if (!validated.ok) {
                return validated;
            }
            return catchToResult(async () => {
                await db.put(GROUPS, validated.value);
                changes.emit({ type: 'group:put', id: validated.value.id, groupId: validated.value.id });
                return validated.value;
            }, mapErr, Ok, Err);
        },

        /**
         * 删组时级联删除组内全部角色（需求 4.1：组是容器）。
         */
        async removeGroup(id) {
            return catchToResult(async () => {
                const members = typeof db.getAllByIndex === 'function'
                    ? await db.getAllByIndex(CHARS, 'by_groupId', id)
                    : (await db.getAll(CHARS)).filter((c) => c.groupId === id);
                if (typeof db.runTransaction === 'function') {
                    await db.runTransaction([GROUPS, CHARS], 'readwrite', (stores) => {
                        stores[GROUPS].delete(id);
                        for (const m of members) {
                            stores[CHARS].delete(m.id);
                        }
                    });
                } else {
                    for (const m of members) {
                        await db.delete(CHARS, m.id);
                    }
                    await db.delete(GROUPS, id);
                }
                changes.emit({ type: 'group:remove', id, groupId: id });
            }, mapErr, Ok, Err);
        },

        async listByGroup(groupId) {
            return catchToResult(async () => {
                const rows = typeof db.getAllByIndex === 'function'
                    ? await db.getAllByIndex(CHARS, 'by_groupId', groupId)
                    : (await db.getAll(CHARS)).filter((c) => c.groupId === groupId);
                return rows
                    .map((r) => validateCharacter(r))
                    .filter((r) => r.ok)
                    .map((r) => r.value)
                    .sort((a, b) => a.name.localeCompare(b.name));
            }, mapErr, Ok, Err);
        },

        async get(id) {
            return catchToResult(async () => {
                const row = await db.get(CHARS, id);
                if (!row) {
                    return null;
                }
                const v = validateCharacter(row);
                return v.ok ? v.value : null;
            }, mapErr, Ok, Err);
        },

        async put(character) {
            const validated = validateCharacter(character);
            if (!validated.ok) {
                return validated;
            }
            return catchToResult(async () => {
                const group = await db.get(GROUPS, validated.value.groupId);
                if (!group) {
                    throw configError({
                        code: 'CHAR_GROUP_MISSING',
                        message: '角色所属组不存在',
                        hint: '请先创建或选择角色组',
                        context: { groupId: validated.value.groupId },
                    });
                }
                await db.put(CHARS, validated.value);
                changes.emit({
                    type: 'character:put',
                    id: validated.value.id,
                    groupId: validated.value.groupId,
                });
                return validated.value;
            }, mapErr, Ok, Err);
        },

        async remove(id) {
            return catchToResult(async () => {
                const existing = await db.get(CHARS, id);
                await db.delete(CHARS, id);
                changes.emit({
                    type: 'character:remove',
                    id,
                    groupId: existing?.groupId,
                });
            }, mapErr, Ok, Err);
        },

        async exportJson() {
            return catchToResult(async () => {
                // 与 list 路径一致：只导出通过校验的实体（避免脏行进出不对称）
                const groups = (await db.getAll(GROUPS))
                    .map((r) => validateCharacterGroup(r))
                    .filter((r) => r.ok)
                    .map((r) => r.value)
                    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
                const characters = (await db.getAll(CHARS))
                    .map((r) => validateCharacter(r))
                    .filter((r) => r.ok)
                    .map((r) => r.value)
                    .sort((a, b) => a.name.localeCompare(b.name));
                return buildExportEnvelope({
                    kind: 'character',
                    schemaVersion: CHARACTER_SCHEMA_VERSION,
                    payload: { groups, characters },
                });
            }, mapErr, Ok, Err);
        },

        async importJson(data, opts) {
            const parsed = parseImportEnvelope(data, 'character');
            if (!parsed.ok) {
                return Err(configError({
                    code: 'CHAR_IMPORT_SHAPE',
                    message: parsed.error,
                }));
            }
            const strategy = opts?.strategy || 'skip';
            const body = parsed.value.body;
            const groupsIn = Array.isArray(body.groups) ? body.groups : [];
            const charsIn = Array.isArray(body.characters) ? body.characters : [];
            const total = groupsIn.length + charsIn.length;
            let done = 0;
            let lastYieldAt = 0;
            const report = async (name) => {
                done += 1;
                if (typeof opts?.onProgress === 'function') {
                    opts.onProgress({ index: done, total: total || 1, name });
                }
                const now = typeof performance !== 'undefined' && performance.now
                    ? performance.now()
                    : Date.now();
                if (now - lastYieldAt >= 32 || done === 1 || done === total) {
                    lastYieldAt = now;
                    await yieldMain();
                }
            };

            let imported = 0;
            let skipped = 0;
            /** @type {string[]} */
            const errors = [];
            /** @type {Map<string, string>} 旧 groupId → 新 groupId（rename 时） */
            const groupIdMap = new Map();
            /** @type {any[]} */
            const groupPuts = [];
            /** @type {any[]} */
            const charPuts = [];

            try {
                const existingGroups = await db.getAll(GROUPS);
                const groupById = new Map(existingGroups.map((g) => [g.id, g]));

                for (const raw of groupsIn) {
                    await report(raw?.name || raw?.id || '');
                    const validated = validateCharacterGroup(raw);
                    if (!validated.ok) {
                        errors.push(validated.error.message);
                        continue;
                    }
                    const decision = resolveDuplicate({
                        incoming: validated.value,
                        existing: groupById.get(validated.value.id),
                        strategy,
                        idPrefix: 'cg',
                    });
                    if (decision.action === 'skip') {
                        skipped += 1;
                        groupIdMap.set(validated.value.id, validated.value.id);
                        continue;
                    }
                    groupPuts.push(decision.entity);
                    groupIdMap.set(validated.value.id, decision.entity.id);
                    groupById.set(decision.entity.id, decision.entity);
                    imported += 1;
                }

                const existingChars = await db.getAll(CHARS);
                const charById = new Map(existingChars.map((c) => [c.id, c]));

                for (const raw of charsIn) {
                    await report(raw?.name || raw?.id || '');
                    const mappedGroupId = groupIdMap.get(raw?.groupId) || raw?.groupId;
                    const validated = validateCharacter({
                        ...raw,
                        groupId: mappedGroupId,
                    });
                    if (!validated.ok) {
                        errors.push(validated.error.message);
                        continue;
                    }
                    const decision = resolveDuplicate({
                        incoming: validated.value,
                        existing: charById.get(validated.value.id),
                        strategy,
                        idPrefix: 'ch',
                    });
                    if (decision.action === 'skip') {
                        skipped += 1;
                        continue;
                    }
                    // rename 后仍挂到映射后的组
                    const entity = {
                        ...decision.entity,
                        groupId: mappedGroupId,
                    };
                    const groupExists = groupById.has(entity.groupId);
                    if (!groupExists) {
                        errors.push(`角色 ${entity.name || entity.id} 缺少所属组`);
                        continue;
                    }
                    charPuts.push(entity);
                    charById.set(entity.id, entity);
                    imported += 1;
                }

                if (groupPuts.length || charPuts.length) {
                    if (typeof opts?.onProgress === 'function') {
                        opts.onProgress({ index: total || 1, total: total || 1, name: '正在写入文件' });
                    }
                    if (typeof db.runTransaction === 'function') {
                        await db.runTransaction([GROUPS, CHARS], 'readwrite', (stores) => {
                            for (const row of groupPuts) stores[GROUPS].put(row);
                            for (const row of charPuts) stores[CHARS].put(row);
                        });
                    } else {
                        for (const row of groupPuts) await db.put(GROUPS, row);
                        for (const row of charPuts) await db.put(CHARS, row);
                    }
                }

                changes.emit({ type: 'import', imported, skipped });
                return Ok({ imported, skipped, errors });
            } catch (err) {
                return Err(mapErr(err));
            }
        },

        onChanged(fn) {
            return changes.subscribe(fn);
        },
    };
}
