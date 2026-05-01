import express from 'express';
import cors from 'cors';
import session from 'express-session';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import fs from 'fs';
import WebSocket from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'nba-odds-dev-secret-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, maxAge: 24 * 60 * 60 * 1000 },
  })
);

const fetchOptions = {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  },
};

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Temporary debug: shows raw Kalshi positions + market fetch result
app.get('/api/debug/kalshi-prices', async (req, res) => {
  if (!req.session?.kalshiCreds) return res.status(401).json({ error: 'Not signed in to Kalshi' });
  const creds = req.session.kalshiCreds;
  const baseUrl = process.env.KALSHI_API_BASE || 'https://api.elections.kalshi.com';
  const result = { positions: [], marketFetch: [] };

  // 1. Fetch positions
  try {
    const posPath = '/trade-api/v2/portfolio/positions';
    const ts = String(Date.now());
    const sig = kalshiSign(creds.privateKey, ts, 'GET', posPath);
    const posRes = await fetch(`${baseUrl}${posPath}?limit=50`, { headers: { 'KALSHI-ACCESS-KEY': creds.apiKeyId, 'KALSHI-ACCESS-TIMESTAMP': ts, 'KALSHI-ACCESS-SIGNATURE': sig } });
    const posData = await posRes.json().catch(() => ({}));
    const allPos = posData.market_positions || posData.positions || [];
    result.positions = allPos.filter(p => (p.ticker||'').startsWith('KXNBAGAME-')).map(p => ({ ...p })); // full object
  } catch (e) { result.posError = e.message; }

  // 2. Try fetching each ticker's market
  for (const pos of result.positions.slice(0, 5)) {
    const ticker = pos.ticker;
    try {
      const mktPath = `/trade-api/v2/markets/${ticker}`;
      const ts = String(Date.now());
      const sig = kalshiSign(creds.privateKey, ts, 'GET', mktPath);
      const mktRes = await fetch(`${baseUrl}${mktPath}`, { headers: { 'KALSHI-ACCESS-KEY': creds.apiKeyId, 'KALSHI-ACCESS-TIMESTAMP': ts, 'KALSHI-ACCESS-SIGNATURE': sig, 'Content-Type': 'application/json' } });
      const status = mktRes.status;
      const body = await mktRes.json().catch(() => ({}));
      // Return the FULL market object so we can see all available field names
      result.marketFetch.push({ ticker, httpStatus: status, fullMarket: body.market || body, error: body.error });
    } catch (e) { result.marketFetch.push({ ticker, error: e.message }); }
  }

  res.json(result);
});

// ── Arb History (persisted to arb-history.json) ────────────────────────────
const ARB_HISTORY_FILE = path.join(__dirname, 'arb-history.json');
function readArbHistory() {
  try { return JSON.parse(fs.readFileSync(ARB_HISTORY_FILE, 'utf8')); } catch { return []; }
}
function writeArbHistory(history) {
  fs.writeFileSync(ARB_HISTORY_FILE, JSON.stringify(history, null, 2));
}
function appendArbHistory(entry) {
  const history = readArbHistory();
  history.unshift(entry); // newest first
  if (history.length > 200) history.splice(200);
  writeArbHistory(history);
}
function updateArbHistoryEntry(id, fields) {
  const history = readArbHistory();
  const idx = history.findIndex(h => h.id === id);
  if (idx === -1) return false;
  Object.assign(history[idx], fields);
  writeArbHistory(history);
  return true;
}

app.get('/api/arb-history', (req, res) => res.json(readArbHistory()));
app.delete('/api/arb-history', (req, res) => { writeArbHistory([]); res.json({ ok: true }); });

// ── Arb fills log: every executeArb call writes one JSON line here. ──────────
// Captures EXPECTED prices (what the engine thought) vs ACTUAL fills (what FOK gave us)
// plus per-leg status and rollback action if a leg failed. Append-only, line-delimited
// JSON so it's easy to tail/grep. Read via /api/arb/fills-log?n=20.
const ARB_FILLS_LOG_FILE = path.join(__dirname, 'arb-fills.log');
function appendFillsLog(entry) {
  try {
    const line = JSON.stringify({ ts: Date.now(), ...entry }) + '\n';
    fs.appendFileSync(ARB_FILLS_LOG_FILE, line);
  } catch (err) {
    console.error('[fills-log] write failed:', err.message);
  }
}
function readFillsLog(limit = 50) {
  try {
    const raw = fs.readFileSync(ARB_FILLS_LOG_FILE, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const last = lines.slice(-limit);
    return last.map((l) => { try { return JSON.parse(l); } catch { return { parseError: l }; } }).reverse();
  } catch { return []; }
}
// View recent fills via browser: http://localhost:3000/api/arb/fills-log?n=20
app.get('/api/arb/fills-log', (req, res) => {
  const n = Math.min(500, Math.max(1, Number(req.query.n) || 50));
  res.json({ entries: readFillsLog(n), file: ARB_FILLS_LOG_FILE });
});
// Wipe fills log (use sparingly)
app.delete('/api/arb/fills-log', (req, res) => {
  try { fs.writeFileSync(ARB_FILLS_LOG_FILE, ''); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
// ───────────────────────────────────────────────────────────────────────────

// Today's scoreboard (live/final scores) + upcoming (next 7 days) from schedule
const NBA_SCHEDULE_URL = 'https://cdn.nba.com/static/json/staticData/scheduleLeagueV2.json';
const NBA_SCOREBOARD_URL = 'https://cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json';
const UPCOMING_DAYS = 7;

function scoreboardGameToEntry(g, dateStr) {
  const awayTeam = g.awayTeam?.teamTricode || 'AWAY';
  const homeTeam = g.homeTeam?.teamTricode || 'HOME';
  return {
    id: g.gameId,
    awayTeam,
    homeTeam,
    startDate: g.gameTimeUTC || dateStr,
    gameStatusText: g.gameStatusText || '',
    awayScore: g.awayTeam?.score,
    homeScore: g.homeTeam?.score,
    url: `https://www.nba.com/game/${awayTeam}-vs-${homeTeam}-${g.gameId}`,
  };
}

app.get('/api/nba/upcoming', async (req, res) => {
  try {
    const now = new Date();
    const cutoff = new Date(now.getTime() + UPCOMING_DAYS * 24 * 60 * 60 * 1000);
    const pastCutoff = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000); // include last 2 days
    const byKey = new Map();

    // 1. Scoreboard for "today" and "yesterday" so we get final scores for recent games
    const datesToFetch = [];
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    datesToFetch.push(today.toISOString().slice(0, 10));
    datesToFetch.push(yesterday.toISOString().slice(0, 10));
    for (const dateStr of datesToFetch) {
      try {
        const sbRes = await fetch(`${NBA_SCOREBOARD_URL}?t=${Date.now()}&gameDate=${dateStr}`, fetchOptions);
        const sb = await sbRes.json();
        const boardDate = sb?.scoreboard?.gameDate || dateStr;
        for (const g of sb?.scoreboard?.games || []) {
          const awayTeam = g.awayTeam?.teamTricode || 'AWAY';
          const homeTeam = g.homeTeam?.teamTricode || 'HOME';
          const key = `${awayTeam}-${homeTeam}`;
          const entry = scoreboardGameToEntry(g, g.gameTimeUTC || boardDate);
          byKey.set(key, entry);
        }
      } catch (e) {
        console.warn('Scoreboard fetch for', dateStr, 'failed:', e.message);
      }
    }

    // 2. Schedule: add future (next 7 days) and recent past (last 2 days) so we have all visible games
    const schedRes = await fetch(NBA_SCHEDULE_URL, fetchOptions);
    const data = await schedRes.json();
    const gameDates = data?.leagueSchedule?.gameDates || [];
    for (const day of gameDates) {
      for (const g of day.games || []) {
        const gameTime = g.gameDateTimeUTC ? new Date(g.gameDateTimeUTC) : null;
        if (!gameTime) continue;
        const isFuture = gameTime >= now && gameTime <= cutoff;
        const isRecentPast = gameTime < now && gameTime >= pastCutoff;
        if (!isFuture && !isRecentPast) continue;
        const awayTeam = g.awayTeam?.teamTricode || 'AWAY';
        const homeTeam = g.homeTeam?.teamTricode || 'HOME';
        const key = `${awayTeam}-${homeTeam}`;
        if (!byKey.has(key)) {
          const et = g.gameEt || g.gameDateTimeEst;
          const startDate = et
            ? et.trim().replace(/Z$/i, '').replace(/[+-]\d{2}:?\d{2}$/, '') + '-04:00'
            : g.gameDateTimeUTC;
          byKey.set(key, {
            id: g.gameId,
            awayTeam,
            homeTeam,
            startDate: startDate || g.gameDateTimeUTC,
            gameStatusText: g.gameStatusText || '',
            url: `https://www.nba.com/game/${awayTeam}-vs-${homeTeam}-${g.gameId}`,
          });
        }
      }
    }

    const games = Array.from(byKey.values()).sort((a, b) => new Date(a.startDate) - new Date(b.startDate));
    res.json({ games });
  } catch (err) {
    console.error('NBA upcoming error:', err.message);
    res.status(500).json({ error: err.message, games: [] });
  }
});

// Live games (in progress, not final)
app.get('/api/nba/live', async (req, res) => {
  try {
    const now = new Date();
    const liveMap = new Map();
    for (const date of [now, new Date(now.getTime() - 24 * 60 * 60 * 1000)]) {
      const dateStr = date.toISOString().slice(0, 10);
      const sbRes = await fetch(
        `${NBA_SCOREBOARD_URL}?t=${Date.now()}&gameDate=${dateStr}`,
        fetchOptions
      );
      const sb = await sbRes.json();
      for (const g of sb?.scoreboard?.games || []) {
        const startTime = g.gameTimeUTC ? new Date(g.gameTimeUTC) : null;
        const hasStarted = startTime && startTime.getTime() < now.getTime();
        const status = (g.gameStatusText || '').toLowerCase();
        const isFinal = status.includes('final');
        const key = `${g.awayTeam?.teamTricode || 'AWAY'}-${g.homeTeam?.teamTricode || 'HOME'}`;
        if (hasStarted && !isFinal && !liveMap.has(key)) {
          liveMap.set(key, {
            awayTeam: g.awayTeam?.teamTricode || 'AWAY',
            homeTeam: g.homeTeam?.teamTricode || 'HOME',
            awayScore: g.awayTeam?.score ?? 0,
            homeScore: g.homeTeam?.score ?? 0,
            gameStatusText: g.gameStatusText || '',
            period: g.period,
            url: `https://www.nba.com/game/${g.awayTeam?.teamTricode || 'AWAY'}-vs-${g.homeTeam?.teamTricode || 'HOME'}-${g.gameId}`,
          });
        }
      }
    }
    const live = [...liveMap.values()];
    res.json({ games: live });
  } catch (err) {
    console.error('NBA live error:', err.message);
    res.status(500).json({ error: err.message, games: [] });
  }
});

// Polymarket NBA tag_id: 745 (from sports metadata - NBA sport has tags "1,745,100639")
const POLYMARKET_NBA_TAG = '745';

// Kalshi API - try demo first (sports may be on production only)
const KALSHI_BASE = 'https://demo-api.kalshi.co/trade-api/v2';

function buildGameWithScores(nbaGame, id, homeTeam, awayTeam, homeOdds, awayOdds, startDate, url, betting = null) {
  const game = {
    id,
    homeTeam,
    awayTeam,
    homeOdds,
    awayOdds,
    startDate,
    url,
    awayScore: nbaGame?.awayTeam?.score,
    homeScore: nbaGame?.homeTeam?.score,
    gameStatusText: nbaGame?.gameStatusText || '',
    period: nbaGame?.period,
  };
  if (betting) Object.assign(game, betting);
  return game;
}

// Parse outcomePrices - Polymarket returns JSON string "[\"0.45\",\"0.55\"]" or "0.45,0.55"
function parseOutcomePrices(val) {
  if (!val) return [0.5, 0.5];
  const s = String(val).trim();
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s);
      return arr.map((p) => parseFloat(p) || 0.5);
    } catch {
      return [0.5, 0.5];
    }
  }
  return s.split(',').map((p) => parseFloat(String(p).trim()) || 0.5);
}

function parseOutcomes(val) {
  if (!val) return [];
  const s = String(val).trim();
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s);
      return arr.map((x) => String(x).trim());
    } catch {
      return [];
    }
  }
  return [];
}

// Normalize a Polymarket CLOB token ID to digits-only (handles stringified JSON array or stray quotes/brackets)
function normalizePolyTokenId(val) {
  if (val == null) return '';
  if (Array.isArray(val)) return normalizePolyTokenId(val[0]);
  let s = String(val).trim();
  try {
    if (s.startsWith('[')) {
      const arr = JSON.parse(s);
      return Array.isArray(arr) && arr[0] != null ? normalizePolyTokenId(arr[0]) : s.replace(/\D/g, '');
    }
  } catch (_) {}
  return s.replace(/\D/g, '') || s;
}

// Fetch market from CLOB by condition_id (like Kushak1 polymarket-auto-trade-example). Returns null if market closed or no orderbook.
async function fetchClobMarket(conditionId) {
  if (!conditionId || typeof conditionId !== 'string') return null;
  const id = String(conditionId).trim();
  if (!id) return null;
  try {
    const res = await fetch(`https://clob.polymarket.com/markets/${encodeURIComponent(id)}`, fetchOptions);
    if (!res.ok) return null;
    const data = await res.json();
    if (data?.closed || !data?.accepting_orders) return null;
    return data;
  } catch (_) {
    return null;
  }
}

// Map CLOB market tokens to [awayTokenId, homeTokenId] by matching outcome to team names
function mapClobTokensToAwayHome(clobTokens, awayTeam, homeTeam) {
  if (!Array.isArray(clobTokens) || clobTokens.length < 2) return [];
  const away = String(awayTeam || '').toUpperCase();
  const home = String(homeTeam || '').toUpperCase();
  let awayToken = null;
  let homeToken = null;
  for (const t of clobTokens) {
    const outcome = String(t?.outcome || '').toUpperCase();
    const tokenId = normalizePolyTokenId(t?.token_id ?? t?.tokenId);
    if (!tokenId) continue;
    if (outcome.includes(away) && !outcome.includes(home)) awayToken = tokenId;
    else if (outcome.includes(home) && !outcome.includes(away)) homeToken = tokenId;
  }
  if (awayToken && homeToken) return [awayToken, homeToken];
  return [normalizePolyTokenId(clobTokens[0]?.token_id ?? clobTokens[0]?.tokenId), normalizePolyTokenId(clobTokens[1]?.token_id ?? clobTokens[1]?.tokenId)].filter(Boolean);
}

// Extract [awayToken, homeToken] from market or event; Gamma API can use clobTokenIds, tokens, or one token per market in multi-outcome events
function parseMarketTokenIds(market, event, awayTeam, homeTeam) {
  const markets = event?.markets || [];
  let tokenIds = market?.clobTokenIds ?? market?.tokens;
  if (typeof tokenIds === 'string') {
    try {
      if (tokenIds.trim().startsWith('[')) tokenIds = JSON.parse(tokenIds);
      else tokenIds = tokenIds.split(',').map((s) => s.trim()).filter(Boolean);
    } catch (_) {
      tokenIds = tokenIds.split(',').map((s) => s.trim()).filter(Boolean);
    }
  }
  // For single-market (binary) events: clobTokenIds[0]=awayYES, [1]=homeYES — use directly.
  // For multi-market (negRisk) events: skip to the title-matching loop below so each team's YES token
  // is found correctly. Without this guard, [1] would be AWAY_NO, not HOME_YES.
  if (Array.isArray(tokenIds) && tokenIds.length >= 2 && markets.length <= 1) {
    return [normalizePolyTokenId(tokenIds[0]), normalizePolyTokenId(tokenIds[1])].filter(Boolean);
  }
  let awayToken = null;
  let homeToken = null;
  for (const m of markets) {
    const title = (m.groupItemTitle || m.question || m.title || '').toLowerCase();
    if (/spread|total|over|under|points|margin|o\/u/i.test(title)) continue;
    const ids = m?.clobTokenIds ?? m?.tokens;
    let arr = Array.isArray(ids) ? ids : [];
    if (typeof ids === 'string') {
      try {
        arr = ids.trim().startsWith('[') ? JSON.parse(ids) : ids.split(',').map((s) => s.trim()).filter(Boolean);
      } catch (_) {
        arr = ids.split(',').map((s) => s.trim()).filter(Boolean);
      }
    }
    if (arr.length === 0) continue;
    const firstToken = normalizePolyTokenId(arr[0]);
    if (!firstToken) continue;
    const titleUpper = (m.groupItemTitle || m.question || m.title || '').toUpperCase();
    if (titleUpper.includes(String(awayTeam).toUpperCase()) && !titleUpper.includes(String(homeTeam).toUpperCase())) awayToken = firstToken;
    else if (titleUpper.includes(String(homeTeam).toUpperCase()) && !titleUpper.includes(String(awayTeam).toUpperCase())) homeToken = firstToken;
    else if (!awayToken) awayToken = firstToken;
    else if (!homeToken) homeToken = firstToken;
    if (awayToken && homeToken) return [awayToken, homeToken];
  }
  return [];
}

// Pick the moneyline market (who wins), not spread or total
function findMoneylineMarket(markets) {
  const skip = /spread|total|over|under|points|margin|o\/u|by\s+\d+\.?\d*\s*points?/i;
  for (const m of markets || []) {
    const title = (m.groupItemTitle || m.question || m.title || '').toLowerCase();
    if (skip.test(title)) continue;
    if ((m.outcomePrices || m.outcome_prices) && (title.includes('win') || title.includes('moneyline') || title.includes(' vs ') || (m.outcomes && !skip.test(String(m.outcomes))))) return m;
  }
  return markets?.find((m) => m.outcomePrices || m.outcome_prices) || markets?.[0];
}

// Map outcome labels to away/home price using event.teams and slug (away = first in slug, home = second)
function mapPricesToAwayHome(prices, outcomes, event, awayAbbr, homeAbbr) {
  if (!prices?.length || prices.length < 2) return { awayOdds: 0.5, homeOdds: 0.5 };
  const away = String(awayAbbr).toUpperCase();
  const home = String(homeAbbr).toUpperCase();
  const teams = event?.teams || [];
  const teamToSide = new Map();
  if (teams.length >= 1) {
    const t0 = teams[0];
    if (t0?.abbreviation) teamToSide.set(String(t0.abbreviation).toUpperCase(), 'away');
    if (t0?.name) teamToSide.set(String(t0.name).trim().toLowerCase(), 'away');
  }
  if (teams.length >= 2) {
    const t1 = teams[1];
    if (t1?.abbreviation) teamToSide.set(String(t1.abbreviation).toUpperCase(), 'home');
    if (t1?.name) teamToSide.set(String(t1.name).trim().toLowerCase(), 'home');
  }
  if (teams.length < 2) {
    teamToSide.set(away, 'away');
    teamToSide.set(home, 'home');
  }

  let awayPrice = 0.5;
  let homePrice = 0.5;
  for (let i = 0; i < outcomes.length && i < prices.length; i++) {
    const label = String(outcomes[i] || '').trim();
    const p = parseFloat(prices[i]) || 0.5;
    const side = teamToSide.get(label.toLowerCase()) || teamToSide.get(label.toUpperCase()) || (label.toUpperCase() === away ? 'away' : label.toUpperCase() === home ? 'home' : null);
    if (side === 'away') awayPrice = p;
    else if (side === 'home') homePrice = p;
    else if (i === 0) awayPrice = p;
    else if (i === 1) homePrice = p;
  }
  if (outcomes.length < 2 && prices.length >= 2) {
    awayPrice = prices[0];
    homePrice = prices[1];
  }
  return { awayOdds: awayPrice, homeOdds: homePrice };
}

// Build a Polymarket game from Gamma API event. Uses CLOB getMarket(condition_id) to validate tokens (Kushak1 architecture).
// Pass knownAway/knownHome (NBA tricodes) when available to avoid extracting wrong abbreviations from titles like "Jazz vs. Nuggets"
async function buildPolyGameFromEvent(event, knownAway, knownHome) {
  const market = findMoneylineMarket(event.markets);
  if (!market) return null;
  const pricesRaw = market?.outcomePrices ?? market?.outcome_prices;
  const prices = parseOutcomePrices(pricesRaw);
  const outcomes = parseOutcomes(market?.outcomes ?? market?.outcome);
  const slug = event.slug || event.id || '';
  const slugMatch = slug.match(/nba-(\w+)-(\w+)-/);
  let awayTeam = (knownAway && knownAway.toUpperCase()) || (slugMatch && slugMatch[1] ? slugMatch[1].toUpperCase() : null) || event.teams?.[0]?.abbreviation || event.teams?.[0]?.name?.slice(0, 3)?.toUpperCase() || 'AWAY';
  let homeTeam = (knownHome && knownHome.toUpperCase()) || (slugMatch && slugMatch[2] ? slugMatch[2].toUpperCase() : null) || event.teams?.[1]?.abbreviation || event.teams?.[1]?.name?.slice(0, 3)?.toUpperCase() || 'HOME';
  // Only use title extraction as fallback when tricodes aren't already known — titles like "Jazz vs. Nuggets" produce "JAZ"/"NUG" which won't match NBA tricodes
  if (!knownAway || !knownHome) {
    const title = event.title || market?.question || '';
    const vsMatch = title.match(/(.+?)\s+vs\.?\s+(.+)/i);
    if (vsMatch) {
      awayTeam = String(vsMatch[1]).trim().slice(0, 3).toUpperCase() || awayTeam;
      homeTeam = String(vsMatch[2]).trim().slice(0, 3).toUpperCase() || homeTeam;
    }
  }
  const { awayOdds, homeOdds } = mapPricesToAwayHome(prices, outcomes, event, awayTeam, homeTeam);
  let betting = null;
  const conditionId = market?.conditionId ?? market?.condition_id ?? event?.conditionId ?? event?.condition_id;
  if (conditionId) {
    const clobMarket = await fetchClobMarket(conditionId);
    if (clobMarket?.tokens) {
      const tokenIdArr = mapClobTokensToAwayHome(clobMarket.tokens, awayTeam, homeTeam);
      const tickSize = clobMarket.minimum_tick_size ?? clobMarket.min_tick_size ?? market?.minimum_tick_size ?? market?.tickSize ?? '0.01';
      const negRisk = Boolean(clobMarket.neg_risk ?? clobMarket.negRisk ?? market?.neg_risk ?? market?.negRisk);
      if (tokenIdArr.length >= 2) {
        betting = { tokenIdAway: tokenIdArr[0], tokenIdHome: tokenIdArr[1], tickSize: String(tickSize), negRisk };
      }
    }
  }
  if (!betting) {
    const tokenIdArr = parseMarketTokenIds(market, event, awayTeam, homeTeam);
    const tickSize = market?.minimum_tick_size ?? market?.tickSize ?? '0.01';
    const negRisk = Boolean(market?.neg_risk ?? market?.negRisk);
    if (tokenIdArr.length >= 2) {
      betting = { tokenIdAway: tokenIdArr[0], tokenIdHome: tokenIdArr[1], tickSize: String(tickSize), negRisk };
    }
  }
  const game = {
    id: event.id || slug,
    homeTeam,
    awayTeam,
    homeOdds: Math.round(homeOdds * 100) / 100,
    awayOdds: Math.round(awayOdds * 100) / 100,
    startDate: event.startDate || event.start_date,
    url: `https://polymarket.com/event/${slug}`,
    label: 'Moneyline',
    awayScore: undefined,
    homeScore: undefined,
    gameStatusText: '',
  };
  if (betting) Object.assign(game, betting);
  return game;
}

// Simple in-memory cache for /api/polymarket (avoids re-fetching all external APIs on every page load)
let polymarketCache = null;
let polymarketCacheTime = 0;
// Call this whenever you need to force a fresh fetch (e.g. after a bug fix)
function bustPolymarketCache() { polymarketCache = null; polymarketCacheTime = 0; }
const POLYMARKET_CACHE_TTL_MS = 10000; // 10 seconds — used when WS is not connected

// ── WebSocket Price Feeds ─────────────────────────────────────────────────────
// Game objects are discovered via REST; prices stay fresh via WebSocket push.

const polyGamesState = new Map();   // gameKey → game object (prices updated by WS)
const kalshiGamesState = new Map(); // gameKey → game object (prices updated by WS)
const polyTokenToKey = new Map();   // tokenId → gameKey
const kalshiTickerToKey = new Map(); // marketTicker → gameKey
const subscribedPolyTokenIds = new Set();

// ── CS2 team name normalization ───────────────────────────────────────────────
// Maps common full/alias names → canonical abbreviation used as game key
const CS2_TEAM_ALIASES = {
  'natus vincere': 'NAVI', 'natusvincere': 'NAVI', 'navi': 'NAVI', "na'vi": 'NAVI',
  'g2 esports': 'G2', 'g2': 'G2',
  'team liquid': 'LIQUID', 'liquid': 'LIQUID',
  'team spirit': 'SPIRIT', 'spirit': 'SPIRIT',
  'faze clan': 'FAZE', 'faze': 'FAZE',
  'team vitality': 'VITALITY', 'vitality': 'VITALITY',
  'ninjas in pyjamas': 'NIP', 'nip': 'NIP',
  'mousesports': 'MOUZ', 'mouz': 'MOUZ',
  'astralis': 'ASTRALIS',
  'ence': 'ENCE',
  'heroic': 'HEROIC',
  'complexity': 'COL', 'team complexity': 'COL',
  'cloud9': 'C9',
  'eternal fire': 'EF', 'eternalfire': 'EF',
  'mibr': 'MIBR',
  '3dmax': '3DMAX',
  'the mongolz': 'MONGOLZ', 'mongolz': 'MONGOLZ',
  'legacy': 'LEGACY',
  'falcons': 'FALCONS',
  'big': 'BIG',
};
function normalizeCS2Team(name) {
  const lower = (name || '').toLowerCase().trim();
  const nosp = lower.replace(/[^a-z0-9]/g, '');
  return CS2_TEAM_ALIASES[lower] || CS2_TEAM_ALIASES[nosp] || nosp.slice(0, 8).toUpperCase();
}
const subscribedKalshiTickers = new Set();

// ─── Polymarket WebSocket ─────────────────────────────────────────────────────
let polyWs = null;
let polyWsPingInterval = null;

function connectPolymarketWS() {
  if (polyWs && (polyWs.readyState === 0 || polyWs.readyState === 1)) return;
  try {
    polyWs = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market');
    polyWs.on('open', () => {
      console.log('[PolyWS] Connected');
      if (subscribedPolyTokenIds.size) {
        polyWs.send(JSON.stringify({ assets_ids: [...subscribedPolyTokenIds], type: 'market' }));
      }
      clearInterval(polyWsPingInterval);
      polyWsPingInterval = setInterval(() => {
        if (polyWs?.readyState === 1) polyWs.send('PING');
      }, 10000);
    });
    polyWs.on('message', (raw) => {
      try {
        const text = raw.toString();
        if (text === 'PONG') return;
        const msgs = JSON.parse(text);
        const arr = Array.isArray(msgs) ? msgs : [msgs];
        for (const msg of arr) {
          const tokenId = String(msg.asset_id || '');
          if (!tokenId) continue;
          const key = polyTokenToKey.get(tokenId);
          if (!key) continue;
          const game = polyGamesState.get(key);
          if (!game) continue;
          let bestBid = null;
          let bestAsk = null;
          if (msg.event_type === 'book') {
            if (Array.isArray(msg.bids) && msg.bids.length > 0) bestBid = parseFloat(msg.bids[0].price);
            if (Array.isArray(msg.asks) && msg.asks.length > 0) bestAsk = parseFloat(msg.asks[0].price);
          } else if (msg.event_type === 'price_change' && Array.isArray(msg.changes)) {
            const buys = msg.changes.filter(c => c.side === 'BUY' && parseFloat(c.size) > 0)
              .sort((a, b) => parseFloat(b.price) - parseFloat(a.price));
            if (buys.length) bestBid = parseFloat(buys[0].price);
            const sells = msg.changes.filter(c => c.side === 'SELL' && parseFloat(c.size) > 0)
              .sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
            if (sells.length) bestAsk = parseFloat(sells[0].price);
          } else if (msg.event_type === 'last_trade_price' && msg.price) {
            bestBid = parseFloat(msg.price);
          }
          if (bestBid !== null && !isNaN(bestBid) && bestBid > 0.01 && bestBid < 0.99) {
            if (tokenId === String(game.tokenIdHome)) game.homeOdds = Math.round(bestBid * 100) / 100;
            else if (tokenId === String(game.tokenIdAway)) game.awayOdds = Math.round(bestBid * 100) / 100;
            game._wsUpdatedAt = Date.now();
            onPriceUpdate();
          }
          if (bestAsk !== null && !isNaN(bestAsk) && bestAsk > 0.01 && bestAsk < 0.99) {
            if (tokenId === String(game.tokenIdHome)) game.homeAsk = Math.round(bestAsk * 100) / 100;
            else if (tokenId === String(game.tokenIdAway)) game.awayAsk = Math.round(bestAsk * 100) / 100;
          }
        }
      } catch (_) {}
    });
    polyWs.on('close', () => {
      clearInterval(polyWsPingInterval);
      console.log('[PolyWS] Disconnected, reconnecting in 3s...');
      setTimeout(connectPolymarketWS, 3000);
    });
    polyWs.on('error', (err) => console.error('[PolyWS] Error:', err.message));
  } catch (err) {
    console.error('[PolyWS] Failed to connect:', err.message);
    setTimeout(connectPolymarketWS, 5000);
  }
}

function subscribePolymarketTokens(tokenIds) {
  const fresh = tokenIds.filter(id => id && !subscribedPolyTokenIds.has(id));
  if (!fresh.length) return;
  fresh.forEach(id => subscribedPolyTokenIds.add(id));
  if (polyWs?.readyState === 1) polyWs.send(JSON.stringify({ assets_ids: fresh, type: 'market' }));
}

// ─── Kalshi WebSocket ─────────────────────────────────────────────────────────
let kalshiWs = null;
let kalshiWsCreds = null;
let kalshiWsPingInterval = null;

function connectKalshiWS(creds) {
  if (!creds?.apiKeyId || !creds?.privateKey) return;
  kalshiWsCreds = creds;
  if (kalshiWs && (kalshiWs.readyState === 0 || kalshiWs.readyState === 1)) return;
  try {
    const ts = String(Date.now());
    const wsPath = '/trade-api/ws/v2';
    const sig = kalshiSign(creds.privateKey, ts, 'GET', wsPath);
    kalshiWs = new WebSocket('wss://api.elections.kalshi.com/trade-api/ws/v2', {
      headers: {
        'KALSHI-ACCESS-KEY': creds.apiKeyId,
        'KALSHI-ACCESS-TIMESTAMP': ts,
        'KALSHI-ACCESS-SIGNATURE': sig,
      },
    });
    kalshiWs.on('open', () => {
      console.log('[KalshiWS] Connected');
      if (subscribedKalshiTickers.size) {
        kalshiWs.send(JSON.stringify({ id: 1, cmd: 'subscribe', params: { channels: ['ticker'], market_tickers: [...subscribedKalshiTickers] } }));
      }
      clearInterval(kalshiWsPingInterval);
      kalshiWsPingInterval = setInterval(() => {
        if (kalshiWs?.readyState === 1) kalshiWs.send(JSON.stringify({ id: 99, cmd: 'ping' }));
      }, 20000);
    });
    kalshiWs.on('message', (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        if (data.type !== 'ticker' || !data.msg) return;
        const { market_ticker, yes_bid, yes_ask } = data.msg;
        if (!market_ticker) return;
        const key = kalshiTickerToKey.get(market_ticker);
        if (!key) return;
        const game = kalshiGamesState.get(key);
        if (!game) return;
        const mid = (parseFloat(yes_bid) + parseFloat(yes_ask)) / 2 / 100; // cents → decimal
        if (isNaN(mid) || mid < 0.01 || mid > 0.99) return;
        if (market_ticker === game.marketTickerHome) game.homeOdds = Math.round(mid * 100) / 100;
        else if (market_ticker === game.marketTickerAway) game.awayOdds = Math.round(mid * 100) / 100;
        game._wsUpdatedAt = Date.now();
        onPriceUpdate();
      } catch (_) {}
    });
    kalshiWs.on('close', () => {
      clearInterval(kalshiWsPingInterval);
      console.log('[KalshiWS] Disconnected, reconnecting in 3s...');
      setTimeout(() => connectKalshiWS(kalshiWsCreds), 3000);
    });
    kalshiWs.on('error', (err) => console.error('[KalshiWS] Error:', err.message));
  } catch (err) {
    console.error('[KalshiWS] Failed to connect:', err.message);
    setTimeout(() => connectKalshiWS(kalshiWsCreds), 5000);
  }
}

function subscribeKalshiTickers(tickers) {
  const fresh = tickers.filter(t => t && !subscribedKalshiTickers.has(t));
  if (!fresh.length) return;
  fresh.forEach(t => subscribedKalshiTickers.add(t));
  if (kalshiWs?.readyState === 1) {
    kalshiWs.send(JSON.stringify({ id: 2, cmd: 'subscribe', params: { channels: ['ticker'], market_tickers: fresh } }));
  }
}
// ─────────────────────────────────────────────────────────────────────────────

// Fetch NBA game odds from Polymarket - look up each upcoming game by slug (tag_id=745 returns 422)
app.get('/api/polymarket', async (req, res) => {
  if (polymarketCache && Date.now() - polymarketCacheTime < POLYMARKET_CACHE_TTL_MS) {
    return res.json(polymarketCache);
  }
  try {
    const byKey = new Map(); // key = AWAY-HOME (e.g. ORL-ATL)

    // 1. Fetch upcoming NBA games from schedule and look up each by Polymarket slug.
    try {
      const now = new Date();
      const cutoff = new Date(now.getTime() + UPCOMING_DAYS * 24 * 60 * 60 * 1000);
      const schedRes = await fetch(NBA_SCHEDULE_URL, fetchOptions);
      const schedData = await schedRes.json();
      const toFetch = [];
      for (const day of schedData?.leagueSchedule?.gameDates || []) {
        for (const g of day.games || []) {
          const gameTime = g.gameDateTimeUTC ? new Date(g.gameDateTimeUTC) : null;
          if (!gameTime || gameTime < now || gameTime > cutoff) continue;
          const away = (g.awayTeam?.teamTricode || '').toUpperCase();
          const home = (g.homeTeam?.teamTricode || '').toUpperCase();
          if (!away || !home) continue;
          // Try ET, UTC, and next-day dates — Polymarket slugs sometimes use a different date than the actual game time
          const etDateStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(gameTime);
          const utcDateStr = gameTime.toISOString().slice(0, 10);
          const nextDayStr = new Date(gameTime.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
          for (const dateStr of [...new Set([etDateStr, utcDateStr, nextDayStr])]) toFetch.push({ away, home, dateStr });
        }
      }
      await Promise.all(
        toFetch.map(async ({ away, home, dateStr }) => {
          const key = `${away}-${home}`;
          if (byKey.has(key)) return;
          const slug = `nba-${away.toLowerCase()}-${home.toLowerCase()}-${dateStr}`;
          try {
            const eventRes = await fetch(
              `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`,
              fetchOptions
            );
            const events = await eventRes.json();
            const event = Array.isArray(events) ? events[0] : events;
            // Skip closed/resolved markets — prefer active ones
            if (event?.markets?.length && event?.closed !== true && event?.active !== false) {
              const game = await buildPolyGameFromEvent(event, away, home);
              if (game && !byKey.has(key)) byKey.set(key, game);
            }
          } catch (_) {}
        })
      );
    } catch (e) {
      console.warn('Polymarket schedule slug fetch failed:', e.message);
    }

    // 2. If today's scoreboard has games, overlay slug-fetched data (scores + slug-specific odds)
    const scoreboardRes = await fetch(
      `https://cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json?t=${Date.now()}`,
      fetchOptions
    );
    const scoreboard = await scoreboardRes.json();
    const nbaGames = scoreboard?.scoreboard?.games || [];
    const dateStr = scoreboard?.scoreboard?.gameDate || new Date().toISOString().slice(0, 10);

    if (nbaGames.length > 0) {
      await Promise.all(
        nbaGames.map(async (g, i) => {
          const away = (g.awayTeam?.teamTricode || 'AWAY').toUpperCase();
          const home = (g.homeTeam?.teamTricode || 'HOME').toUpperCase();
          const key = `${away}-${home}`;
          const gameTimeUTC = g.gameTimeUTC ? new Date(g.gameTimeUTC) : null;
          const utcDateStr2 = gameTimeUTC ? gameTimeUTC.toISOString().slice(0, 10) : dateStr;
          const nextDayStr2 = gameTimeUTC ? new Date(gameTimeUTC.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10) : dateStr;
          const slugsToTry = [...new Set([dateStr, utcDateStr2, nextDayStr2].map(d => `nba-${away.toLowerCase()}-${home.toLowerCase()}-${d}`))];
          const slug = slugsToTry[0];
          try {
            let events = [];
            for (const s of slugsToTry) {
              const r = await fetch(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(s)}`, fetchOptions);
              const d = await r.json();
              if (Array.isArray(d) && d[0]?.markets?.length) { events = d; break; }
            }
            const event = Array.isArray(events) ? events[0] : events;
            if (event?.markets?.length) {
              const market = findMoneylineMarket(event.markets);
              const pricesRaw = market?.outcomePrices ?? market?.outcome_prices;
              const prices = parseOutcomePrices(pricesRaw);
              const outcomes = parseOutcomes(market?.outcomes ?? market?.outcome);
              const { awayOdds, homeOdds } = mapPricesToAwayHome(prices, outcomes, event, away, home);
              let betting = null;
              const conditionId = market?.conditionId ?? market?.condition_id ?? event?.conditionId ?? event?.condition_id;
              if (conditionId) {
                const clobMarket = await fetchClobMarket(conditionId);
                if (clobMarket?.tokens) {
                  const tokenIdArr = mapClobTokensToAwayHome(clobMarket.tokens, away, home);
                  const tickSize = clobMarket.minimum_tick_size ?? clobMarket.min_tick_size ?? market?.minimum_tick_size ?? market?.tickSize ?? '0.01';
                  const negRisk = Boolean(clobMarket.neg_risk ?? clobMarket.negRisk ?? market?.neg_risk ?? market?.negRisk);
                  if (tokenIdArr.length >= 2) {
                    betting = { tokenIdAway: tokenIdArr[0], tokenIdHome: tokenIdArr[1], tickSize: String(tickSize), negRisk };
                  }
                }
              }
              if (!betting) {
                const tokenIdArr = parseMarketTokenIds(market, event, away, home);
                const tickSize = market?.minimum_tick_size ?? market?.tickSize ?? '0.01';
                const negRisk = Boolean(market?.neg_risk ?? market?.negRisk);
                if (tokenIdArr.length >= 2) {
                  betting = { tokenIdAway: tokenIdArr[0], tokenIdHome: tokenIdArr[1], tickSize: String(tickSize), negRisk };
                }
              }
              const built = buildGameWithScores(g, event.id || slug, home, away, Math.round(homeOdds * 100) / 100, Math.round(awayOdds * 100) / 100, event.startDate || g?.gameTimeUTC, `https://polymarket.com/event/${slug}`, betting);
              built.label = 'Moneyline';
              byKey.set(key, built);
            } else {
              const fallback = buildGameWithScores(g, slug, home, away, 0.5, 0.5, event?.startDate || g?.gameTimeUTC, `https://polymarket.com/sports/nba/${slug}`);
              if (!byKey.has(key)) byKey.set(key, fallback);
            }
          } catch (e) {
            const fallback = buildGameWithScores(g, slug, home, away, 0.5, 0.5, g?.gameTimeUTC, `https://polymarket.com/sports/nba/${slug}`);
            if (!byKey.has(key)) byKey.set(key, fallback);
          }
        })
      );
    }

    const games = Array.from(byKey.values()).sort((a, b) => new Date(a.startDate || 0) - new Date(b.startDate || 0));

    // Update in-memory state and subscribe WS to any new token IDs
    const newTokenIds = [];
    for (const game of games) {
      const key = `${game.awayTeam}-${game.homeTeam}`;
      polyGamesState.set(key, game);
      if (game.tokenIdHome) { polyTokenToKey.set(String(game.tokenIdHome), key); if (!subscribedPolyTokenIds.has(String(game.tokenIdHome))) newTokenIds.push(String(game.tokenIdHome)); }
      if (game.tokenIdAway) { polyTokenToKey.set(String(game.tokenIdAway), key); if (!subscribedPolyTokenIds.has(String(game.tokenIdAway))) newTokenIds.push(String(game.tokenIdAway)); }
    }
    if (newTokenIds.length) subscribePolymarketTokens(newTokenIds);

    const result = { games };
    polymarketCache = result;
    polymarketCacheTime = Date.now();
    res.json(result);
  } catch (error) {
    console.error('Polymarket API error:', error.message);
    res.status(500).json({ error: 'Failed to fetch Polymarket data', games: [] });
  }
});

// Kalshi elections API has NBA Spread (and Total) - no auth required
const KALSHI_ELECTIONS = 'https://api.elections.kalshi.com/trade-api/v2';
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

// Parse "DEN at LAL (Mar 14)" or "GSW at NYK (Mar 15)" -> away, home (can be full city names)
function parseKalshiSubtitle(sub) {
  const m = (sub || '').match(/([A-Za-z]+)\s+at\s+([A-Za-z]+)\s+\(/);
  return m ? { away: m[1].toUpperCase(), home: m[2].toUpperCase() } : null;
}

// Event ticker is KXNBAGAME-26MAR15PORPHI (YYMMMDD + away 3 + home 3). Use this so keys match NBA tricodes (POR-PHI).
function parseKalshiEventTicker(eventTicker) {
  const suffix = (eventTicker || '').split('-')[1] || '';
  if (suffix.length < 13) return null; // YYMMMDD = 7, then 6 for teams
  const teamPart = suffix.slice(7);
  if (teamPart.length < 6) return null;
  return { away: teamPart.slice(0, 3), home: teamPart.slice(3, 6) };
}

// Build Kalshi event_ticker for NBA game: KXNBAGAME-26MAR15GSWNYK (YYMMMDD away home)
// Use game date in Eastern so late-night games (e.g. 10pm ET) use the correct calendar day
function kalshiEventTicker(awayTeam, homeTeam, gameDateStr) {
  const d = gameDateStr ? new Date(gameDateStr) : new Date();
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: '2-digit', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (type) => (parts.find((p) => p.type === type) || {}).value || '';
  const yy = get('year');
  const mon = MONTHS[parseInt(get('month'), 10) - 1] || 'JAN';
  const dd = get('day');
  const away = (awayTeam || '').toUpperCase().replace(/\s+/g, '');
  const home = (homeTeam || '').toUpperCase().replace(/\s+/g, '');
  return `KXNBAGAME-${yy}${mon}${dd}${away}${home}`;
}

function kalshiGameFromEventAndMarkets(event, markets, startDate) {
  const teams = parseKalshiSubtitle(event?.sub_title);
  if (!teams && !(event?.event_ticker)) return null;
  const away = teams?.away || (event?.event_ticker || '').replace(/.*\d{2}[A-Z]{3}\d{2}/, '').slice(0, 3) || 'AWAY';
  const home = teams?.home || 'HOME';
  if (markets.length < 2) return null;
  const marketFor = (code) => markets.find((m) => (m.ticker || '').endsWith('-' + code));
  const homeM = marketFor(home);
  const awayM = marketFor(away);
  if (!homeM || !awayM) return null;
  const homeProb = parseFloat(homeM.yes_bid_dollars ?? homeM.last_price_dollars ?? 0.5);
  const awayProb = parseFloat(awayM.yes_bid_dollars ?? awayM.last_price_dollars ?? 0.5);
  return {
    id: event.event_ticker,
    awayTeam: away,
    homeTeam: home,
    homeOdds: homeProb,
    awayOdds: awayProb,
    startDate: startDate || event.last_updated_ts,
    url: `https://kalshi.com/markets/${event.event_ticker}`,
    label: 'Moneyline',
    marketTickerHome: homeM.ticker,
    marketTickerAway: awayM.ticker,
    marketTicker: homeM.ticker,
  };
}

// Fetch NBA game odds from Kalshi (Game line / moneyline: who wins, percentage odds like the app)
app.get('/api/kalshi', async (req, res) => {
  try {
    const eventsRes = await fetch(
      `${KALSHI_ELECTIONS}/events?status=open&series_ticker=KXNBAGAME&limit=50`,
      fetchOptions
    );
    const { events = [] } = await eventsRes.json();

    const gamesByKey = new Map();
    for (const event of events) {
      let teams = parseKalshiEventTicker(event.event_ticker);
      if (!teams) teams = parseKalshiSubtitle(event.sub_title);
      if (!teams) continue;

      const marketsRes = await fetch(
        `${KALSHI_ELECTIONS}/markets?event_ticker=${encodeURIComponent(event.event_ticker)}&status=open`,
        fetchOptions
      );
      const { markets = [] } = await marketsRes.json();
      if (markets.length < 2) continue;

      const marketFor = (code) => markets.find((m) => (m.ticker || '').toUpperCase().endsWith('-' + code));
      const homeM = marketFor(teams.home);
      const awayM = marketFor(teams.away);
      if (!homeM || !awayM) continue;

      const homeProb = parseFloat(homeM.yes_bid_dollars ?? homeM.last_price_dollars ?? 0.5);
      const awayProb = parseFloat(awayM.yes_bid_dollars ?? awayM.last_price_dollars ?? 0.5);

      const key = `${teams.away}-${teams.home}`;
      gamesByKey.set(key, {
        id: event.event_ticker,
        awayTeam: teams.away,
        homeTeam: teams.home,
        homeOdds: homeProb,
        awayOdds: awayProb,
        startDate: event.last_updated_ts,
        url: `https://kalshi.com/markets/${event.event_ticker}`,
        label: 'Moneyline',
        marketTickerHome: homeM.ticker,
        marketTickerAway: awayM.ticker,
        marketTicker: homeM.ticker,
      });
    }

    // Fallback 1: today's and yesterday's scoreboard games
    try {
      const today = new Date();
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      for (const date of [today, yesterday]) {
        const dateStr = date.toISOString().slice(0, 10);
        const sbRes = await fetch(
          `${NBA_SCOREBOARD_URL}?t=${Date.now()}&gameDate=${dateStr}`,
          fetchOptions
        );
        const sb = await sbRes.json();
        for (const g of sb?.scoreboard?.games || []) {
          const away = g.awayTeam?.teamTricode || 'AWAY';
          const home = g.homeTeam?.teamTricode || 'HOME';
          const key = `${away}-${home}`;
          if (gamesByKey.has(key)) continue;
          const ticker = kalshiEventTicker(away, home, g.gameTimeUTC || dateStr);
          const evRes = await fetch(
            `${KALSHI_ELECTIONS}/events/${encodeURIComponent(ticker)}?with_nested_markets=true`,
            fetchOptions
          );
          if (!evRes.ok) continue;
          const evData = await evRes.json().catch(() => ({}));
          const eventObj = evData.event || evData;
          const markets = evData.markets || eventObj.markets || [];
          const game = kalshiGameFromEventAndMarkets(
            eventObj,
            markets,
            g.gameTimeUTC || eventObj?.last_updated_ts
          );
          if (game) gamesByKey.set(key, game);
        }
      }
    } catch (fallbackErr) {
      console.warn('Kalshi scoreboard fallback error:', fallbackErr.message);
    }

    // Fallback 2: all games from NBA schedule (next 7 days + last 5 days) in parallel so every game gets a Kalshi lookup
    try {
      const now = new Date();
      const cutoff = new Date(now.getTime() + UPCOMING_DAYS * 24 * 60 * 60 * 1000);
      const pastCutoff = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
      const schedRes = await fetch(NBA_SCHEDULE_URL, fetchOptions);
      const schedData = await schedRes.json();
      const toFetch = [];
      for (const day of schedData?.leagueSchedule?.gameDates || []) {
        for (const g of day.games || []) {
          const gameTime = g.gameDateTimeUTC ? new Date(g.gameDateTimeUTC) : null;
          if (!gameTime) continue;
          const isFuture = gameTime >= now && gameTime <= cutoff;
          const isRecentPast = gameTime < now && gameTime >= pastCutoff;
          if (!isFuture && !isRecentPast) continue;
          const away = g.awayTeam?.teamTricode || 'AWAY';
          const home = g.homeTeam?.teamTricode || 'HOME';
          const key = `${away}-${home}`;
          if (gamesByKey.has(key)) continue;
          const ticker = kalshiEventTicker(away, home, g.gameDateTimeUTC);
          toFetch.push({ key, ticker, startDate: g.gameDateTimeUTC });
        }
      }
      const BATCH = 8;
      for (let i = 0; i < toFetch.length; i += BATCH) {
        const batch = toFetch.slice(i, i + BATCH);
        const results = await Promise.allSettled(
          batch.map(({ ticker }) =>
            fetch(`${KALSHI_ELECTIONS}/events/${encodeURIComponent(ticker)}?with_nested_markets=true`, fetchOptions)
          )
        );
        for (let j = 0; j < batch.length; j++) {
          const { key, startDate } = batch[j];
          const res = results[j];
          if (res.status !== 'fulfilled' || !res.value.ok) continue;
          const evData = await res.value.json().catch(() => ({}));
          const eventObj = evData.event || evData;
          const markets = evData.markets || eventObj.markets || [];
          const game = kalshiGameFromEventAndMarkets(eventObj, markets, startDate || eventObj?.last_updated_ts);
          if (game) gamesByKey.set(key, game);
        }
      }
    } catch (scheduleFallbackErr) {
      console.warn('Kalshi schedule fallback error:', scheduleFallbackErr.message);
    }

    const games = Array.from(gamesByKey.values()).sort(
      (a, b) => new Date(a.startDate || 0) - new Date(b.startDate || 0)
    );

    // Update in-memory state and subscribe WS to any new tickers
    const newTickers = [];
    for (const game of games) {
      const key = `${game.awayTeam}-${game.homeTeam}`;
      kalshiGamesState.set(key, game);
      if (game.marketTickerHome) { kalshiTickerToKey.set(game.marketTickerHome, key); if (!subscribedKalshiTickers.has(game.marketTickerHome)) newTickers.push(game.marketTickerHome); }
      if (game.marketTickerAway) { kalshiTickerToKey.set(game.marketTickerAway, key); if (!subscribedKalshiTickers.has(game.marketTickerAway)) newTickers.push(game.marketTickerAway); }
    }
    if (newTickers.length) subscribeKalshiTickers(newTickers);

    res.json({ games });
  } catch (error) {
    console.error('Kalshi API error:', error.message);
    res.status(500).json({
      error: 'Kalshi API error - ' + error.message,
      games: [],
    });
  }
});

// ── CS2 market endpoints ──────────────────────────────────────────────────────

// GET /api/cs2/kalshi — open CS2 match markets from Kalshi (KXCS2GAME series)
app.get('/api/cs2/kalshi', async (req, res) => {
  try {
    const evRes = await fetch(
      `${KALSHI_ELECTIONS}/events?status=open&series_ticker=KXCS2GAME&limit=100`,
      fetchOptions
    );
    const { events = [] } = await evRes.json();
    const games = [];
    await Promise.all(events.map(async (event) => {
      try {
        // Parse "Team1 vs. Team2" from event title
        const vsMatch = (event.title || '').match(/^(.+?)\s+vs\.?\s+(.+?)(?:\s+\(|$)/i);
        if (!vsMatch) return;
        const rawTeam1 = vsMatch[1].trim();
        const rawTeam2 = vsMatch[2].trim();

        const mktRes = await fetch(
          `${KALSHI_ELECTIONS}/markets?event_ticker=${encodeURIComponent(event.event_ticker)}&status=open`,
          fetchOptions
        );
        const { markets = [] } = await mktRes.json();
        if (markets.length < 2) return;

        // Match market to team by parsing "Will {team} win..." from market title
        const findMarketForTeam = (teamName) => {
          const normTeam = normalizeCS2Team(teamName);
          return markets.find(m => {
            const titleMatch = (m.title || '').match(/^Will (.+?) win/i);
            if (!titleMatch) return false;
            return normalizeCS2Team(titleMatch[1].trim()) === normTeam;
          });
        };

        const market1 = findMarketForTeam(rawTeam1);
        const market2 = findMarketForTeam(rawTeam2);
        if (!market1 || !market2) return;

        const norm1 = normalizeCS2Team(rawTeam1);
        const norm2 = normalizeCS2Team(rawTeam2);
        // Alphabetical sort for consistent game key
        const [awayNorm, homeNorm, awayM, homeM] = norm1 < norm2
          ? [norm1, norm2, market1, market2]
          : [norm2, norm1, market2, market1];

        const awayOdds = parseFloat(awayM.yes_bid_dollars ?? awayM.last_price_dollars ?? 0.5);
        const homeOdds = parseFloat(homeM.yes_bid_dollars ?? homeM.last_price_dollars ?? 0.5);
        const key = `${awayNorm}-${homeNorm}`;
        const game = {
          id: event.event_ticker,
          awayTeam: awayNorm,
          homeTeam: homeNorm,
          awayOdds: Math.round(awayOdds * 100) / 100,
          homeOdds: Math.round(homeOdds * 100) / 100,
          startDate: event.start_time || event.last_updated_ts,
          url: `https://kalshi.com/markets/${event.event_ticker}`,
          label: 'Moneyline',
          marketTickerAway: awayM.ticker,
          marketTickerHome: homeM.ticker,
          marketTicker: homeM.ticker,
          sport: 'cs2',
          displayName: event.title,
        };
        kalshiGamesState.set(key, game);
        if (awayM.ticker) kalshiTickerToKey.set(awayM.ticker, key);
        if (homeM.ticker) kalshiTickerToKey.set(homeM.ticker, key);
        games.push(game);
      } catch (_) {}
    }));
    res.json({ games });
  } catch (err) {
    console.error('CS2 Kalshi error:', err.message);
    res.status(500).json({ error: err.message, games: [] });
  }
});

// GET /api/cs2/polymarket — open CS2 match markets from Polymarket (counter-strike tag)
app.get('/api/cs2/polymarket', async (req, res) => {
  try {
    const evRes = await fetch(
      'https://gamma-api.polymarket.com/events?tag_slug=counter-strike&closed=false&limit=50',
      fetchOptions
    );
    const events = await evRes.json();
    const games = [];
    await Promise.all((Array.isArray(events) ? events : []).map(async (event) => {
      try {
        if (event.closed || event.active === false) return;
        const market = findMoneylineMarket(event.markets);
        if (!market) return;
        const outcomes = parseOutcomes(market?.outcomes ?? market?.outcome);
        if (outcomes.length !== 2) return;
        // Skip yes/no markets (not match markets)
        if (outcomes.some(o => /^(yes|no)$/i.test(o))) return;

        const prices = parseOutcomePrices(market?.outcomePrices ?? market?.outcome_prices);
        const price1 = parseFloat(prices[0]) || 0.5;
        const price2 = parseFloat(prices[1]) || 0.5;

        const norm1 = normalizeCS2Team(outcomes[0]);
        const norm2 = normalizeCS2Team(outcomes[1]);
        // Alphabetical sort for consistent game key
        const [awayNorm, homeNorm, awayOdds, homeOdds, awayOutIdx, homeOutIdx] = norm1 < norm2
          ? [norm1, norm2, price1, price2, 0, 1]
          : [norm2, norm1, price2, price1, 1, 0];

        const key = `${awayNorm}-${homeNorm}`;
        const game = {
          id: event.id || event.slug,
          awayTeam: awayNorm,
          homeTeam: homeNorm,
          awayOdds: Math.round(awayOdds * 100) / 100,
          homeOdds: Math.round(homeOdds * 100) / 100,
          startDate: event.startDate || event.start_date,
          url: `https://polymarket.com/event/${event.slug}`,
          label: 'Moneyline',
          sport: 'cs2',
          displayName: event.title,
        };

        // Fetch CLOB token IDs
        const conditionId = market?.conditionId ?? market?.condition_id ?? event?.conditionId ?? event?.condition_id;
        if (conditionId) {
          const clobMarket = await fetchClobMarket(conditionId);
          if (clobMarket?.tokens?.length >= 2) {
            game.tokenIdAway = normalizePolyTokenId(clobMarket.tokens[awayOutIdx]?.token_id ?? clobMarket.tokens[awayOutIdx]?.tokenId);
            game.tokenIdHome = normalizePolyTokenId(clobMarket.tokens[homeOutIdx]?.token_id ?? clobMarket.tokens[homeOutIdx]?.tokenId);
            game.tickSize = String(clobMarket.minimum_tick_size ?? clobMarket.min_tick_size ?? market?.minimum_tick_size ?? '0.01');
            game.negRisk = Boolean(clobMarket.neg_risk ?? market?.neg_risk);
          }
        }
        if (!game.tokenIdAway || !game.tokenIdHome) {
          const tokenArr = parseMarketTokenIds(market, event, awayNorm, homeNorm);
          if (tokenArr.length >= 2) { game.tokenIdAway = tokenArr[0]; game.tokenIdHome = tokenArr[1]; }
          game.tickSize = game.tickSize || String(market?.minimum_tick_size ?? '0.01');
          game.negRisk = game.negRisk ?? Boolean(market?.neg_risk);
        }

        polyGamesState.set(key, game);
        const newToks = [];
        if (game.tokenIdAway) { polyTokenToKey.set(String(game.tokenIdAway), key); if (!subscribedPolyTokenIds.has(String(game.tokenIdAway))) newToks.push(String(game.tokenIdAway)); }
        if (game.tokenIdHome) { polyTokenToKey.set(String(game.tokenIdHome), key); if (!subscribedPolyTokenIds.has(String(game.tokenIdHome))) newToks.push(String(game.tokenIdHome)); }
        if (newToks.length) subscribePolymarketTokens(newToks);
        games.push(game);
      } catch (_) {}
    }));
    res.json({ games });
  } catch (err) {
    console.error('CS2 Polymarket error:', err.message);
    res.status(500).json({ error: err.message, games: [] });
  }
});

// ---------- Arbitrage (design: docs/ARBITRAGE_DESIGN.md) ----------
const ARB_MIN_PROFIT_USD = Number(process.env.ARB_MIN_PROFIT_USD) || 0.50;
const ARB_MAX_STAKE_USD = Number(process.env.ARB_MAX_STAKE_USD) || 50;
const ARB_MAX_STAKE_PER_ARB_USD = Number(process.env.ARB_MAX_STAKE_PER_ARB_USD) || ARB_MAX_STAKE_USD; // cap per arb so you can place multiple
const ARB_RESERVE_POLY_USD = Number(process.env.ARB_RESERVE_POLY_USD) || 0;
const ARB_RESERVE_KAL_USD = Number(process.env.ARB_RESERVE_KAL_USD) || 0;
const KALSHI_TAKER_FEE = 0.07; // 0.07 * C * P * (1-P) per contract

// ── Value Betting Engine: Sharp Odds ─────────────────────────────────────────
const ODDS_API_KEY = process.env.ODDS_API_KEY || '';
const ODDS_API_BASE = 'https://api.the-odds-api.com/v4/sports/basketball_nba/odds/';
const ODDS_API_BOOKMAKERS = 'draftkings,fanduel,betmgm';
const SHARP_CACHE_TTL_MS = 300_000; // 5 min cache to conserve API quota
const VALUE_MIN_EDGE = Number(process.env.VALUE_MIN_EDGE) || 0.03;
const VALUE_MAX_POSITION_USD = Number(process.env.VALUE_MAX_POSITION_USD) || 20;
const VALUE_ORDER_SIZE_USD = Number(process.env.VALUE_ORDER_SIZE_USD) || 2;

let sharpOddsCache = null;
let sharpOddsFetchInFlight = false;

function americanToProb(americanOdds) {
  const o = Number(americanOdds);
  if (!Number.isFinite(o)) return null;
  return o > 0 ? 100 / (o + 100) : Math.abs(o) / (Math.abs(o) + 100);
}

const ODDS_API_TEAM_MAP = {
  'Atlanta Hawks': 'ATL', 'Boston Celtics': 'BOS', 'Brooklyn Nets': 'BKN',
  'Charlotte Hornets': 'CHA', 'Chicago Bulls': 'CHI', 'Cleveland Cavaliers': 'CLE',
  'Dallas Mavericks': 'DAL', 'Denver Nuggets': 'DEN', 'Detroit Pistons': 'DET',
  'Golden State Warriors': 'GSW', 'Houston Rockets': 'HOU', 'Indiana Pacers': 'IND',
  'LA Clippers': 'LAC', 'Los Angeles Lakers': 'LAL', 'Memphis Grizzlies': 'MEM',
  'Miami Heat': 'MIA', 'Milwaukee Bucks': 'MIL', 'Minnesota Timberwolves': 'MIN',
  'New Orleans Pelicans': 'NOP', 'New York Knicks': 'NYK', 'Oklahoma City Thunder': 'OKC',
  'Orlando Magic': 'ORL', 'Philadelphia 76ers': 'PHI', 'Phoenix Suns': 'PHX',
  'Portland Trail Blazers': 'POR', 'Sacramento Kings': 'SAC', 'San Antonio Spurs': 'SAS',
  'Toronto Raptors': 'TOR', 'Utah Jazz': 'UTA', 'Washington Wizards': 'WAS',
};

async function fetchSharpOdds() {
  if (sharpOddsFetchInFlight) return sharpOddsCache?.games || new Map();
  if (sharpOddsCache && Date.now() - sharpOddsCache.fetchedAt < SHARP_CACHE_TTL_MS) {
    return sharpOddsCache.games;
  }
  if (!ODDS_API_KEY) {
    console.warn('[ValueEngine] ODDS_API_KEY not set');
    return new Map();
  }
  sharpOddsFetchInFlight = true;
  try {
    const url = `${ODDS_API_BASE}?apiKey=${encodeURIComponent(ODDS_API_KEY)}&regions=us&markets=h2h&bookmakers=${ODDS_API_BOOKMAKERS}&oddsFormat=american`;
    const res = await fetch(url, fetchOptions);
    if (!res.ok) {
      console.warn(`[ValueEngine] Odds API ${res.status}`);
      return sharpOddsCache?.games || new Map();
    }
    const events = await res.json();
    const games = new Map();
    for (const event of events) {
      const away = ODDS_API_TEAM_MAP[event.away_team] || event.away_team?.slice(0,3).toUpperCase();
      const home = ODDS_API_TEAM_MAP[event.home_team] || event.home_team?.slice(0,3).toUpperCase();
      if (!away || !home) continue;
      const probSums = { away: 0, home: 0 };
      let count = 0;
      for (const bm of event.bookmakers || []) {
        const h2h = (bm.markets || []).find((m) => m.key === 'h2h');
        if (!h2h) continue;
        const awayOut = h2h.outcomes?.find((o) => ODDS_API_TEAM_MAP[o.name] === away || o.name === event.away_team);
        const homeOut = h2h.outcomes?.find((o) => ODDS_API_TEAM_MAP[o.name] === home || o.name === event.home_team);
        if (!awayOut || !homeOut) continue;
        const ap = americanToProb(awayOut.price);
        const hp = americanToProb(homeOut.price);
        if (ap == null || hp == null) continue;
        const total = ap + hp;
        probSums.away += ap / total;
        probSums.home += hp / total;
        count++;
      }
      if (!count) continue;
      games.set(gameKey(away, home), {
        away: Math.round((probSums.away / count) * 1000) / 1000,
        home: Math.round((probSums.home / count) * 1000) / 1000,
        bookmakerCount: count, awayTeam: away, homeTeam: home,
      });
    }
    sharpOddsCache = { fetchedAt: Date.now(), games };
    console.log(`[ValueEngine] Sharp odds fetched for ${games.size} games`);
    return games;
  } catch (err) {
    console.error('[ValueEngine] fetchSharpOdds error:', err.message);
    return sharpOddsCache?.games || new Map();
  } finally { sharpOddsFetchInFlight = false; }
}

function detectValueOpportunities(polyGames, sharpOddsMap, minEdge = VALUE_MIN_EDGE) {
  const opportunities = [];
  for (const poly of polyGames) {
    const key = gameKey(poly.awayTeam, poly.homeTeam);
    const sharp = sharpOddsMap.get(key);
    if (!sharp) continue;
    // Engine only BUYs → fill at the ASK, not the mid/bid. Use bestAsk when WS-overlaid;
    // fall back to (bid + 1 tick) when ask is missing. Using mid/bid would overstate the
    // edge by half-spread and the resulting limit order wouldn't fill.
    for (const [side, tokenId, askField, midField, sharpField, label] of [
      ['away', poly.tokenIdAway, poly.awayAsk, poly.awayOdds, sharp.away, `${poly.awayTeam}`],
      ['home', poly.tokenIdHome, poly.homeAsk, poly.homeOdds, sharp.home, `${poly.homeTeam}`],
    ]) {
      if (!tokenId) continue;
      // Execution price: ask if available, else mid + 1 tick (conservative — assume ask is one above mid).
      const execPrice = askField != null ? Number(askField) : (Number(midField) || 0.5) + 0.01;
      const polyProb = Math.max(0.01, Math.min(0.99, execPrice));
      const sharpProb = sharpField;
      const edge = sharpProb - polyProb; // edge against price we'd actually pay
      if (edge < minEdge) continue;
      opportunities.push({
        gameKey: key, awayTeam: poly.awayTeam, homeTeam: poly.homeTeam,
        side, label,
        polyProb,                                // execution price (ask) — used for orders
        polyMid: Number(midField) || null,       // reference mid, for diagnostics
        polyAsk: askField != null ? Number(askField) : null,
        sharpProb,
        edge: Math.round(edge * 1000) / 1000,
        edgePct: Math.round(edge * 10000) / 100,
        polyTokenId: tokenId,
        polyTickSize: poly.tickSize || '0.01',
        polyNegRisk: Boolean(poly.negRisk),
        bookmakerCount: sharp.bookmakerCount,
      });
    }
  }
  return opportunities.sort((a, b) => b.edge - a.edge);
}

// ── Auto-Arb Engine ───────────────────────────────────────────────────────────

// Direct Polymarket order placement — no req/res, takes credentials directly.
async function placePolymarketOrderDirect(polyCreds, polyFunder, tokenId, price, size, tickSize = '0.01', negRisk = false, side = 'BUY') {
  const { ClobClient, Side, OrderType, AssetType } = await import('@polymarket/clob-client');
  const { Wallet } = await import('ethers');
  const wallet = new Wallet(String(polyCreds.privateKey).trim());
  const apiCreds = {
    key: String(polyCreds.apiKey ?? '').trim(),
    secret: String(polyCreds.secret ?? '').trim(),
    passphrase: String(polyCreds.passphrase ?? '').trim(),
  };
  const funder = (polyFunder && /^0x[a-fA-F0-9]{40}$/.test(String(polyFunder)))
    ? String(polyFunder).trim().toLowerCase()
    : wallet.address.toLowerCase();
  const isProxy = funder !== wallet.address.toLowerCase();
  const tokenIdStr = normalizePolyTokenId(tokenId) || String(tokenId).trim();
  // For Magic/Gmail signups (Gnosis Safe proxy), sigType=2 is the right one — try it FIRST
  // when funder is a proxy. For MetaMask-created Polymarket Proxies, sigType=1 works.
  // EOA-only goes last as a fallback.
  const attempts = isProxy
    ? [{ sigType: 2, funderAddr: funder }, { sigType: 1, funderAddr: funder }, { sigType: 0, funderAddr: wallet.address }]
    : [{ sigType: 0, funderAddr: wallet.address }, { sigType: 1, funderAddr: wallet.address }, { sigType: 2, funderAddr: wallet.address }];
  // Simulate market orders with FOK at aggressive prices — no orderbook fetch needed (faster).
  // BUY: use 0.99 (max price, fills against any seller). SELL: use 0.01 (min price, fills against any buyer).
  // FOK ensures full fill or nothing — no partial resting orders.
  let effectivePrice;
  if (String(side).toUpperCase() === 'SELL') {
    effectivePrice = 0.01; // sell at any price — FOK matches against best bid
  } else {
    effectivePrice = 0.99; // buy at any price — FOK matches against best ask
  }

  let lastErr = null;
  const apiKeyMasked = apiCreds.key ? `${apiCreds.key.slice(0, 8)}...` : '<empty>';
  console.log(`[poly-order] starting: token=${tokenIdStr.slice(0, 12)}... side=${side} size=${size} negRisk=${negRisk} apiKey=${apiKeyMasked} EOA=${wallet.address.toLowerCase()}`);
  for (const { sigType, funderAddr } of attempts) {
    const client = new ClobClient('https://clob.polymarket.com', 137, wallet, apiCreds, sigType, funderAddr);
    try { await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL }); } catch (_) {}
    let ts = tickSize;
    try { const mt = await client.getTickSize(tokenIdStr); if (mt != null) ts = polyTickSizeSupported(String(mt)); } catch (_) {}
    const priceRounded = roundPriceToTick(effectivePrice, ts);
    const sideVal = String(side).toUpperCase() === 'SELL' ? Side.SELL : Side.BUY;
    const userOrder = { tokenID: tokenIdStr, price: priceRounded, size: Number(size), side: sideVal };
    console.log(`[poly-order]   attempt sigType=${sigType} funder=${String(funderAddr).toLowerCase()}`);
    try {
      const response = await client.createAndPostOrder(userOrder, { negRisk, tickSize: ts }, OrderType.FOK);
      const responseErr = response?.error || response?.errorMsg;
      if (responseErr) {
        lastErr = new Error(String(responseErr));
        console.log(`[poly-order]     RESP ERROR: ${responseErr}`);
        if (/invalid signature|order_version_mismatch|not authorized/i.test(String(responseErr))) continue;
        throw lastErr;
      }
      const matched = Number(response?.size_matched ?? response?.sizeMatched ?? response?.filled_size ?? -1);
      if (matched === 0) {
        console.log(`[poly-order]     FOK no fill (price moved)`);
        throw new Error('Polymarket FOK: order not filled (price moved)');
      }
      console.log(`[poly-order]     OK matched=${matched}`);
      return response;
    } catch (err) {
      lastErr = err;
      const errMsg = err?.response?.data?.error || err?.message || '';
      const status = err?.response?.status || '?';
      console.log(`[poly-order]     CATCH (status ${status}): ${errMsg}`);
      if (err?.response?.status === 401 || err?.response?.status === 403
          || /invalid signature|order_version_mismatch|not authorized/i.test(errMsg)) continue;
      throw err;
    }
  }
  console.log(`[poly-order] all attempts failed; final error: ${lastErr?.message}`);
  throw lastErr || new Error('Polymarket order failed');
}

// Direct Kalshi order placement — no req/res, takes credentials directly.
async function placeKalshiOrderDirect(kalshiCreds, ticker, side, count, yesPriceCents, action = 'buy') {
  const path = '/trade-api/v2/portfolio/orders';
  const baseUrl = process.env.KALSHI_API_BASE || 'https://api.elections.kalshi.com';
  const timestamp = String(Date.now());
  const signature = kalshiSign(kalshiCreds.privateKey, timestamp, 'POST', path);
  // Use aggressive limit price to simulate market order (Kalshi has no market order type).
  // BUY: 99¢ (max), SELL: 1¢ (min) — fills instantly against best available.
  const isSell = action === 'sell';
  const aggressivePrice = isSell ? 1 : 99;
  const body = {
    ticker,
    action: action,
    side: side.toLowerCase() === 'yes' ? 'yes' : 'no',
    count: Number(count),
    type: 'limit',
    yes_price: aggressivePrice,
    client_order_id: crypto.randomUUID(),
  };
  const orderRes = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'KALSHI-ACCESS-KEY': kalshiCreds.apiKeyId,
      'KALSHI-ACCESS-TIMESTAMP': timestamp,
      'KALSHI-ACCESS-SIGNATURE': signature,
    },
    body: JSON.stringify(body),
  });
  const data = await orderRes.json().catch(() => ({}));
  if (!orderRes.ok) {
    const errMsg = typeof data.error === 'string' ? data.error : data.message || 'Kalshi order failed';
    throw new Error(errMsg);
  }
  return data;
}

// Extract the actual fill price from a Polymarket FOK response.
// Uses (taker_amount / size_matched) when both are present, else falls back to maker_amount math.
// Returns null if we can't compute it from the response shape.
function extractPolyFillPrice(polyResp) {
  if (!polyResp) return null;
  const matched = Number(polyResp.size_matched ?? polyResp.sizeMatched ?? polyResp.filled_size ?? 0);
  if (!matched) return null;
  const taker = Number(polyResp.taker_amount ?? polyResp.takerAmount ?? 0);
  if (taker > 0) return taker / matched;
  // Fallback: makingAmount / matchedAmount (some response shapes)
  const making = Number(polyResp.making_amount ?? polyResp.makingAmount ?? 0);
  if (making > 0) return making / matched;
  return null;
}
// Extract the actual fill price (in cents) from a Kalshi order response.
// Polymarket allowance reader. Tries all sigTypes and picks the highest allowance found
// (sigType-dependent CLOB responses can disagree — Gmail/Magic accounts use Gnosis Safe via
// sigType=2 while MetaMask accounts use Polymarket Proxy via sigType=1). Returns
// { balanceUsdc, allowanceUsdc, ok, hint, walletAddress } or null on error.
async function checkPolyAllowance(credsPoly, polyFunder) {
  if (!credsPoly?.privateKey) return null;
  try {
    const { ClobClient, AssetType } = await import('@polymarket/clob-client');
    const { Wallet } = await import('ethers');
    const wallet = new Wallet(String(credsPoly.privateKey).trim());
    const apiCreds = {
      key: String(credsPoly.apiKey ?? '').trim(),
      secret: String(credsPoly.secret ?? '').trim(),
      passphrase: String(credsPoly.passphrase ?? '').trim(),
    };
    const funder = (polyFunder && /^0x[a-fA-F0-9]{40}$/.test(String(polyFunder)))
      ? String(polyFunder).trim().toLowerCase()
      : wallet.address.toLowerCase();
    const isProxy = funder !== wallet.address.toLowerCase();
    const sigOrder = isProxy ? [2, 1, 0] : [0, 1, 2];

    let bestBalance = 0;
    let bestAllowance = 0;
    let lastErr = null;
    for (const sigType of sigOrder) {
      try {
        const client = new ClobClient('https://clob.polymarket.com', 137, wallet, apiCreds, sigType, funder);
        const bal = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
        const balanceUsdc = Number(BigInt(bal?.balance ?? 0)) / 1e6;
        const allowanceUsdc = Number(BigInt(bal?.allowance ?? 0)) / 1e6;
        // Take the maximum across sigTypes — different sigTypes may map to different on-chain
        // contract pairs (Safe vs Proxy) and only the right one will report real allowance.
        if (balanceUsdc > bestBalance) bestBalance = balanceUsdc;
        if (allowanceUsdc > bestAllowance) bestAllowance = allowanceUsdc;
      } catch (err) {
        lastErr = err;
      }
    }
    if (bestBalance === 0 && lastErr) {
      return { error: lastErr.message, ok: false, hint: `Could not read balance: ${lastErr.message}` };
    }
    const ok = bestBalance === 0 || bestAllowance >= bestBalance;
    const hint = ok
      ? null
      : (bestAllowance === 0
          ? 'USDC allowance reads 0 across all sigTypes. If you can trade on polymarket.com this is likely a CLOB cache lag — try anyway and we will let the order layer decide.'
          : `USDC allowance (${bestAllowance.toFixed(2)}) < balance (${bestBalance.toFixed(2)}).`);
    return { balanceUsdc: bestBalance, allowanceUsdc: bestAllowance, ok, hint, walletAddress: funder };
  } catch (err) {
    console.error('[allowance-check] error:', err.message);
    return { error: err.message, ok: false, hint: `Could not verify allowance: ${err.message}` };
  }
}

function extractKalshiFillCents(kalshiResp) {
  const order = kalshiResp?.order ?? kalshiResp ?? {};
  // Real fill price = taker_fill_cost / taker_fill_count. Both are in the order response when
  // an aggressive limit order matches against resting liquidity (our usual path).
  const cost = Number(order.taker_fill_cost);
  const count = Number(order.taker_fill_count);
  if (Number.isFinite(cost) && Number.isFinite(count) && count > 0) {
    return Math.round((cost / count) * 10) / 10; // 1 decimal place
  }
  // Fallback for older response shapes / rare API variants.
  const yes = Number(order.fill_price ?? order.avg_fill_price);
  if (Number.isFinite(yes) && yes > 0 && yes < 100) return yes;
  // Last resort: yes_price (just the limit we sent — overstates the price for BUYs at 99c, etc.)
  // Only return this if the order clearly executed.
  if (String(order.status).toLowerCase() === 'executed') {
    const limit = Number(order.yes_price);
    if (Number.isFinite(limit) && limit > 0 && limit < 100) return limit;
  }
  return null;
}

// Execute both legs of an arb in parallel with automatic rollback on partial failure.
// Used by manual /api/arb/execute AND auto-arb engine. Writes a fill record (expected vs
// actual) to arb-fills.log on every call — success, failure, or rollback.
async function executeArb(opp, credsPoly, credsKal, polyFunder) {
  const stakePoly = Number(opp.stakePolyUsd) || 0;
  const polyPrice = Number(opp.polyPrice) || 0.5;
  const polySize = Math.max(1, Math.floor(stakePoly / Math.max(0.01, polyPrice)));
  if (polySize * polyPrice < 1) throw new Error(`Stake too small: $${(polySize * polyPrice).toFixed(2)} (min $1 notional)`);
  const kalshiCount = Math.max(1, Number(opp.kalshiCount) || 1);
  const kalshiSide = opp.kalshiSide || 'yes';
  const kalshiPriceCents = Math.min(99, Math.max(1, Number(opp.kalshiYesPriceCents) || 50));

  const t0 = Date.now();
  // Fire both legs IN PARALLEL — minimizes the window where prices can move between legs.
  // Both functions use aggressive prices (Poly FOK at 0.99, Kalshi limit at 99c) so they
  // either fill immediately and fully, or fail fast.
  const [polySettle, kalSettle] = await Promise.allSettled([
    placePolymarketOrderDirect(
      credsPoly, polyFunder,
      opp.polyTokenId, polyPrice, polySize,
      opp.polyTickSize || '0.01', opp.polyNegRisk || false
    ),
    placeKalshiOrderDirect(credsKal, opp.kalshiTicker, kalshiSide, kalshiCount, kalshiPriceCents),
  ]);
  const elapsedMs = Date.now() - t0;

  const polyOk = polySettle.status === 'fulfilled';
  const kalOk = kalSettle.status === 'fulfilled';
  const polyResult = polyOk ? polySettle.value : null;
  const kalshiResult = kalOk ? kalSettle.value : null;
  const polyError = polyOk ? null : (polySettle.reason?.message || String(polySettle.reason));
  const kalError = kalOk ? null : (kalSettle.reason?.message || String(kalSettle.reason));

  // Extract actual fill prices (the whole point of this logging).
  const polyFillPrice = extractPolyFillPrice(polyResult);
  const kalFillCents = extractKalshiFillCents(kalshiResult);
  const polyDriftCents = (polyFillPrice != null) ? Math.round((polyFillPrice - polyPrice) * 1000) / 10 : null;
  const kalDriftCents = (kalFillCents != null) ? Math.round((kalFillCents - kalshiPriceCents) * 10) / 10 : null;

  // Common log payload
  const logBase = {
    gameKey: opp.gameKey, awayTeam: opp.awayTeam, homeTeam: opp.homeTeam,
    strategy: opp.strategy, strategyLabel: opp.strategyLabel,
    expected: {
      polyPrice, polyShares: polySize, polyNotionalUsd: polySize * polyPrice,
      kalshiYesPriceCents: kalshiPriceCents, kalshiCount,
      netProfitUsd: opp.netProfitUsd,
    },
    actual: {
      polyFillPrice, polyDriftCents, polyOrderId: polyResult?.orderID || polyResult?.id || null,
      kalFillCents, kalDriftCents, kalshiOrderId: kalshiResult?.order?.order_id || kalshiResult?.id || null,
    },
    elapsedMs,
  };

  // ── Both succeeded: normal happy path ────────────────────────────────────
  if (polyOk && kalOk) {
    const historyEntry = {
      id: crypto.randomUUID(), placedAt: Date.now(),
      gameKey: opp.gameKey, awayTeam: opp.awayTeam, homeTeam: opp.homeTeam,
      strategyLabel: opp.strategyLabel, strategy: opp.strategy,
      stakePolyUsd: opp.stakePolyUsd, stakeKalshiUsd: opp.stakeKalshiUsd,
      netProfitUsd: opp.netProfitUsd, polyPrice: opp.polyPrice,
      kalshiYesPriceCents: opp.kalshiYesPriceCents,
      polyOrderId: polyResult?.orderID || polyResult?.id || null,
      kalshiOrderId: kalshiResult?.order?.order_id || kalshiResult?.id || null,
      polyTokenId: opp.polyTokenId, polyTickSize: opp.polyTickSize || '0.01', polyNegRisk: Boolean(opp.polyNegRisk),
      polyShares: polySize,
      polyFillPrice, kalFillCents,                   // ← actual fill prices
      polyDriftCents, kalDriftCents,                 // ← drift vs expected
      kalshiTicker: opp.kalshiTicker, kalshiSide, kalshiCount,
      status: 'placed',
    };
    appendArbHistory(historyEntry);
    autoArbEngine.openPositions.set(historyEntry.id, {
      id: historyEntry.id,
      gameKey: opp.gameKey, awayTeam: opp.awayTeam, homeTeam: opp.homeTeam,
      strategyLabel: opp.strategyLabel, strategy: opp.strategy,
      entryPolyPrice: opp.polyPrice, entryKalshiCents: opp.kalshiYesPriceCents,
      polyShares: polySize, kalshiCount,
      polyTokenId: opp.polyTokenId, polyTickSize: opp.polyTickSize || '0.01', polyNegRisk: opp.polyNegRisk || false,
      kalshiTicker: opp.kalshiTicker, kalshiSide,
      stakePolyUsd: opp.stakePolyUsd, stakeKalshiUsd: opp.stakeKalshiUsd,
      netProfitUsd: opp.netProfitUsd, simulate: false, placedAt: Date.now(),
    });
    appendFillsLog({ ...logBase, status: 'both_filled', positionId: historyEntry.id });
    return { poly: polyResult, kalshi: kalshiResult, positionId: historyEntry.id };
  }

  // ── Partial failure: roll back the leg that DID fill ─────────────────────
  // Best-effort flatten. Both rollback functions use aggressive prices to ensure they fill.
  let rollback = null;
  if (polyOk && !kalOk) {
    // Poly filled, Kalshi didn't → sell the Poly position back at market.
    try {
      const sellResult = await placePolymarketOrderDirect(
        credsPoly, polyFunder, opp.polyTokenId, 0.5, polySize,
        opp.polyTickSize || '0.01', opp.polyNegRisk || false, 'SELL'
      );
      const exitPrice = extractPolyFillPrice(sellResult);
      rollback = {
        leg: 'poly',
        action: 'SELL',
        ok: true,
        sharesFlattened: polySize,
        exitFillPrice: exitPrice,
        netLossUsd: (polyFillPrice != null && exitPrice != null) ? Math.round((polyFillPrice - exitPrice) * polySize * 100) / 100 : null,
      };
    } catch (rbErr) {
      rollback = { leg: 'poly', action: 'SELL', ok: false, error: rbErr.message, sharesFlattened: 0 };
    }
  } else if (kalOk && !polyOk) {
    // Kalshi filled, Poly didn't → sell the Kalshi position back at market.
    try {
      const sellResult = await placeKalshiOrderDirect(
        credsKal, opp.kalshiTicker, kalshiSide, kalshiCount, 1, 'sell'
      );
      const exitCents = extractKalshiFillCents(sellResult);
      rollback = {
        leg: 'kalshi',
        action: 'SELL',
        ok: true,
        countFlattened: kalshiCount,
        exitFillCents: exitCents,
        netLossUsd: (kalFillCents != null && exitCents != null) ? Math.round((kalFillCents - exitCents) * kalshiCount) / 100 : null,
      };
    } catch (rbErr) {
      rollback = { leg: 'kalshi', action: 'SELL', ok: false, error: rbErr.message, countFlattened: 0 };
    }
  }

  // ── Log everything and throw a meaningful error ──────────────────────────
  const status = polyOk && kalOk ? 'both_filled'
    : (!polyOk && !kalOk) ? 'both_failed'
    : (polyOk ? 'kalshi_failed' : 'poly_failed');
  appendFillsLog({
    ...logBase,
    status,
    polyError, kalError,
    rollback,
  });

  if (!polyOk && !kalOk) {
    throw new Error(`Both legs failed. Poly: ${polyError}. Kalshi: ${kalError}.`);
  }
  // One leg succeeded, the other failed
  if (rollback?.ok) {
    const lossNote = rollback.netLossUsd != null ? ` Rollback cost: $${rollback.netLossUsd.toFixed(2)}.` : '';
    throw new Error(
      `${polyOk ? 'Kalshi' : 'Polymarket'} leg failed; rolled back the ${polyOk ? 'Poly' : 'Kalshi'} fill.${lossNote} Original error: ${polyOk ? kalError : polyError}`
    );
  }
  // Rollback failed — user has uncovered position, manual intervention needed
  const err = new Error(
    `${polyOk ? 'Kalshi' : 'Polymarket'} leg failed AND rollback of the ${polyOk ? 'Poly' : 'Kalshi'} leg failed. ` +
    `MANUAL ACTION REQUIRED — close the ${polyOk ? 'Poly' : 'Kalshi'} position. ` +
    `Original: ${polyOk ? kalError : polyError}. Rollback: ${rollback?.error || '(none attempted)'}`
  );
  err.leg1Done = true;
  err.polyResult = polyResult;
  err.kalshiResult = kalshiResult;
  err.rollback = rollback;
  throw err;
}

function executeArbSimulated(opp) {
  if (autoArbEngine.simBalancePoly < opp.stakePolyUsd)
    throw new Error(`Sim: insufficient Poly balance ($${autoArbEngine.simBalancePoly.toFixed(2)})`);
  if (autoArbEngine.simBalanceKal < opp.stakeKalshiUsd)
    throw new Error(`Sim: insufficient Kalshi balance ($${autoArbEngine.simBalanceKal.toFixed(2)})`);
  autoArbEngine.simBalancePoly = Math.round((autoArbEngine.simBalancePoly - opp.stakePolyUsd) * 100) / 100;
  autoArbEngine.simBalanceKal  = Math.round((autoArbEngine.simBalanceKal  - opp.stakeKalshiUsd) * 100) / 100;
  const positionId    = crypto.randomUUID();
  const polyOrderId   = 'SIM-' + crypto.randomUUID().slice(0, 8);
  const kalshiOrderId = 'SIM-' + crypto.randomUUID().slice(0, 8);
  appendArbHistory({
    id: positionId, placedAt: Date.now(),
    gameKey: opp.gameKey, awayTeam: opp.awayTeam, homeTeam: opp.homeTeam,
    strategyLabel: opp.strategyLabel,
    stakePolyUsd: opp.stakePolyUsd, stakeKalshiUsd: opp.stakeKalshiUsd,
    netProfitUsd: opp.netProfitUsd, polyPrice: opp.polyPrice,
    kalshiYesPriceCents: opp.kalshiYesPriceCents,
    polyOrderId, kalshiOrderId,
    status: 'simulated',
  });
  autoArbEngine.openPositions.set(positionId, {
    id: positionId,
    gameKey: opp.gameKey, awayTeam: opp.awayTeam, homeTeam: opp.homeTeam,
    strategyLabel: opp.strategyLabel, strategy: opp.strategy,
    entryPolyPrice: opp.polyPrice, entryKalshiCents: opp.kalshiYesPriceCents,
    polyShares: Math.max(1, Math.floor(opp.stakePolyUsd / opp.polyPrice)),
    kalshiCount: opp.kalshiCount,
    polyTokenId: opp.polyTokenId, polyTickSize: opp.polyTickSize || '0.01', polyNegRisk: opp.polyNegRisk || false,
    kalshiTicker: opp.kalshiTicker, kalshiSide: opp.kalshiSide || 'yes',
    stakePolyUsd: opp.stakePolyUsd, stakeKalshiUsd: opp.stakeKalshiUsd,
    netProfitUsd: opp.netProfitUsd, simulate: true, placedAt: Date.now(),
  });
  return { positionId, polyOrderId, kalshiOrderId };
}

const autoArbEngine = {
  running: false,
  simulate: false,
  sport: 'nba',             // 'nba' | 'cs2' | 'both'
  simBalancePoly: 1000,
  simBalanceKal: 1000,
  maxStakeUsd: ARB_MAX_STAKE_USD,
  credsPoly: null,
  credsKal: null,
  polyFunder: null,
  cooldowns: new Map(),   // gameKey → lastPlacedAt ms
  cooldownMs: 60000,
  sseClients: new Set(),
  stats: { placed: 0, failed: 0, totalProfitUsd: 0 },
  startedAt: null,
  _priceUpdatePending: false,
  openPositions: new Map(),   // positionId → position object
  exitThreshold: 1.00,        // sell both legs when currentPolyPrice + currentKalshiPrice >= this
  _exitCheckPending: false,
  _exitIntervalId: null,      // fallback 10s polling interval
  _cs2RefreshId: null,        // periodic CS2 market refresh when sport is cs2/both
  _orderMonitorId: null,      // periodic stale-order cleanup
  orderTimeoutMs: 60000,      // cancel unfilled orders after 60s
};

function broadcastAutoArbEvent(type, data) {
  const payload = `data: ${JSON.stringify({ type, ...data, ts: Date.now() })}\n\n`;
  for (const client of autoArbEngine.sseClients) {
    try { client.write(payload); } catch (_) { autoArbEngine.sseClients.delete(client); }
  }
}

// Broadcast live P&L for open positions to all SSE clients
function broadcastLivePnL() {
  if (autoArbEngine.openPositions.size === 0 || autoArbEngine.sseClients.size === 0) return;
  const updates = [];
  for (const [id, pos] of autoArbEngine.openPositions) {
    const polyGame = polyGamesState.get(pos.gameKey);
    const kalshiGame = kalshiGamesState.get(pos.gameKey);
    if (!polyGame && !kalshiGame) continue;
    const currentPolyPrice = pos.strategy === 1
      ? (polyGame?.homeOdds ?? pos.entryPolyPrice)
      : (polyGame?.awayOdds ?? pos.entryPolyPrice);
    const currentKalshiPrice = pos.strategy === 1
      ? (kalshiGame?.awayOdds ?? (pos.entryKalshiCents / 100))
      : (kalshiGame?.homeOdds ?? (pos.entryKalshiCents / 100));
    const livePnl = Math.round(
      ((currentPolyPrice - pos.entryPolyPrice) * (pos.polyShares || 0) +
       (currentKalshiPrice - pos.entryKalshiCents / 100) * (pos.kalshiCount || 0)) * 100
    ) / 100;
    updates.push({
      positionId: id,
      currentPolyPrice: Math.round(currentPolyPrice * 100) / 100,
      currentKalshiCents: Math.round(currentKalshiPrice * 100),
      livePnl,
      sumPrices: Math.round((currentPolyPrice + currentKalshiPrice) * 100) / 100,
    });
  }
  if (updates.length) broadcastAutoArbEvent('live_pnl', { positions: updates });
}

// Called on every WS price update. Debounced to max once per 200ms.
function onPriceUpdate() {
  // Always broadcast live P&L and check early exits if we have open positions
  if (autoArbEngine.openPositions.size > 0) {
    if (!autoArbEngine._exitCheckPending) {
      autoArbEngine._exitCheckPending = true;
      setTimeout(async () => {
        autoArbEngine._exitCheckPending = false;
        await checkEarlyExits();
        broadcastLivePnL();
      }, 200);
    }
  }
  if (!autoArbEngine.running) return;
  if (!autoArbEngine._priceUpdatePending) {
    autoArbEngine._priceUpdatePending = true;
    setTimeout(runAutoArbCheck, 200);
  }
}

async function runAutoArbCheck() {
  autoArbEngine._priceUpdatePending = false;
  if (!autoArbEngine.running) return;
  const sport = autoArbEngine.sport || 'nba';
  const sportFilter = (g) => sport === 'both' || (g.sport || 'nba') === sport;
  const polyGames = [...polyGamesState.values()].filter(g => g.tokenIdHome && g.tokenIdAway && sportFilter(g));
  const kalshiGames = [...kalshiGamesState.values()].filter(sportFilter);
  if (!polyGames.length || !kalshiGames.length) return;
  const opps = detectArbOpportunities(polyGames, kalshiGames, null, autoArbEngine.maxStakeUsd);
  for (const opp of opps) {
    const lastPlaced = autoArbEngine.cooldowns.get(opp.gameKey);
    if (lastPlaced && Date.now() - lastPlaced < autoArbEngine.cooldownMs) continue;
    autoArbEngine.cooldowns.set(opp.gameKey, Date.now());
    broadcastAutoArbEvent('attempting', { gameKey: opp.gameKey, strategyLabel: opp.strategyLabel, netProfitUsd: opp.netProfitUsd, simulate: autoArbEngine.simulate });
    try {
      let orderIds = { polyOrderId: null, kalshiOrderId: null, positionId: null };
      if (autoArbEngine.simulate) {
        const r = executeArbSimulated(opp);
        orderIds.polyOrderId   = r.polyOrderId;
        orderIds.kalshiOrderId = r.kalshiOrderId;
        orderIds.positionId    = r.positionId;
      } else {
        const r = await executeArb(opp, autoArbEngine.credsPoly, autoArbEngine.credsKal, autoArbEngine.polyFunder);
        orderIds.polyOrderId   = r?.poly?.orderID || r?.poly?.id || null;
        orderIds.kalshiOrderId = r?.kalshi?.order?.order_id || r?.kalshi?.id || null;
        orderIds.positionId    = r?.positionId || null;
      }
      autoArbEngine.stats.placed++;
      autoArbEngine.stats.totalProfitUsd = Math.round((autoArbEngine.stats.totalProfitUsd + opp.netProfitUsd) * 100) / 100;
      broadcastAutoArbEvent('placed', {
        positionId: orderIds.positionId,
        gameKey: opp.gameKey, awayTeam: opp.awayTeam, homeTeam: opp.homeTeam,
        strategyLabel: opp.strategyLabel, netProfitUsd: opp.netProfitUsd,
        stakePolyUsd: opp.stakePolyUsd, stakeKalshiUsd: opp.stakeKalshiUsd,
        polyPrice: opp.polyPrice, kalshiYesPriceCents: opp.kalshiYesPriceCents,
        polyOrderId: orderIds.polyOrderId, kalshiOrderId: orderIds.kalshiOrderId,
        polyUrl: opp.polyUrl || '', kalshiUrl: opp.kalshiUrl || '',
        simulate: autoArbEngine.simulate,
        simBalancePoly: autoArbEngine.simBalancePoly,
        simBalanceKal: autoArbEngine.simBalanceKal,
        stats: autoArbEngine.stats,
      });
      console.log(`[AutoArb${autoArbEngine.simulate ? ' SIM' : ''}] Placed: ${opp.strategyLabel} +$${opp.netProfitUsd}`);
    } catch (err) {
      autoArbEngine.stats.failed++;
      broadcastAutoArbEvent('failed', { gameKey: opp.gameKey, error: err.message, leg1Done: err.leg1Done || false, simulate: autoArbEngine.simulate });
      console.error('[AutoArb] Failed:', err.message);
    }
    break; // one arb per price-update cycle to avoid over-trading
  }
}

async function checkEarlyExits() {
  if (autoArbEngine.openPositions.size === 0) return;
  if (!autoArbEngine.credsPoly || !autoArbEngine.credsKal) return; // need creds to sell
  for (const [positionId, pos] of autoArbEngine.openPositions) {
    const polyGame   = polyGamesState.get(pos.gameKey);
    const kalshiGame = kalshiGamesState.get(pos.gameKey);
    if (!polyGame || !kalshiGame) continue;

    // strategy 1 = Home on Poly + Away on Kalshi; strategy 2 = Away on Poly + Home on Kalshi
    const currentPolyPrice   = pos.strategy === 1
      ? (polyGame.homeOdds   ?? pos.entryPolyPrice)
      : (polyGame.awayOdds   ?? pos.entryPolyPrice);
    const currentKalshiPrice = pos.strategy === 1
      ? (kalshiGame.awayOdds ?? (pos.entryKalshiCents / 100))
      : (kalshiGame.homeOdds ?? (pos.entryKalshiCents / 100));

    if (currentPolyPrice + currentKalshiPrice < autoArbEngine.exitThreshold) continue;

    // Delete immediately to prevent double-exit on the next WS tick
    autoArbEngine.openPositions.delete(positionId);

    const exitPolyPrice   = Math.round(currentPolyPrice * 100) / 100;
    const exitKalshiCents = Math.round(currentKalshiPrice * 100);
    const actualProfitUsd = Math.round(
      ((exitPolyPrice - pos.entryPolyPrice) * pos.polyShares +
       (exitKalshiCents - pos.entryKalshiCents) / 100 * pos.kalshiCount) * 100
    ) / 100;

    try {
      if (pos.simulate) {
        autoArbEngine.simBalancePoly = Math.round(
          (autoArbEngine.simBalancePoly + pos.stakePolyUsd + (exitPolyPrice - pos.entryPolyPrice) * pos.polyShares) * 100
        ) / 100;
        autoArbEngine.simBalanceKal = Math.round(
          (autoArbEngine.simBalanceKal + pos.stakeKalshiUsd + (exitKalshiCents - pos.entryKalshiCents) / 100 * pos.kalshiCount) * 100
        ) / 100;
      } else {
        await placePolymarketOrderDirect(
          autoArbEngine.credsPoly, autoArbEngine.polyFunder,
          pos.polyTokenId, exitPolyPrice, pos.polyShares,
          pos.polyTickSize, pos.polyNegRisk, 'SELL'
        );
        await placeKalshiOrderDirect(
          autoArbEngine.credsKal, pos.kalshiTicker, pos.kalshiSide || 'yes',
          pos.kalshiCount, exitKalshiCents, 'sell'
        );
      }

      autoArbEngine.stats.totalProfitUsd = Math.round((autoArbEngine.stats.totalProfitUsd + actualProfitUsd) * 100) / 100;
      updateArbHistoryEntry(positionId, {
        status: 'closed-early', closedAt: Date.now(),
        exitPolyPrice, exitKalshiCents, actualProfitUsd,
      });
      broadcastAutoArbEvent('exited', {
        positionId,
        gameKey: pos.gameKey, awayTeam: pos.awayTeam, homeTeam: pos.homeTeam,
        strategyLabel: pos.strategyLabel,
        exitPolyPrice, exitKalshiCents, actualProfitUsd,
        simulate: pos.simulate,
        simBalancePoly: autoArbEngine.simBalancePoly,
        simBalanceKal:  autoArbEngine.simBalanceKal,
        stats: autoArbEngine.stats,
      });
      console.log(`[AutoArb${pos.simulate ? ' SIM' : ''}] Early exit: ${pos.strategyLabel} actual=$${actualProfitUsd}`);
    } catch (err) {
      // If balance is 0, position was already sold externally — don't retry
      if (/balance:\s*0,/.test(err.message || '')) {
        updateArbHistoryEntry(positionId, { status: 'sold-early', soldAt: Date.now() });
        console.log(`[AutoArb] Position ${pos.gameKey} already sold externally, removing from tracking`);
      } else {
        autoArbEngine.openPositions.set(positionId, pos); // re-insert to retry next tick
      }
      broadcastAutoArbEvent('exit_failed', {
        positionId, gameKey: pos.gameKey, error: err.message, simulate: pos.simulate,
      });
      console.error('[AutoArb] Early exit failed:', err.message);
    }
  }
}
// ─────────────────────────────────────────────────────────────────────────────

// ── Live Arb Engine ──────────────────────────────────────────────────────────
const arbEngine = {
  running: false, startedAt: null,
  config: {
    orderSizeUsd: 2, intervalMs: 5000, cooldownMs: 60000,
    maxPositionUsd: 20, circuitBreakerPolyUsd: 5, minEdge: 0.03,
  },
  stats: { betsPlaced: 0, betsAttempted: 0, totalStakedUsd: 0, totalEdgeCapture: 0 },
  positionMap: new Map(),
  cooldowns: new Map(),
  sseClients: new Set(),
  timerId: null,
  credsPoly: null,
  polyFunder: null,
};

function broadcastEngineEvent(type, data) {
  const payload = `data: ${JSON.stringify({ type, ...data, ts: Date.now() })}\n\n`;
  for (const client of arbEngine.sseClients) {
    try { client.write(payload); } catch (_) { arbEngine.sseClients.delete(client); }
  }
}

function stopArbEngine(reason = 'stopped') {
  if (arbEngine.timerId) { clearInterval(arbEngine.timerId); arbEngine.timerId = null; }
  arbEngine.running = false;
  broadcastEngineEvent('stopped', { reason, stats: arbEngine.stats });
  console.log('[ArbEngine] stopped:', reason);
}

function computeKellyBetSize(opp, cfg, availPoly, availKal) {
  const impact = arbEngine.marketImpact.get(opp.polyTokenId) || { betsPlaced: 0, estimatedPriceMove: 0 };
  const adjustedPolyPrice = Math.min(0.99, opp.polyPrice + impact.estimatedPriceMove);
  const sum = adjustedPolyPrice + opp.kalshiPrice;
  if (sum >= 1) return null; // arb erased by market impact
  const returnOnCost = (1 - sum) / sum;
  const totalBankroll = availPoly + availKal;
  const kellyStakeTotal = cfg.kellyFraction * returnOnCost * totalBankroll;
  let stakePolyUsd = Math.min(kellyStakeTotal * adjustedPolyPrice / sum, cfg.betSizeUsd, availPoly - cfg.circuitBreakerPolyUsd);
  if (stakePolyUsd < 1) return null;
  const stakeKalshiUsd = (stakePolyUsd * opp.kalshiPrice) / adjustedPolyPrice;
  if (stakeKalshiUsd > availKal - cfg.circuitBreakerKalUsd) return null;
  return { stakePolyUsd, stakeKalshiUsd, adjustedPolyPrice };
}

async function runValueEngineIteration() {
  if (!arbEngine.running) return;
  const { credsPoly, polyFunder, config: cfg } = arbEngine;
  if (!credsPoly) { stopArbEngine('Missing Polymarket credentials'); return; }
  try {
    const base = 'http://localhost:' + (process.env.PORT || 3000);
    const [polyRes, sharpGames] = await Promise.allSettled([
      fetch(`${base}/api/polymarket`),
      fetchSharpOdds(),
    ]);
    const polyData = polyRes.status === 'fulfilled' ? await polyRes.value.json().catch(() => ({})) : {};
    const sharpMap = sharpGames.status === 'fulfilled' ? sharpGames.value : new Map();
    const polyGames = polyData.games || [];

    let polyBal = cfg.orderSizeUsd * 5;
    try {
      const { ClobClient, AssetType } = await import('@polymarket/clob-client');
      const { Wallet } = await import('ethers');
      const wallet = new Wallet(credsPoly.privateKey);
      const apiCreds = { key: credsPoly.apiKey, secret: credsPoly.secret, passphrase: credsPoly.passphrase };
      const funder = polyFunder || wallet.address;
      const isProxy = funder.toLowerCase() !== wallet.address.toLowerCase();
      const client = new ClobClient('https://clob.polymarket.com', 137, wallet, apiCreds, isProxy ? 1 : 0, funder);
      const bal = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
      polyBal = Number(BigInt(bal?.balance ?? 0)) / 1e6;
    } catch (_) {}

    if (polyBal < cfg.circuitBreakerPolyUsd) {
      stopArbEngine(`Circuit breaker: Poly $${polyBal.toFixed(2)}`);
      return;
    }

    const opportunities = detectValueOpportunities(polyGames, sharpMap, cfg.minEdge);
    broadcastEngineEvent('tick', { opportunityCount: opportunities.length, stats: arbEngine.stats, polyBal });

    const now = Date.now();
    for (const opp of opportunities) {
      const posKey = `${opp.gameKey}-${opp.side}`;
      const positionSoFar = arbEngine.positionMap.get(posKey) || 0;
      if (positionSoFar >= cfg.maxPositionUsd) continue;
      const lastOrder = arbEngine.cooldowns.get(posKey) || 0;
      if (now - lastOrder < cfg.cooldownMs) continue;
      const orderUsd = Math.min(cfg.orderSizeUsd, cfg.maxPositionUsd - positionSoFar, polyBal - cfg.circuitBreakerPolyUsd);
      if (orderUsd < 1) continue;
      // Last-mile WS freshness: re-read the live ASK for this token before firing. The opp's snapshot
      // ask may be hundreds of ms old; the WS-pushed game state is current. If the live ask drifted
      // past (sharp - minEdge), bail — the opportunity has already been arbed away.
      const liveGame = polyGamesState.get(opp.gameKey);
      const liveAsk = liveGame
        ? Number(opp.side === 'away' ? liveGame.awayAsk : liveGame.homeAsk)
        : null;
      const snapshotAsk = opp.polyProb;
      const price = (liveAsk != null && Number.isFinite(liveAsk)) ? liveAsk : snapshotAsk;
      if (liveAsk != null && Number.isFinite(liveAsk) && opp.sharpProb != null && (opp.sharpProb - liveAsk) < cfg.minEdge) {
        broadcastEngineEvent('opp_evaporated', { gameKey: opp.gameKey, label: opp.label, liveAsk, snapshotAsk, sharpProb: opp.sharpProb });
        continue;
      }
      const shareCount = Math.max(1, Math.floor(orderUsd / Math.max(0.01, price)));
      arbEngine.stats.betsAttempted++;
      arbEngine.cooldowns.set(posKey, now);
      const betId = crypto.randomUUID();
      broadcastEngineEvent('bet_attempting', { betId, gameKey: opp.gameKey, label: opp.label, orderUsd, price, edge: opp.edgePct, priceSource: liveAsk != null ? 'ws-ask' : 'snapshot-ask' });
      const result = await placePolyOrderDirect(credsPoly, polyFunder, {
        tokenId: opp.polyTokenId, side: 'BUY', price, size: shareCount,
        tickSize: opp.polyTickSize || '0.01', negRisk: opp.polyNegRisk || false,
      });
      if (result?.error) {
        console.log(`[ValueEngine] ✗ ${result.error}`);
        broadcastEngineEvent('bet_failed', { betId, gameKey: opp.gameKey, error: result.error });
        continue;
      }
      const stakeActual = shareCount * price;
      arbEngine.stats.betsPlaced++;
      arbEngine.stats.totalStakedUsd += stakeActual;
      arbEngine.stats.totalEdgeCapture += opp.edge * stakeActual;
      arbEngine.positionMap.set(posKey, positionSoFar + stakeActual);
      appendArbHistory({
        id: betId, placedAt: Date.now(), gameKey: opp.gameKey,
        awayTeam: opp.awayTeam, homeTeam: opp.homeTeam,
        strategyLabel: `Value: ${opp.label} +${opp.edgePct}% edge`,
        stakePolyUsd: Math.round(stakeActual * 100) / 100,
        stakeKalshiUsd: 0, netProfitUsd: Math.round(opp.edge * stakeActual * 100) / 100,
        type: 'value',
      });
      broadcastEngineEvent('bet_placed', {
        betId, gameKey: opp.gameKey, label: opp.label,
        stakeUsd: Math.round(stakeActual * 100) / 100,
        edge: opp.edgePct, positionTotal: arbEngine.positionMap.get(posKey),
        stats: arbEngine.stats,
      });
      console.log(`[ValueEngine] ✓ ${opp.label} $${stakeActual.toFixed(2)} @ ${(price*100).toFixed(0)}¢ edge=${opp.edgePct}%`);
    }
  } catch (err) {
    console.error('[ValueEngine] error:', err.message);
    broadcastEngineEvent('error', { message: err.message });
  }
}

async function placePolyOrderDirect(creds, funder, { tokenId, side, price, size, tickSize, negRisk }) {
  const { ClobClient, Side, OrderType, AssetType } = await import('@polymarket/clob-client');
  const { Wallet } = await import('ethers');
  const wallet = new Wallet(creds.privateKey);
  const apiCreds = { key: creds.apiKey, secret: creds.secret, passphrase: creds.passphrase };
  const effectiveFunder = funder || wallet.address;
  const isProxy = effectiveFunder.toLowerCase() !== wallet.address.toLowerCase();
  // Magic/Gmail signups use Gnosis Safe → sigType=2 first. Then sigType=1 (Poly Proxy), then EOA.
  const attempts = isProxy
    ? [{ sigType: 2, funderAddr: effectiveFunder }, { sigType: 1, funderAddr: effectiveFunder }, { sigType: 0, funderAddr: wallet.address }]
    : [{ sigType: 0, funderAddr: wallet.address }, { sigType: 1, funderAddr: wallet.address }, { sigType: 2, funderAddr: wallet.address }];
  const tokenIdStr = String(tokenId).trim();
  const sideVal = String(side).toUpperCase() === 'SELL' ? Side.SELL : Side.BUY;
  const priceRounded = roundPriceToTick(price, tickSize || '0.01');
  const userOrder = { tokenID: tokenIdStr, price: priceRounded, size: Number(size), side: sideVal };
  let lastErr = null;
  for (const { sigType, funderAddr } of attempts) {
    const client = new ClobClient('https://clob.polymarket.com', 137, wallet, apiCreds, sigType, funderAddr);
    try { await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL }); } catch (_) {}
    try { await client.updateBalanceAllowance({ asset_type: AssetType.CONDITIONAL }); } catch (_) {}
    let ts = tickSize || '0.01';
    try { const mt = await client.getTickSize(tokenIdStr); if (mt != null) ts = polyTickSizeSupported(String(mt)); } catch (_) {}
    userOrder.price = roundPriceToTick(price, ts);
    try {
      const response = await client.createAndPostOrder(userOrder, { negRisk: Boolean(negRisk), tickSize: ts }, OrderType.GTC);
      const responseErr = response?.error || response?.errorMsg;
      if (responseErr) {
        lastErr = new Error(String(responseErr));
        // order_version_mismatch = Magic/Safe account signed as Polymarket Proxy (wrong sigType)
        if (/invalid signature|order_version_mismatch|not authorized/i.test(String(responseErr))) continue;
        return { error: String(responseErr) };
      }
      return response;
    } catch (err) {
      lastErr = err;
      if (/invalid signature|order_version_mismatch|not authorized/i.test(err?.message || '')) continue;
      return { error: err?.message || 'Poly order failed' };
    }
  }
  return { error: lastErr?.message || 'All signature attempts failed' };
}

async function cancelKalshiOrder(creds, orderId) {
  const path = `/trade-api/v2/portfolio/orders/${orderId}`;
  const baseUrl = process.env.KALSHI_API_BASE || 'https://api.elections.kalshi.com';
  const timestamp = String(Date.now());
  const signature = kalshiSign(creds.privateKey, timestamp, 'DELETE', path);
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'DELETE',
    headers: {
      'KALSHI-ACCESS-KEY': creds.apiKeyId,
      'KALSHI-ACCESS-TIMESTAMP': timestamp,
      'KALSHI-ACCESS-SIGNATURE': signature,
    },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || data.message || res.statusText);
  }
  return true;
}

// ── Stale order monitor ───────────────────────────────────────────────────────
// Checks open positions every 30s. Cancels any leg whose order hasn't filled
// within autoArbEngine.orderTimeoutMs. Frees up capital for the next arb.

async function cancelPolymarketOrderDirect(credsPoly, polyFunder, orderId) {
  const { ClobClient } = await import('@polymarket/clob-client');
  const { Wallet } = await import('ethers');
  const wallet = new Wallet(String(credsPoly.privateKey).trim());
  const apiCreds = { key: credsPoly.apiKey ?? '', secret: credsPoly.secret ?? '', passphrase: credsPoly.passphrase ?? '' };
  const funder = (polyFunder && /^0x[a-fA-F0-9]{40}$/.test(String(polyFunder)))
    ? String(polyFunder).trim().toLowerCase() : wallet.address.toLowerCase();
  const isProxy = funder !== wallet.address.toLowerCase();
  for (const sigType of [0, 1, 2]) {
    try {
      const client = new ClobClient('https://clob.polymarket.com', 137, wallet, apiCreds, sigType, isProxy ? funder : wallet.address);
      const result = await client.cancelOrder({ orderID: orderId }).catch(() => client.cancelOrder(orderId));
      if (!result?.error && !result?.errorMsg) return true;
    } catch (_) {}
  }
  return false;
}

async function isPolyOrderFilled(credsPoly, polyFunder, orderId) {
  if (!orderId || orderId.startsWith('SIM-')) return true; // sim orders always "filled"
  try {
    const { ClobClient } = await import('@polymarket/clob-client');
    const { Wallet } = await import('ethers');
    const wallet = new Wallet(String(credsPoly.privateKey).trim());
    const apiCreds = { key: credsPoly.apiKey ?? '', secret: credsPoly.secret ?? '', passphrase: credsPoly.passphrase ?? '' };
    const funder = (polyFunder && /^0x[a-fA-F0-9]{40}$/.test(String(polyFunder)))
      ? String(polyFunder).trim().toLowerCase() : wallet.address.toLowerCase();
    const isProxy = funder !== wallet.address.toLowerCase();
    const client = new ClobClient('https://clob.polymarket.com', 137, wallet, apiCreds, isProxy ? 1 : 0, funder);
    const order = await client.getOrder(orderId);
    // Status 'filled' or 'matched' = done; anything else (resting, open) = not filled
    const status = (order?.status || '').toLowerCase();
    return status === 'filled' || status === 'matched';
  } catch (_) {
    return true; // if we can't check, assume filled to avoid erroneous cancels
  }
}

async function isKalshiOrderFilled(credsKal, orderId) {
  if (!orderId || orderId.startsWith('SIM-')) return true;
  try {
    const path = `/trade-api/v2/portfolio/orders/${orderId}`;
    const baseUrl = process.env.KALSHI_API_BASE || 'https://api.elections.kalshi.com';
    const timestamp = String(Date.now());
    const signature = kalshiSign(credsKal.privateKey, timestamp, 'GET', path);
    const res = await fetch(`${baseUrl}${path}`, {
      headers: {
        'KALSHI-ACCESS-KEY': credsKal.apiKeyId,
        'KALSHI-ACCESS-TIMESTAMP': timestamp,
        'KALSHI-ACCESS-SIGNATURE': signature,
      },
    });
    if (!res.ok) return true;
    const data = await res.json().catch(() => ({}));
    const status = (data?.order?.status || '').toLowerCase();
    return status === 'filled' || status === 'executed';
  } catch (_) {
    return true;
  }
}

async function monitorOpenOrders() {
  if (!autoArbEngine.running || autoArbEngine.simulate) return;
  const now = Date.now();
  const timeout = autoArbEngine.orderTimeoutMs;
  for (const [posId, pos] of autoArbEngine.openPositions) {
    if (pos.simulate || pos.closed) continue;
    const age = now - (pos.placedAt || now);
    if (age < timeout) continue; // not old enough yet

    const [polyFilled, kalshiFilled] = await Promise.all([
      isPolyOrderFilled(autoArbEngine.credsPoly, autoArbEngine.polyFunder, pos.polyOrderId),
      isKalshiOrderFilled(autoArbEngine.credsKal, pos.kalshiOrderId),
    ]);

    if (polyFilled && kalshiFilled) continue; // both filled, nothing to do

    const cancelled = { poly: false, kalshi: false };
    if (!polyFilled && pos.polyOrderId) {
      try {
        await cancelPolymarketOrderDirect(autoArbEngine.credsPoly, autoArbEngine.polyFunder, pos.polyOrderId);
        cancelled.poly = true;
        console.log(`[OrderMonitor] Cancelled stale Poly order ${pos.polyOrderId} for ${pos.gameKey}`);
      } catch (e) {
        console.warn(`[OrderMonitor] Failed to cancel Poly order ${pos.polyOrderId}:`, e.message);
      }
    }
    if (!kalshiFilled && pos.kalshiOrderId) {
      try {
        await cancelKalshiOrder(autoArbEngine.credsKal, pos.kalshiOrderId);
        cancelled.kalshi = true;
        console.log(`[OrderMonitor] Cancelled stale Kalshi order ${pos.kalshiOrderId} for ${pos.gameKey}`);
      } catch (e) {
        console.warn(`[OrderMonitor] Failed to cancel Kalshi order ${pos.kalshiOrderId}:`, e.message);
      }
    }

    autoArbEngine.openPositions.delete(posId);
    broadcastAutoArbEvent('order_stale', {
      positionId: posId,
      gameKey: pos.gameKey,
      polyFilled, kalshiFilled,
      cancelledPoly: cancelled.poly,
      cancelledKalshi: cancelled.kalshi,
      ageMs: age,
    });
    console.log(`[OrderMonitor] Removed stale position ${posId} (poly filled: ${polyFilled}, kalshi filled: ${kalshiFilled})`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

function gameKey(away, home) {
  return `${String(away).toUpperCase()}-${String(home).toUpperCase()}`;
}

function detectArbOpportunities(polyGames, kalshiGames, balances, maxStakeOverride) {
  const maxStake = maxStakeOverride != null ? Number(maxStakeOverride) : ARB_MAX_STAKE_USD;
  const opportunities = [];
  const byKey = new Map();
  for (const g of kalshiGames) byKey.set(gameKey(g.awayTeam, g.homeTeam), g);
  // Subtract active orders from available balance so we don't over-commit
  const activePolyReserved = balances?.polymarket?.activeOrdersUsdc || 0;
  const activeKalReserved = balances?.kalshi?.activeOrdersUsdc || 0;
  const availPoly = balances?.polymarket?.balanceUsdc != null ? Math.max(1, balances.polymarket.balanceUsdc - ARB_RESERVE_POLY_USD - activePolyReserved) : maxStake;
  const availKal = balances?.kalshi?.balanceCents != null ? Math.max(1, (balances.kalshi.balanceCents / 100) - ARB_RESERVE_KAL_USD - activeKalReserved) : maxStake;

  for (const poly of polyGames) {
    const key = gameKey(poly.awayTeam, poly.homeTeam);
    const kal = byKey.get(key);
    if (!kal || !poly.tokenIdHome || !poly.tokenIdAway) continue;

    // Use bestAsk for buy cost (what you actually pay), bestBid for sell value
    // Fall back to bid + 1 tick if ask isn't available yet
    const p_H_bid = Math.max(0.01, Math.min(0.99, Number(poly.homeOdds) || 0.5));
    const p_A_bid = Math.max(0.01, Math.min(0.99, Number(poly.awayOdds) || 0.5));
    const p_H_poly = Math.max(0.01, Math.min(0.99, Number(poly.homeAsk) || (p_H_bid + 0.01)));
    const p_A_poly = Math.max(0.01, Math.min(0.99, Number(poly.awayAsk) || (p_A_bid + 0.01)));
    const p_H_kal = Math.max(0.01, Math.min(0.99, Number(kal.homeOdds) || 0.5));
    const p_A_kal = Math.max(0.01, Math.min(0.99, Number(kal.awayOdds) || 0.5));

    // Strategy 1: Home on Poly, Away on Kalshi. Arb if p_H_poly + p_A_kal < 1
    const sum1 = p_H_poly + p_A_kal;
    if (sum1 < 1) {
      const idealStake = maxStake;
      let x = Math.min(idealStake, availPoly, (availKal * p_H_poly) / p_A_kal);
      x = Math.max(0, Math.min(x, maxStake));
      const y = (x * p_A_kal) / p_H_poly;
      if (y > availKal) continue;
      const K = x / p_H_poly;
      const C = x + y;
      const contractsKal = Math.floor((y * 100) / Math.round(p_A_kal * 100));
      const feeKal = KALSHI_TAKER_FEE * contractsKal * p_A_kal * (1 - p_A_kal);
      const netProfit = K - C - feeKal;
      if (netProfit >= ARB_MIN_PROFIT_USD && x >= 1) {
        opportunities.push({
          gameKey: key,
          awayTeam: poly.awayTeam,
          homeTeam: poly.homeTeam,
          strategy: 1,
          strategyLabel: `Home (${poly.homeTeam}) on Poly, Away (${poly.awayTeam}) on Kalshi`,
          stakePolyUsd: Math.round(x * 100) / 100,
          stakeKalshiUsd: Math.round(y * 100) / 100,
          polyPrice: p_H_poly,
          kalshiPrice: p_A_kal,
          polyTokenId: poly.tokenIdHome,
          polySide: 'BUY',
          kalshiTicker: kal.marketTickerAway,
          kalshiSide: 'yes',
          kalshiYesPriceCents: Math.round(p_A_kal * 100),
          kalshiCount: contractsKal,
          netProfitUsd: Math.round(netProfit * 100) / 100,
          feeUsd: Math.round(feeKal * 100) / 100,
          polyTickSize: poly.tickSize || '0.01',
          polyNegRisk: Boolean(poly.negRisk),
          polyUrl: poly.url || '',
          kalshiUrl: kal.url || '',
        });
      }
    }

    // Strategy 2: Away on Poly, Home on Kalshi. Arb if p_A_poly + p_H_kal < 1
    const sum2 = p_A_poly + p_H_kal;
    if (sum2 < 1) {
      const idealStake = maxStake;
      let x = Math.min(idealStake, availPoly, (availKal * p_A_poly) / p_H_kal);
      x = Math.max(0, Math.min(x, maxStake));
      const y = (x * p_H_kal) / p_A_poly;
      if (y > availKal) continue;
      const K = x / p_A_poly;
      const C = x + y;
      const contractsKal = Math.floor((y * 100) / Math.round(p_H_kal * 100));
      const feeKal = KALSHI_TAKER_FEE * contractsKal * p_H_kal * (1 - p_H_kal);
      const netProfit = K - C - feeKal;
      if (netProfit >= ARB_MIN_PROFIT_USD && x >= 1) {
        opportunities.push({
          gameKey: key,
          awayTeam: poly.awayTeam,
          homeTeam: poly.homeTeam,
          strategy: 2,
          strategyLabel: `Away (${poly.awayTeam}) on Poly, Home (${poly.homeTeam}) on Kalshi`,
          stakePolyUsd: Math.round(x * 100) / 100,
          stakeKalshiUsd: Math.round(y * 100) / 100,
          polyPrice: p_A_poly,
          kalshiPrice: p_H_kal,
          polyTokenId: poly.tokenIdAway,
          polySide: 'BUY',
          kalshiTicker: kal.marketTickerHome,
          kalshiSide: 'yes',
          kalshiYesPriceCents: Math.round(p_H_kal * 100),
          kalshiCount: contractsKal,
          netProfitUsd: Math.round(netProfit * 100) / 100,
          feeUsd: Math.round(feeKal * 100) / 100,
          polyTickSize: poly.tickSize || '0.01',
          polyNegRisk: Boolean(poly.negRisk),
          polyUrl: poly.url || '',
          kalshiUrl: kal.url || '',
        });
      }
    }
  }
  return opportunities;
}

app.get('/api/arb/opportunities', async (req, res) => {
  try {
    const base = `${req.protocol}://${req.get('host')}`;
    const cookie = req.headers.cookie || '';
    const [polyRes, kalshiRes, balancesRes] = await Promise.all([
      fetch(`${base}/api/polymarket`, { headers: { cookie } }),
      fetch(`${base}/api/kalshi`, { headers: { cookie } }),
      req.session?.polyCreds || req.session?.kalshiCreds ? fetch(`${base}/api/balances`, { headers: { cookie } }) : Promise.resolve(null),
    ]);
    const polyData = await polyRes.json().catch(() => ({ games: [] }));
    const kalshiData = await kalshiRes.json().catch(() => ({ games: [] }));
    let balances = null;
    if (balancesRes && balancesRes.ok) balances = await balancesRes.json().catch(() => null);
    const polyGames = polyData.games || [];
    const kalshiGames = kalshiData.games || [];
    const opportunities = detectArbOpportunities(polyGames, kalshiGames, balances);
    res.json({ opportunities, config: { minProfitUsd: ARB_MIN_PROFIT_USD, maxStakeUsd: ARB_MAX_STAKE_USD, maxStakePerArbUsd: ARB_MAX_STAKE_PER_ARB_USD } });
  } catch (err) {
    console.error('Arb opportunities error:', err.message);
    res.status(500).json({ error: err.message, opportunities: [] });
  }
});

app.post('/api/arb/execute', async (req, res) => {
  const credsPoly = req.session?.polyCreds;
  const credsKal = req.session?.kalshiCreds;
  if (!credsPoly || !credsKal) {
    return res.status(401).json({ error: 'Sign in to both Polymarket and Kalshi to place arb' });
  }
  const opp = req.body;
  if (!opp || !opp.gameKey || !opp.polyTokenId || !opp.kalshiTicker) {
    return res.status(400).json({ error: 'Invalid opportunity: need gameKey, polyTokenId, kalshiTicker, stakePolyUsd, kalshiCount, etc.' });
  }

  const stakePoly = Number(opp.stakePolyUsd) || 0;
  const clientPolyPrice = Number(opp.polyPrice) || 0.5;
  // Last-mile WS freshness for the manual panel: client snapshot can be hundreds of ms old.
  // Side-aware: BUY fills at ASK (we pay), SELL fills at BID (we receive). Compare drift against
  // the SAME-side live price; using mid would mask half-spread of real drift.
  const ARB_PRICE_DRIFT_TOLERANCE = 0.005; // 0.5¢ adverse move
  const side = String(opp.polySide || 'BUY').toUpperCase();
  const liveGame = polyGamesState.get(opp.gameKey);
  let polyPrice = clientPolyPrice;
  if (liveGame) {
    // For BUY → look at the side we'd pay (ask). For SELL → the side we'd receive (bid is in awayOdds/homeOdds
    // per counterstrike's WS handler at server.js:580).
    const isAway = String(liveGame.tokenIdAway) === String(opp.polyTokenId);
    const liveBid = Number(isAway ? liveGame.awayOdds : liveGame.homeOdds); // counterstrike stores bid as "Odds"
    const liveAsk = Number(isAway ? liveGame.awayAsk : liveGame.homeAsk);
    const liveExecPrice = side === 'SELL' ? liveBid : liveAsk;
    if (Number.isFinite(liveExecPrice) && liveExecPrice > 0) {
      const drift = liveExecPrice - clientPolyPrice;
      const adverseDrift = side === 'SELL' ? -drift : drift; // BUY: ask up = bad; SELL: bid down = bad
      if (adverseDrift > ARB_PRICE_DRIFT_TOLERANCE) {
        return res.status(409).json({
          error: `Price moved against you while you were clicking. Live ${side === 'SELL' ? 'bid' : 'ask'} ${liveExecPrice.toFixed(3)} vs your snapshot ${clientPolyPrice.toFixed(3)} (drift ${(adverseDrift * 100).toFixed(1)}¢). Refresh the panel and re-evaluate.`,
          livePrice: liveExecPrice,
          liveBid: Number.isFinite(liveBid) ? liveBid : null,
          liveAsk: Number.isFinite(liveAsk) ? liveAsk : null,
          snapshotPrice: clientPolyPrice,
        });
      }
      // Use the live execution-side price so we trade at what the book actually shows.
      polyPrice = liveExecPrice;
    }
  }
  const polySize = Math.max(1, Math.floor(stakePoly / Math.max(0.01, polyPrice)));
  const polyNotional = polySize * polyPrice;
  if (polyNotional < 1) {
    return res.status(400).json({
      error: `Polymarket minimum order is $1 notional. This arb stake would be $${polyNotional.toFixed(2)}. Increase ARB_MAX_STAKE_PER_ARB_USD or choose a larger opportunity.`,
    });
  }

  // Allowance pre-flight removed: CLOB's getBalanceAllowance returns 0 for Magic/Safe
  // accounts even when allowance is actually set on-chain, causing false-positive blocks.
  // The order layer retries through all sigTypes — let it decide.

  try {
    const result = await executeArb(opp, credsPoly, credsKal, req.session?.polyFunder || null);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('Arb execute error:', err);
    if (err.leg1Done) {
      return res.status(500).json({
        error: 'Kalshi order failed after Poly leg filled. Cancel the Poly order or hedge on Kalshi. ' + err.message,
        leg1Done: true,
        polyResult: err.polyResult,
      });
    }
    res.status(500).json({ error: err.message || 'Arb execute failed' });
  }
});

// Combined endpoint - fetches both and tries to match games
app.get('/api/odds', async (req, res) => {
  try {
    const [polyRes, kalshiRes] = await Promise.allSettled([
      fetch(`https://gamma-api.polymarket.com/events?tag_id=${POLYMARKET_NBA_TAG}&active=true&closed=false&limit=50&order=start_date&ascending=true`),
      fetch(`${KALSHI_BASE}/events?status=open&limit=100`),
    ]);

    const polyEvents = polyRes.status === 'fulfilled' ? await polyRes.value.json() : [];
    const kalshiData = kalshiRes.status === 'fulfilled' ? await kalshiRes.value.json() : { events: [] };

    const polymarketGames = [];
    for (const event of polyEvents) {
      if (!event.markets?.length) continue;
      const m = event.markets.find((m) => m.outcomePrices) || event.markets[0];
      const prices = (m?.outcomePrices || '0.5,0.5').split(',').map(Number);
      const teams = event.teams || [];
      const title = event.title || m?.question || '';
      let away = teams[0]?.name || teams[0]?.abbreviation || 'Away';
      let home = teams[1]?.name || teams[1]?.abbreviation || 'Home';
      const vsMatch = title.match(/(.+?)\s+vs\.?\s+(.+)/i) || event.slug?.match(/nba-(\w+)-(\w+)-/);
      if (vsMatch) {
        away = vsMatch[1]?.trim() || away;
        home = vsMatch[2]?.trim() || home;
      }
      polymarketGames.push({
        id: `pm-${event.id}`,
        homeTeam: home,
        awayTeam: away,
        homeOdds: Math.round((prices[1] || 0.5) * 100) / 100,
        awayOdds: Math.round((prices[0] || 0.5) * 100) / 100,
        startDate: event.startDate || event.start_date,
        slug: event.slug,
        url: `https://polymarket.com/event/${event.slug || event.id}`,
      });
    }

    res.json({
      polymarket: polymarketGames,
      kalshi: [],
      note: 'Kalshi sports markets require API access. Add your API key to fetch Kalshi data.',
    });
  } catch (error) {
    res.status(500).json({ error: error.message, polymarket: [], kalshi: [] });
  }
});

// ---------- Auth & place-order (sign in to bet) ----------

// Fetch Polymarket profile to get proxy wallet (for email/Magic sign-in). Balance/allowance live in the proxy.
async function getPolyFunderAddress(ethAddress) {
  if (!ethAddress || typeof ethAddress !== 'string') return null;
  const addr = String(ethAddress).trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) return null;
  try {
    const res = await fetch(
      `https://gamma-api.polymarket.com/public-profile?address=${encodeURIComponent(addr)}`,
      fetchOptions
    );
    const data = await res.json().catch(() => ({}));
    const proxy = data?.proxyWallet ?? data?.proxy_wallet;
    if (proxy && /^0x[a-fA-F0-9]{40}$/.test(String(proxy).trim())) return String(proxy).trim().toLowerCase();
  } catch (_) {}
  return null;
}

// Build wallet + apiCreds + funder from session. Funder = proxy if email sign-in, else EOA.
async function getPolyWalletAndFunder(req) {
  const creds = req.session?.polyCreds;
  if (!creds) return null;
  const { Wallet } = await import('ethers');
  const wallet = new Wallet(String(creds.privateKey).trim());
  const apiCreds = {
    key: String(creds.apiKey ?? '').trim(),
    secret: String(creds.secret ?? '').trim(),
    passphrase: String(creds.passphrase ?? '').trim(),
  };
  const funder = (req.session?.polyFunder && /^0x[a-fA-F0-9]{40}$/.test(String(req.session.polyFunder)))
    ? String(req.session.polyFunder).trim().toLowerCase()
    : wallet.address.toLowerCase();
  return { wallet, apiCreds, funder };
}

app.get('/api/auth/status', (req, res) => {
  res.json({
    polymarket: Boolean(req.session?.polyCreds),
    kalshi: Boolean(req.session?.kalshiCreds),
  });
});

// Balances (when signed in). Use proxy as funder if email/Magic sign-in so we see the right balance.
app.get('/api/balances', async (req, res) => {
  const result = { polymarket: null, kalshi: null };
  const poly = await getPolyWalletAndFunder(req);
  if (poly) {
    try {
      const { ClobClient, AssetType } = await import('@polymarket/clob-client');
      const { wallet, apiCreds, funder } = poly;
      let balanceUsdc = 0;
      let allowanceUsdc = 0;
      const isProxy = funder !== wallet.address.toLowerCase();
      // Magic/Gmail (Gnosis Safe) → sigType=2 first; MetaMask Polymarket Proxy → sigType=1.
      const sigOrder = isProxy ? [2, 1, 0] : [0, 1, 2];
      // Take the MAX balance and allowance across sigTypes. Different sigTypes can return
      // different views; only the correct one shows real allowance for Magic/Safe accounts.
      for (const sigType of sigOrder) {
        try {
          const client = new ClobClient(
            'https://clob.polymarket.com',
            137,
            wallet,
            apiCreds,
            sigType,
            funder
          );
          const bal = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
          const balanceWei = BigInt(bal?.balance ?? 0);
          const allowanceWei = BigInt(bal?.allowance ?? 0);
          const usdc = Number(balanceWei) / 1e6;
          const allowUsdc = Number(allowanceWei) / 1e6;
          if (usdc > balanceUsdc) balanceUsdc = usdc;
          if (allowUsdc > allowanceUsdc) allowanceUsdc = allowUsdc;
        } catch (_) { /* keep trying other sigTypes */ }
      }
      const needAllowance = balanceUsdc > 0 && allowanceUsdc < balanceUsdc;
      result.polymarket = {
        balanceUsdc,
        allowanceUsdc,
        walletAddress: funder,
        ...(balanceUsdc === 0 && { hint: `Balance is $0. Send USDC (Polygon) to ${funder}${isProxy ? ' (your Polymarket profile address)' : ''}, or use an API key from the wallet that has the funds.` }),
        ...(needAllowance && { hint: 'Enable USDC for trading: click Enable USDC and confirm both popups, or use the manual Polygonscan links.' }),
      };
    } catch (err) {
      console.error('Polymarket balance error:', err.message);
      result.polymarket = { error: err.message };
    }
  }
  if (req.session?.kalshiCreds) {
    try {
      const creds = req.session.kalshiCreds;
      const path = '/trade-api/v2/portfolio/balance';
      const baseUrl = process.env.KALSHI_API_BASE || 'https://api.elections.kalshi.com';
      const fullUrl = `${baseUrl}${path}`;
      const timestamp = String(Date.now());
      const signature = kalshiSign(creds.privateKey, timestamp, 'GET', path);
      const balRes = await fetch(fullUrl, {
        method: 'GET',
        headers: {
          'KALSHI-ACCESS-KEY': creds.apiKeyId,
          'KALSHI-ACCESS-TIMESTAMP': timestamp,
          'KALSHI-ACCESS-SIGNATURE': signature,
        },
      });
      const data = await balRes.json().catch(() => ({}));
      if (balRes.ok && data.balance != null) {
        result.kalshi = {
          balanceCents: data.balance,
          portfolioValueCents: data.portfolio_value ?? data.balance,
        };
      } else {
        const errMsg =
          (typeof data.error === 'string' ? data.error : null) ||
          data.error?.message ||
          data.message ||
          (balRes.status === 401 ? 'Invalid or wrong API key. Using Kalshi demo? Set KALSHI_API_BASE=https://demo-api.kalshi.co and restart the server.' : null) ||
          `Failed to fetch balance (${balRes.status})`;
        result.kalshi = { error: errMsg };
      }
    } catch (err) {
      console.error('Kalshi balance error:', err.message);
      result.kalshi = { error: err.message };
    }
  }
  res.json(result);
});

// My orders (open orders + recent) for dashboard
app.get('/api/my-orders', async (req, res) => {
  const result = { polymarket: { orders: [], error: null }, kalshi: { orders: [], error: null } };
  const poly = await getPolyWalletAndFunder(req);
  if (poly) {
    try {
      const { ClobClient } = await import('@polymarket/clob-client');
      const { wallet, apiCreds, funder } = poly;
      const isProxy = funder !== wallet.address.toLowerCase();
      const sigType = isProxy ? 1 : 0;
      const client = new ClobClient('https://clob.polymarket.com', 137, wallet, apiCreds, sigType, funder);
      const raw = await client.getOpenOrders({}, true);
      const orders = Array.isArray(raw) ? raw : [];
      result.polymarket.orders = orders.map((o) => ({
        id: o.id,
        asset_id: o.asset_id,
        market: o.market,
        side: o.side,
        outcome: o.outcome,
        price: o.price,
        original_size: o.original_size,
        size_matched: o.size_matched,
        status: o.status,
        created_at: o.created_at,
      }));
      // Also fetch recent filled trades (maker + taker) + current prices for win/loss detection
      try {
        const addr = funder || wallet.address;
        const [makerRes2, takerRes2] = await Promise.allSettled([
          client.getTrades({ maker_address: addr }),
          client.getTrades({ taker_address: addr }),
        ]);
        const ml = makerRes2.status === 'fulfilled' && Array.isArray(makerRes2.value) ? makerRes2.value : [];
        const tl = takerRes2.status === 'fulfilled' && Array.isArray(takerRes2.value) ? takerRes2.value : [];
        const tm = new Map([...ml, ...tl].map((t) => [t.id, t]));
        const tradeList = [...tm.values()].slice(0, 50);
        // Fetch current midpoint prices to determine win/loss
        let priceMap = {};
        try {
          const tokenIds = [...new Set(tradeList.map((t) => t.asset_id).filter(Boolean))];
          if (tokenIds.length) {
            const priceRes = await fetch(`https://clob.polymarket.com/midpoints?token_ids=${tokenIds.join(',')}`, fetchOptions);
            const priceData = await priceRes.json();
            // Response shape: { "tokenId": { "mid": "0.97" }, ... }
            for (const [k, v] of Object.entries(priceData || {})) {
              priceMap[k] = parseFloat(v?.mid ?? v ?? 0);
            }
          }
        } catch (_) {}
        result.polymarket.trades = tradeList.map((t) => {
          const mid = priceMap[t.asset_id];
          const result_status = mid == null ? 'pending'
            : mid > 0.9 ? 'win'
            : mid < 0.1 ? 'loss'
            : 'pending';
          const shares = Number(t.size) || 0;
          const fillPrice = Number(t.price) || 0;
          const stake = shares * fillPrice;
          const payout = result_status === 'win' ? shares : result_status === 'loss' ? 0 : null;
          return {
            id: t.id,
            market: t.market,
            asset_id: t.asset_id,
            side: t.side,
            outcome: t.outcome,
            price: fillPrice,
            size: shares,
            stake,
            payout,
            result_status,
            created_at: t.created_at,
          };
        });
      } catch (_) {
        result.polymarket.trades = [];
      }
    } catch (err) {
      console.error('Polymarket my-orders error:', err.message);
      result.polymarket.error = err.message;
    }
  }
  if (req.session?.kalshiCreds) {
    try {
      const creds = req.session.kalshiCreds;
      const path = '/trade-api/v2/portfolio/orders';
      const baseUrl = process.env.KALSHI_API_BASE || 'https://api.elections.kalshi.com';
      const fullUrl = `${baseUrl}${path}?limit=50`;
      const timestamp = String(Date.now());
      const signature = kalshiSign(creds.privateKey, timestamp, 'GET', path);
      const ordRes = await fetch(fullUrl, {
        method: 'GET',
        headers: {
          'KALSHI-ACCESS-KEY': creds.apiKeyId,
          'KALSHI-ACCESS-TIMESTAMP': timestamp,
          'KALSHI-ACCESS-SIGNATURE': signature,
        },
      });
      const data = await ordRes.json().catch(() => ({}));
      if (ordRes.ok && Array.isArray(data.orders)) {
        result.kalshi.orders = data.orders;
      } else if (ordRes.ok && data.order) {
        result.kalshi.orders = [data.order];
      } else if (!ordRes.ok) {
        result.kalshi.error = data.error?.message || data.message || `Failed (${ordRes.status})`;
      }
    } catch (err) {
      console.error('Kalshi my-orders error:', err.message);
      result.kalshi.error = err.message;
    }
  }
  res.json(result);
});

// Auto-activate early exit monitoring when both Poly + Kalshi creds are available
function activateEarlyExitMonitor(req) {
  if (!req.session?.polyCreds || !req.session?.kalshiCreds) return;
  // Set engine creds so checkEarlyExits can sell
  autoArbEngine.credsPoly = req.session.polyCreds;
  autoArbEngine.credsKal = req.session.kalshiCreds;
  autoArbEngine.polyFunder = req.session.polyFunder || null;
  if (autoArbEngine.exitThreshold == null) autoArbEngine.exitThreshold = 1.00;
  // Hydrate open positions from arb-history
  const nowMs = Date.now();
  const history = readArbHistory();
  for (const h of history) {
    if (h.status !== 'placed' || autoArbEngine.openPositions.has(h.id)) continue;
    if (nowMs - h.placedAt > 5 * 60 * 60 * 1000) continue;
    autoArbEngine.openPositions.set(h.id, {
      id: h.id, gameKey: h.gameKey, awayTeam: h.awayTeam, homeTeam: h.homeTeam,
      strategyLabel: h.strategyLabel, strategy: h.strategy,
      entryPolyPrice: h.polyPrice, entryKalshiCents: h.kalshiYesPriceCents,
      polyShares: h.polyShares || Math.max(1, Math.floor(h.stakePolyUsd / h.polyPrice)),
      kalshiCount: h.kalshiCount || Math.max(1, Math.floor(h.stakeKalshiUsd / (h.kalshiYesPriceCents / 100))),
      polyTokenId: h.polyTokenId, polyTickSize: h.polyTickSize || '0.01', polyNegRisk: h.polyNegRisk || false,
      kalshiTicker: h.kalshiTicker, kalshiSide: h.kalshiSide || 'yes',
      stakePolyUsd: h.stakePolyUsd, stakeKalshiUsd: h.stakeKalshiUsd,
      netProfitUsd: h.netProfitUsd, simulate: false, placedAt: h.placedAt,
    });
  }
  // Start exit interval if not already running
  if (!autoArbEngine._exitIntervalId) {
    autoArbEngine._exitIntervalId = setInterval(() => { checkEarlyExits(); broadcastLivePnL(); }, 3000);
    console.log(`[EarlyExit] Monitor activated on sign-in — tracking ${autoArbEngine.openPositions.size} open positions`);
  }
}

app.post('/api/auth/polymarket', async (req, res) => {
  const { apiKey, secret, passphrase, privateKey, funderAddress } = req.body || {};
  if (!apiKey || !secret || !passphrase || !privateKey) {
    return res.status(400).json({ error: 'Missing apiKey, secret, passphrase, or privateKey' });
  }
  req.session.polyCreds = {
    apiKey: String(apiKey).trim(),
    secret: String(secret).trim(),
    passphrase: String(passphrase).trim(),
    privateKey: String(privateKey).trim(),
  };
  delete req.session.polyFunder;
  try {
    const { Wallet, ethers } = await import('ethers');
    const wallet = new Wallet(String(privateKey).trim());
    if (funderAddress && /^0x[a-fA-F0-9]{40}$/.test(String(funderAddress).trim())) {
      req.session.polyFunder = String(funderAddress).trim().toLowerCase();
    } else {
      // Derive the Safe proxy address from the on-chain factory (read-only, deterministic — no signing)
      try {
        const provider = new ethers.providers.JsonRpcProvider('https://polygon-bor-rpc.publicnode.com', 137);
        const factory = new ethers.Contract(
          '0xaacFeEa03eb1561C4e67d661e40682Bd20e3541b',
          ['function computeProxyAddress(address user) view returns (address)'],
          provider
        );
        const proxy = await factory.computeProxyAddress(wallet.address);
        const code = await provider.getCode(proxy);
        // Only use proxy if it's actually deployed (i.e. account was created via Polymarket web UI)
        if (code && code !== '0x') {
          req.session.polyFunder = proxy.toLowerCase();
          console.log('Auto-derived Polymarket proxy wallet:', proxy);
        }
      } catch (e) {
        console.log('Proxy derivation skipped:', e.message);
      }
    }
  } catch (_) {}
  // Auto-activate early exit monitor if both creds are now available
  activateEarlyExitMonitor(req);
  res.json({ ok: true });
});

// Server-side Polymarket credential derivation for Magic/Gmail signups.
// User provides ONLY their private key + (optional) profile/funder address; we derive API
// credentials using the right sigType for their account type. This eliminates the failure
// mode where stored creds are tied to a different on-chain identity than the trader.
//
// POST /api/auth/polymarket-derive
// Body: { privateKey, funderAddress? }
// Tries (sigType, funder) combinations in priority order, calls createOrDeriveApiKey for each,
// and validates by reading the balance. Returns the working creds on success.
app.post('/api/auth/polymarket-derive', async (req, res) => {
  const { privateKey, funderAddress } = req.body || {};
  if (!privateKey || !String(privateKey).trim().startsWith('0x')) {
    return res.status(400).json({ error: 'Need privateKey starting with 0x' });
  }
  const pk = String(privateKey).trim();

  try {
    const { ClobClient, AssetType } = await import('@polymarket/clob-client');
    const { Wallet, ethers } = await import('ethers');
    const wallet = new Wallet(pk);

    // 1) Resolve funder address. Order: explicit > Polymarket profile API > Safe factory > EOA.
    let funder = null;
    if (funderAddress && /^0x[a-fA-F0-9]{40}$/.test(String(funderAddress).trim())) {
      funder = String(funderAddress).trim().toLowerCase();
    } else {
      // Try Polymarket's public profile lookup — it returns the user's actual proxy.
      try {
        const apiFunder = await getPolyFunderAddress(wallet.address);
        if (apiFunder) funder = apiFunder;
      } catch (_) {}
      if (!funder) {
        try {
          const provider = new ethers.providers.JsonRpcProvider('https://polygon-bor-rpc.publicnode.com', 137);
          const factory = new ethers.Contract(
            '0xaacFeEa03eb1561C4e67d661e40682Bd20e3541b',
            ['function computeProxyAddress(address user) view returns (address)'],
            provider
          );
          const proxy = await factory.computeProxyAddress(wallet.address);
          const code = await provider.getCode(proxy);
          if (code && code !== '0x') funder = String(proxy).toLowerCase();
        } catch (_) {}
      }
      if (!funder) funder = wallet.address.toLowerCase();
    }
    const isProxy = funder !== wallet.address.toLowerCase();

    // 2) Try sigTypes in priority order (Safe first for proxy accounts) and pick the FIRST one
    // where derived creds successfully read a balance. That tells us we're talking to the
    // right on-chain identity.
    const sigOrder = isProxy ? [2, 1, 0] : [0, 1, 2];
    const attempts = [];
    let chosenCreds = null;
    let chosenSigType = null;
    for (const sigType of sigOrder) {
      try {
        const tempClient = new ClobClient('https://clob.polymarket.com', 137, wallet, undefined, sigType, funder);
        const apiCreds = await tempClient.createOrDeriveApiKey();
        const key = apiCreds.apiKey ?? apiCreds.key;
        if (!key || !apiCreds.secret || !apiCreds.passphrase) {
          attempts.push({ sigType, error: 'missing creds in derive response' });
          continue;
        }
        // Validate by calling getBalanceAllowance — this fails if the API key/sigType/funder
        // don't agree with what the CLOB has on record.
        const fullCreds = { key, secret: apiCreds.secret, passphrase: apiCreds.passphrase };
        const validateClient = new ClobClient('https://clob.polymarket.com', 137, wallet, fullCreds, sigType, funder);
        const bal = await validateClient.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
        const balanceUsdc = Number(BigInt(bal?.balance ?? 0)) / 1e6;
        const allowanceUsdc = Number(BigInt(bal?.allowance ?? 0)) / 1e6;
        attempts.push({ sigType, ok: true, balanceUsdc, allowanceUsdc, apiKeyMasked: `${key.slice(0, 8)}...` });
        // Pick the FIRST sigType that returns a real balance (>0). That's the one whose
        // on-chain identity matches the funds.
        if (chosenCreds == null && balanceUsdc > 0) {
          chosenCreds = fullCreds;
          chosenSigType = sigType;
          break;
        }
        // No balance? Could be a fresh/empty account. Stash as fallback.
        if (chosenCreds == null) {
          chosenCreds = fullCreds;
          chosenSigType = sigType;
        }
      } catch (err) {
        attempts.push({ sigType, error: err?.message || String(err) });
      }
    }

    if (!chosenCreds) {
      return res.status(502).json({
        error: 'Could not derive any working API credentials. See attempts.',
        attempts,
        eoa: wallet.address.toLowerCase(),
        funder,
      });
    }

    req.session.polyCreds = {
      apiKey: chosenCreds.key,
      secret: chosenCreds.secret,
      passphrase: chosenCreds.passphrase,
      privateKey: pk,
    };
    req.session.polyFunder = funder;
    req.session.polySigType = chosenSigType; // Hint for future calls (currently informational)
    activateEarlyExitMonitor(req);
    console.log(`[poly-derive] OK — sigType=${chosenSigType} funder=${funder} EOA=${wallet.address.toLowerCase()}`);
    return res.json({
      ok: true,
      eoa: wallet.address.toLowerCase(),
      funder,
      sigType: chosenSigType,
      apiKeyMasked: `${chosenCreds.key.slice(0, 8)}...`,
      attempts,
    });
  } catch (err) {
    console.error('[poly-derive] error:', err);
    return res.status(500).json({ error: err?.message || 'derive failed' });
  }
});

app.post('/api/auth/kalshi', (req, res) => {
  const { apiKeyId, privateKey } = req.body || {};
  if (!apiKeyId || !privateKey) {
    return res.status(400).json({ error: 'Missing apiKeyId or privateKey' });
  }
  try {
    const normalized = normalizePem(privateKey);
    crypto.createPrivateKey(normalized);
  } catch (err) {
    if (/DECODER|unsupported|PEM|format/i.test(err.message || '')) {
      return res.status(400).json({
        error: 'Invalid private key. Paste the full PEM from Kalshi including -----BEGIN RSA PRIVATE KEY----- and -----END RSA PRIVATE KEY----- each on its own line. If you pasted in one line, try again with the line breaks preserved.',
      });
    }
    return res.status(400).json({ error: err.message || 'Invalid private key' });
  }
  req.session.kalshiCreds = { apiKeyId, privateKey };
  connectKalshiWS({ apiKeyId, privateKey }); // start WS feed immediately on sign-in
  // Auto-activate early exit monitor if both creds are now available
  activateEarlyExitMonitor(req);
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  delete req.session.polyCreds;
  delete req.session.polyFunder;
  delete req.session.kalshiCreds;
  res.json({ ok: true });
});

// Ask CLOB to update USDC + CTF allowance. Returns both responses (may include transactions for frontend to send via MetaMask).
app.post('/api/polymarket/update-allowance', async (req, res) => {
  const poly = await getPolyWalletAndFunder(req);
  if (!poly) return res.status(401).json({ error: 'Not signed in to Polymarket' });
  try {
    const { ClobClient, AssetType } = await import('@polymarket/clob-client');
    const { wallet, apiCreds, funder } = poly;
    const isProxy = funder !== wallet.address.toLowerCase();
    const client = new ClobClient('https://clob.polymarket.com', 137, wallet, apiCreds, isProxy ? 1 : 0, funder);
    const collateral = await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    const conditional = await client.updateBalanceAllowance({ asset_type: AssetType.CONDITIONAL });
    const needsSigning = collateral?.transaction || conditional?.transaction;
    res.json({
      ok: true,
      data: { collateral, conditional },
      message: needsSigning
        ? 'Sign both transactions in MetaMask (Enable USDC + Enable CTF), then try placing a bet.'
        : 'Both allowances approved. Try placing a bet now.',
    });
  } catch (err) {
    console.error('Polymarket update-allowance error:', err);
    const msg = err?.response?.data?.error || err?.message || 'Update failed';
    res.status(err?.status === 400 ? 400 : 500).json({ error: msg });
  }
});

// Polymarket SDK only supports these tick sizes (ROUNDING_CONFIG keys). Use smallest supported >= market min.
const POLY_SUPPORTED_TICK_SIZES = ['0.0001', '0.001', '0.01', '0.1'];
function polyTickSizeSupported(minTickStr) {
  const min = parseFloat(minTickStr);
  if (!Number.isFinite(min)) return '0.01';
  const found = POLY_SUPPORTED_TICK_SIZES.find((s) => parseFloat(s) >= min);
  return found || '0.1';
}

// Round price to Polymarket tick so the CLOB doesn't reject with INVALID_ORDER_MIN_TICK_SIZE.
function roundPriceToTick(price, tickSizeStr) {
  const p = Number(price);
  const tick = parseFloat(tickSizeStr) || 0.01;
  if (!Number.isFinite(p) || !Number.isFinite(tick) || tick <= 0) return p;
  const decimals = tick >= 0.1 ? 1 : tick >= 0.01 ? 2 : tick >= 0.001 ? 3 : 4;
  return Math.round(p * Math.pow(10, decimals)) / Math.pow(10, decimals);
}

// Cancel a Kalshi order
app.post('/api/kalshi/cancel-order', async (req, res) => {
  const kal = req.session?.kalshiCreds;
  if (!kal) return res.status(401).json({ error: 'Not signed in to Kalshi' });
  const { order_id } = req.body || {};
  if (!order_id) return res.status(400).json({ error: 'Missing order_id' });
  try {
    await cancelKalshiOrder(kal, order_id);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Cancel an open Polymarket order by order ID
// Cancel ALL open Polymarket orders
app.post('/api/polymarket/cancel-all-orders', async (req, res) => {
  const poly = await getPolyWalletAndFunder(req);
  if (!poly) return res.status(401).json({ error: 'Not signed in to Polymarket' });
  try {
    const { ClobClient } = await import('@polymarket/clob-client');
    const { wallet, apiCreds, funder } = poly;
    const isProxy = funder !== wallet.address.toLowerCase();
    const client = new ClobClient('https://clob.polymarket.com', 137, wallet, apiCreds, isProxy ? 1 : 0, funder);
    const raw = await client.getOpenOrders({}, true);
    const orders = Array.isArray(raw) ? raw : [];
    if (!orders.length) return res.json({ message: 'No open orders to cancel', cancelled: 0 });
    let cancelled = 0, failed = 0;
    for (const order of orders) {
      try {
        await client.cancelOrder({ orderID: order.id });
        cancelled++;
      } catch (e) {
        // Try other sig types
        let done = false;
        for (const sigType of [0, 1, 2]) {
          try {
            const c2 = new ClobClient('https://clob.polymarket.com', 137, wallet, apiCreds, sigType, isProxy ? funder : wallet.address);
            await c2.cancelOrder({ orderID: order.id });
            cancelled++;
            done = true;
            break;
          } catch (_) {}
        }
        if (!done) failed++;
      }
    }
    console.log(`[CANCEL-ALL] Cancelled ${cancelled}/${orders.length} orders (${failed} failed)`);
    return res.json({ message: `Cancelled ${cancelled} of ${orders.length} orders`, cancelled, failed, total: orders.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/polymarket/cancel-order', async (req, res) => {
  const poly = await getPolyWalletAndFunder(req);
  if (!poly) return res.status(401).json({ error: 'Not signed in to Polymarket' });
  const { order_id } = req.body || {};
  if (!order_id) return res.status(400).json({ error: 'Missing order_id' });
  console.log('Cancelling Poly order ID:', order_id);
  try {
    const { ClobClient } = await import('@polymarket/clob-client');
    const { Wallet } = await import('ethers');
    const { wallet, apiCreds } = poly;
    // Try all sig types until one works
    const attempts = [0, 1, 2];
    let lastErr = null;
    for (const sigType of attempts) {
      try {
        const client = new ClobClient('https://clob.polymarket.com', 137, wallet, apiCreds, sigType, wallet.address);
        // Try both formats: string ID and object {orderID}
        let result;
        try {
          result = await client.cancelOrder({ orderID: order_id });
        } catch (_) {
          result = await client.cancelOrder(order_id);
        }
        console.log('Cancel order result:', JSON.stringify(result));
        if (result?.error || result?.errorMsg) {
          lastErr = new Error(result.error || result.errorMsg);
          continue;
        }
        // cancelOrder returns {canceled: [...], not_canceled: {...}}
        const cancelled = result?.canceled || [];
        const success = Array.isArray(cancelled) && cancelled.includes(order_id);
        if (!success && !cancelled.length) {
          lastErr = new Error('Order not found or already cancelled');
          continue;
        }
        return res.json({ success: true, result });
      } catch (e) {
        lastErr = e;
        if (/invalid signature/i.test(e.message)) continue;
        break;
      }
    }
    return res.status(500).json({ error: lastErr?.message || 'Cancel failed' });
  } catch (err) {
    console.error('Cancel order error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// Sell ALL Polymarket positions by fetching actual trades and computing net shares per token
app.post('/api/polymarket/sell-everything', async (req, res) => {
  const poly = await getPolyWalletAndFunder(req);
  if (!poly) return res.status(401).json({ error: 'Not signed in to Polymarket' });
  try {
    const { ClobClient, Side, OrderType } = await import('@polymarket/clob-client');
    const { wallet, apiCreds, funder } = poly;
    const isProxy = funder !== wallet.address.toLowerCase();
    const addr = funder || wallet.address;
    const client = new ClobClient('https://clob.polymarket.com', 137, wallet, apiCreds, isProxy ? 1 : 0, funder);

    // Fetch all trades to compute net position per token
    const [makerRes, takerRes] = await Promise.allSettled([
      client.getTrades({ maker_address: addr }),
      client.getTrades({ taker_address: addr }),
    ]);
    const allTrades = [
      ...(makerRes.status === 'fulfilled' && Array.isArray(makerRes.value) ? makerRes.value : []),
      ...(takerRes.status === 'fulfilled' && Array.isArray(takerRes.value) ? takerRes.value : []),
    ];
    const uniqueTrades = [...new Map(allTrades.map(t => [t.id, t])).values()];

    // Compute net shares per token
    const netByToken = new Map();
    for (const t of uniqueTrades) {
      if (!t.asset_id || !t.size) continue;
      if (!netByToken.has(t.asset_id)) netByToken.set(t.asset_id, 0);
      const size = parseFloat(t.size) || 0;
      const side = (t.side || '').toUpperCase();
      if (side === 'BUY') netByToken.set(t.asset_id, netByToken.get(t.asset_id) + size);
      else if (side === 'SELL') netByToken.set(t.asset_id, netByToken.get(t.asset_id) - size);
    }

    // Filter to tokens with positive net (we hold shares)
    const positions = [];
    for (const [tokenId, net] of netByToken) {
      const shares = Math.floor(net);
      if (shares >= 1) positions.push({ tokenId, shares });
    }

    if (!positions.length) return res.json({ message: 'No positions to sell', results: [] });
    console.log(`[SELL-EVERYTHING] Found ${positions.length} positions:`, positions.map(p => `${p.tokenId.slice(0,8)}..=${p.shares}`).join(', '));

    const results = [];
    const attempts = [
      { sigType: 0, funderAddr: wallet.address },
      ...(isProxy ? [{ sigType: 1, funderAddr: funder }] : [{ sigType: 1, funderAddr: wallet.address }]),
    ];

    for (const pos of positions) {
      let sold = false;
      let sharesToSell = pos.shares;
      for (const { sigType, funderAddr } of attempts) {
        try {
          const c = new ClobClient('https://clob.polymarket.com', 137, wallet, apiCreds, sigType, funderAddr);
          let ts = '0.01';
          try { const mt = await c.getTickSize(pos.tokenId); if (mt != null) ts = polyTickSizeSupported(String(mt)); } catch (_) {}
          const priceRounded = roundPriceToTick(0.01, ts); // sell at any price (FOK matches best bid)

          for (let attempt = 0; attempt < 2; attempt++) {
            const userOrder = { tokenID: pos.tokenId, price: priceRounded, size: sharesToSell, side: Side.SELL };
            const response = await c.createAndPostOrder(userOrder, { negRisk: false, tickSize: ts }, OrderType.FOK);
            const responseErr = response?.error || response?.errorMsg;
            if (responseErr) {
              const errStr = String(responseErr);
              const balMatch = errStr.match(/balance:\s*(\d+)/);
              if (balMatch && attempt === 0) {
                const actualShares = Math.floor(parseInt(balMatch[1], 10) / 1000000);
                if (actualShares > 0 && actualShares < sharesToSell) {
                  console.log(`[SELL-EVERYTHING] ${pos.tokenId.slice(0,8)}..: balance retry ${sharesToSell} → ${actualShares}`);
                  sharesToSell = actualShares;
                  continue;
                }
              }
              if (/invalid signature/i.test(errStr)) break;
              results.push({ tokenId: pos.tokenId.slice(0, 12) + '...', shares: sharesToSell, status: 'error', error: errStr });
              sold = true; break;
            }
            const matched = Number(response?.size_matched ?? response?.sizeMatched ?? 0);
            results.push({ tokenId: pos.tokenId.slice(0, 12) + '...', shares: sharesToSell, matched, status: 'sold', orderId: response?.orderID });
            sold = true; break;
          }
          if (sold) break;
        } catch (e) {
          if (/invalid signature/i.test(e.message || '')) continue;
          results.push({ tokenId: pos.tokenId.slice(0, 12) + '...', shares: sharesToSell, status: 'error', error: e.message });
          sold = true; break;
        }
      }
      if (!sold) results.push({ tokenId: pos.tokenId.slice(0, 12) + '...', shares: sharesToSell, status: 'error', error: 'All sig attempts failed' });
    }

    console.log('[SELL-EVERYTHING] Results:', JSON.stringify(results, null, 2));
    return res.json({ message: `Processed ${results.length} positions`, results });
  } catch (err) {
    console.error('Sell-everything error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// Sell a Polymarket position at market price (best bid)
app.post('/api/polymarket/sell-position', async (req, res) => {
  const poly = await getPolyWalletAndFunder(req);
  if (!poly) return res.status(401).json({ error: 'Not signed in to Polymarket' });
  const { asset_id, size } = req.body || {};
  if (!asset_id || !size) return res.status(400).json({ error: 'Missing asset_id or size' });
  try {
    const { ClobClient, Side, OrderType } = await import('@polymarket/clob-client');
    const { wallet, apiCreds, funder } = poly;
    // Get current best bid from orderbook
    let sellPrice = 0.01;
    try {
      const obRes = await fetch(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(asset_id)}`, fetchOptions);
      const ob = await obRes.json();
      const bids = ob?.bids || [];
      if (bids.length > 0) {
        // best bid is highest bid price
        const bestBid = Math.max(...bids.map((b) => parseFloat(b.price) || 0));
        sellPrice = bestBid > 0 ? bestBid : 0.01;
      }
    } catch (_) {}
    const isProxy = funder !== wallet.address.toLowerCase();
    const attempts = [
      { sigType: 0, funderAddr: wallet.address },
      ...(isProxy ? [{ sigType: 1, funderAddr: funder }] : [{ sigType: 1, funderAddr: wallet.address }]),
    ];
    const tokenIdStr = String(asset_id).trim();
    let lastErr = null;
    for (const { sigType, funderAddr } of attempts) {
      try {
        const client = new ClobClient('https://clob.polymarket.com', 137, wallet, apiCreds, sigType, funderAddr);
        let ts = '0.01';
        try { const mt = await client.getTickSize(tokenIdStr); if (mt != null) ts = polyTickSizeSupported(String(mt)); } catch (_) {}
        const priceRounded = roundPriceToTick(sellPrice, ts);
        const userOrder = { tokenID: tokenIdStr, price: priceRounded, size: Number(size), side: Side.SELL };
        const response = await client.createAndPostOrder(userOrder, { negRisk: false, tickSize: ts }, OrderType.GTC);
        const responseErr = response?.error || response?.errorMsg;
        if (responseErr) {
          lastErr = new Error(String(responseErr));
          if (/invalid signature/i.test(String(responseErr))) continue;
          return res.status(400).json({ error: String(responseErr) });
        }
        console.log('SELL RESPONSE:', JSON.stringify(response, null, 2));
        return res.json({ success: true, sellPrice: priceRounded, response });
      } catch (e) {
        lastErr = e;
        if (/invalid signature/i.test(e.message || '')) continue;
        return res.status(500).json({ error: e.message });
      }
    }
    return res.status(500).json({ error: lastErr?.message || 'Sell failed' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Sell ALL open Polymarket positions from arb-history at best bid
app.post('/api/polymarket/sell-all-positions', async (req, res) => {
  const poly = await getPolyWalletAndFunder(req);
  if (!poly) return res.status(401).json({ error: 'Not signed in to Polymarket' });
  const { dryRun } = req.body || {};
  try {
    const { ClobClient, Side, OrderType } = await import('@polymarket/clob-client');
    const { wallet, apiCreds, funder } = poly;
    const isProxy = funder !== wallet.address.toLowerCase();

    const history = readArbHistory();
    const placed = history.filter(h => h.status === 'placed');
    if (!placed.length) return res.json({ message: 'No open positions to sell', results: [] });

    // Resolve polyTokenId for positions that don't have it stored
    // Try: 1) polyGamesState lookup, 2) trades lookup to find asset_id from fills
    const addr = funder || wallet.address;
    const client0 = new ClobClient('https://clob.polymarket.com', 137, wallet, apiCreds, isProxy ? 1 : 0, funder);

    // Fetch user's actual trades to: 1) resolve token IDs, 2) compute real net position per token
    let tradeAssetMap = new Map(); // polyOrderId -> asset_id
    let netPositionByToken = new Map(); // asset_id -> { netShares, buys, sells }
    try {
      const [makerRes, takerRes] = await Promise.allSettled([
        client0.getTrades({ maker_address: addr }),
        client0.getTrades({ taker_address: addr }),
      ]);
      const allTrades = [
        ...(makerRes.status === 'fulfilled' && Array.isArray(makerRes.value) ? makerRes.value : []),
        ...(takerRes.status === 'fulfilled' && Array.isArray(takerRes.value) ? takerRes.value : []),
      ];
      // Deduplicate by trade id
      const uniqueTrades = [...new Map(allTrades.map(t => [t.id, t])).values()];
      for (const t of uniqueTrades) {
        if (t.order_id && t.asset_id) tradeAssetMap.set(t.order_id, t.asset_id);
        if (t.maker_order_id && t.asset_id) tradeAssetMap.set(t.maker_order_id, t.asset_id);
        if (t.taker_order_id && t.asset_id) tradeAssetMap.set(t.taker_order_id, t.asset_id);
        // Compute net position: BUY adds shares, SELL removes shares
        if (t.asset_id && t.size) {
          if (!netPositionByToken.has(t.asset_id)) netPositionByToken.set(t.asset_id, { netShares: 0 });
          const pos = netPositionByToken.get(t.asset_id);
          const size = parseFloat(t.size) || 0;
          const side = (t.side || '').toUpperCase();
          // Determine if this user was buyer or seller
          const isBuyer = (t.taker_order_id && tradeAssetMap.has(t.taker_order_id))
            ? t.side?.toUpperCase() === 'BUY'
            : t.side?.toUpperCase() === 'BUY';
          if (side === 'BUY') pos.netShares += size;
          else if (side === 'SELL') pos.netShares -= size;
        }
      }
      console.log(`[SELL-ALL] Fetched ${uniqueTrades.length} trades. Net positions:`,
        [...netPositionByToken.entries()].filter(([,v]) => v.netShares > 0).map(([k,v]) => `${k.slice(0,8)}..=${v.netShares}`).join(', '));
    } catch (e) { console.error('[SELL-ALL] Trade fetch error:', e.message); }

    for (const pos of placed) {
      if (!pos.polyTokenId) {
        // Attempt 1: game state lookup
        const game = polyGamesState.get(pos.gameKey);
        if (game) {
          if (pos.strategy === 1 || (pos.strategyLabel && pos.strategyLabel.startsWith('Home'))) {
            pos.polyTokenId = game.tokenIdHome;
          } else {
            pos.polyTokenId = game.tokenIdAway;
          }
        }
        // Attempt 2: match from trades by order ID
        if (!pos.polyTokenId && pos.polyOrderId) {
          pos.polyTokenId = tradeAssetMap.get(pos.polyOrderId);
        }
        // Attempt 3: getOrder fallback
        if (!pos.polyTokenId && pos.polyOrderId && !pos.polyOrderId.startsWith('SIM-')) {
          try {
            const order = await client0.getOrder(pos.polyOrderId);
            if (order?.asset_id) pos.polyTokenId = order.asset_id;
            else if (order?.token_id) pos.polyTokenId = order.token_id;
          } catch (_) {}
        }
      }
    }
    console.log(`[SELL-ALL] Resolved: ${placed.filter(p => p.polyTokenId).length}/${placed.length} positions have tokenId`);

    const sellable = placed.filter(p => p.polyTokenId);
    if (!sellable.length) return res.json({ message: 'No positions with known token IDs (server may need to fetch game data first)', results: [] });

    // Group by tokenId — use ACTUAL net position from trades instead of calculated shares
    const byToken = new Map();
    for (const pos of sellable) {
      const key = pos.polyTokenId;
      if (!byToken.has(key)) {
        const netPos = netPositionByToken.get(key);
        const realShares = netPos ? Math.floor(netPos.netShares) : 0;
        byToken.set(key, { tokenId: key, totalShares: realShares, positions: [], tickSize: pos.polyTickSize || '0.01', negRisk: pos.polyNegRisk || false });
      }
      byToken.get(key).positions.push(pos);
    }
    // Remove tokens with 0 or negative net shares (already sold or settled)
    for (const [key, group] of byToken) {
      if (group.totalShares <= 0) {
        console.log(`[SELL-ALL] Skipping ${group.positions[0]?.gameKey || key}: net shares = ${group.totalShares} (already sold/settled)`);
        // Mark these positions as settled in history
        for (const pos of group.positions) { updateArbHistoryEntry(pos.id, { status: 'settled', settledAt: Date.now() }); autoArbEngine.openPositions.delete(pos.id); }
        byToken.delete(key);
      }
    }

    const results = [];
    const attempts = [
      { sigType: 0, funderAddr: wallet.address },
      ...(isProxy ? [{ sigType: 1, funderAddr: funder }] : [{ sigType: 1, funderAddr: wallet.address }]),
    ];

    for (const [tokenId, group] of byToken) {
      const gameKey = group.positions[0]?.gameKey || 'unknown';

      // Get best bid from orderbook — if book doesn't exist, market is settled/closed
      let sellPrice = 0.01;
      let bookExists = true;
      try {
        const obRes = await fetch(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenId)}`, fetchOptions);
        if (!obRes.ok) {
          const errText = await obRes.text().catch(() => '');
          if (errText.includes('does not exist') || obRes.status === 404) {
            bookExists = false;
            console.log(`[SELL-ALL] Skipping ${gameKey}: orderbook does not exist (market settled/closed)`);
            for (const pos of group.positions) { updateArbHistoryEntry(pos.id, { status: 'settled', settledAt: Date.now() }); autoArbEngine.openPositions.delete(pos.id); }
            results.push({ gameKey, tokenId, shares: group.totalShares, status: 'settled', positionCount: group.positions.length });
            continue;
          }
        }
        const ob = await obRes.json();
        const bids = ob?.bids || [];
        if (bids.length > 0) {
          const bestBid = Math.max(...bids.map((b) => parseFloat(b.price) || 0));
          sellPrice = bestBid > 0 ? bestBid : 0.01;
        }
      } catch (_) {}

      if (dryRun) {
        results.push({ gameKey, tokenId, shares: group.totalShares, sellPrice, status: 'dry-run', positionCount: group.positions.length });
        continue;
      }

      let sold = false;
      let lastErr = null;
      let sharesToSell = group.totalShares;

      for (const { sigType, funderAddr } of attempts) {
        try {
          const client = new ClobClient('https://clob.polymarket.com', 137, wallet, apiCreds, sigType, funderAddr);
          let ts = group.tickSize;
          try { const mt = await client.getTickSize(String(tokenId)); if (mt != null) ts = polyTickSizeSupported(String(mt)); } catch (_) {}
          const priceRounded = roundPriceToTick(sellPrice, ts);

          // Try selling, and if balance error, parse actual balance and retry
          for (let attempt = 0; attempt < 2; attempt++) {
            const userOrder = { tokenID: String(tokenId), price: priceRounded, size: sharesToSell, side: Side.SELL };
            const response = await client.createAndPostOrder(userOrder, { negRisk: group.negRisk, tickSize: ts }, OrderType.FOK);
            const responseErr = response?.error || response?.errorMsg;
            if (responseErr) {
              const errStr = String(responseErr);
              // Parse actual balance from error: "balance: 49685000, order amount: 50000000"
              const balMatch = errStr.match(/balance:\s*(\d+)/);
              if (balMatch && attempt === 0) {
                const actualBalance = parseInt(balMatch[1], 10);
                const actualShares = Math.floor(actualBalance / 1000000); // 1 share = 1e6 units
                if (actualShares > 0 && actualShares < sharesToSell) {
                  console.log(`[SELL-ALL] ${gameKey}: balance ${actualBalance} → retrying with ${actualShares} shares (was ${sharesToSell})`);
                  sharesToSell = actualShares;
                  continue; // retry with corrected share count
                }
              }
              lastErr = new Error(errStr);
              if (/invalid signature/i.test(errStr)) break; // try next sigType
              results.push({ gameKey, tokenId, shares: sharesToSell, sellPrice: priceRounded, status: 'error', error: errStr });
              sold = false;
              break;
            }
            // Success
            for (const pos of group.positions) {
              updateArbHistoryEntry(pos.id, { status: 'sold-early', soldAt: Date.now(), sellPrice: priceRounded });
              autoArbEngine.openPositions.delete(pos.id);
            }
            results.push({ gameKey, tokenId, shares: sharesToSell, sellPrice: priceRounded, status: 'sold', orderId: response?.orderID || response?.id, positionCount: group.positions.length });
            sold = true;
            break;
          }
          if (sold) break;
          if (lastErr && !/invalid signature/i.test(lastErr.message || '')) break;
        } catch (e) {
          lastErr = e;
          if (/invalid signature/i.test(e.message || '')) continue;
          results.push({ gameKey, tokenId, shares: sharesToSell, sellPrice, status: 'error', error: e.message });
          break;
        }
      }
      if (!sold && !results.find(r => r.tokenId === tokenId)) {
        results.push({ gameKey, tokenId, shares: sharesToSell, sellPrice, status: 'error', error: lastErr?.message || 'All signature attempts failed' });
      }
    }

    console.log('[SELL-ALL] Results:', JSON.stringify(results, null, 2));
    return res.json({ message: `Processed ${results.length} token groups from ${sellable.length} positions`, results });
  } catch (err) {
    console.error('Sell-all error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// Place order on Polymarket (requires session polyCreds). Uses proxy as funder when email/Magic sign-in.
app.post('/api/polymarket/order', async (req, res) => {
  const poly = await getPolyWalletAndFunder(req);
  if (!poly) return res.status(401).json({ error: 'Not signed in to Polymarket' });

  const { tokenId, side, price, size: sizeRaw, sizeInDollars } = req.body || {};
  if (!tokenId || !side || price == null) {
    return res.status(400).json({ error: 'Missing tokenId, side, or price' });
  }
  const priceNum = Number(price);
  if (!Number.isFinite(priceNum) || priceNum <= 0 || priceNum >= 1) {
    return res.status(400).json({ error: 'Price must be between 0 and 1' });
  }
  // CLOB size is in shares (outcome tokens), not USD. Optionally accept sizeInDollars and convert.
  let size = sizeRaw != null ? Number(sizeRaw) : NaN;
  if (sizeInDollars != null && Number.isFinite(Number(sizeInDollars))) {
    size = Number(sizeInDollars) / priceNum;
  }
  if (!Number.isFinite(size) || size <= 0) {
    return res.status(400).json({ error: 'Missing or invalid size (shares), or sizeInDollars' });
  }
  const notionalUsd = priceNum * Number(size);
  if (notionalUsd < 1) {
    return res.status(400).json({
      error: `Polymarket minimum order notional is $1. Your order is $${notionalUsd.toFixed(2)}. Increase size or use at least $1 notional.`,
    });
  }

  try {
    const { ClobClient, Side, OrderType } = await import('@polymarket/clob-client');
    const { wallet, apiCreds, funder } = poly;
    const isProxy = funder !== wallet.address.toLowerCase();
    // Always try EOA (sig 0) first — proxy sig has no on-chain USDC in the GnosisSafe proxy wallet.
    const attempts = [
      { sigType: 0, funderAddr: wallet.address },
      ...(isProxy ? [{ sigType: 1, funderAddr: funder }, { sigType: 2, funderAddr: funder }] : [{ sigType: 1, funderAddr: wallet.address }, { sigType: 2, funderAddr: wallet.address }]),
    ];

    const tokenIdStr = normalizePolyTokenId(tokenId) || String(tokenId).trim();
    if (!tokenIdStr) return res.status(400).json({ error: 'Invalid or missing token id' });
    const negRisk = Boolean(req.body.negRisk);
    const sideVal = (side || '').toUpperCase() === 'SELL' ? Side.SELL : Side.BUY;
    const sizeNum = Number(size);
    const userOrder = { tokenID: tokenIdStr, price: priceNum, size: sizeNum, side: sideVal };
    const optionsBase = { negRisk };

    let lastErr = null;
    for (const { sigType, funderAddr } of attempts) {
      const client = new ClobClient(
        'https://clob.polymarket.com',
        137,
        wallet,
        apiCreds,
        sigType,
        funderAddr
      );
      try { await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL }); } catch (_) {}
      let tickSize = String(req.body.tickSize ?? '0.01');
      try {
        const minTick = await client.getTickSize(tokenIdStr);
        if (minTick != null) tickSize = polyTickSizeSupported(String(minTick));
      } catch (tickErr) {
        const tickMsg = tickErr?.response?.data?.error || tickErr?.message || '';
        if (/orderbook.*does not exist|does not exist/i.test(tickMsg)) {
          return res.status(400).json({
            error: "This market's orderbook no longer exists — the game may have started or the market closed.",
            fix: 'Try a different game that has not started yet, or refresh the page to get the latest odds.',
          });
        }
      }
      if (!POLY_SUPPORTED_TICK_SIZES.includes(tickSize)) tickSize = polyTickSizeSupported(tickSize);
      userOrder.price = roundPriceToTick(userOrder.price, tickSize);
      const options = { ...optionsBase, tickSize };
      try {
        const response = await client.createAndPostOrder(userOrder, options, OrderType.GTC);
        const responseErr = response?.error || response?.errorMsg;
        if (responseErr) {
          lastErr = Object.assign(new Error(String(responseErr)), { responseObj: response });
          if (/invalid signature/i.test(String(responseErr))) continue;
          throw lastErr;
        }
        console.log('\n=== ORDER RESPONSE ===', JSON.stringify(response, null, 2), '=== END ===\n');
        return res.json(response);
      } catch (err) {
        lastErr = err;
        const errMsg = err?.response?.data?.error || err?.message || '';
        const isInvalidSig = /invalid signature/i.test(errMsg);
        if (err?.response?.status === 401 || err?.response?.status === 403 || isInvalidSig) continue;
        throw err;
      }
    }
    const finalMsg = lastErr?.response?.data?.error || lastErr?.message || '';
    if (/invalid signature/i.test(finalMsg)) {
      return res.status(400).json({
        error: 'Invalid signature — the Polymarket SDK has a known bug with email/Google sign-in (proxy) accounts.',
        fix: 'Use a MetaMask wallet instead: create a new wallet, send USDC (Polygon) to it, derive an API key from that wallet, and sign in with those credentials. Leave Profile address blank.',
      });
    }
    throw lastErr;
  } catch (err) {
    const status = err?.response?.status ?? err?.status;
    const body = err?.response?.data;
    console.error('Polymarket order error:', err?.message, 'status:', status, 'body:', body);
    const msg =
      (body && typeof body.errorMsg === 'string' && body.errorMsg) ||
      (typeof err === 'object' && err != null && typeof err.error === 'string' && err.error) ||
      (body && typeof body.error === 'string' && body.error) ||
      (body && typeof body.message === 'string' && body.message) ||
      err?.message ||
      'Order failed';
    const isOrderbookMissing = /orderbook.*does not exist|does not exist/i.test(msg);
    if (isOrderbookMissing) {
      return res.status(400).json({
        error: "This market's orderbook no longer exists — the game may have started or the market closed.",
        fix: 'Try a different game that has not started yet, or refresh the page to get the latest odds.',
      });
    }
    const isAllowanceError = /not enough balance \/ allowance/i.test(msg);
    let balanceAllowance = null;
    let walletAddress = null;
    if (isAllowanceError) {
      console.log('\n========== NOT ENOUGH BALANCE/ALLOWANCE — checking what CLOB sees ==========');
      const polyErr = await getPolyWalletAndFunder(req);
      if (polyErr) {
        walletAddress = polyErr.funder;
        console.log('Funder address (where balance is checked):', walletAddress);
        try {
          const { ClobClient, AssetType } = await import('@polymarket/clob-client');
          const isProxy = polyErr.funder !== polyErr.wallet.address.toLowerCase();
          const client = new ClobClient('https://clob.polymarket.com', 137, polyErr.wallet, polyErr.apiCreds, isProxy ? 1 : 0, polyErr.funder);
          const bal = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
          const balanceUsdc = Number(BigInt(bal?.balance ?? 0)) / 1e6;
          const allowanceUsdc = Number(BigInt(bal?.allowance ?? 0)) / 1e6;
          balanceAllowance = { balanceUsdc, allowanceUsdc };
          console.log('CLOB balance (USDC):', balanceUsdc);
          console.log('CLOB allowance (USDC):', allowanceUsdc);
          console.log('========== end check ==========\n');
          await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL }).catch(() => {});
          await client.updateBalanceAllowance({ asset_type: AssetType.CONDITIONAL }).catch(() => {});
        } catch (e2) {
          console.log('CLOB balance/allowance fetch failed:', e2?.message);
          console.log('========== end check ==========\n');
        }
      } else {
        console.log('No polyCreds in session.');
        console.log('========== end check ==========\n');
      }
    }
    const fix = isAllowanceError
      ? balanceAllowance
        ? balanceAllowance.balanceUsdc === 0
          ? `Send USDC (Polygon) to ${walletAddress || 'your Polymarket profile address'}. If you use email/Google sign-in, add your profile address in Sign in → Profile address.`
          : `CLOB sees balance: $${balanceAllowance.balanceUsdc.toFixed(2)} USDC, allowance: $${balanceAllowance.allowanceUsdc.toFixed(2)}. If allowance is $0, click Enable USDC and retry.`
        : `Orders use ${walletAddress || 'your profile address'} — it must hold USDC on Polygon. If you use email sign-in, add your Polymarket profile address in Sign in.`
      : undefined;
    res.status(status === 403 ? 403 : status === 401 ? 401 : 500).json({
      error: msg,
      detail: body,
      ...(balanceAllowance && { balanceAllowance }),
      ...(walletAddress && { walletAddress }),
      ...(fix && { fix }),
    });
  }
});

// Normalize PEM: if base64 was pasted as one line, split into 64-char lines so Node can decode it
function normalizePem(pem) {
  if (!pem || typeof pem !== 'string') return pem;
  const trimmed = pem.trim();
  const beginIdx = trimmed.indexOf('-----BEGIN');
  const endIdx = trimmed.indexOf('-----END');
  if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) return pem;
  const afterBegin = trimmed.indexOf('\n', beginIdx) + 1;
  const body = trimmed.slice(afterBegin, endIdx).replace(/\s+/g, '');
  if (body.length === 0) return pem;
  const header = trimmed.slice(beginIdx, afterBegin);
  const footer = trimmed.slice(endIdx);
  const lines = [];
  for (let i = 0; i < body.length; i += 64) lines.push(body.slice(i, i + 64));
  return header + lines.join('\n') + '\n' + footer;
}

// Kalshi: sign request (timestamp + method + path) with RSA-PSS SHA-256
function kalshiSign(privateKeyPem, timestamp, method, pathStr) {
  const message = timestamp + method + pathStr;
  let key;
  try {
    const normalized = normalizePem(privateKeyPem);
    key = crypto.createPrivateKey(normalized);
  } catch (err) {
    const msg = err.message || '';
    if (/DECODER|unsupported|PEM|format/i.test(msg)) {
      throw new Error('Invalid Kalshi private key. Re-sign in and paste the full PEM including -----BEGIN RSA PRIVATE KEY----- and -----END RSA PRIVATE KEY----- on their own lines.');
    }
    throw err;
  }
  const sig = crypto.sign('RSA-SHA256', Buffer.from(message, 'utf8'), {
    key,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });
  return sig.toString('base64');
}

// Place order on Kalshi (requires session kalshiCreds)
app.post('/api/kalshi/order', async (req, res) => {
  const creds = req.session?.kalshiCreds;
  if (!creds) return res.status(401).json({ error: 'Not signed in to Kalshi' });

  const { ticker, side, count, yes_price, client_order_id } = req.body || {};
  if (!ticker || !side || count == null) {
    return res.status(400).json({ error: 'Missing ticker, side, or count' });
  }

  const path = '/trade-api/v2/portfolio/orders';
  const baseUrl = process.env.KALSHI_API_BASE || 'https://api.elections.kalshi.com';
  const fullUrl = `${baseUrl}${path}`;
  const timestamp = String(Date.now());
  const signature = kalshiSign(creds.privateKey, timestamp, 'POST', path);

  const body = {
    ticker,
    action: 'buy',
    side: side.toLowerCase() === 'yes' ? 'yes' : 'no',
    count: Number(count),
    type: 'limit',
    yes_price: Math.min(99, Math.max(1, Math.round(Number(yes_price ?? 50)))),
    client_order_id: client_order_id || crypto.randomUUID(),
  };

  try {
    const orderRes = await fetch(fullUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'KALSHI-ACCESS-KEY': creds.apiKeyId,
        'KALSHI-ACCESS-TIMESTAMP': timestamp,
        'KALSHI-ACCESS-SIGNATURE': signature,
      },
      body: JSON.stringify(body),
    });
    const data = await orderRes.json().catch(() => ({}));
    if (!orderRes.ok) {
      const errMsg = typeof data.error === 'string' ? data.error : data.message || (data.error && (data.error.message || JSON.stringify(data.error))) || orderRes.statusText;
      return res.status(orderRes.status).json({ error: errMsg });
    }
    res.json(data);
  } catch (err) {
    console.error('Kalshi order error:', err);
    res.status(500).json({ error: err.message || 'Order failed' });
  }
});

// ── Live Arb Engine API ───────────────────────────────────────────────────────
app.get('/api/arb/engine/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  arbEngine.sseClients.add(res);
  res.write(`data: ${JSON.stringify({ type: 'state', running: arbEngine.running, stats: arbEngine.stats, config: arbEngine.config, ts: Date.now() })}\n\n`);
  req.on('close', () => arbEngine.sseClients.delete(res));
});

app.get('/api/value/opportunities', async (req, res) => {
  try {
    const base = `${req.protocol}://${req.get('host')}`;
    const cookie = req.headers.cookie || '';
    const [polyRes, sharpGames] = await Promise.all([
      fetch(`${base}/api/polymarket`, { headers: { cookie } }),
      fetchSharpOdds(),
    ]);
    const polyData = await polyRes.json().catch(() => ({ games: [] }));
    const opportunities = detectValueOpportunities(polyData.games || [], sharpGames);
    res.json({
      opportunities,
      sharpCacheAge: sharpOddsCache ? Math.round((Date.now() - sharpOddsCache.fetchedAt) / 1000) : null,
      config: { minEdge: VALUE_MIN_EDGE, maxPositionUsd: VALUE_MAX_POSITION_USD, orderSizeUsd: VALUE_ORDER_SIZE_USD },
    });
  } catch (err) {
    res.status(500).json({ error: err.message, opportunities: [] });
  }
});

app.post('/api/arb/engine/start', (req, res) => {
  if (!req.session?.polyCreds) {
    return res.status(401).json({ error: 'Sign in to Polymarket first' });
  }
  if (arbEngine.running) return res.json({ ok: true, message: 'Engine already running' });
  const cfg = req.body?.config || {};
  if (cfg.orderSizeUsd != null) arbEngine.config.orderSizeUsd = Number(cfg.orderSizeUsd);
  if (cfg.intervalMs != null) arbEngine.config.intervalMs = Number(cfg.intervalMs);
  if (cfg.cooldownMs != null) arbEngine.config.cooldownMs = Number(cfg.cooldownMs);
  if (cfg.maxPositionUsd != null) arbEngine.config.maxPositionUsd = Number(cfg.maxPositionUsd);
  if (cfg.minEdge != null) arbEngine.config.minEdge = Number(cfg.minEdge);
  if (cfg.circuitBreakerPolyUsd != null) arbEngine.config.circuitBreakerPolyUsd = Number(cfg.circuitBreakerPolyUsd);
  arbEngine.credsPoly = req.session.polyCreds;
  arbEngine.polyFunder = req.session.polyFunder || null;
  arbEngine._sessionId = req.sessionID;
  arbEngine.stats = { betsPlaced: 0, betsAttempted: 0, totalStakedUsd: 0, totalEdgeCapture: 0 };
  arbEngine.cooldowns.clear();
  arbEngine.positionMap.clear();
  arbEngine.running = true;
  arbEngine.startedAt = Date.now();
  arbEngine.timerId = setInterval(runValueEngineIteration, arbEngine.config.intervalMs);
  broadcastEngineEvent('started', { config: arbEngine.config });
  console.log('[ValueEngine] started — orderSize $' + arbEngine.config.orderSizeUsd + ', interval ' + arbEngine.config.intervalMs + 'ms');
  res.json({ ok: true, config: arbEngine.config });
});

app.post('/api/arb/engine/stop', (req, res) => {
  stopArbEngine('User requested stop');
  res.json({ ok: true, stats: arbEngine.stats });
});

// ── Auto-Arb Engine API ───────────────────────────────────────────────────────
app.get('/api/arb/auto/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  autoArbEngine.sseClients.add(res);
  // Send initial state with open positions — merge in-memory engine positions + arb-history "placed"
  // This ensures positions survive both page reloads AND server restarts
  const now = Date.now();
  const positionMap = new Map(); // positionId → position data (deduped)

  // 1. In-memory engine positions (most up-to-date if engine is/was running)
  for (const [id, pos] of autoArbEngine.openPositions) {
    positionMap.set(id, {
      type: 'placed', gameKey: pos.gameKey, awayTeam: pos.awayTeam, homeTeam: pos.homeTeam,
      strategyLabel: pos.strategyLabel, stakePolyUsd: pos.stakePolyUsd, stakeKalshiUsd: pos.stakeKalshiUsd,
      netProfitUsd: pos.netProfitUsd, polyPrice: pos.entryPolyPrice, kalshiYesPriceCents: pos.entryKalshiCents,
      positionId: id, ts: pos.placedAt, simulate: pos.simulate || false,
    });
  }

  // 2. Arb-history "placed" entries (survives server restarts)
  for (const h of readArbHistory()) {
    if (h.status !== 'placed') continue;
    if (positionMap.has(h.id)) continue; // already have from engine
    // Filter out ended games
    const game = polyGamesState.get(h.gameKey);
    if (game) {
      const statusText = (game.gameStatusText || '').toLowerCase();
      if (statusText.includes('final')) continue;
    }
    const startDate = game?.startDate ? new Date(game.startDate) : null;
    if (startDate && !isNaN(startDate) && now - startDate.getTime() > 4 * 60 * 60 * 1000) continue;
    if (!game && now - h.placedAt > 5 * 60 * 60 * 1000) continue;
    positionMap.set(h.id, {
      type: 'placed', gameKey: h.gameKey, awayTeam: h.awayTeam, homeTeam: h.homeTeam,
      strategyLabel: h.strategyLabel, stakePolyUsd: h.stakePolyUsd, stakeKalshiUsd: h.stakeKalshiUsd,
      netProfitUsd: h.netProfitUsd, polyPrice: h.polyPrice, kalshiYesPriceCents: h.kalshiYesPriceCents,
      positionId: h.id, ts: h.placedAt, simulate: false,
    });
  }

  const historyPositions = [...positionMap.values()];
  const historyStats = { placed: historyPositions.length, failed: autoArbEngine.stats.failed || 0, totalProfitUsd: historyPositions.reduce((s, p) => s + (p.netProfitUsd || 0), 0) };
  const effectiveStats = autoArbEngine.running ? autoArbEngine.stats : historyStats;
  res.write(`data: ${JSON.stringify({ type: 'state', running: autoArbEngine.running, stats: effectiveStats, wsPolyConnected: polyWs?.readyState === 1, wsKalshiConnected: kalshiWs?.readyState === 1, openPositions: historyPositions, ts: Date.now() })}\n\n`);
  req.on('close', () => autoArbEngine.sseClients.delete(res));
});

app.post('/api/arb/auto/start', async (req, res) => {
  const { simulate = false, simBalancePoly = 1000, simBalanceKal = 1000, maxStakeUsd, exitThreshold, sport = 'nba' } = req.body || {};
  if (!simulate) {
    if (!req.session?.polyCreds) return res.status(401).json({ error: 'Sign in to Polymarket first' });
    if (!req.session?.kalshiCreds) return res.status(401).json({ error: 'Sign in to Kalshi first' });
    // Pre-flight: log allowance state but don't block. The CLOB's getBalanceAllowance can
    // return 0 even when on-chain allowance is fine (sigType-dependent caching), so blocking
    // here yields false positives. The order layer retries through all sigTypes anyway.
    const allowance = await checkPolyAllowance(req.session.polyCreds, req.session.polyFunder);
    if (allowance && !allowance.ok && allowance.balanceUsdc > 0) {
      console.warn('[AutoArb] Allowance check warning:', allowance.hint);
    }
  }
  if (autoArbEngine.running) return res.json({ ok: true, message: 'Auto-arb engine already running' });
  autoArbEngine.simulate = Boolean(simulate);
  autoArbEngine.sport = ['nba', 'cs2', 'both'].includes(sport) ? sport : 'nba';
  autoArbEngine.simBalancePoly = Number(simBalancePoly) || 1000;
  autoArbEngine.simBalanceKal  = Number(simBalanceKal)  || 1000;
  autoArbEngine.maxStakeUsd = maxStakeUsd != null ? Math.max(1, Number(maxStakeUsd)) : ARB_MAX_STAKE_USD;
  autoArbEngine.exitThreshold = exitThreshold != null ? Math.max(0.5, Math.min(2.0, Number(exitThreshold))) : 1.00;
  autoArbEngine.credsPoly = req.session?.polyCreds || null;
  autoArbEngine.credsKal  = req.session?.kalshiCreds || null;
  autoArbEngine.polyFunder = req.session?.polyFunder || null;
  autoArbEngine.cooldowns.clear();
  // Hydrate openPositions from arb-history (don't clear — keep existing positions for early exit)
  // Skip positions older than 5h — those games are over
  const history = readArbHistory();
  const nowMs = Date.now();
  for (const h of history) {
    if (h.status !== 'placed' || autoArbEngine.openPositions.has(h.id)) continue;
    if (nowMs - h.placedAt > 5 * 60 * 60 * 1000) continue;
    autoArbEngine.openPositions.set(h.id, {
      id: h.id, gameKey: h.gameKey, awayTeam: h.awayTeam, homeTeam: h.homeTeam,
      strategyLabel: h.strategyLabel, strategy: h.strategy,
      entryPolyPrice: h.polyPrice, entryKalshiCents: h.kalshiYesPriceCents,
      polyShares: h.polyShares || Math.max(1, Math.floor(h.stakePolyUsd / h.polyPrice)),
      kalshiCount: h.kalshiCount || Math.max(1, Math.floor(h.stakeKalshiUsd / (h.kalshiYesPriceCents / 100))),
      polyTokenId: h.polyTokenId, polyTickSize: h.polyTickSize || '0.01', polyNegRisk: h.polyNegRisk || false,
      kalshiTicker: h.kalshiTicker, kalshiSide: h.kalshiSide || 'yes',
      stakePolyUsd: h.stakePolyUsd, stakeKalshiUsd: h.stakeKalshiUsd,
      netProfitUsd: h.netProfitUsd, simulate: false, placedAt: h.placedAt,
    });
  }
  console.log(`[AutoArb] Hydrated ${autoArbEngine.openPositions.size} open positions from history`);
  autoArbEngine.stats = { placed: autoArbEngine.openPositions.size, failed: 0, totalProfitUsd: 0 };
  autoArbEngine.running = true;
  autoArbEngine.startedAt = Date.now();
  if (!autoArbEngine._exitIntervalId) autoArbEngine._exitIntervalId = setInterval(() => { checkEarlyExits(); broadcastLivePnL(); }, 3000);
  autoArbEngine._orderMonitorId = setInterval(() => monitorOpenOrders(), 30000);
  if (!simulate && req.session?.kalshiCreds) connectKalshiWS(req.session.kalshiCreds);

  // For CS2/both: immediately load CS2 markets and refresh every 60s
  if (autoArbEngine.sport === 'cs2' || autoArbEngine.sport === 'both') {
    const base = `http://localhost:${PORT}`;
    const cookie = req.headers.cookie || '';
    const refreshCS2 = async () => {
      if (!autoArbEngine.running) return;
      try { await Promise.all([
        fetch(`${base}/api/cs2/polymarket`, { headers: { cookie } }),
        fetch(`${base}/api/cs2/kalshi`, { headers: { cookie } }),
      ]); } catch (_) {}
    };
    refreshCS2();
    autoArbEngine._cs2RefreshId = setInterval(refreshCS2, 60000);
  }

  broadcastAutoArbEvent('started', { simulate: autoArbEngine.simulate, sport: autoArbEngine.sport, simBalancePoly: autoArbEngine.simBalancePoly, simBalanceKal: autoArbEngine.simBalanceKal, stats: autoArbEngine.stats });
  console.log(`[AutoArb] Engine started (${autoArbEngine.simulate ? 'SIMULATION' : 'REAL'}, sport=${autoArbEngine.sport}, exit≥${autoArbEngine.exitThreshold})`);
  res.json({ ok: true, simulate: autoArbEngine.simulate, sport: autoArbEngine.sport });
});

app.post('/api/arb/auto/stop', (req, res) => {
  autoArbEngine.running = false;
  // Keep _exitIntervalId running so early exits still fire for open positions
  if (autoArbEngine._cs2RefreshId) { clearInterval(autoArbEngine._cs2RefreshId); autoArbEngine._cs2RefreshId = null; }
  if (autoArbEngine._orderMonitorId) { clearInterval(autoArbEngine._orderMonitorId); autoArbEngine._orderMonitorId = null; }
  // Do NOT clear openPositions — we need them for early exit checks
  broadcastAutoArbEvent('stopped', { stats: autoArbEngine.stats });
  console.log('[AutoArb] Engine stopped (keeping open positions for early exit monitoring)');
  res.json({ ok: true, stats: autoArbEngine.stats, openPositions: autoArbEngine.openPositions.size });
});

app.get('/api/arb/auto/status', (req, res) => {
  res.json({
    running: autoArbEngine.running,
    startedAt: autoArbEngine.startedAt,
    stats: autoArbEngine.stats,
    simulate: autoArbEngine.simulate,
    sport: autoArbEngine.sport,
    simBalancePoly: autoArbEngine.simBalancePoly,
    simBalanceKal: autoArbEngine.simBalanceKal,
    exitThreshold: autoArbEngine.exitThreshold,
    openPositionCount: autoArbEngine.openPositions.size,
    wsPolyConnected: polyWs?.readyState === 1,
    wsKalshiConnected: kalshiWs?.readyState === 1,
  });
});
// ─────────────────────────────────────────────────────────────────────────────

// ── Real-time P&L tracker ─────────────────────────────────────────────────────
// GET /api/pnl
// Returns per-arb P&L: current value of each leg vs original stake, unrealized P&L, best-exit hint.
app.get('/api/pnl', async (req, res) => {
  if (!req.session?.polyCreds && !req.session?.kalshiCreds) {
    return res.status(401).json({ error: 'Not signed in' });
  }

  const arbHistoryItems = readArbHistory();
  if (!arbHistoryItems.length) return res.json({ positions: [] });

  // 1. Fetch Polymarket trades (both as maker AND taker — limit orders fill as maker, market orders as taker)
  let polyTrades = [];
  const poly = await getPolyWalletAndFunder(req);
  if (poly) {
    try {
      const { ClobClient } = await import('@polymarket/clob-client');
      const { wallet, apiCreds, funder } = poly;
      const addr = funder || wallet.address;
      const isProxy = funder !== wallet.address.toLowerCase();
      const client = new ClobClient('https://clob.polymarket.com', 137, wallet, apiCreds, isProxy ? 1 : 0, funder);
      const [makerRes, takerRes] = await Promise.allSettled([
        client.getTrades({ maker_address: addr }),
        client.getTrades({ taker_address: addr }),
      ]);
      const makerList = makerRes.status === 'fulfilled' && Array.isArray(makerRes.value) ? makerRes.value : [];
      const takerList = takerRes.status === 'fulfilled' && Array.isArray(takerRes.value) ? takerRes.value : [];
      const tradeMap = new Map([...makerList, ...takerList].map((t) => [t.id, t]));
      polyTrades = [...tradeMap.values()].slice(0, 100);
    } catch (_) {}
  }

  // 2. Fetch Polymarket midpoint prices for all traded token_ids
  let polyPriceMap = {};
  const allTokenIds = [...new Set(polyTrades.map((t) => t.asset_id).filter(Boolean))];
  try {
    if (allTokenIds.length) {
      const priceRes = await fetch(
        `https://clob.polymarket.com/midpoints?token_ids=${allTokenIds.join(',')}`,
        fetchOptions
      );
      const priceData = await priceRes.json();
      for (const [k, v] of Object.entries(priceData || {})) {
        const parsed = parseFloat(v?.mid ?? v ?? 0);
        if (!isNaN(parsed) && parsed > 0) polyPriceMap[k] = parsed;
      }
    }
  } catch (_) {}

  // 2b. Filter out meaningless 50¢ midpoints (happens when book is empty/wide: bid=0, ask=1).
  //     Replace with actual book mid or null for settled/illiquid markets.
  for (const id of Object.keys(polyPriceMap)) {
    const mid = polyPriceMap[id];
    if (mid >= 0.48 && mid <= 0.52) {
      // Suspicious 50¢ — verify with the actual orderbook
      try {
        const bookRes = await fetch(`https://clob.polymarket.com/book?token_id=${id}`, fetchOptions);
        if (bookRes.ok) {
          const book = await bookRes.json();
          const bid = parseFloat(book.bids?.[0]?.price ?? 0);
          const ask = parseFloat(book.asks?.[0]?.price ?? 0);
          if (bid > 0 && ask > 0 && Math.abs(ask - bid) < 0.30) {
            // Real tight spread — trust it
            polyPriceMap[id] = (bid + ask) / 2;
          } else if (bid > 0.55 || ask < 0.45) {
            // Book heavily one-sided — use best available
            polyPriceMap[id] = bid > 0.55 ? bid : ask;
          } else {
            // Wide/empty book — price is unreliable, mark as null so we show "awaiting settlement"
            delete polyPriceMap[id];
          }
        } else {
          delete polyPriceMap[id];
        }
      } catch (_) {
        delete polyPriceMap[id];
      }
    }
  }

  // For tokens still missing (not in midpoints at all), try the orderbook
  const missingIds = allTokenIds.filter((id) => polyPriceMap[id] == null);
  if (missingIds.length) {
    await Promise.all(missingIds.map(async (id) => {
      try {
        const bookRes = await fetch(`https://clob.polymarket.com/book?token_id=${id}`, fetchOptions);
        if (bookRes.ok) {
          const book = await bookRes.json();
          const bid = parseFloat(book.bids?.[0]?.price ?? 0);
          const ask = parseFloat(book.asks?.[0]?.price ?? 0);
          if (bid > 0 && ask > 0 && Math.abs(ask - bid) < 0.30) {
            polyPriceMap[id] = (bid + ask) / 2;
          } else if (bid > 0.6) {
            polyPriceMap[id] = bid;
          } else if (ask > 0 && ask < 0.40) {
            polyPriceMap[id] = ask;
          }
        }
      } catch (_) {}
    }));
  }

  // 3. Fetch Kalshi positions
  let kalshiPositions = [];
  if (req.session?.kalshiCreds) {
    try {
      const creds = req.session.kalshiCreds;
      const path = '/trade-api/v2/portfolio/positions';
      const baseUrl = process.env.KALSHI_API_BASE || 'https://api.elections.kalshi.com';
      const timestamp = String(Date.now());
      const signature = kalshiSign(creds.privateKey, timestamp, 'GET', path);
      const posRes = await fetch(`${baseUrl}${path}?limit=100`, {
        method: 'GET',
        headers: {
          'KALSHI-ACCESS-KEY': creds.apiKeyId,
          'KALSHI-ACCESS-TIMESTAMP': timestamp,
          'KALSHI-ACCESS-SIGNATURE': signature,
        },
      });
      if (posRes.ok) {
        const posData = await posRes.json().catch(() => ({}));
        kalshiPositions = posData.market_positions || posData.positions || [];
      }
    } catch (_) {}
  }

  // Build a map: kalshi ticker -> position data
  const kalshiPosMap = new Map();
  for (const pos of kalshiPositions) {
    const ticker = pos.ticker || pos.market_ticker || '';
    if (ticker) kalshiPosMap.set(ticker, pos);
  }

  // 3a. Build order_id → ticker map by fetching portfolio orders
  // This lets us match Kalshi positions by exact order ID instead of fuzzy team-name
  const kalOrderIdToTicker = new Map();
  if (req.session?.kalshiCreds) {
    try {
      const creds = req.session.kalshiCreds;
      const baseUrl = process.env.KALSHI_API_BASE || 'https://api.elections.kalshi.com';
      const ordPath = '/trade-api/v2/portfolio/orders';
      const ts2 = String(Date.now());
      const sig2 = kalshiSign(creds.privateKey, ts2, 'GET', ordPath);
      const ordRes = await fetch(`${baseUrl}${ordPath}?limit=100&status=all`, {
        headers: {
          'KALSHI-ACCESS-KEY': creds.apiKeyId,
          'KALSHI-ACCESS-TIMESTAMP': ts2,
          'KALSHI-ACCESS-SIGNATURE': sig2,
          'Content-Type': 'application/json',
        },
      });
      if (ordRes.ok) {
        const ordData = await ordRes.json().catch(() => ({}));
        const orders = ordData.orders || [];
        for (const o of orders) {
          if (o.order_id && (o.ticker || o.market_ticker)) {
            kalOrderIdToTicker.set(o.order_id, o.ticker || o.market_ticker);
          }
        }
      }
    } catch (_) {}
  }

  // 3b. Fetch LIVE bid/ask prices for each Kalshi NBA ticker individually.
  // The batch ?tickers= param is unreliable; individual GET /markets/{ticker} is authoritative.
  const kalshiLivePriceMap = new Map(); // ticker -> mid price in cents
  const nbaTickers = [...kalshiPosMap.keys()].filter((t) => t.startsWith('KXNBAGAME-'));
  if (nbaTickers.length && req.session?.kalshiCreds) {
    const creds = req.session.kalshiCreds;
    const baseUrl = process.env.KALSHI_API_BASE || 'https://api.elections.kalshi.com';

    function kalshiMarketMid(m) {
      if (!m) return null;
      const isResolved = ['settled', 'finalized', 'determined'].includes((m.status || '').toLowerCase());
      if (isResolved) {
        const result = (m.result || '').toLowerCase();
        if (result === 'yes') return 100;
        if (result === 'no') return 0;
        return null;
      }
      // Kalshi API v2 returns prices as _dollars strings (e.g. "0.8900") not integer cents
      let yesBid, yesAsk;
      if (m.yes_bid_dollars != null) {
        yesBid = Math.round(parseFloat(m.yes_bid_dollars) * 100);
        yesAsk = Math.round(parseFloat(m.yes_ask_dollars) * 100);
      } else {
        // Fallback: old integer cent fields
        yesBid = m.yes_bid ?? 0;
        yesAsk = m.yes_ask ?? 100;
      }
      if (yesBid === 0 && yesAsk === 100) return null; // no live market
      return Math.round((yesBid + yesAsk) / 2);
    }

    await Promise.all(nbaTickers.slice(0, 15).map(async (ticker) => {
      try {
        const mktPath = `/trade-api/v2/markets/${encodeURIComponent(ticker)}`;
        const ts = String(Date.now());
        const sig = kalshiSign(creds.privateKey, ts, 'GET', `/trade-api/v2/markets/${ticker}`);
        const mktRes = await fetch(`${baseUrl}${mktPath}`, {
          headers: {
            'KALSHI-ACCESS-KEY': creds.apiKeyId,
            'KALSHI-ACCESS-TIMESTAMP': ts,
            'KALSHI-ACCESS-SIGNATURE': sig,
            'Content-Type': 'application/json',
          },
        });
        if (mktRes.ok) {
          const mktData = await mktRes.json().catch(() => ({}));
          const m = mktData.market || mktData;
          const mid = kalshiMarketMid(m);
          if (mid != null) kalshiLivePriceMap.set(ticker, mid);
        }
      } catch (_) {}
    }));
  }

  // 4. Build P&L per arb history entry
  const TRICODE_TO_NICKNAME_PNL = {
    ATL:'HAWKS', BOS:'CELTICS', BKN:'NETS', CHA:'HORNETS',
    CHI:'BULLS', CLE:'CAVALIERS', DAL:'MAVERICKS', DEN:'NUGGETS',
    DET:'PISTONS', GSW:'WARRIORS', HOU:'ROCKETS', IND:'PACERS',
    LAC:'CLIPPERS', LAL:'LAKERS', MEM:'GRIZZLIES', MIA:'HEAT',
    MIL:'BUCKS', MIN:'TIMBERWOLVES', NOP:'PELICANS', NYK:'KNICKS',
    OKC:'THUNDER', ORL:'MAGIC', PHI:'76ERS', PHX:'SUNS',
    POR:'TRAIL BLAZERS', SAC:'KINGS', SAS:'SPURS', TOR:'RAPTORS',
    UTA:'JAZZ', WAS:'WIZARDS',
  };
  function outcomeMatchesTri(outcome, tri) {
    if (!outcome || !tri) return false;
    const o = outcome.toUpperCase();
    const t = tri.toUpperCase();
    if (o.includes(t) || t.includes(o)) return true;
    const nick = TRICODE_TO_NICKNAME_PNL[t];
    return nick ? (o.includes(nick) || nick.includes(o)) : false;
  }

  const positions = arbHistoryItems.map((h) => {
    const away = (h.awayTeam || '').toUpperCase();
    const home = (h.homeTeam || '').toUpperCase();

    // Match poly trade: prefer exact order-ID match, fall back to team-name match
    const polyTrade =
      (h.polyOrderId
        ? polyTrades.find((t) =>
            t.taker_order_id === h.polyOrderId || t.maker_order_id === h.polyOrderId
          )
        : null) ||
      polyTrades.find((t) =>
        t.outcome && (outcomeMatchesTri(t.outcome, away) || outcomeMatchesTri(t.outcome, home))
      );

    // Poly leg
    // Cost basis always comes from arb history (authoritative source).
    // Trade match is only used to get the asset_id for price lookup — never for share count.
    let polyCurrentValue = null;
    let polyOriginalStake = Number(h.stakePolyUsd) || 0;
    let polyEntryPrice = Number(h.polyPrice) || null;
    // Compute exact share count from what we actually paid
    const polyShares = (polyOriginalStake > 0 && polyEntryPrice > 0)
      ? polyOriginalStake / polyEntryPrice
      : 0;
    let polyAssetId = polyTrade ? polyTrade.asset_id : null;

    if (polyAssetId) {
      const mid = polyPriceMap[polyAssetId];
      if (mid != null && polyShares > 0) {
        polyCurrentValue = polyShares * mid;
      }
      // mid === null means market is settled (empty book, no midpoint) — show awaiting settlement
    }

    // Kalshi leg
    // Entry price from arb history (stored at placement time)
    let kalCurrentValue = null;
    let kalOriginalStake = Number(h.stakeKalshiUsd) || 0;
    // arb history stores it as kalshiYesPriceCents (integer) or kalshiPrice (0-1 float)
    let kalEntryPrice = h.kalshiYesPriceCents != null
      ? Number(h.kalshiYesPriceCents)
      : h.kalshiPrice != null ? Math.round(Number(h.kalshiPrice) * 100) : null;
    let kalCurrentPrice = null;
    let kalOrderId = h.kalshiOrderId || null;

    // First try to match position by the exact ticker resolved from the stored order ID
    let resolvedTicker = kalOrderIdToTicker.get(kalOrderId);

    // Search position map — prefer resolved ticker, fall back to team-name pattern
    for (const [ticker, pos] of kalshiPosMap) {
      const isExactMatch = resolvedTicker && ticker === resolvedTicker;
      if (!isExactMatch) {
        const mTicker = ticker.match(/KXNBAGAME-\d{2}[A-Z]{3}\d{2}([A-Z]{3})([A-Z]{3})/);
        if (!mTicker) continue;
        const tAway = mTicker[1];
        const tHome = mTicker[2];
        const matches = (tAway === away || tHome === home || away === tAway || home === tHome);
        if (!isExactMatch && !matches) continue;
      }

      let yesCount = Number(pos.position ?? pos.yes_position ?? pos.quantity ?? 0);
      // Fallback: if position API returns 0 (settled markets removed, or field name mismatch),
      // compute contract count from arb history: stake / (entryPrice / 100)
      if (yesCount === 0 && kalOriginalStake > 0 && kalEntryPrice != null && kalEntryPrice > 0) {
        yesCount = Math.round(kalOriginalStake / (kalEntryPrice / 100));
      }

      // Derive entry price from total_traded if not stored
      if (kalEntryPrice == null && pos.total_traded && yesCount > 0) {
        kalEntryPrice = Math.round(Number(pos.total_traded) / yesCount);
      }

      // Live current price from separately-fetched market data
      const liveMid = kalshiLivePriceMap.get(ticker);
      if (liveMid != null) {
        kalCurrentPrice = liveMid;
        kalCurrentValue = (yesCount * liveMid) / 100;
      } else if (pos.market_value != null) {
        kalCurrentValue = Number(pos.market_value) / 100;
        kalCurrentPrice = yesCount > 0 ? Math.round((kalCurrentValue * 100) / yesCount) : null;
      } else {
        // No live price available — show cost basis (no change)
        kalCurrentPrice = kalEntryPrice;
        kalCurrentValue = kalOriginalStake;
      }
      break;
    }

    if (kalCurrentValue === null && kalOriginalStake > 0) {
      // Position not found in portfolio (may have been resolved/settled)
      // Keep as null so we show n/a instead of a fake value
      kalCurrentValue = null;
    }

    const polyPnl = polyCurrentValue != null ? polyCurrentValue - polyOriginalStake : null;
    const kalPnl = kalCurrentValue != null ? kalCurrentValue - kalOriginalStake : null;
    // Only include legs where we have a real current value — don't inflate/deflate totals with nulls
    const knownCurrentValue =
      (polyCurrentValue != null ? polyCurrentValue : 0) +
      (kalCurrentValue != null ? kalCurrentValue : 0);
    const knownOriginalStake =
      (polyCurrentValue != null ? polyOriginalStake : 0) +
      (kalCurrentValue != null ? kalOriginalStake : 0);
    const totalStake = polyOriginalStake + kalOriginalStake;
    const unrealizedPnl = knownOriginalStake > 0 ? knownCurrentValue - knownOriginalStake : 0;

    // Best exit suggestion: if one leg is up >20% more than the other is down
    let bestExit = null;
    if (polyPnl != null && kalPnl != null && totalStake > 0) {
      const polyChangePct = polyOriginalStake > 0 ? (polyPnl / polyOriginalStake) * 100 : 0;
      const kalChangePct = kalOriginalStake > 0 ? (kalPnl / kalOriginalStake) * 100 : 0;
      if (polyChangePct - kalChangePct > 20) {
        bestExit = 'poly';
      } else if (kalChangePct - polyChangePct > 20) {
        bestExit = 'kalshi';
      }
    }

    // Recommendation logic
    const expectedProfit = h.netProfitUsd != null ? Number(h.netProfitUsd) : null;
    const polyAvailable = polyCurrentValue != null;
    const kalSettledFinal = kalCurrentPrice === 0 || kalCurrentPrice === 100;
    let recommendation = 'hold';
    let recommendationText = 'On track — hold for full arb profit at game end';

    if (kalSettledFinal) {
      // Game is over — direct user to redemption
      if (kalCurrentPrice === 100) {
        recommendation = 'close-both';
        recommendationText = 'Kalshi leg won ✓ — redeem your Polymarket position too';
      } else {
        recommendation = 'hold';
        recommendationText = 'Game over — check Polymarket to redeem the winning side';
      }
    } else if (!polyAvailable && kalCurrentPrice != null) {
      // Poly price unavailable (illiquid book) but game still live on Kalshi
      recommendation = 'hold';
      recommendationText = 'Hold — Polymarket book illiquid, await settlement';
    } else if (expectedProfit != null && expectedProfit > 0.1 && unrealizedPnl > expectedProfit * 1.5) {
      const pct = Math.round((unrealizedPnl / expectedProfit) * 100);
      recommendation = 'close-both';
      recommendationText = `Lock in early: you're at ${pct}% of target profit`;
    } else if (polyPnl != null && polyOriginalStake > 0 && polyPnl > polyOriginalStake * 0.35) {
      recommendation = 'sell-poly';
      recommendationText = 'Poly leg up significantly — sell for early profit';
    } else if (kalPnl != null && kalOriginalStake > 0 && kalPnl > kalOriginalStake * 0.35) {
      recommendation = 'sell-kalshi';
      recommendationText = 'Kalshi leg up significantly — sell';
    } else if (polyAvailable && totalStake > 0 && unrealizedPnl < -(totalStake * 0.30)) {
      // Only show cut-loss when we can see BOTH legs
      recommendation = 'cut-loss';
      recommendationText = 'Down over 30% — consider closing to limit losses';
    }

    return {
      gameKey: h.gameKey,
      awayTeam: h.awayTeam,
      homeTeam: h.homeTeam,
      strategyLabel: h.strategyLabel,
      placedAt: h.placedAt,
      polyOriginalStake: Math.round(polyOriginalStake * 100) / 100,
      polyCurrentValue: polyCurrentValue != null ? Math.round(polyCurrentValue * 100) / 100 : null,
      polyPnl: polyPnl != null ? Math.round(polyPnl * 100) / 100 : null,
      kalOriginalStake: Math.round(kalOriginalStake * 100) / 100,
      kalCurrentValue: kalCurrentValue != null ? Math.round(kalCurrentValue * 100) / 100 : null,
      kalPnl: kalPnl != null ? Math.round(kalPnl * 100) / 100 : null,
      unrealizedPnl: Math.round(unrealizedPnl * 100) / 100,
      bestExit,
      polyAssetId: polyAssetId || null,
      polySize: Math.round(polyShares * 100) / 100, // shares from cost basis (always accurate)
      polyEntryPrice: polyEntryPrice || null,
      polyCurrentPrice: polyAssetId ? (polyPriceMap[polyAssetId] ?? null) : null,
      polySettled: polyAssetId && polyPriceMap[polyAssetId] == null, // poly book empty/illiquid
      gameOver: kalCurrentPrice === 0 || kalCurrentPrice === 100, // market actually resolved on Kalshi
      kalOrderId: kalOrderId || null,
      kalEntryPrice: kalEntryPrice,
      kalCurrentPrice: kalCurrentPrice,
      expectedProfit: expectedProfit,
      recommendation,
      recommendationText,
    };
  });

  res.json({ positions });
});
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/arb/engine/status', (req, res) => {
  res.json({ running: arbEngine.running, startedAt: arbEngine.startedAt, stats: arbEngine.stats, config: arbEngine.config });
});

app.patch('/api/arb/engine/config', (req, res) => {
  const cfg = req.body || {};
  const needsRestart = cfg.intervalMs != null && cfg.intervalMs !== arbEngine.config.intervalMs;
  if (cfg.orderSizeUsd != null) arbEngine.config.orderSizeUsd = Number(cfg.orderSizeUsd);
  if (cfg.intervalMs != null) arbEngine.config.intervalMs = Number(cfg.intervalMs);
  if (cfg.cooldownMs != null) arbEngine.config.cooldownMs = Number(cfg.cooldownMs);
  if (cfg.maxPositionUsd != null) arbEngine.config.maxPositionUsd = Number(cfg.maxPositionUsd);
  if (cfg.minEdge != null) arbEngine.config.minEdge = Number(cfg.minEdge);
  if (cfg.circuitBreakerPolyUsd != null) arbEngine.config.circuitBreakerPolyUsd = Number(cfg.circuitBreakerPolyUsd);
  if (needsRestart && arbEngine.timerId) {
    clearInterval(arbEngine.timerId);
    arbEngine.timerId = setInterval(runValueEngineIteration, arbEngine.config.intervalMs);
  }
  broadcastEngineEvent('config_updated', { config: arbEngine.config });
  res.json({ ok: true, config: arbEngine.config });
});
// ─────────────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`NBA Odds Visualizer running at http://localhost:${PORT}`);
  connectPolymarketWS(); // start WS immediately; tokens subscribed lazily as games are fetched
});
