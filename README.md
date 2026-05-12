<div align="center">
  <img src="icons/logo_full.png" width="96" alt="Lightning Scroller"/>
  <h1>⚡ Lightning Scroller</h1>
  <p><strong>Blast through Facebook's infinite feed at maximum speed.</strong><br/>
  Posts are captured to RAM then flushed to disk — automatically, reliably.</p>

  ![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4a9eff?style=flat-square&logo=googlechrome&logoColor=white)
  ![Manifest V3](https://img.shields.io/badge/Manifest-V3-00cc77?style=flat-square)
</div>

---

## 🚀 One-Click Install Page

Open **`install.html`** in your browser for a guided one-click installer with step-by-step instructions.

Or follow the manual steps below.

---

## 📦 Manual Installation (~60 seconds)

| Step | Action |
|------|--------|
| **1** | [Download ZIP](https://github.com/ZCHGorg/Lightning-Scroller/archive/refs/heads/main.zip) and unzip to a **permanent folder** (don't delete it after installing) |
| **2** | Open Chrome → navigate to `chrome://extensions` |
| **3** | Toggle **Developer mode** ON (top-right corner) |
| **4** | Click **Load unpacked** → select the unzipped `Lightning-Scroller` folder |
| **5** | The ⚡ icon appears in your toolbar — done |

---

## 🎯 How to Use

1. Go to **facebook.com** (home feed, groups, marketplace — any feed page)
2. Click the **⚡** toolbar icon
3. Press **▶ Start**

The green HUD overlay on the page shows live progress. The popup tracks posts buffered, RAM usage, and disk flush count.

**Scroll wheel / arrow keys** pause the engine for 2 seconds so you can read — it resumes automatically.

---

## 🧠 How It Works

```
MutationObserver
  └─ Fires the instant Facebook adds [role="article"] to DOM
  └─ Captures outerHTML before virtual-scroll recycling removes it
  └─ Stores to RAM buffer (up to 200 MB)
       └─ When RAM fills → flushes batch to IndexedDB (on-disk)

Scroll Engine
  └─ Targets Facebook's IntersectionObserver sentinel (scrollHeight - 600px)
  └─ Waits for page to grow before advancing (never outpaces loading)
  └─ rAF-based smooth scroll — doesn't fight Facebook's own scroll handlers
  └─ Detects user input (wheel/touch/keys) and pauses for 2s
```

### Storage layers

| Layer | Capacity | When used |
|-------|----------|-----------|
| **RAM (JS array)** | Up to 200 MB | Always, immediately |
| **IndexedDB (disk)** | Gigabytes | Auto-flush when RAM fills |

---

## ⚙️ Configuration

All tuning constants are at the top of `content.js`:

```js
const SENTINEL_OFFSET  = 600;    // px above scrollHeight to trigger FB load
const STEP_PX          = 400;    // px per rAF frame during scroll
const SETTLE_MS        = 800;    // ms to wait after scroll for FB to render
const MAX_WAIT_MS      = 8000;   // max wait for new content before declaring bottom
const USER_PAUSE_MS    = 2000;   // ms to pause when user touches scroll
const RAM_LIMIT_MB     = 200;    // flush RAM → IndexedDB at this threshold
```

---

## 📁 File Structure

```
Lightning-Scroller/
├── manifest.json      # Chrome Extension Manifest V3
├── content.js         # Core engine: MutationObserver + scroll loop
├── popup.html         # Extension popup UI
├── popup.js           # Popup logic + live status polling
├── install.html       # One-click installer page (open in browser)
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## 🛠️ Troubleshooting

**"Already running" in popup** — Click Stop, reload the Facebook tab, try again.

**Scroll stops after a few pages** — Make sure you're on the main feed (`facebook.com` or `facebook.com/`), not a standalone post page.

**Posts count not increasing** — Facebook may have changed their DOM structure. Open DevTools → Console and check for `[FBS]` log messages.

**IndexedDB errors** — Chrome's storage may be full. Go to `chrome://settings/content/all` and clear site data for facebook.com, then retry.

---

## 👥 Contributing

PRs welcome. Key areas for improvement:
- Export captured posts to JSON/CSV
- Support for Instagram and Twitter/X feeds  
- Chrome Web Store packaging

---

<div align="center">
  <sub>By <a href="https://github.com/ZCHGorg">ZCHG</a> · MIT License · Manifest V3 · Chrome only</sub>
</div>
