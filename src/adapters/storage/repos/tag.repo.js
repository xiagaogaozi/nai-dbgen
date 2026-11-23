/**
 * L2 适配器 · TagLibrary / TagEntry 两层仓库（裁决 D7）。
 * 归属：W1-D 存储代理实现。W0 仅冻结签名。
 */

import { Ok, Err } from '../../../infra/result.js';
import { yieldMain } from '../../../infra/yield-main.js';
import { configError } from '../../../infra/errors.js';
import { mapIdbError, IDB_STORES } from '../idb.js';
import {
    TAG_SCHEMA_VERSION,
    normalizeTagLibraryKind,
    validateTagEntry,
    validateTagLibrary,
    assertSecondaryFieldsAllowed,
} from '../../../domain/model/tag.js';
import { validateTagEntryWriting } from '../../../domain/model/tag-writing.js';
import {
    buildExportEnvelope,
    catchToResult,
    createChangeEmitter,
    parseImportEnvelope,
    resolveDuplicate,
} from '../import-export.js';

/**
 * @param {string} kind
 * @returns {string}
 */
function kindLabelForError(kind) {
    const k = normalizeTagLibraryKind(kind);
    if (k === 'feature') return '特征库';
    if (k === 'constant') return '常驻库';
    return '构图库';
}

/**
 * @param {{ db: object, bus?: object }} deps
 * @returns {import('../../../ports/repository.port.js').TagRepository}
 */
export function createTagRepo(deps) {
    const db = deps?.db;
    if (!db) {
        throw new Error('createTagRepo requires deps.db');
    }
    const changes = createChangeEmitter();
    const LIBS = IDB_STORES.TAG_LIBRARIES;
    const ENTRIES = IDB_STORES.TAG_ENTRIES;

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
        async listLibraries() {
            return catchToResult(async () => {
                const rows = await db.getAll(LIBS);
                return rows
                    .map((r) => validateTagLibrary(r))
                    .filter((r) => r.ok)
                    .map((r) => r.value)
                    .sort((a, b) => a.name.localeCompare(b.name));
            }, mapErr, Ok, Err);
        },

        async getLibrary(id) {
            return catchToResult(async () => {
                const row = await db.get(LIBS, id);
                if (!row) {
                    return null;
                }
                const v = validateTagLibrary(row);
                return v.ok ? v.value : null;
            }, mapErr, Ok, Err);
        },

        async putLibrary(library) {
            const validated = validateTagLibrary(library);
            if (!validated.ok) {
                return validated;
            }
            return catchToResult(async () => {
                await db.put(LIBS, validated.value);
                changes.emit({ type: 'library:put', id: validated.value.id, libraryId: validated.value.id });
                return validated.value;
            }, mapErr, Ok, Err);
        },

        /**
         * 删库时级联删除库内条目。
         */
        async removeLibrary(id) {
            return catchToResult(async () => {
                const members = typeof db.getAllByIndex === 'function'
                    ? await db.getAllByIndex(ENTRIES, 'by_libraryId', id)
                    : (await db.getAll(ENTRIES)).filter((e) => e.libraryId === id);
                if (typeof db.runTransaction === 'function') {
                    await db.runTransaction([LIBS, ENTRIES], 'readwrite', (stores) => {
                        stores[LIBS].delete(id);
                        for (const m of members) {
                            stores[ENTRIES].delete(m.id);
                        }
                    });
                } else {
                    for (const m of members) {
                        await db.delete(ENTRIES, m.id);
                    }
                    await db.delete(LIBS, id);
                }
                changes.emit({ type: 'library:remove', id, libraryId: id });
            }, mapErr, Ok, Err);
        },

        async listEntries(libraryId) {
            return catchToResult(async () => {
                let rows;
                if (libraryId != null && libraryId !== '') {
                    rows = typeof db.getAllByIndex === 'function'
                        ? await db.getAllByIndex(ENTRIES, 'by_libraryId', libraryId)
                        : (await db.getAll(ENTRIES)).filter((e) => e.libraryId === libraryId);
                } else {
                    rows = await db.getAll(ENTRIES);
                }
                return rows
                    .map((r) => validateTagEntry(r))
                    .filter((r) => r.ok)
                    .map((r) => r.value);
            }, mapErr, Ok, Err);
        },

        async get(id) {
            return catchToResult(async () => {
                const row = await db.get(ENTRIES, id);
                if (!row) {
                    return null;
                }
                const v = validateTagEntry(row);
                return v.ok ? v.value : null;
            }, mapErr, Ok, Err);
        },

        async put(entry) {
            const validated = validateTagEntry(entry);
            if (!validated.ok) {
                return validated;
            }
            return catchToResult(async () => {
                const lib = await db.get(LIBS, validated.value.libraryId);
                if (!lib) {
                    throw configError({
                        code: 'TAG_LIB_MISSING',
                        message: '标签条目所属库不存在',
                        hint: '请先创建或选择标签库',
                        context: { libraryId: validated.value.libraryId },
                    });
                }
                const kind = normalizeTagLibraryKind(lib.kind);
                const secondaryOk = assertSecondaryFieldsAllowed(kind, entry);
                if (!secondaryOk.ok) {
                    throw secondaryOk.error;
                }
                const writing = validateTagEntryWriting(
                    kind,
                    validated.value.key,
                    validated.value.value,
                );
                if (!writing.ok) {
                    throw writing.error;
                }
                await db.put(ENTRIES, validated.value);
                changes.emit({
                    type: 'entry:put',
                    id: validated.value.id,
                    libraryId: validated.value.libraryId,
                });
                return validated.value;
            }, mapErr, Ok, Err);
        },

        async remove(id) {
            return catchToResult(async () => {
                const existing = await db.get(ENTRIES, id);
                await db.delete(ENTRIES, id);
                changes.emit({
                    type: 'entry:remove',
                    id,
                    libraryId: existing?.libraryId,
                });
            }, mapErr, Ok, Err);
        },

        async exportJson() {
            return catchToResult(async () => {
                // 与 list 路径一致：只导出通过校验的实体
                const libraries = (await db.getAll(LIBS))
                    .map((r) => validateTagLibrary(r))
                    .filter((r) => r.ok)
                    .map((r) => r.value)
                    .sort((a, b) => a.name.localeCompare(b.name));
                const entries = (await db.getAll(ENTRIES))
                    .map((r) => validateTagEntry(r))
                    .filter((r) => r.ok)
                    .map((r) => r.value);
                return buildExportEnvelope({
                    kind: 'tag',
                    schemaVersion: TAG_SCHEMA_VERSION,
                    payload: { libraries, entries },
                });
            }, mapErr, Ok, Err);
        },

        async importJson(data, opts) {
            const parsed = parseImportEnvelope(data, 'tag');
            if (!parsed.ok) {
                return Err(configError({
                    code: 'TAG_IMPORT_SHAPE',
                    message: parsed.error,
                }));
            }
            const strategy = opts?.strategy || 'skip';
            const body = parsed.value.body;
            const libsIn = Array.isArray(body.libraries) ? body.libraries : [];
            const entriesIn = Array.isArray(body.entries) ? body.entries : [];
            const total = libsIn.length + entriesIn.length;
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
            /** @type {Map<string, string>} */
            const libIdMap = new Map();

            try {
                const existingLibs = await db.getAll(LIBS);
                const libById = new Map(existingLibs.map((l) => [l.id, l]));

                /** @type {string[]} */
                const preflightErrors = [];
                /** @type {Map<string, { name: string, kind: string }>} */
                const libMetaById = new Map(
                    existingLibs.map((l) => [l.id, { name: String(l.name ?? l.id), kind: String(l.kind ?? 'composition') }]),
                );
                /** @type {any[]} */
                const validatedLibs = [];
                /** @type {any[]} */
                const validatedEntries = [];

                for (const raw of libsIn) {
                    await report(raw?.name || raw?.id || '');
                    const validated = validateTagLibrary(raw);
                    if (!validated.ok) {
                        preflightErrors.push(validated.error.message);
                        continue;
                    }
                    validatedLibs.push(validated.value);
                    libMetaById.set(validated.value.id, {
                        name: validated.value.name,
                        kind: validated.value.kind,
                    });
                }

                for (const raw of entriesIn) {
                    await report(raw?.key || raw?.id || '');
                    const validated = validateTagEntry(raw);
                    if (!validated.ok) {
                        const keyHint = raw && typeof raw === 'object' && raw.key != null
                            ? String(raw.key)
                            : '(无 key)';
                        preflightErrors.push(`条目「${keyHint}」：${validated.error.message}`);
                        continue;
                    }
                    const libMeta = libMetaById.get(validated.value.libraryId);
                    if (!libMeta) {
                        preflightErrors.push(
                            `条目「${validated.value.key}」缺少所属库`,
                        );
                        continue;
                    }
                    const kind = normalizeTagLibraryKind(libMeta.kind);
                    const libName = libMeta.name;
                    const secondaryOk = assertSecondaryFieldsAllowed(kind, raw);
                    if (!secondaryOk.ok) {
                        preflightErrors.push(
                            `${kindLabelForError(kind)}「${libName}」条目「${validated.value.key}」：${secondaryOk.error.message}`,
                        );
                        continue;
                    }
                    const writing = validateTagEntryWriting(
                        kind,
                        validated.value.key,
                        validated.value.value,
                    );
                    if (!writing.ok) {
                        preflightErrors.push(
                            `${kindLabelForError(kind)}「${libName}」条目「${validated.value.key}」：${writing.error.message}`,
                        );
                        continue;
                    }
                    validatedEntries.push(validated.value);
                }

                if (preflightErrors.length > 0) {
                    return Err(configError({
                        code: 'TAG_IMPORT_INVALID',
                        message: `导入失败，未写入任何内容：\n${preflightErrors.join('\n')}`,
                        context: { errors: preflightErrors },
                    }));
                }

                /** @type {any[]} */
                const libPuts = [];
                for (const lib of validatedLibs) {
                    const decision = resolveDuplicate({
                        incoming: lib,
                        existing: libById.get(lib.id),
                        strategy,
                        idPrefix: 'tl',
                    });
                    if (decision.action === 'skip') {
                        skipped += 1;
                        libIdMap.set(lib.id, lib.id);
                        continue;
                    }
                    libPuts.push(decision.entity);
                    libIdMap.set(lib.id, decision.entity.id);
                    libById.set(decision.entity.id, decision.entity);
                    imported += 1;
                }

                const existingEntries = await db.getAll(ENTRIES);
                const entryById = new Map(existingEntries.map((e) => [e.id, e]));
                /** @type {any[]} */
                const entryPuts = [];

                for (const entry of validatedEntries) {
                    const mappedLibId = libIdMap.get(entry.libraryId) || entry.libraryId;
                    const decision = resolveDuplicate({
                        incoming: { ...entry, libraryId: mappedLibId },
                        existing: entryById.get(entry.id),
                        strategy,
                        idPrefix: 'te',
                    });
                    if (decision.action === 'skip') {
                        skipped += 1;
                        continue;
                    }
                    const entity = { ...decision.entity, libraryId: mappedLibId };
                    entryPuts.push(entity);
                    entryById.set(entity.id, entity);
                    imported += 1;
                }

                if (libPuts.length || entryPuts.length) {
                    if (typeof opts?.onProgress === 'function') {
                        opts.onProgress({ index: total || 1, total: total || 1, name: '正在写入文件' });
                    }
                    await yieldMain();
                    if (typeof db.runTransaction === 'function') {
                        await db.runTransaction([LIBS, ENTRIES], 'readwrite', (stores) => {
                            for (const row of libPuts) stores[LIBS].put(row);
                            for (const row of entryPuts) stores[ENTRIES].put(row);
                        });
                    } else {
                        for (const row of libPuts) await db.put(LIBS, row);
                        for (const row of entryPuts) await db.put(ENTRIES, row);
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
