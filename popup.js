(function () {
  "use strict";

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

  const LAYOUT_LIMITS = {
    messageControlsSize: [60, 180],
    messageControlsX: [-600, 600],
    messageControlsY: [-600, 600],
    messageControlsTopLimit: [8, 600],
    globalControlsSize: [60, 180],
    globalControlsRight: [8, 2000],
    globalControlsTop: [8, 2000]
  };

  const FALLBACK_MESSAGES = {
    popupTitle: "ChatGPT Thread Collapse",
    popupSubtitle: "Collapse old assistant messages without removing ChatGPT's live DOM nodes.",
    enableExtension: "Enable extension",
    recentKeepCount: "Keep the latest assistant messages expanded",
    collapseComplex: "Prefer collapsing code/math-heavy old messages",
    debugMode: "Developer debug mode",
    sessionControls: "Current thread controls",
    loadingPageState: "Reading current page state…",
    currentSummary: "assistant messages: {0}, collapsed: {1}, near viewport: {2}{3}.",
    notChatgptTab: "No manageable ChatGPT conversation was detected in the current tab.",
    saveStatus: "Settings saved.",
    settingsAutoSave: "Settings are saved automatically.",
    expandNearby: "Expand nearby messages",
    expandAll: "Expand all collapsed messages in this thread",
    collapseAll: "Collapse all messages in this thread",
    restorePrevious: "Restore previous collapsed view",
    recollapseOld: "Re-collapse old messages in this thread",
    resetSession: "Reset current thread state",
    unableReadPageState: "Unable to read the current page state. Make sure this tab is a ChatGPT page.",
    expandAllConfirm: "Expanding all will restore every collapsed assistant message and may briefly increase layout and paint work. Continue?",
    resetSessionConfirm: "This will clear manual expand, lock, and collapsed records for the current thread. Continue?",
  };

  const elements = {
    enabled: document.getElementById("enabled"),
    keepRecentCount: document.getElementById("keepRecentCount"),
    autoCollapseComplex: document.getElementById("autoCollapseComplex"),
    debugMode: document.getElementById("debugMode"),
    expandNearby: document.getElementById("expandNearby"),
    expandAll: document.getElementById("expandAll"),
    collapseAll: document.getElementById("collapseAll"),
    restorePreviousCollapsed: document.getElementById("restorePreviousCollapsed"),
    recollapseOld: document.getElementById("recollapseOld"),
    resetSession: document.getElementById("resetSession"),
    pageStateHint: document.getElementById("pageStateHint"),
    saveStatus: document.getElementById("saveStatus"),
    popupTitle: document.querySelector(".popup-header h1"),
    popupSubtitle: document.querySelector(".popup-header p"),
    sessionTitle: document.getElementById("sessionTitle")
  };
  Object.keys(LAYOUT_LIMITS).forEach((key) => {
    elements[key] = document.getElementById(key);
  });

  let currentPageState = null;

  init().catch((error) => {
    console.error("[ChatGPT Thread Lite] Popup init failed", error);
    elements.pageStateHint.textContent = t("unableReadPageState");
  });

  async function init() {
    applyI18n();
    const stored = await chrome.storage.local.get(["settings"]);
    const settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
    renderSettings(settings);
    bindSettings();
    bindActions();
    await refreshPageState();
  }

  function applyI18n() {
    document.querySelectorAll('[data-i18n]').forEach((element) => {
      const message = chrome.i18n.getMessage(element.dataset.i18n);
      if (message) element.textContent = message;
    });
    document.title = t("popupTitle");
    if (elements.popupTitle) {
      elements.popupTitle.textContent = t("popupTitle");
    }
    if (elements.popupSubtitle) {
      elements.popupSubtitle.textContent = t("popupSubtitle");
    }
    if (elements.sessionTitle) {
      elements.sessionTitle.textContent = t("sessionControls");
    }

    setLabelText("enabled", t("enableExtension"));
    setLabelText("keepRecentCount", t("recentKeepCount"));
    setLabelText("autoCollapseComplex", t("collapseComplex"));
    setLabelText("debugMode", t("debugMode"));
    setButtonText("expandNearby", t("expandNearby"));
    setButtonText("expandAll", t("expandAll"));
    setButtonText("collapseAll", t("collapseAll"));
    setButtonText("restorePreviousCollapsed", t("restorePrevious"));
    setButtonText("recollapseOld", t("recollapseOld"));
    setButtonText("resetSession", t("resetSession"));
    elements.pageStateHint.textContent = t("loadingPageState");
    elements.saveStatus.textContent = t("settingsAutoSave");
  }

  function setLabelText(controlId, text) {
    const input = elements[controlId];
    if (!input) {
      return;
    }
    const label = input.closest("label");
    const span = label ? label.querySelector("span") : null;
    if (span) {
      span.textContent = text;
    }
  }

  function setButtonText(buttonId, text) {
    const button = elements[buttonId];
    if (button) {
      button.textContent = text;
    }
  }

  function renderSettings(settings) {
    elements.enabled.checked = Boolean(settings.enabled);
    elements.keepRecentCount.value = String(settings.keepRecentCount);
    elements.autoCollapseComplex.checked = Boolean(settings.autoCollapseComplex);
    elements.debugMode.checked = Boolean(settings.debugMode);
    Object.entries(LAYOUT_LIMITS).forEach(([key, [min, max]]) => {
      elements[key].value = clampNumber(settings[key], min, max, DEFAULT_SETTINGS[key]);
    });
  }

  function bindSettings() {
    const onChange = async () => {
      const nextSettings = {
        enabled: elements.enabled.checked,
        keepRecentCount: clampNumber(elements.keepRecentCount.value, 1, 50, DEFAULT_SETTINGS.keepRecentCount),
        autoCollapseComplex: elements.autoCollapseComplex.checked,
        debugMode: elements.debugMode.checked,
        nearbyExpandCount: DEFAULT_SETTINGS.nearbyExpandCount
      };

      Object.entries(LAYOUT_LIMITS).forEach(([key, [min, max]]) => {
        nextSettings[key] = clampNumber(elements[key].value, min, max, DEFAULT_SETTINGS[key]);
        elements[key].value = nextSettings[key];
      });

      await chrome.storage.local.set({ settings: nextSettings });
      elements.saveStatus.textContent = t("saveStatus");
      await notifyActiveTab({ type: "settingsUpdated" });
      await refreshPageState();
    };

    elements.enabled.addEventListener("change", onChange);
    elements.keepRecentCount.addEventListener("change", onChange);
    elements.autoCollapseComplex.addEventListener("change", onChange);
    elements.debugMode.addEventListener("change", onChange);
    Object.keys(LAYOUT_LIMITS).forEach((key) => {
      elements[key].addEventListener("change", onChange);
    });
    document.getElementById('resetButtonLayout').addEventListener('click', () => {
      Object.keys(LAYOUT_LIMITS).forEach((key) => {
        elements[key].value = DEFAULT_SETTINGS[key];
      });
      onChange();
    });
  }

  function bindActions() {
    elements.expandNearby.addEventListener("click", () => runAction("expandNearby"));
    elements.expandAll.addEventListener("click", async () => {

      const proceed = window.confirm(t("expandAllConfirm"));
      if (!proceed) {
        return;
      }
      await runAction("expandAll");
    });
    elements.collapseAll.addEventListener("click", () => runAction("collapseAll"));
    elements.restorePreviousCollapsed.addEventListener("click", () => runAction("restorePreviousCollapsed"));
    elements.recollapseOld.addEventListener("click", () => runAction("recollapseOld"));
    elements.resetSession.addEventListener("click", async () => {
      const proceed = window.confirm(t("resetSessionConfirm"));
      if (!proceed) {
        return;
      }
      await runAction("resetSession");
    });
  }

  async function runAction(action) {
    const response = await notifyActiveTab({ type: action });
    if (!response || response.ok === false) {
      elements.pageStateHint.textContent = response && response.message
        ? response.message
        : t("unableReadPageState");
      return;
    }
    if (response.message) {
      elements.pageStateHint.textContent = response.message;
    }
    await refreshPageState();
  }

  async function refreshPageState() {
    const pageState = await notifyActiveTab({ type: "getPageState" });
    currentPageState = pageState && pageState.ok !== false ? pageState : null;

    if (!currentPageState) {
      elements.pageStateHint.textContent = t("notChatgptTab");
      setActionAvailability(false);
      return;
    }

    const collapsedCount = currentPageState.collapsedCount || 0;
    const assistantCount = currentPageState.assistantCount || 0;
    const nearbyCount = currentPageState.nearbyCollapsedCount || 0;
    const summarySuffix = "";
    elements.pageStateHint.textContent = formatMessage("currentSummary", [
      assistantCount,
      collapsedCount,
      nearbyCount,
      summarySuffix
    ]);

    setActionAvailability(true);
    elements.expandAll.disabled = collapsedCount === 0;
    elements.collapseAll.disabled = assistantCount === 0;
    elements.restorePreviousCollapsed.disabled = !Boolean(currentPageState.hasPreviousCollapsedSnapshot);
    elements.expandNearby.disabled = nearbyCount === 0;
  }

  function setActionAvailability(enabled) {
    [
      elements.expandNearby,
      elements.expandAll,
      elements.collapseAll,
      elements.restorePreviousCollapsed,
      elements.recollapseOld,
      elements.resetSession
    ].forEach((button) => {
      button.disabled = !enabled;
    });
  }

  async function notifyActiveTab(message) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      return null;
    }

    try {
      return await chrome.tabs.sendMessage(tab.id, message);
    } catch (error) {
      console.warn("[ChatGPT Thread Lite] Unable to message active tab", error);
      return null;
    }
  }

  function t(key) {
    return chrome.i18n.getMessage(key) || FALLBACK_MESSAGES[key] || key;
  }

  function formatMessage(key, substitutions) {
    const resolved = chrome.i18n.getMessage(key, substitutions);
    if (resolved) {
      return resolved;
    }
    let fallback = FALLBACK_MESSAGES[key] || key;
    substitutions.forEach((value, index) => {
      fallback = fallback.replace(new RegExp(`\\{${index}\\}`, "g"), String(value));
    });
    return fallback;
  }

  function clampNumber(value, min, max, fallback) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    return Math.max(min, Math.min(max, parsed));
  }
})();
