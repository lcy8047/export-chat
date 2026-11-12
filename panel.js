(() => {
  const app = globalThis.__chatExportV1;
  if (app.open) { app.open(); return; }
  const host = document.createElement("div");
  host.style.cssText = "all:initial;position:fixed;right:20px;bottom:20px;z-index:2147483647";
  const shadow = host.attachShadow({ mode: "closed" });
  document.documentElement.append(host);
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    section { width: min(390px, calc(100vw - 40px)); max-height: calc(100vh - 40px);
      overflow: auto; padding: 22px; border: 1px solid #cedbd0; border-radius: 16px;
      color: #23352c; background: #f6f8f4; box-shadow: 0 12px 50px #0003;
      font: 13px/1.65 system-ui, -apple-system, sans-serif; color-scheme: light; }
    h1 { font-size: 21px; line-height: 1.3; letter-spacing: -.04em; margin: 8px 0; }
    h2 { font-size: 12px; margin: 0; }
    p { margin: 6px 0 14px; overflow-wrap: anywhere; }
    .eyebrow { color: #28755d; font-size: 10px; letter-spacing: .16em; font-weight: 800; }
    .muted, small { color: #647369; }
    label { display: block; font-weight: 650; margin: 18px 0 6px; }
    select { width: 100%; padding: 10px; background: white; color: inherit;
      border: 1px solid #bdcec1; border-radius: 8px; font: inherit; }
    .row { display: flex; gap: 8px; margin: 12px 0; }
    button { flex: 1; padding: 10px; border: 1px solid #bdcec1; border-radius: 8px;
      font: inherit; font-weight: 650; background: white; color: inherit; cursor: pointer; }
    button.primary { background: #21684f; color: white; border-color: #21684f; }
    button.close { flex: 0; float: right; padding: 2px 8px; font-size: 16px; }
    button:disabled { opacity: .45; cursor: default; }
    button:focus-visible, select:focus-visible { outline: 3px solid #6aad91; outline-offset: 2px; }
    .status { padding: 12px; background: #eaf1e8; border: 1px solid #d5e0d2;
      border-radius: 10px; margin: 14px 0; }
    .status p { margin: 4px 0 0; font-size: 12px; }
    ul { margin: 8px 0 0; padding-left: 18px; color: #785a24; font-size: 11px; }
    ul:empty { display: none; }
    .preview { max-height: 180px; overflow: auto; margin-top: 8px; }
    .message { padding: 8px 0; border-bottom: 1px solid #d5e0d2; }
    .message strong { color: #28755d; font-size: 11px; }
    .message p { white-space: pre-wrap; margin: 4px 0; font-size: 12px; }
    footer { border-top: 1px solid #d5e0d2; padding-top: 12px; margin-top: 16px;
      font-size: 10px; color: #647369; }
    [hidden] { display: none !important; }
  `;
  shadow.append(style);
  function el(tag, text, parent, className) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    parent.append(node);
    return node;
  }
  function button(parent, label, handler, className) {
    const node = el("button", label, parent, className);
    node.type = "button";
    node.addEventListener("click", handler);
    return node;
  }
  const panel = el("section", "", shadow);
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Chat Export");
  button(panel, "×", () => { host.hidden = true; host.style.display = "none"; }, "close").setAttribute("aria-label", "Close · Collection continues");
  el("span", "CHAT EXPORT · 0.2.2", panel, "eyebrow");
  el("h1", "Keep a copy of your conversation.", panel);
  el("p", "Save the selected conversation branch as Markdown or JSON.", panel, "muted");
  const label = el("label", "Collection scope", panel);
  label.htmlFor = "chat-export-mode";
  const mode = el("select", "", panel);
  mode.id = "chat-export-mode";
  const scrollOption = el("option", "Long conversation · Scroll from start to end", mode);
  scrollOption.value = "scroll";
  const loadedOption = el("option", "Messages already loaded on this page", mode);
  loadedOption.value = "loaded";
  el("small", "Keep the conversation tab open and avoid interacting with it while collecting. You can close this panel.", panel);
  const controls = el("div", "", panel, "row");
  const start = button(controls, "Start collection", begin, "primary");
  const stop = button(controls, "Stop", () => collector.stop());
  const statusBox = el("div", "", panel, "status");
  statusBox.setAttribute("aria-live", "polite");
  const status = el("strong", "Ready to collect.", statusBox);
  const detail = el("p", "", statusBox);
  const warnings = el("ul", "", statusBox);
  const diagnosticButton = button(panel, "Save diagnostics", () => {
    const diagnostics = collector.data?.collection.diagnostics;
    if (diagnostics && !collector.running) {
      saveFile(JSON.stringify(diagnostics, null, 2), "chat-export-diagnostics.json", "application/json;charset=utf-8");
    }
  });
  diagnosticButton.hidden = true;
  const result = el("div", "", panel);
  result.hidden = true;
  el("h2", "Preview · First 4 messages", result);
  const preview = el("div", "", result, "preview");
  // A separate document keeps typing away from capture-phase page shortcuts.
  // Shadow DOM alone retargets the input to the host before those handlers run.
  // The local about:blank frame makes no network requests and needs no permission.
  const filenameFrame = el("iframe", "", result);
  filenameFrame.title = "Export file name";
  filenameFrame.style.cssText = "display:block;width:100%;height:142px;border:0;background:transparent";
  const filenameDocument = filenameFrame.contentDocument;
  filenameDocument.documentElement.lang = "en";
  filenameDocument.title = "Export file name";
  const filenameStyle = el("style", `
    html { color-scheme: light; }
    body { margin: 0; background: transparent; color: #23352c; font: 13px/1.65 system-ui, -apple-system, sans-serif; }
    .field { display: flow-root; padding: 3px; }
    label { display: block; font-weight: 650; margin: 14px 0 6px; }
    input { box-sizing: border-box; width: 100%; padding: 10px; background: white; color: inherit;
      border: 1px solid #bdcec1; border-radius: 8px; font: inherit; }
    input:disabled { opacity: .45; }
    input:focus-visible { outline: 3px solid #6aad91; outline-offset: 0; }
    small { display: block; margin-top: 4px; color: #647369; font-size: 11px; }
  `, filenameDocument.head);
  const filenameSurface = el("div", "", filenameDocument.body, "field");
  const filenameLabel = el("label", "File name", filenameSurface);
  filenameLabel.htmlFor = "chat-export-filename";
  const filenameInput = el("input", "", filenameSurface);
  filenameInput.id = "chat-export-filename";
  filenameInput.type = "text";
  filenameInput.autocomplete = "off";
  filenameInput.spellcheck = false;
  filenameInput.maxLength = 120;
  filenameInput.defaultValue = app.format.filename(document.title || "ChatGPT conversation", "md").slice(0, -3);
  filenameInput.value = filenameInput.defaultValue;
  let filenameEdited = false;
  filenameInput.addEventListener("input", () => {
    filenameEdited = filenameInput.value !== filenameInput.defaultValue;
  });
  const filenameHelp = el("small", "The .md or .json extension is added automatically. Leave the name unchanged to use the default.", filenameSurface);
  filenameHelp.id = "chat-export-filename-help";
  filenameInput.setAttribute("aria-describedby", filenameHelp.id);
  const downloads = el("div", "", result, "row");
  const md = button(downloads, "Save Markdown", () => download("md"));
  const json = button(downloads, "Save JSON", () => download("json"));
  el("footer", "Processed locally in your browser. Original attachments and alternative regenerated branches are excluded. Reloading the page clears collected results.", panel);
  function resizeFilenameFrame() {
    const height = Math.ceil(filenameSurface.getBoundingClientRect().height);
    if (height > 0) filenameFrame.style.height = `${height}px`;
  }
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(resizeFilenameFrame).observe(filenameSurface);

  const reasons = {
    "loaded-only": "Loaded messages collected",
    "scroll-boundaries-observed": "Both scroll boundaries observed",
    "user-stopped": "Stopped by user",
    "time-limit": "90-second time limit",
    "step-limit": "Scroll step limit",
    "conversation-changed": "Navigated to another conversation or page",
    "error": "Collection error"
  };
  const collector = new app.Collector({ onUpdate: render });
  function render(progress) {
    const running = collector.running;
    start.disabled = mode.disabled = filenameInput.disabled = running;
    stop.disabled = !running;
    md.disabled = json.disabled = running || !collector.data?.messages.length;
    if (!progress) return;
    if (progress.phase !== "done") {
      status.textContent = `Collecting · ${progress.count} messages`;
      detail.textContent = progress.phase === "waiting" ? "Waiting for messages to render."
        : progress.phase === "up" ? "Checking earlier messages." : "Checking messages.";
      return;
    }
    const data = collector.data;
    const defaultStem = app.format.filename(data.title, "md").slice(0, -3);
    if (!filenameEdited) filenameInput.value = defaultStem;
    filenameInput.defaultValue = defaultStem;
    const failed = data.collection.stopReason === "error";
    const label = failed ? "Collection failed" : data.collection.stopReason === "user-stopped" ? "Collection stopped" : "Collection finished";
    status.textContent = `${label} · ${data.messages.length} messages`;
    diagnosticButton.hidden = !data.collection.diagnostics;
    detail.textContent = `Completeness unverified · ${reasons[data.collection.stopReason] || data.collection.stopReason}`;
    warnings.replaceChildren();
    data.collection.warnings.forEach(text => el("li", text, warnings));
    result.hidden = !data.messages.length;
    resizeFilenameFrame();
    preview.replaceChildren();
    for (const message of data.messages.slice(0, 4)) {
      const row = el("div", "", preview, "message");
      el("strong", message.role, row);
      // Conversation text is never interpreted as HTML.
      el("p", (message.text || message.markdown || "(No text)").slice(0, 240), row);
    }
  }
  async function begin() {
    if (collector.running) return;
    result.hidden = true;
    diagnosticButton.hidden = true;
    warnings.replaceChildren();
    try { await collector.collect({ mode: mode.value }); }
    catch (error) {
      status.textContent = "Could not start collection.";
      detail.textContent = String(error.message || error);
      render();
    }
  }
  function download(extension) {
    const data = collector.data;
    if (collector.running || !data?.messages.length) return;
    const content = extension === "json" ? JSON.stringify(data, null, 2) : app.format.markdown(data);
    saveFile(content, app.format.exportFilename(filenameInput.value, data.title, extension), extension === "json"
      ? "application/json;charset=utf-8" : "text/markdown;charset=utf-8");
  }
  function saveFile(content, filename, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = el("a", "", shadow);
    link.href = url;
    link.download = filename;
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  app.open = () => {
    host.hidden = false;
    host.style.display = "block";
    if (!host.isConnected) {
      document.documentElement.append(host);
      // Reattaching an iframe replaces its document; retain the field and its value.
      const restoredDocument = filenameFrame.contentDocument;
      restoredDocument.documentElement.lang = "en";
      restoredDocument.title = "Export file name";
      restoredDocument.head.append(filenameStyle);
      restoredDocument.body.append(filenameSurface);
    }
    resizeFilenameFrame();
    start.focus();
  };
  render();
  app.open();
})();
