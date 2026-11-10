(() => {
  const app = globalThis.__chatExportV1 ||= {};
  if (app.Collector) return;
  const ROLE_SELECTOR = "[data-message-author-role]";
  const STREAM_SELECTOR = '[data-testid="stop-button"],button[aria-label="Stop generating"],button[aria-label="\uc751\ub2f5 \uc0dd\uc131 \uc911\uc9c0"]';

  class Collector {
    constructor({ onUpdate = () => {}, settleMs = 650, maxDurationMs = 90000, maxSteps = 240 } = {}) {
      this.onUpdate = onUpdate;
      this.settleMs = settleMs;
      this.maxDurationMs = maxDurationMs;
      this.maxSteps = maxSteps;
      this.running = false;
      this.data = null;
    }
    nodes() {
      const root = document.querySelector("main") || document.body;
      return Array.from(root.querySelectorAll(ROLE_SELECTOR))
        .filter(node => !node.closest('[hidden],[aria-hidden="true"]'));
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
      const batch = this.nodes().map(node => {
        const role = node.getAttribute("data-message-author-role") || "unknown";
        let id = node.getAttribute("data-message-id");
        if (id) id = `${role}:${id}`;
        const turn = node.closest('[data-testid^="conversation-turn-"]');
        if (!id && turn) {
          const peers = Array.from(turn.querySelectorAll(ROLE_SELECTOR));
          id = `${turn.getAttribute("data-testid")}:${role}:${peers.indexOf(node)}`;
        }
        if (!id) {
          this.weakIdentity = true;
          if (!this.fallbackIds.has(node)) this.fallbackIds.set(node, `local-${++this.fallbackCounter}`);
          id = this.fallbackIds.get(node);
        }
        return { id, role, ...app.format.fromElement(node, role, this.url) };
      });
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
      const scroller = this.findScroller(this.nodes()[0]);
      const originalTop = scroller.scrollTop;
      const oldBehavior = scroller.style.getPropertyValue("scroll-behavior");
      const oldPriority = scroller.style.getPropertyPriority("scroll-behavior");
      let reason = "loaded-only";
      let failure = "";
      try {
        if (!this.capture("down").length) {
          throw new Error("No messages found. Open a conversation and try again. The page structure may have changed.");
        }
        if (mode === "scroll") {
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
          collection: { mode, stopReason: reason, warnings },
          messages: this.order.map(id => this.items.get(id))
        };
        this.running = false;
        if (mode === "scroll") {
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
