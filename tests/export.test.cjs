const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const root = path.join(__dirname, '..');

function environment(html = '') {
  const dom = new JSDOM(`<!doctype html><title>Test conversation</title><main>${html}</main>`, {
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
    node.innerHTML = '<h2>Title</h2><p><strong>Bold</strong> <a href="https://example.com/a?q=1">Source</a></p>' +
      '<pre><code class="language-js">const x = "```";\n\n\nconsole.log(x);\n</code></pre>' +
      '<table><tr><th>Name</th><th>Value</th></tr><tr><td>A|B</td><td>1<br>2</td></tr></table>' +
      '<span class="katex"><annotation encoding="application/x-tex">x^2</annotation></span>' +
      '<img alt="Photo" src="https://example.com/private-token"><button>Copy</button>' +
      '<a href="javascript:alert(1)">Unsafe link</a>';
    const md = app.format.toMarkdown(node);
    assert.match(md, /## Title/);
    assert.match(md, /\*\*Bold\*\*/);
    assert.match(md, /\[Source\]\(<https:\/\/example.com\/a\?q=1>\)/);
    assert.ok(md.includes('````js\nconst x = "```";\n\n\nconsole.log(x);\n````'));
    assert.ok(md.includes('| A\\|B | 1<br>2 |'));
    assert.ok(md.includes('$x^2$'));
    assert.ok(md.includes('[Image: Photo]'));
    assert.ok(!md.includes('private-token'));
    assert.ok(!md.includes('javascript:'));
    assert.ok(!md.includes('Copy'));
  } finally { dom.window.close(); }
});

test('user newlines survive and assistant action controls are excluded', async () => {
  const { dom, app } = environment(
    '<article data-message-id="u" data-message-author-role="user"><div class="whitespace-pre-wrap">First\n\nSecond</div></article>' +
    '<article data-message-id="a" data-message-author-role="assistant"><div class="markdown"><p>Answer</p></div><button>Copy</button><span>Other UI</span></article>');
  try {
    const data = await new app.Collector().collect({ mode: 'loaded' });
    assert.equal(data.messages[0].markdown, 'First\n\nSecond');
    assert.equal(data.messages[1].markdown, 'Answer');
    assert.equal(data.completeness, 'unverified');
    assert.equal(data.collection.stopReason, 'loaded-only');
    assert.ok(app.format.markdown(data).includes('Completeness: Unverified'));
  } finally { dom.window.close(); }
});

test('identical questions in different turns remain separate messages', async () => {
  const { dom, app } = environment(message('one', 'Same question') + message('two', 'Same question'));
  try {
    const data = await new app.Collector().collect({ mode: 'loaded' });
    assert.equal(data.messages.length, 2);
    assert.notEqual(data.messages[0].id, data.messages[1].id);
  } finally { dom.window.close(); }
});

function virtualEnvironment(renderMessage = message) {
  const env = environment('<div id="scroller" style="overflow-y:auto;scroll-behavior:smooth"></div>');
  const scroller = env.window.document.getElementById('scroller');
  let top = 1200;
  const render = () => {
    const first = Math.floor(top / 500);
    const last = Math.min(5, Math.floor((top + 499) / 500));
    scroller.innerHTML = Array.from({ length: last - first + 1 }, (_, i) =>
      renderMessage(String(first + i), 'Content ' + (first + i))).join('');
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
      scroller.innerHTML = message('new-conversation', 'Different conversation');
    } });
    const data = await collector.collect({ mode: 'scroll' });
    assert.equal(data.collection.stopReason, 'conversation-changed');
    assert.equal(data.url, 'https://chatgpt.com/c/example');
    assert.ok(!data.messages.some(m => m.text === 'Different conversation'));
  } finally { dom.window.close(); }
});

test('missing message IDs and generation in progress are explicitly reported', async () => {
  const { dom, app } = environment('<div data-message-author-role="user">Question</div><button data-testid="stop-button">Stop</button>');
  try {
    const data = await new app.Collector().collect({ mode: 'loaded' });
    assert.ok(data.collection.warnings.some(w => w.includes('message IDs')));
    assert.ok(data.collection.warnings.some(w => w.includes('Response generation')));
  } finally { dom.window.close(); }
});

test('empty pages produce a useful error and never a successful empty export', async () => {
  const { dom, app } = environment();
  try {
    const data = await new app.Collector({ initialWaitMs: 0 }).collect({ mode: 'loaded' });
    assert.equal(data.collection.stopReason, 'error');
    assert.equal(data.messages.length, 0);
    assert.ok(data.collection.warnings.some(w => w.includes('No messages found')));
  } finally { dom.window.close(); }
});

test('time and step limits preserve partial results', async () => {
  const { dom, app } = environment(message('one', 'Question'));
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
    const name = app.format.filename('../conversation/Title\\x:*?\n', 'json');
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
    [...shadow.querySelectorAll('button')].find(b => b.textContent === 'Start collection').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(shadow.querySelector('.preview').textContent.includes('<img src=x onerror=alert(1)>'));
    assert.equal(shadow.querySelector('.preview img'), null);
    assert.equal([...shadow.querySelectorAll('button')].find(b => b.textContent === 'Save JSON').disabled, false);
  } finally { dom.window.close(); }
});

test('new grouped layout collects user and assistant separately without legacy markers', async () => {
  const { dom, app } = environment(`
    <div data-turn-key="exchange-1">
      <div data-content-search-unit-key="exchange-1:0:user">
        <div data-user-message-bubble="true">First question</div>
      </div>
      <div data-content-search-unit-key="exchange-1:2:assistant">
        <div data-conversation-role="assistant"><div class="MarkdownRoot"><p>First <strong>answer</strong></p></div></div>
      </div>
      <div class="turn-action-controls"><button>Copy</button><span>Rate this response</span></div>
    </div>
    <div data-turn-key="exchange-2">
      <div data-content-search-unit-key="exchange-2:0:user"><div data-user-message-bubble="true">Second question</div></div>
      <div data-content-search-unit-key="exchange-2:2:assistant"><div class="MarkdownRoot"><p>Second answer</p></div></div>
    </div>`);
  try {
    const data = await new app.Collector().collect({ mode: 'loaded' });
    assert.deepEqual(plain(data.messages.map(m => m.role)), ['user', 'assistant', 'user', 'assistant']);
    assert.ok(data.messages[1].markdown.includes('First **answer**'));
    assert.equal(data.messages[3].text, 'Second answer');
    assert.ok(!data.messages.some(m => m.text.includes('Rate this response')));
    assert.equal(new Set(data.messages.map(m => m.id)).size, 4);
    assert.ok(!data.collection.warnings.some(w => w.includes('message IDs')));
  } finally { dom.window.close(); }
});

test('alternate search-unit keys preserve multiple assistant units within one exchange', async () => {
  const { dom, app } = environment(`
    <div data-content-search-turn-key="exchange">
      <div data-chatgpt-search-unit-key="exchange:0:user">Question</div>
      <div data-chatgpt-search-unit-key="exchange:1:assistant"><div class="MarkdownRoot">Progress</div></div>
      <div data-chatgpt-search-unit-key="exchange:2:assistant"><div class="MarkdownRoot">Final answer</div></div>
    </div>`);
  try {
    const data = await new app.Collector().collect({ mode: 'loaded' });
    assert.deepEqual(plain(data.messages.map(m => m.text)), ['Question', 'Progress', 'Final answer']);
    assert.equal(new Set(data.messages.map(m => m.id)).size, 3);
  } finally { dom.window.close(); }
});

test('role and bubble markers work when search units are absent', async () => {
  const { dom, app } = environment(`
    <div data-turn-key="exchange">
      <div data-user-message-bubble="true">Question</div>
      <div data-conversation-role="assistant"><div class="MarkdownRoot">Answer</div></div>
    </div>`);
  try {
    const data = await new app.Collector().collect({ mode: 'loaded' });
    assert.deepEqual(plain(data.messages.map(m => m.role)), ['user', 'assistant']);
    assert.deepEqual(plain(data.messages.map(m => m.text)), ['Question', 'Answer']);
    assert.notEqual(data.messages[0].id, data.messages[1].id);
  } finally { dom.window.close(); }
});

test('turn-level roles are supported and nested legacy message markers are not duplicated', async () => {
  const { dom, app } = environment(`
    <section data-turn="user" data-turn-id="u" data-testid="conversation-turn-0"><div class="whitespace-pre-wrap">Question</div></section>
    <section data-turn="assistant" data-turn-id="a" data-testid="conversation-turn-1">
      <div data-message-author-role="assistant" data-message-id="answer"><div class="markdown">Answer</div></div>
    </section>`);
  try {
    const data = await new app.Collector().collect({ mode: 'loaded' });
    assert.deepEqual(plain(data.messages.map(m => m.role)), ['user', 'assistant']);
    assert.equal(data.messages.length, 2);
  } finally { dom.window.close(); }
});

test('message discovery is not restricted to the first main element and ignores navigation and hidden copies', async () => {
  const { dom, window, app } = environment();
  try {
    window.document.body.insertAdjacentHTML('beforeend', `
      <nav><div data-content-search-unit-key="history:0:user">History preview</div></nav>
      <div hidden><div data-content-search-unit-key="hidden:0:user">Hidden copy</div></div>
      <div style="display:none"><div data-content-search-unit-key="hidden-css:0:user">Hidden CSS copy</div></div>
      <div role="main"><div data-content-search-unit-key="active:0:user">Active question</div>
        <div data-content-search-unit-key="active:2:assistant">Active answer</div></div>
      <form data-chatgpt-composer><div data-user-message-bubble="true">Unsent draft</div></form>`);
    const data = await new app.Collector().collect({ mode: 'loaded' });
    assert.deepEqual(plain(data.messages.map(m => m.text)), ['Active question', 'Active answer']);
  } finally { dom.window.close(); }
});

test('initial rendering gets a short retry instead of immediately reporting no messages', async () => {
  const { dom, window, app } = environment();
  try {
    window.setTimeout(() => {
      window.document.querySelector('main').innerHTML = '<div data-content-search-unit-key="late:0:user">Ready now</div>';
    }, 15);
    const data = await new app.Collector({ initialWaitMs: 300 }).collect({ mode: 'loaded' });
    assert.equal(data.messages.length, 1);
    assert.equal(data.messages[0].text, 'Ready now');
  } finally { dom.window.close(); }
});

test('empty turn shells are not exported as captured messages', async () => {
  const { dom, app } = environment('<section data-turn="user" data-turn-id="empty"></section>');
  try {
    const data = await new app.Collector({ initialWaitMs: 0 }).collect({ mode: 'loaded' });
    assert.equal(data.messages.length, 0);
    assert.equal(data.collection.stopReason, 'error');
    assert.ok(data.collection.diagnostics);
    assert.equal(data.collection.diagnostics.turns, 1);
    assert.ok(!JSON.stringify(data.collection.diagnostics).includes('https://'));
  } finally { dom.window.close(); }
});

test('role containers do not collapse distinct search units into a single message', async () => {
  const { dom, app } = environment(`
    <div data-conversation-role="assistant">
      <div data-content-search-unit-key="exchange:1:assistant">Progress</div>
      <div data-content-search-unit-key="exchange:2:assistant">Final answer</div>
    </div>`);
  try {
    const data = await new app.Collector().collect({ mode: 'loaded' });
    assert.deepEqual(plain(data.messages.map(m => m.text)), ['Progress', 'Final answer']);
  } finally { dom.window.close(); }
});

test('scroll collection keeps stable new-layout identities when virtualized nodes are replaced', async () => {
  const { dom, app } = virtualEnvironment((id, text) => {
    const role = Number(id) % 2 ? 'assistant' : 'user';
    return `<div data-turn-key="exchange-${Math.floor(Number(id) / 2)}"><div data-content-search-unit-key="message-${id}:${role}">${text}</div></div>`;
  });
  try {
    const data = await new app.Collector({ settleMs: 0 }).collect({ mode: 'scroll' });
    assert.equal(data.collection.stopReason, 'scroll-boundaries-observed');
    assert.deepEqual(plain(data.messages.map(m => m.text)), Array.from({ length: 6 }, (_, i) => `Content ${i}`));
    assert.equal(new Set(data.messages.map(m => m.id)).size, 6);
    assert.deepEqual(plain(data.messages.map(m => m.role)), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
  } finally { dom.window.close(); }
});

test('failed collection is shown as an error with diagnostics instead of a finished export', async () => {
  const { dom, window, app } = environment();
  try {
    app.Collector = class extends app.Collector {
      constructor(options) { super({ ...options, initialWaitMs: 0 }); }
    };
    let shadow;
    const original = window.Element.prototype.attachShadow;
    window.Element.prototype.attachShadow = function (options) {
      shadow = original.call(this, options);
      return shadow;
    };
    window.eval(fs.readFileSync(path.join(root, 'panel.js'), 'utf8'));
    [...shadow.querySelectorAll('button')].find(b => b.textContent === 'Start collection').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(shadow.textContent.includes('Collection failed · 0 messages'));
    assert.equal([...shadow.querySelectorAll('button')].find(b => b.textContent === 'Save diagnostics').hidden, false);
    assert.equal([...shadow.querySelectorAll('button')].find(b => b.textContent === 'Save JSON').disabled, true);
  } finally { dom.window.close(); }
});

const localizedRoleLabel = '\ub0b4\uac00 \ud55c \ub9d0:';
const localizedQuestion = '\ud655\uc7a5\ud504\ub85c\uadf8\ub7a8\uc740 \uc758\uc2ec\uc2a4\ub7ec\uc6cc\uc11c \ub0b4\uac00 \uc9c1\uc811 \uad6c\ud604\ud558\uace0 \uc2f6\uc740\ub370';

test('standalone conversation role headings are not exported as extra messages', async () => {
  const { dom, app } = environment(`
    <div data-turn-key="exchange">
      <h4 data-conversation-role="user">${localizedRoleLabel}</h4>
      <div data-content-search-unit-key="exchange:0:user"><div data-user-message-bubble="true">${localizedQuestion}</div></div>
      <h4 data-conversation-role="assistant">ChatGPT said:</h4>
      <div data-content-search-unit-key="exchange:2:assistant"><div class="MarkdownRoot">Answer</div></div>
    </div>`);
  try {
    const data = await new app.Collector().collect({ mode: 'loaded' });
    assert.deepEqual(plain(data.messages.map(m => m.role)), ['user', 'assistant']);
    assert.equal(data.messages[0].text, localizedQuestion);
    assert.ok(!app.format.markdown(data).includes(localizedRoleLabel));
  } finally { dom.window.close(); }
});

test('label-only search units are skipped while headings surrounding a body are stripped', async () => {
  const { dom, app } = environment(`
    <div data-turn-key="exchange">
      <div data-content-search-unit-key="exchange:0:user"><h4 data-conversation-role="user">${localizedRoleLabel}</h4></div>
      <div data-content-search-unit-key="exchange:1:user"><div data-user-message-bubble="true">${localizedQuestion}</div></div>
      <div data-content-search-unit-key="exchange:2:assistant"><h4 data-conversation-role="assistant">ChatGPT said:</h4><p>Answer</p></div>
    </div>`);
  try {
    const data = await new app.Collector().collect({ mode: 'loaded' });
    assert.deepEqual(plain(data.messages.map(m => m.text)), [localizedQuestion, 'Answer']);
    assert.equal(data.messages[1].markdown, 'Answer');
  } finally { dom.window.close(); }
});

test('screen-reader turn headings outside message bodies do not leak into either format', async () => {
  const { dom, app } = environment(`
    <section data-turn="user" data-turn-id="question"><h5 class="sr-only">You said:</h5><p>Question</p></section>
    <section data-turn="assistant" data-turn-id="answer"><h6 class="sr-only">ChatGPT said:</h6><p>Answer</p></section>`);
  try {
    const data = await new app.Collector().collect({ mode: 'loaded' });
    assert.deepEqual(plain(data.messages.map(m => m.text)), ['Question', 'Answer']);
    assert.ok(!app.format.markdown(data).includes('said:'));
  } finally { dom.window.close(); }
});

test('actual message text and Markdown headings matching role labels are preserved', async () => {
  const { dom, app } = environment(`
    <div data-turn-key="exchange">
      <h4 data-conversation-role="user">${localizedRoleLabel}</h4>
      <div data-content-search-unit-key="exchange:0:user"><div data-user-message-bubble="true">${localizedRoleLabel}</div></div>
      <div data-content-search-unit-key="exchange:2:assistant"><div class="MarkdownRoot"><h4>You said:</h4><p>${localizedRoleLabel}</p><pre><code>&lt;h4 data-conversation-role="user"&gt;You said:&lt;/h4&gt;</code></pre></div></div>
    </div>`);
  try {
    const data = await new app.Collector().collect({ mode: 'loaded' });
    assert.equal(data.messages.length, 2);
    assert.equal(data.messages[0].text, localizedRoleLabel);
    assert.ok(data.messages[1].markdown.includes('#### You said:'));
    assert.ok(data.messages[1].text.includes(localizedRoleLabel));
    assert.ok(data.messages[1].markdown.includes('<h4 data-conversation-role="user">You said:</h4>'));
  } finally { dom.window.close(); }
});

test('editable filenames retain the original default and sanitize custom names', () => {
  const { dom, app } = environment();
  try {
    const title = 'Original conversation';
    const defaultStem = app.format.filename(title, 'md').slice(0, -3);
    for (const extension of ['md', 'json']) {
      assert.equal(app.format.exportFilename(defaultStem, title, extension), app.format.filename(title, extension));
      assert.equal(app.format.exportFilename('  ', title, extension), app.format.filename(title, extension));
      assert.equal(app.format.exportFilename('...', title, extension), app.format.filename(title, extension));
      assert.equal(app.format.exportFilename('My notes', title, extension), `My notes.${extension}`);
      assert.equal(app.format.exportFilename('My notes.md', title, extension), `My notes.${extension}`);
      assert.equal(app.format.exportFilename('My notes.json', title, extension), `My notes.${extension}`);
      assert.equal(app.format.exportFilename('draft/title:*?', title, extension), `draft-title---.${extension}`);
    }
    const extensionTitle = 'Conversation.md';
    const extensionStem = app.format.filename(extensionTitle, 'md').slice(0, -3);
    assert.equal(app.format.exportFilename(extensionStem, extensionTitle, 'md'), app.format.filename(extensionTitle, 'md'));
  } finally { dom.window.close(); }
});

function downloadPanelEnvironment() {
  const env = environment(message('question', 'Question'));
  const { window } = env;
  let shadow;
  const original = window.Element.prototype.attachShadow;
  window.Element.prototype.attachShadow = function (options) {
    shadow = original.call(this, options);
    return shadow;
  };
  const blobs = new Map();
  const downloads = [];
  window.Blob = Blob;
  window.URL.createObjectURL = blob => {
    const url = `blob:test-${blobs.size}`;
    blobs.set(url, blob);
    return url;
  };
  window.URL.revokeObjectURL = url => blobs.delete(url);
  window.HTMLAnchorElement.prototype.click = function () {
    downloads.push({ filename: this.download, blob: blobs.get(this.href) });
  };
  window.eval(fs.readFileSync(path.join(root, 'panel.js'), 'utf8'));
  const click = label => [...shadow.querySelectorAll('button')].find(node => node.textContent === label).click();
  const collect = async () => {
    shadow.querySelector('select').value = 'loaded';
    click('Start collection');
    await new Promise(resolve => setTimeout(resolve, 0));
  };
  return { ...env, shadow, downloads, click, collect };
}

test('the filename field is prefilled and unchanged downloads use the previous default', async () => {
  const { dom, app, shadow, downloads, click, collect } = downloadPanelEnvironment();
  try {
    await collect();
    assert.equal(shadow.querySelector('iframe').contentDocument.querySelector('#chat-export-filename').value, 'chat-export-Test conversation');
    click('Save Markdown');
    click('Save JSON');
    assert.deepEqual(downloads.map(item => item.filename), [
      app.format.filename('Test conversation', 'md'), app.format.filename('Test conversation', 'json')
    ]);
    assert.ok((await downloads[0].blob.text()).includes('Question'));
    assert.equal(JSON.parse(await downloads[1].blob.text()).messages[0].text, 'Question');
  } finally { dom.window.close(); }
});

test('editing the filename affects both download formats without changing the conversation title', async () => {
  const { dom, window, shadow, downloads, click, collect } = downloadPanelEnvironment();
  try {
    await collect();
    const input = shadow.querySelector('iframe').contentDocument.querySelector('#chat-export-filename');
    input.value = 'My research';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    click('Save Markdown');
    click('Save JSON');
    assert.deepEqual(downloads.map(item => item.filename), ['My research.md', 'My research.json']);
    assert.equal(JSON.parse(await downloads[1].blob.text()).title, 'Test conversation');
    await collect();
    assert.equal(input.value, 'My research');
    input.value = '';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    click('Save Markdown');
    assert.equal(downloads[2].filename, 'chat-export-Test conversation.md');
  } finally { dom.window.close(); }
});

test('typing a filename never reaches capture-phase composer shortcuts on the parent page', async () => {
  const { dom, window, shadow, collect } = downloadPanelEnvironment();
  try {
    await collect();
    const composer = window.document.createElement('textarea');
    window.document.body.append(composer);
    let capturedKeys = 0;
    window.document.addEventListener('keydown', () => {
      capturedKeys++;
      composer.focus();
    }, true);
    const input = shadow.querySelector('iframe').contentDocument.querySelector('#chat-export-filename');
    input.focus();
    const event = new window.KeyboardEvent('keydown', { key: 'a', bubbles: true, composed: true, cancelable: true });
    input.dispatchEvent(event);
    assert.equal(capturedKeys, 0);
    assert.equal(event.defaultPrevented, false);
    assert.equal(input.ownerDocument.activeElement, input);
    composer.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'b', bubbles: true }));
    assert.equal(capturedKeys, 1);
  } finally { dom.window.close(); }
});

test('filename editing keeps clipboard, input, and composition events local without canceling native editing', async () => {
  const { dom, window, shadow, collect } = downloadPanelEnvironment();
  try {
    await collect();
    const input = shadow.querySelector('iframe').contentDocument.querySelector('#chat-export-filename');
    const events = ['keydown', 'keypress', 'keyup', 'beforeinput', 'input', 'copy', 'cut', 'paste', 'compositionstart', 'compositionupdate', 'compositionend', 'pointerdown'];
    const escapedEvents = [];
    for (const type of events) {
      window.document.addEventListener(type, () => escapedEvents.push(type), true);
      const event = new window.Event(type, { bubbles: true, composed: true, cancelable: true });
      assert.equal(input.dispatchEvent(event), true);
      assert.equal(event.defaultPrevented, false);
    }
    assert.deepEqual(escapedEvents, []);
  } finally { dom.window.close(); }
});

function persistentScrollEnvironment(count = 40) {
  const env = environment('<div id="scroller" style="overflow-y:auto"></div>');
  const scroller = env.window.document.getElementById('scroller');
  scroller.innerHTML = Array.from({ length: count }, (_, i) => message(String(i), `Content ${i}`)).join('');
  let top = Math.min(1200, count * 100 - 500);
  const positions = [];
  const layout = { extraHeight: 0, onScroll: null };
  Object.defineProperties(scroller, {
    clientHeight: { get: () => 500 }, scrollHeight: { get: () => count * 100 + layout.extraHeight },
    scrollTop: { get: () => top, set: value => { top = Math.max(0, Math.min(count * 100 + layout.extraHeight - 500, value)); positions.push(top); layout.onScroll?.(top); } }
  });
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 500, width: 700, height: 500 });
  for (const node of scroller.children) {
    const index = Number(node.getAttribute('data-message-id'));
    node.getBoundingClientRect = () => ({ top: index * 100 - top, bottom: (index + 1) * 100 - top, width: 700, height: 100 });
  }
  return { ...env, scroller, positions, layout };
}

test('unchanged message bodies are converted once despite repeated viewport captures', async () => {
  const { dom, app, scroller } = persistentScrollEnvironment();
  try {
    const data = await new app.Collector({ settleMs: 0 }).collect({ mode: 'scroll' });
    assert.equal(data.messages.length, 40);
    assert.equal(data.collection.metrics.conversions, 40);
    assert.ok(data.collection.metrics.cacheHits > 40);
    assert.equal(data.collection.metrics.resumeJumps, 1);
    assert.equal(scroller.scrollTop, 1200);
    assert.deepEqual(plain(data.messages.map(m => m.text)), Array.from({ length: 40 }, (_, i) => `Content ${i}`));
  } finally { dom.window.close(); }
});

test('same-length text edits and link changes invalidate cached bodies', async () => {
  const { dom, app, scroller } = persistentScrollEnvironment(12);
  try {
    const node = scroller.children[3];
    node.innerHTML = '<p>before</p><a href="https://example.com/old">Link</a>';
    let edited = false;
    const collector = new app.Collector({ settleMs: 0, onUpdate: progress => {
      if (progress.phase !== 'up' || edited) return;
      edited = true;
      node.querySelector('p').firstChild.data = 'after!';
      node.querySelector('a').setAttribute('href', 'https://example.com/new');
    } });
    const data = await collector.collect({ mode: 'scroll' });
    const changed = data.messages.find(m => m.id === 'user:3');
    assert.ok(changed.markdown.includes('after!'));
    assert.ok(changed.markdown.includes('https://example.com/new'));
    assert.ok(!changed.markdown.includes('https://example.com/old'));
    assert.equal(data.collection.metrics.conversions, 13);
    assert.equal(collector.observer, null);
  } finally { dom.window.close(); }
});

test('a recreated message node with the same ID is re-read rather than blindly using its old body', async () => {
  const { dom, app, scroller } = persistentScrollEnvironment(12);
  try {
    let replaced = false;
    const data = await new app.Collector({ settleMs: 0, onUpdate: progress => {
      if (progress.phase !== 'up' || replaced) return;
      replaced = true;
      scroller.children[3].outerHTML = message('3', 'Updated body');
    } }).collect({ mode: 'scroll' });
    assert.equal(data.messages.find(m => m.id === 'user:3').text, 'Updated body');
    assert.equal(data.messages.length, 12);
    assert.equal(data.collection.metrics.conversions, 13);
  } finally { dom.window.close(); }
});

function delayedScrollEnvironment({ delay = 65, placeholders = true, mismatch = false } = {}) {
  const env = environment('<div id="scroller" style="overflow-y:auto"></div>');
  const scroller = env.window.document.getElementById('scroller');
  let top = 1200;
  let timer;
  let wasAtTop = false;
  let mismatched = false;
  const render = hydrated => {
    let first = Math.floor(top / 500);
    let last = Math.min(5, Math.floor((top + 499) / 500));
    if (mismatch && wasAtTop && top === 1200 && !mismatched) {
      mismatched = true;
      first = last = 5;
    }
    scroller.innerHTML = !hydrated && !placeholders ? '' : Array.from({ length: last - first + 1 }, (_, i) =>
      message(String(first + i), hydrated ? `Content ${first + i}` : '')).join('');
    for (const node of scroller.children) {
      const index = Number(node.getAttribute('data-message-id'));
      node.getBoundingClientRect = () => ({ top: index * 500 - top, bottom: (index + 1) * 500 - top, width: 700, height: 500 });
    }
  };
  Object.defineProperties(scroller, {
    clientHeight: { get: () => 500 }, scrollHeight: { get: () => 3000 },
    scrollTop: { get: () => top, set: value => {
      const next = Math.max(0, Math.min(2500, value));
      if (next === top) return;
      env.window.clearTimeout(timer);
      if (top === 0) wasAtTop = true;
      top = next;
      render(delay === 0);
      if (delay) timer = env.window.setTimeout(() => render(true), delay);
    } }
  });
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 500, width: 700, height: 500 });
  render(true);
  return { ...env, scroller };
}

for (const placeholders of [true, false]) {
  test(`adaptive waits retain asynchronously hydrated messages (placeholders: ${placeholders})`, async () => {
    const { dom, app, scroller } = delayedScrollEnvironment({ placeholders });
    try {
      const data = await new app.Collector({ settleMs: 25, minWaitMs: 5, quietMs: 5, hydrationTimeoutMs: 250 }).collect({ mode: 'scroll' });
      assert.deepEqual(plain(data.messages.map(m => m.text)), Array.from({ length: 6 }, (_, i) => `Content ${i}`));
      assert.equal(data.collection.stopReason, 'scroll-boundaries-observed');
      assert.equal(data.collection.metrics.waitLimitHits, 0);
      assert.equal(scroller.scrollTop, 1200);
    } finally { dom.window.close(); }
  });
}

test('an unverified resume snapshot falls back without inserting speculative messages out of order', async () => {
  const { dom, app } = delayedScrollEnvironment({ delay: 0, mismatch: true });
  try {
    const data = await new app.Collector({ settleMs: 0 }).collect({ mode: 'scroll' });
    assert.equal(data.collection.metrics.resumeJumps, 0);
    assert.deepEqual(plain(data.messages.map(m => m.text)), Array.from({ length: 6 }, (_, i) => `Content ${i}`));
  } finally { dom.window.close(); }
});

test('stopping during an adaptive rendering wait preserves data and disconnects the observer', async () => {
  const { dom, window, app } = delayedScrollEnvironment();
  try {
    const collector = new app.Collector({ settleMs: 25, hydrationTimeoutMs: 250 });
    window.setTimeout(() => collector.stop(), 15);
    const data = await collector.collect({ mode: 'scroll' });
    assert.equal(data.collection.stopReason, 'user-stopped');
    assert.ok(data.messages.length);
    assert.equal(collector.observer, null);
    assert.equal(collector.running, false);
  } finally { dom.window.close(); }
});

test('a changed document height disables the visited-region jump', async () => {
  const { dom, app, layout } = persistentScrollEnvironment(20);
  try {
    let expanded = false;
    const data = await new app.Collector({ settleMs: 0, onUpdate: progress => {
      if (progress.phase === 'up' && !expanded) {
        expanded = true;
        layout.extraHeight = 200;
      }
    } }).collect({ mode: 'scroll' });
    assert.equal(data.collection.metrics.resumeJumps, 0);
    assert.equal(data.messages.length, 20);
    assert.equal(data.collection.stopReason, 'scroll-boundaries-observed');
  } finally { dom.window.close(); }
});

test('a rendering timeout reports possible missing bodies rather than claiming completeness', async () => {
  const { dom, app, scroller } = persistentScrollEnvironment(8);
  try {
    scroller.lastElementChild.replaceChildren();
    const data = await new app.Collector({ settleMs: 10, minWaitMs: 2, quietMs: 2, hydrationTimeoutMs: 15 }).collect({ mode: 'scroll' });
    assert.equal(data.messages.length, 7);
    assert.ok(data.collection.metrics.waitLimitHits > 0);
    assert.ok(data.collection.warnings.some(w => w.includes('rendering wait limit')));
    assert.equal(data.completeness, 'unverified');
  } finally { dom.window.close(); }
});

test('navigation during rendering wait retains only the original conversation and stops observing', async () => {
  const { dom, window, app, scroller } = delayedScrollEnvironment();
  try {
    const collector = new app.Collector({ settleMs: 25, hydrationTimeoutMs: 250 });
    window.setTimeout(() => {
      dom.reconfigure({ url: 'https://chatgpt.com/c/another-conversation' });
      scroller.innerHTML = message('another', 'Do not collect this');
    }, 15);
    const data = await collector.collect({ mode: 'scroll' });
    assert.equal(data.collection.stopReason, 'conversation-changed');
    assert.equal(data.url, 'https://chatgpt.com/c/example');
    assert.ok(!data.messages.some(message => message.id === 'user:another'));
    assert.equal(collector.observer, null);
  } finally { dom.window.close(); }
});

test('height changes during the resume jump also force a conservative rescan', async () => {
  const { dom, app, layout } = persistentScrollEnvironment(20);
  try {
    let sawTop = false;
    let changed = false;
    layout.onScroll = top => {
      if (top === 0) sawTop = true;
      if (sawTop && top === 1200 && !changed) {
        changed = true;
        layout.extraHeight = 200;
      }
    };
    const data = await new app.Collector({ settleMs: 0 }).collect({ mode: 'scroll' });
    assert.equal(changed, true);
    assert.equal(data.collection.metrics.resumeJumps, 0);
    assert.equal(data.messages.length, 20);
    assert.equal(data.collection.stopReason, 'scroll-boundaries-observed');
  } finally { dom.window.close(); }
});
