# Live Arbitrage System – Design & Logistics

This document defines the architecture and logistics for **live arbitrage betting** between Polymarket and Kalshi on NBA moneyline markets, built on top of the existing NBA Odds Visualizer. The goal is a system that places bets only when a **fee-adjusted profit** is guaranteed, respects **liquidity** and **portfolio constraints**, and applies **risk controls** beyond simple stop-losses.

---

## 1. Current System Summary (What Exists)

### 1.1 Data flow
- **NBA schedule / scoreboard**: `GET /api/nba/upcoming` (today’s scoreboard + schedule 7 days out). Used to get game list and match Poly/Kalshi by matchup key `AWAY-HOME`.
- **Polymarket**: `GET /api/polymarket` – today’s scoreboard → slugs `nba-{away}-{home}-{date}` → Gamma API by slug → moneyline market, `outcomePrices`, `clobTokenIds`, `tickSize`, `negRisk`. Returns per-game: `homeOdds`, `awayOdds`, `tokenIdHome`, `tokenIdAway`, etc.
- **Kalshi**: `GET /api/kalshi` – `series_ticker=KXNBAGAME`, `status=open` → events → markets per event (two markets: home win, away win). Uses `yes_bid_dollars` / `last_price_dollars` for implied prob. Returns `marketTickerHome`, `marketTickerAway`, `homeOdds`, `awayOdds`.

### 1.2 Order placement
- **Polymarket**: `POST /api/polymarket/order` – session `polyCreds`, body `tokenId`, `side`, `price`, `size`, `tickSize`, `negRisk`. Uses `ClobClient.createAndPostOrder` (limit GTC).
- **Kalshi**: `POST /api/kalshi/order` – session `kalshiCreds`, body `ticker`, `side` (yes/no), `count`, `yes_price`, `client_order_id`. Signed GET/POST to `KALSHI_API_BASE` + `/trade-api/v2/portfolio/orders`.

### 1.3 Auth & state
- Session: `polyCreds` (apiKey, secret, passphrase, privateKey), `kalshiCreds` (apiKeyId, privateKey).
- Balances: `GET /api/balances` (Poly USDC via CLOB balance-allowance; Kalshi balance/portfolio in cents).
- My orders: `GET /api/my-orders` (Poly open orders; Kalshi portfolio orders, filtered client-side for KXNBAGAME and resting).

### 1.4 Gaps for arbitrage
- No **unified odds feed** with **bid/ask and depth** (needed for fill probability and liquidity).
- No **fee model** in the app (Kalshi fees are meaningful; Poly NBA may be low/free).
- No **arb detection**, **sizing**, or **two-legged execution**.
- No **live loop** (polling or websocket) focused on in-play games.
- No **portfolio/reserve** or **risk** logic.

---

## 2. Arbitrage Logic (Fee-Aware, Minimum Profit)

### 2.1 Two-outcome moneyline arb
- **Outcomes**: Home win (H), Away win (A).
- **Books**: Polymarket (Poly), Kalshi (Kal).
- **Prices**: Use **bid** on the side you are buying (you “hit” the bid or post at that price):  
  - Poly: `p_H_poly`, `p_A_poly` (e.g. from order book best bid or current mid).  
  - Kal: `p_H_kal`, `p_A_kal` (e.g. `yes_bid` for “team wins” markets).

**Classic arb condition (no fees):**  
Bet on **opposite** outcomes across books so that whichever outcome wins, you get more than total stake.

- **Strategy 1**: Bet **Home on Poly**, **Away on Kalshi**.  
  - Stake `x` on Home (Poly) at price `p_H_poly` → cost `x`, payout if H wins = `x / p_H_poly`.  
  - Stake `y` on Away (Kalshi) at price `p_A_kal` → cost `y`, payout if A wins = `y / p_A_kal`.  
  - **Risk-free** if:  
    - If H wins: `x / p_H_poly ≥ x + y`  
    - If A wins: `y / p_A_kal ≥ x + y`  
  - Equal payout (no free option) when:  
    `x / p_H_poly = y / p_A_kal = K`.  
  - So: `y = x · p_A_kal / p_H_poly`, and total cost `C = x + y`. Payout (either outcome) `K = x / p_H_poly`.  
  - **Arb exists** when `K > C`, i.e. `1/p_H_poly + 1/p_A_kal > 1` (or equivalently `p_H_poly + p_A_kal < 1` for the “cross” home/away pair).

- **Strategy 2**: Bet **Away on Poly**, **Home on Kalshi**.  
  - Same idea with `p_A_poly` and `p_H_kal`. Arb when `p_A_poly + p_H_kal < 1`.

So the **detection step** is: for each game, compute both crosses; if either `p_H_poly + p_A_kal` or `p_A_poly + p_H_kal` is below 1, an arb is possible (before fees).

### 2.2 Fees and minimum profit threshold

**Kalshi (simplified):**
- Taker: `0.07 × C × P × (1 − P)` per contract (C = contracts, P = price in [0,1]).
- Maker: ~1/4 of taker when limit is filled.
- For a limit order that might fill as maker, use a **worst-case** assumption (e.g. taker) so that **minimum profit is net of fees**.

**Polymarket:**
- Many markets **no fee**; some sports use `feeRate × C × p × (1−p)` (e.g. max ~0.44% at 50%). Assume a small fee or zero for NBA moneyline for safety.

**Minimum profit rule:**
- For each candidate arb, compute:
  - Total cost `C_total = x + y` (in $).
  - Total fees (Poly + Kalshi) for that (x, y) and prices.
  - **Net profit** = `min(x/p_H_poly, y/p_A_kal) − C_total − fees` (for strategy 1; analogous for strategy 2).
- **Only allow placement if** `net_profit ≥ min_profit_threshold` (e.g. $0.50 or 0.5% of stake, configurable).
- This is the **“minimum amount of profit to place a trade in order to not lose money from Kalshi fees”** (and any Poly fees).

### 2.3 Sizing (stake for each leg)
- **Standard arb**: For a given cross (e.g. H on Poly, A on Kalshi), choose stake `x` (or total budget `C`) and set `y = x · p_A_kal / p_H_poly` so payouts are equal.
- **Constrained by liquidity**:  
  - **Poly**: Use order book depth (best bid/ask and size) so that `x` does not exceed available size at the chosen price (or use a **max fill** estimate).  
  - **Kalshi**: Use `yes_ask_size_fp` / order book if available so `y` (in contracts) does not exceed depth.
- **Constrained by portfolio** (see Section 4): `x ≤ available_Poly`, `y × price ≤ available_Kalshi`, and reserve rules.

---

## 3. Risk Adjustment (Not Just Stop-Losses)

You asked for **risk adjustment** beyond simple stop-losses. Below are concrete levers.

### 3.1 Position and exposure limits
- **Per-game cap**: Max total stake (both legs combined) per game, e.g. $X per matchup.
- **Per-side cap**: Max stake on a single outcome (e.g. max $Y on “Home” across all books).
- **Open-arb cap**: Max number of **simultaneous** open arb positions (e.g. 3 games). Avoids over-concentration and keeps capital for new opportunities.

### 3.2 Drawdown and daily loss caps
- **Daily loss cap**: If **realized + unrealized** PnL for the day is below −$Z, **stop placing new arbs** (and optionally cancel resting legs). Requires tracking fills and mark-to-market (or settlement).
- **Drawdown from peak**: If current equity drops by W% from session peak, **pause** or reduce size until manual reset.

### 3.3 Execution and fill risk
- **One leg fills, other doesn’t**: You are then **directional**. Mitigations:
  - **Time limit**: If the second leg doesn’t fill within N seconds, try to **cancel the first** (if exchange allows) or **hedge** on the same book.
  - **Size down**: Prefer smaller size so that if one leg fails, directional exposure is bounded.
- **Slippage**: Use **conservative price** (e.g. worst of bid/ask or a tick worse) when computing arb and min profit so that after slippage you still meet the threshold.

### 3.4 Correlation and concentration
- **Same game, multiple arbs**: If you already have an open arb on GSW–NYK, either **block** a second arb on the same game or **cap total** exposure for that game.
- **Time of game**: Optionally reduce size or skip arbs in the last few minutes of a game (higher volatility, faster market close).

These can be implemented as **configurable parameters** (env or config file) and **guards** in the arb engine before sending orders.

---

## 4. Liquidity and Portfolio (Reserve + No Bust)

You want:
- **A)** Not run out of money on one account (so you can keep trading).
- **B)** Leave equity for future trades (not deploy 100% of capital).

### 4.1 Standard arb form vs “best” sizing
- **Standard (fixed equation)**: For a given arb, we compute `(x, y)` so payouts are equal and total cost is some **target stake** (e.g. $100). That’s the “textbook” arb.
- **Portfolio-aware (not fixed equation)**: The **best** way to use capital is to size so that:
  1. You never exceed **available balance** on either venue (Poly USDC, Kalshi balance).
  2. You **reserve** a fraction (or fixed amount) on **each** venue for future arbs and for life-of-order margin.

### 4.2 Concrete allocation rules
- **Reserve (per venue)**  
  - Poly: `available_Poly = balance_poly − reserve_poly`. Reserve can be **$R_poly** or **r_poly × balance**.  
  - Kalshi: `available_Kal = balance_kal − reserve_kal` (in $ equivalent).  
  - Only allow an arb if **both** legs can be paid from `available_*` after accounting for **existing open orders** (resting amounts).

- **Max stake per arb**  
  - Option 1: **Fixed cap** per trade (e.g. max $500 total cost per arb).  
  - Option 2: **Fraction of available**: e.g. `max_stake = min(available_Poly, available_Kal) × 0.2` so you never put more than 20% of the “bottleneck” side into one arb.  
  - Option 3: **Proportional** to liquidity (order book depth) so you don’t move the market; then also cap by `available_*` and reserve.

- **Order of operations**  
  1. Fetch **balances** and **open orders** (you already have `/api/balances` and `/api/my-orders`).  
  2. Compute **used** and **available** per venue (balance − reserve − resting order value).  
  3. When evaluating an arb:  
     - Compute **ideal** `(x, y)` from equal-payout formula.  
     - **Cap** `x` by `available_Poly` and by Poly liquidity; **cap** `y` (in $) by `available_Kal` and by Kalshi liquidity.  
     - Recompute **actual** stake (e.g. take `min(ideal_stake, capped_stake)`), then re-check **net profit ≥ min_profit_threshold**.  
  4. Only then place **both** legs (with a clear **atomicity / rollback** strategy if one leg fails).

This gives you a **dynamic**, portfolio-aware sizing that respects both “don’t go bust” and “leave room for future trades.”

---

## 5. Live Betting Logistics

You want **live** arbitrage **during the game**.

### 5.1 Data availability
- **Polymarket**: Odds update as the market trades; for NBA they have moneyline markets that can be **live** (prices move with the game). Your current flow uses **today’s scoreboard** and slugs; the **same** slug can serve pre-game and in-game; you just need to **poll** the same endpoints (or event endpoint) on a short interval to get updated prices.
- **Kalshi**: KXNBAGAME markets are game-outcome markets. They may stay **open** until the game ends (or close early when outcome is determined). You need to confirm via their API/docs whether they update during the game; if they do, **polling** markets by `event_ticker` will give updated `yes_bid`/`last_price`.
- **Game state**: You already have **scoreboard** (scores, period). Use this to:
  - **Restrict** live arb to games in status “in” (or equivalent) and optionally exclude last 2 minutes if desired.
  - **Display** live score next to arb opportunities.

### 5.2 Polling vs websockets
- **Current stack** is request/response (fetch). Easiest extension is **polling** from the **server** (Node):
  - Every **T** seconds (e.g. 5–15 s for live), call Poly and Kalshi for **live games** (e.g. games from today’s scoreboard that are in progress).
  - For those games only, fetch **order book** (Poly CLOB) and **market prices** (Kalshi) to get bid/ask and depth.
  - Run **arb detection** and **sizing** (with fees, reserve, caps).
  - If an opportunity passes the threshold, **execute** both legs (see Section 6).
- **WebSockets**: Poly and Kalshi may offer websockets for order book / trades. That would reduce latency and load but requires more integration; can be **Phase 2**.

### 5.3 Which games to run on
- **Pre-game**: All games that have both Poly and Kalshi markets open (current visualizer already merges by matchup).
- **Live**: Only games where **scoreboard** says status is live (e.g. “2nd Q” or “Halftime”). Filter `gameStatusText` or equivalent so the arb engine only considers **in-play** games when “live” mode is on.

---

## 6. Proposed Architecture (Extending the Visualizer)

### 6.1 Components to add
1. **Config**  
   - `MIN_PROFIT_USD` (or min % of stake).  
   - `RESERVE_POLY_USD`, `RESERVE_KAL_USD` (or reserve fractions).  
   - `MAX_STAKE_PER_ARB`, `MAX_OPEN_ARBS`, `DAILY_LOSS_CAP`, etc.  
   - `LIVE_POLL_INTERVAL_MS`, `ENABLE_LIVE_ARB` (boolean).

2. **Unified odds + depth**  
   - **Service or route** that, for a given game (matchup key):
     - Gets Poly prices (and **order book** from CLOB for that token).
     - Gets Kalshi prices (and depth if API provides it).
     - Returns one structure: `{ poly: { homeBid, homeAsk, awayBid, awayAsk, homeDepth, awayDepth }, kalshi: { ... } }`.
   - This can be a new **server-side** module that the visualizer’s existing Poly/Kalshi fetchers call, or a new endpoint that the **arb engine** calls.

3. **Arb engine (server-side)**  
   - **Input**: Unified odds + depth, balances, open orders, config.  
   - **Output**: List of **actionable arbs**: game, strategy (H-Poly/A-Kal or A-Poly/H-Kal), stake `(x, y)`, expected net profit, fees.  
   - Steps:
     - For each game with both Poly and Kalshi data, compute both crosses.
     - If either cross has `sum of probs < 1`, compute optimal stake subject to liquidity and portfolio caps and reserve.
     - Apply min-profit and fee check; apply risk limits (per-game cap, open-arb cap, daily loss).
     - Return only arbs that pass.

4. **Executor**  
   - For one chosen arb:  
     - **Place leg 1** (e.g. Poly). If it fails, **abort** (no leg 2).  
     - **Place leg 2** (e.g. Kalshi). If it fails, you have **one-sided exposure**; implement a policy (e.g. cancel leg 1 if possible, or hedge, or alert and stop).
   - Use **idempotency** (e.g. `client_order_id` on Kalshi; Poly if supported) to avoid duplicates on retries.

5. **Live loop (server)**  
   - **Timer or cron** (e.g. every 15 s when “live” is enabled):
     - Fetch scoreboard for **today**; filter to **in-progress** games.
     - For those games, fetch unified odds + depth.
     - Fetch balances and open orders.
     - Run arb engine; if any opportunity, **optionally** auto-execute or push to a **queue** for one-click execution (to start, manual trigger is safer).
   - **State**: Track “last run” time, “open arb” count per game, daily PnL (if you persist fills).

6. **UI extensions (optional but recommended)**  
   - **Arb panel**: Table or list of **current opportunities** (game, strategy, size, net profit, fees).  
   - **Config panel**: Min profit, reserves, max stake, enable/disable live arb.  
   - **Risk panel**: Current exposure, open arbs, daily PnL (if implemented).  
   - **One-click “Place arb”** that calls a new endpoint `POST /api/arb/execute` with the chosen opportunity id (so the server runs the two-legged execution).

### 6.2 What stays the same
- **Auth**: Same session and creds for Poly and Kalshi; arb runs **on the server** with the same creds.
- **Existing routes**: `/api/polymarket`, `/api/kalshi`, `/api/nba/upcoming`, `/api/balances`, `/api/my-orders`, and the two order POSTs stay; new logic **calls** them or reuses their data.
- **Visualizer**: The main “compare odds” table can stay; add a **separate** “Arb opportunities” section and a **settings** area for the arb engine.

### 6.3 Safety and operational details
- **Rate limits**: Respect Poly and Kalshi rate limits; add backoff and max requests per minute in the poll loop.
- **Logging**: Log every arb check (game, prices, decision: pass/fail and reason) and every execution (leg 1/2, order ids, amounts). Easiest to start with file logs or a small SQLite table.
- **Kill switch**: Config or UI flag to **disable** auto-execution immediately (poll can keep running for visibility only).
- **Dry run**: Mode where arb engine runs and logs “would place” but does **not** send orders.

---

## 7. Implementation Phases (Suggested)

1. **Phase 1 – Arb math and detection (no execution)**  
   - Add config (min profit, reserves, caps).  
   - Add unified odds (+ depth where easy) for a single game.  
   - Implement arb detection and sizing (with fees) in the server; expose as `GET /api/arb/opportunities` (or similar) that returns list of opportunities.  
   - UI: show these in a side panel or new section.  
   - **No live loop yet**; call opportunities on demand (e.g. when user clicks “Refresh” or a “Check arb” button).

2. **Phase 2 – Two-legged execution (manual trigger)**  
   - Add `POST /api/arb/execute` that takes one opportunity and places **both** legs; implement “leg 2 fails” handling (cancel leg 1 or alert).  
   - UI: “Place arb” button per opportunity.  
   - Track open orders and balances so the next run doesn’t over-allocate.

3. **Phase 3 – Portfolio and risk**  
   - Enforce reserve and available balance in sizing.  
   - Enforce per-game and open-arb caps, and optionally daily loss cap (if you track PnL).  
   - Add risk panel and config UI.

4. **Phase 4 – Live loop**  
   - Add server-side timer for live games; poll scoreboard + Poly + Kalshi for in-play games; run arb engine; optionally auto-execute or show live opportunities.  
   - Add “Live arb” on/off and poll interval to config.

5. **Phase 5 – Hardening**  
   - Websockets if needed for speed; full fill tracking and PnL; more sophisticated “one leg filled” handling (hedge or cancel).

---

## 8. Summary Table

| Topic | Approach |
|-------|----------|
| **Min profit** | Only place when `net_profit ≥ MIN_PROFIT_USD` after Kalshi (and Poly) fees. |
| **Fees** | Model Kalshi taker/maker; Poly NBA low or zero; subtract from gross arb profit. |
| **Risk (beyond stop-loss)** | Per-game cap, open-arb cap, daily loss cap, drawdown pause; execution risk (one leg fills) via time limit and cancel/hedge policy. |
| **Liquidity** | Size using order book depth so as not to exceed available size at price; cap by depth. |
| **Portfolio A (no bust)** | Use `available = balance − reserve − resting` per venue; cap stake by `available`. |
| **Portfolio B (reserve)** | Configurable reserve $ or % per venue; only deploy the rest. |
| **Sizing** | Standard equal-payout formula, then **cap** by liquidity and by available; re-check min profit. |
| **Live** | Poll scoreboard + Poly + Kalshi for in-play games; run arb engine on interval; execute or show opportunities. |
| **Architecture** | Extend existing Express server and frontend; add arb engine, executor, config, and optional live loop; reuse auth, balances, orders, and existing odds endpoints. |

This design keeps the visualizer’s architecture and adds a **fee-aware, risk- and liquidity-aware, portfolio-respecting** arb layer that can run **live during games** with clear phases for implementation and safety.
