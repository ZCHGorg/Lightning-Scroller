const RAM_LIMIT_MB = 200;

const btnStart  = document.getElementById("btnStart");
const btnStop   = document.getElementById("btnStop");
const btnClear  = document.getElementById("btnClear");
const statusEl  = document.getElementById("statusText");
const statPosts = document.getElementById("statPosts");
const statFlush = document.getElementById("statFlush");
const ramBar    = document.getElementById("ramBar");
const ramLabel  = document.getElementById("ramLabel");

let pollInterval = null;

// ── Helpers ────────────────────────────────────────────────────────────────
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function setStatus(msg, cls = "") {
  statusEl.className = "status-text " + cls;
  statusEl.innerHTML = msg;
}

function updateStats({ postCount = 0, flushCount = 0, ramMB = 0 } = {}) {
  statPosts.textContent = postCount;
  statFlush.textContent = flushCount;
  const pct = Math.min(100, (ramMB / RAM_LIMIT_MB) * 100);
  ramBar.style.width = pct + "%";
  ramLabel.textContent = parseFloat(ramMB).toFixed(1) + " MB";
}

function setRunning(yes) {
  btnStart.disabled = yes;
  btnStop.disabled  = !yes;
  if (yes) {
    setStatus('<span class="spinner"></span>Scrolling…', "active");
  }
}

// ── Poll content script for live stats ────────────────────────────────────
function startPolling(tabId) {
  stopPolling();
  pollInterval = setInterval(async () => {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { action: "status" });
      if (!res) return;
      updateStats(res);
      if (!res.running) {
        stopPolling();
        setStatus(`✅ Done — ${res.postCount} posts | ${res.flushCount} disk batches`, "done");
        setRunning(false);
      } else {
        setStatus(
          `<span class="spinner"></span>${res.postCount} posts · RAM ${parseFloat(res.ramMB).toFixed(1)} MB`,
          "active"
        );
      }
    } catch (_) { /* tab might have navigated */ }
  }, 600);
}

function stopPolling() {
  clearInterval(pollInterval);
  pollInterval = null;
}

// ── Button Handlers ────────────────────────────────────────────────────────
btnStart.addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab || !tab.url?.includes("facebook.com")) {
    setStatus("⚠ Navigate to facebook.com first.", "error");
    return;
  }
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { action: "start" });
    if (res?.ok) {
      setRunning(true);
      startPolling(tab.id);
    } else {
      setStatus("⚠ " + (res?.reason || "Unknown error"), "error");
    }
  } catch (e) {
    setStatus("⚠ Can't reach page. Reload Facebook and try again.", "error");
  }
});

btnStop.addEventListener("click", async () => {
  const tab = await getActiveTab();
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { action: "stop" });
    stopPolling();
    setRunning(false);
    setStatus(`⏹ Stopped — ${res?.postCount || "?"} posts | ${res?.flushCount || 0} disk batches`, "done");
  } catch (_) {}
});

btnClear.addEventListener("click", async () => {
  const tab = await getActiveTab();
  stopPolling();
  try { await chrome.tabs.sendMessage(tab.id, { action: "clear" }); } catch (_) {}
  updateStats();
  setStatus("🗑 Cleared all buffered data.");
  setRunning(false);
});

// ── Init: read current state ───────────────────────────────────────────────
(async () => {
  const tab = await getActiveTab();
  if (!tab?.url?.includes("facebook.com")) {
    setStatus("Navigate to facebook.com to begin.");
    return;
  }
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { action: "status" });
    if (res) {
      updateStats(res);
      if (res.running) {
        setRunning(true);
        startPolling(tab.id);
      }
    }
  } catch (_) {}
})();
