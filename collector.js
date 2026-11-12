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

  function eligible(node, styleCache) {
    if (node.closest(EXCLUDED) || app.format.isRoleLabel(node)) return false;
    for (let parent = node; parent; parent = parent.parentElement) {
      let visible = styleCache.get(parent);
      if (visible === undefined) {
        const style = getComputedStyle(parent);
        visible = style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse";
        styleCache.set(parent, visible);
      }
      if (!visible) return false;
    }
    return true;
  }
  const STREAM_SELECTOR = '[data-testid="stop-button"],button[aria-label="Stop generating"],button[aria-label="\uc751\ub2f5 \uc0dd\uc131 \uc911\uc9c0"]';

  class Collector {
    constructor({ onUpdate = () => {}, settleMs = 650, minWaitMs = 80, quietMs = 80, hydrationTimeoutMs = 1800, initialWaitMs = 4000, maxDurationMs = 90000, maxSteps = 240 } = {}) {
      this.onUpdate = onUpdate;
      this.settleMs = settleMs;
      this.minWaitMs = Math.min(minWaitMs, settleMs);
      this.quietMs = Math.min(quietMs, settleMs);
      this.hydrationTimeoutMs = hydrationTimeoutMs;
      this.initialWaitMs = initialWaitMs;
      this.maxDurationMs = maxDurationMs;
      this.maxSteps = maxSteps;
      this.running = false;
      this.data = null;
    }
    nodes() {
      this.flushMutations();
      if (this.discoveryCache) return this.discoveryCache;
      const styles = new WeakMap();
      const candidates = Array.from(document.querySelectorAll(MESSAGE_SELECTOR))
        .filter(node => roleOf(node) && eligible(node, styles));
      const candidateSet = new Set(candidates);
      const roles = new Map(candidates.map(node => [node, roleOf(node)]));
      const units = new Set(candidates.filter(node => node.matches(UNIT_SELECTOR)));
      const unitParents = new Set();
      for (const unit of units) {
        for (let parent = unit.parentElement; parent; parent = parent.parentElement) {
          if (candidateSet.has(parent)) unitParents.add(parent);
        }
      }
      const messages = candidates.filter(node => {
        if (units.has(node)) return true;
        if (unitParents.has(node)) return false;
        for (let parent = node.parentElement; parent; parent = parent.parentElement) {
          if (units.has(parent)) return false;
        }
        return true;
      });
      const messageSet = new Set(messages);
      const mixedParents = new Set();
      for (const child of messages) {
        for (let parent = child.parentElement; parent; parent = parent.parentElement) {
          if (messageSet.has(parent) && roles.get(child) !== roles.get(parent)) mixedParents.add(parent);
        }
      }
      const singleRole = new Set(messages.filter(node => !mixedParents.has(node)));
      this.discoveryCache = messages.filter(node => {
        if (!singleRole.has(node)) return false;
        for (let parent = node.parentElement; parent; parent = parent.parentElement) {
          if (singleRole.has(parent) && roles.get(parent) === roles.get(node)) return false;
        }
        return true;
      });
      return this.discoveryCache;
    }
    identity(node, role, peerIndices) {
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
        return `${role}:turn:${key}:${peerIndices.get(node) || 0}`;
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
    flushMutations() {
      if (this.observer) this.processMutations(this.observer.takeRecords());
    }
    processMutations(records) {
      if (!records.length) return;
      this.discoveryCache = null;
      for (const record of records) {
        const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
        for (let node = target; node; node = node.parentElement) {
          const entry = this.nodeCache.get(node);
          if (entry) entry.dirty = true;
        }
        const changedMessage = target?.closest(MESSAGE_SELECTOR);
        const changedTree = record.type === "childList" && [...record.addedNodes, ...record.removedNodes]
          .some(node => node.nodeType === 1 && (node.matches(MESSAGE_SELECTOR) || node.querySelector(MESSAGE_SELECTOR)));
        if ((changedMessage && !target.closest(EXCLUDED)) || changedTree) {
          this.domVersion++;
          this.lastMutationAt = Date.now();
        }
      }
    }
    capture(direction, { notify = true, commit = true } = {}) {
      if (location.href !== this.url) return [];
      this.flushMutations();
      this.metrics.snapshots++;
      this.sawStreaming ||= Boolean(document.querySelector(STREAM_SELECTOR));
      const nodes = this.nodes();
      const peerIndices = new WeakMap();
      const groups = new Map();
      for (const node of nodes) {
        const turn = node.closest(TURN_SELECTOR);
        if (!turn) continue;
        if (!groups.has(turn)) groups.set(turn, new Map());
        const group = groups.get(turn);
        const role = roleOf(node);
        peerIndices.set(node, group.get(role) || 0);
        group.set(role, (group.get(role) || 0) + 1);
      }
      const batch = nodes.map(node => {
        const role = roleOf(node);
        const id = this.identity(node, role, peerIndices);
        const cached = this.nodeCache.get(node);
        if (cached && !cached.dirty && cached.message.id === id && cached.message.role === role) {
          this.metrics.cacheHits++;
          return cached.message;
        }
        const message = { id, role, ...app.format.fromElement(node, role, this.url) };
        this.metrics.conversions++;
        this.nodeCache.set(node, { message, dirty: false });
        return message;
      }).filter(message => this.hasContent(message));
      this.lastNodes = nodes;
      this.lastBatch = batch;
      if (!commit) return batch;
      for (const message of batch) {
        const previous = this.items.get(message.id);
        if (!previous || previous.text !== message.text || previous.markdown !== message.markdown ||
            JSON.stringify(previous.images) !== JSON.stringify(message.images) ||
            JSON.stringify(previous.attachments) !== JSON.stringify(message.attachments)) {
          this.contentRevision++;
          this.items.set(message.id, message);
        }
      }
      // Linked neighbours keep insertion and membership checks independent of transcript length.
      const nextKnown = new Array(batch.length);
      let next = null;
      for (let i = batch.length - 1; i >= 0; i--) {
        nextKnown[i] = next;
        if (this.links.has(batch[i].id)) next = batch[i].id;
      }
      let previous = null;
      for (let i = 0; i < batch.length; i++) {
        const id = batch[i].id;
        if (!this.links.has(id)) {
          let before = nextKnown[i];
          let after = previous;
          if (!after && !before) {
            if (this.links.size) this.unanchoredOrder = true;
            if (direction === "up") before = this.head;
            else after = this.tail;
          }
          if (after) before = this.links.get(after).next;
          else if (before) after = this.links.get(before).previous;
          this.links.set(id, { previous: after, next: before });
          if (after) this.links.get(after).next = id;
          else this.head = id;
          if (before) this.links.get(before).previous = id;
          else this.tail = id;
        }
        previous = id;
      }
      if (notify) this.notify(direction === "up" ? "up" : "down");
      return batch;
    }
    hasContent(message) {
      return Boolean(message && (message.text || message.markdown || message.images.length || message.attachments.length));
    }
    orderedMessages() {
      const result = [];
      for (let id = this.head; id !== null; id = this.links.get(id).next) result.push(this.items.get(id));
      return result;
    }
    viewportBounds(scroller) {
      if (scroller === document.scrollingElement || scroller === document.documentElement) {
        return { top: 0, bottom: innerHeight || scroller.clientHeight };
      }
      const top = scroller.getBoundingClientRect().top + scroller.clientTop;
      return { top, bottom: top + scroller.clientHeight };
    }
    visibleSnapshotIds(scroller) {
      const viewport = this.viewportBounds(scroller);
      let measured = false;
      const ids = new Set();
      for (const node of this.lastNodes) {
        const rect = node.getBoundingClientRect();
        const geometry = rect.width > 0 || rect.height > 0;
        measured ||= geometry;
        if (geometry && rect.bottom > viewport.top && rect.top < viewport.bottom) {
          const message = this.nodeCache.get(node)?.message;
          if (this.hasContent(message)) ids.add(message.id);
        }
      }
      return measured ? ids : new Set(this.lastBatch.map(message => message.id));
    }
    viewportReady(scroller) {
      const viewport = this.viewportBounds(scroller);
      let measured = false;
      let visible = 0;
      let pending = 0;
      for (const node of this.lastNodes) {
        const rect = node.getBoundingClientRect();
        const geometry = rect.width > 0 || rect.height > 0;
        measured ||= geometry;
        if (geometry && (rect.bottom <= viewport.top || rect.top >= viewport.bottom)) continue;
        const message = this.nodeCache.get(node)?.message;
        // Label-only units are chrome; empty visible turn shells need hydration.
        if (!this.hasContent(message) && node.textContent.trim()) continue;
        visible++;
        if (!this.hasContent(message)) pending++;
      }
      if (measured && !visible) return false;
      return visible > 0 && pending === 0;
    }
    async wait(scroller, direction, { boundary = false, commit = true } = {}) {
      const started = Date.now();
      const minimum = boundary ? this.settleMs : this.minWaitMs;
      const maximum = Math.max(minimum, this.hydrationTimeoutMs);
      let checkedVersion = -1;
      let ready = false;
      while (!this.interruption()) {
        this.flushMutations();
        if (checkedVersion !== this.domVersion) {
          this.capture(direction, { notify: false, commit });
          checkedVersion = this.domVersion;
          ready = this.viewportReady(scroller);
        }
        if (this.settleMs === 0) return true;
        const now = Date.now();
        if (ready && now - started >= minimum && now - this.lastMutationAt >= this.quietMs) return true;
        if (now - started >= maximum) {
          this.metrics.waitLimitHits++;
          return false;
        }
        await new Promise(resolve => setTimeout(resolve, Math.min(40, Math.max(1, maximum - (now - started)))));
      }
      return false;
    }
    atBoundary(scroller, direction) {
      return direction === "up" ? scroller.scrollTop <= 2
        : scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 3;
    }
    async sweep(scroller, direction) {
      let stable = 0;
      this.capture(direction, { notify: false });
      for (let step = 0; step < this.maxSteps; step++) {
        if (this.interruption()) return this.interruption();
        const beforeHeight = scroller.scrollHeight;
        const beforeCount = this.items.size;
        const beforeRevision = this.contentRevision;
        const distance = Math.max(200, scroller.clientHeight * 0.65);
        scroller.scrollTop += direction === "up" ? -distance : distance;
        this.metrics.scrollSteps++;
        this.discoveryCache = null;
        const boundary = this.atBoundary(scroller, direction);
        await this.wait(scroller, direction, { boundary });
        if (this.interruption()) return this.interruption();
        this.notify(direction);
        const unchanged = beforeHeight === scroller.scrollHeight && beforeCount === this.items.size && beforeRevision === this.contentRevision;
        stable = this.atBoundary(scroller, direction) && unchanged ? stable + 1 : 0;
        if (stable >= 3) return "boundary-observed";
      }
      return "step-limit";
    }
    async resume(scroller, originalTop, originalHeight, originalIds) {
      if (!originalTop || scroller.scrollHeight !== originalHeight || this.interruption()) return;
      // Only skip a visited region if the restored snapshot overlaps the original one.
      scroller.scrollTop = originalTop;
      this.discoveryCache = null;
      const ready = await this.wait(scroller, "down", { commit: false });
      if (!this.interruption() && scroller.scrollHeight === originalHeight && ready &&
          Array.from(this.visibleSnapshotIds(scroller)).some(id => originalIds.has(id))) {
        this.metrics.resumeJumps++;
        this.capture("down", { notify: false });
        return;
      }
      if (this.interruption()) return;
      scroller.scrollTop = 0;
      this.discoveryCache = null;
      await this.wait(scroller, "up");
    }
    async collect({ mode = "scroll" } = {}) {
      if (this.running) throw new Error("Collection is already in progress.");
      if (!["scroll", "loaded"].includes(mode)) throw new Error("Unsupported collection mode.");
      this.running = true;
      this.stopped = false;
      this.data = null;
      this.items = new Map();
      this.links = new Map();
      this.head = this.tail = null;
      this.nodeCache = new WeakMap();
      this.discoveryCache = null;
      this.lastNodes = [];
      this.lastBatch = [];
      this.domVersion = this.contentRevision = 0;
      this.startedAt = this.lastMutationAt = Date.now();
      this.metrics = { snapshots: 0, conversions: 0, cacheHits: 0, scrollSteps: 0, resumeJumps: 0, waitLimitHits: 0 };
      this.observer = new MutationObserver(records => this.processMutations(records));
      this.observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
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
          const originalHeight = scroller.scrollHeight;
          if (this.maxSteps > 0) await this.wait(scroller, "down");
          const originalIds = this.visibleSnapshotIds(scroller);
          const up = await this.sweep(scroller, "up");
          if (up === "boundary-observed") {
            await this.resume(scroller, originalTop, originalHeight, originalIds);
            reason = await this.sweep(scroller, "down");
          } else reason = up;
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
        if (this.metrics.waitLimitHits) warnings.push("Some message bodies did not settle before the rendering wait limit. They may be incomplete or missing.");
        if (failure) warnings.push(failure);
        this.data = {
          schemaVersion: 1, title: this.title, url: this.url,
          exportedAt: new Date().toISOString(), scope: "current-branch", completeness: "unverified",
          collection: { mode, stopReason: reason, warnings,
            metrics: { ...this.metrics, elapsedMs: Date.now() - this.startedAt },
            ...(reason === "error" ? { diagnostics: this.diagnostics() } : {}) },
          messages: this.orderedMessages()
        };
        this.observer.disconnect();
        this.observer = null;
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
