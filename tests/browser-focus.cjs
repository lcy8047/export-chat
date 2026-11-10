const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1100 } });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://chatgpt.com' });
    const page = await context.newPage();
    await page.route('https://chatgpt.com/**', route => route.fulfill({
      contentType: 'text/html', body: `<!doctype html><title>Focus regression</title>
        <main><div data-content-search-unit-key="turn:0:user"><div data-user-message-bubble="true">A test conversation</div></div></main>
        <textarea id="composer" aria-label="Chat composer"></textarea>`
    }));
    await page.goto('https://chatgpt.com/c/focus-test');
    await page.evaluate(() => {
      window.capturedKeys = 0;
      window.capturedFieldEvents = [];
      // Capture listeners are installed before the extension, as on the real page.
      document.addEventListener('keydown', () => {
        window.capturedKeys++;
        document.querySelector('#composer').focus();
      }, true);
      for (const type of ['paste', 'copy', 'cut', 'compositionstart', 'compositionupdate', 'compositionend']) {
        document.addEventListener(type, () => window.capturedFieldEvents.push(type), true);
      }
    });
    // Use an isolated JS world like a Chrome content script, not page-world injection.
    const session = await context.newCDPSession(page);
    const { frameTree } = await session.send('Page.getFrameTree');
    const { executionContextId } = await session.send('Page.createIsolatedWorld', {
      frameId: frameTree.frame.id, worldName: 'chat-export-test'
    });
    async function evaluate(expression) {
      const response = await session.send('Runtime.evaluate', {
        expression, contextId: executionContextId, awaitPromise: true, returnByValue: true
      });
      if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
      return response.result.value;
    }
    await evaluate(`(() => {
      const original = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function(options) {
        const root = original.call(this, options);
        globalThis.testPanel = root;
        return root;
      };
    })()`);
    for (const name of ['format.js', 'collector.js', 'panel.js']) {
      await evaluate(fs.readFileSync(path.join(__dirname, '..', name), 'utf8'));
    }
    await evaluate(`(() => {
      testPanel.querySelector('select').value = 'loaded';
      Array.from(testPanel.querySelectorAll('button')).find(button => button.textContent === 'Start collection').click();
    })()`);
    assert.equal(await evaluate(`testPanel.querySelector('iframe').contentDocument.querySelector('input').value`), 'chat-export-Focus regression');
    async function clickFilename() {
      const position = await evaluate(`(() => {
        const frame = testPanel.querySelector('iframe');
        const input = frame.contentDocument.querySelector('input');
        frame.scrollIntoView({ block: 'center' });
        input.scrollIntoView({ block: 'center' });
        const outer = frame.getBoundingClientRect();
        const inner = input.getBoundingClientRect();
        return { x: outer.left + inner.left + inner.width / 2, y: outer.top + inner.top + inner.height / 2 };
      })()`);
      await page.mouse.click(position.x, position.y);
    }
    const value = () => evaluate(`testPanel.querySelector('iframe').contentDocument.querySelector('input').value`);
    await clickFilename();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('Research notes');
    await page.keyboard.press('Backspace');
    await page.keyboard.type('s');
    assert.equal(await value(), 'Research notes');
    assert.equal(await page.locator('#composer').inputValue(), '');
    assert.equal(await page.evaluate(() => window.capturedKeys), 0);
    console.log('PASS: native typing, selection, and deletion retain filename focus.');

    await page.evaluate(() => navigator.clipboard.writeText('Pasted notes'));
    await clickFilename();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.press('ControlOrMeta+V');
    assert.equal(await value(), 'Pasted notes');
    assert.deepEqual(await page.evaluate(() => window.capturedFieldEvents), []);
    console.log('PASS: native clipboard paste stays in the filename field.');

    await session.send('Input.imeSetComposition', { text: '\ud55c', selectionStart: 1, selectionEnd: 1 });
    await session.send('Input.imeSetComposition', { text: '\ud55c\uae00', selectionStart: 2, selectionEnd: 2 });
    await session.send('Input.insertText', { text: '\ud55c\uae00' });
    assert.equal(await value(), 'Pasted notes\ud55c\uae00');
    assert.deepEqual(await page.evaluate(() => window.capturedFieldEvents), []);
    console.log('PASS: IME composition stays in the filename field.');

    const downloadPromise = page.waitForEvent('download');
    await evaluate(`Array.from(testPanel.querySelectorAll('button')).find(button => button.textContent === 'Save Markdown').click()`);
    const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), 'Pasted notes\ud55c\uae00.md');
    console.log('PASS: the edited filename is used by a native browser download.');

    await page.locator('#composer').click();
    await page.keyboard.type('hello');
    assert.equal(await page.locator('#composer').inputValue(), 'hello');
    assert.ok(await page.evaluate(() => window.capturedKeys) > 0);
    console.log('PASS: normal page typing and shortcuts remain active outside the field.');
    await context.close();
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
