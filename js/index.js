/**
 * your-agent-ui 前端主逻辑（优化版）
 * 修复：工具调用气泡标题状态不实时更新（需刷新页面才变「已完成」）
 * ------------------------------------------------------------
 * 结构：
 *   1. CONFIG        配置（支持 URL 参数 / localStorage 覆盖）
 *   2. SessionStore  会话持久化（localStorage）
 *   3. state         运行时状态
 *   4. UI            渲染层（消息 / 会话列表 / 状态栏）
 *   5. Transport     协议适配层（SSE / HTTP / WebSocket 统一接口）
 *   6. Controller    发送入口 + 中断审批循环
 * ------------------------------------------------------------
 */
(function () {
	"use strict";

	// ==================== 1. 配置 ====================
	const DEFAULT_CONFIG = {
		baseUrl: "http://192.168.124.6:8090",
		paths: {
			sse: "/chat/invoke_stream",
			sseResume: "/chat/resume_stream",
			ws: "/chat/ws",
			http: "/chat/invoke",
			httpResume: "/chat/resume",
		},
	};

	/**
	 * 解析最终配置：
	 * 优先级：URL 参数 ?base=... > localStorage(agent_base_url) > 默认值
	 */
	function resolveConfig() {
		const params = new URLSearchParams(location.search);
		const base =
			params.get("base") ||
			localStorage.getItem("agent_base_url") ||
			DEFAULT_CONFIG.baseUrl;
		const wsBase = base.replace(/^http/, "ws");
		const p = DEFAULT_CONFIG.paths;
		return {
			sseUrl: base + p.sse,
			sseResumeUrl: base + p.sseResume,
			wsUrl: wsBase + p.ws,
			httpUrl: base + p.http,
			httpResumeUrl: base + p.httpResume,
		};
	}

	const CONFIG = resolveConfig();

	// ==================== 2. 会话持久化 ====================
	const STORAGE_KEY = "agent_chat_sessions";
	const MAX_SESSIONS = 15;
	const MAX_MESSAGES = 200;

	const SessionStore = {
		loadAll() {
			try {
				const raw = localStorage.getItem(STORAGE_KEY);
				const list = raw ? JSON.parse(raw) : [];
				return Array.isArray(list)
					? list.sort((a, b) => b.updatedAt - a.updatedAt)
					: [];
			} catch (e) {
				console.warn("读取会话失败，已重置", e);
				return [];
			}
		},

		saveAll(list) {
			try {
				localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
			} catch (e) {
				if (e.name === "QuotaExceededError") {
					// list 已按 updatedAt 降序，保留最新的一半
					const trimmed = list.slice(0, Math.max(1, Math.floor(list.length / 2)));
					try {
						localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
						console.warn("localStorage 超限，已裁剪旧会话");
					} catch (e2) {
						console.error("localStorage 写入失败", e2);
					}
				} else {
					console.error("localStorage 写入失败", e);
				}
			}
		},

		create() {
			const session = {
				id: "session-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
				title: "新会话",
				messages: [],
				updatedAt: Date.now(),
			};
			let list = this.loadAll();
			list.unshift(session);
			if (list.length > MAX_SESSIONS) list = list.slice(0, MAX_SESSIONS);
			this.saveAll(list);
			return session;
		},

		update(session) {
			if (!session) return;
			if (session.messages.length > MAX_MESSAGES) {
				session.messages = session.messages.slice(-MAX_MESSAGES);
			}
			let list = this.loadAll();
			const idx = list.findIndex((s) => s.id === session.id);
			session.updatedAt = Date.now();
			if (idx >= 0) list[idx] = session;
			else list.unshift(session);

			list.sort((a, b) => b.updatedAt - a.updatedAt);
			if (list.length > MAX_SESSIONS) list = list.slice(0, MAX_SESSIONS);
			this.saveAll(list);
		},

		get(sessionId) {
			return this.loadAll().find((s) => s.id === sessionId) || null;
		},

		/** 删除指定会话，返回删除后的列表 */
		remove(sessionId) {
			let list = this.loadAll().filter((s) => s.id !== sessionId);
			this.saveAll(list);
			return list;
		},

		/** 重命名会话，返回是否成功 */
		rename(sessionId, title) {
			const name = String(title || "").trim();
			if (!name) return false;
			let list = this.loadAll();
			const target = list.find((s) => s.id === sessionId);
			if (!target) return false;
			target.title = name.slice(0, 50);
			// 重命名不改变排序时间，保持列表位置稳定
			this.saveAll(list);
			return true;
		},
	};

	// ==================== 3. 运行时状态 ====================
	const state = {
		threadId: null,
		protocol: "sse",
		isStreaming: false,
		abortController: null,
		ws: null,
		currentSession: null,
	};

	// ==================== 4. UI 层 ====================
	const dom = {
		chatContainer: document.getElementById("chatContainer"),
		userInput: document.getElementById("userInput"),
		sendBtn: document.getElementById("sendBtn"),
		statusBar: document.getElementById("statusBar"),
		sessionListEl: document.getElementById("sessionList"),
		protocolGroup: document.getElementById("protocolGroup"),
	};

	const PROTOCOL_LABELS = { sse: "SSE", http: "HTTP", ws: "WebSocket" };

	function escapeHtml(str) {
		return String(str).replace(
			/[&<>"']/g,
			(c) =>
				({
					"&": "&amp;",
					"<": "&lt;",
					">": "&gt;",
					'"': "&quot;",
					"'": "&#39;",
				})[c]
		);
	}

	function formatTime(ts) {
		const d = new Date(ts);
		const pad = (n) => String(n).padStart(2, "0");
		return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
	}

	/**
	 * 安全序列化：兼容字符串、循环引用、undefined、函数等。
	 * 避免 JSON.stringify 抛错导致整个流中断。
	 */
	function safeStringify(value) {
		if (value === undefined) return "";
		if (typeof value === "string") return value;
		try {
			return JSON.stringify(value, null, 2);
		} catch (e) {
			try {
				// 处理循环引用
				const seen = new WeakSet();
				return JSON.stringify(
					value,
					(k, v) => {
						if (typeof v === "object" && v !== null) {
							if (seen.has(v)) return "[Circular]";
							seen.add(v);
						}
						return v;
					},
					2
				);
			} catch (e2) {
				return String(value);
			}
		}
	}

	// 滚动节流：避免每个 token 都触发 layout
	let scrollScheduled = false;
	function scrollToBottom() {
		if (scrollScheduled) return;
		scrollScheduled = true;
		requestAnimationFrame(() => {
			dom.chatContainer.scrollTop = dom.chatContainer.scrollHeight;
			scrollScheduled = false;
		});
	}

	/** 创建节点标签旁的 loading 转圈元素 */
	function createNodeSpinner() {
		const spinner = document.createElement("span");
		spinner.className = "node-spinner";
		spinner.setAttribute("role", "status");
		spinner.setAttribute("aria-label", "正在处理");
		return spinner;
	}

	/**
	 * 切换 agent 气泡的「进行中」状态：
	 * loading=true 时在节点标签旁插入转圈，false 时移除并标记 done。
	 */
	function setNodeLoading(agentDiv, loading) {
		if (!agentDiv) return;
		const tag = agentDiv.querySelector(".node-tag");
		if (!tag) return;
		const existing = tag.querySelector(".node-spinner");
		if (loading) {
			if (!existing) tag.appendChild(createNodeSpinner());
			agentDiv.classList.add("streaming");
			agentDiv.classList.remove("done");
		} else {
			if (existing) existing.remove();
			agentDiv.classList.remove("streaming");
			agentDiv.classList.add("done");
		}
	}

	/**
	 * 渲染一条消息气泡。
	 * - agent：Markdown 渲染
	 * - tool：可折叠气泡（默认折叠）
	 * - user：纯文本
	 * @param {object} msg  { role, content, node?, toolName?, toolInput?, toolOutput?, phase? }
	 * @param {object} opts { markdown?: boolean }
	 * @returns {HTMLElement}
	 */
	function renderMessage(msg, opts = {}) {
		if (msg.role === "tool") return renderToolMessage(msg);

		const div = document.createElement("div");
		div.className = `message ${msg.role}`;

		if (msg.role === "agent") {
			const tag = document.createElement("div");
			tag.className = "node-tag";
			const nameEl = document.createElement("span");
			nameEl.className = "node-name";
			nameEl.textContent = msg.node || "agent";
			tag.appendChild(nameEl);
			// 会话进行中：节点名旁显示 loading 转圈（流式结束时由 setNodeLoading 移除）
			if (opts.loading) {
				tag.appendChild(createNodeSpinner());
				div.classList.add("streaming");
			}
			div.appendChild(tag);
		}

		const text = document.createElement("span");
		text.className = "content";

		const useMarkdown =
			opts.markdown !== undefined ? opts.markdown : msg.role === "agent";
		if (useMarkdown && window.Markdown) {
			text.classList.add("markdown");
			text.innerHTML = window.Markdown.render(msg.content || "");
		} else {
			text.textContent = msg.content || "";
		}
		div.appendChild(text);

		dom.chatContainer.appendChild(div);
		scrollToBottom();
		return div;
	}

	/**
	 * 构建单个工具调用的内容体（参数 / 结果）。
	 * 供工具组内的工具项复用。
	 */
	function buildToolBody(msg) {
		const body = document.createElement("div");
		body.className = "tool-body";

		if (msg.toolInput !== undefined) {
			const sec = document.createElement("div");
			sec.className = "tool-section";
			sec.innerHTML = `<div class="tool-label">参数</div><pre class="tool-pre">${escapeHtml(
				safeStringify(msg.toolInput)
			)}</pre>`;
			body.appendChild(sec);
		}
		if (msg.toolOutput !== undefined) {
			const sec = document.createElement("div");
			sec.className = "tool-section";
			sec.innerHTML = `<div class="tool-label">结果</div><pre class="tool-pre">${escapeHtml(
				safeStringify(msg.toolOutput)
			)}</pre>`;
			body.appendChild(sec);
		}
		// 兼容旧数据：只有 content 字段
		if (msg.toolInput === undefined && msg.toolOutput === undefined && msg.content) {
			const sec = document.createElement("div");
			sec.className = "tool-section";
			sec.innerHTML = `<pre class="tool-pre">${escapeHtml(msg.content)}</pre>`;
			body.appendChild(sec);
		}
		// 完全无内容时给出占位，避免展开后空白
		if (!body.childNodes.length) {
			const sec = document.createElement("div");
			sec.className = "tool-section";
			sec.innerHTML = `<pre class="tool-pre">（无参数/结果）</pre>`;
			body.appendChild(sec);
		}
		return body;
	}

	/**
	 * 创建工具组容器（一轮 = 一次 invoke_stream / resume_stream）。
	 * 结构：
	 *   <div class="message tool-group collapsible collapsed">
	 *     <div class="tool-group-header">🔧 工具调用 (N) · 进行中 <span class="chevron">▸</span></div>
	 *     <div class="tool-group-body">
	 *       <div class="tool-item collapsible collapsed">…</div>
	 *     </div>
	 *   </div>
	 */
	function createToolGroup() {
		const group = document.createElement("div");
		group.className = "message tool-group collapsible collapsed";

		const header = document.createElement("div");
		header.className = "tool-group-header";
		header.setAttribute("role", "button");
		header.setAttribute("tabindex", "0");
		header.setAttribute("aria-expanded", "false");
		header.innerHTML = `
      <span class="tool-group-title">🔧 工具调用 (0) · 进行中</span>
      <span class="chevron">▸</span>
    `;

		const body = document.createElement("div");
		body.className = "tool-group-body";

		group.appendChild(header);
		group.appendChild(body);

		const toggle = () => {
			const collapsed = group.classList.toggle("collapsed");
			header.setAttribute("aria-expanded", String(!collapsed));
		};
		header.addEventListener("click", toggle);
		header.addEventListener("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				toggle();
			}
		});

		group._body = body;
		group._header = header;
		group._items = [];

		dom.chatContainer.appendChild(group);
		scrollToBottom();
		return group;
	}

	/** 刷新工具组头部摘要（数量 + 状态 + 工具名） */
	function refreshToolGroupHeader(group) {
		const title = group._header.querySelector(".tool-group-title");
		if (!title) return;
		const total = group._items.length;
		const pending = group._items.filter((it) => it.msg && it.msg.phase !== "end").length;
		// total 为 0 时不应判定为已完成
		const status = total > 0 && pending === 0 ? "已完成" : "进行中";
		group.classList.toggle("done", total > 0 && pending === 0);
		// 工具名摘要：去重后拼接，超过 3 个用 … 省略
		const names = [];
		group._items.forEach((it) => {
			const n = it.msg && it.msg.toolName;
			if (n && names.indexOf(n) === -1) names.push(n);
		});
		let nameStr = "";
		if (names.length) {
			nameStr =
				" · " +
				(names.length > 3
					? names.slice(0, 3).join(", ") + " …"
					: names.join(", "));
		}
		title.textContent = `🔧 工具调用 (${total}) · ${status}${nameStr}`;
	}

	/**
	 * 向工具组追加一个工具项（默认折叠，可单独展开）。
	 * @returns {{item: HTMLElement, msg: object}}
	 */
	function appendToolItem(group, msg, opts = {}) {
		const item = document.createElement("div");
		item.className = "tool-item collapsible collapsed";

		const phase = msg.phase || "start";
		const icon = phase === "end" ? "✅" : "🔧";
		const label = phase === "end" ? "工具完成" : "调用工具";
		const name = msg.toolName || "tool";

		if (phase === "end") item.classList.add("done");

		const header = document.createElement("div");
		header.className = "tool-header";
		header.setAttribute("role", "button");
		header.setAttribute("tabindex", "0");
		header.setAttribute("aria-expanded", "false");
		header.innerHTML = `
      <span class="tool-title">${icon} ${label}: <strong>${escapeHtml(name)}</strong></span>
      <span class="chevron">▸</span>
    `;

		const body = buildToolBody(msg);
		item.appendChild(header);
		item.appendChild(body);

		const toggle = () => {
			const collapsed = item.classList.toggle("collapsed");
			header.setAttribute("aria-expanded", String(!collapsed));
		};
		header.addEventListener("click", toggle);
		header.addEventListener("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				toggle();
			}
		});

		// 关键：只创建一次 entry，同时放进 _items 和返回
		const entry = { item, msg };
		group._body.appendChild(item);
		group._items.push(entry);          // _items 里存的是 entry
		refreshToolGroupHeader(group);
		scrollToBottom();
		if (
			opts.autoExpand &&
			group._items.length === 1 &&
			group.classList.contains("collapsed")
		) {
			group.classList.remove("collapsed");
			group._header.setAttribute("aria-expanded", "true");
		}

		scrollToBottom();
		return entry;                      // 返回同一个 entry
	}

	/**
	 * 原地更新工具项（tool_start → tool_end 合并）。
	 * 保留当前展开/折叠状态，只更新头部与内容体。
	 */
	function updateToolItem(group, entry, msg) {
		const phase = msg.phase || "start";
		const icon = phase === "end" ? "✅" : "🔧";
		const label = phase === "end" ? "工具完成" : "调用工具";
		const name = msg.toolName || "tool";

		const title = entry.item.querySelector(".tool-title");
		if (title) {
			title.innerHTML = `${icon} ${label}: <strong>${escapeHtml(name)}</strong>`;
		}

		const oldBody = entry.item.querySelector(".tool-body");
		if (oldBody) oldBody.replaceWith(buildToolBody(msg));

		entry.item.classList.toggle("done", phase === "end");
		entry.msg = msg;
		refreshToolGroupHeader(group);   // 刷新组头状态
		scrollToBottom();
	}

	/**
	 * 本轮结束兜底：把所有仍处于 start 的工具项标记为完成。
	 * 用于 tool_end 事件丢失 / 后端未回传工具名等异常场景，
	 * 避免气泡标题永久停留在「进行中」。
	 */
	function finalizeToolGroup(ctx) {
		const group = ctx && ctx.toolGroup;
		if (!group) return;
		group._items.forEach((entry) => {
			if (entry.msg && entry.msg.phase !== "end") {
				entry.msg.phase = "end";
				// 只有确实没有输出且没有 content 时才写兜底
				if (
					(entry.msg.toolOutput === undefined || entry.msg.toolOutput === null) &&
					!entry.msg.content
				) {
					entry.msg.toolOutput = "（未收到结果）";
				}
				updateToolItem(group, entry, entry.msg);
			}
		});
		refreshToolGroupHeader(group);
		group.classList.add("collapsed");
		group._header.setAttribute("aria-expanded", "false");
	}

	/**
	 * 渲染一条工具消息（用于会话重放）。
	 * 重放时由 switchSession 按 turnId 聚合，这里仅作为兜底：
	 * 单条工具消息渲染为一个只含一项的工具组。
	 */
	function renderToolMessage(msg) {
		const group = createToolGroup();
		appendToolItem(group, msg);
		return group;
	}

	/**
	 * 将 agent 气泡内容重新按 Markdown 渲染（流式结束后调用）。
	 * 流式过程中保持纯文本以保证性能，结束后一次性渲染。
	 */
	function renderAgentMarkdown(agentDiv) {
		if (!window.Markdown) return;
		const content = agentDiv.querySelector(".content");
		if (!content) return;
		const raw = content.textContent || "";
		content.classList.add("markdown");
		content.innerHTML = window.Markdown.render(raw);
		scrollToBottom();
	}

	/**
	 * 追加消息到 DOM 并（可选）写入当前会话。
	 * 注意：流式过程中不写盘，由调用方在结束时统一持久化。
	 * @param {string} role
	 * @param {string} content
	 * @param {object} opts { record?, node?, msg? }  msg 为完整消息对象（优先）
	 */
	function addMessage(role, content = "", opts = {}) {
		const { record = true, node = null, msg: fullMsg = null, loading = false } = opts;
		const msg = fullMsg || { role, content, node };
		const div = renderMessage(msg, { loading });

		if (record && state.currentSession) {
			state.currentSession.messages.push(msg);
			if (role === "user" && state.currentSession.title === "新会话") {
				state.currentSession.title = content.slice(0, 20);
			}
			SessionStore.update(state.currentSession);
			renderSessionList();
		}
		return div;
	}

	function appendToMessage(div, delta) {
		const content = div.querySelector(".content");
		if (content) content.textContent += delta;
		scrollToBottom();
	}

	function renderSessionList() {
		if (!dom.sessionListEl) return;
		const list = SessionStore.loadAll();
		dom.sessionListEl.innerHTML = "";

		if (list.length === 0) {
			const empty = document.createElement("div");
			empty.className = "session-empty";
			empty.textContent = "暂无会话";
			dom.sessionListEl.appendChild(empty);
			return;
		}

		const frag = document.createDocumentFragment();
		list.forEach((s) => {
			frag.appendChild(createSessionItem(s));
		});
		dom.sessionListEl.appendChild(frag);
	}

	/** 创建单个会话列表项（含重命名 / 删除操作） */
	function createSessionItem(s) {
		const item = document.createElement("div");
		item.className =
			"session-item" + (state.currentSession?.id === s.id ? " active" : "");
		item.dataset.id = s.id;

		// 主体（标题 + 时间）
		const main = document.createElement("div");
		main.className = "session-main";

		const titleEl = document.createElement("div");
		titleEl.className = "session-title";
		titleEl.textContent = s.title || "新会话";
		titleEl.title = s.title || "新会话";

		const timeEl = document.createElement("span");
		timeEl.className = "time";
		timeEl.textContent = formatTime(s.updatedAt);

		main.appendChild(titleEl);
		main.appendChild(timeEl);

		// 操作按钮（悬停显示）
		const actions = document.createElement("div");
		actions.className = "session-actions";

		const renameBtn = document.createElement("button");
		renameBtn.className = "session-action rename";
		renameBtn.title = "重命名";
		renameBtn.setAttribute("aria-label", "重命名会话");
		renameBtn.textContent = "✏️";
		renameBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			startRename(item, s);
		});

		const delBtn = document.createElement("button");
		delBtn.className = "session-action delete";
		delBtn.title = "删除";
		delBtn.setAttribute("aria-label", "删除会话");
		delBtn.textContent = "🗑️";
		delBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			deleteSession(s.id);
		});

		actions.appendChild(renameBtn);
		actions.appendChild(delBtn);

		item.appendChild(main);
		item.appendChild(actions);

		item.addEventListener("click", () => switchSession(s.id));
		return item;
	}

	/** 进入重命名编辑态 */
	function startRename(item, session) {
		if (state.isStreaming) return;
		if (item.querySelector(".session-rename-input")) return; // 已在编辑中

		const main = item.querySelector(".session-main");
		const titleEl = item.querySelector(".session-title");
		const actions = item.querySelector(".session-actions");
		if (!main || !titleEl) return;

		const input = document.createElement("input");
		input.className = "session-rename-input";
		input.type = "text";
		input.value = session.title || "";
		input.maxLength = 50;

		// 隐藏原标题与操作按钮，插入输入框
		titleEl.style.display = "none";
		if (actions) actions.style.display = "none";
		main.insertBefore(input, titleEl);
		input.focus();
		input.select();

		let done = false;
		const finish = (commit) => {
			if (done) return;
			done = true;
			const value = input.value.trim();
			input.remove();
			titleEl.style.display = "";
			if (actions) actions.style.display = "";

			if (commit && value && value !== session.title) {
				if (SessionStore.rename(session.id, value)) {
					// 同步内存中的当前会话标题
					if (state.currentSession?.id === session.id) {
						state.currentSession.title = value.slice(0, 50);
					}
					titleEl.textContent = value.slice(0, 50);
					titleEl.title = value.slice(0, 50);
				}
			}
		};

		input.addEventListener("keydown", (e) => {
			e.stopPropagation();
			if (e.key === "Enter") {
				e.preventDefault();
				finish(true);
			} else if (e.key === "Escape") {
				e.preventDefault();
				finish(false);
			}
		});
		input.addEventListener("blur", () => finish(true));
		input.addEventListener("click", (e) => e.stopPropagation());
	}

	/** 删除会话（带二次确认） */
	function deleteSession(sessionId) {
		if (state.isStreaming) {
			alert("正在生成回复，请先停止后再删除会话");
			return;
		}
		const session = SessionStore.get(sessionId);
		if (!session) return;

		const name = session.title || "新会话";
		if (!confirm(`确定删除会话「${name}」吗？此操作不可恢复。`)) return;

		const wasCurrent = state.currentSession?.id === sessionId;
		const list = SessionStore.remove(sessionId);

		if (wasCurrent) {
			if (list.length > 0) {
				// 切换到剩余列表中的第一个
				switchSession(list[0].id);
			} else {
				// 没有会话了，新建一个
				const s = SessionStore.create();
				state.currentSession = s;
				state.threadId = s.id;
				dom.chatContainer.innerHTML = "";
				renderSessionList();
			}
		} else {
			renderSessionList();
		}
	}

	/**
	 * 完整重放历史消息（含 node 标签、tool、interrupt 记录）。
	 * 工具消息按 turnId 聚合：同一轮（一次 invoke_stream / resume_stream）
	 * 的所有工具调用渲染到同一个工具组。
	 */
	function switchSession(sessionId) {
		if (state.isStreaming) return;
		const session = SessionStore.get(sessionId);
		if (!session) return;

		state.currentSession = session;
		state.threadId = session.id;

		dom.chatContainer.innerHTML = "";

		// 按 turnId 聚合工具消息；无 turnId 的旧数据按“连续段”聚合
		let currentGroup = null;
		let currentTurnKey = null;
		let legacySeq = 0;

		session.messages.forEach((m) => {
			if (m.role === "interrupt") {
				renderInterruptRecord(m);
				currentGroup = null;
				currentTurnKey = null;
				return;
			}
			if (m.role === "tool") {
				const key = m.turnId != null ? "turn:" + m.turnId : "legacy:" + legacySeq;
				if (!currentGroup || key !== currentTurnKey) {
					currentGroup = createToolGroup();
					currentTurnKey = key;
					if (m.turnId == null) legacySeq++;
				}
				appendToolItem(currentGroup, m);
				return;
			}
			// 非工具消息：结束当前工具组
			currentGroup = null;
			currentTurnKey = null;
			renderMessage(m);
		});
		scrollToBottom();
		renderSessionList();
	}

	function renderInterruptRecord(m) {
		const div = document.createElement("div");
		div.className = "message interrupt";
		div.innerHTML = `
      <div>⚠️ <strong>需要审批</strong></div>
      <div style="margin-top:6px;font-size:13px;">${escapeHtml(m.content || "")}</div>
      <div style="margin-top:6px;font-size:13px;font-weight:600;">${escapeHtml(m.result || "")}</div>
    `;
		dom.chatContainer.appendChild(div);
	}

	function setStreaming(streaming) {
		state.isStreaming = streaming;
		dom.sendBtn.textContent = streaming ? "停止" : "发送";
		dom.sendBtn.classList.toggle("stop", streaming);
		dom.sendBtn.disabled = false;
		dom.protocolGroup
			.querySelectorAll("button")
			.forEach((b) => (b.disabled = streaming));
	}

	function setStatus(text) {
		if (dom.statusBar) dom.statusBar.textContent = text;
	}

	// ==================== 5. 协议适配层 ====================
	/**
	 * 统一事件处理（不含 interrupt）。
	 * @param {object} data 服务端事件
	 * @param {HTMLElement} agentDiv 当前 agent 气泡
	 * @param {object} ctx  { node, extraMsgs, toolBubbles } 用于回填会话与气泡合并
	 */
	function handleEvent(data, agentDiv, ctx) {
		switch (data.type) {
			case "token": {
				const content = agentDiv.querySelector(".content");
				if (content) content.textContent += data.content;
				scrollToBottom();
				break;
			}
			case "node": {
				// 只更新节点名，保留标签内的 loading 转圈
				const nameEl = agentDiv.querySelector(".node-tag .node-name");
				if (nameEl) nameEl.textContent = data.name;
				else {
					const tag = agentDiv.querySelector(".node-tag");
					if (tag) tag.textContent = data.name;
				}
				ctx.node = data.name;
				break;
			}
			case "tool_start": {
				const name = data.name || data.tool || data.tool_name || "tool";
				const input = data.input ?? data.args ?? data.arguments;
				const callId = data.tool_call_id || data.id || null;

				const msg = {
					role: "tool",
					phase: "start",
					toolName: name,
					toolInput: input,
					toolCallId: callId,
					turnId: ctx.turnId,
				};

				if (!ctx.toolGroup) ctx.toolGroup = createToolGroup();
				const entry = appendToolItem(ctx.toolGroup, msg, { autoExpand: true });   // 拿到 entry

				ctx.toolBubbles = ctx.toolBubbles || {};
				const key = callId ? "id:" + String(callId) : "name:" + name;
				(ctx.toolBubbles[key] = ctx.toolBubbles[key] || []).push(entry);  // 存同一个 entry

				ctx.extraMsgs.push(msg);
				break;
			}
			case "tool_end": {
				const name = data.name || data.tool || data.tool_name || "tool";
				let output = data.output ?? data.result ?? data.content;

				// output 为空时给明确占位，避免 undefined 触发兜底
				if (output === undefined || output === null || output === "") {
					output = "（工具执行完成，但无返回内容）";
				}

				const callId = data.tool_call_id || data.id || null;
				ctx.toolBubbles = ctx.toolBubbles || {};
				let existing = null;

				// ① 按 id 精确匹配
				if (callId) {
					const q = ctx.toolBubbles["id:" + String(callId)];
					if (q && q.length) existing = q.shift();
				}

				// ② 按名字匹配最近一个未完成
				if (!existing) {
					const q = ctx.toolBubbles["name:" + name];
					if (q) {
						while (q.length) {
							const cand = q.shift();
							if (cand && cand.msg && cand.msg.phase !== "end") {
								existing = cand;
								break;
							}
						}
					}
				}

				// ③ 回退：本轮最早一个未完成
				if (!existing && ctx.toolGroup) {
					existing = ctx.toolGroup._items.find(
						(it) => it.msg && it.msg.phase !== "end"
					) || null;
					if (existing) {
						Object.keys(ctx.toolBubbles).forEach((k) => {
							const q = ctx.toolBubbles[k];
							const i = q.indexOf(existing);
							if (i >= 0) q.splice(i, 1);
						});
					}
				}

				if (existing) {
					const merged = Object.assign({}, existing.msg, {
						phase: "end",
						toolOutput: output,
					});
					// 找到 extraMsgs 里的旧对象，替换成新对象
					const idx = ctx.extraMsgs.indexOf(existing.msg);
					if (idx >= 0) ctx.extraMsgs[idx] = merged;
					updateToolItem(ctx.toolGroup, existing, merged);
				} else {
					const msg = {
						role: "tool",
						phase: "end",
						toolName: name,
						toolOutput: output,
						toolCallId: callId,
						turnId: ctx.turnId,
					};
					if (!ctx.toolGroup) ctx.toolGroup = createToolGroup();
					appendToolItem(ctx.toolGroup, msg, { autoExpand: true });
					ctx.extraMsgs.push(msg);
				}
				break;
			}
			case "error":
				appendToMessage(agentDiv, `\n[服务端错误] ${data.message}`);
				break;
			case "done":
				break;
			default:
				// 未知事件：打印到控制台，便于排查后端事件格式
				console.debug("[agent-ui] 未处理的事件类型:", data.type, data);
				break;
		}
	}

	/**
	 * 消费 SSE 流。
	 * 兼容：`data:` 有无空格、多行 data、`[DONE]` 结束标记。
	 * @returns {Promise<object|null>} 第一个 interrupt 事件
	 */
	async function consumeSSE(url, body, agentDiv, ctx) {
		state.abortController = new AbortController();
		const interrupts = [];

		const response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "text/event-stream",
			},
			body: JSON.stringify(body),
			signal: state.abortController.signal,
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		const processLine = (line) => {
			if (!line.startsWith("data:")) return;
			const raw = line.slice(5).trim();
			if (!raw || raw === "[DONE]") return;
			let data;
			try {
				data = JSON.parse(raw);
			} catch (e) {
				console.warn("SSE 解析失败:", raw, e);
				return;
			}
			// 事件处理也需保护：单个事件异常不能中断整个流
			try {
				if (data.type === "interrupt") interrupts.push(data);
				else handleEvent(data, agentDiv, ctx);
			} catch (e) {
				console.error("事件处理失败:", data, e);
			}
		};

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) processLine(line);
		}
		if (buffer) processLine(buffer);

		return interrupts.length > 0 ? interrupts[0] : null;
	}

	/** 创建带光标 + 节点 loading 转圈的 agent 气泡 */
	function createAgentBubble() {
		const div = addMessage("agent", "", { record: false, loading: true });
		const cursor = document.createElement("span");
		cursor.className = "cursor";
		div.appendChild(cursor);
		return { div, cursor };
	}

	// ---- SSE ----
	async function sendBySSE(message, agentDiv, ctx) {
		return consumeSSE(
			CONFIG.sseUrl,
			{ message, thread_id: state.threadId },
			agentDiv,
			ctx
		);
	}

	/** 开启新一轮（一次 invoke_stream / resume_stream）：重置工具组与 turnId */
	function beginTurn(ctx) {
		ctx.toolGroup = null;
		ctx.toolBubbles = {};
		ctx.turnId =
			"turn-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
	}

	async function resumeBySSE(interruptInfo, answer, ctx) {
		const { div, cursor } = createAgentBubble();
		beginTurn(ctx);
		try {
			const body = { thread_id: state.threadId, resume: answer };
			if (interruptInfo?.id) body.interrupt_id = interruptInfo.id;
			return await consumeSSE(CONFIG.sseResumeUrl, body, div, ctx);
		} finally {
			cursor.remove();
			setNodeLoading(div, false);
			// 恢复阶段产生的 agent 内容也记入本轮，避免刷新后丢失
			const text = div.querySelector(".content")?.textContent || "";
			if (text) ctx.extraMsgs.push({ role: "agent", content: text, node: ctx.node || "agent" });
			renderAgentMarkdown(div);
		}
	}

	// ---- HTTP ----
	async function sendByHTTP(message, agentDiv, ctx) {
		state.abortController = new AbortController();
		const response = await fetch(CONFIG.httpUrl, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({ message, thread_id: state.threadId }),
			signal: state.abortController.signal,
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);

		const data = await response.json();
		if (data.content) appendToMessage(agentDiv, data.content);
		return data.interrupt || null;
	}

	async function resumeByHTTP(interruptInfo, answer, ctx) {
		// 恢复统一走 SSE，保证连续中断可流式处理
		return resumeBySSE(interruptInfo, answer, ctx);
	}

	// ---- WebSocket ----
	/**
	 * 通用 WS 会话：发送 payload，消费事件直到 done/close。
	 * @param {object} payload 首帧数据
	 * @param {HTMLElement} agentDiv
	 * @param {object} ctx
	 */
	function runWebSocket(payload, agentDiv, ctx) {
		return new Promise((resolve, reject) => {
			let interruptInfo = null;
			let finished = false;

			const ws = new WebSocket(CONFIG.wsUrl);
			state.ws = ws;
			const cleanup = () => {
				if (state.ws === ws) state.ws = null;
			};

			ws.onopen = () => ws.send(JSON.stringify(payload));

			ws.onmessage = (event) => {
				let data;
				try {
					data = JSON.parse(event.data);
				} catch (e) {
					console.warn("WS 消息解析失败:", event.data, e);
					return;
				}
				try {
					if (data.type === "interrupt") {
						interruptInfo = data;
					} else if (data.type === "done") {
						finished = true;
						ws.close();
						cleanup();
						resolve(interruptInfo);
					} else {
						handleEvent(data, agentDiv, ctx);
					}
				} catch (e) {
					console.error("WS 事件处理失败:", data, e);
				}
			};

			ws.onerror = () => {
				cleanup();
				if (!finished) {
					finished = true;
					reject(new Error("WebSocket 连接失败"));
				}
			};

			ws.onclose = () => {
				cleanup();
				if (!finished) {
					finished = true;
					// 未收到 done 就关闭：视为异常结束
					reject(new Error("WebSocket 连接意外关闭"));
				}
			};
		});
	}

	async function sendByWebSocket(message, agentDiv, ctx) {
		return runWebSocket(
			{ message, thread_id: state.threadId },
			agentDiv,
			ctx
		);
	}

	async function resumeByWebSocket(interruptInfo, answer, ctx) {
		const { div, cursor } = createAgentBubble();
		beginTurn(ctx);
		try {
			const payload = {
				type: "resume",
				thread_id: state.threadId,
				resume: answer,
			};
			if (interruptInfo?.id) payload.interrupt_id = interruptInfo.id;
			return await runWebSocket(payload, div, ctx);
		} finally {
			cursor.remove();
			setNodeLoading(div, false);
			// 恢复阶段产生的 agent 内容也记入本轮，避免刷新后丢失
			const text = div.querySelector(".content")?.textContent || "";
			if (text) ctx.extraMsgs.push({ role: "agent", content: text, node: ctx.node || "agent" });
			renderAgentMarkdown(div);
		}
	}

	// ==================== 6. 中断审批 + 主流程 ====================
	function waitForInterruptApproval(interruptInfo) {
		return new Promise((resolve) => {
			const payload = interruptInfo?.value;
			const display =
				typeof payload === "string"
					? payload
					: payload != null
						? JSON.stringify(payload)
						: "(无审批内容)";

			const div = document.createElement("div");
			div.className = "message interrupt";
			div.innerHTML = `
        <div>⚠️ <strong>需要审批</strong></div>
        <div style="margin-top:6px;font-size:13px;">${escapeHtml(display)}</div>
        <div class="actions">
          <button class="approve">批准</button>
          <button class="reject">拒绝</button>
        </div>
      `;
			dom.chatContainer.appendChild(div);
			scrollToBottom();

			const finish = (answer, label) => {
				const actions = div.querySelector(".actions");
				if (actions) actions.remove();

				const result = document.createElement("div");
				result.style.cssText = "margin-top:6px;font-size:13px;font-weight:600;";
				result.textContent = label;
				div.appendChild(result);

				// 审批记录写入会话（作为 interrupt 类型，便于重放）
				if (state.currentSession) {
					state.currentSession.messages.push({
						role: "interrupt",
						content: display,
						result: label,
					});
					SessionStore.update(state.currentSession);
					renderSessionList();
				}
				resolve(answer);
			};

			div.querySelector(".approve").onclick = () => finish("y", "✅ 已批准");
			div.querySelector(".reject").onclick = () => finish("n", "❌ 已拒绝");
		});
	}

	/**
	 * 核心循环：首次请求 → 若返回 interrupt 则等待审批 → 恢复 → 循环。
	 * @param {(ctx) => Promise<object|null>} initialFn
	 * @param {(interrupt, answer, ctx) => Promise<object|null>} resumeFn
	 * @param {object} ctx
	 */
	async function runStreamAndHandleInterrupts(initialFn, resumeFn, ctx) {
		let fn = initialFn;
		while (true) {
			const interruptInfo = await fn(ctx);
			if (!interruptInfo) break;
			const answer = await waitForInterruptApproval(interruptInfo);
			fn = (c) => resumeFn(interruptInfo, answer, c);
		}
	}

	/** 把本轮产生的 agent 内容 + tool 消息一次性写入会话 */
	function persistTurn(agentDiv, ctx) {
		if (!state.currentSession) return;
		const content = agentDiv.querySelector(".content")?.textContent || "";
		const msgs = state.currentSession.messages;

		// 先写本轮附加消息（tool / 恢复阶段的 agent），再写主 agent 最终内容
		ctx.extraMsgs.forEach((m) => msgs.push(m));
		if (content) {
			msgs.push({ role: "agent", content, node: ctx.node || "agent" });
		}
		SessionStore.update(state.currentSession);
		renderSessionList();
	}

	async function sendMessage() {
		if (state.isStreaming) {
			state.abortController?.abort();
			if (state.ws) state.ws.close();
			return;
		}

		const message = dom.userInput.value.trim();
		if (!message) return;

		dom.userInput.value = "";
		dom.userInput.style.height = "auto";

		// 记录用户消息
		addMessage("user", message);

		// 快照当前会话，避免流式期间切换/新建导致写错会话
		const sessionSnapshot = state.currentSession;

		const { div: agentDiv, cursor } = createAgentBubble();
		const ctx = {
			node: null,
			extraMsgs: [],
			toolBubbles: {},
			toolGroup: null,
			turnId: "turn-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
		};

		setStreaming(true);

		try {
			switch (state.protocol) {
				case "sse":
					await runStreamAndHandleInterrupts(
						(c) => sendBySSE(message, agentDiv, c),
						resumeBySSE,
						ctx
					);
					break;
				case "http":
					await runStreamAndHandleInterrupts(
						(c) => sendByHTTP(message, agentDiv, c),
						resumeByHTTP,
						ctx
					);
					break;
				case "ws":
					await runStreamAndHandleInterrupts(
						(c) => sendByWebSocket(message, agentDiv, c),
						resumeByWebSocket,
						ctx
					);
					break;
			}
		} catch (err) {
			if (err.name !== "AbortError") {
				appendToMessage(agentDiv, `\n[错误] ${err.message}`);
			}
		} finally {
			cursor.remove();
			// 会话结束：移除节点标签旁的 loading 转圈
			setNodeLoading(agentDiv, false);
			// 兜底收尾：把本轮残留的未完成工具项标记为完成
			finalizeToolGroup(ctx);
			// 仅当会话未被切换时才写回，防止串会话
			if (state.currentSession === sessionSnapshot) {
				persistTurn(agentDiv, ctx);
			}
			// 流式结束后将 agent 气泡按 Markdown 重新渲染
			renderAgentMarkdown(agentDiv);
			setStreaming(false);
		}
	}

	function clearChat() {
		if (state.isStreaming) {
			state.abortController?.abort();
			if (state.ws) state.ws.close();
		}
		const s = SessionStore.create();
		state.currentSession = s;
		state.threadId = s.id;
		dom.chatContainer.innerHTML = "";
		renderSessionList();
	}

	// ==================== 事件绑定 ====================
	dom.protocolGroup.querySelectorAll("button").forEach((btn) => {
		btn.addEventListener("click", () => {
			if (state.isStreaming) return;
			const protocol = btn.dataset.protocol;
			state.protocol = protocol;
			dom.protocolGroup
				.querySelectorAll("button")
				.forEach((b) => b.classList.toggle("active", b === btn));
			if (state.ws) {
				state.ws.close();
				state.ws = null;
			}
			setStatus(`协议：${PROTOCOL_LABELS[protocol]}`);
		});
	});

	dom.userInput.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			sendMessage();
		}
	});

	dom.userInput.addEventListener("input", () => {
		dom.userInput.style.height = "auto";
		dom.userInput.style.height =
			Math.min(dom.userInput.scrollHeight, 120) + "px";
	});

	dom.sendBtn.addEventListener("click", sendMessage);

	// 新建会话 / 新建对话
	const newSessionBtn = document.getElementById("newSessionBtn");
	const clearBtn = document.getElementById("clearBtn");
	if (newSessionBtn) newSessionBtn.addEventListener("click", clearChat);
	if (clearBtn) clearBtn.addEventListener("click", clearChat);

	// 暴露给控制台调试使用
	window.clearChat = clearChat;
	window.sendMessage = sendMessage;

	// ==================== 初始化 ====================
	(function init() {
		const list = SessionStore.loadAll();
		if (list.length > 0) {
			switchSession(list[0].id);
		} else {
			const s = SessionStore.create();
			state.currentSession = s;
			state.threadId = s.id;
			renderSessionList();
		}
		setStatus(`协议：${PROTOCOL_LABELS[state.protocol]}`);
	})();
})();
