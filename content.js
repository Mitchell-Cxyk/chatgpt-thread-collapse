(function () {
  "use strict";

  const EXTENSION_PREFIX = "cgpt-lite";
  const STORAGE_KEYS = {
    settings: "settings",
    sessionStates: "sessionStates"
  };

  const DEFAULT_SETTINGS = {
    enabled: true,
    keepRecentCount: 6,
    autoCollapseComplex: true,
    debugMode: false,
    nearbyExpandCount: 12,
    messageControlsSize: 100,
    messageControlsX: 0,
    messageControlsY: 0,
    messageControlsTopLimit: 8,
    globalControlsSize: 100,
    globalControlsRight: 18,
    globalControlsTop: 72
  };

  const DEFAULT_SESSION_STATE = {
    lockedExpanded: {},
    manualExpanded: {},
    collapsed: {},
    lastBulkCollapsedSnapshot: []
  };

  const FALLBACK_MESSAGES = {
    assistantMessage: "Assistant message",
    expand: "Expand",
    collapse: "Collapse",
    collapsedMessage: "Message collapsed",
    lock: "Lock",
    locked: "Locked",
    permanentExpand: "Always keep this message expanded",
    restoreDefaultFold: "Restore default fold",
    collapsedHint: "Old message lightened",
    complexCollapsed: "Complex content lightened",
    clickToRestore: "Click to restore",
    noFullNodeCached: "No full node cached",
    expandAllHeader: "Expand all",
    collapseAllHeader: "Collapse all",
    expandAllPerfHint: "Expanding all may briefly affect performance.",
    noCollapsedMessages: "There are no collapsed messages in the current thread.",
    noNearbyCollapsedMessages: "No collapsed messages were found near the current viewport.",
    sessionResetDone: "Current thread state has been reset.",
    noPreviousCollapsedView: "There is no previous collapsed view to restore.",
    restoredPreviousCollapsedView: "Restored the previous collapsed view.",
    recollapsedOldMessages: "Re-applied the current collapse strategy to old messages.",
    collapseAllToast: "Collapsed {0} messages.",
    expandNearbyToast: "Restored {0} messages near the viewport.",
    expandAllToast: "Restored {0} messages. You can revert with the previous collapsed view.",
    currentSummary: "assistant messages: {0}, collapsed: {1}, near viewport: {2}{3}.",
    unableReadPageState: "Unable to read the current page state.",
    noChatgptConversation: "No manageable ChatGPT conversation was detected in the current tab.",
    restorePreviousCollapsed: "Restore previous collapsed view",
    settingsSaved: "Settings saved.",
    settingsAutoSave: "Settings are saved automatically.",
    expandNearby: "Expand nearby messages",
    expandAll: "Expand all collapsed messages in this thread",
    recollapseOld: "Re-collapse old messages in this thread",
    resetSession: "Reset current thread state"
  };

  function t(key, substitutions = []) {
    const localized = chrome.i18n.getMessage(key, substitutions);
    if (localized) {
      return localized;
    }
    let fallback = FALLBACK_MESSAGES[key] || key;
    substitutions.forEach((value, index) => {
      fallback = fallback.replace(new RegExp(`\\{${index}\\}`, "g"), String(value));
    });
    return fallback;
  }

  /*
   * All page-structure selectors stay here.
   * Keep them shallow and resilient; avoid deep utility classes.
   * Primary selectors target current ChatGPT conversation turns.
   * Fallback selectors cover older chat.openai.com layouts or future markup shifts.
   */
  const SELECTORS = {
    roots: {
      main: [
        "main",
        "[role='main']"
      ],
      conversation: [
        "main",
        "[data-testid='conversation-panel']",
        "[data-testid='conversation-panel-content']",
        ".overflow-y-auto"
      ]
    },
    header: {
      anchors: [
        "main header",
        "header",
        "[data-testid='conversation-header']",
        "[class*='sticky'][class*='top']"
      ]
    },
    messages: {
      primaryTurnCandidates: [
        "article[data-testid^='conversation-turn-']",
        "[data-testid^='conversation-turn-']"
      ],
      assistantHints: [
        "[data-message-author-role='assistant']",
        "[data-testid*='assistant']",
        "[aria-label*='Assistant']",
        "[alt='ChatGPT']",
        "svg title"
      ],
      userHints: [
        "[data-message-author-role='user']",
        "[data-testid*='user']",
        "[aria-label*='You']"
      ],
      contentHints: [
        ".markdown",
        "[data-message-id]",
        "pre",
        "code",
        "table",
        "p"
      ]
    },
    complexContent: {
      code: ["pre", "code"],
      math: ["mjx-container", ".katex", "[data-testid*='math']"],
      table: ["table"],
      list: ["ul", "ol"],
      quote: ["blockquote"]
    }
  };

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    sessionKey: "",
    sessionState: cloneSessionState(DEFAULT_SESSION_STATE),
    messageRecords: new Map(),
    collapsedNodes: new Map(),
    messageControls: new Map(),
    controlsLayer: null,
    controlMessages: [],
    controlsFrame: 0,
    observer: null,
    scanTimer: null,
    debugCounter: 0,
    lastUrl: location.href,
    latestToastTimer: 0,
    stopped: false,
    urlTimer: 0
  };

  bootstrap().catch((error) => {
    if (handleInvalidatedContext(error)) return;
    console.error("[ChatGPT Thread Lite] bootstrap failed", error);
  });

  async function bootstrap() {
    if (!ensureActiveContext()) return;
    await loadPersistentState();
    if (!ensureActiveContext()) return;
    bindRuntimeEvents();
    scheduleScan("bootstrap");
  }

  async function loadPersistentState() {
    const stored = await chrome.storage.local.get([STORAGE_KEYS.settings, STORAGE_KEYS.sessionStates]);
    state.settings = { ...DEFAULT_SETTINGS, ...(stored[STORAGE_KEYS.settings] || {}) };
    state.sessionKey = getSessionKey();
    state.sessionState = getStoredSessionState(stored[STORAGE_KEYS.sessionStates], state.sessionKey);
  }

  function bindRuntimeEvents() {
    startObserver();

    document.addEventListener("click", handleCollapsedMessageActivation, true);
    document.addEventListener("keydown", handleCollapsedMessageActivation, true);
    window.addEventListener("scroll", scheduleMessageControlPositionUpdate, true);
    window.addEventListener("resize", scheduleMessageControlPositionUpdate);

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (!ensureActiveContext()) return;
      if (areaName !== "local") {
        return;
      }

      if (changes[STORAGE_KEYS.settings]) {
        state.settings = {
          ...DEFAULT_SETTINGS,
          ...(changes[STORAGE_KEYS.settings].newValue || {})
        };
        scheduleScan("settings changed");
      }

      if (changes[STORAGE_KEYS.sessionStates]) {
        const nextStates = changes[STORAGE_KEYS.sessionStates].newValue || {};
        state.sessionState = getStoredSessionState(nextStates, state.sessionKey);
        scheduleScan("session state changed");
      }
    });

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!ensureActiveContext()) return false;
      handleRuntimeMessage(message)
        .then(sendResponse)
        .catch((error) => {
          if (handleInvalidatedContext(error)) return;
          console.warn("[ChatGPT Thread Lite] message failed", error);
          sendResponse({ ok: false, message: "扩展操作失败。" });
        });
      return true;
    });

    window.addEventListener("beforeunload", stopContentScript);

    state.urlTimer = setInterval(() => {
      if (!ensureActiveContext()) return;
      if (location.href !== state.lastUrl) {
        state.lastUrl = location.href;
        handleUrlChange().catch((error) => {
          if (handleInvalidatedContext(error)) return;
          console.warn("[ChatGPT Thread Lite] failed to reload session state", error);
        });
      }
    }, 1000);
  }

  async function handleUrlChange() {
    if (!ensureActiveContext()) return;
    clearMessageControls();
    restoreAllCollapsedNodesSilently();
    state.sessionKey = getSessionKey();
    const stored = await chrome.storage.local.get([STORAGE_KEYS.sessionStates]);
    if (!ensureActiveContext()) return;
    state.sessionState = getStoredSessionState(stored[STORAGE_KEYS.sessionStates], state.sessionKey);
    state.messageRecords.clear();
    state.collapsedNodes.clear();
    scheduleScan("url changed");
  }

  function startObserver() {
    disconnectObserver();
    state.observer = new MutationObserver((mutations) => {
      if (!state.settings.enabled) {
        return;
      }

      const relevant = mutations.some((mutation) => {
        if (mutation.type === "childList" && (mutation.addedNodes.length || mutation.removedNodes.length)) {
          return true;
        }
        if (mutation.type === "characterData") {
          return true;
        }
        return mutation.type === "attributes";
      });

      if (relevant) {
        scheduleScan("mutation");
      }
    });

    state.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: false
    });
  }

  function disconnectObserver() {
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
  }

  function scheduleScan(reason) {
    if (!ensureActiveContext()) return;
    clearTimeout(state.scanTimer);
    state.scanTimer = window.setTimeout(() => {
      scanAndApply(reason).catch((error) => {
        if (handleInvalidatedContext(error)) return;
        console.warn("[ChatGPT Thread Lite] scan failed", error);
      });
    }, 180);
  }

  async function scanAndApply(reason) {
    if (!ensureActiveContext()) return;
    if (!state.settings.enabled) {
      restoreAllCollapsedNodesSilently();
      clearMessageControls();
      removeGlobalControls();
      debugLog("scan skipped, disabled");
      return;
    }

    const messages = collectAssistantMessages();
    applyVirtualization(messages);
    applyGlobalHeaderControls(messages);
    applyMessageControls(messages);
    cleanupStaleCaches(messages);
    debugLog(`scan ${reason}`, {
      assistantCount: messages.length,
      collapsedCount: getCollapsedIds().length
    });
  }
  function collectAssistantMessages() {
    const root = findConversationRoot();
    if (!root) {
      return [];
    }

    const candidates = collectMessageTurnCandidates(root);
    const assistantMessages = [];

    candidates.forEach((node, index) => {
      if (!(node instanceof HTMLElement)) {
        return;
      }

      if (!looksLikeMessageTurn(node)) {
        return;
      }

      const role = detectMessageRole(node);
      if (role !== "assistant") {
        return;
      }

      const record = getOrCreateMessageRecord(node, index);
      if (!record) {
        return;
      }

      assistantMessages.push(record);
    });

    assistantMessages.sort((a, b) => a.index - b.index);
    assistantMessages.forEach((record, index) => {
      record.order = index;
      if (record.node && record.node.dataset) {
        record.node.dataset[`${camelCase(EXTENSION_PREFIX)}MessageId`] = record.id;
      }
    });

    return assistantMessages;
  }

  function collectMessageTurnCandidates(root) {
    const primary = uniqueElements(queryCandidates(root, SELECTORS.messages.primaryTurnCandidates))
      .filter((node) => !node.parentElement?.closest("[data-testid^='conversation-turn-']"));

    if (primary.length) {
      return primary;
    }

    const roleNodes = Array.from(root.querySelectorAll("[data-message-author-role='assistant']"));
    return uniqueElements(roleNodes.map((roleNode) => (
      roleNode.closest("article, [role='article']") || roleNode
    ))).filter((node) => node instanceof HTMLElement);
  }

  function findConversationRoot() {
    for (const selector of SELECTORS.roots.conversation) {
      const node = document.querySelector(selector);
      if (node instanceof HTMLElement) {
        return node;
      }
    }
    for (const selector of SELECTORS.roots.main) {
      const node = document.querySelector(selector);
      if (node instanceof HTMLElement) {
        return node;
      }
    }
    return null;
  }

  function looksLikeMessageTurn(node) {
    if (!node.isConnected) {
      return false;
    }
    const text = getNodeText(node);
    if (!text) {
      return false;
    }
    const hasHint = SELECTORS.messages.contentHints.some((selector) => node.querySelector(selector));
    return hasHint || text.length > 20;
  }

  function detectMessageRole(node) {
    const explicitRole = node.getAttribute("data-message-author-role");
    if (explicitRole === "assistant" || explicitRole === "user") {
      return explicitRole;
    }

    const authorRoles = new Set(Array.from(node.querySelectorAll("[data-message-author-role]"))
      .map((element) => element.getAttribute("data-message-author-role"))
      .filter(Boolean));

    if (authorRoles.size === 1 && authorRoles.has("assistant")) {
      return "assistant";
    }
    if (authorRoles.size === 1 && authorRoles.has("user")) {
      return "user";
    }

    // A container with both roles is a conversation wrapper, never a single turn.
    if (authorRoles.size > 1) {
      return "unknown";
    }

    if (queryCandidates(node, SELECTORS.messages.userHints).length > 0) {
      return "user";
    }

    if (queryCandidates(node, SELECTORS.messages.assistantHints).length > 0) {
      return "assistant";
    }

    const testId = node.getAttribute("data-testid") || "";
    if (/assistant/i.test(testId)) {
      return "assistant";
    }
    if (/user/i.test(testId)) {
      return "user";
    }

    const labelText = (node.textContent || "").slice(0, 80);
    if (/chatgpt/i.test(labelText)) {
      return "assistant";
    }

    return "unknown";
  }

  function getOrCreateMessageRecord(node, fallbackIndex) {
    const summary = createTextSummary(node);
    if (!summary) {
      return null;
    }

    const id = buildMessageId(node, summary, fallbackIndex);
    const existing = state.messageRecords.get(id) || {};
    const record = {
      id,
      node,
      summary,
      index: fallbackIndex,
      order: existing.order || fallbackIndex,
      complex: detectComplexity(node),
      hostAccessibility: existing.hostAccessibility || null,
      collapsed: state.sessionState.collapsed[id] === true,
      locked: state.sessionState.lockedExpanded[id] === true,
      manuallyExpanded: state.sessionState.manualExpanded[id] === true
    };
    state.messageRecords.set(id, record);
    return record;
  }

  function buildMessageId(node, summary, fallbackIndex) {
    const explicitId =
      node.getAttribute("data-message-id") ||
      node.getAttribute("data-id") ||
      node.getAttribute("id") ||
      node.getAttribute("data-testid");

    if (explicitId) {
      return sanitizeId(`msg-${explicitId}`);
    }

    const rolePart = detectMessageRole(node);
    const summaryHash = simpleHash(summary.slice(0, 300));
    const pathIndex = getSiblingPath(node);
    return sanitizeId(`${state.sessionKey}-${rolePart}-${fallbackIndex}-${pathIndex}-${summaryHash}`);
  }

  function applyGlobalHeaderControls(messages) {
    if (!document.body) {
      return;
    }

    let container = document.querySelector(`.${EXTENSION_PREFIX}-global-controls`);
    if (!container) {
      container = document.createElement("div");
      container.className = `${EXTENSION_PREFIX}-global-controls`;
      container.setAttribute("aria-label", t("assistantMessage"));

      const expandAllBtn = createButton(t("expandAllHeader"), "primary", "global-expand-all", () => {
        expandAllCollapsedMessages().catch(handleSoftError);
      });

      const collapseAllBtn = createButton(t("collapseAllHeader"), "default", "global-collapse-all", () => {
        collapseAllMessages().catch(handleSoftError);
      });

      container.append(collapseAllBtn, expandAllBtn);
      document.body.appendChild(container);
    }

    const expandAllBtn = container.querySelector("[data-action='global-expand-all']");
    positionGlobalControls();
    const collapseAllBtn = container.querySelector("[data-action='global-collapse-all']");
    const collapsedCount = getCollapsedIds().length;

    if (expandAllBtn) {
      expandAllBtn.disabled = collapsedCount === 0;
      expandAllBtn.title = t("expandAll");
    }

    if (collapseAllBtn) {
      collapseAllBtn.disabled = messages.length === 0;
      collapseAllBtn.title = t("collapseAllHeader");
    }
  }
  function removeGlobalControls() {
    const controls = document.querySelector(`.${EXTENSION_PREFIX}-global-controls`);
    if (controls) {
      controls.remove();
    }
  }

  function layoutSetting(key, min, max) {
    const value = Number(state.settings[key]);
    return Math.max(min, Math.min(max, Number.isFinite(value) ? value : DEFAULT_SETTINGS[key]));
  }

  function positionGlobalControls() {
    const controls = document.querySelector(`.${EXTENSION_PREFIX}-global-controls`);
    if (!controls) return;
    controls.style.setProperty('--ctl-scale', layoutSetting('globalControlsSize', 60, 180) / 100);
    const bounds = controls.getBoundingClientRect();
    controls.style.right = `${Math.max(8, Math.min(window.innerWidth - Math.ceil(bounds.width) - 8,
      layoutSetting('globalControlsRight', 8, 2000)))}px`;
    controls.style.top = `${Math.max(8, Math.min(window.innerHeight - Math.ceil(bounds.height) - 8,
      layoutSetting('globalControlsTop', 8, 2000)))}px`;
  }

  function ensureControlsLayer() {
    if (state.controlsLayer && state.controlsLayer.isConnected) {
      return state.controlsLayer;
    }
    const layer = document.createElement("div");
    layer.className = `${EXTENSION_PREFIX}-controls-layer`;
    layer.setAttribute("aria-label", t("assistantMessage"));
    document.body.appendChild(layer);
    state.controlsLayer = layer;
    return layer;
  }

  function applyMessageControls(messages) {
    state.controlMessages = messages;
    renderMessageControlsForViewport();
  }

  function renderMessageControlsForViewport() {
    if (!state.settings.enabled || !document.body) {
      return;
    }

    const layer = ensureControlsLayer();
    const visibleIds = new Set();
    state.controlMessages.forEach((record) => {
      if (!record.node || !record.node.isConnected) {
        return;
      }
      const rect = record.node.getBoundingClientRect();
      if (rect.bottom < -48 || rect.top > window.innerHeight + 48) {
        return;
      }

      visibleIds.add(record.id);
      let controls = state.messageControls.get(record.id);
      if (!controls || !controls.isConnected) {
        controls = createMessageControl(record);
        layer.appendChild(controls);
        state.messageControls.set(record.id, controls);
      }
      syncMessageControl(record, controls, rect);
    });

    Array.from(state.messageControls.entries()).forEach(([id, controls]) => {
      if (!visibleIds.has(id)) {
        controls.remove();
        state.messageControls.delete(id);
      }
    });
  }
  function createMessageControl(record) {
    const controls = document.createElement("div");
    controls.className = `${EXTENSION_PREFIX}-message-controls`;
    controls.dataset.messageId = record.id;

    const toggleBtn = createButton("", "default", "message-toggle", () => {
      const current = state.messageRecords.get(record.id);
      if (!current) {
        return;
      }
      const operation = isCollapsed(record.id)
        ? expandMessage(record.id, { manual: true, persist: true })
        : collapseMessage(record.id, { manual: true });
      operation
        .then(() => scheduleScan("message control toggled"))
        .catch(handleSoftError);
    });

    const lockBtn = createButton("", "default", "message-lock", () => {
      toggleLock(record.id).catch(handleSoftError);
    });
    controls.append(toggleBtn, lockBtn);
    return controls;
  }

  function syncMessageControl(record, controls, rect) {
    const collapsed = isCollapsed(record.id);
    const locked = state.sessionState.lockedExpanded[record.id] === true;
    const toggleBtn = controls.querySelector("[data-action='message-toggle']");
    const lockBtn = controls.querySelector("[data-action='message-lock']");

    setButtonTextIfChanged(toggleBtn, collapsed ? t("expand") : t("collapse"));
    if (toggleBtn) {
      toggleBtn.dataset.variant = collapsed ? "primary" : "default";
      toggleBtn.disabled = locked && !collapsed;
      toggleBtn.title = collapsed ? t("expand") : t("collapse");
    }

    setButtonTextIfChanged(lockBtn, locked ? t("locked") : t("lock"));
    if (lockBtn) {
      lockBtn.classList.toggle("is-active", locked);
      lockBtn.title = t("permanentExpand");
    }

    controls.classList.toggle("is-collapsed", collapsed);
    controls.setAttribute("aria-label", record.summary || t("assistantMessage"));
    controls.style.setProperty('--ctl-scale', layoutSetting('messageControlsSize', 60, 180) / 100);
    const bounds = controls.getBoundingClientRect();
    const width = Math.ceil(bounds.width) || 64;
    const height = Math.ceil(bounds.height) || 48;
    const bottomLimit = Math.max(8, window.innerHeight - height - 8);
    const topLimit = Math.min(bottomLimit, layoutSetting('messageControlsTopLimit', 8, 600));
    const top = Math.max(topLimit, Math.min(bottomLimit,
      rect.top + 6 + layoutSetting('messageControlsY', -600, 600)));
    const left = Math.max(8, Math.min(window.innerWidth - width - 8,
      rect.left - width - 8 + layoutSetting('messageControlsX', -600, 600)));
    controls.style.top = `${top}px`;
    controls.style.left = `${left}px`;
  }

  function setButtonTextIfChanged(button, label) {
    if (button && button.textContent !== label) {
      button.textContent = label;
    }
  }

  function scheduleMessageControlPositionUpdate() {
    if (!ensureActiveContext()) return;
    if (state.controlsFrame) {
      cancelAnimationFrame(state.controlsFrame);
    }
    state.controlsFrame = requestAnimationFrame(() => {
      state.controlsFrame = 0;
      if (!ensureActiveContext()) return;
      try {
        positionGlobalControls();
        renderMessageControlsForViewport();
      } catch (error) {
        handleSoftError(error);
      }
    });
  }

  function clearMessageControls() {
    if (state.controlsFrame) {
      cancelAnimationFrame(state.controlsFrame);
      state.controlsFrame = 0;
    }
    state.messageControls.forEach((controls) => controls.remove());
    state.messageControls.clear();
    state.controlMessages = [];
    if (state.controlsLayer) {
      state.controlsLayer.remove();
      state.controlsLayer = null;
    }
  }
  function applyVirtualization(messages) {
    const keepRecentCount = Math.max(1, Number(state.settings.keepRecentCount) || DEFAULT_SETTINGS.keepRecentCount);

    messages.forEach((record, index) => {
      record.collapsed = isCollapsed(record.id);
      record.locked = state.sessionState.lockedExpanded[record.id] === true;
      record.manuallyExpanded = state.sessionState.manualExpanded[record.id] === true;

      const keepBecauseRecent = index >= messages.length - keepRecentCount;
      const keepBecauseManual = record.locked || record.manuallyExpanded;
      const wasPersistedCollapsed = state.sessionState.collapsed[record.id] === true;
      // Complex content must not automatically hide the reply being read or streamed.
      // Explicit collapse actions still take precedence for the latest reply.
      const isLatestReply = index === messages.length - 1;
      const shouldPreferCollapse = state.settings.autoCollapseComplex
        ? (record.complex || !keepBecauseRecent)
        : !keepBecauseRecent;
      const shouldCollapse = !keepBecauseManual
        && (wasPersistedCollapsed || (!isLatestReply && shouldPreferCollapse));

      if (shouldCollapse) {
        if (!record.collapsed) {
          collapseMessageSync(record.id, { manual: false });
        } else if (record.node && record.node.isConnected) {
          collapseMessageSync(record.id, { manual: false });
        }
      } else if (record.collapsed) {
        expandMessageSync(record.id, { manual: false, persist: false });
      }
    });
  }

  async function collapseMessage(messageId, options) {
    const ok = collapseMessageSync(messageId, options);
    if (ok) {
      await persistSessionState();
      scheduleScan("message collapsed");
    }
    return ok;
  }

  function collapseMessageSync(messageId, options) {
    const record = state.messageRecords.get(messageId);
    if (!record || !record.node || !record.node.isConnected) {
      return false;
    }

    if (isCollapsed(messageId) || state.sessionState.lockedExpanded[messageId]) {
      return false;
    }

    const node = record.node;
    const summary = record.summary || createTextSummary(node);
    saveHostAccessibilityAttributes(record, node);

    node.classList.add(`${EXTENSION_PREFIX}-collapsed`);
    node.dataset[`${camelCase(EXTENSION_PREFIX)}Collapsed`] = "true";
    node.dataset[`${camelCase(EXTENSION_PREFIX)}Summary`] = summary;
    node.dataset[`${camelCase(EXTENSION_PREFIX)}Hint`] = t("clickToRestore");
    node.setAttribute("role", "button");
    node.setAttribute("tabindex", "0");
    node.setAttribute("aria-expanded", "false");
    node.setAttribute("title", `${t("collapsedHint")} — ${t("clickToRestore")}`);

    state.collapsedNodes.set(messageId, node);
    state.sessionState.collapsed[messageId] = true;
    delete state.sessionState.manualExpanded[messageId];
    record.summary = summary;
    record.collapsed = true;

    if (options && options.manual) {
      showToast(t("collapsedMessage"));
    }
    return true;
  }

  async function expandMessage(messageId, options) {
    const ok = expandMessageSync(messageId, options);
    if (ok) {
      await persistSessionState();
      scheduleScan("message expanded");
    }
    return ok;
  }

  function expandMessageSync(messageId, options) {
    const record = state.messageRecords.get(messageId);
    const node = state.collapsedNodes.get(messageId) || (record && record.node);
    if (!node || !node.isConnected || !node.classList.contains(`${EXTENSION_PREFIX}-collapsed`)) {
      return false;
    }

    node.classList.remove(`${EXTENSION_PREFIX}-collapsed`);
    delete node.dataset[`${camelCase(EXTENSION_PREFIX)}Collapsed`];
    delete node.dataset[`${camelCase(EXTENSION_PREFIX)}Summary`];
    delete node.dataset[`${camelCase(EXTENSION_PREFIX)}Hint`];
    restoreHostAccessibilityAttributes(record, node);

    state.collapsedNodes.delete(messageId);
    delete state.sessionState.collapsed[messageId];
    if (options && options.persist) {
      state.sessionState.manualExpanded[messageId] = true;
    }
    if (record) {
      record.collapsed = false;
      record.manuallyExpanded = state.sessionState.manualExpanded[messageId] === true;
      record.locked = state.sessionState.lockedExpanded[messageId] === true;
    }
    return true;
  }

  function handleCollapsedMessageActivation(event) {
    if (!ensureActiveContext()) return;
    if (event.type === "keydown" && event.key !== "Enter" && event.key !== " ") {
      return;
    }
    if (event.type === "click" && event.button !== 0) {
      return;
    }
    if (!(event.target instanceof Element)) {
      return;
    }

    const node = event.target.closest(`.${EXTENSION_PREFIX}-collapsed`);
    if (!(node instanceof HTMLElement)) {
      return;
    }

    const messageId = node.dataset[`${camelCase(EXTENSION_PREFIX)}MessageId`];
    if (!messageId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    expandMessage(messageId, { manual: true, persist: true }).catch(handleSoftError);
  }

  function saveHostAccessibilityAttributes(record, node) {
    if (record.hostAccessibility) {
      return;
    }
    record.hostAccessibility = {
      role: node.getAttribute("role"),
      tabindex: node.getAttribute("tabindex"),
      ariaExpanded: node.getAttribute("aria-expanded"),
      title: node.getAttribute("title")
    };
  }

  function restoreHostAccessibilityAttributes(record, node) {
    if (!record || !record.hostAccessibility) {
      ["role", "tabindex", "aria-expanded", "title"].forEach((name) => node.removeAttribute(name));
      return;
    }

    const attributes = {
      role: record.hostAccessibility.role,
      tabindex: record.hostAccessibility.tabindex,
      "aria-expanded": record.hostAccessibility.ariaExpanded,
      title: record.hostAccessibility.title
    };
    Object.entries(attributes).forEach(([name, value]) => {
      if (value === null) {
        node.removeAttribute(name);
      } else {
        node.setAttribute(name, value);
      }
    });
    record.hostAccessibility = null;
  }
  async function toggleLock(messageId) {
    if (state.sessionState.lockedExpanded[messageId]) {
      delete state.sessionState.lockedExpanded[messageId];
    } else {
      state.sessionState.lockedExpanded[messageId] = true;
      delete state.sessionState.collapsed[messageId];
      delete state.sessionState.manualExpanded[messageId];
      expandMessageSync(messageId, { manual: true, persist: false });
    }

    const record = state.messageRecords.get(messageId);
    if (record) {
      record.locked = state.sessionState.lockedExpanded[messageId] === true;
    }

    await persistSessionState();
    scheduleScan("lock toggled");
  }

  async function persistSessionState() {
    if (!ensureActiveContext()) return;
    const stored = await chrome.storage.local.get([STORAGE_KEYS.sessionStates]);
    if (!ensureActiveContext()) return;
    const allStates = stored[STORAGE_KEYS.sessionStates] || {};
    allStates[state.sessionKey] = cloneSessionState(state.sessionState);
    await chrome.storage.local.set({ [STORAGE_KEYS.sessionStates]: allStates });
  }

  function getStoredSessionState(allStates, sessionKey) {
    const raw = allStates && allStates[sessionKey];
    return cloneSessionState({ ...DEFAULT_SESSION_STATE, ...(raw || {}) });
  }

  function cloneSessionState(sessionState) {
    return {
      lockedExpanded: { ...(sessionState.lockedExpanded || {}) },
      manualExpanded: { ...(sessionState.manualExpanded || {}) },
      collapsed: { ...(sessionState.collapsed || {}) },
      lastBulkCollapsedSnapshot: Array.isArray(sessionState.lastBulkCollapsedSnapshot)
        ? [...sessionState.lastBulkCollapsedSnapshot]
        : []
    };
  }

  async function handleRuntimeMessage(message) {
    switch (message && message.type) {
      case "settingsUpdated":
        scheduleScan("popup settings update");
        return { ok: true };
      case "getPageState":
        return getPageState();
      case "expandNearby":
        return expandNearbyMessages();
      case "expandAll":
        return expandAllCollapsedMessages();
      case "collapseAll":
        return collapseAllMessages();
      case "restorePreviousCollapsed":
        return restorePreviousCollapsedSnapshot();
      case "recollapseOld":
        return recollapseOldMessages();
      case "resetSession":
        return resetCurrentSessionState();
      default:
        return { ok: false, message: t("unableReadPageState") };
    }
  }

  function getPageState() {
    const messages = collectAssistantMessages();
    const collapsedIds = getCollapsedIds();
    const nearbyCollapsedIds = getCollapsedIdsNearViewport(state.settings.nearbyExpandCount);

    return {
      ok: true,
      sessionKey: state.sessionKey,
      assistantCount: messages.length,
      collapsedCount: collapsedIds.length,
      nearbyCollapsedCount: nearbyCollapsedIds.length,
      hasPreviousCollapsedSnapshot: Array.isArray(state.sessionState.lastBulkCollapsedSnapshot)
        && state.sessionState.lastBulkCollapsedSnapshot.length > 0
    };
  }

  async function expandNearbyMessages() {
    const ids = getCollapsedIdsNearViewport(state.settings.nearbyExpandCount);
    if (!ids.length) {
      return { ok: true, message: t("noNearbyCollapsedMessages") };
    }

    state.sessionState.lastBulkCollapsedSnapshot = getCollapsedIds();
    let restored = 0;
    ids.forEach((id) => {
      if (expandMessageSync(id, { manual: true, persist: true })) {
        restored += 1;
      }
    });
    await persistSessionState();
    scheduleScan("expand nearby");
    return { ok: true, message: t("expandNearbyToast", [restored]) };
  }

  async function expandAllCollapsedMessages() {
    const ids = getCollapsedIds();
    if (!ids.length) {
      return { ok: true, message: t("noCollapsedMessages") };
    }

    state.sessionState.lastBulkCollapsedSnapshot = [...ids];
    let restored = 0;
    ids.forEach((id) => {
      if (expandMessageSync(id, { manual: true, persist: true })) {
        restored += 1;
      }
    });
    await persistSessionState();
    scheduleScan("expand all");
    return { ok: true, message: t("expandAllToast", [restored]) };
  }

  async function restorePreviousCollapsedSnapshot() {
    const ids = Array.isArray(state.sessionState.lastBulkCollapsedSnapshot)
      ? [...state.sessionState.lastBulkCollapsedSnapshot]
      : [];
    if (!ids.length) {
      return { ok: true, message: t("noPreviousCollapsedView") };
    }

    ids.forEach((id) => {
      const record = state.messageRecords.get(id);
      if (record && !state.sessionState.lockedExpanded[id]) {
        collapseMessageSync(id, { manual: false });
      }
    });
    await persistSessionState();
    scheduleScan("restore previous collapsed");
    return { ok: true, message: t("restoredPreviousCollapsedView") };
  }

  async function recollapseOldMessages() {
    state.sessionState.manualExpanded = {};
    const messages = collectAssistantMessages();
    applyVirtualization(messages);
    await persistSessionState();
    scheduleScan("recollapse old");
    return { ok: true, message: t("recollapsedOldMessages") };
  }

  async function collapseAllMessages() {
    const messages = collectAssistantMessages();
    if (!messages.length) {
      return { ok: true, message: t("noCollapsedMessages") };
    }

    state.sessionState.lastBulkCollapsedSnapshot = getCollapsedIds();
    let collapsed = 0;

    messages.forEach((record) => {
      if (state.sessionState.lockedExpanded[record.id]) {
        return;
      }
      if (!isCollapsed(record.id)) {
        collapseMessageSync(record.id, { manual: false });
        if (isCollapsed(record.id)) {
          collapsed += 1;
        }
      }
    });

    await persistSessionState();
    scheduleScan("collapse all");
    showToast(t("collapseAllToast", [collapsed]));
    return { ok: true, message: t("collapseAllToast", [collapsed]) };
  }

  async function resetCurrentSessionState() {
    restoreAllCollapsedNodesSilently();
    state.sessionState = cloneSessionState(DEFAULT_SESSION_STATE);
    await persistSessionState();
    scheduleScan("reset session");
    return { ok: true, message: t("sessionResetDone") };
  }

  function restoreAllCollapsedNodesSilently() {
    Array.from(state.collapsedNodes.keys()).forEach((id) => {
      expandMessageSync(id, { manual: false, persist: false });
    });
  }

  function getCollapsedIds() {
    return Array.from(state.collapsedNodes.entries())
      .filter(([, node]) => (
        node
        && node.isConnected
        && node.classList.contains(`${EXTENSION_PREFIX}-collapsed`)
      ))
      .map(([id]) => id);
  }

  function getCollapsedIdsNearViewport(nearbyCount) {
    const collapsed = Array.from(state.collapsedNodes.entries())
      .map(([id, node]) => ({ id, node }))
      .filter((item) => (
        item.node
        && item.node.isConnected
        && item.node.classList.contains(`${EXTENSION_PREFIX}-collapsed`)
      ));

    if (!collapsed.length) {
      return [];
    }

    const viewportCenter = window.scrollY + (window.innerHeight / 2);
    const sorted = collapsed
      .map((item) => {
        const rect = item.node.getBoundingClientRect();
        const absoluteTop = rect.top + window.scrollY;
        return {
          id: item.id,
          distance: Math.abs(absoluteTop - viewportCenter)
        };
      })
      .sort((a, b) => a.distance - b.distance);

    return sorted.slice(0, Math.max(1, nearbyCount || DEFAULT_SETTINGS.nearbyExpandCount)).map((item) => item.id);
  }

  function cleanupStaleCaches(messages) {
    const knownIds = new Set(messages.map((message) => message.id));
    Array.from(state.collapsedNodes.entries()).forEach(([id, node]) => {
      if (!node || !node.isConnected) {
        state.collapsedNodes.delete(id);
        return;
      }
      if (!knownIds.has(id)) {
        node.classList.remove(`${EXTENSION_PREFIX}-collapsed`);
        delete node.dataset[`${camelCase(EXTENSION_PREFIX)}Collapsed`];
        delete node.dataset[`${camelCase(EXTENSION_PREFIX)}Summary`];
        delete node.dataset[`${camelCase(EXTENSION_PREFIX)}Hint`];
        restoreHostAccessibilityAttributes(state.messageRecords.get(id), node);
        state.collapsedNodes.delete(id);
        delete state.sessionState.collapsed[id];
      }
    });
  }
  function createTextSummary(node) {
    const rawText = getNodeText(node)
      .replace(/\s+/g, " ")
      .trim();
    if (!rawText) {
      return "";
    }
    const limited = rawText.slice(0, 180);
    return limited.length < rawText.length ? `${limited}…` : limited;
  }

  function detectComplexity(node) {
    const counts = {
      code: countMatches(node, SELECTORS.complexContent.code),
      math: countMatches(node, SELECTORS.complexContent.math),
      table: countMatches(node, SELECTORS.complexContent.table),
      list: countMatches(node, SELECTORS.complexContent.list),
      quote: countMatches(node, SELECTORS.complexContent.quote)
    };
    const textLength = getNodeText(node).length;
    return counts.code > 0 || counts.math > 0 || counts.table > 0 || counts.list >= 6 || counts.quote >= 3 || textLength > 3200;
  }

  function queryCandidates(root, selectors) {
    const matches = [];
    selectors.forEach((selector) => {
      try {
        matches.push(...root.querySelectorAll(selector));
      } catch (error) {
        handleSoftError(error);
      }
    });
    return matches;
  }

  function uniqueElements(elements) {
    return Array.from(new Set(elements));
  }

  function createButton(label, variant, action, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `${EXTENSION_PREFIX}-btn`;
    button.dataset.variant = variant === "primary" ? "primary" : variant === "danger" ? "danger" : "default";
    button.textContent = label;
    button.dataset.action = action;
    button.addEventListener("click", (event) => {
      if (!ensureActiveContext()) return;
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
    return button;
  }

  function getNodeText(node) {
    return (node.innerText || node.textContent || "").trim();
  }

  function countMatches(root, selectors) {
    return selectors.reduce((count, selector) => {
      try {
        return count + root.querySelectorAll(selector).length;
      } catch (error) {
        handleSoftError(error);
        return count;
      }
    }, 0);
  }

  function getSiblingPath(node) {
    const parts = [];
    let current = node;
    while (current && current.parentElement && current !== document.body) {
      const index = Array.from(current.parentElement.children).indexOf(current);
      parts.push(index);
      current = current.parentElement;
    }
    return parts.reverse().join("-");
  }

  function getSessionKey() {
    const conversationId = extractConversationIdFromUrl(location.href);
    return conversationId ? `session:${conversationId}` : `session:path:${location.pathname}`;
  }

  function extractConversationIdFromUrl(url) {
    const match = url.match(/\/c\/([a-zA-Z0-9-]+)/);
    return match ? match[1] : "";
  }

  function sanitizeId(value) {
    return String(value).replace(/[^a-zA-Z0-9:_-]/g, "_").slice(0, 220);
  }

  function simpleHash(value) {
    let hash = 0;
    for (let index = 0; index < value.length; index += 1) {
      hash = ((hash << 5) - hash) + value.charCodeAt(index);
      hash |= 0;
    }
    return Math.abs(hash).toString(16);
  }

  function camelCase(value) {
    return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
  }

  function isCollapsed(messageId) {
    const node = state.collapsedNodes.get(messageId);
    return Boolean(
      node
      && node.isConnected
      && node.classList.contains(`${EXTENSION_PREFIX}-collapsed`)
    );
  }

  function showToast(message) {
    const previous = document.querySelector(`.${EXTENSION_PREFIX}-toast`);
    if (previous) {
      previous.remove();
    }

    const toast = document.createElement("div");
    toast.className = `${EXTENSION_PREFIX}-toast`;
    toast.textContent = message;
    document.body.appendChild(toast);
    clearTimeout(state.latestToastTimer);
    state.latestToastTimer = window.setTimeout(() => {
      toast.remove();
    }, 2200);
  }

  function debugLog(label, payload) {
    if (!state.settings.debugMode) {
      return;
    }
    state.debugCounter += 1;
    console.debug(`[ChatGPT Thread Lite ${state.debugCounter}] ${label}`, payload || "");
  }

  function handleSoftError(error) {
    if (handleInvalidatedContext(error)) return;
    if (state.settings.debugMode) {
      console.warn("[ChatGPT Thread Lite] soft error", error);
    }
  }

  function handleInvalidatedContext(error) {
    if (state.stopped || /extension context invalidated/i.test(String(error?.message || error))) {
      stopContentScript();
      return true;
    }
    return false;
  }

  function ensureActiveContext() {
    if (state.stopped) return false;
    try {
      if (chrome.runtime?.id) return true;
    } catch (_) {
      // A reloaded extension leaves this old content script without a runtime.
    }
    stopContentScript();
    return false;
  }

  function stopContentScript() {
    if (state.stopped) return;
    state.stopped = true;
    disconnectObserver();
    clearTimeout(state.scanTimer);
    clearTimeout(state.latestToastTimer);
    clearInterval(state.urlTimer);
    document.removeEventListener('click', handleCollapsedMessageActivation, true);
    document.removeEventListener('keydown', handleCollapsedMessageActivation, true);
    window.removeEventListener('scroll', scheduleMessageControlPositionUpdate, true);
    window.removeEventListener('resize', scheduleMessageControlPositionUpdate);
    window.removeEventListener('beforeunload', stopContentScript);
    clearMessageControls();
    removeGlobalControls();
    // Include a turn whose collapse was interrupted by an API throwing.
    state.messageRecords.forEach((record) => {
      expandMessageSync(record.id, { manual: false, persist: false });
    });
    state.collapsedNodes.clear();
    state.messageRecords.clear();
    document.querySelector(`.${EXTENSION_PREFIX}-toast`)?.remove();
  }
})();
