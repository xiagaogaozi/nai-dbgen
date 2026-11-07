/**
 * 独立标签超市：单份服务器 JSON 文件，不复用旧 TagRepository。
 * 数据格式仍是 tag envelope；key 使用多级 · 路径，末段为中文叶子名。
 */
import { Err, Ok } from '../../infra/result.js';
import { configError } from '../../infra/errors.js';
import { SERVER_FILE_PREFIX } from './server-files.js';

export const MARKET_CATALOG_FILE = `${SERVER_FILE_PREFIX}market_catalog.json`;

/** @param {unknown} raw */
export function validateMarketCatalog(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, message: '标签超市必须是 JSON 对象' };
    const catalog = /** @type {Record<string, unknown>} */ (raw);
    if (catalog.kind !== 'tag' || !Array.isArray(catalog.libraries) || !Array.isArray(catalog.entries)) {
        return { ok: false, message: '标签超市格式无效：需要 tag 类型的 libraries/entries 信封' };
    }
    const libraries = catalog.libraries;
    const libraryIds = new Set();
    for (const lib of libraries) {
        if (!lib || typeof lib !== 'object' || typeof lib.id !== 'string' || !lib.id) return { ok: false, message: '标签超市包含无效库 ID' };
        if (libraryIds.has(lib.id)) return { ok: false, message: `标签超市库 ID 重复：${lib.id}` };
        libraryIds.add(lib.id);
    }
    const ids = new Set();
    for (const entry of catalog.entries) {
        if (!entry || typeof entry !== 'object') return { ok: false, message: '标签超市包含无效条目' };
        const row = /** @type {Record<string, unknown>} */ (entry);
        const id = typeof row.id === 'string' ? row.id : '';
        const key = typeof row.key === 'string' ? row.key : '';
        const value = typeof row.value === 'string' ? row.value : '';
        const path = key.split('·').map((part) => part.trim());
        if (!id || ids.has(id)) return { ok: false, message: `标签超市条目 ID 缺失或重复：${id || key}` };
        if (typeof row.libraryId !== 'string' || !libraryIds.has(row.libraryId)) return { ok: false, message: `条目「${key}」没有对应来源库` };
        if (path.length < 2 || path.some((part) => !part || /^(待审核-|待分类$|待命名-)/.test(part))) {
            return { ok: false, message: `条目「${key}」尚未完成分类或命名审核` };
        }
        if (!value.trim()) return { ok: false, message: `条目「${key}」缺少英文 tag/value` };
        ids.add(id);
    }
    if (!catalog.entries.length) return { ok: false, message: '标签超市没有条目' };
    return { ok: true, value: /** @type {any} */ (raw) };
}

/** @param {{ readJson: Function, writeJson: Function }} serverFiles */
export function createMarketCatalogStore(serverFiles) {
    if (!serverFiles || typeof serverFiles.readJson !== 'function' || typeof serverFiles.writeJson !== 'function') {
        throw new Error('createMarketCatalogStore requires serverFiles');
    }
    return {
        async load() {
            const result = await serverFiles.readJson(MARKET_CATALOG_FILE);
            if (!result?.ok || result.value == null) return result;
            const valid = validateMarketCatalog(result.value);
            return valid.ok ? result : Err(configError({ code: 'MARKET_CATALOG_INVALID', message: valid.message, hint: '请通过工作台“导入”载入审核完成的标签超市文件' }));
        },
        async clear() {
            if (typeof serverFiles.remove !== 'function') {
                return Err(configError({ code: 'MARKET_CATALOG_CLEAR_UNAVAILABLE', message: '标签超市清空功能不可用' }));
            }
            return serverFiles.remove(MARKET_CATALOG_FILE);
        },
        async replace(data) {
            const valid = validateMarketCatalog(data);
            if (!valid.ok) return Err(configError({ code: 'MARKET_CATALOG_INVALID', message: valid.message, hint: '请修正标签超市文件后重试' }));

            // Keep the exact previous payload so a failed replacement cannot strand a partial/new file.
            const previous = await serverFiles.readJson(MARKET_CATALOG_FILE);
            if (!previous?.ok) return previous;

            const saved = await serverFiles.writeJson(MARKET_CATALOG_FILE, data);
            if (saved?.ok) return saved;

            const rollback = previous.value == null
                ? await serverFiles.remove(MARKET_CATALOG_FILE)
                : await serverFiles.writeJson(MARKET_CATALOG_FILE, previous.value);
            if (!rollback?.ok) {
                return Err(configError({
                    code: 'MARKET_CATALOG_ROLLBACK_FAILED',
                    message: '标签超市替换失败，且旧文件恢复未能确认',
                    hint: '请检查服务器上的 nai-dbgen_market_catalog.json，并在工作台重新导入备份',
                    cause: saved.error,
                    context: { rollbackError: rollback?.error?.message ?? 'unknown' },
                }));
            }
            return saved;
        },
    };
}
