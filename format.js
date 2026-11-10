(() => {
  const app = globalThis.__chatExportV1 ||= {};
  if (app.format) return;
  const OMIT = "button,script,style,svg,nav,input,textarea,[hidden],[aria-hidden='true'],.turn-action-controls";
  const BODY_SELECTOR = '.markdown,.MarkdownRoot,[data-user-message-bubble="true"],.whitespace-pre-wrap,[data-testid="collapsible-user-message-content"]';
  const HEADING_SELECTOR = "h1,h2,h3,h4,h5,h6";
  function isRoleLabel(node) {
    if (!node.matches(HEADING_SELECTOR) || node.closest(BODY_SELECTOR)) return false;
    // Role headings describe the conversation UI, not a separate authored message.
    // Do not match their text: a real message may contain exactly the same words.
    return node.matches('[data-conversation-role],[data-message-author-role],[data-turn],.sr-only,[data-testid="conversation-turn-heading"]');
  }
  const escape = text => String(text).replace(/\\/g, "\\\\").replace(/([`*_[\]<>])/g, "\\$1");
  const ticks = text => Math.max(0, ...(text.match(/`+/g) || []).map(s => s.length));
  const block = text => `\n\n${text.trim()}\n\n`;

  function safeUrl(value, base) {
    if (!value) return "";
    try {
      const url = new URL(value, base);
      return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : "";
    } catch { return ""; }
  }

  function toMarkdown(root, { base = location.href, preserveWhitespace = false } = {}) {
    function render(node) {
      if (node.nodeType === 3) {
        return escape(preserveWhitespace ? node.textContent : node.textContent.replace(/\s+/g, " "));
      }
      if (node.nodeType !== 1 || node.matches(OMIT)) return "";
      const tag = node.tagName.toLowerCase();
      const children = () => Array.from(node.childNodes, render).join("");
      if (tag === "pre") {
        const code = node.querySelector("code") || node;
        const text = code.textContent.replace(/\n$/, "");
        const fence = "`".repeat(Math.max(3, ticks(text) + 1));
        const language = (code.className.match(/(?:^|\s)language-([\w+-]+)/) || [])[1] || "";
        return block(`${fence}${language}\n${text}\n${fence}`);
      }
      if (tag === "code") {
        const text = node.textContent;
        const fence = "`".repeat(ticks(text) + 1);
        const pad = /^[` ]|[` ]$/.test(text) ? " " : "";
        return `${fence}${pad}${text}${pad}${fence}`;
      }
      if (node.matches(".katex-display, .katex")) {
        const tex = node.querySelector('annotation[encoding="application/x-tex"]');
        if (tex) return node.matches(".katex-display")
          ? block(`$$\n${tex.textContent}\n$$`) : `$${tex.textContent}$`;
      }
      if (tag === "br") return "\n";
      if (tag === "hr") return block("---");
      if (/^h[1-6]$/.test(tag)) return block(`${"#".repeat(Number(tag[1]))} ${children().trim()}`);
      if (["strong", "b"].includes(tag)) return `**${children()}**`;
      if (["em", "i"].includes(tag)) return `*${children()}*`;
      if (["del", "s"].includes(tag)) return `~~${children()}~~`;
      if (tag === "a") {
        const url = safeUrl(node.getAttribute("href"), base);
        return url ? `[${children()}](<${url.replace(/>/g, "%3E")}>)` : children();
      }
      if (tag === "img") return `[Image: ${escape(node.getAttribute("alt") || "No description")}]`;
      if (tag === "blockquote") return block(children().trim().split("\n").map(s => `> ${s}`).join("\n"));
      if (["ul", "ol"].includes(tag)) {
        const start = Number(node.getAttribute("start") || 1);
        const items = Array.from(node.children).filter(n => n.tagName === "LI");
        return block(items.map((item, index) => {
          const prefix = tag === "ol" ? `${start + index}. ` : "- ";
          const text = Array.from(item.childNodes, render).join("").trim();
          return prefix + text.replace(/\n/g, "\n" + " ".repeat(prefix.length));
        }).join("\n"));
      }
      if (tag === "table") {
        const cells = Array.from(node.querySelectorAll("tr"))
          .filter(row => row.closest("table") === node)
          .map(row => Array.from(row.children)
            .filter(cell => ["TH", "TD"].includes(cell.tagName))
            .map(cell => Array.from(cell.childNodes, render).join("").trim()
              .replace(/\|/g, "\\|").replace(/\n/g, "<br>")));
        if (!cells.length) return "";
        const width = Math.max(...cells.map(row => row.length));
        const lines = cells.map(row => "| " + Array.from({ length: width }, (_, i) => row[i] || "").join(" | ") + " |");
        lines.splice(1, 0, "| " + Array(width).fill("---").join(" | ") + " |");
        return block(lines.join("\n"));
      }
      const text = children();
      return ["p", "div", "section", "article", "figure"].includes(tag) ? block(text) : text;
    }
    return render(root).replace(/\u00a0/g, " ").trim();
  }

  function fromElement(element, role, base) {
    if (isRoleLabel(element)) return { text: "", markdown: "", images: [], attachments: [] };
    const clone = element.cloneNode(true);
    clone.querySelectorAll(OMIT).forEach(node => node.remove());
    clone.querySelectorAll(HEADING_SELECTOR).forEach(node => {
      if (isRoleLabel(node)) node.remove();
    });
    const candidates = role === "assistant" ? Array.from(clone.querySelectorAll(".markdown,.MarkdownRoot")) : [];
    const roots = candidates.filter(node => !candidates.some(other => other !== node && other.contains(node)));
    // Restrict known message bodies to avoid exporting action labels and UI chrome.
    const userBody = role === "user" ? clone.querySelector('[data-user-message-bubble="true"],.whitespace-pre-wrap,[data-testid="collapsible-user-message-content"]') : null;
    const bodies = roots.length ? roots : [userBody || clone];
    return {
      text: bodies.map(node => node.textContent.trim()).join("\n\n"),
      markdown: bodies.map(node => toMarkdown(node, { base, preserveWhitespace: role === "user" })).join("\n\n"),
      images: Array.from(clone.querySelectorAll("img"), img => ({
        type: "image-reference", alt: img.getAttribute("alt") || "", embedded: false
      })),
      attachments: Array.from(clone.querySelectorAll("a[download]"), link => ({
        name: link.getAttribute("download") || link.textContent.trim(), embedded: false
      }))
    };
  }

  function markdown(data) {
    const title = String(data.title || "ChatGPT conversation").replace(/[\r\n]+/g, " ");
    const metadata = [
      `Source: ${data.url}`, `Exported at: ${data.exportedAt}`,
      `Scope: Currently selected conversation branch · ${data.messages.length} messages`,
      `Completeness: Unverified · Stop reason: ${data.collection.stopReason}`,
      ...data.collection.warnings
    ].map(line => "> " + String(line).replace(/[\r\n]+/g, " ")).join("\n");
    return `# ${escape(title)}\n\n${metadata}\n\n` + data.messages.map((message, index) =>
      `## ${index + 1}. ${escape(message.role)}\n\n${message.markdown || "(No text)"}\n`
    ).join("\n---\n\n");
  }
  function filename(title, extension) {
    const safe = String(title || "conversation").normalize("NFC")
      .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "-")
      .slice(0, 80).replace(/[.\s]+$/g, "") || "conversation";
    return `chat-export-${safe}.${extension}`;
  }
  app.format = Object.freeze({ fromElement, toMarkdown, markdown, filename, isRoleLabel });
})();
