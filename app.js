/* Injective Portfolio - app.js (v2.0.2) */

/* ================= CONFIG ================= */
const INITIAL_SETTLE_TIME = 4200;
let settleStart = Date.now();

const ACCOUNT_POLL_MS = 2000;
const REST_SYNC_MS = 60000;
const CHART_SYNC_MS = 60000;

const DAY_MINUTES = 24 * 60;
const ONE_MIN_MS = 60_000;

const STAKE_TARGET_MAX = 1000;
const EVENTS_MAX = 100;

/* localStorage keys */
const STORAGE_KEYS = {
  nw: 'nw-points',
  staked: 'staked-points',
  rewards: 'reward-points',
  events: 'event-log',
  stakeBarMax: 'stake-bar-max',
  rewardBarMax: 'reward-bar-max',
};

/* ================= HELPERS ================= */
const $ = (id) => document.getElementById(id);
const format = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 6 });
const shortAddr = (addr) => addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : '';
const nowIso = () => new Date().toISOString();

function blink(el, color = 'green') {
  el.style.backgroundColor = color;
  el.style.animation = 'blink 1s infinite';
}

function updateConnectionStatus(connected, liveMode) {
  const dot = $('statusDot');
  const text = $('statusText');
  dot.style.backgroundColor = connected ? (liveMode ? 'var(--green)' : 'var(--amber)') : 'var(--red)';
  text.textContent = connected ? (liveMode ? 'Live' : 'Refresh') : 'Offline';
}

function copyAddress(addr) {
  navigator.clipboard.writeText(addr);
  const icon = document.querySelector('.copy-btn');
  if (icon) {
    icon.textContent = '✔';
    setTimeout(() => (icon.textContent = '📋'), 1200);
  }
}

function persistPoints(key, points) {
  localStorage.setItem(key, JSON.stringify(points));
}

function loadPoints(key) {
  try {
    return JSON.parse(localStorage.getItem(key)) || [];
  } catch {
    return [];
  }
}

function addEventLog(event) {
  const logs = loadPoints(STORAGE_KEYS.events);
  logs.unshift(event);
  if (logs.length > EVENTS_MAX) logs.pop();
  persistPoints(STORAGE_KEYS.events, logs);
}

/* ================= MAIN ================= */

window.addEventListener('DOMContentLoaded', () => {
  const addressInput = $('addressInput');
  const addressDisplay = $('addressDisplay');

  addressInput.addEventListener('change', () => {
    const addr = addressInput.value.trim();
    if (!addr.startsWith('inj')) return;

    addressDisplay.innerHTML = `${shortAddr(addr)} <button class="icon-btn copy-btn" onclick="copyAddress('${addr}')">📋</button>`;
    localStorage.setItem('addr', addr);
    loadUserData(addr);
  });

  const stored = localStorage.getItem('addr');
  if (stored) {
    addressDisplay.innerHTML = `${shortAddr(stored)} <button class="icon-btn copy-btn" onclick="copyAddress('${stored}')">📋</button>`;
    addressInput.value = stored;
    loadUserData(stored);
  }

  initMenu();
  initTheme();
});

function loadUserData(addr) {
  console.log('Loading data for', addr);
  // Placeholder: trigger fetch data, update charts, etc.
}

function initMenu() {
  const navItems = document.querySelectorAll('.nav-item');
  navItems.forEach((btn) => {
    btn.addEventListener('click', () => {
      navItems.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const page = btn.dataset.page;
      document.querySelectorAll('.page').forEach((sec) => {
        sec.classList.toggle('active', sec.dataset.page === page);
        sec.setAttribute('aria-hidden', sec.dataset.page !== page);
      });
    });
  });

  const menuBtn = $('menuBtn');
  const drawer = $('drawer');
  const backdrop = $('backdrop');
  menuBtn.addEventListener('click', () => {
    drawer.setAttribute('aria-hidden', 'false');
    backdrop.setAttribute('aria-hidden', 'false');
  });
  backdrop.addEventListener('click', () => {
    drawer.setAttribute('aria-hidden', 'true');
    backdrop.setAttribute('aria-hidden', 'true');
  });
}

function initTheme() {
  const themeBtn = $('themeToggle');
  const icon = $('themeIcon');
  const root = document.documentElement;

  themeBtn.addEventListener('click', () => {
    const dark = root.classList.toggle('light');
    icon.textContent = dark ? '🌞' : '🌙';
  });
}

// More interactive logic and chart drawing will be inserted during the chart implementation phase.
