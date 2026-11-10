# Chat Export

A Chrome Manifest V3 extension that saves the selected branch of the current ChatGPT conversation as **Markdown or JSON**.

## Installation

1. Download this repository, or extract `chat-export.zip` into a separate folder if you have a packaged copy.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode** in the upper-right corner.
4. Click **Load unpacked**.
5. Select the folder containing `manifest.json`.
6. Open a conversation at `https://chatgpt.com` and click **Chat Export** in the extensions menu.

The extension runs without Node.js or `npm install`.

## Updating an unpacked installation

1. Pull the latest changes or replace the unpacked files.
2. Open `chrome://extensions` and click **Reload** on **Chat Export**.
3. **Reload the ChatGPT conversation tab as well** to remove the previous injected collector.
4. Reopen the extension. The panel header should show **0.2.1**.

## Usage

- **Long conversation**: Collects messages while scrolling up from the current position, then scans down to the bottom. A boundary is considered observed after the scroll height, message count, and content length remain stable for three checks.
- **Messages already loaded on this page**: Collects only messages already present in the DOM. This may include messages outside the visible viewport.
- **Stop**: Ends collection and retains the messages captured so far.
- After collection, review the preview of the first four messages.
- The **File name** field is prefilled with the original automatic name: `chat-export-` followed by the sanitized conversation title. Leave it unchanged to keep that default, or enter your own name.
- Click **Save Markdown** or **Save JSON**. The selected format's `.md` or `.json` extension is added automatically. A custom name ending with either extension is adjusted to the selected format without duplicating the extension.
- The filename field runs in a local iframe so page-level keyboard shortcuts cannot redirect typing to the ChatGPT composer. Normal selection, clipboard shortcuts, and IME composition remain available. The iframe makes no network request and requires no additional permission.
- An empty or unusable custom name falls back to the original default. Filename characters that cannot be used in paths are replaced. Changing the filename does not change the conversation title inside the exported content.
- Closing the panel does not stop collection. Click the extension icon to reopen it.
- Keep the tab open and avoid navigating, scrolling, editing messages, or regenerating responses during collection.
- Collection is limited to 90 seconds and 240 scroll steps per direction. Partial results remain available when a limit is reached.
- If you remain in the same conversation, the original scroll position is restored after collection.
- If the conversation URL changes, collection stops before capturing content from the new conversation.
- Results are stored only in memory. Reloading or closing the tab clears them. If the panel remains after navigation, existing results are still exported with their original conversation URL and title.

## Troubleshooting message detection

The collector supports both legacy role attributes and newer ChatGPT search-unit, conversation-role, and user-bubble markers. It also handles turn-level roles without assuming that a turn is an `article`, and does not restrict detection to the first `main` element. Nested markers for the same message are deduplicated; grouped exchanges keep user and assistant messages separate. Conversation role headings and screen-reader turn labels outside message bodies are excluded without filtering matching words from actual messages.

If no messages are available immediately, collection waits up to four seconds for rendering. A failed collection is labeled **Collection failed**, with **Save diagnostics** available for troubleshooting. The diagnostic file contains only document readiness and marker counts, without message text, HTML, titles, URLs, or message identifiers. No diagnostics are sent automatically.

If an ordinary visible conversation still produces zero messages, first reload both the extension and the ChatGPT tab. If the problem persists, save the diagnostic file to help identify an unsupported layout.

## Export scope and limitations

**Finishing collection does not establish transcript completeness.** The extension cannot compare the DOM against the complete conversation stored on the server, so every export records `completeness: "unverified"`. Observing both scroll boundaries does not guarantee a complete transcript.

- Only rendered messages in the currently selected conversation branch are collected. Alternative regenerated responses and earlier edited branches are not explored.
- Server data that has not been rendered and hidden internal reasoning are not collected.
- Image descriptions and attachment names available through download links may be recorded. Original attachments are neither downloaded nor embedded.
- Markdown conversion handles headings, emphasis, links, code, lists, blockquotes, basic tables, and KaTeX formulas. Complex merged cells and specialized interfaces are not preserved exactly.
- Search-unit keys and message IDs are preferred. Conversation-turn or exchange attributes and DOM node identities are used as fallbacks. DOM node identities may produce duplicates when nodes are recreated; the export includes a warning when this fallback is used.
- Responses generated during collection may be incomplete. Collect again after generation finishes.
- Lazy loading, background-tab timer throttling, and ChatGPT interface changes may cause omissions.

The extension has not yet been tested directly against the current signed-in ChatGPT interface. Start with a short conversation and one containing code and tables, then compare the exports with the originals. If no messages are found, check the role and turn selectors in `collector.js` and the message-body selectors in `format.js`.

## Privacy and permissions

- No data is sent to external servers at runtime. The extension contains no analytics or tracking code.
- Only the `activeTab` and `scripting` permissions are used. Scripts are injected into the ChatGPT tab when you click the toolbar button.
- Cookies and authentication tokens are not read, and internal APIs are not called.
- Exports are saved as files on your device. They include conversation content and links appearing in that content.
- Conversation previews use `textContent` so message text is not executed as HTML.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | Manifest V3 configuration and permissions |
| `background.js` | Toolbar click handling, site validation, and script injection |
| `collector.js` | Message identification, ordering, scrolling, and interruption handling |
| `format.js` | Message extraction, Markdown conversion, and filename sanitization |
| `panel.js` | Shadow DOM panel, isolated iframe filename field, status, previews, and downloads |
| `tests/export.test.cjs` | Automated tests using DOM fixtures |
| `tests/browser-focus.cjs` | Chromium regression checks for filename focus, clipboard, IME, and downloads |

## Development checks

```sh
npm ci
npm run check
npm test
```

`jsdom` is used only for development tests. Tests cover legacy and grouped search-unit layouts, message discovery outside the first main element, initial rendering delays, DOM replacement during virtual scrolling, repeated-message preservation, code fences, tables, formulas, interruptions, limits, panel reopening, role-label exclusion with matching message-text preservation, editable download filenames with unchanged defaults, and safe text rendering. They do not exercise Chrome extension APIs or a signed-in ChatGPT session.


To run the native browser regression check, install Chromium once and run:

```sh
npx playwright install chromium
npm run test:browser
```

Playwright is a development dependency only. This check uses a local fixture served through intercepted requests and a CDP isolated world to model a content script. A parent-page capture listener deliberately steals composer focus if filename keystrokes escape. The check exercises native typing, selection, deletion, clipboard paste, IME composition, and a browser download; it also verifies that typing in the page composer still works. It does not access a signed-in ChatGPT account.
