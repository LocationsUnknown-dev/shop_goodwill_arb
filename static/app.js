const hoursSlider = document.getElementById("hoursSlider");
const hoursLabel = document.getElementById("hoursLabel");
const minProfit = document.getElementById("minProfit");
const scanBtn = document.getElementById("scanBtn");
const clearClosedBtn = document.getElementById("clearClosedBtn");
const scanStatus = document.getElementById("scanStatus");
const itemsBody = document.getElementById("itemsBody");

let items = [];

hoursSlider.addEventListener("input", () => {
  hoursLabel.textContent = hoursSlider.value;
});
minProfit.addEventListener("input", render);

function selectedMode() {
  return document.querySelector('input[name="mode"]:checked').value;
}

function setStatus(msg, isError = false) {
  scanStatus.textContent = msg;
  scanStatus.classList.toggle("error", isError);
}

function fmtMoney(n) {
  if (n === null || n === undefined || isNaN(n)) return "—";
  const v = Number(n);
  return (v < 0 ? "-$" : "$") + Math.abs(v).toFixed(2);
}

function fmtEndsIn(iso) {
  const end = new Date(iso).getTime();
  const now = Date.now();
  const diff = end - now;
  if (diff <= 0) return "ended";
  const h = Math.floor(diff / 3.6e6);
  const m = Math.floor((diff % 3.6e6) / 6e4);
  return h >= 1 ? `${h}h ${m}m` : `${m}m`;
}

function render() {
  const minPct = parseFloat(minProfit.value) || 0;
  itemsBody.innerHTML = "";

  const visible = items.filter((it) => {
    if (it.status === "closed") return true; // always show closed
    return (it.profit_pct ?? -Infinity) >= minPct;
  });

  if (visible.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="8" class="empty">
      No items match. Try scanning or lowering the profit % filter.
    </td>`;
    itemsBody.appendChild(tr);
    return;
  }

  for (const it of visible) {
    const tr = document.createElement("tr");
    if (it.status === "closed") tr.classList.add("closed");

    const profitClass = it.profit > 0 ? "positive" : "negative";
    const modeBadge = it.model_mode
      ? `<span class="badge ${it.model_mode}">${it.model_mode}</span>`
      : "";
    const confBadge = it.confidence
      ? `<span class="badge confidence-${it.confidence}">${it.confidence}</span>`
      : "—";
    const statusBadge = it.status === "closed"
      ? `<span class="badge closed">Auction Closed</span>` : "";

    const sourcesHtml = (it.sources && it.sources.length)
      ? `<div class="reasoning">Sources: ${it.sources
          .map((s) => s.startsWith("http")
            ? `<a href="${s}" target="_blank" rel="noopener">${new URL(s).hostname}</a>`
            : s)
          .join(", ")}</div>`
      : "";

    tr.innerHTML = `
      <td class="title-cell">
        <span class="title">${escapeHtml(it.title)} ${statusBadge} ${modeBadge}</span>
        <a href="${it.url}" target="_blank" rel="noopener">View listing →</a>
        <div class="reasoning">${escapeHtml(it.reasoning || "")}</div>
        ${sourcesHtml}
      </td>
      <td>${fmtMoney(it.total_cost)}<br><small>bid ${fmtMoney(it.current_bid)}</small></td>
      <td>${fmtMoney(it.estimated_resale)}</td>
      <td class="profit ${profitClass}">
        ${fmtMoney(it.profit)}
        <br><small>${it.profit_pct != null ? it.profit_pct.toFixed(1) + "%" : ""}</small>
      </td>
      <td>${fmtMoney(it.max_bid)}</td>
      <td>${fmtEndsIn(it.end_time)}</td>
      <td>${confBadge}</td>
      <td class="actions">
        <button data-rescan="${it.id}" data-mode="cheap">Rescan cheap</button>
        <button data-rescan="${it.id}" data-mode="accurate">Rescan accurate</button>
      </td>
    `;
    itemsBody.appendChild(tr);
  }
}

function escapeHtml(s) {
  if (!s) return "";
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function refresh() {
  try {
    const r = await fetch("/api/items");
    items = await r.json();
    render();
  } catch (e) {
    setStatus("Failed to load items: " + e.message, true);
  }
}

async function runScan() {
  scanBtn.disabled = true;
  setStatus("Scanning…");
  try {
    const r = await fetch("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        max_hours: parseInt(hoursSlider.value, 10),
        mode: selectedMode(),
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "scan failed");
    setStatus(
      `Fetched ${data.fetched} listings · analyzed ${data.analyzed} new · skipped ${data.skipped} already seen`
    );
    items = data.items || [];
    render();
  } catch (e) {
    setStatus("Scan failed: " + e.message, true);
  } finally {
    scanBtn.disabled = false;
  }
}

async function rescanOne(itemId, mode) {
  setStatus(`Rescanning item ${itemId} (${mode})…`);
  try {
    const r = await fetch(`/api/scan/${itemId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "rescan failed");
    const idx = items.findIndex((x) => x.id === itemId);
    if (idx >= 0) items[idx] = data;
    render();
    setStatus(`Rescanned item ${itemId}.`);
  } catch (e) {
    setStatus("Rescan failed: " + e.message, true);
  }
}

async function clearClosed() {
  try {
    const r = await fetch("/api/clear-closed", { method: "POST" });
    const data = await r.json();
    items = data.items || [];
    render();
    setStatus(`Removed ${data.deleted} closed items.`);
  } catch (e) {
    setStatus("Clear failed: " + e.message, true);
  }
}

scanBtn.addEventListener("click", runScan);
clearClosedBtn.addEventListener("click", clearClosed);
itemsBody.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-rescan]");
  if (!btn) return;
  const id = parseInt(btn.getAttribute("data-rescan"), 10);
  const mode = btn.getAttribute("data-mode");
  rescanOne(id, mode);
});

// Initial load + poll every 60s to auto-close expired auctions.
refresh();
setInterval(refresh, 60000);
