const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.join(__dirname, '..');
const baseline = process.argv[2];

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const virtualized of [false, true]) {
      const results = [];
      for (const [label, filename] of [...(baseline ? [['baseline', path.resolve(baseline)]] : []), ['current', path.join(root, 'collector.js')]]) {
        const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
        await page.route('https://chatgpt.com/**', route => route.fulfill({
          contentType: 'text/html', body: `<!doctype html><title>Collector benchmark</title>
            <style>#scroller{height:600px;width:760px;overflow-y:auto;overflow-anchor:none}article{height:120px;box-sizing:border-box;overflow:hidden}p{margin:0}pre{margin:0}</style>
            <main><div id="scroller"></div></main>`
        }));
        await page.goto('https://chatgpt.com/c/benchmark');
        await page.evaluate(virtualized => {
          const scroller = document.querySelector('#scroller');
          for (let index = 0; index < 40; index++) {
            const node = document.createElement('article');
            node.dataset.messageId = String(index);
            node.dataset.messageAuthorRole = index % 2 ? 'assistant' : 'user';
            node.dataset.index = String(index);
            scroller.append(node);
          }
          const body = index => `<div class="markdown"><p>Message ${index}: a repeatable conversation fixture.</p><pre><code class="language-js">const index = ${index};</code></pre></div>`;
          const render = () => {
            const first = Math.max(0, Math.floor(scroller.scrollTop / 120) - 1);
            const last = Math.min(39, Math.ceil((scroller.scrollTop + scroller.clientHeight) / 120));
            for (const node of scroller.children) {
              const index = Number(node.dataset.index);
              const hydrate = !virtualized || (index >= first && index <= last);
              if (hydrate && !node.firstChild) node.innerHTML = body(index);
              if (!hydrate && node.firstChild) node.replaceChildren();
            }
          };
          scroller.scrollTop = 2100;
          render();
          if (virtualized) scroller.addEventListener('scroll', render);
        }, virtualized);
        await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'format.js'), 'utf8') });
        await page.addScriptTag({ content: fs.readFileSync(filename, 'utf8') });
        const result = await page.evaluate(async () => {
          const app = globalThis.__chatExportV1;
          let conversions = 0;
          const original = app.format;
          app.format = { ...original, fromElement(...args) { conversions++; return original.fromElement(...args); } };
          const start = performance.now();
          const data = await new app.Collector().collect({ mode: 'scroll' });
          return { elapsedMs: Math.round(performance.now() - start), conversions,
            stopReason: data.collection.stopReason, metrics: data.collection.metrics,
            messages: data.messages.map(({ id, role, text, markdown }) => ({ id, role, text, markdown })) };
        });
        assert.equal(result.stopReason, 'scroll-boundaries-observed');
        assert.equal(result.messages.length, 40);
        assert.deepEqual(result.messages.map(message => Number(message.id.split(':').at(-1))), Array.from({ length: 40 }, (_, i) => i));
        results.push({ label, ...result });
        console.log(JSON.stringify({ fixture: virtualized ? 'virtualized' : 'fully-loaded', label,
          elapsedMs: result.elapsedMs, conversions: result.conversions, messages: result.messages.length,
          ...(result.metrics ? { metrics: result.metrics } : {}) }));
        await page.close();
      }
      if (baseline) {
        assert.deepEqual(results[0].messages, results[1].messages);
        console.log(JSON.stringify({ fixture: virtualized ? 'virtualized' : 'fully-loaded', identicalMessages: true,
          speedup: Number((results[0].elapsedMs / results[1].elapsedMs).toFixed(2)) }));
      }
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
