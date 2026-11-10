const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const root = path.join(__dirname, '..');

function environment(html = '') {
  const dom = new JSDOM(`<!doctype html><title>테스트 대화</title><main>${html}</main>`, {
    url: 'https://chatgpt.com/c/example', runScripts: 'outside-only'
  });
  for (const file of ['format.js', 'collector.js']) dom.window.eval(fs.readFileSync(path.join(root, file), 'utf8'));
  return { dom, window: dom.window, app: dom.window.__chatExportV1 };
}
function message(id, text, role = 'user') {
  return `<article data-message-id="${id}" data-message-author-role="${role}"><div>${text}</div></article>`;
}
const plain = value => JSON.parse(JSON.stringify(value));

// These fixtures intentionally cover content fidelity and DOM replacement, not ChatGPT's live markup.
test('Markdown preserves code fences, blank lines, links, tables, math and image presence', () => {
  const { dom, window, app } = environment();
  try {
    const node = window.document.createElement('div');
    node.innerHTML = '<h2>제목</h2><p><strong>굵게</strong> <a href="https://example.com/a?q=1">출처</a></p>' +
      '<pre><code class="language-js">const x = "```";\n\n\nconsole.log(x);\n</code></pre>' +
      '<table><tr><th>이름</th><th>값</th></tr><tr><td>A|B</td><td>1<br>2</td></tr></table>' +
      '<span class="katex"><annotation encoding="application/x-tex">x^2</annotation></span>' +
      '<img alt="사진" src="https://example.com/private-token"><button>복사</button>' +
      '<a href="javascript:alert(1)">위험 링크</a>';
    const md = app.format.toMarkdown(node);
    assert.match(md, /## 제목/);
    assert.match(md, /\*\*굵게\*\*/);
    assert.match(md, /\[출처\]\(<https:\/\/example.com\/a\?q=1>\)/);
    assert.ok(md.includes('````js\nconst x = "```";\n\n\nconsole.log(x);\n````'));
    assert.ok(md.includes('| A\\|B | 1<br>2 |'));
    assert.ok(md.includes('$x^2$'));
    assert.ok(md.includes('[이미지: 사진]'));
    assert.ok(!md.includes('private-token'));
    assert.ok(!md.includes('javascript:'));
    assert.ok(!md.includes('복사'));
  } finally { dom.window.close(); }
});

test('user newlines survive and assistant action controls are excluded', async () => {
  const { dom, app } = environment(
    '<article data-message-id="u" data-message-author-role="user"><div class="whitespace-pre-wrap">첫째\n\n둘째</div></article>' +
    '<article data-message-id="a" data-message-author-role="assistant"><div class="markdown"><p>대답</p></div><button>복사</button><span>기타 UI</span></article>');
  try {
    const data = await new app.Collector().collect({ mode: 'loaded' });
    assert.equal(data.messages[0].markdown, '첫째\n\n둘째');
    assert.equal(data.messages[1].markdown, '대답');
    assert.equal(data.completeness, 'unverified');
    assert.equal(data.collection.stopReason, 'loaded-only');
    assert.ok(app.format.markdown(data).includes('완전성: 미확인'));
  } finally { dom.window.close(); }
});

test('identical questions in different turns remain separate messages', async () => {
  const { dom, app } = environment(message('one', '같은 질문') + message('two', '같은 질문'));
  try {
    const data = await new app.Collector().collect({ mode: 'loaded' });
    assert.equal(data.messages.length, 2);
    assert.notEqual(data.messages[0].id, data.messages[1].id);
  } finally { dom.window.close(); }
});

function virtualEnvironment() {
  const env = environment('<div id="scroller" style="overflow-y:auto;scroll-behavior:smooth"></div>');
  const scroller = env.window.document.getElementById('scroller');
  let top = 1200;
  const render = () => {
    const first = Math.floor(top / 500);
    const last = Math.min(5, Math.floor((top + 499) / 500));
    scroller.innerHTML = Array.from({ length: last - first + 1 }, (_, i) =>
      message(String(first + i), '내용 ' + (first + i))).join('');
  };
  Object.defineProperties(scroller, {
    clientHeight: { get: () => 500 }, scrollHeight: { get: () => 3000 },
    scrollTop: { get: () => top, set: value => { top = Math.max(0, Math.min(2500, value)); render(); } }
  });
  render();
  return { ...env, scroller };
}

test('scrolling a virtualized conversation merges replaced DOM nodes in chronological order', async () => {
  const { dom, app, scroller } = virtualEnvironment();
  try {
    const data = await new app.Collector({ settleMs: 0 }).collect({ mode: 'scroll' });
    assert.deepEqual(plain(data.messages.map(m => m.id)), Array.from({ length: 6 }, (_, i) => `user:${i}`));
    assert.equal(data.collection.stopReason, 'scroll-boundaries-observed');
    assert.equal(data.completeness, 'unverified');
    assert.equal(scroller.scrollTop, 1200);
    assert.equal(scroller.style.getPropertyValue('scroll-behavior'), 'smooth');
  } finally { dom.window.close(); }
});

test('stopping a job retains the captured messages and restores the scroll position', async () => {
  const { dom, app, scroller } = virtualEnvironment();
  try {
    let collector;
    collector = new app.Collector({ settleMs: 0, onUpdate: () => collector.stop() });
    const data = await collector.collect({ mode: 'scroll' });
    assert.equal(data.collection.stopReason, 'user-stopped');
    assert.ok(data.messages.length);
    assert.equal(scroller.scrollTop, 1200);
    assert.equal(collector.running, false);
  } finally { dom.window.close(); }
});

test('conversation navigation aborts before new conversation content is captured', async () => {
  const { dom, app, scroller } = virtualEnvironment();
  try {
    let changed = false;
    const collector = new app.Collector({ settleMs: 0, onUpdate: () => {
      if (changed) return;
      changed = true;
      dom.reconfigure({ url: 'https://chatgpt.com/c/different' });
      scroller.innerHTML = message('new-conversation', '다른 대화');
    } });
    const data = await collector.collect({ mode: 'scroll' });
    assert.equal(data.collection.stopReason, 'conversation-changed');
    assert.equal(data.url, 'https://chatgpt.com/c/example');
    assert.ok(!data.messages.some(m => m.text === '다른 대화'));
  } finally { dom.window.close(); }
});

test('missing message IDs and generation in progress are explicitly reported', async () => {
  const { dom, app } = environment('<div data-message-author-role="user">질문</div><button data-testid="stop-button">중지</button>');
  try {
    const data = await new app.Collector().collect({ mode: 'loaded' });
    assert.ok(data.collection.warnings.some(w => w.includes('고유 ID')));
    assert.ok(data.collection.warnings.some(w => w.includes('답변 생성')));
  } finally { dom.window.close(); }
});

test('empty pages produce a useful error and never a successful empty export', async () => {
  const { dom, app } = environment();
  try {
    const data = await new app.Collector().collect({ mode: 'loaded' });
    assert.equal(data.collection.stopReason, 'error');
    assert.equal(data.messages.length, 0);
    assert.ok(data.collection.warnings.some(w => w.includes('메시지를 찾지 못했습니다')));
  } finally { dom.window.close(); }
});

test('time and step limits preserve partial results', async () => {
  const { dom, app } = environment(message('one', '질문'));
  try {
    const timed = await new app.Collector({ maxDurationMs: 0 }).collect({ mode: 'scroll' });
    assert.equal(timed.collection.stopReason, 'time-limit');
    assert.equal(timed.messages.length, 1);
    const stepped = await new app.Collector({ maxSteps: 0 }).collect({ mode: 'scroll' });
    assert.equal(stepped.collection.stopReason, 'step-limit');
    assert.equal(stepped.messages.length, 1);
  } finally { dom.window.close(); }
});

test('filenames remove path separators and control characters', () => {
  const { dom, app } = environment();
  try {
    const name = app.format.filename('../대화/제목\\x:*?\n', 'json');
    assert.ok(name.endsWith('.json'));
    assert.ok(!/[\\/:*?\n]/.test(name));
  } finally { dom.window.close(); }
});

test('reopening the panel does not duplicate it; previews treat conversation HTML as text', async () => {
  const { dom, window } = environment(message('one', '&lt;img src=x onerror=alert(1)&gt;'));
  try {
    let shadow;
    const original = window.Element.prototype.attachShadow;
    window.Element.prototype.attachShadow = function (options) {
      shadow = original.call(this, options);
      return shadow;
    };
    const code = fs.readFileSync(path.join(root, 'panel.js'), 'utf8');
    window.eval(code);
    window.eval(code);
    assert.equal(window.document.documentElement.querySelectorAll(':scope > div').length, 1);
    const select = shadow.querySelector('select');
    select.value = 'loaded';
    [...shadow.querySelectorAll('button')].find(b => b.textContent === '수집 시작').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(shadow.querySelector('.preview').textContent.includes('<img src=x onerror=alert(1)>'));
    assert.equal(shadow.querySelector('.preview img'), null);
    assert.equal([...shadow.querySelectorAll('button')].find(b => b.textContent === 'JSON 저장').disabled, false);
  } finally { dom.window.close(); }
});
