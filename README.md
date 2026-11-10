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

## Usage

- **Long conversation**: Collects messages while scrolling up from the current position, then scans down to the bottom. A boundary is considered observed after the scroll height, message count, and content length remain stable for three checks.
- **Messages already loaded on this page**: Collects only messages already present in the DOM. This may include messages outside the visible viewport.
- **Stop**: Ends collection and retains the messages captured so far.
- After collection, review the preview of the first four messages and click **Save Markdown** or **Save JSON**.
- Closing the panel does not stop collection. Click the extension icon to reopen it.
- Keep the tab open and avoid navigating, scrolling, editing messages, or regenerating responses during collection.
- Collection is limited to 90 seconds and 240 scroll steps per direction. Partial results remain available when a limit is reached.
- If you remain in the same conversation, the original scroll position is restored after collection.
- If the conversation URL changes, collection stops before capturing content from the new conversation.
- Results are stored only in memory. Reloading or closing the tab clears them. If the panel remains after navigation, existing results are still exported with their original conversation URL and title.

## Export scope and limitations

**Finishing collection does not establish transcript completeness.** The extension cannot compare the DOM against the complete conversation stored on the server, so every export records `completeness: "unverified"`. Observing both scroll boundaries does not guarantee a complete transcript.

- Only rendered messages in the currently selected conversation branch are collected. Alternative regenerated responses and earlier edited branches are not explored.
- Server data that has not been rendered and hidden internal reasoning are not collected.
- Image descriptions and attachment names available through download links may be recorded. Original attachments are neither downloaded nor embedded.
- Markdown conversion handles headings, emphasis, links, code, lists, blockquotes, basic tables, and KaTeX formulas. Complex merged cells and specialized interfaces are not preserved exactly.
- Message IDs are preferred. Conversation-turn attributes or DOM node identities are used as fallbacks. DOM node identities may produce duplicates when nodes are recreated; the export includes a warning when this fallback is used.
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
| `panel.js` | Isolated Shadow DOM panel, status, previews, and downloads |
| `tests/export.test.cjs` | Automated tests using DOM fixtures |

## Development checks

```sh
npm ci
npm run check
npm test
```

`jsdom` is used only for development tests. Tests cover DOM replacement during virtual scrolling, repeated-message preservation, code fences, tables, formulas, interruptions, limits, panel reopening, and safe text rendering. They do not exercise Chrome extension APIs or a signed-in ChatGPT session.
