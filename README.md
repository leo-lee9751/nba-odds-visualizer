# NBA Odds Visualizer

Compare NBA game moneyline odds from **Kalshi** and **Polymarket** side by side.

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
