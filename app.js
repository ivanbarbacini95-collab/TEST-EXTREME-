/* =========================================================
   Injective Portfolio • v2.0.2
   app.js — FULL FILE (no cuts)
   ========================================================= */

/* ================= CONFIG ================= */
const INITIAL_SETTLE_TIME = 4200;

const ACCOUNT_POLL_MS = 2000;
const REST_SYNC_MS = 60000;
const CHART_SYNC_MS = 60000;

const DAY_MINUTES = 24 * 60;
const ONE_MIN_MS = 60_000;

const STAKE_TARGET_MAX = 1000;
const REWARD_WITHDRAW_THRESHOLD = 0.0002; // INJ

/* persistence versions */
const STAKE_LOCAL_VER = 3; // bumped: labels store timestamps for cross-device merge
const REWARD_WD_LOCAL_VER = 2;
const NW_LOCAL_VER = 2;    // bumped: allow live window state + scale
const EV_LOCAL_VER = 1;

/* net worth limits */
const NW_MAX_POINTS = 4800;

/* Net Worth live window */
const NW_LIVE_WINDOW_MS = 2 * 60 * 1000; // ✅ 2 minutes (as requested)

/* cloud */
const CLOUD_API = "/api/point";
const CLOUD_PUSH_DEBOUNCE_MS = 1200;
const CLOUD_PULL_INTERVAL_MS = 45_000;

/* refresh mode staging */
const REFRESH_RED_MS = 220;

/* ================= HELPERS ================= */
const $ = (id) => document.getElementById(id);
const clamp = (n, a, b) => Math.min(Math.max(n, a), b);
const safe = (n) => (Number.isFinite(+n) ? +n : 0);

function pad2(n) { return String(n).padStart(2, "0"); }

function fmtHHMM(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function fmtHHMMSS(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/* storage-label (timestamp) helpers */
function tsLabel(ms = Date.now()) { return String(Math.floor(ms)); }
function labelToTs(lbl) {
  if (lbl == null) return 0;
  const s = String(lbl).trim();
  if (/^\d{10,13}$/.test(s)) return safe(s);
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

/* UI labels */
function nowLabel() { return new Date().toLocaleTimeString(); }
function shortAddr(a) { return a && a.length > 18 ? (a.slice(0, 10) + "…" + a.slice(-6)) : (a || ""); }
function setText(id, txt) { const el = $(id); if (el) el.textContent = txt; }

function fmtSmart(v){
  v = safe(v);
  const av = Math.abs(v);
  if (av >= 1000) return v.toFixed(0);
  if (av >= 100) return v.toFixed(1);
  if (av >= 10) return v.toFixed(2);
  if (av >= 1) return v.toFixed(3);
  if (av >= 0.1) return v.toFixed(4);
  return v.toFixed(6);
}

function hasInternet() { return navigator.onLine === true; }

/* ================= GLOBAL ERROR GUARDS ================= */
function setStatusError(msg){
  const statusText = $("statusText");
  const statusDot = $("statusDot");
  if (statusText) statusText.textContent = msg || "Error";
  if (statusDot) statusDot.style.background = "#ef4444";
}

window.addEventListener("error", (e) => {
  setStatusError("JS Error");
  console.error("JS Error:", e?.error || e);
});
window.addEventListener("unhandledrejection", (e) => {
  setStatusError("Promise Error");
  console.error("Promise Error:", e?.reason || e);
});

/* ================= THEME / MODE ================= */
const THEME_KEY = "inj_theme";
const MODE_KEY  = "inj_mode"; // live | refresh

let theme = localStorage.getItem(THEME_KEY) || "dark";
let liveMode = (localStorage.getItem(MODE_KEY) || "live") === "live";

function axisGridColor() {
  return (document.body.dataset.theme === "light") ? "rgba(15,23,42,.14)" : "rgba(249,250,251,.10)";
}
function axisTickColor() {
  return (document.body.dataset.theme === "light") ? "rgba(15,23,42,.65)" : "rgba(249,250,251,.60)";
}

function applyTheme(t){
  theme = (t === "light") ? "light" : "dark";
  document.body.dataset.theme = theme;
  localStorage.setItem(THEME_KEY, theme);
  const themeIcon = $("themeIcon");
  if (themeIcon) themeIcon.textContent = theme === "dark" ? "🌙" : "☀️";
  refreshChartsTheme();
}

/* ================= CHARTJS ZOOM REGISTER (NO CRASH) ================= */
let ZOOM_OK = false;
function tryRegisterZoom(){
  try{
    if (!window.Chart) return false;
    const plug = window.ChartZoom || window["chartjs-plugin-zoom"];
    if (plug) Chart.register(plug);
    const has = !!(Chart?.registry?.plugins?.get && Chart.registry.plugins.get("zoom"));
    return has;
  } catch (e){
    console.warn("Zoom plugin not available:", e);
    return false;
  }
}

/* ================= CONNECTION UI ================= */
const statusDot  = $("statusDot");
const statusText = $("statusText");

let wsTradeOnline = false;
let wsKlineOnline = false;
let accountOnline = false;

let refreshLoaded = false;
let refreshLoading = false;
let modeLoading = false;

function liveReady(){
  const socketsOk = wsTradeOnline && wsKlineOnline;
  const accountOk = !address || accountOnline;
  return socketsOk && accountOk;
}

function refreshConnUI() {
  if (!statusDot || !statusText) return;

  if (!hasInternet()) {
    statusText.textContent = "Offline";
    statusDot.style.background = "#ef4444";
    return;
  }

  const loadingNow =
    modeLoading ||
    refreshLoading ||
    (!liveMode && !refreshLoaded) ||
    (liveMode && !liveReady());

  if (loadingNow) {
    statusText.textContent = "Loading...";
    statusDot.style.background = "#f59e0b";
    return;
  }

  statusText.textContent = "Online";
  statusDot.style.background = "#22c55e";
}

/* ================= UI READY FAILSAFE ================= */
function setUIReady(force=false){
  const root = $("appRoot");
  if (!root) return;
  if (root.classList.contains("ready")) return;
  if (!force && !tfReady.d) return;
  root.classList.remove("loading");
  root.classList.add("ready");
}

/* ================= SAFE FETCH ================= */
async function fetchJSON(url, opts = {}) {
  try {
    const res = await fetch(url, { cache: "no-store", ...opts });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } catch (e) {
    return null;
  }
}

/* ================= SMOOTH DISPLAY ================= */
let settleStart = Date.now();
function scrollSpeed() {
  const t = Math.min((Date.now() - settleStart) / INITIAL_SETTLE_TIME, 1);
  const base = 0.08;
  const maxExtra = 0.80;
  return base + (t * t) * maxExtra;
}
function tick(cur, tgt) {
  if (!Number.isFinite(tgt)) return cur;
  return cur + (tgt - cur) * scrollSpeed();
}

/* ================= COLORED DIGITS ================= */
function colorNumber(el, n, o, d) {
  if (!el) return;
  n = safe(n); o = safe(o);
  const ns = n.toFixed(d), os = o.toFixed(d);
  if (ns === os) { el.textContent = ns; return; }
  el.innerHTML = [...ns].map((c, i) => {
    const col = c !== os[i]
      ? (n > o ? "#22c55e" : "#ef4444")
      : (document.body.dataset.theme === "light" ? "#0f172a" : "#f9fafb");
    return `<span style="color:${col}">${c}</span>`;
  }).join("");
}

/* money with digit coloring */
function colorMoney(el, n, o, decimals = 2){
  if (!el) return;
  n = safe(n); o = safe(o);
  const ns = n.toFixed(decimals);
  const os = o.toFixed(decimals);
  if (ns === os) { el.textContent = `$${ns}`; return; }

  const baseCol = (document.body.dataset.theme === "light") ? "#0f172a" : "#f9fafb";
  const upCol = "#22c55e";
  const dnCol = "#ef4444";
  const dir = (n > o) ? "up" : "down";

  const out = [`<span style="color:${baseCol}">$</span>`];
  for (let i = 0; i < ns.length; i++){
    const c = ns[i];
    const oc = os[i];
    const col = (c !== oc) ? (dir === "up" ? upCol : dnCol) : baseCol;
    out.push(`<span style="color:${col}">${c}</span>`);
  }
  el.innerHTML = out.join("");
}

/* ================= PERF ================= */
function pctChange(price, open) {
  const p = safe(price), o = safe(open);
  if (!o) return 0;
  const v = ((p - o) / o) * 100;
  return Number.isFinite(v) ? v : 0;
}
function updatePerf(arrowId, pctId, v) {
  const arrow = $(arrowId), pct = $(pctId);
  if (!arrow || !pct) return;

  if (v > 0) { arrow.textContent = "▲"; arrow.className = "arrow up"; pct.className = "pct up"; }
  else if (v < 0) { arrow.textContent = "▼"; arrow.className = "arrow down"; pct.className = "pct down"; }
  else { arrow.textContent = "►"; arrow.className = "arrow flat"; pct.className = "pct flat"; }

  pct.textContent = Math.abs(v).toFixed(2) + "%";
}

/* ================= BAR RENDER ================= */
function renderBar(bar, line, val, open, low, high, gradUp, gradDown) {
  if (!bar || !line) return;

  open = safe(open); low = safe(low); high = safe(high); val = safe(val);

  if (!open || !Number.isFinite(low) || !Number.isFinite(high) || high === low) {
    line.style.left = "50%";
    bar.style.left = "50%";
    bar.style.width = "0%";
    bar.style.background = "rgba(255,255,255,0.10)";
    return;
  }

  const range = Math.max(Math.abs(high - open), Math.abs(open - low));
  const min = open - range;
  const max = open + range;

  const pos = clamp(((val - min) / (max - min)) * 100, 0, 100);
  const center = 50;

  line.style.left = pos + "%";

  if (val >= open) {
    bar.style.left = center + "%";
    bar.style.width = Math.max(0, pos - center) + "%";
    bar.style.background = gradUp;
  } else {
    bar.style.left = pos + "%";
    bar.style.width = Math.max(0, center - pos) + "%";
    bar.style.background = gradDown;
  }
}

/* ================= FLASH EXTREMES ================= */
const lastExtremes = { d:{low:null,high:null}, w:{low:null,high:null}, m:{low:null,high:null} };
function flash(el) {
  if (!el) return;
  el.classList.remove("flash-yellow");
  void el.offsetWidth;
  el.classList.add("flash-yellow");
}

/* ================= ADDRESS / SEARCH ================= */
const searchWrap = $("searchWrap");
const searchBtn = $("searchBtn");
const addressInput = $("addressInput");
const addressDisplay = $("addressDisplay");
const menuBtn = $("menuBtn");

let address = localStorage.getItem("inj_address") || "";
let pendingAddress = address || "";

function setAddressDisplay(addr) {
  if (!addressDisplay) return;
  if (!addr) { addressDisplay.innerHTML = ""; return; }
  addressDisplay.innerHTML = `<span class="tag"><strong>Wallet:</strong> ${shortAddr(addr)}</span>`;
}
setAddressDisplay(address);

function openSearch() {
  if (!searchWrap) return;
  searchWrap.classList.add("open");
  document.body.classList.add("search-open");
  setTimeout(() => addressInput?.focus(), 20);
}
function closeSearch() {
  if (!searchWrap) return;
  searchWrap.classList.remove("open");
  document.body.classList.remove("search-open");
  addressInput?.blur();
}

if (addressInput) addressInput.value = ""; // ✅ start empty (we show wallet in display)

if (searchBtn) {
  searchBtn.addEventListener("click", (e) => {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    if (!searchWrap.classList.contains("open")) openSearch();
    else addressInput?.focus();
  }, { passive: false });
}

if (addressInput) {
  addressInput.addEventListener("focus", () => openSearch(), { passive: true });

  addressInput.addEventListener("input", (e) => { pendingAddress = e.target.value.trim(); }, { passive: true });

  addressInput.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const v = pendingAddress;
      await commitAddress(v);
      // ✅ keep wallet displayed, but clear input for next search
      addressInput.value = "";
      pendingAddress = "";
      closeSearch();
    } else if (e.key === "Escape") {
      e.preventDefault();
      addressInput.value = "";
      pendingAddress = "";
      closeSearch();
    }
  });
}

/* close search only if clicking outside */
document.addEventListener("click", (e) => {
  if (!searchWrap) return;
  if (searchWrap.contains(e.target)) return;
  closeSearch();
}, { passive: true });

/* ================= DRAWER MENU ================= */
const backdrop = $("backdrop");
const drawer = $("drawer");
const drawerNav = $("drawerNav");
const themeToggle = $("themeToggle");
const liveToggle = $("liveToggle");
const liveIcon = $("liveIcon");
const modeHint = $("modeHint");

/* cloud status in menu */
const cloudDotMenu = $("cloudDotMenu");
const cloudTextMenu = $("cloudTextMenu");
const cloudPtsMenu = $("cloudPtsMenu");

let isDrawerOpen = false;

function openDrawer(){
  isDrawerOpen = true;
  document.body.classList.add("drawer-open");
  drawer?.setAttribute("aria-hidden", "false");
  backdrop?.setAttribute("aria-hidden", "false");
}
function closeDrawer(){
  isDrawerOpen = false;
  document.body.classList.remove("drawer-open");
  drawer?.setAttribute("aria-hidden", "true");
  backdrop?.setAttribute("aria-hidden", "true");
}
function toggleDrawer(){ isDrawerOpen ? closeDrawer() : openDrawer(); }

menuBtn?.addEventListener("click", (e) => {
  e?.preventDefault?.();
  e?.stopPropagation?.();
  toggleDrawer();
}, { passive: false });

backdrop?.addEventListener("click", () => closeDrawer(), { passive:true });

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeDrawer();
    closeComingSoon();
    exitFullscreenCard();
  }
});

themeToggle?.addEventListener("click", (e) => {
  e?.preventDefault?.();
  applyTheme(theme === "dark" ? "light" : "dark");
}, { passive:false });

/* ================= COMING SOON overlay (FIX CLOSE) ================= */
const comingSoon = $("comingSoon");
const comingTitle = $("comingTitle");
const comingSub = $("comingSub");
const comingClose = $("comingClose");

function pageLabel(key){
  if (key === "home") return "HOME";
  if (key === "market") return "MARKET";
  if (key === "settings") return "SETTINGS";
  return "PAGE";
}

function openComingSoon(pageKey){
  if (!comingSoon) return;
  if (comingTitle) comingTitle.textContent = `COMING SOON 🚀`;
  if (comingSub) comingSub.textContent = `${pageLabel(pageKey)} is coming soon.`;
  comingSoon.classList.add("show");
  comingSoon.setAttribute("aria-hidden", "false");
}
function closeComingSoon(){
  if (!comingSoon) return;
  comingSoon.classList.remove("show");
  comingSoon.setAttribute("aria-hidden", "true");
}

/* ✅ close always works: stop propagation, and also close if click outside card */
comingClose?.addEventListener("click", (e) => {
  e?.preventDefault?.();
  e?.stopPropagation?.();
  closeComingSoon();
}, { passive:false });

comingSoon?.addEventListener("click", (e) => {
  if (e.target === comingSoon) closeComingSoon();
}, { passive:true });

/* ================= PAGES (Dashboard / Events) ================= */
const pageDashboard = $("pageDashboard");
const pageEvents = $("pageEvents");

function showPage(key){
  // hide all
  pageDashboard?.classList.remove("active");
  pageEvents?.classList.remove("active");

  if (key === "events") pageEvents?.classList.add("active");
  else pageDashboard?.classList.add("active");
}

/* nav active */
function setActivePage(pageKey){
  const items = drawerNav?.querySelectorAll(".nav-item") || [];
  items.forEach(btn => btn.classList.toggle("active", btn.dataset.page === pageKey));
}

drawerNav?.addEventListener("click", (e) => {
  const btn = e.target?.closest(".nav-item");
  if (!btn) return;
  const page = btn.dataset.page || "dashboard";
  setActivePage(page);
  closeDrawer();

  if (page === "dashboard") {
    closeComingSoon();
    showPage("dashboard");
  } else if (page === "event" || page === "events") {
    closeComingSoon();
    showPage("events");
    renderEvents();
  } else {
    showPage("dashboard"); // keep dashboard under overlay
    openComingSoon(page);
  }
}, { passive:true });

/* ================= FULLSCREEN CARD (expand icon) ================= */
let expandedCard = null;
let expandedBackdrop = null;
const expandedHiddenMap = new Map();

function buildExpandedBackdrop(){
  if (expandedBackdrop) return;
  const bd = document.createElement("div");
  bd.style.position = "fixed";
  bd.style.inset = "0";
  bd.style.background = "rgba(0,0,0,0.50)";
  bd.style.backdropFilter = "blur(10px)";
  bd.style.zIndex = "190";
  bd.addEventListener("click", () => exitFullscreenCard(), { passive:true });
  document.body.appendChild(bd);
  expandedBackdrop = bd;
}

function hideNonChartContent(card){
  const hidden = [];
  // keep: card-tools + any element that contains a canvas
  const keepSet = new Set();
  const tools = card.querySelector(".card-tools");
  if (tools) keepSet.add(tools);

  const canvases = card.querySelectorAll("canvas");
  canvases.forEach(cv => {
    keepSet.add(cv);
    let p = cv.parentElement;
    while (p && p !== card) { keepSet.add(p); p = p.parentElement; }
  });

  // hide direct children not in keep chain
  [...card.children].forEach(ch => {
    if (keepSet.has(ch)) return;
    // if any kept ancestor contains this, don't hide it
    let ok = false;
    for (const k of keepSet) {
      if (k && k !== ch && k.contains && k.contains(ch)) { ok = true; break; }
    }
    if (ok) return;

    hidden.push([ch, ch.style.display]);
    ch.style.display = "none";
  });

  expandedHiddenMap.set(card, hidden);
}

function restoreNonChartContent(card){
  const hidden = expandedHiddenMap.get(card) || [];
  hidden.forEach(([el, disp]) => { el.style.display = disp || ""; });
  expandedHiddenMap.delete(card);
}

function enterFullscreenCard(card){
  if (!card) return;
  if (expandedCard) exitFullscreenCard();
  expandedCard = card;

  buildExpandedBackdrop();
  expandedBackdrop.style.display = "block";

  document.body.classList.add("card-expanded");
  card.classList.add("fullscreen");
  hideNonChartContent(card);

  // ensure charts resize properly
  setTimeout(() => {
    try { chart?.resize?.(); } catch {}
    try { stakeChart?.resize?.(); } catch {}
    try { rewardChart?.resize?.(); } catch {}
    try { netWorthChart?.resize?.(); } catch {}
  }, 120);
}

function exitFullscreenCard(){
  if (!expandedCard) return;
  restoreNonChartContent(expandedCard);
  expandedCard.classList.remove("fullscreen");
  document.body.classList.remove("card-expanded");
  expandedBackdrop && (expandedBackdrop.style.display = "none");
  expandedCard = null;

  setTimeout(() => {
    try { chart?.resize?.(); } catch {}
    try { stakeChart?.resize?.(); } catch {}
    try { rewardChart?.resize?.(); } catch {}
    try { netWorthChart?.resize?.(); } catch {}
  }, 120);
}

function bindExpandButtons(){
  const btns = document.querySelectorAll(".card-expand");
  btns.forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const card = btn.closest(".card");
      if (!card) return;
      if (card === expandedCard) exitFullscreenCard();
      else enterFullscreenCard(card);
    }, { passive:false });
  });
}

/* ================= EVENTS SYSTEM ================= */
let eventsAll = [];

function evStoreKey(addr){
  const a = (addr || "").trim();
  return a ? `inj_events_v${EV_LOCAL_VER}_${a}` : null;
}

function loadEvents(){
  const key = evStoreKey(address);
  if (!key) { eventsAll = []; return; }
  try{
    const raw = localStorage.getItem(key);
    if (!raw) { eventsAll = []; return; }
    const obj = JSON.parse(raw);
    if (!Array.isArray(obj?.events)) { eventsAll = []; return; }
    eventsAll = obj.events.slice(0, 1200);
  } catch {
    eventsAll = [];
  }
}

function saveEvents(){
  const key = evStoreKey(address);
  if (!key) return;
  try{
    localStorage.setItem(key, JSON.stringify({ v: EV_LOCAL_VER, t: Date.now(), events: eventsAll.slice(0, 1200) }));
  } catch {}
}

function showToast(ev){
  const host = $("toastHost");
  if (!host) return;

  const el = document.createElement("div");
  el.className = "toast";

  const when = fmtHHMMSS(ev.ts || Date.now());
  const title = ev.title || "Event";
  const sub = ev.detail || "";

  el.innerHTML = `
    <div class="toast-row">
      <div class="toast-title">${title}</div>
      <div style="font-weight:900;opacity:.82;font-size:.82rem">${when}</div>
    </div>
    <div class="toast-sub">${sub}</div>
  `;

  host.appendChild(el);

  setTimeout(() => {
    try { host.removeChild(el); } catch {}
  }, 2600);
}

function pushEvent(ev){
  if (!address) return;
  const obj = {
    id: ev.id || (String(Date.now()) + "_" + Math.random().toString(16).slice(2)),
    ts: ev.ts || Date.now(),
    kind: ev.kind || "info",
    title: ev.title || "Event",
    detail: ev.detail || "",
    amount: ev.amount ?? null,
    dir: ev.dir || null, // up|down|null
    status: ev.status || "pending" // pending|ok|err
  };
  eventsAll.unshift(obj);
  eventsAll = eventsAll.slice(0, 1200);
  saveEvents();
  renderEvents();
  showToast(obj);

  // simulate “pending → ok” for tx-like events
  if (obj.status === "pending" && obj.kind !== "price") {
    setTimeout(() => {
      const idx = eventsAll.findIndex(x => x.id === obj.id);
      if (idx >= 0) {
        eventsAll[idx].status = hasInternet() ? "ok" : "err";
        saveEvents();
        renderEvents();
      }
    }, 1500);
  }
}

function renderEvents(){
  const body = $("eventsTableBody");
  const empty = $("eventsEmpty");
  if (!body) return;

  body.innerHTML = "";
  const list = eventsAll || [];

  if (empty) empty.style.display = list.length ? "none" : "block";
  if (!list.length) return;

  for (const ev of list){
    const tr = document.createElement("tr");

    const dt = new Date(ev.ts || Date.now());
    const when = `${dt.toLocaleDateString()} ${fmtHHMMSS(ev.ts || Date.now())}`;

    const pillDotClass = (ev.status === "ok") ? "ev-dot ok" : (ev.status === "err") ? "ev-dot err" : "ev-dot";
    const arrow = ev.dir === "up" ? `<span class="ev-arrow up">▲</span>` : ev.dir === "down" ? `<span class="ev-arrow down">▼</span>` : "";
    const kind = (ev.kind || "info").toUpperCase();

    tr.innerHTML = `
      <td>
        <span class="ev-pill"><span class="${pillDotClass}"></span>${kind}</span>
      </td>
      <td>${ev.title || "Event"}</td>
      <td style="white-space:nowrap">${when}</td>
      <td>${arrow} ${ev.detail || ""}</td>
    `;
    body.appendChild(tr);
  }
}

$("eventsClearBtn")?.addEventListener("click", (e) => {
  e.preventDefault();
  eventsAll = [];
  saveEvents();
  renderEvents();
}, { passive:false });

/* ================= MODE SWITCH + PULL TO REFRESH ================= */
let accountPollTimer = null;
let restSyncTimer = null;
let chartSyncTimer = null;
let ensureChartTimer = null;
let cloudPullTimer = null;

function stopAllTimers(){
  if (accountPollTimer) { clearInterval(accountPollTimer); accountPollTimer = null; }
  if (restSyncTimer) { clearInterval(restSyncTimer); restSyncTimer = null; }
  if (chartSyncTimer) { clearInterval(chartSyncTimer); chartSyncTimer = null; }
  if (ensureChartTimer) { clearInterval(ensureChartTimer); ensureChartTimer = null; }
  if (cloudPullTimer) { clearInterval(cloudPullTimer); cloudPullTimer = null; }
}
function startAllTimers(){
  stopAllTimers();
  accountPollTimer = setInterval(loadAccount, ACCOUNT_POLL_MS);
  restSyncTimer = setInterval(loadCandleSnapshot, REST_SYNC_MS);
  chartSyncTimer = setInterval(loadChartToday, CHART_SYNC_MS);
  ensureChartTimer = setInterval(ensureChartBootstrapped, 1500);
  cloudPullTimer = setInterval(() => { if (address) cloudPull(); }, CLOUD_PULL_INTERVAL_MS);
}

async function refreshLoadAllOnce(){
  if (refreshLoading) return;
  if (!hasInternet()) { refreshLoaded = false; refreshConnUI(); cloudSetState("synced"); return; }

  refreshLoading = true;
  refreshLoaded = false;
  modeLoading = true;
  refreshConnUI();

  try{
    await loadCandleSnapshot(true);
    await loadChartToday(true);
    if (address) await loadAccount(true);
    refreshLoaded = true;
    modeLoading = false;
    refreshConnUI();
    setUIReady(true);
    cloudSetState("synced");
  } finally {
    refreshLoading = false;
    refreshConnUI();
  }
}

function setMode(isLive){
  liveMode = !!isLive;
  localStorage.setItem(MODE_KEY, liveMode ? "live" : "refresh");

  if (liveIcon) liveIcon.textContent = liveMode ? "📡" : "⟳";
  if (modeHint) modeHint.textContent = `Mode: ${liveMode ? "LIVE" : "REFRESH"}`;

  modeLoading = true;
  refreshConnUI();

  if (!liveMode) {
    stopAllTimers();
    stopAllSockets();
    wsTradeOnline = false;
    wsKlineOnline = false;
    accountOnline = false;

    refreshLoaded = false;
    refreshLoading = false;

    setTimeout(() => {
      refreshConnUI();
      refreshLoadAllOnce();
    }, REFRESH_RED_MS);

  } else {
    refreshLoaded = false;
    refreshLoading = false;

    startTradeWS();
    startKlineWS();
    loadCandleSnapshot();
    loadChartToday();
    if (address) loadAccount();
    startAllTimers();
    refreshConnUI();
  }
}

liveToggle?.addEventListener("click", (e) => {
  e?.preventDefault?.();
  setMode(!liveMode);
}, { passive:false });

/* ✅ Pull-to-refresh only in REFRESH mode */
let ptr = { startY: 0, pulling: false, shown: false };
let ptrEl = null;

function ensurePullSpinner(){
  if (ptrEl) return ptrEl;
  const el = document.createElement("div");
  el.id = "pullSpinner";
  el.style.position = "fixed";
  el.style.top = "10px";
  el.style.left = "50%";
  el.style.transform = "translateX(-50%)";
  el.style.zIndex = "160";
  el.style.width = "38px";
  el.style.height = "38px";
  el.style.borderRadius = "999px";
  el.style.border = "3px solid rgba(250,204,21,.25)";
  el.style.borderTopColor = "rgba(250,204,21,.95)";
  el.style.display = "none";
  el.style.boxShadow = "0 16px 70px rgba(0,0,0,.45)";
  el.style.background = "rgba(17,28,47,.65)";
  el.style.backdropFilter = "blur(8px)";
  el.style.animation = "spin 1s linear infinite";
  const st = document.createElement("style");
  st.textContent = `@keyframes spin{to{transform:translateX(-50%) rotate(360deg)}}`;
  document.head.appendChild(st);
  document.body.appendChild(el);
  ptrEl = el;
  return el;
}

function showPullSpinner(on){
  const el = ensurePullSpinner();
  el.style.display = on ? "block" : "none";
}

function initPullToRefresh(){
  let touchId = null;

  window.addEventListener("touchstart", (e) => {
    if (liveMode) return;                // ✅ only in refresh mode
    if (!hasInternet()) return;
    if (document.body.classList.contains("drawer-open")) return;
    if (document.body.classList.contains("card-expanded")) return;

    const atTop = (window.scrollY || document.documentElement.scrollTop || 0) <= 2;
    if (!atTop) return;

    const t = e.touches?.[0];
    if (!t) return;
    touchId = t.identifier;
    ptr.startY = t.clientY;
    ptr.pulling = true;
    ptr.shown = false;
  }, { passive: true });

  window.addEventListener("touchmove", (e) => {
    if (!ptr.pulling) return;
    const t = [...(e.touches || [])].find(x => x.identifier === touchId) || e.touches?.[0];
    if (!t) return;
    const dy = t.clientY - ptr.startY;
    if (dy > 85 && !ptr.shown) {
      ptr.shown = true;
      showPullSpinner(true);
    }
  }, { passive: true });

  window.addEventListener("touchend", async () => {
    if (!ptr.pulling) return;
    const doRefresh = ptr.shown;
    ptr.pulling = false;
    ptr.shown = false;

    if (!doRefresh) return;
    showPullSpinner(true);
    try{
      await refreshLoadAllOnce();
      pushEvent({ kind:"info", title:"Refresh", detail:"Data refreshed (REFRESH mode).", status:"ok" });
    } finally {
      setTimeout(() => showPullSpinner(false), 550);
    }
  }, { passive: true });

  window.addEventListener("touchcancel", () => {
    ptr.pulling = false; ptr.shown = false;
    showPullSpinner(false);
  }, { passive: true });
}

/* ================= STATE ================= */
let targetPrice = 0;
let displayed = { price: 0, available: 0, stake: 0, rewards: 0, netWorthUsd: 0, apr: 0 };

let availableInj = 0, stakeInj = 0, rewardsInj = 0, apr = 0;

const candle = {
  d: { t: 0, open: 0, high: 0, low: 0 },
  w: { t: 0, open: 0, high: 0, low: 0 },
  m: { t: 0, open: 0, high: 0, low: 0 },
};
const tfReady = { d: false, w: false, m: false };

/* ================= WS (price + klines) ================= */
let wsTrade = null;
let wsKline = null;
let tradeRetryTimer = null;
let klineRetryTimer = null;

function stopAllSockets(){
  try { wsTrade?.close(); } catch {}
  try { wsKline?.close(); } catch {}
  wsTrade = null; wsKline = null;
  if (tradeRetryTimer) { clearTimeout(tradeRetryTimer); tradeRetryTimer = null; }
  if (klineRetryTimer) { clearTimeout(klineRetryTimer); klineRetryTimer = null; }
}

function clearTradeRetry() {
  if (tradeRetryTimer) { clearTimeout(tradeRetryTimer); tradeRetryTimer = null; }
}
function scheduleTradeRetry() {
  clearTradeRetry();
  tradeRetryTimer = setTimeout(() => { if (liveMode) startTradeWS(); }, 1200);
}

function startTradeWS() {
  if (!liveMode) return;
  try { wsTrade?.close(); } catch {}

  wsTradeOnline = false;
  refreshConnUI();
  if (!hasInternet()) return;

  wsTrade = new WebSocket("wss://stream.binance.com:9443/ws/injusdt@trade");

  wsTrade.onopen = () => {
    wsTradeOnline = true;
    modeLoading = address ? !accountOnline : false;
    refreshConnUI();
    clearTradeRetry();
  };
  wsTrade.onclose = () => { wsTradeOnline = false; refreshConnUI(); scheduleTradeRetry(); };
  wsTrade.onerror = () => { wsTradeOnline = false; refreshConnUI(); try { wsTrade.close(); } catch {} scheduleTradeRetry(); };

  wsTrade.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    const p = safe(msg?.p);
    if (!p) return;

    targetPrice = p;

    if (tfReady.d) { candle.d.high = Math.max(candle.d.high, p); candle.d.low = Math.min(candle.d.low, p); }
    if (tfReady.w) { candle.w.high = Math.max(candle.w.high, p); candle.w.low = Math.min(candle.w.low, p); }
    if (tfReady.m) { candle.m.high = Math.max(candle.m.high, p); candle.m.low = Math.min(candle.m.low, p); }
  };
}

function clearKlineRetry() {
  if (klineRetryTimer) { clearTimeout(klineRetryTimer); klineRetryTimer = null; }
}
function scheduleKlineRetry() {
  clearKlineRetry();
  klineRetryTimer = setTimeout(() => { if (liveMode) startKlineWS(); }, 1200);
}

function applyKline(intervalKey, k) {
  const t = safe(k.t);
  const o = safe(k.o);
  const h = safe(k.h);
  const l = safe(k.l);
  if (o && h && l) {
    candle[intervalKey].t = t || candle[intervalKey].t;
    candle[intervalKey].open = o;
    candle[intervalKey].high = h;
    candle[intervalKey].low  = l;
    if (!tfReady[intervalKey]) {
      tfReady[intervalKey] = true;
      settleStart = Date.now();
    }
  }
}

function startKlineWS() {
  if (!liveMode) return;
  try { wsKline?.close(); } catch {}

  wsKlineOnline = false;
  refreshConnUI();
  if (!hasInternet()) return;

  const url =
    "wss://stream.binance.com:9443/stream?streams=" +
    "injusdt@kline_1m/" +
    "injusdt@kline_1d/" +
    "injusdt@kline_1w/" +
    "injusdt@kline_1M";

  wsKline = new WebSocket(url);

  wsKline.onopen = () => {
    wsKlineOnline = true;
    modeLoading = address ? !accountOnline : false;
    refreshConnUI();
    clearKlineRetry();
  };
  wsKline.onclose = () => { wsKlineOnline = false; refreshConnUI(); scheduleKlineRetry(); };
  wsKline.onerror = () => { wsKlineOnline = false; refreshConnUI(); try { wsKline.close(); } catch {} scheduleKlineRetry(); };

  wsKline.onmessage = async (e) => {
    let payload;
    try { payload = JSON.parse(e.data); } catch { return; }
    const data = payload?.data;
    const stream = payload?.stream || "";
    const k = data?.k;
    if (!k) return;

    if (stream.includes("@kline_1m")) {
      updateChartFrom1mKline(k);
      return;
    }

    if (stream.includes("@kline_1d")) applyKline("d", k);
    else if (stream.includes("@kline_1w")) applyKline("w", k);
    else if (stream.includes("@kline_1M")) applyKline("m", k);

    setUIReady(false);
  };
}

/* ================= ACCOUNT (Injective LCD) + VALIDATOR ================= */
let validator = { addr: "", moniker: "", status: "unknown" };
let validatorLoading = false;

function setValidatorUI(state){
  const nameEl = $("validatorName");
  const addrEl = $("validatorAddr");
  const dotEl  = $("validatorDot");

  if (nameEl) nameEl.textContent = validator.moniker || "Validator";
  if (addrEl) addrEl.textContent = validator.addr ? shortAddr(validator.addr) : "—";

  if (!dotEl) return;

  // ✅ request: dot yellow blinking at far right; also color based on state
  dotEl.classList.remove("ok","err");
  dotEl.style.background = "#f59e0b";

  if (!hasInternet()) {
    dotEl.classList.add("err");
    dotEl.style.background = "#ef4444";
    return;
  }

  if (state === "loading" || validatorLoading) {
    dotEl.style.background = "#f59e0b";
    return;
  }

  if (validator.status === "bonded" || validator.status === "active") {
    dotEl.classList.add("ok");
    dotEl.style.background = "#22c55e";
  } else if (validator.status === "unbonded" || validator.status === "jailed") {
    dotEl.classList.add("err");
    dotEl.style.background = "#ef4444";
  } else {
    dotEl.style.background = "#f59e0b";
  }
}

async function fetchValidatorInfo(valAddr){
  if (!valAddr) return;
  if (!hasInternet()) return;

  validatorLoading = true;
  setValidatorUI("loading");

  const base = "https://lcd.injective.network";
  const v = await fetchJSON(`${base}/cosmos/staking/v1beta1/validators/${valAddr}`);
  validatorLoading = false;

  if (!v?.validator) {
    validator.status = "unknown";
    setValidatorUI("ready");
    return;
  }

  const moniker = v.validator?.description?.moniker || "Validator";
  const jailed = !!v.validator?.jailed;
  const st = String(v.validator?.status || "").toLowerCase();

  validator.addr = valAddr;
  validator.moniker = moniker;

  // cosmos status values: BOND_STATUS_BONDED / etc
  if (jailed) validator.status = "jailed";
  else if (st.includes("bonded")) validator.status = "bonded";
  else if (st.includes("unbond")) validator.status = "unbonded";
  else validator.status = "unknown";

  setValidatorUI("ready");
}

async function loadAccount(isRefresh=false) {
  if (!isRefresh && !liveMode) return;

  if (!address || !hasInternet()) {
    accountOnline = false;
    refreshConnUI();
    setValidatorUI("ready");
    return;
  }

  const base = "https://lcd.injective.network";
  const [b, s, r, i] = await Promise.all([
    fetchJSON(`${base}/cosmos/bank/v1beta1/balances/${address}`),
    fetchJSON(`${base}/cosmos/staking/v1beta1/delegations/${address}`),
    fetchJSON(`${base}/cosmos/distribution/v1beta1/delegators/${address}/rewards`),
    fetchJSON(`${base}/cosmos/mint/v1beta1/inflation`)
  ]);

  if (!b || !s || !r || !i) {
    accountOnline = false;
    refreshConnUI();
    setValidatorUI("ready");
    return;
  }

  accountOnline = true;
  modeLoading = false;
  refreshConnUI();

  const bal = b.balances?.find(x => x.denom === "inj");
  availableInj = safe(bal?.amount) / 1e18;

  const del = (s.delegation_responses || []);
  stakeInj = del.reduce((a, d) => a + safe(d?.balance?.amount), 0) / 1e18;

  const newRewards = (r.rewards || []).reduce((a, x) => a + (x.reward || []).reduce((s2, y) => s2 + safe(y.amount), 0), 0) / 1e18;
  rewardsInj = newRewards;

  apr = safe(i.inflation) * 100;

  // ✅ validator (first delegation)
  const valAddr = del?.[0]?.delegation?.validator_address || "";
  if (valAddr && valAddr !== validator.addr) {
    validator.addr = valAddr;
    validator.moniker = "Loading…";
    validator.status = "unknown";
    setValidatorUI("loading");
    fetchValidatorInfo(valAddr);
  } else {
    setValidatorUI("ready");
  }

  // series updates
  maybeAddStakePoint(stakeInj);
  maybeRecordRewardWithdrawal(rewardsInj);

  // net worth point
  recordNetWorthPoint();

  setUIReady(true);
}

/* ================= BINANCE REST: snapshot candele 1D/1W/1M ================= */
async function loadCandleSnapshot(isRefresh=false) {
  if (!isRefresh && !liveMode) return;
  if (!hasInternet()) return;

  const [d, w, m] = await Promise.all([
    fetchJSON("https://api.binance.com/api/v3/klines?symbol=INJUSDT&interval=1d&limit=1"),
    fetchJSON("https://api.binance.com/api/v3/klines?symbol=INJUSDT&interval=1w&limit=1"),
    fetchJSON("https://api.binance.com/api/v3/klines?symbol=INJUSDT&interval=1M&limit=1"),
  ]);

  if (Array.isArray(d) && d[0]) {
    candle.d.t = safe(d[0][0]);
    candle.d.open = safe(d[0][1]);
    candle.d.high = safe(d[0][2]);
    candle.d.low  = safe(d[0][3]);
    if (candle.d.open && candle.d.high && candle.d.low) tfReady.d = true;
  }
  if (Array.isArray(w) && w[0]) {
    candle.w.t = safe(w[0][0]);
    candle.w.open = safe(w[0][1]);
    candle.w.high = safe(w[0][2]);
    candle.w.low  = safe(w[0][3]);
    if (candle.w.open && candle.w.high && candle.w.low) tfReady.w = true;
  }
  if (Array.isArray(m) && m[0]) {
    candle.m.t = safe(m[0][0]);
    candle.m.open = safe(m[0][1]);
    candle.m.high = safe(m[0][2]);
    candle.m.low  = safe(m[0][3]);
    if (candle.m.open && candle.m.high && candle.m.low) tfReady.m = true;
  }

  setUIReady(true);
}

/* ================= PRICE CHART (1D) ================= */
let chart = null;
let chartLabels = [];
let chartData = [];
let lastChartMinuteStart = 0;
let chartBootstrappedToday = false;

let hoverActive = false;
let hoverIndex = null;
let pinnedIndex = null;
let isPanning = false;

const verticalLinePlugin = {
  id: "verticalLinePlugin",
  afterDraw(ch) {
    if (!hoverActive || hoverIndex == null) return;
    const meta = ch.getDatasetMeta(0);
    const el = meta?.data?.[hoverIndex];
    if (!el) return;
    const ctx = ch.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(el.x, ch.chartArea.top);
    ctx.lineTo(el.x, ch.chartArea.bottom);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(250,204,21,0.9)";
    ctx.stroke();
    ctx.restore();
  }
};

function applyChartColorBySign(sign) {
  if (!chart) return;
  const ds = chart.data.datasets?.[0];
  if (!ds) return;

  if (sign === "up") {
    ds.borderColor = "#22c55e";
    ds.backgroundColor = "rgba(34,197,94,.20)";
  } else if (sign === "down") {
    ds.borderColor = "#ef4444";
    ds.backgroundColor = "rgba(239,68,68,.18)";
  } else {
    ds.borderColor = "#3b82f6";
    ds.backgroundColor = "rgba(59,130,246,.14)";
  }
  chart.update("none");
}

function updatePinnedOverlay() {
  const overlay = $("chartOverlay");
  const chartEl = $("chartPrice");
  if (!overlay || !chartEl || !chart) return;

  if (pinnedIndex == null) {
    overlay.classList.remove("show");
    chartEl.textContent = "--";
    return;
  }

  const ds = chart.data.datasets?.[0]?.data || [];
  const lbs = chart.data.labels || [];
  if (!ds.length || !lbs.length) {
    overlay.classList.remove("show");
    chartEl.textContent = "--";
    return;
  }

  let idx = Number.isFinite(+pinnedIndex) ? +pinnedIndex : null;
  if (idx == null) {
    overlay.classList.remove("show");
    chartEl.textContent = "--";
    return;
  }

  idx = clamp(Math.round(idx), 0, ds.length - 1);
  const price = safe(ds[idx]);
  const label = lbs[idx];
  if (!Number.isFinite(price) || !label) {
    overlay.classList.remove("show");
    chartEl.textContent = "--";
    return;
  }

  chartEl.textContent = `${label} • $${price.toFixed(4)}`;
  overlay.classList.add("show");
}

async function fetchKlines1mRange(startTime, endTime) {
  const out = [];
  let cursor = startTime;
  const end = endTime || Date.now();

  while (cursor < end && out.length < DAY_MINUTES) {
    const url = `https://api.binance.com/api/v3/klines?symbol=INJUSDT&interval=1m&limit=1000&startTime=${cursor}&endTime=${end}`;
    const d = await fetchJSON(url);
    if (!Array.isArray(d) || !d.length) break;

    out.push(...d);

    const lastOpenTime = safe(d[d.length - 1][0]);
    cursor = lastOpenTime + ONE_MIN_MS;

    if (!lastOpenTime) break;
    if (d.length < 1000) break;
  }
  return out.slice(0, DAY_MINUTES);
}

function initChartToday() {
  const canvas = $("priceChart");
  if (!canvas || !window.Chart) return;

  const zoomBlock = ZOOM_OK ? {
    zoom: {
      pan: {
        enabled: true,
        mode: "x",
        threshold: 2,
        onPanStart: () => { isPanning = true; },
        onPanComplete: ({ chart }) => {
          isPanning = false;
          const xScale = chart.scales.x;
          const center = (chart.chartArea.left + chart.chartArea.right) / 2;
          pinnedIndex = xScale.getValueForPixel(center);
          updatePinnedOverlay();
        }
      },
      zoom: {
        wheel: { enabled: true },
        pinch: { enabled: true },
        mode: "x",
        onZoomComplete: ({ chart }) => {
          const xScale = chart.scales.x;
          const center = (chart.chartArea.left + chart.chartArea.right) / 2;
          pinnedIndex = xScale.getValueForPixel(center);
          updatePinnedOverlay();
        }
      }
    }
  } : {};

  chart = new Chart(canvas, {
    type: "line",
    data: {
      labels: chartLabels,
      datasets: [{
        data: chartData,
        borderColor: "#3b82f6",
        backgroundColor: "rgba(59,130,246,.14)",
        fill: true,
        pointRadius: 0,
        tension: 0.3,
        cubicInterpolationMode: "monotone",
        spanGaps: true
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false },
        ...zoomBlock
      },
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { display: false },
        y: {
          ticks: { color: axisTickColor() },
          grid: { color: axisGridColor() }
        }
      }
    },
    plugins: [verticalLinePlugin]
  });

  setupChartInteractions();
}

async function loadChartToday(isRefresh=false) {
  if (!isRefresh && !liveMode) return;
  if (!hasInternet()) return;
  if (!tfReady.d || !candle.d.t) return;

  const kl = await fetchKlines1mRange(candle.d.t, Date.now());
  if (!kl.length) return;

  chartLabels = kl.map(k => fmtHHMM(safe(k[0])));
  chartData   = kl.map(k => safe(k[4]));
  lastChartMinuteStart = safe(kl[kl.length - 1][0]) || 0;

  const lastClose = safe(kl[kl.length - 1][4]);
  if (!targetPrice && lastClose) targetPrice = lastClose;

  if (!chart) initChartToday();
  if (chart) {
    chart.data.labels = chartLabels;
    chart.data.datasets[0].data = chartData;
    chart.update("none");
  }

  chartBootstrappedToday = true;
  setUIReady(true);
}

function setupChartInteractions() {
  const canvas = $("priceChart");
  if (!canvas || !chart) return;

  const getIndexFromEvent = (evt) => {
    const points = chart.getElementsAtEventForMode(evt, "index", { intersect: false }, false);
    if (!points || !points.length) return null;
    return points[0].index;
  };

  const handleMove = (evt) => {
    if (!chart) return;
    if (isPanning) return;

    const idx = getIndexFromEvent(evt);
    if (idx == null) return;

    hoverActive = true;
    hoverIndex = idx;
    pinnedIndex = idx;

    updatePinnedOverlay();
    chart.update("none");
  };

  const handleLeave = () => {
    hoverActive = false;
    hoverIndex = null;
    pinnedIndex = null;
    updatePinnedOverlay();
    if (chart) chart.update("none");
  };

  canvas.addEventListener("mousemove", handleMove, { passive: true });
  canvas.addEventListener("mouseleave", handleLeave, { passive: true });

  canvas.addEventListener("touchstart", (e) => handleMove(e), { passive: true });
  canvas.addEventListener("touchmove", (e) => handleMove(e), { passive: true });
  canvas.addEventListener("touchend", handleLeave, { passive: true });
  canvas.addEventListener("touchcancel", handleLeave, { passive: true });
}

async function ensureChartBootstrapped() {
  if (!liveMode) return;
  if (chartBootstrappedToday) return;
  if (!tfReady.d || !candle.d.t) await loadCandleSnapshot();
  if (tfReady.d && candle.d.t) await loadChartToday();
}

function updateChartFrom1mKline(k) {
  if (!liveMode) return;
  if (!chart || !chartBootstrappedToday || !tfReady.d || !candle.d.t) return;

  const openTime = safe(k.t);
  const close = safe(k.c);
  if (!openTime || !close) return;
  if (openTime < candle.d.t) return;

  if (lastChartMinuteStart === openTime) {
    const idx = chart.data.datasets[0].data.length - 1;
    if (idx >= 0) {
      chart.data.datasets[0].data[idx] = close;
      chart.update("none");
    }
    return;
  }

  lastChartMinuteStart = openTime;
  chart.data.labels.push(fmtHHMM(openTime));
  chart.data.datasets[0].data.push(close);

  while (chart.data.labels.length > DAY_MINUTES) chart.data.labels.shift();
  while (chart.data.datasets[0].data.length > DAY_MINUTES) chart.data.datasets[0].data.shift();

  chart.update("none");
}

/* ================= STAKE CHART (persist + cloud-ready labels) ================= */
let stakeChart = null;
let stakeLabels = [];
let stakeData = [];
let stakeMoves = [];
let stakeTypes = [];
let lastStakeRecordedRounded = null;
let stakeBaselineCaptured = false;

function stakeStoreKey(addr) {
  const a = (addr || "").trim();
  return a ? `inj_stake_series_v${STAKE_LOCAL_VER}_${a}` : null;
}

function clampArray(arr, max) {
  if (!Array.isArray(arr)) return [];
  if (arr.length <= max) return arr;
  return arr.slice(arr.length - max);
}

function saveStakeSeriesLocal() {
  const key = stakeStoreKey(address);
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify({
      v: STAKE_LOCAL_VER, t: Date.now(),
      labels: stakeLabels, data: stakeData, moves: stakeMoves, types: stakeTypes
    }));
    cloudBumpLocal(1);
  } catch {}
  cloudMarkDirty();
}

function loadStakeSeriesLocal() {
  const key = stakeStoreKey(address);
  if (!key) return false;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return false;
    const obj = JSON.parse(raw);
    if (!obj || obj.v !== STAKE_LOCAL_VER) return false;

    stakeLabels = Array.isArray(obj.labels) ? obj.labels : [];
    stakeData   = Array.isArray(obj.data)   ? obj.data   : [];
    stakeMoves  = Array.isArray(obj.moves)  ? obj.moves  : [];
    stakeTypes  = Array.isArray(obj.types)  ? obj.types  : [];

    const n = stakeData.length;
    stakeLabels = stakeLabels.slice(0, n);
    stakeMoves  = stakeMoves.slice(0, n);
    stakeTypes  = stakeTypes.slice(0, n);

    while (stakeMoves.length < n) stakeMoves.push(0);
    while (stakeTypes.length < n) stakeTypes.push("Stake update");

    stakeBaselineCaptured = stakeData.length > 0;
    lastStakeRecordedRounded = stakeData.length ? Number(safe(stakeData[stakeData.length - 1]).toFixed(6)) : null;
    return true;
  } catch {
    return false;
  }
}

function initStakeChart() {
  const canvas = $("stakeChart");
  if (!canvas || !window.Chart) return;

  stakeChart = new Chart(canvas, {
    type: "line",
    data: {
      labels: stakeLabels,
      datasets: [{
        data: stakeData,
        borderColor: "#22c55e",
        backgroundColor: "rgba(34,197,94,.18)",
        fill: true,
        tension: 0.25,
        cubicInterpolationMode: "monotone",
        spanGaps: true,
        pointRadius: 3,
        pointHoverRadius: 6,
        pointBackgroundColor: (ctx) => (stakeMoves[ctx.dataIndex] || 0) < 0 ? "#ef4444" : "#22c55e",
        pointBorderColor: (ctx) => (stakeMoves[ctx.dataIndex] || 0) < 0 ? "rgba(239,68,68,.95)" : "rgba(34,197,94,.90)",
        pointBorderWidth: 1
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          enabled: true,
          displayColors: false,
          callbacks: {
            title: (items) => {
              const lbl = stakeLabels[items?.[0]?.dataIndex ?? 0] || "";
              const ts = labelToTs(lbl);
              return ts ? `${new Date(ts).toLocaleDateString()} ${fmtHHMMSS(ts)}` : String(lbl);
            },
            label: (item) => {
              const i = item.dataIndex;
              const v = safe(stakeData[i]);
              const t = stakeTypes[i] || "Stake update";
              return `${t} • ${v.toFixed(6)} INJ`;
            }
          }
        },
        ...(ZOOM_OK ? { zoom: { pan: { enabled: true, mode: "x", threshold: 2 }, zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: "x" } } } : {})
      },
      scales: {
        x: {
          ticks: {
            color: axisTickColor(),
            callback: (val, idx) => {
              const ts = labelToTs(stakeLabels[idx]);
              return ts ? fmtHHMM(ts) : "";
            },
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 6
          },
          grid: { color: axisGridColor() }
        },
        y: { ticks: { color: axisTickColor() }, grid: { color: axisGridColor() } }
      }
    }
  });
}

function drawStakeChart() {
  if (!stakeChart) initStakeChart();
  if (stakeChart) {
    stakeChart.data.labels = stakeLabels;
    stakeChart.data.datasets[0].data = stakeData;
    stakeChart.update("none");
  }
}

function maybeAddStakePoint(currentStake) {
  const s = safe(currentStake);
  if (!Number.isFinite(s)) return;
  const rounded = Number(s.toFixed(6));

  if (!stakeBaselineCaptured) {
    stakeLabels.push(tsLabel());
    stakeData.push(rounded);
    stakeMoves.push(1);
    stakeTypes.push("Baseline (current)");
    lastStakeRecordedRounded = rounded;
    stakeBaselineCaptured = true;
    saveStakeSeriesLocal();
    drawStakeChart();
    return;
  }

  if (lastStakeRecordedRounded == null) { lastStakeRecordedRounded = rounded; return; }
  if (rounded === lastStakeRecordedRounded) return;

  const delta = rounded - lastStakeRecordedRounded;
  lastStakeRecordedRounded = rounded;

  stakeLabels.push(tsLabel());
  stakeData.push(rounded);
  stakeMoves.push(delta > 0 ? 1 : -1);
  stakeTypes.push(delta > 0 ? "Delegate / Compound" : "Undelegate");

  saveStakeSeriesLocal();
  drawStakeChart();

  // ✅ event
  pushEvent({
    kind: "tx",
    title: delta > 0 ? "Stake increased" : "Stake decreased",
    detail: `${delta > 0 ? "+" : ""}${delta.toFixed(6)} INJ`,
    status: "pending"
  });
}

/* ================= REWARD WITHDRAWALS (persist + cloud) ================= */
let wdLabelsAll = [];
let wdValuesAll = [];
let wdTimesAll  = [];

let wdLabels = [];
let wdValues = [];
let wdTimes  = [];

let wdLastRewardsSeen = null;
let wdMinFilter = 0;

function wdStoreKey(addr) {
  const a = (addr || "").trim();
  return a ? `inj_reward_withdrawals_v${REWARD_WD_LOCAL_VER}_${a}` : null;
}

function saveWdAllLocal() {
  const key = wdStoreKey(address);
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify({
      v: REWARD_WD_LOCAL_VER, t: Date.now(),
      labels: wdLabelsAll, values: wdValuesAll, times: wdTimesAll
    }));
    cloudBumpLocal(1);
  } catch {}
  cloudMarkDirty();
}

function loadWdAllLocal() {
  const key = wdStoreKey(address);
  if (!key) return false;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return false;
    const obj = JSON.parse(raw);
    if (!obj || obj.v !== REWARD_WD_LOCAL_VER) return false;

    wdLabelsAll = Array.isArray(obj.labels) ? obj.labels : [];
    wdValuesAll = Array.isArray(obj.values) ? obj.values : [];
    wdTimesAll  = Array.isArray(obj.times)  ? obj.times  : [];

    rebuildWdView();
    return true;
  } catch {
    return false;
  }
}

function rebuildWdView() {
  wdLabels = [];
  wdValues = [];
  wdTimes  = [];

  for (let i = 0; i < wdValuesAll.length; i++) {
    const v = safe(wdValuesAll[i]);
    if (v >= wdMinFilter) {
      wdLabels.push(wdLabelsAll[i]);
      wdValues.push(v);
      wdTimes.push(wdTimesAll[i] || 0);
    }
  }

  drawRewardWdChart();
  syncRewardTimelineUI(true);
}

const rewardPointLabelPlugin = {
  id: "rewardPointLabelPlugin",
  afterDatasetsDraw(ch) {
    const ds = ch.data.datasets?.[0];
    if (!ds) return;

    const meta = ch.getDatasetMeta(0);
    const dataEls = meta?.data || [];
    if (!dataEls.length) return;

    const xScale = ch.scales?.x;
    const n = ds.data.length;

    let min = xScale?.min;
    let max = xScale?.max;
    if (!Number.isFinite(min)) min = 0;
    if (!Number.isFinite(max)) max = n - 1;

    const visibleCount = Math.max(0, Math.floor(max - min + 1));
    if (visibleCount > 200) return;

    const ctx = ch.ctx;
    ctx.save();
    ctx.font = "800 11px Inter, sans-serif";
    ctx.fillStyle = (document.body.dataset.theme === "light")
      ? "rgba(15,23,42,0.88)"
      : "rgba(249,250,251,0.92)";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";

    const leftBound  = ch.chartArea.left + 6;
    const rightBound = ch.chartArea.right - 6;

    let drawn = 0;
    const maxDraw = 60;

    for (let i = Math.max(0, Math.floor(min)); i <= Math.min(n - 1, Math.ceil(max)); i++) {
      const el = dataEls[i];
      if (!el) continue;
      if (drawn >= maxDraw) break;

      const v = safe(ds.data[i]);
      const text = `+${v.toFixed(6)} INJ`;

      const halfW = ctx.measureText(text).width / 2;
      let x = el.x;
      x = Math.max(leftBound + halfW, Math.min(rightBound - halfW, x));

      let y = el.y - 10;
      y = Math.max(ch.chartArea.top + 12, y);

      ctx.fillText(text, x, y);
      drawn++;
    }
    ctx.restore();
  }
};

let rewardChart = null;

function initRewardWdChart() {
  const canvas = $("rewardChart");
  if (!canvas || !window.Chart) return;

  rewardChart = new Chart(canvas, {
    type: "line",
    data: {
      labels: wdLabels,
      datasets: [{
        data: wdValues,
        borderColor: "#3b82f6",
        backgroundColor: "rgba(59,130,246,.14)",
        fill: true,
        tension: 0.25,
        cubicInterpolationMode: "monotone",
        spanGaps: true,
        pointRadius: 4,
        pointHoverRadius: 6,
        pointBackgroundColor: "#3b82f6",
        pointBorderColor: "rgba(249,250,251,.6)",
        pointBorderWidth: 1
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      layout: { padding: { left: 18, right: 18, top: 6, bottom: 4 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          enabled: true,
          displayColors: false,
          callbacks: {
            title: (items) => {
              const i = items?.[0]?.dataIndex ?? 0;
              const ts = wdTimes[i] || labelToTs(wdLabels[i]);
              return ts ? `${new Date(ts).toLocaleDateString()} ${fmtHHMMSS(ts)}` : (wdLabels[i] || "");
            },
            label: (item) => `Withdrawn • +${safe(item.raw).toFixed(6)} INJ`
          }
        },
        ...(ZOOM_OK ? { zoom: { pan: { enabled: true, mode: "x", threshold: 2 }, zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: "x" } } } : {})
      },
      scales: {
        x: { ticks: { color: axisTickColor(), maxRotation: 0, autoSkip: true, maxTicksLimit: 6 }, grid: { color: axisGridColor() } },
        y: {
          position: "right",
          ticks: { color: axisTickColor(), mirror: true, padding: 6, callback: (val) => fmtSmart(val) },
          grid: { color: axisGridColor() }
        }
      }
    },
    plugins: [rewardPointLabelPlugin]
  });
}

function drawRewardWdChart() {
  if (!rewardChart) initRewardWdChart();
  if (rewardChart) {
    rewardChart.data.labels = wdLabels;
    rewardChart.data.datasets[0].data = wdValues;
    rewardChart.update("none");
  }
}

function syncRewardTimelineUI(forceToEnd=false) {
  const slider = $("rewardTimeline");
  const meta = $("rewardTimelineMeta");
  if (!slider || !meta) return;

  const n = wdValues.length;
  if (!n) {
    slider.min = 0; slider.max = 0; slider.value = 0;
    meta.textContent = "—";
    if (rewardChart) {
      rewardChart.options.scales.x.min = undefined;
      rewardChart.options.scales.x.max = undefined;
      rewardChart.update("none");
    }
    return;
  }

  slider.min = 0;
  slider.max = String(n - 1);
  if (forceToEnd) slider.value = String(n - 1);

  const idx = clamp(parseInt(slider.value || "0", 10), 0, n - 1);
  const win = Math.min(60, n);
  const minIdx = Math.max(0, idx - win + 1);
  const maxIdx = idx;

  if (rewardChart) {
    rewardChart.options.scales.x.min = minIdx;
    rewardChart.options.scales.x.max = maxIdx;
    rewardChart.update("none");
  }

  const fromTs = wdTimes[minIdx] || labelToTs(wdLabels[minIdx]);
  const toTs   = wdTimes[maxIdx] || labelToTs(wdLabels[maxIdx]);
  const from = fromTs ? fmtHHMM(fromTs) : (wdLabels[minIdx] || "");
  const to   = toTs ? fmtHHMM(toTs) : (wdLabels[maxIdx] || "");
  meta.textContent = n <= 1 ? `${to}` : `${from} → ${to}`;
}

function attachRewardTimelineHandlers() {
  const slider = $("rewardTimeline");
  slider?.addEventListener("input", () => syncRewardTimelineUI(false), { passive: true });
}
function goRewardLive() {
  const slider = $("rewardTimeline");
  if (slider) slider.value = String(Math.max(0, wdValues.length - 1));
  if (rewardChart?.resetZoom) rewardChart.resetZoom();
  syncRewardTimelineUI(true);
}
function attachRewardLiveHandler() {
  $("rewardLiveBtn")?.addEventListener("click", () => goRewardLive(), { passive: true });
}
function attachRewardFilterHandler() {
  const sel = $("rewardFilter");
  if (!sel) return;
  sel.addEventListener("change", () => {
    wdMinFilter = safe(sel.value);
    rebuildWdView();
    goRewardLive();
  }, { passive: true });
}

function maybeRecordRewardWithdrawal(newRewards) {
  const r = safe(newRewards);
  if (wdLastRewardsSeen == null) { wdLastRewardsSeen = r; return; }

  const diff = wdLastRewardsSeen - r;
  if (diff > REWARD_WITHDRAW_THRESHOLD) {
    const ts = Date.now();
    wdTimesAll.push(ts);
    wdLabelsAll.push(tsLabel(ts));
    wdValuesAll.push(diff);
    saveWdAllLocal();
    rebuildWdView();
    goRewardLive();

    pushEvent({
      kind: "tx",
      title: "Rewards withdrawn",
      detail: `+${diff.toFixed(6)} INJ`,
      status: "pending"
    });
  }
  wdLastRewardsSeen = r;
}

/* ================= NET WORTH (persist + chart) ================= */
let nwTf = "1d";         // 1d | 1w | 1m | 1y | all | live
let nwScale = "linear";  // linear | log
let nwTAll = [];
let nwUsdAll = [];
let nwInjAll = [];

let netWorthChart = null;
let nwHoverActive = false;
let nwHoverIndex = null;

function nwStoreKey(addr){
  const a = (addr || "").trim();
  return a ? `inj_networth_v${NW_LOCAL_VER}_${a}` : null;
}

function clampNWArrays(){
  const n = Math.min(nwTAll.length, nwUsdAll.length, nwInjAll.length);
  nwTAll = nwTAll.slice(-n);
  nwUsdAll = nwUsdAll.slice(-n);
  nwInjAll = nwInjAll.slice(-n);
  if (nwTAll.length > NW_MAX_POINTS){
    nwTAll = nwTAll.slice(-NW_MAX_POINTS);
    nwUsdAll = nwUsdAll.slice(-NW_MAX_POINTS);
    nwInjAll = nwInjAll.slice(-NW_MAX_POINTS);
  }
}

function saveNWLocal(){
  const key = nwStoreKey(address);
  if (!key) return;
  try{
    localStorage.setItem(key, JSON.stringify({
      v: NW_LOCAL_VER, t: Date.now(),
      tAll: nwTAll,
      usdAll: nwUsdAll,
      injAll: nwInjAll,
      tf: nwTf,
      scale: nwScale
    }));
    cloudBumpLocal(1);
  } catch {}
  cloudMarkDirty();
}

function loadNWLocal(){
  const key = nwStoreKey(address);
  if (!key) return false;
  try{
    const raw = localStorage.getItem(key);
    if (!raw) return false;
    const obj = JSON.parse(raw);
    if (!obj || obj.v !== NW_LOCAL_VER) return false;

    nwTAll = Array.isArray(obj.tAll) ? obj.tAll.map(Number) : [];
    nwUsdAll = Array.isArray(obj.usdAll) ? obj.usdAll.map(Number) : [];
    nwInjAll = Array.isArray(obj.injAll) ? obj.injAll.map(Number) : [];
    nwTf = typeof obj.tf === "string" ? obj.tf : "1d";
    nwScale = (obj.scale === "log") ? "log" : "linear";

    clampNWArrays();
    return true;
  } catch {
    return false;
  }
}

function nwWindowMs(tf){
  if (tf === "live") return NW_LIVE_WINDOW_MS;
  if (tf === "1w") return 7 * 24 * 60 * 60 * 1000;
  if (tf === "1m") return 30 * 24 * 60 * 60 * 1000;
  if (tf === "1y") return 365 * 24 * 60 * 60 * 1000;
  if (tf === "all") return 10 * 365 * 24 * 60 * 60 * 1000; // big
  return 24 * 60 * 60 * 1000;
}

function nwHasSpan(tf){
  if (!nwTAll.length) return false;
  const first = nwTAll[0];
  const span = Date.now() - first;
  return span >= nwWindowMs(tf) * 0.8;
}

/* build view: always left->right, no scroll except live window */
function nwBuildView(tf){
  const now = Date.now();
  const w = nwWindowMs(tf);
  const minT = (tf === "all") ? 0 : (now - w);

  const labels = [];
  const data = [];
  const times = [];

  for (let i = 0; i < nwTAll.length; i++){
    const t = safe(nwTAll[i]);
    const u = safe(nwUsdAll[i]);
    if (t >= minT && Number.isFinite(u) && u > 0) {
      times.push(t);
      labels.push(tsLabel(t)); // store label as ts
      data.push(u);
    }
  }

  // live: keep only last window (and this will "scroll" by filtering)
  if (tf === "live") {
    const liveMin = now - NW_LIVE_WINDOW_MS;
    const outL = [], outD = [], outT = [];
    for (let i = 0; i < times.length; i++){
      if (times[i] >= liveMin) { outT.push(times[i]); outL.push(labels[i]); outD.push(data[i]); }
    }
    return { labels: outL, data: outD, times: outT };
  }

  return { labels, data, times };
}

function nwApplySignStyling(sign){
  if (!netWorthChart) return;
  const ds = netWorthChart.data.datasets?.[0];
  if (!ds) return;

  if (sign === "up"){
    ds.borderColor = "#22c55e";
    ds.backgroundColor = "rgba(34,197,94,.16)";
  } else if (sign === "down"){
    ds.borderColor = "#ef4444";
    ds.backgroundColor = "rgba(239,68,68,.14)";
  } else {
    ds.borderColor = "#3b82f6";
    ds.backgroundColor = "rgba(59,130,246,.12)";
  }
  netWorthChart.update("none");
}

const nwVerticalLinePlugin = {
  id: "nwVerticalLinePlugin",
  afterDraw(ch){
    if (!nwHoverActive || nwHoverIndex == null) return;
    const meta = ch.getDatasetMeta(0);
    const el = meta?.data?.[nwHoverIndex];
    if (!el) return;
    const ctx = ch.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(el.x, ch.chartArea.top);
    ctx.lineTo(el.x, ch.chartArea.bottom);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(250,204,21,0.65)";
    ctx.stroke();
    ctx.restore();
  }
};

const nwLastDotPlugin = {
  id: "nwLastDotPlugin",
  afterDatasetsDraw(ch) {
    const ds = ch.data.datasets?.[0];
    if (!ds) return;

    const meta = ch.getDatasetMeta(0);
    const pts = meta?.data || [];
    if (!pts.length) return;

    const el = pts[pts.length - 1];
    if (!el) return;

    const t = Date.now();
    const pulse = 0.35 + 0.65 * Math.abs(Math.sin(t / 320));

    const ctx = ch.ctx;
    ctx.save();

    ctx.shadowColor = `rgba(250,204,21,${0.35 * pulse})`;
    ctx.shadowBlur = 10;

    ctx.beginPath();
    ctx.arc(el.x, el.y, 6.5, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(250,204,21,${0.22 * pulse})`;
    ctx.fill();

    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.arc(el.x, el.y, 3.2, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(250,204,21,${0.95 * pulse})`;
    ctx.fill();

    ctx.restore();
  }
};

function initNWChart(){
  const canvas = $("netWorthChart");
  if (!canvas || !window.Chart) return;

  const view = nwBuildView(nwTf);

  netWorthChart = new Chart(canvas, {
    type: "line",
    data: {
      labels: view.labels,
      datasets: [{
        data: view.data,
        borderColor: "#3b82f6",
        backgroundColor: "rgba(59,130,246,.12)",
        borderWidth: 2,
        fill: true,
        tension: 0.35,
        cubicInterpolationMode: "monotone",
        pointRadius: 0,
        pointHitRadius: 18,
        clip: { left: 0, top: 0, right: 22, bottom: 0 },
        spanGaps: true,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      normalized: true,
      layout: { padding: { left: 8, right: 34, top: 8, bottom: 12 } },

      plugins: {
        legend: { display: false },
        tooltip: { enabled: false },
        ...(ZOOM_OK ? {
          zoom: {
            pan: { enabled: true, mode: "x", threshold: 2 },
            zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: "x" }
          }
        } : {})
      },

      interaction: { mode: "index", intersect: false },

      scales: {
        x: {
          display: true,
          ticks: {
            color: axisTickColor(),
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 6,
            padding: 8,
            callback: (val, idx) => {
              const ts = labelToTs(netWorthChart?.data?.labels?.[idx]);
              return ts ? fmtHHMM(ts) : "";
            }
          },
          grid: { display: false },
          border: { display: false }
        },
        y: {
          type: (nwScale === "log") ? "logarithmic" : "linear",
          position: "right",
          ticks: {
            mirror: false,
            color: axisTickColor(),
            padding: 10,
            maxTicksLimit: 5,
            callback: (v) => `$${fmtSmart(v)}`
          },
          grid: { color: axisGridColor() },
          border: { display: false }
        }
      }
    },
    plugins: [nwVerticalLinePlugin, nwLastDotPlugin]
  });

  attachNWInteractions();
}

function drawNW(){
  if (!netWorthChart) initNWChart();
  if (!netWorthChart) return;

  const view = nwBuildView(nwTf);

  netWorthChart.data.labels = view.labels;
  netWorthChart.data.datasets[0].data = view.data;

  // update y scale type
  netWorthChart.options.scales.y.type = (nwScale === "log") ? "logarithmic" : "linear";

  netWorthChart.update("none");

  // pnl
  const pnlEl = $("netWorthPnl");
  if (view.data.length >= 2){
    const first = safe(view.data[0]);
    const last  = safe(view.data[view.data.length - 1]);
    const pnl = last - first;
    const pnlPct = first ? (pnl / first) * 100 : 0;

    if (pnlEl){
      pnlEl.classList.remove("good","bad","flat");
      const cls = pnl > 0 ? "good" : (pnl < 0 ? "bad" : "flat");
      pnlEl.classList.add(cls);
      const sign = pnl > 0 ? "+" : "";
      pnlEl.textContent = `PnL: ${sign}$${pnl.toFixed(2)} (${sign}${pnlPct.toFixed(2)}%)`;
      nwApplySignStyling(pnl > 0 ? "up" : (pnl < 0 ? "down" : "flat"));
    }
  } else {
    if (pnlEl){
      pnlEl.classList.remove("good","bad");
      pnlEl.classList.add("flat");
      pnlEl.textContent = "PnL: —";
      nwApplySignStyling("flat");
    }
  }

  updateNWTFButtons();
}

function updateNWTFButtons(){
  const wrap = $("nwTfSwitch");
  if (!wrap) return;
  const btns = wrap.querySelectorAll(".tf-btn");
  btns.forEach(b => {
    const tf = b.dataset.tf || "";
    // live always available
    const enabled = (tf === "live") ? true
      : (tf === "1d") ? true
      : (tf === "1w") ? nwHasSpan("1w")
      : (tf === "1m") ? nwHasSpan("1m")
      : (tf === "1y") ? nwHasSpan("1y")
      : (tf === "all") ? (nwTAll.length > 20)
      : true;

    b.disabled = !enabled;
    b.style.opacity = enabled ? "1" : "0.42";
    b.style.pointerEvents = enabled ? "auto" : "none";
    b.classList.toggle("active", (b.dataset.tf === nwTf));
  });
}

/* hover interactions */
function nwGetIndexFromEvent(evt){
  if (!netWorthChart) return null;
  const pts = netWorthChart.getElementsAtEventForMode(evt, "index", { intersect: false }, false);
  if (!pts || !pts.length) return null;
  return pts[0].index;
}

function nwShowHoverValue(idx){
  if (!netWorthChart) return;
  const data = netWorthChart.data.datasets?.[0]?.data || [];
  const labels = netWorthChart.data.labels || [];
  idx = clamp(idx, 0, data.length - 1);
  const v = safe(data[idx]);
  const ts = labelToTs(labels[idx]);
  if (!v) return;

  const el = $("netWorthUsd");
  if (el){
    el.textContent = `$${v.toFixed(2)}`;
  }
  const pnlEl = $("netWorthPnl");
  if (pnlEl){
    pnlEl.classList.remove("good","bad","flat");
    pnlEl.classList.add("flat");
    pnlEl.textContent = `Point: ${ts ? fmtHHMMSS(ts) : ""} • $${v.toFixed(2)}`;
  }
}

function attachNWInteractions(){
  const canvas = $("netWorthChart");
  if (!canvas || !netWorthChart) return;

  const onMove = (evt) => {
    const idx = nwGetIndexFromEvent(evt);
    if (idx == null) return;
    nwHoverActive = true;
    nwHoverIndex = idx;
    nwShowHoverValue(idx);
    netWorthChart.update("none");
  };

  const onLeave = () => {
    nwHoverActive = false;
    nwHoverIndex = null;
    netWorthChart.update("none");
  };

  canvas.addEventListener("mousemove", onMove, { passive: true });
  canvas.addEventListener("mouseleave", onLeave, { passive: true });

  canvas.addEventListener("touchstart", (e) => onMove(e), { passive: true });
  canvas.addEventListener("touchmove", (e) => onMove(e), { passive: true });
  canvas.addEventListener("touchend", onLeave, { passive: true });
  canvas.addEventListener("touchcancel", onLeave, { passive: true });
}

function attachNWTFHandlers(){
  const wrap = $("nwTfSwitch");
  if (!wrap) return;

  wrap.addEventListener("click", (e) => {
    const btn = e.target?.closest(".tf-btn");
    if (!btn) return;
    const tf = btn.dataset.tf || "1d";
    if (!["live","1d","1w","1m","1y","all"].includes(tf)) return;
    if (btn.disabled) return;

    nwTf = tf;
    saveNWLocal();
    drawNW();
  }, { passive:true });

  // scale toggle
  $("nwScaleBtn")?.addEventListener("click", (e) => {
    e.preventDefault();
    nwScale = (nwScale === "log") ? "linear" : "log";
    const b = $("nwScaleBtn");
    if (b) b.textContent = (nwScale === "log") ? "LOG" : "LIN";
    saveNWLocal();
    drawNW();
  }, { passive:false });

  // live toggle button
  $("nwLiveBtn")?.addEventListener("click", (e) => {
    e.preventDefault();
    const b = $("nwLiveBtn");
    const on = (nwTf === "live") ? false : true;
    nwTf = on ? "live" : "1d";
    if (b) b.classList.toggle("active", on);
    saveNWLocal();
    drawNW();
  }, { passive:false });
}

/* record points */
function recordNetWorthPoint(){
  if (!address) return;
  const px = safe(targetPrice);
  if (!Number.isFinite(px) || px <= 0) return;

  const totalInj = safe(availableInj) + safe(stakeInj) + safe(rewardsInj);
  const totalUsd = totalInj * px;
  if (!Number.isFinite(totalUsd) || totalUsd <= 0) return;

  const now = Date.now();
  const lastT = nwTAll.length ? safe(nwTAll[nwTAll.length - 1]) : 0;
  const lastUsd = nwUsdAll.length ? safe(nwUsdAll[nwUsdAll.length - 1]) : 0;

  const dt = now - lastT;
  const dUsd = Math.abs(totalUsd - lastUsd);

  // density control
  if (lastT && dt < 5_000 && dUsd < 0.25) return;

  nwTAll.push(now);
  nwUsdAll.push(totalUsd);
  nwInjAll.push(totalInj);
  clampNWArrays();
  saveNWLocal();
  drawNW();
}

/* ================= CLOUD SYNC (REAL) ================= */
const CLOUD_VER = 2;
const CLOUD_KEY = `inj_cloudmeta_v${CLOUD_VER}`;
let cloudPts = 0;
let cloudLastSync = 0;
let cloudDirty = false;
let cloudPushTimer = null;

function cloudLoadMeta(){
  try{
    const raw = localStorage.getItem(CLOUD_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    cloudPts = safe(obj?.pts);
    cloudLastSync = safe(obj?.lastSync);
  } catch {}
}
function cloudSaveMeta(){
  try{
    localStorage.setItem(CLOUD_KEY, JSON.stringify({ v:CLOUD_VER, pts: cloudPts, lastSync: cloudLastSync }));
  } catch {}
}

function cloudSetState(state){
  const root = $("appRoot");
  const st = $("cloudStatus");
  if (!root || !st) return;

  root.classList.remove("cloud-synced","cloud-saving","cloud-error");

  // footer text
  if (state === "saving"){
    root.classList.add("cloud-saving");
    st.textContent = hasInternet() ? "Cloud: Saving" : "Cloud: Offline cache";
  } else if (state === "error"){
    root.classList.add("cloud-error");
    st.textContent = "Cloud: Error";
  } else {
    root.classList.add("cloud-synced");
    st.textContent = hasInternet() ? "Cloud: Synced" : "Cloud: Offline cache";
  }

  // menu text + dot
  if (cloudDotMenu) {
    cloudDotMenu.classList.remove("ok","saving","err");
    if (state === "saving") cloudDotMenu.classList.add("saving");
    else if (state === "error") cloudDotMenu.classList.add("err");
    else cloudDotMenu.classList.add("ok");
  }
  if (cloudTextMenu) {
    cloudTextMenu.textContent = (state === "saving") ? "Saving"
      : (state === "error") ? "Error"
      : hasInternet() ? "Synced" : "Offline cache";
  }
}

function cloudRenderMeta(){
  const hist = $("cloudHistory");
  if (hist) hist.textContent = `· ${Math.max(0, Math.floor(cloudPts))} pts`;
  if (cloudPtsMenu) cloudPtsMenu.textContent = `${Math.max(0, Math.floor(cloudPts))} pts`;
}

function cloudBumpLocal(points = 1){
  cloudPts = safe(cloudPts) + safe(points);
  cloudLastSync = Date.now();
  cloudSaveMeta();
  cloudRenderMeta();
}

function cloudMarkDirty(){
  if (!address) return;
  cloudDirty = true;
  if (!hasInternet()) return;
  scheduleCloudPush();
}

function scheduleCloudPush(){
  if (cloudPushTimer) clearTimeout(cloudPushTimer);
  cloudPushTimer = setTimeout(() => cloudPush(), CLOUD_PUSH_DEBOUNCE_MS);
}

function buildCloudPayload(){
  return {
    v: 2,
    t: Date.now(),
    stake: { labels: stakeLabels, data: stakeData, moves: stakeMoves, types: stakeTypes },
    wd: { labels: wdLabelsAll, values: wdValuesAll, times: wdTimesAll },
    nw: { times: nwTAll, usd: nwUsdAll, inj: nwInjAll }
  };
}

function mergeUniqueByTs(baseTimes, baseVals, addTimes, addVals){
  // assumes times arrays contain ms timestamps
  const map = new Map();
  for (let i=0;i<baseTimes.length;i++){
    const t = safe(baseTimes[i]);
    if (!t) continue;
    map.set(t, safe(baseVals[i]));
  }
  for (let i=0;i<addTimes.length;i++){
    const t = safe(addTimes[i]);
    if (!t) continue;
    if (!map.has(t)) map.set(t, safe(addVals[i]));
  }
  const times = [...map.keys()].sort((a,b)=>a-b);
  const vals = times.map(t => map.get(t));
  return { times, vals };
}

function mergeStakeByLabel(payloadStake){
  if (!payloadStake) return;
  const pl = Array.isArray(payloadStake.labels) ? payloadStake.labels : [];
  const pd = Array.isArray(payloadStake.data) ? payloadStake.data : [];
  const pm = Array.isArray(payloadStake.moves) ? payloadStake.moves : [];
  const pt = Array.isArray(payloadStake.types) ? payloadStake.types : [];

  // merge by timestamp label (we store numeric-label)
  const map = new Map();
  for (let i=0;i<stakeLabels.length;i++){
    const k = String(stakeLabels[i]);
    map.set(k, { d: safe(stakeData[i]), m: safe(stakeMoves[i]), t: String(stakeTypes[i] || "Stake update") });
  }
  for (let i=0;i<pl.length;i++){
    const k = String(pl[i]);
    if (!map.has(k)) {
      map.set(k, { d: safe(pd[i]), m: safe(pm[i]), t: String(pt[i] || "Stake update") });
    }
  }

  const keys = [...map.keys()].sort((a,b)=>labelToTs(a)-labelToTs(b));
  stakeLabels = keys;
  stakeData = keys.map(k => map.get(k).d);
  stakeMoves = keys.map(k => map.get(k).m);
  stakeTypes = keys.map(k => map.get(k).t);

  // clamp
  stakeLabels = clampArray(stakeLabels, 2400);
  stakeData   = clampArray(stakeData,   2400);
  stakeMoves  = clampArray(stakeMoves,  2400);
  stakeTypes  = clampArray(stakeTypes,  2400);

  stakeBaselineCaptured = stakeData.length > 0;
  lastStakeRecordedRounded = stakeData.length ? Number(safe(stakeData[stakeData.length - 1]).toFixed(6)) : null;
}

function mergeWd(payloadWd){
  if (!payloadWd) return;
  const pl = Array.isArray(payloadWd.labels) ? payloadWd.labels : [];
  const pv = Array.isArray(payloadWd.values) ? payloadWd.values : [];
  const pt = Array.isArray(payloadWd.times) ? payloadWd.times : [];

  // merge by times (preferred)
  const map = new Map();
  for (let i=0;i<wdTimesAll.length;i++){
    const t = safe(wdTimesAll[i]) || labelToTs(wdLabelsAll[i]);
    if (!t) continue;
    map.set(t, { v: safe(wdValuesAll[i]), l: String(wdLabelsAll[i] || tsLabel(t)) });
  }
  for (let i=0;i<pt.length;i++){
    const t = safe(pt[i]) || labelToTs(pl[i]);
    if (!t) continue;
    if (!map.has(t)) map.set(t, { v: safe(pv[i]), l: String(pl[i] || tsLabel(t)) });
  }

  const times = [...map.keys()].sort((a,b)=>a-b);
  wdTimesAll  = times;
  wdValuesAll = times.map(t => map.get(t).v);
  wdLabelsAll = times.map(t => map.get(t).l);

  // clamp
  wdTimesAll  = clampArray(wdTimesAll, 2400);
  wdValuesAll = clampArray(wdValuesAll, 2400);
  wdLabelsAll = clampArray(wdLabelsAll, 2400);
}

function mergeNW(payloadNw){
  if (!payloadNw) return;
  const t = Array.isArray(payloadNw.times) ? payloadNw.times : [];
  const u = Array.isArray(payloadNw.usd) ? payloadNw.usd : [];
  const j = Array.isArray(payloadNw.inj) ? payloadNw.inj : [];

  const m1 = mergeUniqueByTs(nwTAll, nwUsdAll, t, u);
  const m2 = mergeUniqueByTs(nwTAll, nwInjAll, t, j);

  nwTAll = m1.times;
  nwUsdAll = m1.vals;
  nwInjAll = m2.vals;

  clampNWArrays();
}

async function cloudPull(){
  if (!address) return;
  if (!hasInternet()) { cloudSetState("synced"); return; }

  const url = `${CLOUD_API}?address=${encodeURIComponent(address)}`;
  const res = await fetchJSON(url);
  if (!res?.ok) { cloudSetState("error"); return; }
  if (!res.data) { cloudSetState("synced"); return; }

  try{
    const data = res.data;
    mergeStakeByLabel(data.stake);
    mergeWd(data.wd);
    mergeNW(data.nw);

    // rebuild chart views
    saveStakeSeriesLocal();
    saveWdAllLocal();
    rebuildWdView();
    goRewardLive();
    saveNWLocal();
    drawNW();
    drawStakeChart();
    drawRewardWdChart();

    cloudLastSync = Date.now();
    cloudSaveMeta();
    cloudSetState("synced");
  } catch {
    cloudSetState("error");
  }
}

async function cloudPush(){
  if (!address) return;
  if (!hasInternet()) return;
  if (!cloudDirty) return;

  cloudSetState("saving");

  const url = `${CLOUD_API}?address=${encodeURIComponent(address)}`;
  const payload = buildCloudPayload();

  const res = await fetchJSON(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!res?.ok) {
    cloudSetState("error");
    return;
  }

  cloudDirty = false;
  cloudLastSync = Date.now();
  cloudSaveMeta();
  cloudSetState("synced");
}

/* ================= NET WORTH UI rows ================= */
function updateNetWorthMiniRows(){
  const totalInj = safe(availableInj) + safe(stakeInj) + safe(rewardsInj);
  const px = safe(displayed.price);

  setText("nwInjQty", totalInj.toFixed(4));
  setText("nwInjPx", `$${px.toFixed(2)}`);

  // also big total INJ label if present
  setText("netWorthInj", `${totalInj.toFixed(4)} INJ`);
}

/* ================= IMPORTANT PRICE EVENTS (24h thresholds) ================= */
let lastPriceStepUp = 0;
let lastPriceStepDown = 0;
function maybePriceEvent(pct24h){
  // fire at each 5% step
  const step = 5;
  const upSteps = Math.floor(Math.max(0, pct24h) / step);
  const dnSteps = Math.floor(Math.max(0, -pct24h) / step);

  if (upSteps > lastPriceStepUp) {
    lastPriceStepUp = upSteps;
    pushEvent({ kind:"price", title:"Price move", detail:`INJ +${(upSteps*step).toFixed(0)}% (24h)`, dir:"up", status:"ok" });
  }
  if (dnSteps > lastPriceStepDown) {
    lastPriceStepDown = dnSteps;
    pushEvent({ kind:"price", title:"Price move", detail:`INJ -${(dnSteps*step).toFixed(0)}% (24h)`, dir:"down", status:"ok" });
  }
}

/* ================= CHART THEME REFRESH ================= */
function refreshChartsTheme(){
  try{
    if (stakeChart) {
      stakeChart.options.scales.y.grid.color = axisGridColor();
      stakeChart.options.scales.y.ticks.color = axisTickColor();
      stakeChart.options.scales.x.grid.color = axisGridColor();
      stakeChart.options.scales.x.ticks.color = axisTickColor();
      stakeChart.update("none");
    }
    if (rewardChart) {
      rewardChart.options.scales.x.grid.color = axisGridColor();
      rewardChart.options.scales.y.grid.color = axisGridColor();
      rewardChart.options.scales.x.ticks.color = axisTickColor();
      rewardChart.options.scales.y.ticks.color = axisTickColor();
      rewardChart.update("none");
    }
    if (chart) {
      chart.options.scales.y.grid.color = axisGridColor();
      chart.options.scales.y.ticks.color = axisTickColor();
      chart.update("none");
    }
    if (netWorthChart) {
      netWorthChart.options.scales.y.grid.color = axisGridColor();
      netWorthChart.options.scales.y.ticks.color = axisTickColor();
      netWorthChart.options.scales.x.ticks.color = axisTickColor();
      netWorthChart.update("none");
    }
  } catch {}
}

/* ================= ADDRESS COMMIT ================= */
async function commitAddress(newAddr) {
  const a = (newAddr || "").trim();
  if (!a) return;

  address = a;
  localStorage.setItem("inj_address", address);

  setAddressDisplay(address);
  settleStart = Date.now();

  // reset runtime
  availableInj = 0; stakeInj = 0; rewardsInj = 0; apr = 0;
  displayed.available = 0; displayed.stake = 0; displayed.rewards = 0; displayed.netWorthUsd = 0; displayed.apr = 0;

  // load local series
  loadStakeSeriesLocal();
  drawStakeChart();

  wdLastRewardsSeen = null;
  wdMinFilter = safe($("rewardFilter")?.value || 0);
  loadWdAllLocal();
  rebuildWdView();
  goRewardLive();

  loadNWLocal();
  const scaleBtn = $("nwScaleBtn");
  if (scaleBtn) scaleBtn.textContent = (nwScale === "log") ? "LOG" : "LIN";
  const liveBtn = $("nwLiveBtn");
  if (liveBtn) liveBtn.classList.toggle("active", nwTf === "live");
  attachNWTFHandlers();
  drawNW();

  // events
  loadEvents();
  renderEvents();

  // cloud pull
  cloudSetState("saving");
  await cloudPull();

  modeLoading = true;
  refreshConnUI();

  if (liveMode) await loadAccount();
  else {
    refreshLoaded = false;
    refreshConnUI();
    await refreshLoadAllOnce();
  }
}

/* ================= ONLINE / OFFLINE listeners ================= */
window.addEventListener("online", () => {
  refreshConnUI();
  setValidatorUI("ready");
  cloudSetState("synced");
  if (address) cloudPull();
  if (liveMode) {
    startTradeWS();
    startKlineWS();
    if (address) loadAccount();
  } else {
    refreshLoadAllOnce();
  }
}, { passive: true });

window.addEventListener("offline", () => {
  wsTradeOnline = false;
  wsKlineOnline = false;
  accountOnline = false;
  refreshLoaded = false;
  refreshLoading = false;
  modeLoading = false;
  refreshConnUI();
  setValidatorUI("ready");
  cloudSetState("synced");
}, { passive: true });

/* ================= BOOT ================= */
(async function boot() {
  // theme + zoom
  applyTheme(theme);
  ZOOM_OK = tryRegisterZoom();

  // ui
  cloudLoadMeta();
  cloudRenderMeta();
  cloudSetState("synced");
  refreshConnUI();
  setTimeout(() => setUIReady(true), 2600);

  attachRewardTimelineHandlers();
  attachRewardLiveHandler();
  attachRewardFilterHandler();

  if (liveIcon) liveIcon.textContent = liveMode ? "📡" : "⟳";
  if (modeHint) modeHint.textContent = `Mode: ${liveMode ? "LIVE" : "REFRESH"}`;

  // bind expand
  bindExpandButtons();

  // pull-to-refresh
  initPullToRefresh();

  // address display
  setAddressDisplay(address);

  // initial data for last saved address
  wdMinFilter = safe($("rewardFilter")?.value || 0);

  if (address) {
    // local loads first
    loadStakeSeriesLocal(); drawStakeChart();
    loadWdAllLocal(); rebuildWdView(); goRewardLive();
    loadNWLocal();
    const scaleBtn = $("nwScaleBtn");
    if (scaleBtn) scaleBtn.textContent = (nwScale === "log") ? "LOG" : "LIN";
    const liveBtn = $("nwLiveBtn");
    if (liveBtn) liveBtn.classList.toggle("active", nwTf === "live");
    attachNWTFHandlers();
    drawNW();

    loadEvents();
    renderEvents();

    // cloud merge
    await cloudPull();
  }

  modeLoading = true;
  refreshConnUI();

  await loadCandleSnapshot(liveMode ? false : true);
  await loadChartToday(liveMode ? false : true);

  if (liveMode) {
    startTradeWS();
    startKlineWS();
    if (address) await loadAccount();
    startAllTimers();
  } else {
    stopAllTimers();
    stopAllSockets();
    accountOnline = false;
    refreshLoaded = false;
    refreshConnUI();
    await refreshLoadAllOnce();
  }
})();

/* ================= LOOP ================= */
function animate() {
  // PRICE
  const op = displayed.price;
  displayed.price = tick(displayed.price, targetPrice);
  colorNumber($("price"), displayed.price, op, 4);

  // PERF
  const pD = tfReady.d ? pctChange(targetPrice, candle.d.open) : 0;
  const pW = tfReady.w ? pctChange(targetPrice, candle.w.open) : 0;
  const pM = tfReady.m ? pctChange(targetPrice, candle.m.open) : 0;

  updatePerf("arrow24h", "pct24h", pD);
  updatePerf("arrowWeek", "pctWeek", pW);
  updatePerf("arrowMonth", "pctMonth", pM);

  // price event thresholds (24h)
  if (tfReady.d) maybePriceEvent(pD);

  // Chart sign color
  const sign = pD > 0 ? "up" : (pD < 0 ? "down" : "flat");
  applyChartColorBySign(sign);

  const dUp   = "linear-gradient(90deg, rgba(34,197,94,.55), rgba(16,185,129,.32))";
  const dDown = "linear-gradient(270deg, rgba(239,68,68,.55), rgba(248,113,113,.30))";

  const wUp   = "linear-gradient(90deg, rgba(59,130,246,.55), rgba(99,102,241,.30))";
  const wDown = "linear-gradient(270deg, rgba(239,68,68,.40), rgba(59,130,246,.26))";

  const mUp   = "linear-gradient(90deg, rgba(249,115,22,.50), rgba(236,72,153,.28))";
  const mDown = "linear-gradient(270deg, rgba(239,68,68,.40), rgba(236,72,153,.25))";

  renderBar($("priceBar"), $("priceLine"), targetPrice, candle.d.open, candle.d.low, candle.d.high, dUp, dDown);
  renderBar($("weekBar"),  $("weekLine"),  targetPrice, candle.w.open, candle.w.low, candle.w.high, wUp, wDown);
  renderBar($("monthBar"), $("monthLine"), targetPrice, candle.m.open, candle.m.low, candle.m.high, mUp, mDown);

  // Values + flash extremes
  const pMinEl = $("priceMin"), pMaxEl = $("priceMax");
  const wMinEl = $("weekMin"),  wMaxEl = $("weekMax");
  const mMinEl = $("monthMin"), mMaxEl = $("monthMax");

  if (tfReady.d) {
    const low = safe(candle.d.low), high = safe(candle.d.high);
    setText("priceMin", low.toFixed(3));
    setText("priceOpen", safe(candle.d.open).toFixed(3));
    setText("priceMax", high.toFixed(3));
    if (lastExtremes.d.low !== null && low !== lastExtremes.d.low) flash(pMinEl);
    if (lastExtremes.d.high !== null && high !== lastExtremes.d.high) flash(pMaxEl);
    lastExtremes.d.low = low; lastExtremes.d.high = high;
  } else {
    setText("priceMin", "--"); setText("priceOpen", "--"); setText("priceMax", "--");
  }

  if (tfReady.w) {
    const low = safe(candle.w.low), high = safe(candle.w.high);
    setText("weekMin", low.toFixed(3));
    setText("weekOpen", safe(candle.w.open).toFixed(3));
    setText("weekMax", high.toFixed(3));
    if (lastExtremes.w.low !== null && low !== lastExtremes.w.low) flash(wMinEl);
    if (lastExtremes.w.high !== null && high !== lastExtremes.w.high) flash(wMaxEl);
    lastExtremes.w.low = low; lastExtremes.w.high = high;
  } else {
    setText("weekMin", "--"); setText("weekOpen", "--"); setText("weekMax", "--");
  }

  if (tfReady.m) {
    const low = safe(candle.m.low), high = safe(candle.m.high);
    setText("monthMin", low.toFixed(3));
    setText("monthOpen", safe(candle.m.open).toFixed(3));
    setText("monthMax", high.toFixed(3));
    if (lastExtremes.m.low !== null && low !== lastExtremes.m.low) flash(mMinEl);
    if (lastExtremes.m.high !== null && high !== lastExtremes.m.high) flash(mMaxEl);
    lastExtremes.m.low = low; lastExtremes.m.high = high;
  } else {
    setText("monthMin", "--"); setText("monthOpen", "--"); setText("monthMax", "--");
  }

  // AVAILABLE
  const oa = displayed.available;
  displayed.available = tick(displayed.available, availableInj);
  colorNumber($("available"), displayed.available, oa, 6);
  setText("availableUsd", `≈ $${(displayed.available * displayed.price).toFixed(2)}`);

  // STAKE
  const os = displayed.stake;
  displayed.stake = tick(displayed.stake, stakeInj);
  colorNumber($("stake"), displayed.stake, os, 4);
  setText("stakeUsd", `≈ $${(displayed.stake * displayed.price).toFixed(2)}`);

  const stakePct = clamp((displayed.stake / STAKE_TARGET_MAX) * 100, 0, 100);
  const stakeBar = $("stakeBar");
  const stakeLine = $("stakeLine");
  if (stakeBar) {
    stakeBar.style.width = stakePct + "%";
    stakeBar.style.backgroundPosition = `${(100 - stakePct) * 0.6}% 0`;
  }
  if (stakeLine) stakeLine.style.left = stakePct + "%";
  setText("stakePercent", stakePct.toFixed(1) + "%");
  setText("stakeMin", "0");
  setText("stakeMax", String(STAKE_TARGET_MAX));

  // REWARDS
  const or = displayed.rewards;
  displayed.rewards = tick(displayed.rewards, rewardsInj);
  colorNumber($("rewards"), displayed.rewards, or, 7);
  setText("rewardsUsd", `≈ $${(displayed.rewards * displayed.price).toFixed(2)}`);

  const maxR = Math.max(0.1, Math.ceil(displayed.rewards * 10) / 10);
  const rp = clamp((displayed.rewards / maxR) * 100, 0, 100);

  const rewardBar = $("rewardBar");
  const rewardLine = $("rewardLine");
  if (rewardBar) {
    rewardBar.style.width = rp + "%";
    rewardBar.style.backgroundPosition = `${(100 - rp)}% 0`;
  }
  if (rewardLine) rewardLine.style.left = rp + "%";
  setText("rewardPercent", rp.toFixed(1) + "%");
  setText("rewardMin", "0");
  setText("rewardMax", maxR.toFixed(1));

  // APR (animated like price)
  const oapr = displayed.apr;
  displayed.apr = tick(displayed.apr, apr);
  colorNumber($("apr"), displayed.apr, oapr, 2);

  // Last update at bottom
  setText("updated", "Last update: " + nowLabel());

  /* ================= NET WORTH UI ================= */
  const totalInj = safe(availableInj) + safe(stakeInj) + safe(rewardsInj);
  const totalUsd = totalInj * safe(displayed.price);

  if (!nwHoverActive) {
    const onw = displayed.netWorthUsd;
    displayed.netWorthUsd = tick(displayed.netWorthUsd, totalUsd);
    colorMoney($("netWorthUsd"), displayed.netWorthUsd, onw, 2);

    // keep pnl & chart updated (live view filters window)
    drawNW();
  }

  updateNetWorthMiniRows();

  // densità: registra spesso (solo live + address)
  if (address && liveMode) recordNetWorthPoint();

  // cloud push if dirty (debounced)
  if (cloudDirty && hasInternet()) scheduleCloudPush();

  refreshConnUI();
  setValidatorUI("ready");

  // keep dot fluid
  if (netWorthChart) netWorthChart.draw();

  requestAnimationFrame(animate);
}
animate();

/* ================= WHAT WAS ADDED (this file) =================
✅ FIX: Coming soon close works always (button + background + ESC)
✅ Menu: Event opens dedicated Events page; other items open coming soon overlay
✅ Validator card: single card, Injective validator fetched (if delegations exist), status dot yellow/green/red
✅ Cloud Sync: real GET/POST to /api/point with Saving/Synced/Error reflected in menu + footer
✅ Address search: wallet stays displayed, input clears after commit
✅ Events: toast slide-down + persistence + events table rendering; stake/reward/price events added
✅ Pull-to-refresh: enabled only in REFRESH mode (mobile), shows spinner and refreshes data
=============================================================== */
