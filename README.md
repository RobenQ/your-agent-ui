# your-agent-ui

一个简单的 chat agent 前端页面。

配合 `your-agent`、`your-agent-mcp-server` 使用，可快速实现一个支持 tool call、工具调用审批、skill 的 chat agent。

## 功能

- 三种通信协议：**SSE** / **HTTP** / **WebSocket**（可切换）
- 流式输出（token 逐字渲染 + 光标动画）
- **Markdown 渲染**（标题、粗体/斜体、代码块、表格、列表、引用、链接等）
- 工具调用展示（`tool_start` / `tool_end`，**可折叠气泡，默认折叠**）
- 工具调用审批（interrupt → 批准/拒绝 → 自动恢复）
- 多会话管理，本地持久化（localStorage，最多 15 个会话 / 每会话 200 条消息）
- **会话重命名 / 删除**（悬停会话项显示操作按钮）
- 历史消息完整重放（含 node 标签、tool 消息、审批记录）

## 目录结构

```
your-agent-ui/
├── index.html          # 页面结构
├── css/index.css       # 样式
├── js/index.js         # 主逻辑
└── js/markdown.js      # 轻量 Markdown 渲染器（无依赖）
```

## 配置后端地址

默认后端为 `http://192.168.124.6:8090`。可通过以下方式覆盖（优先级从高到低）：

1. URL 参数：`index.html?base=http://your-host:8090`
2. localStorage：`localStorage.setItem("agent_base_url", "http://your-host:8090")`
3. 修改 `js/index.js` 中的 `DEFAULT_CONFIG.baseUrl`

## 后端接口约定

| 协议 | 路径 | 说明 |
|---|---|---|
| SSE | `POST /chat/invoke_stream` | 首次发送，`text/event-stream` |
| SSE | `POST /chat/resume_stream` | 审批后恢复 |
| HTTP | `POST /chat/invoke` | 首次发送，JSON 响应 |
| HTTP | `POST /chat/resume` | 审批后恢复 |
| WS | `ws://.../chat/ws` | 双向流式 |

事件格式（SSE / WS 一致）：

```json
{ "type": "token", "content": "..." }
{ "type": "node", "name": "..." }
{ "type": "tool_start", "name": "...", "input": {} }
{ "type": "tool_end", "name": "...", "output": "..." }
{ "type": "interrupt", "id": "...", "value": "..." }
{ "type": "error", "message": "..." }
{ "type": "done" }
```

## 本次优化要点

- 修复流式内容回填错位（`syncAgentContent` 启发式 → 显式 `persistTurn`）
- 流式期间不再逐 token 写 localStorage，结束后一次性持久化
- 修复「流式中新建会话导致内容串会话」问题（会话快照校验）
- 历史重放完整保留 node 标签 / tool 消息 / 审批记录
- SSE 解析兼容 `data:` 无空格、多行、`[DONE]`，解析失败不再静默吞错
- WebSocket 未收到 `done` 即关闭时按异常处理（不再误判为正常结束）
- 抽出统一协议适配层，消除 WS 首次/恢复的重复代码
- 滚动节流（requestAnimationFrame）、错误气泡样式、无障碍属性
- 后端地址可配置化

## 会话管理

- **重命名**：鼠标悬停在会话项上，点击 ✏️ 按钮，原地变为输入框。
  - `Enter` 确认，`Esc` 取消，失焦自动确认。
  - 标题最长 50 字符，空标题不保存。
- **删除**：点击 🗑️ 按钮，二次确认后删除。
  - 若删除的是当前会话，自动切换到剩余列表第一个；若无剩余会话则自动新建。
- 流式生成中禁止重命名/删除，避免状态错乱。

## 工具调用气泡

- 每次工具调用渲染为一个**可折叠气泡**，**默认折叠**，只显示头部（图标 + 工具名）。
- 点击头部（或键盘 Enter / 空格）展开/收起，查看参数与结果。
- `tool_start` 与 `tool_end` **合并为同一个气泡**：开始时显示「🔧 调用工具」，结束后原地更新为「✅ 工具完成」并补充结果，不会产生两个气泡。
- 历史重放时同样保持折叠状态与完整参数/结果。
- 兼容多种后端字段名：`name`/`tool`/`tool_name`、`input`/`args`/`arguments`、`output`/`result`/`content`。

### 排查：工具气泡不显示

1. 打开浏览器控制台，查看是否有 `[agent-ui] 未处理的事件类型:` 日志——若有，说明后端事件名不是 `tool_start`/`tool_end`。
2. 查看是否有 `事件处理失败:` 错误——已做保护，单个事件异常不会中断整个流。
3. 确认后端确实发送了 `tool_start` / `tool_end` 事件（可在 Network → EventStream 中查看）。
4. 若使用 HTTP 协议，当前实现只渲染最终 `content`，不展示工具调用（需后端在 JSON 中返回工具信息）。

## Markdown 渲染

- 使用自研轻量渲染器 `js/markdown.js`，**无第三方依赖、可离线**。
- **安全**：先整体 HTML 转义再生成受控标签，杜绝 XSS。
- **性能**：流式过程中保持纯文本（避免每 token 重解析），流结束后一次性渲染为 Markdown。
- 支持：标题、粗体/斜体/删除线、行内代码、代码块（带语言标识）、链接、图片、有序/无序列表、引用、分割线、表格。
- 仅 `agent` 消息启用 Markdown；`user` / `tool` 消息保持纯文本。
