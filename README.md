# ChatGPT Thread Collapse

A very long ChatGPT web conversation can become noticeably sluggish, so this project started as an idea for a Chrome extension that folds long threads into a lighter view.

This project was built in a vibe coding style using Codex.

It is a local Chrome extension for long ChatGPT threads. The extension safely collapses older assistant messages and skips their layout and paint work while leaving ChatGPT-owned DOM nodes intact.

## What it does

- Collapses older assistant messages into lightweight placeholders while keeping recent replies expanded
- Restores any folded message on demand
- Keeps code blocks, equations, copy buttons, and normal scrolling intact
- Adds thread-level controls for expand all, collapse all, nearby expand, restore previous collapsed view, and reset thread state
- Shows per-message `Expand`, `Collapse`, and `Lock` controls in a separate extension overlay
- Stores settings and per-thread state locally in `chrome.storage.local`

## Why it helps

Long ChatGPT threads slow down because many assistant messages require layout and paint work. This extension applies rendering containment to old messages without detaching React-managed nodes, which keeps ChatGPT state consistent while making long conversations lighter.

That means:

- Less layout and paint work while scrolling
- Lower layout and paint cost on long conversations
- Manual control over what stays expanded
- React-safe folding: ChatGPT page nodes remain attached and can be updated normally

## Install

1. Open Chrome and go to `chrome://extensions/`
2. Turn on Developer mode
3. Click `Load unpacked`
4. Select the `chatgpt-thread-lite-extension` folder
5. Open `https://chatgpt.com/` or `https://chat.openai.com/`

## How to use

After the extension loads, it will start scanning assistant messages in the current conversation.

You can control it in two places:

- In the vertically stacked floating controls on the right, with `Collapse all` and `Expand all`
- On the left of each visible assistant message, with compact vertically stacked `Expand` / `Collapse` and `Lock` buttons
- In the popup, where you can change settings and manage the current thread

## Settings

The popup lets you:

- Enable or disable the extension
- Change how many recent assistant messages stay expanded
- Prefer collapsing code-heavy or formula-heavy old messages
- Adjust message and global button sizes independently (60–180%)
- Move message buttons with horizontal/vertical offsets, and global buttons with top/right distances; positions stay inside the viewport
- Restore default button positions and sizes without resetting other settings
- Expand nearby collapsed messages
- Expand all collapsed messages in the current thread
- Restore the previous collapsed view
- Re-collapse old messages
- Reset the current thread state

Open the extension popup and scroll to **Button position and size**. Changes save automatically and apply to open ChatGPT pages. Message offsets are relative to the left side of each reply: positive values move right/down. Global distances are measured from the window's right/top edges.

Under **Message buttons**, **Top scroll limit (px)** sets where the buttons stop as you scroll upward past a reply's start (8–600 px, default 8). Set it to 80, for example, to keep the buttons below a header. In short windows, the limit is reduced as needed to keep the buttons visible.

## Internationalization

This project already includes a minimal i18n setup:

- Chinese is the default locale
- English resources are prefilled under `_locales/en`
- UI strings are routed through `chrome.i18n.getMessage`

If you want to add more languages later, copy `_locales/en/messages.json` into a new locale folder and fill in the translations.

## Project structure

```text
chatgpt-thread-lite-extension/
├── manifest.json
├── content.js
├── content.css
├── popup.html
├── popup.js
├── popup.css
├── _locales/
│   ├── zh_CN/messages.json
│   └── en/messages.json
└── README.md
```

## Notes for maintainers

- All ChatGPT selector logic is centralized in `content.js` under `SELECTORS`
- If ChatGPT changes its DOM, update message detection before touching UI code
- The latest assistant reply stays expanded by default, including while streaming code or formulas. It can still be collapsed manually or with **Collapse all** unless locked; older replies follow the automatic collapse settings.

## Compatibility and safety

Version 1.2 no longer removes or replaces ChatGPT conversation nodes. Per-message controls live in a separate extension overlay. Collapsed turns stay in the live React tree and are reduced with CSS containment, preventing the `Content failed to load` failure caused by external DOM replacement.

## Development

There is no bundler and no external CDN dependency. Edit the files directly and reload the unpacked extension in Chrome.

After reloading or updating the extension, refresh existing ChatGPT tabs to load the new content script. If the old script loses its extension context, it stops its observers and timers, removes its controls, and restores collapsed messages without changing saved settings.

If GitHub CLI login fails with `error connecting to github.com`, it usually means the terminal network path is blocked or not using the same proxy/VPN settings as the browser. In that case, fix terminal connectivity first, then run:

```bash
gh auth login
gh auth status
```

## License

This repository is distributed under the MIT License. See [LICENSE](./LICENSE) for the full text.
