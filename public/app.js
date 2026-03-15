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
  });
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

let currentRows = [];
let authState = { polymarket: false, kalshi: false };

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

function renderMatchupCell(poly, kalshi) {
  const g = poly || kalshi;
  const away = g?.awayTeam || 'Away';
  const home = g?.homeTeam || 'Home';
  const hasScore = poly && poly.awayScore != null && poly.homeScore != null;
  const scoreStr = hasScore ? `<span class="matchup-score">${escapeHtml(String(poly.awayScore))} – ${escapeHtml(String(poly.homeScore))}</span>` : '<span class="vs">vs</span>';
  const statusStr = poly?.gameStatusText ? `<div class="matchup-status">${escapeHtml(poly.gameStatusText)}</div>` : '';
  const dateStr = g?.startDate ? `<div class="game-date">${formatDate(g.startDate)}</div>` : '';
  const link = (poly?.url || kalshi?.url) || '#';
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
    const [polyResult, kalshiResult] = await Promise.allSettled([
      fetchPolymarket(),
      fetchKalshi(),
    ]);

    const polyGames = polyResult.status === 'fulfilled' ? polyResult.value : [];
    const kalshiGames = kalshiResult.status === 'fulfilled' ? kalshiResult.value : [];

    if (polyResult.status !== 'fulfilled') {
      wrapper.innerHTML = `<div class="error">${escapeHtml(polyResult.reason?.message || 'Failed to load Polymarket')}${getConnectionErrorHint()}</div>`;
      return;
    }

    const byKey = new Map();

    for (const g of polyGames) {
      const key = gameKey(g.awayTeam, g.homeTeam);
      byKey.set(key, { poly: g, kalshi: byKey.get(key)?.kalshi || null });
    }
    for (const g of kalshiGames) {
      const key = gameKey(g.awayTeam, g.homeTeam);
      const existing = byKey.get(key);
      if (existing) existing.kalshi = g;
      else byKey.set(key, { poly: null, kalshi: g });
    }

    const rows = Array.from(byKey.entries()).map(([key, { poly, kalshi }]) => ({
      key,
      poly,
      kalshi,
      sortDate: (poly?.startDate || kalshi?.startDate) || '',
    }));
    rows.sort((a, b) => new Date(a.sortDate) - new Date(b.sortDate));

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
            <th class="col-kalshi">Kalshi (spread)</th>
          </tr>
        </thead>
        <tbody>
          ${rows
            .map(
              (r) => `
            <tr class="game-row">
              <td class="col-matchup">${renderMatchupCell(r.poly, r.kalshi)}</td>
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
  updateAuthUI();
}

function updateAuthUI() {
  const statusEl = document.getElementById('authStatus');
  const logoutBtn = document.getElementById('logoutBtn');
  const polyBtn = document.getElementById('signInPolyBtn');
  const kalshiBtn = document.getElementById('signInKalshiBtn');
  const parts = [];
  if (authState.polymarket) parts.push('Polymarket');
  if (authState.kalshi) parts.push('Kalshi');
  statusEl.textContent = parts.length ? `Signed in: ${parts.join(', ')}` : '';
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
  form.dataset.gameKey = gameKey;
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
    titleEl.textContent = `Bet on ${game.awayTeam} vs ${game.homeTeam} (Kalshi spread)`;
    const yesCents = Math.round((game.homeOdds || 0.5) * 100);
    fieldsEl.innerHTML = `
      <label>Side
        <select name="side" required>
          <option value="yes">Yes (${escapeHtml(game.homeTeam)} covers spread)</option>
          <option value="no">No (${escapeHtml(game.awayTeam)} covers)</option>
        </select>
      </label>
      <label>Contracts <input type="number" name="count" min="1" value="1" required /></label>
      <label>Limit price (cents 1–99) <input type="number" name="yes_price" min="1" max="99" value="${yesCents}" required /></label>
    `;
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
      alert(data.error || 'Order failed');
      return;
    }
    alert(`Order placed: ${data.status || 'live'}`);
    closeBetModal();
    load({ animate: false });
  } else {
    const body = {
      ticker: game.marketTicker,
      side: fd.get('side'),
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
      alert(data.error || 'Order failed');
      return;
    }
    alert('Order placed');
    closeBetModal();
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
