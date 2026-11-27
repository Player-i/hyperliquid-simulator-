# HL Paper Trader — Hyperliquid simulator

A paper-trading simulator that runs on Hyperliquid's **real, live market data**. It uses the same order books, trade tape, mark/oracle prices and funding rates as the real exchange, across every listed perp and spot market. Your orders are simulated against that live data, and no real funds or wallet are involved.

> Unofficial personal practice tool. It isn't affiliated with Hyperliquid and only reads Hyperliquid's public API (`api.hyperliquid.xyz`).

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # engine unit tests
npm run build      # static build in dist/
```

The app is fully client-side: your browser connects straight to Hyperliquid's public WebSocket and REST API, and your account is saved in `localStorage`.

**Hosting:** pushing to `main` runs `.github/workflows/deploy.yml`, which builds and publishes the app to GitHub Pages. To turn this on, go to the repository's *Settings → Pages* and set *Source* to *GitHub Actions*.

## How the simulation works

| Area | Behavior |
|---|---|
| **Markets** | Every live Hyperliquid perp, with its real `szDecimals`, max leverage and margin tiers, plus every spot pair (HYPE/USDC, UBTC/USDC, PURR/USDC, …) |
| **Spot** | Perps and spot have separate balances, as on Hyperliquid, and you move USDC between them with *Transfer*. Buys and sells fill against the live spot book. Fees default to 0.070% taker and 0.040% maker, and are taken from the token you receive. The **Balances** tab shows each holding's average cost and unrealized PnL. Pairs quoted in tokens other than USDC (e.g. USDT0) need that token first. |
| **TWAP** | Like Hyperliquid's TWAP: one market sub-order every 30 s, with at most 3% slippage per sub-order. If earlier sub-orders didn't fill, later ones catch up, capped at 3× a normal slice. Optional size randomization. Duration is 5 min to 24 h, and each sub-order must be at least $10. The **TWAP** tab shows progress and average price. A running TWAP picks up again when you reopen the app. |
| **Market orders** | Walk the live L2 book level by level, so you get the real depth and real slippage. They're capped at 8% max slippage from mid, like Hyperliquid's default. Liquidity you take is removed from a local overlay, so two orders can't fill at the same level until the real book refreshes. |
| **Limit orders (GTC)** | The part that crosses the book fills as taker. The remainder rests at the **back of the queue** at its price. |
| **Queue position** | Your queue position shrinks when real trades print at your price and when size ahead of you is cancelled. You fill only when real aggressive flow reaches you, a trade prints *through* your price, or the book crosses your price. The **Open Orders** tab shows how much size is still ahead of you. |
| **ALO / IOC** | Post-only orders are rejected if they would cross. IOC orders cancel any unfilled remainder. |
| **PnL tracker** | A separate *PnL Tracker* view. You can filter by date range (24H, 7D, 30D, 90D, YTD, all time, or custom from/to dates), market (perps or spot), coin, and longs vs. shorts, and include or exclude funding. It shows net PnL, realized PnL, fees, funding, volume, win rate, profit factor, average win and loss, best and worst trade, green days and max drawdown. Charts: cumulative net PnL, daily net PnL and account equity. Tables break results down by coin, by day, by closed trade, and as a full ledger. Everything can be exported to CSV. |
| **Trigger orders** | Stop Market/Limit and Take Profit Market/Limit, plus position TP/SL. They trigger on **mark price**, like Hyperliquid. Market triggers use 10% slippage. |
| **Tick/lot rules** | Prices use at most 5 significant figures and at most `6 - szDecimals` decimals. Sizes are rounded to `szDecimals`. Minimum order value is $10. Limit prices more than 80% from the reference price are rejected. |
| **Fees** | Base tier: 0.045% taker and 0.015% maker. You can change these in Settings, including negative maker fees for rebates. |
| **Margin** | Cross and isolated margin, with per-asset leverage limited by the asset's margin tiers. Resting orders reserve margin. In isolated mode you can add or remove margin. |
| **Liquidation** | Maintenance margin is half the initial margin at max leverage. The liquidation check runs on mark price, and the liquidation price uses Hyperliquid's formula. A liquidated position is market-closed into the live book. |
| **Funding** | Settled hourly on the hour using the live funding rate × oracle price. When funding is positive, longs pay shorts. |
| **Latency** | Each order or cancel is delayed by a configurable network latency before it reaches the simulated exchange. The default is 150 ms ± 30% jitter. |

### Known limitations
- Hyperliquid's public book feed shows the top 20 levels on each side. If a resting order sits deeper than that, its queue position is unknown until the price comes into view.
- Your simulated orders don't move the real market. On illiquid coins, a fill you'd really get could push the price, and that impact isn't modelled after your own fill.
- Scale orders, spot TP/SL and partial liquidations aren't modelled yet.
- The account equity curve is sampled once a minute, and only while the app is open. Realized PnL, fees and funding come from the full trade history, which keeps the last 10,000 fills.

## Code layout
- `src/engine/engine.ts`: matching, margin, liquidation and funding engine. It's pure TypeScript and unit tested in `engine.test.ts`.
- `src/engine/rules.ts`: Hyperliquid tick and lot rules.
- `src/api/hl.ts`: Hyperliquid info API plus a WebSocket manager with ref-counted subscriptions and reconnect.
- `src/store.ts`: connects live feeds to the engine and handles persistence.
- `src/ui/*`: chart, order book and tape, order form, positions/orders/balances/TWAP/history tables, modals, and the PnL tracker (`Portfolio.tsx`).
