const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch (error) {
  console.log("content integration test skipped: install Playwright to run it");
  process.exit(0);
}

(async function main() {
  const projectRoot = path.resolve(__dirname, "..");
  const contentScript = fs.readFileSync(path.join(projectRoot, "content.js"), "utf8");
  const browserPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath();
  if (!fs.existsSync(browserPath)) {
    console.log("content integration test skipped: install the Playwright Chromium browser to run it");
    return;
  }
  const browser = await chromium.launch({ headless: true, executablePath: browserPath });
  try {
  const page = await browser.newPage();
  const errors = [];

  page.on("pageerror", function (error) {
    errors.push(error.message);
  });

  await page.evaluate(function () {
    const messages = {
      expandAllHeader: "Expand all",
      collapseAllHeader: "Collapse all",
      expandAll: "Expand all",
      assistantMessage: "Assistant messages",
      collapsedHint: "Old message lightened",
      clickToRestore: "Click to restore"
    };
    let runtimeListener = null;
    let storageListener = null;
    window.__updateSettings = function (settings) {
      storageListener({ settings: { newValue: settings } }, 'local');
    };

    window.chrome = {
      i18n: {
        getMessage: function (key, substitutions) {
          let value = messages[key] || key;
          (substitutions || []).forEach(function (substitution, index) {
            value = value.replace("{" + index + "}", String(substitution));
          });
          return value;
        }
      },
      storage: {
        local: {
          get: async function () {
            return {
              settings: {
                enabled: true,
                keepRecentCount: 2,
                autoCollapseComplex: true,
                debugMode: false,
                nearbyExpandCount: 12
              },
              sessionStates: {}
            };
          },
          set: async function () {}
        },
        onChanged: { addListener: function (listener) { storageListener = listener; } }
      },
      runtime: {
        id: 'test-extension',
        onMessage: {
          addListener: function (listener) {
            runtimeListener = listener;
          }
        }
      }
    };

    window.__sendExtensionMessage = function (message) {
      return new Promise(function (resolve, reject) {
        if (!runtimeListener) {
          reject(new Error("Content listener was not registered"));
          return;
        }
        runtimeListener(message, {}, resolve);
      });
    };
  });

  const turns = Array.from({ length: 10 }, function (_, index) {
    const role = index % 2 === 0 ? "user" : "assistant";
    return '<article data-testid="conversation-turn-' + index + '"><div data-message-author-role="' + role + '"><div class="markdown"><p>' + role + ' message ' + index + ' with enough text for detection.</p></div></div></article>';
  }).join("");

  await page.setContent("<main><div id=\"conversation\">" + turns + "</div></main>");
  await page.addStyleTag({ path: path.join(projectRoot, "content.css") });
  await page.addStyleTag({ content: "main { margin: 0 100px; }" });
  await page.evaluate(function () {
    window.__originalTurnNodes = Array.from(document.querySelectorAll("article"));
  });
  await page.addScriptTag({ content: contentScript });
  await page.waitForTimeout(800);
  const initial = await page.evaluate(async function () {
    const state = await window.__sendExtensionMessage({ type: "getPageState" });
    return {
      state: state,
      totalTurns: document.querySelectorAll("article").length,
      connectedTurns: window.__originalTurnNodes.filter(function (node) { return node.isConnected; }).length,
      identitiesIntact: window.__originalTurnNodes.every(function (node) {
        return document.querySelector('[data-testid="' + node.dataset.testid + '"]') === node;
      }),
      collapsedUsers: document.querySelectorAll('article.cgpt-lite-collapsed [data-message-author-role="user"]').length,
      collapsedTurns: document.querySelectorAll("article.cgpt-lite-collapsed").length,
      extensionNodesInsideConversation: document.querySelectorAll("#conversation .cgpt-lite-global-controls, #conversation .cgpt-lite-message-controls, #conversation .cgpt-lite-placeholder").length,
      messageControlCount: document.querySelectorAll(".cgpt-lite-message-controls").length,
      globalControlsOnBody: document.querySelector(".cgpt-lite-global-controls").parentElement === document.body
    };
  });

  assert.equal(initial.state.assistantCount, 5);
  assert.equal(initial.state.collapsedCount, 3);
  assert.equal(initial.totalTurns, 10);
  assert.equal(initial.connectedTurns, 10);
  assert.equal(initial.identitiesIntact, true);
  assert.equal(initial.collapsedUsers, 0);
  assert.equal(initial.collapsedTurns, 3);
  assert.equal(initial.extensionNodesInsideConversation, 0);
  assert.equal(initial.messageControlCount, 5);
  assert.equal(initial.globalControlsOnBody, true);

  const layout = await page.evaluate(function () {
    const controls = document.querySelector('.cgpt-lite-message-controls');
    const turn = document.querySelector('article[data-testid="conversation-turn-1"]');
    const global = document.querySelector('.cgpt-lite-global-controls');
    return {
      messageDirection: getComputedStyle(controls).flexDirection,
      globalDirection: getComputedStyle(global).flexDirection,
      messageOnLeft: controls.getBoundingClientRect().right < turn.getBoundingClientRect().left,
      globalOnRight: global.getBoundingClientRect().left > innerWidth / 2,
      compactWidth: controls.getBoundingClientRect().width < 80
    };
  });
  assert.deepEqual(layout, {
    messageDirection: 'column', globalDirection: 'column',
    messageOnLeft: true, globalOnRight: true, compactWidth: true
  });

  const controlRects = () => page.evaluate(() => {
    const rect = selector => {
      const box = document.querySelector(selector).getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom };
    };
    return { message: rect('.cgpt-lite-message-controls'), global: rect('.cgpt-lite-global-controls') };
  });
  const originalRects = await controlRects();
  await page.evaluate(() => window.__updateSettings({
    keepRecentCount: 2, messageControlsSize: 150, messageControlsX: 100, messageControlsY: 30,
    globalControlsSize: 150, globalControlsRight: 80, globalControlsTop: 120
  }));
  await page.waitForTimeout(400);
  const adjustedRects = await controlRects();
  assert.ok(adjustedRects.message.width > originalRects.message.width);
  assert.ok(adjustedRects.message.x > originalRects.message.x);
  assert.equal(adjustedRects.message.y, originalRects.message.y + 30);
  assert.ok(adjustedRects.global.width > originalRects.global.width);
  assert.equal(adjustedRects.global.y, 120);
  assert.equal(adjustedRects.global.right, page.viewportSize().width - 80);
  await page.setViewportSize({ width: 360, height: 640 });
  await page.evaluate(() => window.__updateSettings({
    keepRecentCount: 2, messageControlsX: 600, messageControlsY: 600,
    globalControlsRight: 2000, globalControlsTop: 2000
  }));
  await page.waitForTimeout(400);
  const boundedRects = await controlRects();
  for (const rect of Object.values(boundedRects)) {
    assert.ok(rect.x >= 8 && rect.y >= 8);
    assert.ok(rect.right <= 352 && rect.bottom <= 632);
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.evaluate(() => window.__updateSettings({ keepRecentCount: 2 }));
  await page.waitForTimeout(400);

  const restoredOne = await page.evaluate(async function () {
    const node = document.querySelector("article.cgpt-lite-collapsed");
    const originalChild = node.firstElementChild;
    node.click();
    await new Promise(function (resolve) { setTimeout(resolve, 50); });
    return {
      nodeStillConnected: node.isConnected,
      childIdentityPreserved: node.firstElementChild === originalChild,
      collapsed: node.classList.contains("cgpt-lite-collapsed")
    };
  });
  assert.deepEqual(restoredOne, {
    nodeStillConnected: true,
    childIdentityPreserved: true,
    collapsed: false
  });

  const afterReactStyleUpdate = await page.evaluate(async function () {
    const node = document.querySelector("article.cgpt-lite-collapsed");
    const child = node.querySelector("p");
    child.appendChild(document.createTextNode(" React update."));
    await new Promise(function (resolve) { setTimeout(resolve, 300); });
    return {
      nodeStillConnected: node.isConnected,
      childStillConnected: child.isConnected,
      updateVisibleInDom: child.textContent.includes("React update."),
      identityPreserved: window.__originalTurnNodes.includes(node)
    };
  });
  assert.deepEqual(afterReactStyleUpdate, {
    nodeStillConnected: true,
    childStillConnected: true,
    updateVisibleInDom: true,
    identityPreserved: true
  });

  const expanded = await page.evaluate(async function () {
    await window.__sendExtensionMessage({ type: "expandAll" });
    return window.__sendExtensionMessage({ type: "getPageState" });
  });
  assert.equal(expanded.collapsedCount, 0);

  const collapsedAgain = await page.evaluate(async function () {
    document.querySelector('[data-action="global-collapse-all"]').click();
    await new Promise(function (resolve) { setTimeout(resolve, 100); });
    return {
      state: await window.__sendExtensionMessage({ type: "getPageState" }),
      allOriginalNodesConnected: window.__originalTurnNodes.every(function (node) { return node.isConnected; })
    };
  });
  assert.equal(collapsedAgain.state.collapsedCount, 5);
  assert.equal(collapsedAgain.allOriginalNodesConnected, true);

  // A newly streamed reply stays open even after Collapse all and when complex
  // content arrives; explicit controls must still fold it across later scans.
  await page.evaluate(function () {
    document.querySelector('#conversation').insertAdjacentHTML('beforeend',
      '<article data-testid="conversation-turn-10"><div data-message-author-role="user"><p>New prompt</p></div></article>' +
      '<article data-testid="conversation-turn-11"><div data-message-author-role="assistant"><div class="markdown"><p>New reply in progress</p></div></div></article>');
  });
  const latest = page.locator('[data-testid="conversation-turn-11"]');
  await page.waitForTimeout(400);
  assert.equal(await latest.evaluate(node => node.classList.contains('cgpt-lite-collapsed')), false);
  await latest.locator('.markdown').evaluate(node => {
    node.insertAdjacentHTML('beforeend', '<pre><code>const answer = 42;</code></pre><span class="katex">x = 42</span>');
  });
  await page.waitForTimeout(400);
  assert.equal(await latest.evaluate(node => node.classList.contains('cgpt-lite-collapsed')), false);
  await latest.scrollIntoViewIfNeeded();
  const latestToggle = page.locator('.cgpt-lite-message-controls[data-message-id="msg-conversation-turn-11"] [data-action="message-toggle"]');
  await latestToggle.click();
  await page.waitForTimeout(400);
  assert.equal(await latest.evaluate(node => node.classList.contains('cgpt-lite-collapsed')), true);
  await latestToggle.click();
  await page.waitForTimeout(400);
  assert.equal(await latest.evaluate(node => node.classList.contains('cgpt-lite-collapsed')), false);
  await page.locator('[data-action="global-collapse-all"]').click();
  await page.waitForTimeout(400);
  assert.equal(await latest.evaluate(node => node.classList.contains('cgpt-lite-collapsed')), true);
  await page.locator('[data-action="global-expand-all"]').click();
  await page.waitForTimeout(400);
  assert.equal(await latest.evaluate(node => node.classList.contains('cgpt-lite-collapsed')), false);
  assert.deepEqual(errors, []);

  // A long reply follows scrolling until it reaches the configured top limit.
  await latest.evaluate(node => { node.style.minHeight = '1400px'; });
  await page.evaluate(() => window.__updateSettings({ keepRecentCount: 2, messageControlsTopLimit: 120 }));
  await page.waitForTimeout(400);
  const scrollReplyTo = async top => {
    await latest.evaluate((node, targetTop) => {
      window.scrollTo(0, window.scrollY + node.getBoundingClientRect().top - targetTop);
    }, top);
    await page.waitForTimeout(100);
  };
  const latestControls = page.locator('.cgpt-lite-message-controls[data-message-id="msg-conversation-turn-11"]');
  await scrollReplyTo(-100);
  assert.equal(await latestControls.evaluate(node => node.getBoundingClientRect().top), 120);
  await scrollReplyTo(-300);
  assert.equal(await latestControls.evaluate(node => node.getBoundingClientRect().top), 120);
  await scrollReplyTo(200);
  assert.equal(await latestControls.evaluate(node => node.getBoundingClientRect().top), 206);
  await page.setViewportSize({ width: 360, height: 400 });
  await page.evaluate(() => window.__updateSettings({ keepRecentCount: 2, messageControlsTopLimit: 600 }));
  await page.waitForTimeout(400);
  assert.ok(await latestControls.evaluate(node => node.getBoundingClientRect().bottom <= innerHeight - 8));
  await latest.evaluate(node => { node.style.minHeight = ''; });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.evaluate(() => {
    window.__updateSettings({ keepRecentCount: 2 });
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(400);

  page.on('console', message => {
    if (['warning', 'error'].includes(message.type())) errors.push(message.text());
  });
  await page.evaluate(() => {
    window.__originalGetMessage = chrome.i18n.getMessage;
    window.__originalStorageGet = chrome.storage.local.get;
  });
  for (const failure of ['runtime', 'i18n', 'storage']) {
    if (failure !== 'runtime') {
      await page.evaluate(() => {
        chrome.runtime.id = 'test-extension';
        chrome.i18n.getMessage = window.__originalGetMessage;
        chrome.storage.local.get = window.__originalStorageGet;
      });
      await page.addScriptTag({ content: contentScript });
      await page.waitForTimeout(400);
    }
    await page.locator('[data-action="global-collapse-all"]').click();
    await page.waitForTimeout(400);
    assert.ok(await page.locator('.cgpt-lite-collapsed').count() > 0);
    await page.evaluate(mode => {
      const invalidated = () => { throw new Error('Extension context invalidated.'); };
      if (mode === 'runtime') delete chrome.runtime.id;
      if (mode === 'i18n') chrome.i18n.getMessage = invalidated;
      if (mode === 'storage') {
        chrome.storage.local.get = async () => invalidated();
        document.querySelector('[data-action="global-expand-all"]').click();
      }
      document.querySelector('article p').append(' Trigger a scan.');
    }, failure);
    await page.waitForTimeout(500);
    assert.equal(await page.locator('.cgpt-lite-collapsed').count(), 0);
    assert.equal(await page.locator('.cgpt-lite-controls-layer, .cgpt-lite-global-controls').count(), 0);
    await page.evaluate(() => {
      document.querySelector('article p').append(' Still editable after cleanup.');
      window.dispatchEvent(new Event('scroll'));
    });
    await page.waitForTimeout(1100);
    assert.equal(await page.locator('.cgpt-lite-controls-layer, .cgpt-lite-global-controls').count(), 0);
    assert.deepEqual(errors, []);
  }

  const popup = await browser.newPage();
  popup.on('pageerror', error => errors.push(error.message));
  await popup.evaluate(() => {
    window.__savedSettings = { keepRecentCount: 3 };
    window.chrome = {
      i18n: { getMessage: () => '' },
      storage: { local: {
        get: async () => ({ settings: window.__savedSettings }),
        set: async ({ settings }) => { window.__savedSettings = settings; }
      } },
      tabs: { query: async () => [] }
    };
  });
  const popupHtml = fs.readFileSync(path.join(projectRoot, 'popup.html'), 'utf8').replace('<script src="popup.js"></script>', '');
  const openPopup = async () => {
    await popup.setContent(popupHtml);
    await popup.addStyleTag({ path: path.join(projectRoot, 'popup.css') });
    await popup.addScriptTag({ path: path.join(projectRoot, 'popup.js') });
  };
  await openPopup();
  assert.equal(await popup.locator('#messageControlsSize').inputValue(), '100');
  await popup.locator('#messageControlsSize').fill('140');
  await popup.locator('#messageControlsSize').dispatchEvent('change');
  await popup.locator('#messageControlsTopLimit').fill('80');
  await popup.locator('#messageControlsTopLimit').dispatchEvent('change');
  await popup.locator('#globalControlsRight').fill('95');
  await popup.locator('#globalControlsRight').dispatchEvent('change');
  await openPopup();
  assert.equal(await popup.locator('#messageControlsSize').inputValue(), '140');
  assert.equal(await popup.locator('#messageControlsTopLimit').inputValue(), '80');
  assert.equal(await popup.locator('#globalControlsRight').inputValue(), '95');
  await popup.locator('#messageControlsSize').fill('999');
  await popup.locator('#messageControlsSize').dispatchEvent('change');
  assert.equal(await popup.locator('#messageControlsSize').inputValue(), '180');
  await popup.locator('#resetButtonLayout').click();
  const saved = await popup.evaluate(() => window.__savedSettings);
  assert.equal(saved.messageControlsSize, 100);
  assert.equal(saved.messageControlsTopLimit, 8);
  assert.equal(saved.globalControlsRight, 18);
  assert.equal(saved.keepRecentCount, 3);
  assert.deepEqual(errors, []);

  console.log("content integration test passed");
  } finally {
    await browser.close();
  }
})().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
