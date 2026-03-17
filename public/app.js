const API_BASE = '';
const FETCH_TIMEOUT_MS = 20000;

const fetchOpts = { credentials: 'include' };

function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...fetchOpts, ...opts, signal: controller.signal })
    .finally(() => clearTimeout(timeout));
}

async function fetchPolymarket() {
  const res = await fetchWithTimeout(`${API_BASE}/api/polymarket`);
  if (!res.ok) throw new Error(`Polymarket: ${res.status}`);
  const data = await res.json();
  return data.games || [];
}

async function fetchKalshi() {
  const res = await fetchWithTimeout(`${API_BASE}/api/kalshi`);
  if (!res.ok) throw new Error(`Kalshi: ${res.status}`);
  const data = await res.json();
  return data.games || [];
}

async function fetchUpcoming() {
  const res = await fetchWithTimeout(`${API_BASE}/api/nba/upcoming`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.games || [];
}

async function fetchLiveGames() {
  try {
    const res = await fetchWithTimeout(`${API_BASE}/api/nba/live`);
    if (!res.ok) return;
    const data = await res.json();
    liveGames = data.games || [];
    renderLiveGames();
  } catch {
    liveGames = [];
    renderLiveGames();
  }
}

function renderLiveGames() {
  const content = document.getElementById('liveContent');
  if (!content) return;
  if (liveGames.length === 0) {
    content.innerHTML = '<p class="live-empty">No games in progress right now.</p>';
    return;
  }
  content.innerHTML = `
    <div class="live-list">
      ${liveGames.map((g) => `
        <a href="${escapeHtml(g.url || '#')}" target="_blank" rel="noopener" class="live-card">
          <span class="live-matchup">${escapeHtml(g.awayTeam)} ${g.awayScore ?? 0} – ${g.homeScore ?? 0} ${escapeHtml(g.homeTeam)}</span>
          <span class="live-status">${escapeHtml(g.gameStatusText || 'Live')}</span>
        </a>
      `).join('')}
    </div>`;
}

function gameKey(away, home) {
  return `${String(away).toUpperCase()}-${String(home).toUpperCase()}`;
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/New_York',
  });
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

let currentRows = [];
let liveGames = [];
let authState = { polymarket: false, kalshi: false };
let balances = { polymarket: null, kalshi: null };
let myOrders = { polymarket: { orders: [], error: null }, kalshi: { orders: [], error: null } };

function renderOddsCell(game, platform, canBet) {
  if (!game) return '<div class="odds-cell"><span class="empty-odds">—</span></div>';
  const homePct = Math.round((game.homeOdds || 0) * 100);
  const awayPct = Math.round((game.awayOdds || 0) * 100);
  const label = game.label ? ` <span class="market-label">(${escapeHtml(game.label)})</span>` : '';
  const url = game.url || '#';
  const showBet = canBet && ((platform === 'polymarket' && game.tokenIdAway) || (platform === 'kalshi' && game.marketTicker));
  const betBtn = showBet
    ? `<button type="button" class="bet-btn" data-platform="${escapeHtml(platform)}" data-game-key="${escapeHtml(gameKey(game.awayTeam, game.homeTeam))}" title="Place bet">Bet</button>`
    : '';
  return `
    <div class="odds-cell">
      <a href="${url}" target="_blank" rel="noopener" style="color:inherit;text-decoration:none;">
        <div class="odds-line">
          <span class="odds-value ${awayPct < 50 ? 'low' : ''}">${awayPct}%</span>
          <span class="odds-label">${escapeHtml(game.awayTeam)}</span>
          <span class="odds-value ${homePct < 50 ? 'low' : ''}">${homePct}%</span>
          <span class="odds-label">${escapeHtml(game.homeTeam)}</span>
        </div>
        ${label}
      </a>
      ${betBtn}
    </div>
  `;
}

function renderMatchupCell(poly, kalshi, upcoming) {
  const g = poly || upcoming || kalshi;
  const away = g?.awayTeam || 'Away';
  const home = g?.homeTeam || 'Home';
  const hasScore = g && g.awayScore != null && g.homeScore != null;
  const scoreStr = hasScore ? `<span class="matchup-score">${escapeHtml(String(g.awayScore))} – ${escapeHtml(String(g.homeScore))}</span>` : '<span class="vs">vs</span>';
  const statusStr = (poly?.gameStatusText || g?.gameStatusText) ? `<div class="matchup-status">${escapeHtml(poly?.gameStatusText || g?.gameStatusText || '')}</div>` : '';
  const dateSource = upcoming?.startDate || poly?.startDate || kalshi?.startDate;
  const dateStr = dateSource ? `<div class="game-date">${formatDate(dateSource)}</div>` : '';
  const link = (poly?.url || kalshi?.url || upcoming?.url) || '#';
  return `
    <div class="matchup-cell">
      <a href="${link}" target="_blank" rel="noopener">
        <span>${escapeHtml(away)}</span> ${scoreStr} <span>${escapeHtml(home)}</span>
        ${statusStr}
        ${dateStr}
      </a>
    </div>
  `;
}

function getConnectionErrorHint() {
  if (typeof window !== 'undefined' && window.location?.protocol === 'file:') {
    return ' Open http://localhost:3000 in your browser and run "npm start" in the project folder.';
  }
  return ' If the server is running, try refreshing the page.';
}

async function load(options = {}) {
  const refreshBtn = document.getElementById('refreshBtn');
  const wrapper = document.getElementById('gamesTableWrapper');
  const animate = options.animate === true;

  if (animate) {
    refreshBtn.classList.add('is-refreshing');
    refreshBtn.disabled = true;
  }

  wrapper.innerHTML = '<div class="loading" id="mainLoading">Loading odds…</div>';

  try {
    const [polyResult, kalshiResult, upcomingResult] = await Promise.allSettled([
      fetchPolymarket(),
      fetchKalshi(),
      fetchUpcoming(),
    ]);

    const polyGames = polyResult.status === 'fulfilled' ? polyResult.value : [];
    const kalshiGames = kalshiResult.status === 'fulfilled' ? kalshiResult.value : [];
    const upcomingGames = upcomingResult.status === 'fulfilled' ? upcomingResult.value : [];

    if (polyResult.status !== 'fulfilled') {
      wrapper.innerHTML = `<div class="error">${escapeHtml(polyResult.reason?.message || 'Failed to load Polymarket')}${getConnectionErrorHint()}</div>`;
      return;
    }

    const byKey = new Map();

    for (const g of kalshiGames) {
      const key = gameKey(g.awayTeam, g.homeTeam);
      byKey.set(key, { poly: null, kalshi: g, upcoming: null, sortDate: g.startDate || '' });
    }
    for (const g of upcomingGames) {
      const key = gameKey(g.awayTeam, g.homeTeam);
      const existing = byKey.get(key);
      if (existing) {
        existing.upcoming = g;
        if (g.startDate) existing.sortDate = existing.sortDate || g.startDate;
      } else byKey.set(key, { poly: null, kalshi: null, upcoming: g, sortDate: g.startDate || '' });
    }
    for (const g of polyGames) {
      const key = gameKey(g.awayTeam, g.homeTeam);
      const existing = byKey.get(key);
      if (existing) {
        existing.poly = g;
        if (g.startDate) existing.sortDate = existing.sortDate || g.startDate;
      } else byKey.set(key, { poly: g, kalshi: null, upcoming: null, sortDate: g.startDate || '' });
    }

    const rows = Array.from(byKey.entries()).map(([key, { poly, kalshi, upcoming }]) => ({
      key,
      poly,
      kalshi,
      upcoming,
      sortDate: (poly?.startDate || kalshi?.startDate || upcoming?.startDate) || '',
    }));
    const isCompleted = (r) => {
      const status = (r.poly?.gameStatusText || r.kalshi?.gameStatusText || r.upcoming?.gameStatusText || '').toLowerCase();
      if (status.includes('final')) return true;
      const d = (r.sortDate && new Date(r.sortDate)) || null;
      return d && !isNaN(d.getTime()) && d.getTime() < Date.now();
    };
    rows.sort((a, b) => {
      const aDone = isCompleted(a);
      const bDone = isCompleted(b);
      if (aDone && !bDone) return 1;
      if (!aDone && bDone) return -1;
      return new Date(a.sortDate || 0) - new Date(b.sortDate || 0);
    });

    if (rows.length === 0) {
      wrapper.innerHTML = '<div class="empty">No NBA games available right now.</div>';
      return;
    }

    currentRows = rows;
    wrapper.innerHTML = `
      <table class="games-table">
        <thead>
          <tr>
            <th class="col-matchup">Matchup</th>
            <th class="col-poly">Polymarket (moneyline)</th>
            <th class="col-kalshi">Kalshi (moneyline)</th>
          </tr>
        </thead>
        <tbody>
          ${rows
            .map(
              (r) => `
            <tr class="game-row">
              <td class="col-matchup">${renderMatchupCell(r.poly, r.kalshi, r.upcoming)}</td>
              <td class="col-poly">${renderOddsCell(r.poly, 'polymarket', authState.polymarket)}</td>
              <td class="col-kalshi">${renderOddsCell(r.kalshi, 'kalshi', authState.kalshi)}</td>
            </tr>
          `
            )
            .join('')}
        </tbody>
      </table>
    `;
    document.querySelectorAll('.bet-btn').forEach((btn) => {
      btn.addEventListener('click', () => openBetModal(btn.dataset.platform, btn.dataset.gameKey));
    });
    refreshBalances();
    if (authState.polymarket || authState.kalshi) fetchMyOrders();
    fetchLiveGames();
  } catch (err) {
    wrapper.innerHTML = `<div class="error">${escapeHtml(err?.message || 'Failed to load')}${getConnectionErrorHint()}</div>`;
  } finally {
    if (animate) {
      refreshBtn.disabled = false;
      refreshBtn.classList.remove('is-refreshing');
    }
  }
}

async function fetchAuthStatus() {
  try {
    const res = await fetchWithTimeout(`${API_BASE}/api/auth/status`);
    const data = await res.json();
    authState = { polymarket: !!data.polymarket, kalshi: !!data.kalshi };
  } catch {
    authState = { polymarket: false, kalshi: false };
  }
  if (authState.polymarket || authState.kalshi) {
    try {
      const res = await fetchWithTimeout(`${API_BASE}/api/balances`);
      const data = await res.json();
      balances = { polymarket: data.polymarket ?? null, kalshi: data.kalshi ?? null };
    } catch {
      balances = { polymarket: null, kalshi: null };
    }
  } else {
    balances = { polymarket: null, kalshi: null };
  }
  updateAuthUI();
  if (authState.polymarket || authState.kalshi) fetchMyOrders();
  else renderDashboard();
}

async function refreshBalances() {
  if (!authState.polymarket && !authState.kalshi) return;
  try {
    const res = await fetchWithTimeout(`${API_BASE}/api/balances`);
    const data = await res.json();
    balances = { polymarket: data.polymarket ?? null, kalshi: data.kalshi ?? null };
  } catch {
    balances = { polymarket: null, kalshi: null };
  }
  updateAuthUI();
}

async function fetchMyOrders() {
  if (!authState.polymarket && !authState.kalshi) {
    myOrders = { polymarket: { orders: [], error: null }, kalshi: { orders: [], error: null } };
    renderDashboard();
    return;
  }
  try {
    const res = await fetchWithTimeout(`${API_BASE}/api/my-orders`);
    const data = await res.json();
    myOrders = {
      polymarket: data.polymarket ?? { orders: [], error: null },
      kalshi: data.kalshi ?? { orders: [], error: null },
    };
  } catch {
    myOrders = { polymarket: { orders: [], error: null }, kalshi: { orders: [], error: null } };
  }
  renderDashboard();
}

let arbOpportunities = [];
let arbConfig = {};
const ARB_POLL_INTERVAL_MS = 500; // poll every 0.5s; faster = more chance to catch arbs before they disappear
const SIM_INITIAL_POLY = 1000;
const SIM_INITIAL_KAL = 1000;
const SIM_COOLDOWN_MS = 3000; // same game+strategy can be taken again after 3s (arbs often flash repeatedly)
let simRunning = false;
let simPoly = SIM_INITIAL_POLY;
let simKal = SIM_INITIAL_KAL;
let simHistory = []; // { t, poly, kal, total }
let simTaken = new Map(); // key (gameKey-strategy) -> lastTakenTime
let simChart = null;
let simHistoryIntervalId = null;
const ARB_STALE_KEEP_MS = 8000; // keep disappeared opportunities visible for 8s so user can click "Place arb"
const ARB_PAST_MAX = 50; // max past opportunities to keep
const arbStaleMap = new Map(); // key = gameKey+strategy, value = { ...opp, staleUntil }
let arbPastOpportunities = []; // { ...opp, lastSeenAt } newest first, capped at ARB_PAST_MAX
let arbPollTimerId = null;
let arbFetchInFlight = false;
let arbPendingManualCheck = false;
let arbShowCheckingIndicator = false;
let arbUserHasClickedCheck = false; // only show indicator after user has clicked "Check arb" at least once

async function fetchArbOpportunities(silent = false) {
  if (arbFetchInFlight) {
    if (!silent) arbPendingManualCheck = true;
    return;
  }
  const btn = document.getElementById('checkArbBtn');
  const content = document.getElementById('arbContent');
  arbShowCheckingIndicator = !silent;
  if (!silent) {
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Checking…';
    }
    content.hidden = false;
    content.innerHTML = '<div class="loading">Loading…</div>';
  }
  arbFetchInFlight = true;
  updateArbCheckingIndicator();
  try {
    const res = await fetchWithTimeout(`${API_BASE}/api/arb/opportunities`);
    const data = await res.json().catch(() => ({}));
    const newList = data.opportunities || [];
    const newKeys = new Set(newList.map((o) => `${o.gameKey}-${o.strategy}`));
    const prev = arbOpportunities;
    arbOpportunities = newList;
    for (const o of prev) {
      const key = `${o.gameKey}-${o.strategy}`;
      if (!newKeys.has(key)) arbStaleMap.set(key, { ...o, staleUntil: Date.now() + ARB_STALE_KEEP_MS });
    }
    for (const key of arbStaleMap.keys()) {
      if (arbStaleMap.get(key).staleUntil < Date.now()) arbStaleMap.delete(key);
    }
    arbConfig = data.config || {};
    if (simRunning) processSimulationArbs(newList);
    renderArbOpportunities();
    content.hidden = false;
  } catch (err) {
    if (!silent) {
      content.innerHTML = `<div class="error">${escapeHtml(err?.message || 'Failed to load arb opportunities')}</div>`;
    }
    content.hidden = false;
  } finally {
    arbFetchInFlight = false;
    updateArbCheckingIndicator();
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Check arb';
    }
    if (arbPendingManualCheck) {
      arbPendingManualCheck = false;
      setTimeout(() => fetchArbOpportunities(false), 0);
    }
  }
}

function updateArbCheckingIndicator() {
  const el = document.getElementById('arbCheckingIndicator');
  const show = arbFetchInFlight && arbShowCheckingIndicator && arbUserHasClickedCheck;
  if (el) el.hidden = !show;
}

function startArbAutoRefresh() {
  if (arbPollTimerId != null) return;
  const indicatorEl = document.getElementById('arbCheckingIndicator');
  if (indicatorEl) indicatorEl.hidden = true;
  fetchArbOpportunities(true);
  arbPollTimerId = setInterval(() => fetchArbOpportunities(true), ARB_POLL_INTERVAL_MS);
}

function processSimulationArbs(opportunities) {
  const now = Date.now();
  for (const opp of opportunities) {
    const key = `${opp.gameKey}-${opp.strategy}`;
    const last = simTaken.get(key);
    if (last != null && now - last < SIM_COOLDOWN_MS) continue;
    const x = Number(opp.stakePolyUsd) || 0;
    const y = Number(opp.stakeKalshiUsd) || 0;
    const fee = Number(opp.feeUsd) || 0;
    const payout = x / (Number(opp.polyPrice) || 0.5);
    if (simPoly < x || simKal < y) continue;
    simPoly -= x;
    simKal -= y;
    simPoly += payout - fee;
    simTaken.set(key, now);
    simHistory.push({ t: now, poly: simPoly, kal: simKal, total: simPoly + simKal });
    updateSimChart();
  }
  renderSimBalances();
}

function renderSimBalances() {
  const el = document.getElementById('simBalances');
  if (!el) return;
  el.textContent = `Poly $${simPoly.toFixed(2)}  ·  Kalshi $${simKal.toFixed(2)}  ·  Total $${(simPoly + simKal).toFixed(2)}`;
}

function updateSimChart() {
  if (!simChart || !simHistory.length) return;
  const labels = simHistory.map((p) => {
    const d = new Date(p.t);
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  });
  simChart.data.labels = labels;
  simChart.data.datasets[0].data = simHistory.map((p) => p.poly);
  simChart.data.datasets[1].data = simHistory.map((p) => p.kal);
  simChart.data.datasets[2].data = simHistory.map((p) => p.poly + p.kal);
  simChart.update('none');
}

function initSimChart() {
  const canvas = document.getElementById('simChart');
  if (!canvas || typeof Chart === 'undefined') return;
  if (simChart) simChart.destroy();
  simChart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        { label: 'Polymarket', data: [], borderColor: '#6366f1', backgroundColor: 'rgba(99, 102, 241, 0.1)', fill: true, tension: 0.1 },
        { label: 'Kalshi', data: [], borderColor: '#f59e0b', backgroundColor: 'rgba(245, 158, 11, 0.1)', fill: true, tension: 0.1 },
        { label: 'Total', data: [], borderColor: '#22c55e', backgroundColor: 'rgba(34, 197, 94, 0.1)', fill: true, tension: 0.1 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { ticks: { maxTicksLimit: 12, color: '#8b92a8' }, grid: { color: '#2a3140' } },
        y: { beginAtZero: false, ticks: { color: '#8b92a8' }, grid: { color: '#2a3140' } },
      },
      plugins: { legend: { labels: { color: '#e6e9f0' } } },
    },
  });
}

function startSimulation() {
  simRunning = true;
  simPoly = SIM_INITIAL_POLY;
  simKal = SIM_INITIAL_KAL;
  simHistory = [{ t: Date.now(), poly: simPoly, kal: simKal, total: simPoly + simKal }];
  simTaken = new Map();
  initSimChart();
  updateSimChart();
  renderSimBalances();
  document.getElementById('simStartBtn').disabled = true;
  document.getElementById('simStopBtn').disabled = false;
  simHistoryIntervalId = setInterval(() => {
    if (!simRunning) return;
    simHistory.push({ t: Date.now(), poly: simPoly, kal: simKal, total: simPoly + simKal });
    if (simHistory.length > 500) simHistory = simHistory.slice(-400);
    updateSimChart();
  }, 2000);
}

function stopSimulation() {
  simRunning = false;
  if (simHistoryIntervalId) {
    clearInterval(simHistoryIntervalId);
    simHistoryIntervalId = null;
  }
  document.getElementById('simStartBtn').disabled = false;
  document.getElementById('simStopBtn').disabled = true;
}

function formatLastSeen(ms) {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return sec <= 1 ? 'just now' : sec + ' s ago';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + ' min ago';
  const hr = Math.floor(min / 60);
  return hr + ' hr ago';
}

function renderArbOpportunities() {
  const content = document.getElementById('arbContent');
  const pastSection = document.getElementById('arbPastSection');
  const pastContent = document.getElementById('arbPastContent');
  if (!content) return;

  const now = Date.now();
  for (const key of Array.from(arbStaleMap.keys())) {
    const o = arbStaleMap.get(key);
    if (o.staleUntil < now) {
      const { staleUntil, ...opp } = o;
      arbPastOpportunities.unshift({ ...opp, lastSeenAt: now - ARB_STALE_KEEP_MS });
      if (arbPastOpportunities.length > ARB_PAST_MAX) arbPastOpportunities.pop();
      arbStaleMap.delete(key);
    }
  }

  const staleList = Array.from(arbStaleMap.values());
  const displayList = [...arbOpportunities, ...staleList];
  if (displayList.length === 0) {
    content.innerHTML = '<p class="arb-empty">No arb opportunities above the minimum profit threshold.</p>';
  } else {
    content.innerHTML = `
      <div class="arb-list">
        ${displayList.map((opp, i) => {
          const isStale = i >= arbOpportunities.length;
          const canPlace = !isStale && authState.polymarket && authState.kalshi;
          return `
          <div class="arb-card ${isStale ? 'arb-card-stale' : ''}" data-index="${i}" data-stale="${isStale}">
            ${isStale ? '<div class="arb-stale-badge">Arb no longer valid — do not place</div><div class="arb-stale-warning">This opportunity no longer exists. Placing this bet could lose money.</div>' : ''}
            <div class="arb-game">${escapeHtml(opp.awayTeam)} @ ${escapeHtml(opp.homeTeam)}</div>
            <div class="arb-strategy">${escapeHtml(opp.strategyLabel || '')}</div>
            <div class="arb-details">
              Stake Poly $${opp.stakePolyUsd} · Kalshi $${opp.stakeKalshiUsd} · Net profit $${opp.netProfitUsd}${opp.feeUsd != null ? ` (fee $${opp.feeUsd})` : ''}
            </div>
            <button type="button" class="auth-btn arb-place-btn" data-index="${i}" data-stale="${isStale}" ${!canPlace ? 'disabled' : ''} title="${isStale ? 'Arb no longer valid — do not place. You could lose money.' : (!authState.polymarket || !authState.kalshi) ? 'Sign in to both Polymarket and Kalshi' : 'Place arb'}">${isStale ? 'No longer valid' : 'Place arb'}</button>
          </div>`;
        }).join('')}
      </div>`;
    content.querySelectorAll('.arb-place-btn').forEach((btn) => {
      if (btn.dataset.stale === 'true') return;
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.index, 10);
        const opp = displayList[idx];
        if (opp && !opp.staleUntil) placeArb(opp, btn);
      });
    });
  }
  content.hidden = false;

  if (pastSection && pastContent) {
    if (arbPastOpportunities.length === 0) {
      pastSection.hidden = true;
    } else {
      pastSection.hidden = false;
      pastContent.innerHTML = `
        <div class="arb-list arb-past-list">
          ${arbPastOpportunities.map((opp) => {
            const lastSeen = formatLastSeen(now - opp.lastSeenAt);
            return `
            <div class="arb-card arb-card-past">
              <div class="arb-past-meta">Last seen ${escapeHtml(lastSeen)}</div>
              <div class="arb-game">${escapeHtml(opp.awayTeam)} @ ${escapeHtml(opp.homeTeam)}</div>
              <div class="arb-strategy">${escapeHtml(opp.strategyLabel || '')}</div>
              <div class="arb-details">
                Stake Poly $${opp.stakePolyUsd} · Kalshi $${opp.stakeKalshiUsd} · Net profit $${opp.netProfitUsd}${opp.feeUsd != null ? ` (fee $${opp.feeUsd})` : ''}
              </div>
            </div>`;
          }).join('')}
        </div>`;
    }
  }
}

async function placeArb(opp, btnEl) {
  if (!authState.polymarket || !authState.kalshi) {
    alert('Sign in to both Polymarket and Kalshi to place an arb.');
    return;
  }
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.textContent = 'Placing…';
  }
  try {
    const res = await fetch(`${API_BASE}/api/arb/execute`, {
      method: 'POST',
      ...fetchOpts,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opp),
    });
    let data = {};
    try {
      data = await res.json();
    } catch (_) {
      data = { error: res.statusText || 'Request failed' };
    }
    if (!res.ok) {
      const msg = typeof data.error === 'string' ? data.error : (data.error && (data.error.message || String(data.error))) || 'Arb execute failed';
      if (data.leg1Done) {
        alert(`Warning: Poly leg filled but Kalshi failed. ${msg}`);
      } else {
        alert(msg);
      }
      return;
    }
    alert('Arb placed. Poly and Kalshi orders submitted.');
    await fetchAuthStatus();
    fetchMyOrders();
    fetchArbOpportunities();
  } catch (err) {
    alert(err?.message || 'Arb execute failed');
  } finally {
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.textContent = 'Place arb';
    }
  }
}

function kalshiTickerToMatchup(ticker) {
  if (!ticker || typeof ticker !== 'string') return null;
  const m = ticker.match(/KXNBAGAME-\d{2}[A-Z]{3}\d{2}([A-Z]{3})([A-Z]{3})/);
  return m ? { away: m[1], home: m[2] } : null;
}

function kalshiTickerToTeam(ticker) {
  if (!ticker || typeof ticker !== 'string') return null;
  const parts = ticker.split('-');
  return parts.length >= 3 ? parts[parts.length - 1] : null;
}

function renderDashboard() {
  const hint = document.getElementById('dashboardHint');
  const content = document.getElementById('dashboardContent');
  if (!authState.polymarket && !authState.kalshi) {
    hint.hidden = false;
    content.hidden = true;
    return;
  }
  hint.hidden = true;
  content.hidden = false;
  const parts = [];
  if (authState.polymarket) {
    const poly = myOrders.polymarket;
    const orders = poly?.orders || [];
    const err = poly?.error;
    parts.push(`
      <div class="dashboard-section">
        <h4>Polymarket</h4>
        ${err ? `<p class="dashboard-order-card poly" style="color:var(--text-muted)">${escapeHtml(err)}</p>` : ''}
        ${orders.length === 0 && !err ? '<p class="order-detail">No open orders</p>' : ''}
        ${(orders.slice(0, 20)).map((o) => {
          const size = o.original_size != null ? Number(o.original_size) : '';
          const matched = o.size_matched != null ? Number(o.size_matched) : 0;
          const price = o.price != null ? (Number(o.price) * 100).toFixed(0) + '¢' : '';
          return `<div class="dashboard-order-card poly">
            <div class="order-game">Order ${escapeHtml((o.asset_id || o.id || '').slice(0, 12))}…</div>
            <div class="order-detail">${o.side || 'buy'} ${size} @ ${price} (matched: ${matched})</div>
            <div class="order-status">${escapeHtml(o.status || '')}</div>
          </div>`;
        }).join('')}
      </div>`);
  }
  if (authState.kalshi) {
    const kalshi = myOrders.kalshi;
    const allOrders = kalshi?.orders || [];
    const orders = allOrders.filter((o) => {
      const ticker = o.ticker || o.market_ticker || '';
      const status = (o.status || '').toLowerCase();
      return ticker.startsWith('KXNBAGAME-') && (status === 'resting' || status === 'pending' || status === 'open');
    });
    const err = kalshi?.error;
    parts.push(`
      <div class="dashboard-section">
        <h4>Kalshi (NBA moneyline only)</h4>
        ${err ? `<p class="dashboard-order-card kalshi" style="color:var(--text-muted)">${escapeHtml(err)}</p>` : ''}
        ${orders.length === 0 && !err ? '<p class="order-detail">No NBA game orders</p>' : ''}
        ${(orders.slice(0, 20)).map((o) => {
          const ticker = o.ticker || o.market_ticker || '';
          const matchup = kalshiTickerToMatchup(ticker);
          const team = kalshiTickerToTeam(ticker);
          const gameStr = matchup ? `${matchup.away} vs ${matchup.home}` : ticker.slice(0, 24) + '…';
          const side = o.side === 'yes' ? (team ? team + ' wins' : 'Yes') : (team ? team + ' no' : 'No');
          const status = o.status || '';
          const price = o.yes_price != null ? o.yes_price + '¢' : (o.order?.yes_price != null ? o.order.yes_price + '¢' : '');
          const count = o.remaining_count ?? o.count ?? o.order?.remaining_count ?? o.order?.count ?? '';
          return `<div class="dashboard-order-card kalshi">
            <div class="order-game">${escapeHtml(gameStr)}</div>
            <div class="order-detail">${escapeHtml(side)} · ${count} @ ${price}</div>
            <div class="order-status">${escapeHtml(status)}</div>
          </div>`;
        }).join('')}
      </div>`);
  }
  content.innerHTML = parts.join('');
}

function formatBalance(platform) {
  const b = platform === 'polymarket' ? balances.polymarket : balances.kalshi;
  if (!b) return '';
  if (b.error) {
    const msg = String(b.error).slice(0, 80);
    return msg.length < String(b.error).length ? ` (error: ${msg}…)` : ` (error: ${msg})`;
  }
  if (platform === 'polymarket' && b.balanceUsdc != null) {
    const s = ` $${Number(b.balanceUsdc).toFixed(2)}`;
    if (b.hint) return s + ' — ' + b.hint;
    if (b.allowanceUsdc != null && b.allowanceUsdc < b.balanceUsdc) return s + ` (allowance $${Number(b.allowanceUsdc).toFixed(2)})`;
    return s;
  }
  if (platform === 'kalshi' && b.balanceCents != null) return ` $${(Number(b.balanceCents) / 100).toFixed(2)}`;
  return '';
}

function updateAuthUI() {
  const statusEl = document.getElementById('authStatus');
  const logoutBtn = document.getElementById('logoutBtn');
  const polyBtn = document.getElementById('signInPolyBtn');
  const kalshiBtn = document.getElementById('signInKalshiBtn');
  const enablePolyUsdcBtn = document.getElementById('enablePolyUsdcBtn');
  const parts = [];
  if (authState.polymarket) parts.push('Polymarket' + formatBalance('polymarket'));
  if (authState.kalshi) parts.push('Kalshi' + formatBalance('kalshi'));
  statusEl.textContent = parts.length ? `Signed in: ${parts.join(' | ')}` : '';
  logoutBtn.style.display = parts.length ? 'inline-block' : 'none';
  polyBtn.style.display = authState.polymarket ? 'none' : 'inline-block';
  kalshiBtn.style.display = authState.kalshi ? 'none' : 'inline-block';
  const poly = balances.polymarket;
  const needAllowance = authState.polymarket && poly && poly.balanceUsdc > 0 && (poly.allowanceUsdc == null || poly.allowanceUsdc < poly.balanceUsdc);
  if (enablePolyUsdcBtn) enablePolyUsdcBtn.style.display = needAllowance ? 'inline-block' : 'none';
  const enablePolyUsdcManual = document.getElementById('enablePolyUsdcManual');
  if (enablePolyUsdcManual) enablePolyUsdcManual.style.display = needAllowance ? 'inline-block' : 'none';
  const enablePolyUsdcCtfManual = document.getElementById('enablePolyUsdcCtfManual');
  if (enablePolyUsdcCtfManual) enablePolyUsdcCtfManual.style.display = needAllowance ? 'inline-block' : 'none';
}

function openBetModal(platform, key) {
  const row = currentRows.find((r) => r.key === key);
  const game = row && (platform === 'polymarket' ? row.poly : row.kalshi);
  if (!game) return;
  const modal = document.getElementById('betModal');
  const form = document.getElementById('betForm');
  const fieldsEl = document.getElementById('betFormFields');
  const titleEl = document.getElementById('betModalTitle');
  form.dataset.platform = platform;
  form.dataset.gameKey = key;
  form.dataset.game = JSON.stringify(game);

  if (platform === 'polymarket') {
    titleEl.textContent = `Bet on ${game.awayTeam} vs ${game.homeTeam} (Polymarket)`;
    const defaultPriceAway = (game.awayOdds || 0.5).toFixed(2);
    const defaultPriceHome = (game.homeOdds || 0.5).toFixed(2);
    fieldsEl.innerHTML = `
      <label>Outcome
        <select name="outcome" required>
          <option value="away" data-token="${escapeHtml(game.tokenIdAway || '')}" data-price="${defaultPriceAway}">${escapeHtml(game.awayTeam)} wins</option>
          <option value="home" data-token="${escapeHtml(game.tokenIdHome || '')}" data-price="${defaultPriceHome}">${escapeHtml(game.homeTeam)} wins</option>
        </select>
      </label>
      <label>Price (0–1) <input type="number" name="price" step="0.01" min="0.01" max="0.99" value="${defaultPriceAway}" required /></label>
      <label>Size (shares) <input type="number" name="size" min="1" step="1" value="10" required /> <span class="form-hint">Min $1 total (size × price)</span></label>
    `;
    fieldsEl.querySelector('select[name="outcome"]').addEventListener('change', (e) => {
      const opt = e.target.selectedOptions[0];
      if (opt) form.querySelector('input[name="price"]').value = opt.dataset.price;
    });
  } else {
    titleEl.textContent = `Bet on ${game.awayTeam} vs ${game.homeTeam} (Kalshi moneyline)`;
    const homeCents = Math.round((game.homeOdds || 0.5) * 100);
    const awayCents = Math.round((game.awayOdds || 0.5) * 100);
    const tickerHome = game.marketTickerHome || game.marketTicker;
    const tickerAway = game.marketTickerAway || game.marketTicker;
    fieldsEl.innerHTML = `
      <label>Pick winner
        <select name="outcome" required>
          <option value="home" data-ticker="${escapeHtml(tickerHome)}" data-cents="${homeCents}">${escapeHtml(game.homeTeam)} wins</option>
          <option value="away" data-ticker="${escapeHtml(tickerAway)}" data-cents="${awayCents}">${escapeHtml(game.awayTeam)} wins</option>
        </select>
      </label>
      <label>Contracts <input type="number" name="count" min="1" value="1" required /></label>
      <label>Limit price (¢ per contract, 1–99) <input type="number" name="yes_price" min="1" max="99" value="${homeCents}" required /></label>
    `;
    fieldsEl.querySelector('select[name="outcome"]').addEventListener('change', (e) => {
      const opt = e.target.selectedOptions[0];
      if (opt) form.querySelector('input[name="yes_price"]').value = opt.dataset.cents;
    });
  }
  modal.hidden = false;
}

function closeBetModal() {
  document.getElementById('betModal').hidden = true;
}

document.getElementById('refreshBtn').addEventListener('click', () => load({ animate: true }));

document.getElementById('signInPolyBtn').addEventListener('click', () => {
  document.getElementById('polySignInModal').hidden = false;
});
document.getElementById('closePolySignIn').addEventListener('click', () => {
  document.getElementById('polySignInModal').hidden = true;
});
const POLY_REMEMBER_KEY = 'nbaOdds_polyRemember';
const KALSHI_REMEMBER_KEY = 'nbaOdds_kalshiRemember';

document.getElementById('polySignInForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const payload = {
    apiKey: fd.get('apiKey'),
    secret: fd.get('secret'),
    passphrase: fd.get('passphrase'),
    privateKey: fd.get('privateKey'),
  };
  const res = await fetch(`${API_BASE}/api/auth/polymarket`, {
    method: 'POST',
    ...fetchOpts,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    alert(data.error || 'Sign-in failed');
    return;
  }
  if (fd.get('remember')) try { localStorage.setItem(POLY_REMEMBER_KEY, JSON.stringify(payload)); } catch (_) {}
  else try { localStorage.removeItem(POLY_REMEMBER_KEY); } catch (_) {}
  document.getElementById('polySignInModal').hidden = true;
  e.target.reset();
  await fetchAuthStatus();
  load({ animate: false });
});

document.getElementById('signInKalshiBtn').addEventListener('click', () => {
  document.getElementById('kalshiSignInModal').hidden = false;
});
document.getElementById('closeKalshiSignIn').addEventListener('click', () => {
  document.getElementById('kalshiSignInModal').hidden = true;
});
document.getElementById('kalshiSignInForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const payload = { apiKeyId: fd.get('apiKeyId'), privateKey: fd.get('privateKey') };
  const res = await fetch(`${API_BASE}/api/auth/kalshi`, {
    method: 'POST',
    ...fetchOpts,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    alert(data.error || 'Sign-in failed');
    return;
  }
  if (fd.get('remember')) try { localStorage.setItem(KALSHI_REMEMBER_KEY, JSON.stringify(payload)); } catch (_) {}
  else try { localStorage.removeItem(KALSHI_REMEMBER_KEY); } catch (_) {}
  document.getElementById('kalshiSignInModal').hidden = true;
  e.target.reset();
  await fetchAuthStatus();
  load({ animate: false });
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await fetch(`${API_BASE}/api/auth/logout`, { method: 'POST', ...fetchOpts });
  try { localStorage.removeItem(POLY_REMEMBER_KEY); localStorage.removeItem(KALSHI_REMEMBER_KEY); } catch (_) {}
  await fetchAuthStatus();
  load({ animate: false });
});

// Polygon: USDC.e, CTF (Conditional Tokens), and CLOB exchange. Both approvals required for orders.
const POLYGON_USDC = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const POLYGON_CTF = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const POLYGON_CLOB_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const POLYGON_CHAIN_ID = '0x89';
const POLYGONSCAN_USDC_WRITE = 'https://polygonscan.com/address/' + POLYGON_USDC + '#writeContract';
const POLYGONSCAN_CTF_WRITE = 'https://polygonscan.com/address/' + POLYGON_CTF + '#writeContract';

function pad32(v, len) {
  return String(v).replace(/^0x/, '').padStart(len || 64, '0');
}
function encodeApprove(spender, amountHex) {
  return '0x095ea7b3' + pad32(spender) + pad32(amountHex || 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
}
function encodeSetApprovalForAll(operator, approved) {
  return '0xa22cb465' + pad32(operator) + pad32(approved ? '1' : '0');
}

function openPolyApproveModal() {
  document.getElementById('polyApproveModal').hidden = false;
}
function closePolyApproveModal() {
  document.getElementById('polyApproveModal').hidden = true;
}

async function onEnablePolyUsdcClick(btn) {
  if (!btn || btn.disabled) return;
  if (typeof window.ethereum === 'undefined') {
    alert('MetaMask not found. Use the manual links below to approve on Polygonscan (connect wallet, Polygon network).');
    window.open(POLYGONSCAN_USDC_WRITE, '_blank');
    return;
  }
  btn.disabled = true;
  btn.textContent = '…';
  try {
    await window.ethereum.request({ method: 'eth_requestAccounts' });
    const chainId = await window.ethereum.request({ method: 'eth_chainId' });
    if (chainId !== POLYGON_CHAIN_ID) {
      try {
        await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: POLYGON_CHAIN_ID }] });
      } catch (e) {
        if (e?.code === 4902) alert('Add Polygon network in MetaMask first, then try again.');
        else alert(e?.message || 'Switch to Polygon in MetaMask and try again.');
        return;
      }
    }
    openPolyApproveModal();
  } catch (e) {
    alert(e?.code === 4001 ? 'Connect with MetaMask first.' : (e?.message || 'Request failed'));
  } finally {
    btn.disabled = false;
    btn.textContent = 'Enable USDC';
  }
}

document.body.addEventListener('click', (e) => {
  const btn = e.target.id === 'enablePolyUsdcBtn' ? e.target : e.target.closest('#enablePolyUsdcBtn');
  if (!btn) return;
  e.preventDefault();
  onEnablePolyUsdcClick(btn);
});

document.getElementById('closePolyApproveModal').addEventListener('click', () => {
  closePolyApproveModal();
  refreshBalances();
});
document.getElementById('polyApproveModal').addEventListener('click', (ev) => {
  if (ev.target.id === 'polyApproveModal') { closePolyApproveModal(); refreshBalances(); }
});
document.getElementById('polyApproveUsdcBtn').addEventListener('click', async function () {
  if (typeof window.ethereum === 'undefined') return;
  const b = this;
  b.disabled = true;
  b.textContent = 'Opening MetaMask…';
  try {
    await window.ethereum.request({
      method: 'eth_sendTransaction',
      params: [{ to: POLYGON_USDC, data: encodeApprove(POLYGON_CLOB_EXCHANGE), value: '0x0' }],
    });
    b.textContent = '1. Approve USDC ✓';
  } catch (e) {
    if (e?.code === 4001) b.textContent = '1. Approve USDC (rejected)';
    else { alert(e?.message || 'Failed'); b.textContent = '1. Approve USDC'; }
  }
  b.disabled = false;
});
document.getElementById('polyApproveCtfBtn').addEventListener('click', async function () {
  if (typeof window.ethereum === 'undefined') return;
  const b = this;
  b.disabled = true;
  b.textContent = 'Opening MetaMask…';
  try {
    await window.ethereum.request({
      method: 'eth_sendTransaction',
      params: [{ to: POLYGON_CTF, data: encodeSetApprovalForAll(POLYGON_CLOB_EXCHANGE, true), value: '0x0' }],
    });
    b.textContent = '2. Approve CTF ✓';
  } catch (e) {
    if (e?.code === 4001) b.textContent = '2. Approve CTF (rejected)';
    else { alert(e?.message || 'Failed'); b.textContent = '2. Approve CTF'; }
  }
  b.disabled = false;
});
const manualUsdcEl = document.getElementById('enablePolyUsdcManual');
if (manualUsdcEl) manualUsdcEl.addEventListener('click', (e) => { e.preventDefault(); window.open(POLYGONSCAN_USDC_WRITE, '_blank'); });
const manualCtfEl = document.getElementById('enablePolyUsdcCtfManual');
if (manualCtfEl) manualCtfEl.addEventListener('click', (e) => { e.preventDefault(); window.open(POLYGONSCAN_CTF_WRITE, '_blank'); });

document.getElementById('closeBetModal').addEventListener('click', closeBetModal);
document.getElementById('betModal').addEventListener('click', (e) => {
  if (e.target.id === 'betModal') closeBetModal();
});
document.getElementById('betForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const platform = form.dataset.platform;
  const gameJson = form.dataset.game;
  if (!platform || !gameJson) {
    closeBetModal();
    return;
  }
  const game = JSON.parse(gameJson);
  const fd = new FormData(form);

  if (platform === 'polymarket') {
    const price = Number(fd.get('price'));
    const size = Number(fd.get('size'));
    const notional = price * size;
    if (notional < 1) {
      alert(`Polymarket minimum order is $1. Your size × price = $${notional.toFixed(2)}. Increase size or price.`);
      return;
    }
    const outcome = fd.get('outcome');
    const tokenId = outcome === 'away' ? game.tokenIdAway : game.tokenIdHome;
    const body = {
      tokenId,
      side: 'BUY',
      price,
      size,
      tickSize: game.tickSize || '0.01',
      negRisk: game.negRisk || false,
    };
    const res = await fetch(`${API_BASE}/api/polymarket/order`, {
      method: 'POST',
      ...fetchOpts,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = typeof data.error === 'object' ? (data.error?.message || JSON.stringify(data.error)) : (data.error || 'Order failed');
      const fix = data.fix || '';
      const ba = data.balanceAllowance;
      const wallet = data.walletAddress;
      const detail = data.detail?.error || data.detail?.message;
      const parts = [msg];
      if (wallet) parts.push(`Wallet: ${wallet}`);
      if (ba) parts.push(`Balance: $${Number(ba.balanceUsdc).toFixed(2)} USDC · Allowance: $${Number(ba.allowanceUsdc).toFixed(2)}`);
      if (detail) parts.push(detail);
      if (fix) parts.push(fix);
      alert(parts.join('\n\n'));
      return;
    }
    alert(`Order placed: ${data.status || 'live'}`);
    closeBetModal();
    await fetchAuthStatus();
    fetchMyOrders();
    load({ animate: false });
  } else {
    const outcome = fd.get('outcome');
    const ticker = outcome === 'home' ? (game.marketTickerHome || game.marketTicker) : (game.marketTickerAway || game.marketTicker);
    const body = {
      ticker,
      side: 'yes',
      count: Number(fd.get('count')),
      yes_price: Number(fd.get('yes_price')),
      client_order_id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    };
    const res = await fetch(`${API_BASE}/api/kalshi/order`, {
      method: 'POST',
      ...fetchOpts,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = typeof data.error === 'object' ? (data.error?.message || JSON.stringify(data.error)) : (data.error || 'Order failed');
      alert(msg);
      return;
    }
    const status = data.order?.status || data.status || '';
    const filled = /filled|executed|complete/i.test(status);
    if (filled) {
      alert('Order filled. Check Kalshi for your position.');
    } else {
      alert('Order filled.');
    }
    closeBetModal();
    await fetchAuthStatus();
    fetchMyOrders();
    load({ animate: false });
  }
});

(async function init() {
  document.getElementById('polySignInModal').hidden = true;
  document.getElementById('kalshiSignInModal').hidden = true;
  document.getElementById('betModal').hidden = true;
  await fetchAuthStatus();
  try {
    if (!authState.polymarket) {
      const raw = localStorage.getItem(POLY_REMEMBER_KEY);
      if (raw) {
        const payload = JSON.parse(raw);
        const res = await fetch(`${API_BASE}/api/auth/polymarket`, { method: 'POST', ...fetchOpts, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        if (res.ok) await fetchAuthStatus();
      }
    }
    if (!authState.kalshi) {
      const raw = localStorage.getItem(KALSHI_REMEMBER_KEY);
      if (raw) {
        const payload = JSON.parse(raw);
        const res = await fetch(`${API_BASE}/api/auth/kalshi`, { method: 'POST', ...fetchOpts, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        if (res.ok) await fetchAuthStatus();
      }
    }
  } catch (_) {}
  fetchLiveGames();
  load();
  const checkArbBtn = document.getElementById('checkArbBtn');
  if (checkArbBtn) {
    checkArbBtn.addEventListener('click', () => {
      arbUserHasClickedCheck = true;
      fetchArbOpportunities(false);
    });
  }
  startArbAutoRefresh();

  const simStartBtn = document.getElementById('simStartBtn');
  const simStopBtn = document.getElementById('simStopBtn');
  if (simStartBtn) simStartBtn.addEventListener('click', startSimulation);
  if (simStopBtn) simStopBtn.addEventListener('click', stopSimulation);
  const simBalancesEl = document.getElementById('simBalances');
  if (simBalancesEl && !simRunning) simBalancesEl.textContent = `Poly $${SIM_INITIAL_POLY}  ·  Kalshi $${SIM_INITIAL_KAL}  ·  Total $${SIM_INITIAL_POLY + SIM_INITIAL_KAL} (initial)`;
})();
