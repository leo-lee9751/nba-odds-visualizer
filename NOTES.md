# NBA Odds Visualizer – Project Notes

Quick reference for running the app and signing into Polymarket / Kalshi. Useful when starting a new Cursor chat: say "see NOTES.md in nba-odds-visualizer" and open this file.

---

## Run the app

```bash
cd C:\Users\leole\nba-odds-visualizer
npm install   # first time only
npm start
```

Open **http://localhost:3000** in the browser.

---

## Polymarket sign-in

1. **Get your private key** from the wallet you use on Polymarket (e.g. MetaMask → Account details → Show private key). Use the **Polygon** account; key must start with `0x` (add `0x` if it doesn’t).
2. **Derive API credentials** (Git Bash):
   ```bash
   export POLY_PRIVATE_KEY=0xYourKeyHere
   node scripts/derive-polymarket-creds.js
   ```
3. **Fill the "Sign in to Polymarket" form** with:
   - **API Key** – from script output (UUID)
   - **Secret** – from script output
   - **Passphrase** – from script output
   - **Private key** – same `0x...` key from step 1

---

## Kalshi sign-in

1. Go to **kalshi.com** → **Account** → **API Keys**.
2. **Create new API key**. Save the **private key (PEM)** when shown (Kalshi only shows it once).
3. **Fill the "Sign in to Kalshi" form** with:
   - **API Key ID** – UUID from Kalshi
   - **Private key (PEM)** – full block including `-----BEGIN RSA PRIVATE KEY-----` and `-----END RSA PRIVATE KEY-----`

---

## Upcoming games

The app shows **today’s and the next 7 days** of NBA games from the league schedule. Odds from Polymarket and Kalshi are attached when available; games with no odds still appear with matchup and date.

## Project layout

- **Backend:** `server.js` (Express, `/api/polymarket`, `/api/kalshi`, `/api/nba/upcoming`, auth and place-order endpoints)
- **Frontend:** `public/app.js`, `public/index.html`, `public/styles.css`
- **Polymarket derive script:** `scripts/derive-polymarket-creds.js` (needs `POLY_PRIVATE_KEY` in Git Bash: `export POLY_PRIVATE_KEY=0x...`)

Optional env: `SESSION_SECRET` for production; `KALSHI_API_BASE` for Kalshi API base (e.g. `https://demo-api.kalshi.co` if your API key is from **demo.kalshi.com**; default is production elections API).
