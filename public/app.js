const API_BASE = '';
const FETCH_TIMEOUT_MS = 60000;

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

// NBA tricode → full nickname (all caps) for trade outcome matching
const TRICODE_TO_NICKNAME = {
  ATL: 'HAWKS', BOS: 'CELTICS', BKN: 'NETS', CHA: 'HORNETS',
  CHI: 'BULLS', CLE: 'CAVALIERS', DAL: 'MAVERICKS', DEN: 'NUGGETS',
  DET: 'PISTONS', GSW: 'WARRIORS', HOU: 'ROCKETS', IND: 'PACERS',
  LAC: 'CLIPPERS', LAL: 'LAKERS', MEM: 'GRIZZLIES', MIA: 'HEAT',
  MIL: 'BUCKS', MIN: 'TIMBERWOLVES', NOP: 'PELICANS', NYK: 'KNICKS',
  OKC: 'THUNDER', ORL: 'MAGIC', PHI: '76ERS', PHX: 'SUNS',
  POR: 'TRAIL BLAZERS', SAC: 'KINGS', SAS: 'SPURS', TOR: 'RAPTORS',
  UTA: 'JAZZ', WAS: 'WIZARDS',
};

/** Returns true if a Polymarket trade outcome string matches an NBA tricode.
 *  Handles nickname ↔ tricode mapping (e.g. "Pacers" ↔ "IND"). */
function outcomeMatchesTeam(outcome, tricode) {
  if (!outcome || !tricode) return false;
  const out = outcome.toUpperCase();
  const tri = tricode.toUpperCase();
  if (out.includes(tri) || tri.includes(out)) return true;
  const nick = TRICODE_TO_NICKNAME[tri];
  if (nick && (out.includes(nick) || nick.includes(out))) return true;
  return false;
}

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
const closedOrderbooks = new Set(); // token IDs with no CLOB orderbook — skip these in arb display
const autoArbPlaced = new Set(); // gameKey+strategy keys already auto-placed this session
let autoArbEnabled = false;
let arbPollTimerId = null;
let arbFetchInFlight = false;
let arbPendingManualCheck = false;
let arbShowCheckingIndicator = false;
let arbUserHasClickedCheck = false; // only show indicator after user has clicked "Check arb" at least once

// ── Live Arb Engine ───────────────────────────────────────────────────────────
let engineRunning = false;
let engineSSE = null;
let engineStats = { betsPlaced: 0, betsAttempted: 0, totalStakedUsd: 0, expectedProfitUsd: 0 };
let engineFeed = [];

function renderEngineStats() {
  const el = document.getElementById('engineStats');
  if (!el) return;
  if (!engineStats || !Object.keys(engineStats).length) { el.innerHTML = ''; return; }
  el.innerHTML = `<span>Bets placed: <strong>${engineStats.betsPlaced||0}</strong></span> · <span>Edge captured: <strong>$${(engineStats.totalEdgeCapture||0).toFixed(2)}</strong></span> · <span>Total staked: <strong>$${(engineStats.totalStakedUsd||0).toFixed(2)}</strong></span> · <span>Attempted: <strong>${engineStats.betsAttempted||0}</strong></span>`;
}

function renderEngineFeed() {
  const el = document.getElementById('engineFeed');
  const wrap = document.getElementById('engineFeedWrap');
  if (!el || !wrap) return;
  wrap.style.display = engineFeed.length ? 'block' : 'none';
  el.innerHTML = engineFeed.slice(0, 50).map((ev) => {
    const time = new Date(ev.ts).toLocaleTimeString();
    if (ev.type === 'bet_placed') {
      return `<div class="engine-feed-item success">[${time}] ✓ VALUE ${escapeHtml(ev.label||'')} — $${(ev.stakeUsd||0).toFixed(2)} @ edge +${(ev.edge||0).toFixed(1)}% | pos $${(ev.positionTotal||0).toFixed(2)}</div>`;
    } else if (ev.type === 'bet_failed') {
      return `<div class="engine-feed-item error">[${time}] ✗ ${ev.gameKey} — poly: ${ev.polyErr||'ok'} kal: ${ev.kalErr||'ok'}</div>`;
    } else if (ev.type === 'tick') {
      return `<div class="engine-feed-item">[${time}] tick — ${ev.opportunityCount} value opps | Poly $${(ev.polyBal||0).toFixed(2)}</div>`;
    } else if (ev.type === 'stopped') {
      return `<div class="engine-feed-item error">[${time}] STOPPED — ${ev.reason}</div>`;
    } else if (ev.type === 'error') {
      return `<div class="engine-feed-item error">[${time}] ERROR — ${ev.message}</div>`;
    }
    if (ev.type === 'state' || ev.type === 'started' || ev.type === 'config_updated') return '';
    return `<div class="engine-feed-item">[${time}] ${ev.type}</div>`;
  }).filter(Boolean).join('');
}

function updateEngineUI() {
  const startBtn = document.getElementById('engineStartBtn');
  const stopBtn = document.getElementById('engineStopBtn');
  const badge = document.getElementById('engineStatusBadge');
  if (!startBtn) return;
  startBtn.disabled = engineRunning;
  stopBtn.disabled = !engineRunning;
  if (badge) {
    badge.textContent = engineRunning ? '🟢 Running' : '⚫ Stopped';
    badge.style.color = engineRunning ? 'var(--green)' : 'var(--muted)';
  }
  renderEngineStats();
  renderEngineFeed();
}

function openEngineSSE() {
  if (engineSSE) { engineSSE.close(); engineSSE = null; }
  engineSSE = new EventSource('/api/arb/engine/stream');
  engineSSE.onmessage = (e) => {
    try {
      const ev = JSON.parse(e.data);
      engineFeed.unshift(ev);
      if (engineFeed.length > 100) engineFeed.pop();
      if (ev.stats) engineStats = ev.stats;
      if (ev.type === 'stopped' || ev.type === 'circuit_breaker') {
        engineRunning = false;
        if (engineSSE) { engineSSE.close(); engineSSE = null; }
      }
      updateEngineUI();
    } catch (_) {}
  };
  engineSSE.onerror = () => {
    // SSE will auto-reconnect; just update UI if engine stopped
    if (!engineRunning) { if (engineSSE) { engineSSE.close(); engineSSE = null; } }
  };
}

async function startEngine() {
  if (!authState.polymarket) { alert('Sign in to Polymarket first to use the Value Engine.'); return; }
  const config = {
    orderSizeUsd: parseFloat(document.getElementById('engineBetSize')?.value) || 2,
    maxPositionUsd: parseFloat(document.getElementById('engineMaxPosition')?.value) || 20,
    minEdge: (parseFloat(document.getElementById('engineMinEdge')?.value) || 3) / 100,
    intervalMs: parseInt(document.getElementById('engineInterval')?.value) || 5000,
    cooldownMs: parseInt(document.getElementById('engineCooldown')?.value) || 60000,
    circuitBreakerPolyUsd: parseFloat(document.getElementById('engineCircuitPoly')?.value) || 5,
  };
  try {
    const res = await fetch(`${API_BASE}/api/arb/engine/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ config }),
    });
    const data = await res.json();
    if (!res.ok) { alert(data.error || 'Failed to start engine'); return; }
    engineRunning = true;
    engineFeed = [];
    engineStats = { betsPlaced: 0, betsAttempted: 0, totalStakedUsd: 0, totalEdgeCapture: 0 };
    openEngineSSE();
    updateEngineUI();
  } catch (err) {
    alert('Engine start failed: ' + err.message);
  }
}

async function stopEngine() {
  try {
    await fetch(`${API_BASE}/api/arb/engine/stop`, { method: 'POST', credentials: 'include' });
  } catch (_) {}
  engineRunning = false;
  if (engineSSE) { engineSSE.close(); engineSSE = null; }
  updateEngineUI();
}
// ─────────────────────────────────────────────────────────────────────────────

// ── Auto-Arb Engine UI ────────────────────────────────────────────────────────
let autoArbRunning = false;
let autoArbSimulate = true; // default to simulation
let autoArbSSE = null;
let autoArbFeed = [];
let autoArbStats = { placed: 0, failed: 0, totalProfitUsd: 0 };
let autoArbSimBalancePoly = 1000;
let autoArbSimBalanceKal = 1000;
let autoArbPositions = []; // positions placed in current session
let autoArbRealizedPnl   = 0;
let autoArbUnrealizedPnl = 0;

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function renderArbPosCard(pos) {
  const isHomePoly = (pos.strategyLabel || '').includes('Home');
  const polyTeam  = isHomePoly ? pos.homeTeam : pos.awayTeam;
  const kalTeam   = isHomePoly ? pos.awayTeam : pos.homeTeam;
  const polyPrice = pos.polyPrice != null ? Math.round(pos.polyPrice * 100) + '¢' : '–';
  const kalPrice  = pos.kalshiYesPriceCents != null ? pos.kalshiYesPriceCents + '¢' : '–';
  const badge     = pos.simulate
    ? '<span class="arb-pos-badge sim">SIM</span>'
    : '<span class="arb-pos-badge live">LIVE</span>';

  let footer;
  if (pos.closed) {
    const expected = pos.netProfitUsd != null ? `+$${Number(pos.netProfitUsd).toFixed(2)}` : '–';
    const actual   = pos.actualProfitUsd != null ? `+$${Number(pos.actualProfitUsd).toFixed(2)}` : '–';
    const exitPoly = pos.exitPolyPrice != null ? Math.round(pos.exitPolyPrice * 100) + '¢' : '–';
    const exitKal  = pos.exitKalshiCents != null ? pos.exitKalshiCents + '¢' : '–';
    footer = `
      <div class="arb-pos-footer arb-pos-footer--closed">
        <div class="arb-pos-profit-block">
          <span class="arb-pos-profit-label">Expected</span>
          <span class="arb-pos-profit">${expected}</span>
        </div>
        <div class="arb-pos-profit-block">
          <span class="arb-pos-profit-label">Actual</span>
          <span class="arb-pos-profit arb-pos-profit--actual">${actual}</span>
        </div>
        <span class="arb-pos-status--closed">Closed early ✓ · ${exitPoly} / ${exitKal}</span>
      </div>`;
  } else {
    const profit = pos.netProfitUsd != null ? `+$${Number(pos.netProfitUsd).toFixed(2)}` : '';
    footer = `
      <div class="arb-pos-footer">
        <span class="arb-pos-profit">${profit} expected</span>
        <span class="arb-pos-status"><span class="arb-pos-pending-dot"></span>Pending payout</span>
      </div>`;
  }

  const polyHref  = escapeHtml(pos.polyUrl  || '#');
  const kalshiHref = escapeHtml(pos.kalshiUrl || '#');
  return `
    <div class="arb-pos-card${pos.closed ? ' arb-pos-card--closed' : ''}">
      <div class="arb-pos-header">
        <span class="arb-pos-matchup">${escapeHtml(pos.awayTeam)} @ ${escapeHtml(pos.homeTeam)}</span>
        <div class="arb-pos-meta">${badge}<span class="arb-pos-time">${fmtTime(pos.placedAt || pos.ts)}</span></div>
      </div>
      <div class="arb-pos-legs">
        <div class="arb-pos-leg">
          <a class="arb-pos-leg-platform poly" href="${polyHref}" target="_blank" rel="noopener">Polymarket ↗</a>
          <div class="arb-pos-leg-team">${escapeHtml(polyTeam)} YES</div>
          <div class="arb-pos-leg-price">${polyPrice} · $${Number(pos.stakePolyUsd).toFixed(2)}</div>
          <div class="arb-pos-leg-id">${escapeHtml(pos.polyOrderId || '')}</div>
        </div>
        <div class="arb-pos-leg">
          <a class="arb-pos-leg-platform kalshi" href="${kalshiHref}" target="_blank" rel="noopener">Kalshi ↗</a>
          <div class="arb-pos-leg-team">${escapeHtml(kalTeam)} YES</div>
          <div class="arb-pos-leg-price">${kalPrice} · $${Number(pos.stakeKalshiUsd).toFixed(2)}</div>
          <div class="arb-pos-leg-id">${escapeHtml(pos.kalshiOrderId || '')}</div>
        </div>
      </div>
      ${footer}
    </div>`;
}

function updateAutoArbUI() {
  const startBtn = document.getElementById('autoArbStartBtn');
  const stopBtn  = document.getElementById('autoArbStopBtn');
  const badge    = document.getElementById('autoArbStatusBadge');
  if (!startBtn) return;
  startBtn.disabled = autoArbRunning;
  stopBtn.disabled  = !autoArbRunning;

  // Status badge
  if (badge) {
    const simTag = autoArbSimulate ? ' <span style="color:#f5a623;font-size:11px;font-weight:700">[SIM]</span>' : '';
    badge.innerHTML    = autoArbRunning ? `🟢 Running${simTag}` : '⚫ Stopped';
    badge.style.color  = autoArbRunning ? '#22c55e' : 'var(--text-muted)';
  }

  // Sim balance bar
  const simBar = document.getElementById('autoArbSimBalanceBar');
  if (simBar) {
    simBar.hidden = !(autoArbSimulate && autoArbRunning);
    if (!simBar.hidden) {
      document.getElementById('autoArbSimPolyBal').textContent = '$' + autoArbSimBalancePoly.toFixed(2);
      document.getElementById('autoArbSimKalBal').textContent  = '$' + autoArbSimBalanceKal.toFixed(2);
    }
  }

  // Portfolio bar
  const portBar = document.getElementById('autoArbPortfolioBar');
  if (portBar) {
    portBar.hidden = autoArbPositions.length === 0 && autoArbStats.placed === 0;
    if (!portBar.hidden) {
      const openPositions = autoArbPositions.filter(p => !p.closed);
      const totalDeployed = openPositions.reduce((s, p) => s + (p.stakePolyUsd || 0) + (p.stakeKalshiUsd || 0), 0);
      document.getElementById('arbPortCnt').textContent         = autoArbPositions.length;
      document.getElementById('arbPortDeployed').textContent    = '$' + totalDeployed.toFixed(2);
      document.getElementById('arbPortUnrealized').textContent  = '+$' + autoArbUnrealizedPnl.toFixed(2);
      document.getElementById('arbPortRealized').textContent    = '+$' + autoArbRealizedPnl.toFixed(2);
      document.getElementById('arbPortFailed').textContent      = autoArbStats.failed;
    }
  }

  // Open positions grid
  const openWrap = document.getElementById('autoArbOpenPositionsWrap');
  const openGrid = document.getElementById('autoArbOpenPositionsGrid');
  const openPositions = autoArbPositions.filter(p => !p.closed);
  if (openWrap && openGrid) {
    openWrap.hidden = openPositions.length === 0;
    if (!openWrap.hidden) openGrid.innerHTML = openPositions.map(renderArbPosCard).join('');
  }

  // Closed positions grid
  const closedWrap = document.getElementById('autoArbClosedPositionsWrap');
  const closedGrid = document.getElementById('autoArbClosedPositionsGrid');
  const closedPositions = autoArbPositions.filter(p => p.closed);
  if (closedWrap && closedGrid) {
    closedWrap.hidden = closedPositions.length === 0;
    if (!closedWrap.hidden) closedGrid.innerHTML = closedPositions.map(renderArbPosCard).join('');
  }

  // Activity log
  const feedEl = document.getElementById('autoArbFeed');
  if (feedEl) {
    feedEl.innerHTML = autoArbFeed.slice(0, 60).map(ev => {
      const t = fmtTime(ev.ts);
      const s = ev.simulate ? '[SIM] ' : '';
      if (ev.type === 'placed')      return `<div class="engine-feed-item success">[${t}] ${s}✓ ${ev.strategyLabel} — +$${ev.netProfitUsd} expected</div>`;
      if (ev.type === 'attempting')  return `<div class="engine-feed-item">[${t}] ${s}→ ${ev.strategyLabel} (+$${ev.netProfitUsd} expected)</div>`;
      if (ev.type === 'failed')      return `<div class="engine-feed-item error">[${t}] ${s}✗ ${ev.gameKey || ''} — ${ev.error}${ev.leg1Done ? ' (⚠ Poly filled, Kalshi failed)' : ''}</div>`;
      if (ev.type === 'exited')      return `<div class="engine-feed-item success">[${t}] ${s}✓ EXIT ${ev.strategyLabel} — actual +$${ev.actualProfitUsd}</div>`;
      if (ev.type === 'exit_failed') return `<div class="engine-feed-item error">[${t}] ${s}✗ Exit failed ${ev.gameKey || ''} — ${ev.error}</div>`;
      if (ev.type === 'order_stale') return `<div class="engine-feed-item error">[${t}] ⚠ Stale order cancelled — ${ev.gameKey} (poly filled: ${ev.polyFilled}, kalshi filled: ${ev.kalshiFilled})</div>`;
      if (ev.type === 'started')     return `<div class="engine-feed-item">[${t}] Engine started (${ev.simulate ? 'SIMULATION' : 'REAL MONEY'})</div>`;
      if (ev.type === 'stopped')     return `<div class="engine-feed-item">[${t}] Engine stopped</div>`;
      return '';
    }).filter(Boolean).join('');
  }
}

function updateAutoArbWSBadge(wsPolyConnected, wsKalshiConnected) {
  const el = document.getElementById('autoArbWsBadge');
  if (!el) return;
  const polyDot = wsPolyConnected ? '🟢' : '🔴';
  const kalDot = wsKalshiConnected ? '🟢' : '🔴';
  el.textContent = `WS: Poly ${polyDot}  Kalshi ${kalDot}`;
}

function openAutoArbSSE() {
  if (autoArbSSE) { autoArbSSE.close(); autoArbSSE = null; }
  autoArbSSE = new EventSource('/api/arb/auto/stream');
  autoArbSSE.onmessage = (e) => {
    try {
      const ev = JSON.parse(e.data);
      if (ev.stats) autoArbStats = ev.stats;
      if (ev.simulate !== undefined) autoArbSimulate = ev.simulate;
      if (ev.simBalancePoly !== undefined) autoArbSimBalancePoly = ev.simBalancePoly;
      if (ev.simBalanceKal  !== undefined) autoArbSimBalanceKal  = ev.simBalanceKal;
      if (ev.wsPolyConnected !== undefined) updateAutoArbWSBadge(ev.wsPolyConnected, ev.wsKalshiConnected);

      // Hydrate open positions from server on initial state event
      if (ev.type === 'state' && Array.isArray(ev.openPositions) && ev.openPositions.length > 0 && autoArbPositions.length === 0) {
        autoArbPositions = ev.openPositions.map(p => ({ ...p, placedAt: p.ts || Date.now(), closed: false }));
        autoArbUnrealizedPnl = Math.round(autoArbPositions.reduce((s, p) => s + (p.netProfitUsd || 0), 0) * 100) / 100;
      }

      if (ev.type === 'placed') {
        autoArbPositions.unshift({ ...ev, placedAt: ev.ts || Date.now(), closed: false });
        autoArbUnrealizedPnl = Math.round((autoArbUnrealizedPnl + (ev.netProfitUsd || 0)) * 100) / 100;
      }

      if (ev.type === 'exited') {
        const idx = autoArbPositions.findIndex(p => p.positionId === ev.positionId);
        if (idx !== -1) {
          const pos = autoArbPositions[idx];
          autoArbUnrealizedPnl = Math.round((autoArbUnrealizedPnl - (pos.netProfitUsd || 0)) * 100) / 100;
          autoArbPositions[idx] = {
            ...pos, closed: true, closedAt: ev.ts || Date.now(),
            exitPolyPrice: ev.exitPolyPrice,
            exitKalshiCents: ev.exitKalshiCents,
            actualProfitUsd: ev.actualProfitUsd,
          };
        }
        autoArbRealizedPnl = Math.round((autoArbRealizedPnl + (ev.actualProfitUsd || 0)) * 100) / 100;
      }

      if (ev.type === 'live_pnl' && Array.isArray(ev.positions)) {
        for (const update of ev.positions) {
          const pos = autoArbPositions.find(p => p.positionId === update.positionId);
          if (pos) {
            pos.livePnl = update.livePnl;
            pos.currentPolyPrice = update.currentPolyPrice;
            pos.currentKalshiCents = update.currentKalshiCents;
            pos.sumPrices = update.sumPrices;
          }
        }
        // Keep unrealized as the expected guaranteed profit (not live P&L)
        autoArbUnrealizedPnl = Math.round(
          autoArbPositions.filter(p => !p.closed).reduce((s, p) => s + (p.netProfitUsd || 0), 0) * 100
        ) / 100;
        updateAutoArbUI();
        return; // don't add to feed
      }

      if (ev.type === 'order_stale') {
        const idx = autoArbPositions.findIndex(p => p.positionId === ev.positionId);
        if (idx !== -1) {
          autoArbUnrealizedPnl = Math.round((autoArbUnrealizedPnl - (autoArbPositions[idx].netProfitUsd || 0)) * 100) / 100;
          autoArbPositions.splice(idx, 1);
        }
      }

      if (ev.type === 'stopped') {
        autoArbRunning = false;
        autoArbRealizedPnl   = 0;
        autoArbUnrealizedPnl = 0;
        // Don't close SSE — keep it open so positions hydrate on page reload
      }

      if (ev.type !== 'state') autoArbFeed.unshift(ev);
      if (autoArbFeed.length > 100) autoArbFeed.pop();
      updateAutoArbUI();
    } catch (_) {}
  };
  autoArbSSE.onerror = () => {
    // Never close — let EventSource auto-reconnect to keep positions hydrated
  };
}

async function startAutoArb() {
  const isSim = document.getElementById('autoArbModeSim')?.checked ?? true;
  if (!isSim) {
    if (!authState.polymarket) { alert('Sign in to Polymarket first for real money mode.'); return; }
    if (!authState.kalshi) { alert('Sign in to Kalshi first for real money mode.'); return; }
  }
  const simBalancePoly = parseFloat(document.getElementById('autoArbSimPoly')?.value) || 1000;
  const simBalanceKal  = parseFloat(document.getElementById('autoArbSimKal')?.value)  || 1000;
  const maxStakeUsd    = parseFloat(document.getElementById('autoArbMaxStake')?.value) || 50;
  const exitThreshold  = parseFloat(document.getElementById('autoArbExitThreshold')?.value) || 1.00;
  const sportRadio = document.querySelector('input[name="autoArbSport"]:checked');
  const sport = sportRadio?.value || 'nba';
  try {
    const res = await fetch(`${API_BASE}/api/arb/auto/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ simulate: isSim, simBalancePoly, simBalanceKal, maxStakeUsd, exitThreshold, sport }),
    });
    const data = await res.json();
    if (!res.ok) { alert(data.error || 'Failed to start auto-arb'); return; }
    autoArbRunning = true;
    autoArbSimulate = isSim;
    autoArbSimBalancePoly = simBalancePoly;
    autoArbSimBalanceKal  = simBalanceKal;
    autoArbFeed = [];
    autoArbStats = { placed: 0, failed: 0, totalProfitUsd: 0 };
    autoArbPositions = [];
    autoArbRealizedPnl   = 0;
    autoArbUnrealizedPnl = 0;
    openAutoArbSSE();
    updateAutoArbUI();
    setTimeout(refreshAutoArbWSStatus, 2000);
  } catch (err) {
    alert('Auto-arb start failed: ' + err.message);
  }
}

async function stopAutoArb() {
  try {
    await fetch(`${API_BASE}/api/arb/auto/stop`, { method: 'POST', credentials: 'include' });
  } catch (_) {}
  autoArbRunning = false;
  if (autoArbSSE) { autoArbSSE.close(); autoArbSSE = null; }
  updateAutoArbUI();
}

async function refreshAutoArbWSStatus() {
  try {
    const res = await fetch(`${API_BASE}/api/arb/auto/status`, { credentials: 'include' });
    if (res.ok) {
      const data = await res.json();
      updateAutoArbWSBadge(data.wsPolyConnected, data.wsKalshiConnected);
    }
  } catch (_) {}
  if (autoArbRunning) setTimeout(refreshAutoArbWSStatus, 5000);
}
// ─────────────────────────────────────────────────────────────────────────────

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
    const newList = (data.opportunities || []).filter((o) =>
      !closedOrderbooks.has(o.polyTokenId) &&
      !closedOrderbooks.has(o.polyTokenIdAway) &&
      !closedOrderbooks.has(o.polyTokenIdHome)
    );
    const newKeys = new Set(newList.map((o) => `${o.gameKey}-${o.strategy}`));
    const prev = arbOpportunities;
    arbOpportunities = newList;
    for (const o of prev) {
      const key = `${o.gameKey}-${o.strategy}`;
      if (!newKeys.has(key)) arbStaleMap.set(key, { ...o, staleUntil: Date.now() + ARB_STALE_KEEP_MS });
    }

    // Auto-arb: place new opportunities automatically if enabled
    if (autoArbEnabled && authState.polymarket && authState.kalshi) {
      for (const opp of newList) {
        const key = `${opp.gameKey}-${opp.strategy}`;
        if (!autoArbPlaced.has(key)) {
          autoArbPlaced.add(key);
          placeArb(opp, null, true); // silent auto-place
        }
      }
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

async function placeArb(opp, btnEl, silent = false) {
  if (!authState.polymarket || !authState.kalshi) {
    if (!silent) alert('Sign in to both Polymarket and Kalshi to place an arb.');
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
      if (/orderbook.*no longer exists|does not exist/i.test(msg)) {
        if (opp.polyTokenId) closedOrderbooks.add(opp.polyTokenId);
        if (opp.polyTokenIdAway) closedOrderbooks.add(opp.polyTokenIdAway);
        if (opp.polyTokenIdHome) closedOrderbooks.add(opp.polyTokenIdHome);
        fetchArbOpportunities();
        return;
      }
      if (data.leg1Done) {
        showToast(`⚠️ Poly leg filled but Kalshi failed. ${msg}`, 'error');
      } else if (!silent) {
        alert(msg);
      } else {
        showToast(`Auto-arb failed: ${msg}`, 'error');
      }
      return;
    }
    showToast(`✅ Arb placed — ${opp.awayTeam} @ ${opp.homeTeam} · +$${opp.netProfitUsd} expected`);
    await fetchAuthStatus();
    fetchMyOrders();
    fetchArbOpportunities();
    fetchArbHistory();
  } catch (err) {
    if (!silent) alert(err?.message || 'Arb execute failed');
    else showToast(`Auto-arb error: ${err?.message || 'failed'}`, 'error');
  } finally {
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.textContent = 'Place arb';
    }
  }
}

// ── Toast notifications ───────────────────────────────────────────────────
function showToast(msg, type = 'success') {
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:9999;display:flex;flex-direction:column;gap:8px;';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.style.cssText = `background:${type === 'error' ? '#ff4444' : '#00c853'};color:#fff;padding:12px 18px;border-radius:8px;font-size:14px;max-width:340px;box-shadow:0 4px 16px rgba(0,0,0,0.4);opacity:1;transition:opacity 0.4s;`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 400); }, 4000);
}

// ── Real-time P&L tracker ─────────────────────────────────────────────────
let pnlData = []; // latest /api/pnl response
let pnlRefreshTimerId = null;

async function fetchPnl(silent = false) {
  if (!authState.polymarket && !authState.kalshi) return;
  try {
    const res = await fetchWithTimeout(`${API_BASE}/api/pnl`);
    if (!res.ok) return;
    const data = await res.json();
    pnlData = data.positions || [];
    renderPnlRows();
  } catch (_) {}
}

function startPnlAutoRefresh() {
  if (pnlRefreshTimerId != null) return;
  fetchPnl(true);
  pnlRefreshTimerId = setInterval(() => fetchPnl(true), 10000);
}

function stopPnlAutoRefresh() {
  if (pnlRefreshTimerId != null) {
    clearInterval(pnlRefreshTimerId);
    pnlRefreshTimerId = null;
  }
}

function renderPositionsPanel() {
  const panel = document.getElementById('positionsPanel');
  const portfolioBar = document.getElementById('posPortfolioBar');
  const list = document.getElementById('posList');
  if (!panel || !list) return;

  if (!pnlData.length) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;

  // Portfolio summary
  let totalInvested = 0, totalCurrent = 0;
  for (const pos of pnlData) {
    totalInvested += (pos.polyOriginalStake || 0) + (pos.kalOriginalStake || 0);
    // Only count current values we actually have — don't fall back to stake for missing prices
    totalCurrent += (pos.polyCurrentValue ?? 0) + (pos.kalCurrentValue ?? 0);
  }
  const netPnl = totalCurrent - totalInvested;
  const pctReturn = totalInvested > 0 ? (netPnl / totalInvested * 100) : 0;
  const portfolioClass = netPnl >= 0 ? 'pos-pnl-positive' : 'pos-pnl-negative';
  if (portfolioBar) {
    portfolioBar.hidden = false;
    portfolioBar.innerHTML = `
      <div class="pos-portfolio-stat"><span class="pos-portfolio-label">Invested</span><span class="pos-portfolio-val">$${totalInvested.toFixed(2)}</span></div>
      <div class="pos-portfolio-stat"><span class="pos-portfolio-label">Current Value</span><span class="pos-portfolio-val">$${totalCurrent.toFixed(2)}</span></div>
      <div class="pos-portfolio-stat"><span class="pos-portfolio-label">Net P&amp;L</span><span class="pos-portfolio-val ${portfolioClass}">${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(2)}</span></div>
      <div class="pos-portfolio-stat"><span class="pos-portfolio-label">Return</span><span class="pos-portfolio-val ${portfolioClass}">${pctReturn >= 0 ? '+' : ''}${pctReturn.toFixed(1)}%</span></div>
    `;
  }

  // Per-position cards
  list.innerHTML = pnlData.map(pos => {
    const date = pos.placedAt ? new Date(pos.placedAt).toLocaleDateString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }) : '';

    // POLY leg
    const polyEntry = pos.polyEntryPrice != null ? (pos.polyEntryPrice * 100).toFixed(0) : null;
    const polyCurrent = pos.polyCurrentPrice != null ? (pos.polyCurrentPrice * 100).toFixed(0) : null;
    const polyPnlSign = pos.polyPnl >= 0 ? '+' : '';
    const polyPnlClass = pos.polyPnl >= 0 ? 'pos-pnl-positive' : 'pos-pnl-negative';
    const polyBarWidth = pos.polyEntryPrice > 0 && pos.polyCurrentPrice != null
      ? Math.min(100, Math.round(pos.polyCurrentPrice * 100)) : 0;
    const polyEntryBarWidth = pos.polyEntryPrice > 0 ? Math.min(100, Math.round(pos.polyEntryPrice * 100)) : 0;
    const polyAction = pos.polyAssetId && pos.polySize
      ? `<button class="pos-action-btn sell" onclick="sellPolyPosition('${pos.polyAssetId}', ${pos.polySize}, this)">Sell</button>`
      : '';

    // KAL leg
    const kalEntry = pos.kalEntryPrice != null ? pos.kalEntryPrice : null;
    const kalCurrent = pos.kalCurrentPrice != null ? pos.kalCurrentPrice : null;
    const kalPnlSign = pos.kalPnl >= 0 ? '+' : '';
    const kalPnlClass = pos.kalPnl >= 0 ? 'pos-pnl-positive' : 'pos-pnl-negative';
    const kalBarWidth = kalCurrent != null ? Math.min(100, Math.round(kalCurrent)) : 0;
    const kalEntryBarWidth = kalEntry != null ? Math.min(100, Math.round(kalEntry)) : 0;
    const kalAction = pos.kalOrderId
      ? `<button class="pos-action-btn cancel" onclick="cancelKalshiOrderFromDashboard('${pos.kalOrderId}', this)">Cancel</button>`
      : '';

    // Recommendation badge
    const recMap = {
      'close-both': { cls: 'rec-close', icon: '🎯' },
      'sell-poly': { cls: 'rec-sell', icon: '💰' },
      'sell-kalshi': { cls: 'rec-sell', icon: '💰' },
      'cut-loss': { cls: 'rec-danger', icon: '⚠️' },
      'hold': { cls: 'rec-hold', icon: '✋' },
    };
    const rec = recMap[pos.recommendation] || recMap['hold'];
    const recBadge = pos.recommendationText
      ? `<div class="pos-rec-badge ${rec.cls}">${rec.icon} ${escapeHtml(pos.recommendationText)}</div>`
      : '';

    // Combined P&L
    const posPnlClass = pos.unrealizedPnl >= 0 ? 'pos-pnl-positive' : 'pos-pnl-negative';
    const expectedLine = pos.expectedProfit
      ? `<span class="pos-expected">Target: +$${Number(pos.expectedProfit).toFixed(2)}</span>`
      : '';

    return `<div class="pos-card" data-game-key="${escapeHtml(pos.gameKey || '')}">
      <div class="pos-card-header">
        <span class="pos-game">🏀 ${escapeHtml(pos.awayTeam || '')} @ ${escapeHtml(pos.homeTeam || '')}</span>
        <div style="display:flex;gap:6px;align-items:center">
          <span class="trade-badge arb">ARB</span>
          <span class="pos-date">${escapeHtml(date)}</span>
        </div>
      </div>

      <div class="pos-legs">
        <!-- POLY leg -->
        <div class="pos-leg pos-leg-poly">
          <div class="pos-leg-header">
            <span class="leg-label" style="background:var(--accent-poly);color:#fff">POLY</span>
            <span class="pos-leg-team">${escapeHtml(pos.strategyLabel ? pos.strategyLabel.split(' ').slice(0,2).join(' ') : pos.awayTeam || '')}</span>
            ${polyAction}
          </div>
          <div class="pos-price-row">
            <span class="pos-price-entry">Entry: ${polyEntry != null ? polyEntry + '¢' : 'n/a'}</span>
            <span class="pos-arrow">→</span>
            <span class="pos-price-current ${pos.polyCurrentPrice > pos.polyEntryPrice ? 'pos-pnl-positive' : pos.polyCurrentPrice < pos.polyEntryPrice ? 'pos-pnl-negative' : ''}">${
              polyCurrent != null ? polyCurrent + '¢'
              : pos.gameOver ? '<span style="color:#22c55e;font-size:0.7rem">settled</span>'
              : pos.polySettled ? '<span style="color:#f59e0b;font-size:0.7rem">illiquid</span>'
              : '—'
            }</span>
          </div>
          <div class="pos-bar-wrap">
            <div class="pos-bar-track">
              <div class="pos-bar-entry" style="width:${polyEntryBarWidth}%"></div>
              <div class="pos-bar-current" style="width:${polyBarWidth}%;background:${pos.polyCurrentPrice > pos.polyEntryPrice ? '#22c55e' : '#ef4444'}"></div>
            </div>
          </div>
          <div class="pos-value-row">
            <span>$${(pos.polyOriginalStake || 0).toFixed(2)} → ${
              pos.polyCurrentValue != null
                ? '$' + pos.polyCurrentValue.toFixed(2)
                : pos.gameOver
                  ? '<span style="color:#22c55e;font-size:0.72rem">🏆 Game over — redeem on Polymarket</span>'
                  : pos.polySettled
                    ? '<span style="color:#f59e0b;font-size:0.72rem">⏳ Book illiquid — check Polymarket</span>'
                    : pos.polyAssetId
                      ? '<span style="color:var(--text-muted);font-size:0.7rem">⏳ price loading…</span>'
                      : '<span style="color:var(--text-muted)">n/a</span>'
            }</span>
            ${pos.polyPnl != null ? `<span class="${polyPnlClass}">${polyPnlSign}$${Math.abs(pos.polyPnl).toFixed(2)}</span>` : ''}
          </div>
        </div>

        <!-- KAL leg -->
        <div class="pos-leg pos-leg-kal">
          <div class="pos-leg-header">
            <span class="leg-label" style="background:var(--accent-kalshi);color:#000">KAL</span>
            <span class="pos-leg-team">${escapeHtml(pos.strategyLabel ? pos.strategyLabel.split(' ').slice(-2).join(' ') : pos.homeTeam || '')}</span>
            ${kalAction}
          </div>
          <div class="pos-price-row">
            <span class="pos-price-entry">Entry: ${kalEntry != null ? kalEntry + '¢' : 'n/a'}</span>
            <span class="pos-arrow">→</span>
            <span class="pos-price-current ${kalCurrent > kalEntry ? 'pos-pnl-positive' : kalCurrent < kalEntry ? 'pos-pnl-negative' : ''}">${kalCurrent != null ? kalCurrent + '¢' : '—'}</span>
          </div>
          <div class="pos-bar-wrap">
            <div class="pos-bar-track">
              <div class="pos-bar-entry" style="width:${kalEntryBarWidth}%"></div>
              <div class="pos-bar-current" style="width:${kalBarWidth}%;background:${kalCurrent > kalEntry ? '#22c55e' : '#ef4444'}"></div>
            </div>
          </div>
          <div class="pos-value-row">
            <span>$${(pos.kalOriginalStake || 0).toFixed(2)} → ${
              pos.kalCurrentPrice === 0
                ? '<span style="color:#ef4444;font-size:0.7rem">settled ✗ lost</span>'
                : pos.kalCurrentPrice === 100
                ? '<span class="pos-pnl-positive" style="font-size:0.7rem">settled ✓ won</span>'
                : pos.kalCurrentValue != null
                ? (pos.kalCurrentValue >= pos.kalOriginalStake * 1.5
                    ? `<span class="pos-pnl-positive">$${pos.kalCurrentValue.toFixed(2)} ✓</span>`
                    : '$' + pos.kalCurrentValue.toFixed(2))
                : '<span style="color:var(--text-muted)">n/a</span>'
            }</span>
            ${pos.kalPnl != null && pos.kalCurrentPrice !== 0 ? `<span class="${kalPnlClass}">${kalPnlSign}$${Math.abs(pos.kalPnl).toFixed(2)}</span>` : ''}
          </div>
        </div>
      </div>

      <div class="pos-footer">
        <div class="pos-combined-pnl">
          ${pos.gameOver
            ? `<span style="color:#22c55e;font-weight:600">🏁 Game settled — redeem winning position</span>`
            : pos.polySettled && !pos.gameOver
              ? `<span style="color:var(--text-muted)">Combined P&amp;L:</span>
                 <span class="${posPnlClass}" style="font-weight:700">${pos.unrealizedPnl >= 0 ? '+' : ''}$${Number(pos.unrealizedPnl).toFixed(2)}</span>
                 <span style="color:#f59e0b;font-size:0.7rem">(Poly unavailable)</span>
                 ${expectedLine}`
              : `<span>Combined P&amp;L:</span>
                 <span class="${posPnlClass}" style="font-weight:700">${pos.unrealizedPnl >= 0 ? '+' : ''}$${Number(pos.unrealizedPnl).toFixed(2)}</span>
                 ${expectedLine}`
          }
        </div>
        ${recBadge}
      </div>
    </div>`;
  }).join('');
}

// Keep old renderPnlRows as a wrapper that calls renderPositionsPanel + injects into dashboard cards
function renderPnlRows() {
  renderPositionsPanel();
  // Also update dashboard arb-pair-cards if present
  const cards = document.querySelectorAll('.arb-pair-card[data-game-key]');
  for (const card of cards) {
    const gk = card.dataset.gameKey;
    const pos = pnlData.find((p) => p.gameKey === gk);
    let existing = card.querySelector('.pnl-row');
    if (existing) existing.remove();
    if (!pos) continue;
    const row = document.createElement('div');
    row.className = 'pnl-row';
    const pnlSign = pos.unrealizedPnl >= 0 ? '+' : '';
    const pnlClass = pos.unrealizedPnl >= 0 ? 'pnl-positive' : 'pnl-negative';
    row.innerHTML = `<div class="pnl-total ${pnlClass}">P&amp;L: ${pnlSign}$${Math.abs(pos.unrealizedPnl).toFixed(2)} unrealized${pos.recommendationText ? ' · ' + pos.recommendationText : ''}</div>`;
    card.appendChild(row);
  }
}
// ─────────────────────────────────────────────────────────────────────────────

// ── Arb History ───────────────────────────────────────────────────────────
let arbHistory = [];

async function fetchArbHistory() {
  try {
    const res = await fetch(`${API_BASE}/api/arb-history`, fetchOpts);
    if (res.ok) {
      arbHistory = await res.json();
      renderArbHistory();
    }
  } catch (_) {}
}

function renderArbHistory() {
  const el = document.getElementById('arbHistoryContent');
  if (!el) return;
  if (!arbHistory.length) {
    el.innerHTML = '<p style="color:var(--muted);font-size:13px">No arbs placed yet.</p>';
    return;
  }
  el.innerHTML = arbHistory.map((h) => {
    const date    = new Date(h.placedAt).toLocaleString();
    const profit  = h.netProfitUsd != null ? `+$${h.netProfitUsd}` : '';
    const isEarly = h.status === 'closed-early';
    const statusBadge = isEarly
      ? ' <span style="color:#22c55e;font-size:11px;font-weight:700">· Closed early ✓</span>' : '';
    const actualLine = isEarly && h.actualProfitUsd != null
      ? `<div class="order-detail" style="color:#22c55e">Actual profit: +$${h.actualProfitUsd}` +
        (h.exitPolyPrice != null
          ? ` <span style="color:var(--text-muted);font-size:11px">(exit ${Math.round(h.exitPolyPrice*100)}¢ / ${h.exitKalshiCents}¢)</span>` : '') +
        `</div>` : '';
    return `<div class="dashboard-order-card poly" style="margin-bottom:8px">
      <div class="order-game">${escapeHtml(h.awayTeam || '')} @ ${escapeHtml(h.homeTeam || '')}${statusBadge}</div>
      <div class="order-detail">${escapeHtml(h.strategyLabel || '')} · Poly $${h.stakePolyUsd} · Kalshi $${h.stakeKalshiUsd}</div>
      <div class="order-detail" style="color:var(--text-muted)">${profit} expected profit</div>
      ${actualLine}
      <div class="order-detail" style="color:var(--text-muted);font-size:11px">${date}</div>
    </div>`;
  }).join('');
}

// ── Auto-arb toggle ───────────────────────────────────────────────────────
function toggleAutoArb() {
  autoArbEnabled = !autoArbEnabled;
  const btn = document.getElementById('autoArbBtn');
  if (btn) {
    btn.textContent = autoArbEnabled ? '🤖 Auto Arb: ON' : '🤖 Auto Arb: OFF';
    btn.style.background = autoArbEnabled ? 'var(--green)' : '';
    btn.style.color = autoArbEnabled ? '#000' : '';
  }
  if (autoArbEnabled) {
    showToast('Auto Arb enabled — opportunities will be placed automatically');
  } else {
    autoArbPlaced.clear(); // reset so re-enabling can place again
    showToast('Auto Arb disabled', 'error');
  }
}
// ─────────────────────────────────────────────────────────────────────────

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

function renderTradeCard(t, accentClass) {
  const team = t.outcome ? escapeHtml(t.outcome) : (t.side || 'BUY').toUpperCase();
  const priceCents = t.price != null ? (t.price * 100).toFixed(0) + '¢' : '';
  const stake = t.stake != null ? '$' + t.stake.toFixed(2) : '';
  const date = t.created_at ? new Date(t.created_at * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
  const rs = t.result_status || 'pending';
  const isArb = arbHistory.some((h) =>
    (h.awayTeam && (outcomeMatchesTeam(team, h.awayTeam) || team.toLowerCase().includes(h.awayTeam.toLowerCase()))) ||
    (h.homeTeam && (outcomeMatchesTeam(team, h.homeTeam) || team.toLowerCase().includes(h.homeTeam.toLowerCase())))
  );
  const badge = rs === 'win'
    ? `<span class="trade-badge win">WIN ✓</span>`
    : rs === 'loss'
    ? `<span class="trade-badge loss">LOSS ✗</span>`
    : `<span class="trade-badge pending">LIVE</span>`;
  const arbTag = isArb ? `<span class="trade-badge arb">ARB</span>` : '';
  const profitLine = rs === 'win' && t.payout != null && t.stake != null
    ? `<div class="trade-profit win">Payout: $${t.payout.toFixed(2)} · Profit: +$${(t.payout - t.stake).toFixed(2)}</div>`
    : rs === 'loss' && stake
    ? `<div class="trade-profit loss">Lost: ${stake}</div>`
    : '';
  return `<div class="trade-card ${accentClass}">
    <div class="trade-card-top">
      <span class="trade-team">🏀 ${team}</span>
      <div style="display:flex;gap:4px">${arbTag}${badge}</div>
    </div>
    <div class="trade-card-mid">
      <span class="trade-pill ${accentClass}">${(t.side || 'BUY').toUpperCase()}</span>
      <span class="trade-meta">${t.size != null ? Number(t.size).toFixed(0) + ' shares' : ''} @ ${priceCents}</span>
      <span class="trade-meta">Stake: ${stake}</span>
    </div>
    ${profitLine}
    <div class="trade-card-bottom">
      <span class="trade-date">${date}</span>
      ${rs === 'pending' ? `<button class="sell-btn" onclick="sellPolyPosition('${t.asset_id}',${Number(t.size)},this)">Sell</button>` : ''}
    </div>
  </div>`;
}

function renderKalshiOrderCard(o) {
  const ticker = o.ticker || o.market_ticker || '';
  const matchup = kalshiTickerToMatchup(ticker);
  const team = kalshiTickerToTeam(ticker);
  const gameStr = matchup ? `${matchup.away} vs ${matchup.home}` : ticker.slice(0, 20) + '…';
  const betOn = o.side === 'yes' ? (team || 'Yes') : (team ? team + ' no' : 'No');
  const price = o.yes_price != null ? o.yes_price + '¢' : (o.order?.yes_price != null ? o.order.yes_price + '¢' : '');
  const count = o.remaining_count ?? o.count ?? o.order?.remaining_count ?? o.order?.count ?? '';
  const stake = count && price ? '$' + (Number(count) * parseInt(price) / 100).toFixed(2) : '';
  const isArb = arbHistory.some((h) =>
    (h.awayTeam && gameStr.toLowerCase().includes(h.awayTeam.toLowerCase())) ||
    (h.homeTeam && gameStr.toLowerCase().includes(h.homeTeam.toLowerCase()))
  );
  const arbTag = isArb ? `<span class="trade-badge arb">ARB</span>` : '';
  return `<div class="trade-card kalshi">
    <div class="trade-card-top">
      <span class="trade-team">🏀 ${escapeHtml(betOn)}</span>
      <div style="display:flex;gap:4px">${arbTag}<span class="trade-badge pending">RESTING</span></div>
    </div>
    <div class="trade-card-mid">
      <span class="trade-pill kalshi">${o.side === 'yes' ? 'YES' : 'NO'}</span>
      <span class="trade-meta">${count} contracts @ ${price}</span>
      ${stake ? `<span class="trade-meta">Stake: ${stake}</span>` : ''}
    </div>
    <div class="trade-date">${escapeHtml(gameStr)}</div>
  </div>`;
}

async function cancelKalshiOrderFromDashboard(orderId, btn) {
  if (!confirm('Cancel this Kalshi order?')) return;
  btn.disabled = true;
  btn.textContent = 'Cancelling…';
  try {
    const res = await fetch('/api/kalshi/cancel-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order_id: orderId }),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      btn.textContent = 'Failed';
      alert('Cancel failed: ' + (data.error || 'Unknown'));
    } else {
      btn.textContent = 'Cancelled';
      btn.style.background = '#555';
      setTimeout(fetchMyOrders, 1500);
    }
  } catch (e) { btn.textContent = 'Error'; alert(e.message); }
}

async function cancelPolyOrder(orderId, btn) {
  if (!confirm('Cancel this open order?')) return;
  btn.disabled = true;
  btn.textContent = 'Cancelling…';
  try {
    const res = await fetch('/api/polymarket/cancel-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order_id: orderId }),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      btn.textContent = 'Failed';
      btn.style.color = 'var(--red)';
      alert('Cancel failed: ' + (data.error || 'Unknown error'));
    } else {
      btn.textContent = 'Cancelled';
      btn.style.background = '#555';
      btn.style.color = '#fff';
      (btn.closest('.trade-card') || btn.closest('.arb-pair-card') || btn.closest('.arb-leg'))?.style && ((btn.closest('.trade-card') || btn.closest('.arb-pair-card')).style.opacity = '0.4');
      setTimeout(fetchMyOrders, 1500);
    }
  } catch (e) {
    btn.textContent = 'Error';
    alert('Cancel error: ' + e.message);
  }
}

async function sellPolyPosition(assetId, size, btn) {
  if (!confirm(`Sell ${size} shares at best bid price?`)) return;
  btn.disabled = true;
  btn.textContent = 'Selling…';
  try {
    const res = await fetch('/api/polymarket/sell-position', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ asset_id: assetId, size }),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      btn.textContent = 'Failed';
      btn.style.color = 'var(--red)';
      alert('Sell failed: ' + (data.error || 'Unknown error'));
    } else {
      btn.textContent = `Sold @ ${(data.sellPrice * 100).toFixed(0)}¢`;
      btn.style.background = 'var(--green)';
      btn.style.color = '#000';
      fetchMyOrders();
    }
  } catch (e) {
    btn.textContent = 'Error';
    alert('Sell error: ' + e.message);
  }
}

async function sellAllPolyPositions(btn) {
  const openCount = arbHistory.filter(h => h.status === 'placed').length;
  if (!openCount) return alert('No open positions to sell.');
  if (!confirm(`Sell ALL ${openCount} open Polymarket positions at best bid? This cannot be undone.`)) return;
  btn.disabled = true;
  btn.textContent = 'Selling…';
  try {
    const res = await fetch('/api/polymarket/sell-all-positions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      btn.textContent = 'Failed';
      alert('Sell-all failed: ' + (data.error || 'Unknown error'));
    } else {
      const sold = (data.results || []).filter(r => r.status === 'sold').length;
      const errors = (data.results || []).filter(r => r.status === 'error');
      btn.textContent = `Sold ${sold} groups`;
      btn.style.background = 'var(--green, #22c55e)';
      btn.style.color = '#000';
      if (errors.length) alert(`${errors.length} group(s) failed:\n` + errors.map(e => `${e.gameKey}: ${e.error}`).join('\n'));
      fetchArbHistory();
      fetchMyOrders();
    }
  } catch (e) {
    btn.textContent = 'Error';
    alert('Sell-all error: ' + e.message);
  }
  setTimeout(() => { btn.disabled = false; btn.textContent = 'Sell All Poly'; btn.style.background = ''; btn.style.color = ''; }, 5000);
}

function switchOrdersTab(tab) {
  document.querySelectorAll('.orders-tab').forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === tab));
  document.querySelectorAll('.orders-panel').forEach((panel) => panel.classList.toggle('hidden', !panel.id.endsWith(tab)));
}

function renderDashboard() {
  const hint = document.getElementById('dashboardHint');
  const content = document.getElementById('dashboardContent');
  if (!authState.polymarket && !authState.kalshi) {
    hint.hidden = false; content.hidden = true; return;
  }
  hint.hidden = true; content.hidden = false;

  const polyTrades = myOrders.polymarket?.trades || [];
  const polyOpenOrders = (myOrders.polymarket?.orders || []).filter(o => ['live','open','resting'].includes((o.status||'').toLowerCase()));
  const polyErr = myOrders.polymarket?.error;
  const kalshiOrders = (myOrders.kalshi?.orders || []).filter(o => {
    const ticker = o.ticker || o.market_ticker || '';
    return ticker.startsWith('KXNBAGAME-') && ['resting','pending','open'].includes((o.status||'').toLowerCase());
  });
  const kalshiErr = myOrders.kalshi?.error;

  // Build arb pair cards from arbHistory — match poly trades + kalshi orders to each arb
  const usedPolyIds = new Set();
  const usedKalshiIds = new Set();

  const arbCards = arbHistory.slice().reverse().map(h => {
    const away = (h.awayTeam || '').toUpperCase();
    const home = (h.homeTeam || '').toUpperCase();
    const date = h.placedAt ? new Date(h.placedAt).toLocaleDateString('en-US', { month:'short', day:'numeric' }) : '';

    // Match poly filled trade by team name (handles tricode ↔ nickname, e.g. IND ↔ Pacers)
    const polyTrade = polyTrades.find(t => !usedPolyIds.has(t.id) && t.outcome &&
      (outcomeMatchesTeam(t.outcome, away) || outcomeMatchesTeam(t.outcome, home)));
    if (polyTrade) usedPolyIds.add(polyTrade.id);

    // Also match poly open order (unmatched/live) if no filled trade found
    const polyOpenOrder = !polyTrade ? polyOpenOrders.find(o => !usedPolyIds.has(o.id)) : null;
    if (polyOpenOrder) usedPolyIds.add(polyOpenOrder.id);

    // Match kalshi order by ticker game
    const kalOrder = kalshiOrders.find(o => {
      if (usedKalshiIds.has(o.order_id || o.id)) return false;
      const m = kalshiTickerToMatchup(o.ticker || o.market_ticker || '');
      if (!m) return false;
      return (m.away.toUpperCase().includes(away) || m.home.toUpperCase().includes(home) ||
              away.includes(m.away.toUpperCase()) || home.includes(m.home.toUpperCase()));
    });
    if (kalOrder) usedKalshiIds.add(kalOrder.order_id || kalOrder.id);

    const rs = polyTrade?.result_status || 'pending';
    const statusBadge = rs === 'win' ? `<span class="trade-badge win">WIN ✓</span>`
      : rs === 'loss' ? `<span class="trade-badge loss">LOSS ✗</span>`
      : `<span class="trade-badge pending">PENDING</span>`;

    // Build poly leg — filled trade gets Sell, open order gets Cancel
    let polyLine = '';
    if (polyTrade) {
      const polyBtn = rs === 'pending' && polyTrade.asset_id
        ? `<button class="leg-sell-btn" onclick="sellPolyPosition('${polyTrade.asset_id}',${Number(polyTrade.size)},this)">Sell</button>` : '';
      polyLine = `<div class="arb-leg poly-leg"><span class="leg-label">POLY</span><span class="leg-team">${escapeHtml(polyTrade.outcome||'')}</span><span class="leg-detail">${(polyTrade.price*100).toFixed(0)}¢ · $${(polyTrade.stake||0).toFixed(2)}</span>${polyBtn}</div>`;
    } else if (polyOpenOrder) {
      const price = polyOpenOrder.price != null ? (Number(polyOpenOrder.price)*100).toFixed(0)+'¢' : '';
      const stake = polyOpenOrder.original_size && polyOpenOrder.price ? '$'+(Number(polyOpenOrder.original_size)*Number(polyOpenOrder.price)).toFixed(2) : `$${(h.stakePolyUsd||0).toFixed(2)}`;
      polyLine = `<div class="arb-leg poly-leg"><span class="leg-label">POLY</span><span class="leg-team">${polyOpenOrder.side||'BUY'} ${price}</span><span class="leg-detail">${stake} · unmatched</span><button class="leg-sell-btn" onclick="cancelPolyOrder('${polyOpenOrder.id}',this)">Cancel</button></div>`;
    } else if (h.stakePolyUsd) {
      polyLine = `<div class="arb-leg poly-leg"><span class="leg-label">POLY</span><span class="leg-team">${escapeHtml(h.awayTeam||h.homeTeam||'')}</span><span class="leg-detail">$${h.stakePolyUsd.toFixed(2)}</span></div>`;
    }

    const kalTeam = kalOrder ? (kalshiTickerToTeam(kalOrder.ticker||kalOrder.market_ticker||'') || '') : '';
    const kalPrice = kalOrder ? (kalOrder.yes_price ?? kalOrder.order?.yes_price ?? '') : '';
    const kalStake = kalOrder && kalOrder.count ? '$'+((Number(kalOrder.count||0)*Number(kalPrice||0))/100).toFixed(2) : '';
    const kalOrderId = kalOrder ? (kalOrder.order_id || kalOrder.id || '') : '';
    const kalLine = kalOrder
      ? `<div class="arb-leg kal-leg"><span class="leg-label">KAL</span><span class="leg-team">${escapeHtml(kalTeam)}</span><span class="leg-detail">${kalPrice}¢ · ${kalStake}</span>${kalOrderId ? `<button class="leg-sell-btn" onclick="cancelKalshiOrderFromDashboard('${kalOrderId}',this)">Cancel</button>` : ''}</div>`
      : h.stakeKalshiUsd ? `<div class="arb-leg kal-leg"><span class="leg-label">KAL</span><span class="leg-team">${escapeHtml(h.strategyLabel||'')}</span><span class="leg-detail">$${h.stakeKalshiUsd.toFixed(2)}</span></div>` : '';

    const profitLine = h.netProfitUsd ? `<div class="arb-profit">Expected profit: <strong>+$${Number(h.netProfitUsd).toFixed(2)}</strong></div>` : '';

    return `<div class="arb-pair-card" data-game-key="${escapeHtml(h.gameKey || gameKey(away, home))}">
      <div class="arb-pair-header">
        <span class="arb-pair-game">🏀 ${escapeHtml(away)} @ ${escapeHtml(home)}</span>
        <div style="display:flex;gap:4px"><span class="trade-badge arb">ARB</span>${statusBadge}</div>
      </div>
      ${polyLine}${kalLine}
      <div class="arb-pair-footer">${profitLine}<span class="trade-date">${date}</span></div>
    </div>`;
  }).filter(Boolean);

  // Standalone poly trades not matched to any arb
  const standalonePoly = polyTrades.filter(t => !usedPolyIds.has(t.id));
  // Standalone kalshi orders not matched
  const standaloneKal = kalshiOrders.filter(o => !usedKalshiIds.has(o.order_id || o.id));

  const openOrdersHtml = polyOpenOrders.map(o => {
    const price = o.price != null ? (Number(o.price)*100).toFixed(0)+'¢' : '';
    const size = o.original_size != null ? Number(o.original_size).toFixed(0)+' shares' : '';
    const stake = o.original_size && o.price ? '$'+(Number(o.original_size)*Number(o.price)).toFixed(2) : '';
    return `<div class="arb-pair-card" style="border-left-color:#f59e0b">
      <div class="arb-pair-header">
        <span class="arb-pair-game">📋 Open Order</span>
        <span class="trade-badge pending">UNMATCHED</span>
      </div>
      <div class="arb-leg poly-leg"><span class="leg-label">POLY</span><span class="leg-team">${o.side||'BUY'}</span><span class="leg-detail">${size} @ ${price} · ${stake}</span></div>
      <div class="arb-pair-footer"><span></span><button class="sell-btn" onclick="cancelPolyOrder('${o.id}',this)">Cancel</button></div>
    </div>`;
  }).join('');

  const standalonePolyHtml = standalonePoly.map(t => renderTradeCard(t, 'poly')).join('');
  const standaloneKalHtml = standaloneKal.map(o => renderKalshiOrderCard(o)).join('');

  const pnlToolbar = arbCards.length > 0
    ? `<div class="pnl-toolbar">
        <span class="pnl-label">Real-time P&amp;L</span>
        <button class="auth-btn" id="refreshPnlBtn" onclick="fetchPnl()" style="font-size:0.75rem;padding:2px 8px">↺ Refresh P&amp;L</button>
        <span class="pnl-auto-hint">auto-refreshes every 10s</span>
       </div>`
    : '';

  const allContent = [
    pnlToolbar,
    arbCards.join(''),
    openOrdersHtml,
    standalonePolyHtml || standaloneKalHtml ? `<div class="orders-col-header poly-header" style="margin-top:12px">Manual bets</div>` + standalonePolyHtml + standaloneKalHtml : '',
    arbCards.length === 0 && !openOrdersHtml && !standalonePolyHtml && !standaloneKalHtml
      ? '<p class="order-detail" style="color:var(--text-muted);padding:8px 0">No bets yet</p>' : '',
    polyErr ? `<p class="order-detail" style="color:var(--red)">${escapeHtml(polyErr)}</p>` : '',
    kalshiErr ? `<p class="order-detail" style="color:var(--red)">${escapeHtml(kalshiErr)}</p>` : '',
  ].join('');

  content.innerHTML = allContent;

  // After rendering, inject current P&L data and start auto-refresh
  if (arbCards.length > 0) {
    renderPnlRows();
    startPnlAutoRefresh();
  } else {
    stopPnlAutoRefresh();
  }
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
  if (authState.polymarket || authState.kalshi) startPnlAutoRefresh();
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
    funderAddress: (fd.get('funderAddress') || '').trim() || undefined,
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
  fetchArbHistory();

  // Open SSE to hydrate open positions from arb-history (even when engine is stopped)
  openAutoArbSSE();

  const simStartBtn = document.getElementById('simStartBtn');
  const simStopBtn = document.getElementById('simStopBtn');
  if (simStartBtn) simStartBtn.addEventListener('click', startSimulation);
  if (simStopBtn) simStopBtn.addEventListener('click', stopSimulation);
  const engineStartBtn = document.getElementById('engineStartBtn');
  const engineStopBtn = document.getElementById('engineStopBtn');
  if (engineStartBtn) engineStartBtn.addEventListener('click', startEngine);
  if (engineStopBtn) engineStopBtn.addEventListener('click', stopEngine);
  const autoArbStartBtn = document.getElementById('autoArbStartBtn');
  const autoArbStopBtn = document.getElementById('autoArbStopBtn');
  if (autoArbStartBtn) autoArbStartBtn.addEventListener('click', startAutoArb);
  if (autoArbStopBtn) autoArbStopBtn.addEventListener('click', stopAutoArb);
  // Show/hide sim config based on mode selection
  const simCfg = document.getElementById('autoArbSimConfig');
  document.querySelectorAll('input[name="autoArbMode"]').forEach(radio => {
    radio.addEventListener('change', () => {
      if (simCfg) simCfg.style.display = radio.value === 'sim' && radio.checked ? 'flex' : (document.getElementById('autoArbModeSim')?.checked ? 'flex' : 'none');
    });
  });
  const simBalancesEl = document.getElementById('simBalances');
  if (simBalancesEl && !simRunning) simBalancesEl.textContent = `Poly $${SIM_INITIAL_POLY}  ·  Kalshi $${SIM_INITIAL_KAL}  ·  Total $${SIM_INITIAL_POLY + SIM_INITIAL_KAL} (initial)`;
})();
