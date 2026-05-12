/**
 * FB Lightning Scroller — content.js v5
 *
 * KEY INSIGHTS:
 *
 * 1. Facebook uses a virtual DOM — it REMOVES posts from the DOM as you scroll
 *    away. outerHTML must be captured while the post is in the viewport.
 *    Solution: MutationObserver watches for articles being ADDED to DOM and
 *    captures them immediately, before FB can remove them.
 *
 * 2. Single loop, not parallel. Scroll → wait for new articles to appear in
 *    DOM (MutationObserver signals this) → confirm captured → scroll again.
 *    Buffer is always in sync because we don't advance until capture is done.
 *
 * 3. Scroll wheel pause: listen for wheel + touchmove + keydown events.
 *    When detected, pause the engine for USER_PAUSE_MS ms. rAF-based scrollBy
 *    yields naturally to user input between frames.
 *
 * 4. FB infinite scroll trigger: the sentinel is ~600px above scrollHeight.
 *    We scroll to scrollHeight - 600, which reliably triggers the next batch.
 */

const SENTINEL_OFFSET  = 600;    // px above scrollHeight to trigger FB load
const STEP_PX          = 400;    // px per rAF frame during smooth scroll
const SETTLE_MS        = 800;    // ms to wait after scroll for FB to render
const MAX_WAIT_MS      = 8000;   // max ms waiting for new content before declaring bottom
const USER_PAUSE_MS    = 2000;   // ms to pause engine when user touches scroll
const RAM_LIMIT_MB     = 200;
const DB_NAME          = "FBScroller";
const DB_STORE         = "posts";

// ── State ──────────────────────────────────────────────────────────────────
let running         = false;
let paused          = false;
let pauseTimer      = null;
let db              = null;
let seenIds         = new Set();
let ramBuffer       = [];
let ramBytes        = 0;
let postCount       = 0;
let diskPostCount   = 0;
let flushCount      = 0;
let abortCtl        = null;
let mutationQueue   = [];        // articles detected by MutationObserver
let observer        = null;

// ── User scroll detection — pause engine when user touches scroll ───────────
function onUserScroll() {
  if (!running) return;
  paused = true;
  clearTimeout(pauseTimer);
  pauseTimer = setTimeout(() => { paused = false; }, USER_PAUSE_MS);
  setHUD(`⏸ Paused (user scroll) — resuming in ${USER_PAUSE_MS/1000}s…\n📦 ${postCount} posts buffered`);
}

function installScrollGuard() {
  window.addEventListener('wheel',     onUserScroll, { passive: true });
  window.addEventListener('touchmove', onUserScroll, { passive: true });
  window.addEventListener('keydown',   e => {
    if ([' ','ArrowDown','ArrowUp','PageDown','PageUp'].includes(e.key)) onUserScroll();
  }, { passive: true });
}
function removeScrollGuard() {
  window.removeEventListener('wheel',     onUserScroll);
  window.removeEventListener('touchmove', onUserScroll);
}

// ── MutationObserver — capture articles the moment FB adds them to DOM ──────
function startObserver() {
  observer = new MutationObserver(mutations => {
    for (const mut of mutations) {
      for (const node of mut.addedNodes) {
        if (node.nodeType !== 1) continue;
        // Direct article or contains articles
        const articles = node.matches('[role="article"]')
          ? [node]
          : [...node.querySelectorAll('[role="article"]')];
        for (const el of articles) {
          captureArticle(el);
        }
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

function stopObserver() {
  observer?.disconnect();
  observer = null;
}

// Capture an article element immediately into RAM
function captureArticle(el) {
  let key = el.dataset.fbsId;
  if (!key) {
    key = `p${seenIds.size}_${Math.random().toString(36).slice(2,7)}`;
    el.dataset.fbsId = key;
  }
  if (seenIds.has(key)) return false;
  seenIds.add(key);

  // Store outerHTML — captured NOW while FB hasn't recycled it yet
  const html = el.outerHTML;
  const sz   = html.length * 2;
  ramBytes  += sz;
  ramBuffer.push({ id: key, html, capturedAt: Date.now() });
  postCount++;
  return true;
}

// Also sweep anything currently visible (for posts already in DOM at start)
function sweepVisible() {
  document.querySelectorAll('[role="article"]').forEach(captureArticle);
}

// ── IndexedDB ──────────────────────────────────────────────────────────────
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 3);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains(DB_STORE))
        d.createObjectStore(DB_STORE, { autoIncrement: true });
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function flushToDisk() {
  if (!db || ramBuffer.length === 0) return;
  const batch = ++flushCount;
  const items = ramBuffer.splice(0);
  ramBytes    = 0;
  const tx = db.transaction(DB_STORE, "readwrite");
  const st = tx.objectStore(DB_STORE);
  for (const r of items) st.put({ batch, id: r.id, html: r.html, capturedAt: r.capturedAt });
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
  diskPostCount += items.length;
}

// ── Smooth scroll to a Y target, respecting pause and abort ───────────────
function smoothScrollTo(targetY, signal) {
  return new Promise(resolve => {
    function frame() {
      if (signal.aborted) { resolve(); return; }
      if (paused)         { setTimeout(() => requestAnimationFrame(frame), 100); return; }

      const cur  = window.scrollY;
      const diff = targetY - cur;
      if (Math.abs(diff) < 2) { resolve(); return; }

      const step = Math.sign(diff) * Math.min(STEP_PX, Math.abs(diff));
      window.scrollBy(0, step);
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  });
}

// Wait up to maxMs for at least one new article to be captured
function waitForNewPosts(countBefore, maxMs, signal) {
  return new Promise(resolve => {
    const deadline = Date.now() + maxMs;
    function check() {
      if (signal.aborted)          { resolve('aborted'); return; }
      if (postCount > countBefore) { resolve('got_posts'); return; }
      if (Date.now() > deadline)   { resolve('timeout'); return; }
      setTimeout(check, 100);
    }
    check();
  });
}

// Wait for the page to grow taller (FB loaded more content)
function waitForHeightGrowth(baseline, maxMs, signal) {
  return new Promise(resolve => {
    const deadline = Date.now() + maxMs;
    function check() {
      if (signal.aborted)                          { resolve(false); return; }
      if (document.body.scrollHeight > baseline)   { resolve(true);  return; }
      if (Date.now() > deadline)                   { resolve(false); return; }
      setTimeout(check, 100);
    }
    check();
  });
}

// ── Main loop — single sequential loop, buffer always in sync ─────────────
async function mainLoop(signal) {
  sweepVisible();  // capture anything already on screen

  let stallCount = 0;

  while (!signal.aborted) {
    // Wait while user is scrolling
    while (paused && !signal.aborted) {
      await new Promise(r => setTimeout(r, 100));
    }
    if (signal.aborted) break;

    const heightBefore = document.body.scrollHeight;
    const postsBefore  = postCount;
    const target       = heightBefore - SENTINEL_OFFSET;

    // 1. Scroll smoothly to the sentinel zone
    await smoothScrollTo(target, signal);
    if (signal.aborted) break;

    // 2. Wait a beat for FB's IntersectionObserver to fire and request new posts
    await new Promise(r => setTimeout(r, SETTLE_MS));
    if (signal.aborted) break;

    // 3. Wait for page to actually grow (new content appended)
    const grew = await waitForHeightGrowth(heightBefore, MAX_WAIT_MS, signal);
    if (signal.aborted) break;

    if (!grew) {
      stallCount++;
      if (stallCount >= 2) {
        // Confirmed bottom
        sweepVisible();
        await flushToDisk();
        setHUD(`✅ Done! ${postCount} posts | ${flushCount} disk batches | ${diskPostCount} on disk`);
        running = false;
        return;
      }
      // Try once more
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }
    stallCount = 0;

    // 4. Wait for the MutationObserver to capture the new posts
    await waitForNewPosts(postsBefore, 3000, signal);

    // 5. Flush RAM if needed (non-blocking to scroll)
    const ramMB = ramBytes / 1024 / 1024;
    if (ramMB >= RAM_LIMIT_MB) {
      setHUD(`💾 RAM full (${ramMB.toFixed(1)} MB) — flushing to disk…`);
      await flushToDisk();
    }

    // 6. Update HUD
    const scrollable = Math.max(1, document.body.scrollHeight - window.innerHeight);
    const pct  = Math.min(100, Math.round((window.scrollY / scrollable) * 100));
    setHUD(
      `⚡ ${pct}% scrolled\n` +
      `📦 RAM: ${postCount} posts (${(ramBytes/1024/1024).toFixed(1)} MB)\n` +
      `💾 Disk: ${diskPostCount} posts (${flushCount} batches)`
    );
  }

  // Aborted cleanly
  sweepVisible();
  await flushToDisk();
  setHUD(`⏹ Stopped — ${postCount} posts captured | ${flushCount} disk batches`);
  running = false;
}

// ── HUD ────────────────────────────────────────────────────────────────────
let hud = null;
function ensureHUD() {
  if (hud && document.body.contains(hud)) return;
  hud = document.createElement("div");
  hud.id = "__fbs_hud";
  Object.assign(hud.style, {
    position:"fixed", bottom:"18px", right:"18px", zIndex:"2147483647",
    background:"rgba(5,5,15,0.93)", color:"#00ff99",
    font:"700 12px/1.7 'Courier New',monospace",
    padding:"12px 16px", borderRadius:"9px",
    border:"1px solid rgba(0,255,153,0.3)",
    maxWidth:"340px", whiteSpace:"pre-line",
    boxShadow:"0 0 20px rgba(0,255,153,0.15)",
    pointerEvents:"none", userSelect:"none",
  });
  document.body.appendChild(hud);
}
function setHUD(msg)  { ensureHUD(); hud.textContent = `⚡ Lightning Scroller\n${msg}`; }
function removeHUD()  { hud?.remove(); hud = null; }

// ── MV3-safe message listener ──────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

  if (msg.action === "start") {
    if (running) { sendResponse({ ok: false, reason: "Already running" }); return false; }

    running       = true;
    paused        = false;
    ramBuffer     = []; ramBytes = 0;
    seenIds       = new Set();
    postCount     = 0; diskPostCount = 0; flushCount = 0;
    abortCtl      = new AbortController();

    sendResponse({ ok: true });

    ensureHUD();
    setHUD("Opening IndexedDB…");
    installScrollGuard();
    startObserver();

    openDB()
      .then(d  => { db = d; })
      .catch(e => console.warn("[FBS] IndexedDB:", e))
      .finally(() => {
        setHUD("🚀 Running…");
        mainLoop(abortCtl.signal);
      });

    return false;
  }

  if (msg.action === "stop") {
    abortCtl?.abort();
    stopObserver();
    removeScrollGuard();
    sendResponse({ ok: true, postCount, flushCount });
    return false;
  }

  if (msg.action === "status") {
    sendResponse({ running, postCount, flushCount, ramMB: (ramBytes/1024/1024).toFixed(2) });
    return false;
  }

  if (msg.action === "clear") {
    abortCtl?.abort();
    stopObserver();
    removeScrollGuard();
    running = false;
    ramBuffer = []; ramBytes = 0; postCount = 0; diskPostCount = 0; flushCount = 0;
    seenIds.clear();
    if (db) try { db.transaction(DB_STORE,"readwrite").objectStore(DB_STORE).clear(); } catch(_){}
    removeHUD();
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
