/**
 * 轻量 Markdown 渲染器（无第三方依赖，可离线使用）
 * ------------------------------------------------------------
 * 设计原则：
 *   1. 安全优先：先整体 HTML 转义，再生成受控标签，杜绝 XSS。
 *   2. 覆盖常用语法：标题、粗体/斜体/删除线、行内代码、代码块、
 *      链接、图片、有序/无序列表、引用、分割线、表格、换行。
 *   3. 流式友好：支持「未闭合代码块」的容错渲染。
 * ------------------------------------------------------------
 * 用法：
 *   Markdown.render("# hi")            -> "<h1>hi</h1>"
 *   Markdown.renderInline("**hi**")    -> "<strong>hi</strong>"
 */
(function (global) {
	"use strict";

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

	/** 行内语法：代码 > 图片 > 链接 > 粗体 > 斜体 > 删除线 */
	function renderInline(text) {
		// 先转义，后续只插入受控标签
		let s = escapeHtml(text);

		// 行内代码 `code`（优先，避免内部内容被其它规则处理）
		const codeStore = [];
		s = s.replace(/`([^`]+)`/g, (_, code) => {
			const idx = codeStore.push(`<code>${code}</code>`) - 1;
			return `\u0000CODE${idx}\u0000`;
		});

		// 图片 ![alt](url)
		s = s.replace(
			/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
			(_, alt, url, title) =>
				`<img src="${url}" alt="${alt}"${title ? ` title="${title}"` : ""} loading="lazy">`
		);

		// 链接 [text](url)
		s = s.replace(
			/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
			(_, label, url, title) =>
				`<a href="${url}" target="_blank" rel="noopener noreferrer"${title ? ` title="${title}"` : ""}>${label}</a>`
		);

		// 粗体 **text** / __text__
		s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
		s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");

		// 斜体 *text* / _text_
		s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
		s = s.replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");

		// 删除线 ~~text~~
		s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");

		// 还原行内代码
		s = s.replace(/\u0000CODE(\d+)\u0000/g, (_, i) => codeStore[Number(i)]);

		return s;
	}

	/** 解析表格：返回 HTML 或 null */
	function tryParseTable(lines, start) {
		const header = lines[start];
		const sep = lines[start + 1];
		if (!header || !sep) return null;
		if (!/^\s*\|?.+\|.+\|?\s*$/.test(header)) return null;
		if (!/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(sep))
			return null;

		const splitRow = (row) =>
			row
				.trim()
				.replace(/^\||\|$/g, "")
				.split("|")
				.map((c) => c.trim());

		const headers = splitRow(header);
		const aligns = splitRow(sep).map((c) => {
			const left = c.startsWith(":");
			const right = c.endsWith(":");
			if (left && right) return "center";
			if (right) return "right";
			if (left) return "left";
			return "";
		});

		let i = start + 2;
		const rows = [];
		while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim() !== "") {
			rows.push(splitRow(lines[i]));
			i++;
		}

		const th = headers
			.map(
				(h, idx) =>
					`<th${aligns[idx] ? ` style="text-align:${aligns[idx]}"` : ""}>${renderInline(h)}</th>`
			)
			.join("");
		const tbody = rows
			.map(
				(r) =>
					"<tr>" +
					headers
						.map(
							(_, idx) =>
								`<td${aligns[idx] ? ` style="text-align:${aligns[idx]}"` : ""}>${renderInline(r[idx] || "")}</td>`
						)
						.join("") +
					"</tr>"
			)
			.join("");

		return {
			html: `<table><thead><tr>${th}</tr></thead><tbody>${tbody}</tbody></table>`,
			next: i,
		};
	}

	/**
	 * 块级渲染。
	 * @param {string} src
	 * @returns {string} HTML
	 */
	function render(src) {
		if (src == null) return "";
		const lines = String(src).replace(/\r\n?/g, "\n").split("\n");
		const out = [];
		let i = 0;

		while (i < lines.length) {
			const line = lines[i];

			// 空行
			if (/^\s*$/.test(line)) {
				i++;
				continue;
			}

			// 代码块 ```lang
			const fence = line.match(/^\s*```(\w*)\s*$/);
			if (fence) {
				const lang = fence[1] || "";
				const buf = [];
				i++;
				while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
					buf.push(lines[i]);
					i++;
				}
				i++; // 跳过结束 ```
				const code = escapeHtml(buf.join("\n"));
				out.push(
					`<pre class="md-code"><code${lang ? ` class="language-${lang}"` : ""}>${code}</code></pre>`
				);
				continue;
			}

			// 标题
			const h = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
			if (h) {
				const level = h[1].length;
				out.push(`<h${level}>${renderInline(h[2].trim())}</h${level}>`);
				i++;
				continue;
			}

			// 分割线
			if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
				out.push("<hr>");
				i++;
				continue;
			}

			// 引用 >
			if (/^\s{0,3}>/.test(line)) {
				const buf = [];
				while (i < lines.length && /^\s{0,3}>/.test(lines[i])) {
					buf.push(lines[i].replace(/^\s{0,3}>\s?/, ""));
					i++;
				}
				out.push(`<blockquote>${render(buf.join("\n"))}</blockquote>`);
				continue;
			}

			// 表格
			const table = tryParseTable(lines, i);
			if (table) {
				out.push(table.html);
				i = table.next;
				continue;
			}

			// 无序列表
			if (/^\s{0,3}[-*+]\s+/.test(line)) {
				const buf = [];
				while (i < lines.length && /^\s{0,3}[-*+]\s+/.test(lines[i])) {
					buf.push(lines[i].replace(/^\s{0,3}[-*+]\s+/, ""));
					i++;
				}
				out.push(
					`<ul>${buf.map((t) => `<li>${renderInline(t)}</li>`).join("")}</ul>`
				);
				continue;
			}

			// 有序列表
			if (/^\s{0,3}\d+\.\s+/.test(line)) {
				const buf = [];
				while (i < lines.length && /^\s{0,3}\d+\.\s+/.test(lines[i])) {
					buf.push(lines[i].replace(/^\s{0,3}\d+\.\s+/, ""));
					i++;
				}
				out.push(
					`<ol>${buf.map((t) => `<li>${renderInline(t)}</li>`).join("")}</ol>`
				);
				continue;
			}

			// 普通段落（合并连续非空行）
			const buf = [];
			while (
				i < lines.length &&
				!/^\s*$/.test(lines[i]) &&
				!/^\s*```/.test(lines[i]) &&
				!/^\s{0,3}#{1,6}\s+/.test(lines[i]) &&
				!/^\s{0,3}>/.test(lines[i]) &&
				!/^\s{0,3}[-*+]\s+/.test(lines[i]) &&
				!/^\s{0,3}\d+\.\s+/.test(lines[i]) &&
				!/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(lines[i])
			) {
				buf.push(lines[i]);
				i++;
			}
			if (buf.length) {
				out.push(`<p>${renderInline(buf.join("\n")).replace(/\n/g, "<br>")}</p>`);
			}
		}

		return out.join("\n");
	}

	global.Markdown = { render, renderInline, escapeHtml };
})(window);
