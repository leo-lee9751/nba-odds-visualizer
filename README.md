# NBA Odds Visualizer

Compare NBA game moneyline odds from **Kalshi** and **Polymarket** side by side, and run an automated arbitrage engine that exploits pricing discrepancies between the two platforms.

## Setup

```bash
cd nba-odds-visualizer
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Data Sources

- **Polymarket** – Fetched from the public Gamma API (no auth required).
- **Kalshi** – Proxied through this server. Sports markets may require an API key on production.

## API Endpoints

- `GET /api/polymarket` – NBA game odds from Polymarket
- `GET /api/kalshi` – NBA game odds from Kalshi (when available)

---

## Arbitrage — How It Works

Both Polymarket and Kalshi are binary prediction markets for NBA game outcomes: each game has a YES market for the home team winning and a YES market for the away team winning. Each platform independently prices these outcomes.

Because the two platforms don't always agree on probabilities, a pricing gap occasionally opens up. When the sum of the best available prices **across platforms** is **less than 100¢**, a risk-free profit exists:

- Buy **Team A YES** on Platform 1 at price `p1`
- Buy **Team B YES** on Platform 2 at price `p2`
- Total cost: `p1 + p2 < $1.00`
- Exactly one of these pays out $1 when the game ends
- **Guaranteed profit = $1.00 − (p1 + p2)**, regardless of who wins

**Example:**
```
Polymarket:  Lakers YES  = 45¢   (Polymarket thinks Lakers win 45% of the time)
Kalshi:      Celtics YES = 52¢   (Kalshi thinks Celtics win 52% of the time)

Combined cost = 97¢
Guaranteed payout = $1.00
Risk-free profit  = +3¢ per dollar pair deployed (~3.1% return)
```

The app checks **two strategies** per game on every price update:

| Strategy | Polymarket leg | Kalshi leg | Arb condition |
|----------|---------------|------------|---------------|
| 1 | Buy HOME YES | Buy AWAY YES | `homeOdds_poly + awayOdds_kal < 1.00` |
| 2 | Buy AWAY YES | Buy HOME YES | `awayOdds_poly + homeOdds_kal < 1.00` |

---

## Live Price Feeds

REST polling (10-second cache) is far too slow — arb windows open and close in 1–3 seconds during live games. The server maintains persistent WebSocket connections to both platforms:

**Polymarket** — `wss://ws-subscriptions-clob.polymarket.com/ws/market`
- Subscribes by token ID (one token per outcome per game)
- Receives `price_change` and `book` events in real time
- Updates in-memory `polyGamesState` map keyed by `AWAY-HOME`

**Kalshi** — `wss://api.elections.kalshi.com/trade-api/ws/v2`
- Subscribes to the `ticker` channel by market ticker
- Receives `yes_bid` / `yes_ask` on each tick; mid-price = `(bid + ask) / 2 / 100`
- Updates in-memory `kalshiGamesState` map keyed by `AWAY-HOME`

Both maps are updated in-place on every WS message. When either map changes, `onPriceUpdate()` fires (debounced to 200ms), which triggers both the arb detection loop and the early-exit check simultaneously.

---

## Auto-Arb Engine

The Auto-Arb Engine runs continuously in the background once started, firing on every price update.

### Modes

**Simulation mode** (default — safe to run without any capital):
No real orders are placed. The engine uses fake in-memory balances (configurable, default $1,000 each) and records all trades with `SIM-` order IDs. Use this to validate the strategy and observe how often opportunities appear before putting in real money.

**Real money mode**:
Places actual limit orders on Polymarket (via the CLOB REST API with your private key) and Kalshi (via their trading REST API with your RSA key). Requires signing in to both platforms first.

### Detection Loop

On every `onPriceUpdate()` call:
1. Snapshot `polyGamesState` and `kalshiGamesState`
2. Run `detectArbOpportunities()` across all matched game pairs
3. Skip any game that was traded in the last **60 seconds** (cooldown per game key)
4. Place **at most one arb** per cycle to avoid over-trading
5. Broadcast result to the UI via Server-Sent Events (SSE)

### Stake Sizing

Stakes are sized so that **both legs pay out the same dollar amount**, eliminating all directional risk. Given max stake `S` and entry prices `p_poly` and `p_kal`:

```
polyStake        = min(S, availablePolyBalance)
kalshiStake      = polyStake × p_kal / p_poly

polyShares       = floor(polyStake / p_poly)
kalshiContracts  = floor(kalshiStake × 100 / round(p_kal × 100))
```

Both legs converge to the same payout `K ≈ polyStake / p_poly`. Kalshi taker fees are subtracted from the projected profit, and opportunities below a minimum net profit threshold (`ARB_MIN_PROFIT_USD`) are discarded.

### Configuration

| Setting | What it does |
|---------|-------------|
| **Max stake / arb ($)** | Hard cap on USD deployed per opportunity across both legs |
| **Exit at ≥** | Early-exit threshold — sell both legs when current prices sum to this value (default `1.00`) |
| **Fake Poly / Fake Kalshi ($)** | Starting fake balances for simulation mode |

---

## Selling — Two Exit Paths

### Path 1 — Early Exit (prices recover)

After placing an arb, the engine watches all open positions. On every price tick **and** every 10 seconds (fallback timer), it checks:

```
currentPolyPrice + currentKalshiPrice >= exitThreshold
```

When this condition is met, both legs are sold immediately. This happens when the market has corrected — the price gap has closed — so there's no longer any advantage to holding.

**Actual profit realized:**
```
actualProfit = (exitPolyPrice − entryPolyPrice) × polyShares
             + (exitKalshiCents − entryKalshiCents) / 100 × kalshiContracts
```

This will typically be less than the maximum guaranteed profit you'd collect by holding to settlement, but it frees up capital immediately to redeploy into the next opportunity — increasing the number of arbs you can run per unit of time.

In **simulation mode**: balances are credited back (stake returned + profit added).  
In **real money mode**: a `SELL` limit order is placed on Polymarket and a `sell` order on Kalshi at the current market price.

### Path 2 — Hold to Game Settlement

If the exit threshold is never reached while the game is live, the position is held until the game ends. The platform whose YES token won pays out $1 per share/contract automatically — no action needed. The losing leg expires at $0. Net result equals the expected profit locked in at entry.

---

## Position Cards (UI)

Each placed arb appears as a card in the **Auto-Arb Engine** panel:

```
┌─────────────────────────────────────────────────┐
│  Lakers @ Celtics                  [SIM]  9:41 PM│
├──────────────────────┬──────────────────────────┤
│  POLYMARKET          │  KALSHI                   │
│  Lakers YES          │  Celtics YES              │
│  45¢ · $25.00        │  52¢ · $27.89             │
│  SIM-a1b2c3          │  SIM-d4e5f6               │
├─────────────────────────────────────────────────┤
│  +$1.53 expected        ● Pending payout         │
└─────────────────────────────────────────────────┘
```

After an early exit the card updates to show both expected and actual profit:

```
├─────────────────────────────────────────────────┤
│  Expected   Actual                               │
│  +$1.53     +$0.87     Closed early ✓ · 52¢/56¢ │
└─────────────────────────────────────────────────┘
```

The **portfolio bar** above the cards shows live totals across all open positions:
- **Positions** — number of arbs placed this session
- **Deployed** — total capital currently locked in open positions
- **Unrealized** — expected profit from still-open positions
- **Realized** — actual profit banked from early exits
