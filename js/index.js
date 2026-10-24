// ==================== 配置 ====================
const CONFIG = {
	sseUrl: "http://192.168.124.6:8090/chat/invoke_stream",
	sseResumeUrl: "http://192.168.124.6:8090/chat/resume_stream",
	wsUrl: "ws://192.168.124.6:8090/chat/ws",
	httpUrl: "http://192.168.124.6:8090/chat/invoke",
	resumeUrl: "http://192.168.124.6:8090/chat/resume",
};

// ==================== 状态 ====================
const state = {
	threadId: "session-" + Date.now(),
	protocol: "sse",
	isStreaming: false,
	abortController: null,
	ws: null,
};

// ==================== DOM ====================
const chatContainer = document.getElementById("chatContainer");
const userInput = document.getElementById("userInput");
const sendBtn = document.getElementById("sendBtn");
const statusBar = document.getElementById("statusBar");

// ==================== 协议切换 ====================
document.querySelectorAll("#protocolGroup button").forEach(btn => {
	btn.addEventListener("click", () => {
		if (state.isStreaming) return;
		const protocol = btn.dataset.protocol;
		state.protocol = protocol;

		document.querySelectorAll("#protocolGroup button")
			.forEach(b => b.classList.toggle("active", b === btn));

		if (state.ws) {
			state.ws.close();
			state.ws = null;
		}

		const labels = {
			sse: "SSE",
			ws: "WebSocket",
			http: "HTTP"
		};
		statusBar.textContent = `协议：${labels[protocol]}`;
	});
});

// ==================== 消息渲染 ====================
function addMessage(role, content = "") {
	const div = document.createElement("div");
	div.className = `message ${role}`;
	if (role === "agent") {
		const tag = document.createElement("div");
		tag.className = "node-tag";
		tag.textContent = "agent";
		div.appendChild(tag);
	}
	const text = document.createElement("span");
	text.className = "content";
	text.textContent = content;
	div.appendChild(text);
	chatContainer.appendChild(div);
	chatContainer.scrollTop = chatContainer.scrollHeight;
	return div;
}

function appendToMessage(div, delta) {
	const content = div.querySelector(".content");
	content.textContent += delta;
	chatContainer.scrollTop = chatContainer.scrollHeight;
}

function setStreaming(streaming) {
	state.isStreaming = streaming;
	sendBtn.textContent = streaming ? "停止" : "发送";
	sendBtn.classList.toggle("stop", streaming);
	sendBtn.disabled = false;
	document.querySelectorAll("#protocolGroup button")
		.forEach(b => b.disabled = streaming);
}

function clearChat() {
	if (state.isStreaming) state.abortController?.abort();
	if (state.ws) {
		state.ws.close();
		state.ws = null;
	}
	chatContainer.innerHTML = "";
	state.threadId = "session-" + Date.now();
}

// ==================== 统一事件处理（不含 interrupt） ====================
function handleEvent(data, agentDiv) {
	switch (data.type) {
		case "token": {
			const content = agentDiv.querySelector(".content");
			content.textContent += data.content;
			chatContainer.scrollTop = chatContainer.scrollHeight;
			break;
		}
		case "node": {
			const tag = agentDiv.querySelector(".node-tag");
			if (tag) tag.textContent = data.name;
			break;
		}
		case "tool_start":
			addMessage("tool", `🔧 调用工具: ${data.name}\n参数: ${JSON.stringify(data.input)}`);
			break;
		case "tool_end":
			addMessage("tool", `✅ 工具完成: ${data.name}\n结果: ${data.output}`);
			break;
		case "error":
			appendToMessage(agentDiv, `\n[服务端错误] ${data.message}`);
			break;
		case "done":
			break;
	}
}

// ==================== 等待用户审批 ====================
function waitForInterruptApproval(interruptInfo) {
	return new Promise((resolve) => {
		const payload = interruptInfo?.value;
		const display = typeof payload === "string" ?
			payload :
			payload != null ?
			JSON.stringify(payload) :
			"(无审批内容)";

		const div = document.createElement("div");
		div.className = "message interrupt";
		div.innerHTML = `
      <div>⚠️ <strong>需要审批</strong></div>
      <div style="margin-top:6px;font-size:13px;">${display}</div>
      <div class="actions">
        <button class="approve">批准</button>
        <button class="reject">拒绝</button>
      </div>
    `;
		chatContainer.appendChild(div);
		chatContainer.scrollTop = chatContainer.scrollHeight;

		const finish = (answer, label) => {
			// 移除按钮，保留气泡，显示审批结果
			const actions = div.querySelector(".actions");
			if (actions) actions.remove();

			const result = document.createElement("div");
			result.style.marginTop = "6px";
			result.style.fontSize = "13px";
			result.style.fontWeight = "600";
			result.textContent = label;
			div.appendChild(result);

			resolve(answer);
		};

		div.querySelector(".approve").onclick = () => finish("y", "✅ 已批准");
		div.querySelector(".reject").onclick = () => finish("n", "❌ 已拒绝");
	});
}

// ==================== 核心循环：首次函数 + 恢复函数 分离 ====================
async function runStreamAndHandleInterrupts(initialFn, resumeFn) {
	let fetchFn = initialFn;
	while (true) {
		const interruptInfo = await fetchFn();
		if (!interruptInfo) break;
		const answer = await waitForInterruptApproval(interruptInfo);
		fetchFn = () => resumeFn(interruptInfo, answer);
	}
}

// ==================== 公共：消费 SSE 流 ====================
async function consumeSSE(url, body, agentDiv, accept = "text/event-stream") {
	state.abortController = new AbortController();
	const interrupts = [];

	const response = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Accept": accept,
		},
		body: JSON.stringify(body),
		signal: state.abortController.signal,
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}`);

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	while (true) {
		const {
			done,
			value
		} = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, {
			stream: true
		});
		const lines = buffer.split("\n");
		buffer = lines.pop() || "";
		for (const line of lines) {
			if (!line.startsWith("data: ")) continue;
			const raw = line.slice(6).trim();
			if (!raw) continue;
			try {
				const data = JSON.parse(raw);
				if (data.type === "interrupt") {
					interrupts.push(data);
				} else {
					handleEvent(data, agentDiv);
				}
			} catch {}
		}
	}
	return interrupts.length > 0 ? interrupts[0] : null;
}

// ==================== SSE：首次发送 ====================
async function sendBySSE(message, agentDiv) {
	return consumeSSE(
		CONFIG.sseUrl, {
			message,
			thread_id: state.threadId
		},
		agentDiv
	);
}

// ==================== SSE：恢复 ====================
async function resumeBySSE(interruptInfo, answer) {
	addMessage("user", answer === "y" ? "✅ 批准" : "❌ 拒绝");
	const newDiv = addMessage("agent", "");
	const cursor = document.createElement("span");
	cursor.className = "cursor";
	newDiv.appendChild(cursor);

	try {
		const body = {
			thread_id: state.threadId,
			resume: answer
		};
		if (interruptInfo?.id) body.interrupt_id = interruptInfo.id;

		return await consumeSSE(CONFIG.sseResumeUrl, body, newDiv);
	} finally {
		cursor.remove();
	}
}

// ==================== HTTP：首次发送 ====================
async function sendByHTTP(message, agentDiv) {
	state.abortController = new AbortController();
	const response = await fetch(CONFIG.httpUrl, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Accept": "application/json"
		},
		body: JSON.stringify({
			message,
			thread_id: state.threadId
		}),
		signal: state.abortController.signal,
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}`);

	const data = await response.json();
	if (data.content) appendToMessage(agentDiv, data.content);
	return data.interrupt || null;
}

// ==================== HTTP：恢复（走 SSE，避免协议不一致） ====================
async function resumeByHTTP(interruptInfo, answer) {
	addMessage("user", answer === "y" ? "✅ 批准" : "❌ 拒绝");
	const newDiv = addMessage("agent", "");

	const body = {
		thread_id: state.threadId,
		resume: answer
	};
	if (interruptInfo?.id) body.interrupt_id = interruptInfo.id;

	const response = await fetch(CONFIG.resumeUrl, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Accept": "application/json"
		},
		body: JSON.stringify(body),
	});
	const data = await response.json();
	if (data.content) appendToMessage(newDiv, data.content);
	return data.interrupt || null;
}

// ==================== WebSocket：首次发送 ====================
async function sendByWebSocket(message, agentDiv) {
	return new Promise((resolve, reject) => {
		let interruptInfo = null;
		let finished = false;

		const ws = new WebSocket(CONFIG.wsUrl);
		state.ws = ws;
		const cleanup = () => {
			if (state.ws === ws) state.ws = null;
		};

		ws.onopen = () => {
			ws.send(JSON.stringify({
				message,
				thread_id: state.threadId
			}));
		};

		ws.onmessage = (event) => {
			try {
				const data = JSON.parse(event.data);
				if (data.type === "interrupt") {
					interruptInfo = data;
				} else if (data.type === "done") {
					finished = true;
					ws.close();
					cleanup();
					resolve(interruptInfo);
				} else {
					handleEvent(data, agentDiv);
				}
			} catch {}
		};

		ws.onerror = () => {
			cleanup();
			if (!finished) reject(new Error("WebSocket 连接失败"));
		};
		ws.onclose = () => {
			cleanup();
			if (!finished) {
				finished = true;
				resolve(interruptInfo);
			}
		};
	});
}

// ==================== WebSocket：恢复 ====================
async function resumeByWebSocket(interruptInfo, answer) {
	addMessage("user", answer === "y" ? "✅ 批准" : "❌ 拒绝");
	const newDiv = addMessage("agent", "");
	const cursor = document.createElement("span");
	cursor.className = "cursor";
	newDiv.appendChild(cursor);

	try {
		return await new Promise((resolve, reject) => {
			let newInterrupt = null;
			let finished = false;

			const ws = new WebSocket(CONFIG.wsUrl);
			state.ws = ws;
			const cleanup = () => {
				if (state.ws === ws) state.ws = null;
			};

			ws.onopen = () => {
				const payload = {
					type: "resume",
					thread_id: state.threadId,
					resume: answer,
				};
				if (interruptInfo?.id) payload.interrupt_id = interruptInfo.id;
				ws.send(JSON.stringify(payload));
			};

			ws.onmessage = (event) => {
				try {
					const data = JSON.parse(event.data);
					if (data.type === "interrupt") {
						newInterrupt = data;
					} else if (data.type === "done") {
						finished = true;
						ws.close();
						cleanup();
						resolve(newInterrupt);
					} else {
						handleEvent(data, newDiv);
					}
				} catch {}
			};

			ws.onerror = () => {
				cleanup();
				if (!finished) reject(new Error("WebSocket 连接失败"));
			};
			ws.onclose = () => {
				cleanup();
				if (!finished) {
					finished = true;
					resolve(newInterrupt);
				}
			};
		});
	} finally {
		cursor.remove();
	}
}

// ==================== 发送入口 ====================
async function sendMessage() {
	if (state.isStreaming) {
		state.abortController?.abort();
		if (state.ws) state.ws.close();
		return;
	}

	const message = userInput.value.trim();
	if (!message) return;

	userInput.value = "";
	addMessage("user", message);

	const agentDiv = addMessage("agent", "");
	const cursor = document.createElement("span");
	cursor.className = "cursor";
	agentDiv.appendChild(cursor);

	setStreaming(true);

	try {
		switch (state.protocol) {
			case "sse":
				await runStreamAndHandleInterrupts(
					() => sendBySSE(message, agentDiv),
					resumeBySSE
				);
				break;

			case "http":
				await runStreamAndHandleInterrupts(
					() => sendByHTTP(message, agentDiv),
					resumeByHTTP
				);
				break;

			case "ws":
				await runStreamAndHandleInterrupts(
					() => sendByWebSocket(message, agentDiv),
					resumeByWebSocket
				);
				break;
		}
	} catch (err) {
		if (err.name !== "AbortError") {
			appendToMessage(agentDiv, `\n[错误] ${err.message}`);
		}
	} finally {
		cursor.remove();
		setStreaming(false);
	}
}

// ==================== 输入事件 ====================
userInput.addEventListener("keydown", (e) => {
	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault();
		sendMessage();
	}
});

userInput.addEventListener("input", () => {
	userInput.style.height = "auto";
	userInput.style.height = Math.min(userInput.scrollHeight, 120) + "px";
});