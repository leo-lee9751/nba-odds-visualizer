import express from 'express';
import cors from 'cors';
import session from 'express-session';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import fs from 'fs';

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

app.get('/api/arb-history', (req, res) => res.json(readArbHistory()));
app.delete('/api/arb-history', (req, res) => { writeArbHistory([]); res.json({ ok: true }); });
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
const POLYMARKET_CACHE_TTL_MS = 10000; // 10 seconds — keep odds fresh for live games

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

    res.json({ games });
  } catch (error) {
    console.error('Kalshi API error:', error.message);
    res.status(500).json({
      error: 'Kalshi API error - ' + error.message,
      games: [],
    });
  }
});

// ---------- Arbitrage (design: docs/ARBITRAGE_DESIGN.md) ----------
const ARB_MIN_PROFIT_USD = Number(process.env.ARB_MIN_PROFIT_USD) || 0.50;
const ARB_MAX_STAKE_USD = Number(process.env.ARB_MAX_STAKE_USD) || 50;
const ARB_MAX_STAKE_PER_ARB_USD = Number(process.env.ARB_MAX_STAKE_PER_ARB_USD) || ARB_MAX_STAKE_USD; // cap per arb so you can place multiple
const ARB_RESERVE_POLY_USD = Number(process.env.ARB_RESERVE_POLY_USD) || 0;
const ARB_RESERVE_KAL_USD = Number(process.env.ARB_RESERVE_KAL_USD) || 0;
const KALSHI_TAKER_FEE = 0.07; // 0.07 * C * P * (1-P) per contract

// ── Live Arb Engine ──────────────────────────────────────────────────────────
const arbEngine = {
  running: false,
  startedAt: null,
  config: {
    betSizeUsd: 2,
    intervalMs: 3000,
    cooldownMs: 30000,
    circuitBreakerPolyUsd: 5,
    circuitBreakerKalUsd: 5,
    maxBetsPerOpportunity: 10,
    kellyFraction: 0.25,
    priceImpactBpsPerDollar: 0.5,
  },
  stats: { betsPlaced: 0, betsAttempted: 0, totalStakedUsd: 0, expectedProfitUsd: 0 },
  cooldowns: new Map(),      // `${gameKey}-${strategy}` → timestamp of last bet
  marketImpact: new Map(),   // polyTokenId → { betsPlaced, estimatedPriceMove }
  sseClients: new Set(),
  timerId: null,
  credsPoly: null,
  credsKal: null,
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

async function runEngineIteration() {
  if (!arbEngine.running) return;
  const { credsPoly, credsKal, polyFunder, config: cfg } = arbEngine;
  if (!credsPoly || !credsKal) { stopArbEngine('Missing credentials'); return; }

  try {
    // Fetch odds + balances in parallel
    const [polyRes, kalRes] = await Promise.allSettled([
      fetch('http://localhost:3000/api/polymarket'),
      fetch('http://localhost:3000/api/kalshi'),
    ]);

    const polyData = polyRes.status === 'fulfilled' ? await polyRes.value.json().catch(() => ({})) : {};
    const kalData = kalRes.status === 'fulfilled' ? await kalRes.value.json().catch(() => ({})) : {};

    const polyGames = polyData.games || [];
    const kalshiGames = kalData.games || [];

    // Fetch real balances directly using stored credentials (no session cookie needed)
    let polyBal = cfg.betSizeUsd * 5;
    let kalBal = cfg.betSizeUsd * 5;
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
    try {
      const path = '/trade-api/v2/portfolio/balance';
      const baseUrl = process.env.KALSHI_API_BASE || 'https://api.elections.kalshi.com';
      const timestamp = String(Date.now());
      const sig = kalshiSign(credsKal.privateKey, timestamp, 'GET', path);
      const r = await fetch(`${baseUrl}${path}`, {
        headers: { 'KALSHI-ACCESS-KEY': credsKal.apiKeyId, 'KALSHI-ACCESS-TIMESTAMP': timestamp, 'KALSHI-ACCESS-SIGNATURE': sig },
      });
      if (r.ok) { const d = await r.json(); kalBal = (d?.balance?.available ?? 0) / 100; }
    } catch (_) {}

    // Circuit breaker
    if (polyBal < cfg.circuitBreakerPolyUsd || kalBal < cfg.circuitBreakerKalUsd) {
      stopArbEngine(`Circuit breaker: Poly $${polyBal.toFixed(2)}, Kalshi $${kalBal.toFixed(2)}`);
      return;
    }

    const opportunities = detectArbOpportunities(polyGames, kalshiGames, { polymarket: { balanceUsdc: polyBal }, kalshi: { balanceCents: kalBal * 100 } });
    broadcastEngineEvent('tick', { opportunityCount: opportunities.length, stats: arbEngine.stats, polyBal, kalBal });

    const now = Date.now();
    for (const opp of opportunities) {
      const cooldownKey = `${opp.gameKey}-${opp.strategy}`;
      const lastBet = arbEngine.cooldowns.get(cooldownKey) || 0;
      if (now - lastBet < cfg.cooldownMs) continue;

      const impact = arbEngine.marketImpact.get(opp.polyTokenId) || { betsPlaced: 0, estimatedPriceMove: 0 };
      if (impact.betsPlaced >= cfg.maxBetsPerOpportunity) continue;

      const sizing = computeKellyBetSize(opp, cfg, polyBal, kalBal);
      if (!sizing) continue;

      arbEngine.stats.betsAttempted++;
      arbEngine.cooldowns.set(cooldownKey, now);

      const betId = crypto.randomUUID();
      const polySize = Math.max(1, Math.floor(sizing.stakePolyUsd / Math.max(0.01, sizing.adjustedPolyPrice)));
      const kalCount = Math.max(1, Math.floor((sizing.stakeKalshiUsd * 100) / Math.max(1, opp.kalshiYesPriceCents)));

      broadcastEngineEvent('bet_attempting', {
        betId, gameKey: opp.gameKey, strategyLabel: opp.strategyLabel,
        stakePolyUsd: sizing.stakePolyUsd, stakeKalshiUsd: sizing.stakeKalshiUsd,
        polyPrice: sizing.adjustedPolyPrice, kalshiPrice: opp.kalshiPrice,
      });

      // Place both legs concurrently
      const [polySettled, kalSettled] = await Promise.allSettled([
        placePolyOrderDirect(credsPoly, polyFunder, {
          tokenId: opp.polyTokenId, side: 'BUY',
          price: sizing.adjustedPolyPrice, size: polySize,
          tickSize: opp.polyTickSize || '0.01', negRisk: opp.polyNegRisk || false,
        }),
        placeKalshiOrderDirect(credsKal, {
          ticker: opp.kalshiTicker, side: opp.kalshiSide || 'yes',
          count: kalCount, yes_price: opp.kalshiYesPriceCents || 50,
          client_order_id: betId,
        }),
      ]);

      const polyOk = polySettled.status === 'fulfilled' && !polySettled.value?.error;
      const kalOk = kalSettled.status === 'fulfilled' && !kalSettled.value?.error;
      const polyErr = polySettled.status === 'rejected' ? polySettled.reason?.message : polySettled.value?.error;
      const kalErr = kalSettled.status === 'rejected' ? kalSettled.reason?.message : kalSettled.value?.error;

      if (polyOk && kalOk) {
        arbEngine.stats.betsPlaced++;
        arbEngine.stats.totalStakedUsd += sizing.stakePolyUsd + sizing.stakeKalshiUsd;
        arbEngine.stats.expectedProfitUsd += opp.netProfitUsd || 0;
        // Update market impact
        const prev = arbEngine.marketImpact.get(opp.polyTokenId) || { betsPlaced: 0, estimatedPriceMove: 0 };
        arbEngine.marketImpact.set(opp.polyTokenId, {
          betsPlaced: prev.betsPlaced + 1,
          estimatedPriceMove: prev.estimatedPriceMove + (sizing.stakePolyUsd * cfg.priceImpactBpsPerDollar / 10000),
        });
        appendArbHistory({
          id: betId, placedAt: Date.now(), source: 'engine',
          gameKey: opp.gameKey, awayTeam: opp.awayTeam, homeTeam: opp.homeTeam,
          strategyLabel: opp.strategyLabel,
          stakePolyUsd: sizing.stakePolyUsd, stakeKalshiUsd: sizing.stakeKalshiUsd,
          netProfitUsd: opp.netProfitUsd, polyPrice: sizing.adjustedPolyPrice,
          kalshiYesPriceCents: opp.kalshiYesPriceCents, status: 'placed',
        });
        broadcastEngineEvent('bet_placed', {
          betId, gameKey: opp.gameKey, strategyLabel: opp.strategyLabel,
          stakePolyUsd: sizing.stakePolyUsd, stakeKalshiUsd: sizing.stakeKalshiUsd,
          netProfitUsd: opp.netProfitUsd, stats: arbEngine.stats,
        });
        console.log(`[ArbEngine] ✓ bet placed: ${opp.strategyLabel} stake $${sizing.stakePolyUsd.toFixed(2)}+$${sizing.stakeKalshiUsd.toFixed(2)} profit ~$${(opp.netProfitUsd||0).toFixed(2)}`);
      } else {
        broadcastEngineEvent('bet_failed', { betId, gameKey: opp.gameKey, polyErr, kalErr });
        console.log(`[ArbEngine] ✗ bet failed: ${opp.strategyLabel} polyErr=${polyErr} kalErr=${kalErr}`);
      }
    }
  } catch (err) {
    console.error('[ArbEngine] iteration error:', err.message);
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
  const attempts = [
    { sigType: 0, funderAddr: wallet.address },
    ...(isProxy ? [{ sigType: 1, funderAddr: effectiveFunder }] : [{ sigType: 1, funderAddr: wallet.address }]),
  ];
  const tokenIdStr = String(tokenId).trim();
  const sideVal = String(side).toUpperCase() === 'SELL' ? Side.SELL : Side.BUY;
  const priceRounded = roundPriceToTick(price, tickSize || '0.01');
  const userOrder = { tokenID: tokenIdStr, price: priceRounded, size: Number(size), side: sideVal };
  let lastErr = null;
  for (const { sigType, funderAddr } of attempts) {
    const client = new ClobClient('https://clob.polymarket.com', 137, wallet, apiCreds, sigType, funderAddr);
    try { await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL }); } catch (_) {}
    let ts = tickSize || '0.01';
    try { const mt = await client.getTickSize(tokenIdStr); if (mt != null) ts = polyTickSizeSupported(String(mt)); } catch (_) {}
    userOrder.price = roundPriceToTick(price, ts);
    try {
      const response = await client.createAndPostOrder(userOrder, { negRisk: Boolean(negRisk), tickSize: ts }, OrderType.GTC);
      const responseErr = response?.error || response?.errorMsg;
      if (responseErr) {
        lastErr = new Error(String(responseErr));
        if (/invalid signature/i.test(String(responseErr))) continue;
        return { error: String(responseErr) };
      }
      return response;
    } catch (err) {
      lastErr = err;
      if (/invalid signature/i.test(err?.message || '')) continue;
      return { error: err?.message || 'Poly order failed' };
    }
  }
  return { error: lastErr?.message || 'All signature attempts failed' };
}

async function placeKalshiOrderDirect(creds, { ticker, side, count, yes_price, client_order_id }) {
  const path = '/trade-api/v2/portfolio/orders';
  const baseUrl = process.env.KALSHI_API_BASE || 'https://api.elections.kalshi.com';
  const timestamp = String(Date.now());
  const signature = kalshiSign(creds.privateKey, timestamp, 'POST', path);
  const body = {
    ticker, action: 'buy',
    side: side.toLowerCase() === 'yes' ? 'yes' : 'no',
    count: Number(count), type: 'limit',
    yes_price: Math.min(99, Math.max(1, Math.round(Number(yes_price ?? 50)))),
    client_order_id: client_order_id || crypto.randomUUID(),
  };
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'KALSHI-ACCESS-KEY': creds.apiKeyId,
      'KALSHI-ACCESS-TIMESTAMP': timestamp,
      'KALSHI-ACCESS-SIGNATURE': signature,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { error: data.error || data.message || res.statusText };
  return data;
}
// ─────────────────────────────────────────────────────────────────────────────

function gameKey(away, home) {
  return `${String(away).toUpperCase()}-${String(home).toUpperCase()}`;
}

function detectArbOpportunities(polyGames, kalshiGames, balances) {
  const opportunities = [];
  const byKey = new Map();
  for (const g of kalshiGames) byKey.set(gameKey(g.awayTeam, g.homeTeam), g);
  const availPoly = balances?.polymarket?.balanceUsdc != null ? Math.max(1, balances.polymarket.balanceUsdc - ARB_RESERVE_POLY_USD) : ARB_MAX_STAKE_USD;
  const availKal = balances?.kalshi?.balanceCents != null ? Math.max(1, (balances.kalshi.balanceCents / 100) - ARB_RESERVE_KAL_USD) : ARB_MAX_STAKE_USD;

  for (const poly of polyGames) {
    const key = gameKey(poly.awayTeam, poly.homeTeam);
    const kal = byKey.get(key);
    if (!kal || !poly.tokenIdHome || !poly.tokenIdAway) continue;

    const p_H_poly = Math.max(0.01, Math.min(0.99, Number(poly.homeOdds) || 0.5));
    const p_A_poly = Math.max(0.01, Math.min(0.99, Number(poly.awayOdds) || 0.5));
    const p_H_kal = Math.max(0.01, Math.min(0.99, Number(kal.homeOdds) || 0.5));
    const p_A_kal = Math.max(0.01, Math.min(0.99, Number(kal.awayOdds) || 0.5));

    // Strategy 1: Home on Poly, Away on Kalshi. Arb if p_H_poly + p_A_kal < 1
    const sum1 = p_H_poly + p_A_kal;
    if (sum1 < 1) {
      const idealStake = Math.min(ARB_MAX_STAKE_USD, ARB_MAX_STAKE_PER_ARB_USD);
      let x = Math.min(idealStake, availPoly, (availKal * p_H_poly) / p_A_kal);
      x = Math.max(0, Math.min(x, ARB_MAX_STAKE_PER_ARB_USD));
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
        });
      }
    }

    // Strategy 2: Away on Poly, Home on Kalshi. Arb if p_A_poly + p_H_kal < 1
    const sum2 = p_A_poly + p_H_kal;
    if (sum2 < 1) {
      const idealStake = Math.min(ARB_MAX_STAKE_USD, ARB_MAX_STAKE_PER_ARB_USD);
      let x = Math.min(idealStake, availPoly, (availKal * p_A_poly) / p_H_kal);
      x = Math.max(0, Math.min(x, ARB_MAX_STAKE_PER_ARB_USD));
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
  const polyPrice = Number(opp.polyPrice) || 0.5;
  const polySize = Math.max(1, Math.floor(stakePoly / Math.max(0.01, polyPrice)));
  const polyNotional = polySize * polyPrice;
  if (polyNotional < 1) {
    return res.status(400).json({
      error: `Polymarket minimum order is $1 notional. This arb stake would be $${polyNotional.toFixed(2)}. Increase ARB_MAX_STAKE_PER_ARB_USD or choose a larger opportunity.`,
    });
  }

  try {
    const base = `${req.protocol}://${req.get('host')}`;
    const cookie = req.headers.cookie || '';

    const polyOrderRes = await fetch(`${base}/api/polymarket/order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        tokenId: opp.polyTokenId,
        side: opp.polySide || 'BUY',
        price: polyPrice,
        size: polySize,
        tickSize: opp.polyTickSize || '0.01',
        negRisk: opp.polyNegRisk || false,
      }),
    });
    const polyResult = await polyOrderRes.json().catch(() => ({}));
    if (!polyOrderRes.ok) {
      const polyErr = polyResult.error || 'Polymarket order failed';
      const polyFix = polyResult.fix || '';
      return res.status(polyOrderRes.status).json({
        error: polyFix ? `${polyErr}\n\n${polyFix}` : polyErr,
        polyResult: { error: polyErr, fix: polyFix, detail: polyResult.detail },
      });
    }

    const kalshiOrderRes = await fetch(`${base}/api/kalshi/order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        ticker: opp.kalshiTicker,
        side: opp.kalshiSide || 'yes',
        count: Math.max(1, Number(opp.kalshiCount) || 1),
        yes_price: Math.min(99, Math.max(1, Number(opp.kalshiYesPriceCents) || 50)),
        client_order_id: crypto.randomUUID(),
      }),
    });
    const kalshiResult = await kalshiOrderRes.json().catch(() => ({}));
    if (!kalshiOrderRes.ok) {
      return res.status(kalshiOrderRes.status).json({
        error: 'Kalshi order failed after Poly leg filled. Cancel the Poly order or hedge on Kalshi. ' + (kalshiResult.error || ''),
        leg1Done: true,
        polyResult,
      });
    }

    // Log to arb history
    appendArbHistory({
      id: crypto.randomUUID(),
      placedAt: Date.now(),
      gameKey: opp.gameKey,
      awayTeam: opp.awayTeam,
      homeTeam: opp.homeTeam,
      strategyLabel: opp.strategyLabel,
      stakePolyUsd: opp.stakePolyUsd,
      stakeKalshiUsd: opp.stakeKalshiUsd,
      netProfitUsd: opp.netProfitUsd,
      polyPrice: opp.polyPrice,
      kalshiYesPriceCents: opp.kalshiYesPriceCents,
      polyOrderId: polyResult?.orderID || polyResult?.id || null,
      kalshiOrderId: kalshiResult?.order?.order_id || kalshiResult?.id || null,
      status: 'placed',
    });

    res.json({ ok: true, poly: polyResult, kalshi: kalshiResult });
  } catch (err) {
    console.error('Arb execute error:', err);
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
      const sigOrder = isProxy ? [1, 0, 2] : [0, 1, 2];
      for (const sigType of sigOrder) {
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
        if (usdc > 0) {
          balanceUsdc = usdc;
          allowanceUsdc = allowUsdc;
          break;
        }
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
      // Also fetch recent filled trades + current prices for win/loss detection
      try {
        const trades = await client.getTrades({ maker_address: funder || wallet.address });
        const tradeList = Array.isArray(trades) ? trades.slice(0, 20) : [];
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
    const { Wallet } = await import('ethers');
    const wallet = new Wallet(String(privateKey).trim());
    if (funderAddress && /^0x[a-fA-F0-9]{40}$/.test(String(funderAddress).trim())) {
      req.session.polyFunder = String(funderAddress).trim().toLowerCase();
    }
    // Do NOT auto-fetch proxy — MetaMask users use EOA; auto-detect was causing "invalid signature" for them
  } catch (_) {}
  res.json({ ok: true });
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

app.post('/api/arb/engine/start', (req, res) => {
  if (!req.session?.polyCreds || !req.session?.kalshiCreds) {
    return res.status(401).json({ error: 'Sign in to both Polymarket and Kalshi first' });
  }
  if (arbEngine.running) return res.json({ ok: true, message: 'Engine already running' });
  const cfg = req.body?.config || {};
  if (cfg.betSizeUsd != null) arbEngine.config.betSizeUsd = Number(cfg.betSizeUsd);
  if (cfg.intervalMs != null) arbEngine.config.intervalMs = Number(cfg.intervalMs);
  if (cfg.cooldownMs != null) arbEngine.config.cooldownMs = Number(cfg.cooldownMs);
  if (cfg.kellyFraction != null) arbEngine.config.kellyFraction = Number(cfg.kellyFraction);
  if (cfg.circuitBreakerPolyUsd != null) arbEngine.config.circuitBreakerPolyUsd = Number(cfg.circuitBreakerPolyUsd);
  if (cfg.circuitBreakerKalUsd != null) arbEngine.config.circuitBreakerKalUsd = Number(cfg.circuitBreakerKalUsd);
  if (cfg.maxBetsPerOpportunity != null) arbEngine.config.maxBetsPerOpportunity = Number(cfg.maxBetsPerOpportunity);
  arbEngine.credsPoly = req.session.polyCreds;
  arbEngine.credsKal = req.session.kalshiCreds;
  arbEngine.polyFunder = req.session.polyFunder || null;
  arbEngine._sessionId = req.sessionID;
  arbEngine.stats = { betsPlaced: 0, betsAttempted: 0, totalStakedUsd: 0, expectedProfitUsd: 0 };
  arbEngine.cooldowns.clear();
  arbEngine.marketImpact.clear();
  arbEngine.running = true;
  arbEngine.startedAt = Date.now();
  arbEngine.timerId = setInterval(runEngineIteration, arbEngine.config.intervalMs);
  broadcastEngineEvent('started', { config: arbEngine.config });
  console.log('[ArbEngine] started — betSize $' + arbEngine.config.betSizeUsd + ', interval ' + arbEngine.config.intervalMs + 'ms');
  res.json({ ok: true, config: arbEngine.config });
});

app.post('/api/arb/engine/stop', (req, res) => {
  stopArbEngine('User requested stop');
  res.json({ ok: true, stats: arbEngine.stats });
});

app.get('/api/arb/engine/status', (req, res) => {
  res.json({ running: arbEngine.running, startedAt: arbEngine.startedAt, stats: arbEngine.stats, config: arbEngine.config });
});

app.patch('/api/arb/engine/config', (req, res) => {
  const cfg = req.body || {};
  const needsRestart = cfg.intervalMs != null && cfg.intervalMs !== arbEngine.config.intervalMs;
  if (cfg.betSizeUsd != null) arbEngine.config.betSizeUsd = Number(cfg.betSizeUsd);
  if (cfg.intervalMs != null) arbEngine.config.intervalMs = Number(cfg.intervalMs);
  if (cfg.cooldownMs != null) arbEngine.config.cooldownMs = Number(cfg.cooldownMs);
  if (cfg.kellyFraction != null) arbEngine.config.kellyFraction = Number(cfg.kellyFraction);
  if (cfg.circuitBreakerPolyUsd != null) arbEngine.config.circuitBreakerPolyUsd = Number(cfg.circuitBreakerPolyUsd);
  if (cfg.circuitBreakerKalUsd != null) arbEngine.config.circuitBreakerKalUsd = Number(cfg.circuitBreakerKalUsd);
  if (needsRestart && arbEngine.timerId) {
    clearInterval(arbEngine.timerId);
    arbEngine.timerId = setInterval(runEngineIteration, arbEngine.config.intervalMs);
  }
  broadcastEngineEvent('config_updated', { config: arbEngine.config });
  res.json({ ok: true, config: arbEngine.config });
});
// ─────────────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`NBA Odds Visualizer running at http://localhost:${PORT}`);
});
