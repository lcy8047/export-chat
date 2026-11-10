(() => {
  const app = globalThis.__chatExportV1;
  if (app.open) { app.open(); return; }
  const host = document.createElement("div");
  host.style.cssText = "all:initial;position:fixed;right:20px;bottom:20px;z-index:2147483647";
  const shadow = host.attachShadow({ mode: "closed" });
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
  button(panel, "×", () => { host.hidden = true; }, "close").setAttribute("aria-label", "닫기 · 수집은 계속됩니다");
  el("span", "CHAT EXPORT", panel, "eyebrow");
  el("h1", "대화를 파일로 간직하세요.", panel);
  el("p", "현재 선택된 대화 분기를 Markdown·JSON으로 저장합니다.", panel, "muted");
  const label = el("label", "수집 범위", panel);
  label.htmlFor = "chat-export-mode";
  const mode = el("select", "", panel);
  mode.id = "chat-export-mode";
  const scrollOption = el("option", "긴 대화 · 처음부터 끝까지 스크롤", mode);
  scrollOption.value = "scroll";
  const loadedOption = el("option", "현재 페이지에 로드된 메시지만", mode);
  loadedOption.value = "loaded";
  el("small", "스크롤 수집 중에는 대화 탭을 열어 두고 조작을 잠시 멈춰 주세요. 창은 닫아도 됩니다.", panel);
  const controls = el("div", "", panel, "row");
  const start = button(controls, "수집 시작", begin, "primary");
  const stop = button(controls, "중지", () => collector.stop());
  const statusBox = el("div", "", panel, "status");
  statusBox.setAttribute("aria-live", "polite");
  const status = el("strong", "수집할 준비가 되었습니다.", statusBox);
  const detail = el("p", "", statusBox);
  const warnings = el("ul", "", statusBox);
  const result = el("div", "", panel);
  result.hidden = true;
  el("h2", "미리보기 · 처음 4개 메시지", result);
  const preview = el("div", "", result, "preview");
  const downloads = el("div", "", result, "row");
  const md = button(downloads, "Markdown 저장", () => download("md"));
  const json = button(downloads, "JSON 저장", () => download("json"));
  el("footer", "외부 전송 없이 브라우저 안에서 처리합니다. 첨부파일 원본과 다른 재생성 분기는 포함하지 않습니다. 새로고침하면 수집 결과가 사라집니다.", panel);
  document.documentElement.append(host);

  const reasons = {
    "loaded-only": "로드된 메시지 수집",
    "scroll-boundaries-observed": "스크롤 양 끝 확인",
    "user-stopped": "사용자 중지",
    "time-limit": "90초 시간 제한",
    "step-limit": "스크롤 횟수 제한",
    "conversation-changed": "다른 대화 또는 페이지로 이동",
    "error": "수집 오류"
  };
  const collector = new app.Collector({ onUpdate: render });
  function render(progress) {
    const running = collector.running;
    start.disabled = mode.disabled = running;
    stop.disabled = !running;
    md.disabled = json.disabled = running || !collector.data?.messages.length;
    if (!progress) return;
    if (progress.phase !== "done") {
      status.textContent = `수집 중 · 메시지 ${progress.count}개`;
      detail.textContent = progress.phase === "up" ? "이전 메시지를 확인하고 있습니다." : "메시지를 확인하고 있습니다.";
      return;
    }
    const data = collector.data;
    status.textContent = `${data.collection.stopReason === "user-stopped" ? "수집 중지" : "수집 종료"} · 메시지 ${data.messages.length}개`;
    detail.textContent = `완전성 미확인 · ${reasons[data.collection.stopReason] || data.collection.stopReason}`;
    warnings.replaceChildren();
    data.collection.warnings.forEach(text => el("li", text, warnings));
    result.hidden = !data.messages.length;
    preview.replaceChildren();
    for (const message of data.messages.slice(0, 4)) {
      const row = el("div", "", preview, "message");
      el("strong", message.role, row);
      // Conversation text is never interpreted as HTML.
      el("p", (message.text || message.markdown || "(텍스트 없음)").slice(0, 240), row);
    }
  }
  async function begin() {
    if (collector.running) return;
    result.hidden = true;
    warnings.replaceChildren();
    try { await collector.collect({ mode: mode.value }); }
    catch (error) {
      status.textContent = "수집을 시작하지 못했습니다.";
      detail.textContent = String(error.message || error);
      render();
    }
  }
  function download(extension) {
    const data = collector.data;
    if (collector.running || !data?.messages.length) return;
    const content = extension === "json" ? JSON.stringify(data, null, 2) : app.format.markdown(data);
    const blob = new Blob([content], { type: extension === "json"
      ? "application/json;charset=utf-8" : "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = el("a", "", shadow);
    link.href = url;
    link.download = app.format.filename(data.title, extension);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  app.open = () => {
    host.hidden = false;
    if (!host.isConnected) document.documentElement.append(host);
    start.focus();
  };
  render();
  app.open();
})();
