# shujuku 条件模板兼容修复 · 0.2.41

原先通过 `ChatCompletionService.sendRequest` 发出的召回、单图和楼层生图提示词，没有经过酒馆的发送前模板事件。世界书或上下文中的 shujuku 条件模板因此原样进入请求，未命中分支也被发送。

## shujuku 的实际处理机制

核对来源为用户提供的 `小玉替换/shujuku` 源码：

- `src/presentation/bootstrap/init.ts`：通过 `makeLast`（旧宿主回退到 `on`）注册 `CHAT_COMPLETION_SETTINGS_READY` 监听器，排在其他提示词模板扩展之后。
- `src/service/runtime/helpers-remaining.ts`：`handleChatCompletionReady_ACU` 逐条处理最终 `messages`，也处理多模态数组中的文本分段。
- `src/service/runtime/template-vars/acu-template-vars.ts`：依次处理 random → calc/max/min → db/sql 和 `$v:` → script → if。
- `src/service/runtime/template-vars/if-block-parser.ts`：识别双引号形式的 `<if seed/cell/cond/db/sql="...">`，按条件保留一个分支，并继续调用原有嵌套解析逻辑。

| 条件 | 实际数据依赖 |
| --- | --- |
| `seed` | shujuku 从宿主读取的最新 AI 回复和最新剧情推进数据 |
| `cell` | shujuku 的 `currentJsonTableData_ACU`，按表名、行标识和列名取值 |
| `cond` | seed/cell/random/calc/max/min/db/sql/v 等子条件及其变量存储，支持组合逻辑 |
| `db` | SQLite 模式、当前 storage provider、ORM 查询构建器和中英文名称映射器 |
| `sql` | SQLite 模式、当前 storage provider 和 SQL 名称翻译；读取查询结果的首行首列判断真值 |

条件模板受 `promptTemplateSettings.enabled` 控制。`db` / `sql` 条件在非 SQLite 模式下按 shujuku 原有规则为 false。
`seed` 和表格数据使用 shujuku 当前运行时状态；nai-dbgen 没有从自己的上下文窗口另行推断或覆盖这些状态。

酒馆的 `public/scripts/openai.js` 会在请求前等待此事件；`public/scripts/custom-request.js` 中的 `ChatCompletionService.sendRequest` 仅发送 HTTP，不包含这个步骤。
shujuku 的 `renderWorldbookForPrompt` 也没有完整执行上述条件模板链路，不能用它替代最终消息处理。

## nai-dbgen 改动

`src/adapters/host/chat-completion.bridge.js` 对消息创建副本，等待同一个 `CHAT_COMPLETION_SETTINGS_READY` 事件，让已加载的 shujuku 使用其原解析器和运行时数据处理最终内容。
`src/adapters/llm/transport/st-backend.js` 在预设变量、世界书、上下文、参考图片均已组装后调用此桥接，再发送处理结果。召回、工作台和楼层生成共享这个入口。

事件后仍有已知类型的 `<if ...>` 起始标签时，返回 `LLM_ACU_IF_UNRESOLVED`；事件直接抛错时返回 `LLM_PROMPT_TEMPLATE_FAILED`。两者均不可重试，不调用发送接口。
这涵盖 shujuku 未加载、模板功能关闭、语法不完整和部分解析等情况。错误只记录条件数量和类型，不复制大段提示词正文。
普通消息在没有模板事件的宿主上保持可用。未增加任意长度截断；普通未知模板保持原文。

## 验证

- 发送桥接、LLM 网关、请求配置、预设渲染及启动装配的针对性测试：88 项通过，其中新增 15 项。
- 直接加载上述 shujuku 事件处理器及 8 个相关源码模块，配合酒馆原 EventEmitter 和真实 sql.js：20 个集成用例通过。覆盖五类条件、真假分支、组合与嵌套、中文名称映射、数据库变量与随机/计算变量的顺序、当前数据库状态变化、传统表格模式、多模态文本、前置异步监听器，以及关闭模板后的拦截。
- 大分支夹具：1,000 个未命中分支与一个命中分支，输入 523,915 个字符，发送接口收到 6 个字符的命中内容。字符数不等于 token 数。
- 全量测试：822 项，805 通过、12 失败、5 取消。用未修改的 HEAD 独立解包，并挂载相同 node_modules 和上级 ref 后复跑：807 项，790 通过、12 失败、5 取消；失败项名称完全一致。其中本地预览服务无法监听 `127.0.0.1`（沙箱 `EPERM`），其余为既有预览夹具及 UI 断言问题。

源码集成检查可重复运行（依赖 shujuku 已安装的 TypeScript 和 sql.js，SillyTavern 源码默认取上级 `ref/SillyTavern`）：

```sh
node tests/manual/shujuku-if-compat.mjs /path/to/shujuku [/path/to/SillyTavern]
```

集成验证使用构造的聊天/表格/剧情状态、SQL provider 边界和发送接口，脚本变量解析器用异步原样返回替身；条件求值、ORM、SQL 和名称映射执行真实源码。尚未在用户的运行中酒馆会话里捕获并复测原先的超大请求，也未调用真实模型。
