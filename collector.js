(() => {
  const app = globalThis.__chatExportV1 ||= {};
  if (app.Collector) return;
  const UNIT_ATTRIBUTES = ["data-content-search-unit-key", "data-chatgpt-search-unit-key"];
  const UNIT_SELECTOR = UNIT_ATTRIBUTES.map(name => `[${name}]`).join(",");
  const TURN_SELECTOR = '[data-turn-id],[data-testid^="conversation-turn-"],[data-turn-key],[data-content-search-turn-key]';
  const MESSAGE_SELECTOR = [
    "[data-message-author-role]", "[data-conversation-role]", UNIT_SELECTOR,
    '[data-user-message-bubble="true"]', '[data-turn="user"]', '[data-turn="assistant"]'
  ].join(",");
  const EXCLUDED = 'nav,aside,form,[role="navigation"],[role="dialog"],[contenteditable="true"],[hidden],[aria-hidden="true"]';
  const ROLES = new Set(["user", "assistant", "system", "developer", "tool"]);

  function roleOf(node) {
    for (const name of ["data-message-author-role", "data-conversation-role", "data-turn"]) {
      const role = node.getAttribute(name);
      if (ROLES.has(role)) return role;
    }
    for (const name of UNIT_ATTRIBUTES) {
      const role = node.getAttribute(name)?.split(":").at(-1);
      if (role === "user" || role === "assistant") return role;
    }
    return node.getAttribute("data-user-message-bubble") === "true" ? "user" : "";
  }

  function eligible(node) {
    if (node.closest(EXCLUDED)) return false;
    for (let parent = node; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
    }
    return true;
  }
  const STREAM_SELECTOR = '[data-testid="stop-button"],button[aria-label="Stop generating"],button[aria-label="\uc751\ub2f5 \uc0dd\uc131 \uc911\uc9c0"]';

  class Collector {
    constructor({ onUpdate = () => {}, settleMs = 650, initialWaitMs = 4000, maxDurationMs = 90000, maxSteps = 240 } = {}) {
      this.onUpdate = onUpdate;
      this.settleMs = settleMs;
      this.initialWaitMs = initialWaitMs;
      this.maxDurationMs = maxDurationMs;
      this.maxSteps = maxSteps;
      this.running = false;
      this.data = null;
    }
    nodes() {
      // New ChatGPT exchanges group both roles under one data-turn-key.
      // Search units identify individual messages; the exchange is not a message.
      const candidates = Array.from(document.querySelectorAll(MESSAGE_SELECTOR))
        .filter(node => roleOf(node) && eligible(node));
      const units = candidates.filter(node => node.matches(UNIT_SELECTOR));
      const messages = candidates.filter(node => node.matches(UNIT_SELECTOR) ||
        !units.some(unit => node.contains(unit) || unit.contains(node)));
      const singleRole = messages.filter(node => !messages.some(child =>
        child !== node && node.contains(child) && roleOf(child) !== roleOf(node)));
      return singleRole.filter(node => !singleRole.some(parent =>
        parent !== node && parent.contains(node) && roleOf(parent) === roleOf(node)));
    }
    identity(node, role, peers) {
      const unit = node.closest(UNIT_SELECTOR) || Array.from(node.querySelectorAll(UNIT_SELECTOR))
        .find(child => roleOf(child) === role);
      if (unit) {
        for (const name of UNIT_ATTRIBUTES) {
          const key = unit.getAttribute(name);
          if (key && roleOf(unit) === role) return `${role}:unit:${key}`;
        }
      }
      const messageId = node.getAttribute("data-message-id") || node.querySelector("[data-message-id]")?.getAttribute("data-message-id");
      if (messageId) return `${role}:${messageId}`;
      const turn = node.closest(TURN_SELECTOR);
      if (turn) {
        const key = ["data-turn-id", "data-testid", "data-turn-key", "data-content-search-turn-key"]
          .map(name => turn.getAttribute(name)).find(Boolean);
        const siblings = peers.filter(peer => roleOf(peer) === role && peer.closest(TURN_SELECTOR) === turn);
        return `${role}:turn:${key}:${siblings.indexOf(node)}`;
      }
      this.weakIdentity = true;
      if (!this.fallbackIds.has(node)) this.fallbackIds.set(node, `local-${++this.fallbackCounter}`);
      return this.fallbackIds.get(node);
    }
    diagnostics() {
      // Counts only: never include message text, HTML, URLs, titles, or identifiers.
      const count = selector => document.querySelectorAll(selector).length;
      return {
        documentState: document.readyState,
        legacyRoles: count("[data-message-author-role]"),
        conversationRoles: count("[data-conversation-role]"),
        searchUnits: count(UNIT_SELECTOR),
        turns: count('[data-turn="user"],[data-turn="assistant"]'),
        exchanges: count("[data-turn-key],[data-content-search-turn-key]"),
        userBubbles: count('[data-user-message-bubble="true"]'),
        selectedMessages: this.nodes().length
      };
    }
    findScroller(node) {
      for (let parent = node?.parentElement; parent; parent = parent.parentElement) {
        if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY) &&
            parent.scrollHeight > parent.clientHeight + 10) return parent;
      }
      return document.scrollingElement || document.documentElement;
    }
    notify(phase) {
      this.onUpdate({ phase, count: this.items.size, running: this.running });
    }
    stop() { this.stopped = true; }
    interruption() {
      if (location.href !== this.url) return "conversation-changed";
      if (this.stopped) return "user-stopped";
      if (Date.now() >= this.deadline) return "time-limit";
      return "";
    }
    capture(direction) {
      if (location.href !== this.url) return [];
      this.sawStreaming ||= Boolean(document.querySelector(STREAM_SELECTOR));
      const nodes = this.nodes();
      const batch = nodes.map(node => {
        const role = roleOf(node);
        return { id: this.identity(node, role, nodes), role, ...app.format.fromElement(node, role, this.url) };
      }).filter(message => message.text || message.markdown || message.images.length || message.attachments.length);
      // Merge overlapping viewport snapshots by message identity, not by text.
      // Identical questions in distinct turns must remain distinct messages.
      for (let i = 0; i < batch.length; i++) {
        const message = batch[i];
        this.items.set(message.id, message);
        if (this.order.includes(message.id)) continue;
        const previous = i ? this.order.indexOf(batch[i - 1].id) : -1;
        const next = batch.slice(i + 1).map(item => this.order.indexOf(item.id)).find(index => index >= 0);
        if (previous < 0 && next === undefined && this.order.length) this.unanchoredOrder = true;
        const position = previous >= 0 ? previous + 1 : next !== undefined ? next
          : direction === "up" ? i : this.order.length;
        this.order.splice(position, 0, message.id);
      }
      this.notify(direction === "up" ? "up" : "down");
      return batch;
    }
    async wait() {
      // Interruptible waits also notice an SPA conversation change while the tab is open.
      const until = Date.now() + this.settleMs;
      while (Date.now() < until && !this.interruption()) {
        await new Promise(resolve => setTimeout(resolve, Math.min(100, until - Date.now())));
      }
    }
    async sweep(scroller, direction) {
      let stable = 0;
      for (let step = 0; step < this.maxSteps; step++) {
        if (this.interruption()) return this.interruption();
        this.capture(direction);
        const beforeHeight = scroller.scrollHeight;
        const beforeCount = this.items.size;
        const beforeText = this.totalTextLength();
        const distance = Math.max(200, scroller.clientHeight * 0.65);
        scroller.scrollTop += direction === "up" ? -distance : distance;
        await this.wait();
        if (this.interruption()) return this.interruption();
        this.capture(direction);
        const atBoundary = direction === "up" ? scroller.scrollTop <= 2
          : scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 3;
        stable = atBoundary && beforeHeight === scroller.scrollHeight &&
          beforeCount === this.items.size && beforeText === this.totalTextLength() ? stable + 1 : 0;
        if (stable >= 3) return "boundary-observed";
      }
      return "step-limit";
    }
    totalTextLength() {
      let length = 0;
      for (const message of this.items.values()) length += message.markdown.length;
      return length;
    }
    async collect({ mode = "scroll" } = {}) {
      if (this.running) throw new Error("Collection is already in progress.");
      if (!["scroll", "loaded"].includes(mode)) throw new Error("Unsupported collection mode.");
      this.running = true;
      this.stopped = false;
      this.data = null;
      this.items = new Map();
      this.order = [];
      this.fallbackIds = new WeakMap();
      this.fallbackCounter = 0;
      this.weakIdentity = this.unanchoredOrder = this.sawStreaming = false;
      this.url = location.href;
      this.title = document.title || "ChatGPT conversation";
      this.deadline = Date.now() + this.maxDurationMs;
      let scroller = null;
      let originalTop = 0;
      let oldBehavior = "";
      let oldPriority = "";
      let reason = "loaded-only";
      let failure = "";
      try {
        const readyDeadline = Date.now() + this.initialWaitMs;
        let initial = this.capture("down");
        while (!initial.length && !this.interruption() && Date.now() < readyDeadline) {
          this.notify("waiting");
          await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(0, readyDeadline - Date.now()))));
          if (!this.interruption()) initial = this.capture("down");
        }
        if (!initial.length && !this.interruption()) {
          throw new Error("No messages found after waiting for the page. Reload ChatGPT and try again. If this persists, save diagnostics from this panel.");
        }
        if (this.interruption()) reason = this.interruption();
        else if (mode === "scroll") {
          scroller = this.findScroller(this.nodes()[0]);
          originalTop = scroller.scrollTop;
          oldBehavior = scroller.style.getPropertyValue("scroll-behavior");
          oldPriority = scroller.style.getPropertyPriority("scroll-behavior");
          scroller.style.setProperty("scroll-behavior", "auto", "important");
          const up = await this.sweep(scroller, "up");
          reason = up === "boundary-observed" ? await this.sweep(scroller, "down") : up;
          if (reason === "boundary-observed") reason = "scroll-boundaries-observed";
        }
      } catch (error) {
        reason = "error";
        failure = String(error.message || error);
      } finally {
        const warnings = [
          "Collected from the DOM. A complete conversation transcript cannot be guaranteed.",
          "Only the selected branch is included. Original attachments and alternative regenerated branches are excluded."
        ];
        if (this.weakIdentity) warnings.push("Some message IDs could not be identified. Recreated DOM nodes may produce duplicates.");
        if (this.unanchoredOrder) warnings.push("Some viewport snapshots had no overlapping messages. Their order was inferred from the scroll direction.");
        if (this.sawStreaming) warnings.push("Response generation was detected during collection. Collect again after generation finishes.");
        if (failure) warnings.push(failure);
        this.data = {
          schemaVersion: 1, title: this.title, url: this.url,
          exportedAt: new Date().toISOString(), scope: "current-branch", completeness: "unverified",
          collection: { mode, stopReason: reason, warnings, ...(reason === "error" ? { diagnostics: this.diagnostics() } : {}) },
          messages: this.order.map(id => this.items.get(id))
        };
        this.running = false;
        if (scroller) {
          if (location.href === this.url) scroller.scrollTop = originalTop;
          if (oldBehavior) scroller.style.setProperty("scroll-behavior", oldBehavior, oldPriority);
          else scroller.style.removeProperty("scroll-behavior");
        }
        this.notify("done");
      }
      return this.data;
    }
  }
  app.Collector = Collector;
})();
