/* ================= CONFIG ================= */
const INITIAL_SETTLE_TIME = 4200;
let settleStart = Date.now();

const ACCOUNT_POLL_MS = 8000;
const CHART_TICK_MS = 8000;

const ONE_MIN_MS = 60_000;

/* persistence */
const EVENTS_LOCAL_KEY = "injp_events_v1";

/* ================= HELPERS ================= */
const $  = (id)   => document.getElementById(id);
const $q = (sel)  => document.querySelector(sel);
const $qa= (sel)  => Array.from(document.querySelectorAll(sel));

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

function fmtUsd(v){
  if (!isFinite(v)) return "$0.00";
  return "$" + v.toFixed(2);
}
function fmtInj(v, dp = 4){
  if (!isFinite(v)) return "0";
  return v.toFixed(dp);
}
function shortenAddr(addr){
  if (!addr) return "Nessun address";
  if (addr.length <= 14) return addr;
  return addr.slice(0, 7) + "…" + addr.slice(-6);
}
function nowIso(){ return new Date().toISOString(); }
function fmtTime(ts){
  const d = ts instanceof Date ? ts : new Date(ts);
  return d.toLocaleString("it-IT", {hour12:false});
}

/* toast */
function showToast(title, sub){
  const host = $("toastHost");
  if (!host) return;
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `
    <div class="toast-row">
      <div>
        <div class="toast-title">${title}</div>
        ${sub ? `<div class="toast-sub">${sub}</div>` : ""}
      </div>
    </div>
  `;
  host.appendChild(el);
  setTimeout(() => { el.remove(); }, 2600);
}

/* ================= STATE ================= */
const state = {
  theme: "dark",
  liveMode: true,
  address: "",
  price: 25,
  price24h: {open:25, low:25, high:25},
  week: {open:25, low:25, high:25},
  month:{open:25, low:25, high:25},
  available: 0,
  stake: 0,
  rewards: 0,
  validatorName: "Validator",
  validatorAddr: "—",
  netWorth: 0,
  netWorthPoints: [],
  pricePoints: [],
  stakedPoints: [],
  rewardPoints: [],
  charts: {
    netWorth: null,
    price: null,
    staked: null,
    reward: null
  },
  events: [],
};

/* ================= INIT ================= */
document.addEventListener("DOMContentLoaded", () => {
  initTheme();
  initDrawer();
  initSearch();
  initNav();
  initCloud();
  initStatus();
  initCharts();
  initEvents();

  // fake initial data (così i grafici non sono vuoti)
  seedInitialPoints();
  renderAll();

  // polling “live” finto (poi colleghi ai tuoi dati reali)
  setInterval(() => {
    if (!state.liveMode) return;
    simulateTick();
  }, CHART_TICK_MS);
});

/* ================= THEME ================= */
function initTheme(){
  const themeToggle = $("themeToggle");
  const icon = $("themeIcon");
  const saved = localStorage.getItem("injp_theme");
  if (saved === "light" || saved === "dark"){
    state.theme = saved;
  }
  applyTheme();

  if (themeToggle){
    themeToggle.addEventListener("click", () => {
      state.theme = state.theme === "dark" ? "light" : "dark";
      localStorage.setItem("injp_theme", state.theme);
      applyTheme();
    });
  }

  function applyTheme(){
    if (state.theme === "light"){
      document.body.setAttribute("data-theme","light");
      icon.textContent = "☀️";
    } else {
      document.body.removeAttribute("data-theme");
      icon.textContent = "🌙";
    }
  }
}

/* ================= DRAWER / NAV ================= */
function initDrawer(){
  const menuBtn   = $("menuBtn");
  const backdrop  = $("backdrop");
  const drawer    = $("drawer");

  function openDrawer(){
    document.body.classList.add("drawer-open");
    drawer?.setAttribute("aria-hidden","false");
    backdrop?.setAttribute("aria-hidden","false");
  }
  function closeDrawer(){
    document.body.classList.remove("drawer-open");
    drawer?.setAttribute("aria-hidden","true");
    backdrop?.setAttribute("aria-hidden","true");
  }

  menuBtn?.addEventListener("click", openDrawer);
  backdrop?.addEventListener("click", closeDrawer);

  // chiude su ESC
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape"){
      closeDrawer();
    }
  });
}

function initNav(){
  const navItems = $qa(".nav-item");
  const pages = {
    dashboard: $("pageDashboard"),
    events: $("pageEvents"),
    settings: $("pageSettings"),
    tools: $("pageTools"),
  };

  navItems.forEach(btn => {
    btn.addEventListener("click", () => {
      const page = btn.dataset.page;
      navItems.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");

      Object.entries(pages).forEach(([k, el]) => {
        if (!el) return;
        el.classList.toggle("active", k === page);
      });

      // chiudo drawer
      document.body.classList.remove("drawer-open");
      $("drawer")?.setAttribute("aria-hidden","true");
      $("backdrop")?.setAttribute("aria-hidden","true");
    });
  });
}

/* ================= SEARCH / ADDRESS ================= */
function initSearch(){
  const searchWrap = $("searchWrap");
  const searchBtn  = $("searchBtn");
  const input      = $("addressInput");
  const addrDisp   = $("addressDisplay");

  function setSearchOpen(open){
    if (!searchWrap) return;
    if (open){
      searchWrap.classList.add("open");
      document.body.classList.add("search-open");
      setTimeout(() => input?.focus(), 40);
    } else {
      searchWrap.classList.remove("open");
      document.body.classList.remove("search-open");
      input?.blur();
    }
  }

  searchBtn?.addEventListener("click", () => {
    const isOpen = searchWrap?.classList.contains("open");
    setSearchOpen(!isOpen);
  });

  input?.addEventListener("keydown", (e) => {
    if (e.key === "Enter"){
      const raw = input.value.trim();
      if (!raw){
        showToast("Address mancante","Incolla un address Injective (inj...)");
        return;
      }
      // per ora validazione minimale
      state.address = raw;
      addrDisp.textContent = shortenAddr(raw);
      showToast("Address aggiornato", shortenAddr(raw));
    }
  });
}

/* ================= LIVE / REFRESH ================= */
function initStatus(){
  const statusDot  = $("statusDot");
  const statusText = $("statusText");
  const liveToggle = $("liveToggle");
  const liveIcon   = $("liveIcon");
  const modeHint   = $("modeHint");

  function setLiveMode(live){
    state.liveMode = live;
    if (live){
      statusText.textContent = "LIVE";
      statusDot.style.background = "#22c55e";
      liveIcon.textContent = "📡";
      modeHint.textContent = "Mode: LIVE";
    } else {
      statusText.textContent = "REFRESH";
      statusDot.style.background = "#f59e0b";
      liveIcon.textContent = "⟳";
      modeHint.textContent = "Mode: REFRESH";
    }
  }

  liveToggle?.addEventListener("click", () => {
    setLiveMode(!state.liveMode);
    showToast(
      state.liveMode ? "Modalità LIVE" : "Modalità REFRESH",
      state.liveMode ? "Aggiornamento continuo dati." : "Aggiornamento solo a snapshot."
    );
  });

  // default: LIVE
  setLiveMode(true);
}

/* ================= CLOUD SYNC (fake) ================= */
function initCloud(){
  const footer = $("cloudStatus");
  const menuDot= $("cloudDotMenu");
  const menuTxt= $("cloudTextMenu");
  const menuPts= $("cloudPtsMenu");
  const hist   = $("cloudHistory");

  function setState(cls, text){
    document.body.classList.remove("cloud-synced","cloud-saving","cloud-error");
    document.body.classList.add(cls);
    if (footer) footer.textContent = "Cloud: " + text;
    if (menuTxt) menuTxt.textContent = text;
    if (menuDot){
      menuDot.classList.remove("ok","saving","err");
      if (cls === "cloud-synced") menuDot.classList.add("ok");
      else if (cls === "cloud-saving") menuDot.classList.add("saving");
      else if (cls === "cloud-error") menuDot.classList.add("err");
    }
  }

  // set iniziale
  setState("cloud-synced","Synced");
  if (menuPts) menuPts.textContent = "0 pts";
  if (hist) hist.textContent = "· 0 pts";

  // finto salvataggio ogni tot
  setInterval(() => {
    setState("cloud-saving","Saving…");
    setTimeout(() => {
      setState("cloud-synced","Synced");
    }, 800);
  }, 45_000);
}

/* ================= CHARTS ================= */
function createLineChart(ctx, opts = {}){
  return new Chart(ctx, {
    type: "line",
    data: {
      labels: [],
      datasets: [{
        data: [],
        borderWidth: 2,
        pointRadius: 0,
        pointHitRadius: 6,
        tension: 0.35,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display:false },
        tooltip: {
          mode: "index",
          intersect: false,
          callbacks: {
            title: (items) => {
              if (!items.length) return "";
              const idx = items[0].dataIndex;
              const t = opts.getTime ? opts.getTime(idx) : null;
              return t ? fmtTime(t) : "";
            }
          }
        }
      },
      scales: {
        x: {
          display: true,
          grid: { display:false },
          ticks:{ maxTicksLimit: 6 }
        },
        y: {
          display: true,
          grid: { color: "rgba(148,163,184,.16)" },
          ticks:{ maxTicksLimit: 5 }
        }
      }
    }
  });
}

function initCharts(){
  const nwCtx  = $("netWorthChart")?.getContext("2d");
  const pCtx   = $("priceChart")?.getContext("2d");
  const sCtx   = $("stakeChart")?.getContext("2d");
  const rCtx   = $("rewardChart")?.getContext("2d");

  if (nwCtx){
    state.charts.netWorth = createLineChart(nwCtx, {
      getTime: idx => state.netWorthPoints[idx]?.t
    });
  }
  if (pCtx){
    state.charts.price = createLineChart(pCtx, {
      getTime: idx => state.pricePoints[idx]?.t
    });
  }
  if (sCtx){
    state.charts.staked = createLineChart(sCtx, {
      getTime: idx => state.stakedPoints[idx]?.t
    });
  }
  if (rCtx){
    state.charts.reward = createLineChart(rCtx, {
      getTime: idx => state.rewardPoints[idx]?.t
    });
  }

  // fullscreen su tutte le card con grafico
  $qa(".card-expand").forEach(btn => {
    btn.addEventListener("click", () => {
      const card = btn.closest(".card");
      if (!card) return;
      const isFull = card.classList.contains("fullscreen");
      $qa(".card.fullscreen").forEach(c => c.classList.remove("fullscreen"));
      document.body.classList.remove("card-expanded");
      if (!isFull){
        card.classList.add("fullscreen");
        document.body.classList.add("card-expanded");
      }
    });
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape"){
      $qa(".card.fullscreen").forEach(c => c.classList.remove("fullscreen"));
      document.body.classList.remove("card-expanded");
    }
  });
}

/* ================= DUMMY DATA (per avere grafici vivi) ================= */
function seedInitialPoints(){
  const now = Date.now();
  const basePrice = state.price;

  for (let i = 20; i >= 0; i--){
    const t = now - i * ONE_MIN_MS;
    const p = basePrice * (1 + (Math.random() - 0.5) * 0.02);
    const nw = p * 10; // 10 INJ finto
    const st = 5 + Math.random() * 3;
    const rw = Math.max(0, (20 - i) * 0.01);

    state.pricePoints.push({t, v: p});
    state.netWorthPoints.push({t, v: nw});
    state.stakedPoints.push({t, v: st});
    state.rewardPoints.push({t, v: rw});
  }
}

function simulateTick(){
  const now = Date.now();
  const lastPrice = state.pricePoints[state.pricePoints.length-1]?.v ?? state.price;
  const newPrice  = lastPrice * (1 + (Math.random() - 0.5) * 0.01);
  state.price = newPrice;

  const injQty = 10; // finto
  const nw = newPrice * injQty;
  const st = 5 + Math.random()*3;
  const rw = Math.max(0, (state.rewardPoints[state.rewardPoints.length-1]?.v ?? 0) + Math.random()*0.01);

  state.netWorth = nw;
  state.pricePoints.push({t: now, v: newPrice});
  state.netWorthPoints.push({t: now, v: nw});
  state.stakedPoints.push({t: now, v: st});
  state.rewardPoints.push({t: now, v: rw});

  // mantieni solo ultimi N punti per i grafici
  const maxPts = 240;
  const trim = arr => { if (arr.length > maxPts) arr.splice(0, arr.length - maxPts); };
  trim(state.pricePoints);
  trim(state.netWorthPoints);
  trim(state.stakedPoints);
  trim(state.rewardPoints);

  renderAll();
}

/* ================= RENDER ================= */
function renderAll(){
  renderPriceCard();
  renderBalanceCards();
  renderNetWorth();
  renderCharts();
  renderUpdated();
}

function renderPriceCard(){
  $("price")!.textContent = fmtUsd(state.price);

  // per ora range finto 1D/1W/1M
  state.price24h.low  = Math.min(state.price24h.low, state.price);
  state.price24h.high = Math.max(state.price24h.high, state.price);

  $("priceMin").textContent  = fmtUsd(state.price24h.low);
  $("priceMax").textContent  = fmtUsd(state.price24h.high);
  $("priceOpen").textContent = fmtUsd(state.price24h.open);

  // barre fittizie: solo per layout
  const range = state.price24h.high - state.price24h.low || 1;
  const pos   = (state.price - state.price24h.low) / range;
  const bar   = $("priceBar");
  const line  = $("priceLine");
  if (bar)  bar.style.width = clamp(pos*100, 4, 100) + "%";
  if (line) line.style.left = clamp(pos*100, 0, 100) + "%";
}

function renderBalanceCards(){
  $("available")!.textContent  = fmtInj(state.available, 6);
  $("availableUsd")!.textContent = fmtUsd(state.available * state.price);
  $("stake")!.textContent      = fmtInj(state.stake, 4);
  $("stakeUsd")!.textContent   = fmtUsd(state.stake * state.price);
  $("rewards")!.textContent    = fmtInj(state.rewards, 7);
  $("rewardsUsd")!.textContent = fmtUsd(state.rewards * state.price);

  const totalInj = state.available + state.stake + state.rewards;
  $("netWorthInj")!.textContent = fmtInj(totalInj,4) + " INJ";
  $("nwInjPx")!.textContent     = fmtUsd(state.price);
  $("nwInjQty")!.textContent    = fmtInj(totalInj,4);
}

function renderNetWorth(){
  $("netWorthUsd")!.textContent = fmtUsd(state.netWorth);

  // PnL finto: confronto con valore iniziale
  const first = state.netWorthPoints[0]?.v ?? state.netWorth;
  const diff  = state.netWorth - first;
  const pct   = first ? (diff/first)*100 : 0;

  const el = $("netWorthPnl");
  if (!el) return;

  el.classList.remove("good","bad","flat");
  let cls = "flat";
  if (diff > 0.0001) cls = "good";
  else if (diff < -0.0001) cls = "bad";

  el.classList.add(cls);
  el.textContent = `PnL: ${diff >= 0 ? "+" : ""}${fmtUsd(diff)} (${pct >=0?"+":""}${pct.toFixed(2)}%)`;
}

function renderCharts(){
  // Net Worth
  const cNW = state.charts.netWorth;
  if (cNW){
    cNW.data.labels = state.netWorthPoints.map(p => new Date(p.t).toLocaleTimeString("it-IT",{hour:"2-digit",minute:"2-digit"}));
    cNW.data.datasets[0].data = state.netWorthPoints.map(p => p.v);
    cNW.update();
  }

  // Price
  const cP = state.charts.price;
  if (cP){
    cP.data.labels = state.pricePoints.map(p => new Date(p.t).toLocaleTimeString("it-IT",{hour:"2-digit",minute:"2-digit"}));
    cP.data.datasets[0].data = state.pricePoints.map(p => p.v);
    cP.update();
  }

  // Staked
  const cS = state.charts.staked;
  if (cS){
    cS.data.labels = state.stakedPoints.map(p => new Date(p.t).toLocaleTimeString("it-IT",{hour:"2-digit",minute:"2-digit"}));
    cS.data.datasets[0].data = state.stakedPoints.map(p => p.v);
    cS.update();
  }

  // Reward
  const cR = state.charts.reward;
  if (cR){
    cR.data.labels = state.rewardPoints.map(p => new Date(p.t).toLocaleTimeString("it-IT",{hour:"2-digit",minute:"2-digit"}));
    cR.data.datasets[0].data = state.rewardPoints.map(p => p.v);
    cR.update();
  }
}

function renderUpdated(){
  const el = $("updated");
  if (!el) return;
  el.textContent = "Last update: " + new Date().toLocaleString("it-IT",{hour12:false});
}

/* ================= EVENTS ================= */
function initEvents(){
  // carica da localStorage
  try{
    const raw = localStorage.getItem(EVENTS_LOCAL_KEY);
    if (raw){
      const list = JSON.parse(raw);
      if (Array.isArray(list)) state.events = list;
    }
  }catch(e){}

  // reset button
  $("eventsClearBtn")?.addEventListener("click", () => {
    if (!confirm("Sicuro di voler resettare tutti gli eventi?")) return;
    state.events = [];
    saveEvents();
    renderEvents();
    showToast("Events resettati","Lo storico eventi è stato azzerato.");
  });

  // render iniziale
  renderEvents();
}

function saveEvents(){
  try{
    localStorage.setItem(EVENTS_LOCAL_KEY, JSON.stringify(state.events));
  }catch(e){}
}

function addEvent(type, title, details){
  const ev = {
    id: Date.now() + "_" + Math.random().toString(16).slice(2),
    type,
    title,
    details,
    ts: nowIso(),
  };
  state.events.unshift(ev); // più recenti in alto
  saveEvents();
  renderEvents();
}

function renderEvents(){
  const tbody = $("eventsTableBody");
  const empty = $("eventsEmpty");
  if (!tbody || !empty) return;

  tbody.innerHTML = "";

  if (!state.events.length){
    empty.style.display = "block";
    return;
  }
  empty.style.display = "none";

  for (const ev of state.events){
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>
        <span class="ev-pill">
          <span class="ev-dot"></span>
          <span>${ev.type}</span>
        </span>
      </td>
      <td>${ev.title}</td>
      <td>${fmtTime(ev.ts)}</td>
      <td>${ev.details || ""}</td>
    `;
    tbody.appendChild(tr);
  }
}

/* ================= FIRST DEMO EVENT ================= */
setTimeout(() => {
  addEvent(
    "system",
    "Dashboard ready",
    "Stato iniziale caricato (demo)."
  );
}, 2500);