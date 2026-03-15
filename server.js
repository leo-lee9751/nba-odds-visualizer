import express from 'express';
import cors from 'cors';
import session from 'express-session';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

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

// Fetch NBA game odds from Polymarket - uses NBA scoreboard to get today's games, then fetches odds by slug
app.get('/api/polymarket', async (req, res) => {
  try {
    // 1. Get today's NBA games from official NBA scoreboard
    const scoreboardRes = await fetch(
      `https://cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json?t=${Date.now()}`,
      fetchOptions
    );
    const scoreboard = await scoreboardRes.json();
    const nbaGames = scoreboard?.scoreboard?.games || [];
    const dateStr = scoreboard?.scoreboard?.gameDate || new Date().toISOString().slice(0, 10);

    if (nbaGames.length === 0) {
      return res.json({ games: [] });
    }

    // 2. Build Polymarket slugs (nba-away-home-YYYY-MM-DD)
    const slugs = nbaGames.map((g) => {
      const away = (g.awayTeam?.teamTricode || '').toLowerCase();
      const home = (g.homeTeam?.teamTricode || '').toLowerCase();
      return `nba-${away}-${home}-${dateStr}`;
    });

    // 3. Fetch each event from Polymarket (batch - one request per slug)
    const games = [];
    await Promise.all(
      slugs.map(async (slug, i) => {
        try {
          const eventRes = await fetch(
            `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`,
            fetchOptions
          );
          const events = await eventRes.json();
          const event = Array.isArray(events) ? events[0] : events;

          if (!event?.markets?.length) {
            const g = nbaGames[i];
            games.push(buildGameWithScores(g, slug, g?.homeTeam?.teamTricode || 'HOME', g?.awayTeam?.teamTricode || 'AWAY', 0.5, 0.5, event?.startDate || g?.gameTimeUTC, `https://polymarket.com/sports/nba/${slug}`));
            return;
          }

          const market = findMoneylineMarket(event.markets);
          const pricesRaw = market?.outcomePrices ?? market?.outcome_prices;
          const prices = parseOutcomePrices(pricesRaw);
          const outcomes = parseOutcomes(market?.outcomes ?? market?.outcome);

          const g = nbaGames[i];
          const awayTeam = g?.awayTeam?.teamTricode || event.teams?.[0]?.abbreviation || 'AWAY';
          const homeTeam = g?.homeTeam?.teamTricode || event.teams?.[1]?.abbreviation || 'HOME';

          const { awayOdds, homeOdds } = mapPricesToAwayHome(prices, outcomes, event, awayTeam, homeTeam);

          const tokenIds = market?.clobTokenIds ?? market?.tokens;
          const tokenIdArr = Array.isArray(tokenIds) ? tokenIds : [];
          const tickSize = market?.minimum_tick_size ?? market?.tickSize ?? '0.01';
          const negRisk = Boolean(market?.neg_risk ?? market?.negRisk);
          const betting =
            tokenIdArr.length >= 2
              ? {
                  tokenIdAway: tokenIdArr[0],
                  tokenIdHome: tokenIdArr[1],
                  tickSize: String(tickSize),
                  negRisk,
                }
              : null;

          games.push(buildGameWithScores(g, event.id || slug, homeTeam, awayTeam, Math.round(homeOdds * 100) / 100, Math.round(awayOdds * 100) / 100, event.startDate || g?.gameTimeUTC, `https://polymarket.com/event/${slug}`, betting));
        } catch (e) {
          const g = nbaGames[i];
          games.push(buildGameWithScores(g, slug, g?.homeTeam?.teamTricode || 'HOME', g?.awayTeam?.teamTricode || 'AWAY', 0.5, 0.5, g?.gameTimeUTC, `https://polymarket.com/sports/nba/${slug}`));
        }
      })
    );

    games.sort((a, b) => new Date(a.startDate || 0) - new Date(b.startDate || 0));

    res.json({ games });
  } catch (error) {
    console.error('Polymarket API error:', error.message);
    res.status(500).json({ error: 'Failed to fetch Polymarket data', games: [] });
  }
});

// Kalshi elections API has NBA Spread (and Total) - no auth required
const KALSHI_ELECTIONS = 'https://api.elections.kalshi.com/trade-api/v2';

// Parse "DEN at LAL (Mar 14)" or "GSW at NYK (Mar 15)" -> away, home
function parseKalshiSubtitle(sub) {
  const m = (sub || '').match(/([A-Za-z]+)\s+at\s+([A-Za-z]+)\s+\(/);
  return m ? { away: m[1].toUpperCase(), home: m[2].toUpperCase() } : null;
}

// Fetch NBA game odds from Kalshi (Spread markets from elections API)
app.get('/api/kalshi', async (req, res) => {
  try {
    const eventsRes = await fetch(
      `${KALSHI_ELECTIONS}/events?status=open&series_ticker=KXNBASPREAD&limit=50`,
      fetchOptions
    );
    const { events = [] } = await eventsRes.json();

    const games = [];
    for (const event of events) {
      const teams = parseKalshiSubtitle(event.sub_title);
      if (!teams) continue;

      const marketsRes = await fetch(
        `${KALSHI_ELECTIONS}/markets?event_ticker=${encodeURIComponent(event.event_ticker)}&status=open`,
        fetchOptions
      );
      const { markets = [] } = await marketsRes.json();
      if (!markets.length) continue;

      // Pick the market with highest volume as the "main" spread line
      const sorted = [...markets].sort(
        (a, b) => parseFloat(b.volume_fp || 0) - parseFloat(a.volume_fp || 0)
      );
      const main = sorted[0];
      const yesPrice = parseFloat(main.yes_bid_dollars || main.last_price_dollars || 0.5);
      const noPrice = 1 - yesPrice;
      const yesIsHome = (main.yes_sub_title || main.title || '').toLowerCase().includes(teams.home.toLowerCase()) || (main.yes_sub_title || '').includes(teams.home);

      games.push({
        id: event.event_ticker,
        awayTeam: teams.away,
        homeTeam: teams.home,
        homeOdds: yesIsHome ? yesPrice : noPrice,
        awayOdds: yesIsHome ? noPrice : yesPrice,
        startDate: event.last_updated_ts,
        url: `https://kalshi.com/markets/${event.event_ticker}`,
        label: 'Spread',
        marketTicker: main.ticker,
      });
    }

    games.sort((a, b) => new Date(a.startDate || 0) - new Date(b.startDate || 0));

    res.json({ games });
  } catch (error) {
    console.error('Kalshi API error:', error.message);
    res.status(500).json({
      error: 'Kalshi API error - ' + error.message,
      games: [],
    });
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

app.get('/api/auth/status', (req, res) => {
  res.json({
    polymarket: Boolean(req.session?.polyCreds),
    kalshi: Boolean(req.session?.kalshiCreds),
  });
});

app.post('/api/auth/polymarket', (req, res) => {
  const { apiKey, secret, passphrase, privateKey } = req.body || {};
  if (!apiKey || !secret || !passphrase || !privateKey) {
    return res.status(400).json({ error: 'Missing apiKey, secret, passphrase, or privateKey' });
  }
  req.session.polyCreds = { apiKey, secret, passphrase, privateKey };
  res.json({ ok: true });
});

app.post('/api/auth/kalshi', (req, res) => {
  const { apiKeyId, privateKey } = req.body || {};
  if (!apiKeyId || !privateKey) {
    return res.status(400).json({ error: 'Missing apiKeyId or privateKey' });
  }
  req.session.kalshiCreds = { apiKeyId, privateKey };
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  delete req.session.polyCreds;
  delete req.session.kalshiCreds;
  res.json({ ok: true });
});

// Place order on Polymarket (requires session polyCreds)
app.post('/api/polymarket/order', async (req, res) => {
  const creds = req.session?.polyCreds;
  if (!creds) return res.status(401).json({ error: 'Not signed in to Polymarket' });

  const { tokenId, side, price, size } = req.body || {};
  if (!tokenId || !side || price == null || !size) {
    return res.status(400).json({ error: 'Missing tokenId, side, price, or size' });
  }

  try {
    const { ClobClient, Side, OrderType } = await import('@polymarket/clob-client');
    const { Wallet } = await import('ethers');

    const wallet = new Wallet(creds.privateKey);
    const apiCreds = { apiKey: creds.apiKey, secret: creds.secret, passphrase: creds.passphrase };
    const client = new ClobClient(
      'https://clob.polymarket.com',
      137,
      wallet,
      apiCreds,
      0, // EOA - use 2 and funder address if you use Polymarket proxy wallet
      wallet.address
    );

    const tickSize = String(req.body.tickSize ?? '0.01');
    const negRisk = Boolean(req.body.negRisk);
    const sideVal = (side || '').toUpperCase() === 'SELL' ? Side.SELL : Side.BUY;

    const response = await client.createAndPostOrder(
      { tokenID: String(tokenId), price: Number(price), size: Number(size), side: sideVal },
      { tickSize, negRisk },
      OrderType.GTC
    );
    res.json(response);
  } catch (err) {
    console.error('Polymarket order error:', err);
    res.status(500).json({ error: err.message || 'Order failed' });
  }
});

// Kalshi: sign request (timestamp + method + path) with RSA-PSS SHA-256
function kalshiSign(privateKeyPem, timestamp, method, pathStr) {
  const message = timestamp + method + pathStr;
  const key = crypto.createPrivateKey(privateKeyPem);
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
      return res.status(orderRes.status).json({ error: data.message || data.error || orderRes.statusText });
    }
    res.json(data);
  } catch (err) {
    console.error('Kalshi order error:', err);
    res.status(500).json({ error: err.message || 'Order failed' });
  }
});

app.listen(PORT, () => {
  console.log(`NBA Odds Visualizer running at http://localhost:${PORT}`);
});
