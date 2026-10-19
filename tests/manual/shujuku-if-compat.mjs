import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

// Run the supplied shujuku sources without mounting its UI or sending HTTP requests.
if (!process.argv[2]) throw new Error('用法: node tests/manual/shujuku-if-compat.mjs <shujuku目录> [SillyTavern目录]');
const shujuku = path.resolve(process.argv[2]);
const pluginRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const tavernRoot = process.argv[3] ? path.resolve(process.argv[3]) : path.join(pluginRoot, '../ref/SillyTavern');
const testedPackage = process.env.NAI_DBGEN_PROOF_PACKAGE || pluginRoot;
const { createStBackendLlmTransport } = await import(pathToFileURL(path.join(testedPackage, 'src/adapters/llm/transport/st-backend.js')));
const require = createRequire(path.join(shujuku, 'package.json'));
const ts = require('typescript');
const SQL = await require('sql.js')();
const db = new SQL.Database();
const ddl = `CREATE TABLE inventory ( -- 背包物品表
  row_id INTEGER PRIMARY KEY, -- 行号
  item_name TEXT NOT NULL, -- 物品名称
  quantity INTEGER DEFAULT 1 -- 数量
);`;
db.run(ddl);
db.run("INSERT INTO inventory (item_name, quantity) VALUES ('铁剑', 2)");
const settings = { promptTemplateSettings: { enabled: true } };
const tables = { sheet_stats: { name: '状态', content: [['姓名', '体力'], ['主角', '80']] } };
const runtime = { chat: [{ is_user: false, mes: '主角正在战斗，手持铁剑' }], plot: '即将进入森林', sqlite: true };
const warnings = [];
const logs = {
    logDebug_ACU() {},
    logWarn_ACU: (...args) => warnings.push(args.join(' ')),
    logError_ACU: (...args) => warnings.push(args.join(' ')),
};
const mocks = new Map(Object.entries({
    'shared/utils.ts': logs,
    'service/runtime/state-manager.ts': { settings_ACU: settings, currentJsonTableData_ACU: tables },
    'data/gateways/chat-gateway.ts': { getChatArray_ACU: () => runtime.chat },
    'service/runtime/plot-runtime.ts': { getPlotFromHistory_ACU: () => runtime.plot },
    'service/scripts/script-tavern-facade.ts': { getScriptCurrentMainReplyRequestId_ACU: () => null },
    'service/scripts/script-variable-resolver.ts': {
        replaceScriptVariables_ACU: async (text) => { await Promise.resolve(); return text; },
    },
    'service/table/storage-mode.ts': { isSqliteMode: () => runtime.sqlite },
    'service/table/table-storage-strategy.ts': {
        getStorageProvider: () => ({ executeQuery: (sql) => db.exec(sql)[0] || { columns: [], values: [] } }),
    },
}));
const cache = new Map();
function load(relative) {
    relative = relative.replaceAll('\\', '/');
    if (relative === 'service/runtime/template-vars.ts') relative = 'service/runtime/template-vars/if-block-parser.ts';
    if (mocks.has(relative)) return mocks.get(relative);
    if (cache.has(relative)) return cache.get(relative).exports;
    const filename = path.join(shujuku, 'src', relative);
    let source = fs.readFileSync(filename, 'utf8');
    if (relative === 'service/runtime/helpers-remaining.ts') {
        // Remove only unrelated re-exports; run the original event handler body unchanged.
        const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
        source = ast.statements.filter((statement) => !ts.isExportDeclaration(statement))
            .map((statement) => statement.getFullText(ast)).join('\n');
    }
    const compiled = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        fileName: filename,
    }).outputText;
    const module = { exports: {} };
    cache.set(relative, module);
    const localRequire = (specifier) => {
        assert.ok(specifier.startsWith('.'), `unexpected package import: ${specifier}`);
        const target = path.normalize(path.join(path.dirname(relative), specifier));
        return load(target.endsWith('.ts') ? target : `${target}.ts`);
    };
    new Function('exports', 'require', 'module', compiled)(module.exports, localRequire, module);
    return module.exports;
}

const handler = load('service/runtime/helpers-remaining.ts').handleChatCompletionReady_ACU;
load('service/runtime/template-vars/name-mapper.ts').buildGlobalNameMapper(new Map([['inventory', ddl]]));
const emitterSource = fs.readFileSync(path.join(tavernRoot, 'public/lib/eventemitter.js'), 'utf8');
const EventEmitter = new Function('localStorage', 'console', emitterSource.replace('export { EventEmitter }', 'return EventEmitter;'))(
    { getItem: () => null }, { debug() {}, error() {}, trace() {} },
);
const event = 'chat_completion_settings_ready';
const eventSource = new EventEmitter();
const calls = [];
eventSource.on(event, async (data) => {
    // A previous template extension may generate ACU syntax asynchronously.
    await Promise.resolve();
    for (const message of data.messages) {
        if (typeof message.content === 'string') message.content = message.content.replace('EJS_FIXTURE', '<if seed="战斗">从前置模板生成</if>');
    }
});
eventSource.makeLast(event, handler);
const ctx = {
    eventTypes: { CHAT_COMPLETION_SETTINGS_READY: event }, eventSource,
    ChatCompletionService: {
        createRequestData: (data) => data,
        async sendRequest(data) { calls.push(structuredClone(data)); return { content: 'ok' }; },
    },
};
const transport = createStBackendLlmTransport({ getContext: () => ctx });
const config = { name: 'proof', model: 'proof', apiKey: 'sk-fixture', baseUrl: 'https://example.invalid/v1' };
let cases = 0;
async function check(label, input, expected) {
    const messages = [{ role: 'user', content: input }];
    const result = await transport.complete({ config, messages });
    assert.equal(result.ok, true, `${label}: ${result.error?.message}`);
    assert.equal(calls.at(-1).messages[0].content, expected, label);
    assert.equal(messages[0].content, input, `${label}: caller data mutated`);
    cases++;
}

await check('seed true', '<if seed="战斗">A<else>B</if>', 'A');
await check('seed false', '<if seed="沙漠">A<else>B</if>', 'B');
await check('plot seed', '<if seed="森林">A<else>B</if>', 'A');
await check('cell true', '<if cell="状态/主角/体力 >= 80">A<else>B</if>', 'A');
await check('cell false', '<if cell="状态/主角/体力 < 80">A<else>B</if>', 'B');
await check('cond combined', '<if cond="seed:战斗 & cell:状态/主角/体力 >= 80">A<else>B</if>', 'A');
await check('db true with Chinese mapping', "<if db=\"背包物品表.where('物品名称', '铁剑').count() > 0\">A<else>B</if>", 'A');
await check('db false', "<if db=\"inventory.where('item_name', '魔杖').count() > 0\">A<else>B</if>", 'B');
await check('SQL true with Chinese mapping', '<if sql="SELECT COUNT(*) FROM 背包物品表 WHERE 数量 > 0">A<else>B</if>', 'A');
await check('SQL false', '<if sql="SELECT 1 WHERE 0">A<else>B</if>', 'B');
await check('db variable before cond', "{[db.inventory.count() as n]}<if cond=\"v:n >= 1\">count=$v:n<else>empty</if>", 'count=1');
await check('random and calc before if', '<random id="r" min="3" max="3"/><calc id="c" expr="$random:r * 2"/><if cond="calc:c == 6">A<else>B</if>', 'A');
await check('nested conditions', '<if seed="战斗">A<if cell="状态/主角/体力 > 50">B</if></if>', 'AB');
await check('prior event listener', 'EJS_FIXTURE', '从前置模板生成');

runtime.sqlite = false;
await check('legacy cell', '<if cell="状态/主角/体力 >= 80">A<else>B</if>', 'A');
await check('legacy db follows upstream false', '<if db="inventory.count() > 0">A<else>B</if>', 'B');
runtime.sqlite = true;
db.run('DELETE FROM inventory');
await check('current DB state changes branch', '<if db="inventory.count() > 0">A<else>B</if>', 'B');

const huge = Array.from({ length: 1000 }, (_, index) => `<if seed="未出现_${index}">${'不应发送'.repeat(125)}</if>`).join('')
    + '<if seed="战斗">唯一命中分支</if>';
await check('1000 false branches', huge, '唯一命中分支');
const inputChars = huge.length;
const outputChars = calls.at(-1).messages[0].content.length;
const multi = [{ role: 'user', content: [
    { type: 'text', text: '<if seed="战斗">多模态命中<else>不应发送</if>' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
] }];
assert.equal((await transport.complete({ config, messages: multi })).ok, true);
assert.equal(calls.at(-1).messages[0].content[0].text, '多模态命中');
assert.deepEqual(calls.at(-1).messages[0].content[1], multi[0].content[1]);
cases++;

settings.promptTemplateSettings.enabled = false;
const before = calls.length;
const blocked = await transport.complete({ config, messages: [{ role: 'user', content: huge }] });
assert.equal(blocked.error.code, 'LLM_ACU_IF_UNRESOLVED');
assert.equal(calls.length, before);
cases++;
assert.deepEqual(warnings, [], `unexpected upstream warnings: ${warnings.join('\n')}`);
db.close();
console.log(JSON.stringify({ testedPackage, casesPassed: cases, inputChars, outputChars, falseBranches: 1000,
    sourceModules: [...cache.keys()], realSqlite: true, realEventEmitter: true,
    mockedBoundaries: ['host chat/tables/settings/plot', 'script variable resolver (async identity)', 'SQL storage provider over actual sql.js', 'HTTP sendRequest'] }, null, 2));
