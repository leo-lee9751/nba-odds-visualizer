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
      if (aDone && !bDone) return -1;
      if (!aDone && bDone) return 1;
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
  if (platform === 'polymarket' && b.balanceUsdc != null) return ` $${Number(b.balanceUsdc).toFixed(2)}`;
  if (platform === 'kalshi' && b.balanceCents != null) return ` $${(Number(b.balanceCents) / 100).toFixed(2)}`;
  return '';
}

function updateAuthUI() {
  const statusEl = document.getElementById('authStatus');
  const logoutBtn = document.getElementById('logoutBtn');
  const polyBtn = document.getElementById('signInPolyBtn');
  const kalshiBtn = document.getElementById('signInKalshiBtn');
  const parts = [];
  if (authState.polymarket) parts.push('Polymarket' + formatBalance('polymarket'));
  if (authState.kalshi) parts.push('Kalshi' + formatBalance('kalshi'));
  statusEl.textContent = parts.length ? `Signed in: ${parts.join(' | ')}` : '';
  logoutBtn.style.display = parts.length ? 'inline-block' : 'none';
  polyBtn.style.display = authState.polymarket ? 'none' : 'inline-block';
  kalshiBtn.style.display = authState.kalshi ? 'none' : 'inline-block';
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
      <label>Size (shares / $) <input type="number" name="size" min="1" step="1" value="10" required /></label>
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
document.getElementById('polySignInForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const res = await fetch(`${API_BASE}/api/auth/polymarket`, {
    method: 'POST',
    ...fetchOpts,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiKey: fd.get('apiKey'),
      secret: fd.get('secret'),
      passphrase: fd.get('passphrase'),
      privateKey: fd.get('privateKey'),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    alert(data.error || 'Sign-in failed');
    return;
  }
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
  const res = await fetch(`${API_BASE}/api/auth/kalshi`, {
    method: 'POST',
    ...fetchOpts,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKeyId: fd.get('apiKeyId'), privateKey: fd.get('privateKey') }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    alert(data.error || 'Sign-in failed');
    return;
  }
  document.getElementById('kalshiSignInModal').hidden = true;
  e.target.reset();
  await fetchAuthStatus();
  load({ animate: false });
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await fetch(`${API_BASE}/api/auth/logout`, { method: 'POST', ...fetchOpts });
  await fetchAuthStatus();
  load({ animate: false });
});

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
    const outcome = fd.get('outcome');
    const tokenId = outcome === 'away' ? game.tokenIdAway : game.tokenIdHome;
    const body = {
      tokenId,
      side: 'BUY',
      price: Number(fd.get('price')),
      size: Number(fd.get('size')),
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
      alert(msg);
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
  load();
})();
