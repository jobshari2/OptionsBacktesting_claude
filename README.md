# Nifty Options Lab — live chain and ideas, strategies, covered call, portfolio hedge (Upstox)

A local web app for Nifty options on the Upstox API. Its screens are grouped in the top bar:

- **Live:** the option chain with a Nifty chart and support / resistance, the volume surge and price signals with their track record, and **Live Ideas**: the trades the live chain suggests (arbitrage, verticals, the Market Pulse trade idea, neutral and back spreads). Everything is recorded to an all-day tape.
- **Strategies:** ready-made and your own strategies, deployed on the live chain, and a **Builder** to trade a position by hand on a historical replay (real 1-minute option prices) or the live chain.
- **Trading Ideas:** the **Modified covered call** against NIFTYBEES, with its rules and adjustments, a backtest, a live paper trade and a live trade; and a **Strategy lab** to try a new options structure (starting with ways to profit when Nifty falls).
- **Portfolio:** hedge your holdings with Nifty options — the cheapest hedge for a loss limit you set, and a backtest of hedges back to 2008.
- **Data:** what history Upstox provides and what is cached.

You need Node.js 22 or newer. Run `npm install` once (installs `protobufjs` for the tick feed, `chart.js` and `lightweight-charts` for the charts, served locally).

## Setup

1. Create an app at <https://account.upstox.com/developer/apps> and set its Redirect URL to `http://localhost:3000/callback`.
2. Copy `.env.example` to `.env` and fill in `UPSTOX_API_KEY` and `UPSTOX_API_SECRET`, or paste a token into `UPSTOX_ACCESS_TOKEN`.
3. Set `AUTH_USERNAME` and `AUTH_PASSWORD` in `.env` to require a sign-in. The page then shows a login screen first, every `/api/*` route answers 401 without a session, and a **Sign out** button appears in the top bar. Scripts can send an HTTP Basic header (`curl -u user:pass ...`). With either value empty, sign-in is off and the server prints a warning. The sign-in lasts `AUTH_SESSION_HOURS` (default 12) and ends when the server restarts.
4. Run `npm start` and open <http://localhost:3000>.
5. Click **Login with Upstox** if asked. The token is saved to `.token.json` until it expires (about 3:30 AM IST the next day).
6. Optional, Zerodha Kite: click the **Kite** chip at the top, enter your Kite Connect app's **API key** and **API secret** (from <https://developers.kite.trade/apps>; set the app's Redirect URL to the address the chip shows, `http://localhost:3000/kite/callback`), then **Login with Kite**. With **Live data: Kite** picked at the top, every live screen takes its prices from Kite instead of Upstox; the **Trade on Kite** buttons send orders (see [Live data from Upstox or Kite](#live-data-from-upstox-or-kite-and-orders-on-kite)).

`npm run demo` shows the live screens with synthetic data. Historical replays, backtests and the Hedge screen need real Upstox data. `npm test` runs the tests.

To run it on Azure App Service (Node 22 LTS, Linux), see [docs/azure-deployment.md](docs/azure-deployment.md): the settings, the code changes still needed, and the VS Code steps.

## Screens

Pick a group in the top bar; its screens are in the row below. A group reopens on the screen you last used in it.

| Group | Screen | What it's for |
| --- | --- | --- |
| **Live** | **Chain** | Option chain; beside it the Nifty chart with support / resistance or the signals (with the one-line Market Pulse); under them the **ATM option charts** (the ATM call and put, following the ATM; collapsible); under the chain spread arbitrage or the volume surge |
| | **Live Ideas** | The best trades on the live chain in one place (with the Nifty chart floating at the top right of the window: drag, resize, minimise or hide it), each with max profit / loss at expiry, as cards or a table: **Best trades** (arbitrage first, then reward-to-risk × chance of profit within a loss limit), vertical-spread arbitrage (same list as Chain), **other arbitrage** (butterfly, broken-wing butterfly, box, calendar), debit verticals, the Pulse trade idea with its writers / buyers read, Pulse buyers and writers, neutral, back spreads, **miscellaneous** (the best of each other defined-risk structure) and your saved paper trades. Open any in the Builder or save it as a live paper trade |
| **Strategies** | **Strategies** | Ready-made and saved strategies as cards (reset edited built-ins, delete your own); **Deploy live** on an upcoming expiry, **Builder ▸**; **+ New strategy** opens the Builder |
| **Builder** | **Builder** | Manual / strategy trading on a historical replay or live (paper), payoff, Greeks, P&L |
| **Trades** | **Trades** | Trades saved from the Builder (live paper trades and replays) and the Modified covered call's paper trade; load one back |
| **Trading Ideas** | **Covered call** | The Modified covered call: NIFTYBEES worth one lot plus a monthly call ratio 1×2 and a 2-3-1 put butterfly: **Strategy & rules**, **Backtest** (with the adjustment study), **Paper trade** and **Live trade** |
| | **Strategy lab** | Try a new options structure written as legs from ATM: **Idea** (how the Modified covered call can be simplified to profit from a fall, with a model of each version), **Build & payoff** (edit the legs, payoff at expiry and today, with or without NIFTYBEES), **Backtest** (every monthly or weekly series, trend filter, target / stop) and **Compare** (every preset, always in and only in a downtrend, on the same series) |
| **Portfolio** | **Hedge** | Protect your holdings with Nifty options: planner and backtest |
| **Data** | **Data** | What history Upstox provides, what's cached, downloading what is missing (by hand or automatically) |

The colour theme (Night, Day, Large) is picked at the top right.

---

## Part 1 · Live

## Live chain (Chain screen)

- **Top bar:** spot, ATM, PCR, the expiry and strike-range pickers, IST time, and data age and status.
- **Option chain:** calls on the left, puts on the right.
  - Bid/ask cells are tinted by order-book pressure.
  - Shading: ITM rows are shaded, ATM is gold, and a line marks spot.
  - The highest OI on each side is outlined.
  - Vol Δ shows volume added over the window picked in the chain header (1/3/5/15 min). LTP flashes when it ticks.
  - Strikes carrying a support (**S**, green) or resistance (**R**, red) level are tagged; filled tags are major levels. Hover for the source.
- **Right half of the screen** shows one of two panes, picked with the switch above it: **Chart & levels** (below: the Nifty chart, the collapsible **ATM option charts** with the ATM call and put side by side, then Support & resistance and Order flow) or **Signals** (see *Signals*). New signals that arrive while the chart is showing are counted on the Signals button; the count turns red and blinks for a high-probability one.
- **Nifty chart** (Chart & levels): every trade (**Tick**) or candles of 1, 3, 5, 10, 15 minutes, 1 hour, 2 hours, day, week or month, with the support / resistance levels drawn across. Drag to move, wheel to zoom, scroll back to load older candles; **Candles / Line**, **S/R**, **Order flow** and **Δ / CVD** on/off, **Latest**. The hovered candle's open / high / low / close is shown at the top left; hovering a support / resistance line shows its details (major / minor, distance from Nifty, source). The levels are worked out afresh each day from the sessions before it; past the last of them (a new high or low) **dashed** levels are projected from the next round numbers (500s major, 100s minor) and the previous day's R3 / S3 pivots, following the live price. The small chart icon beside each strike in the chain (left = the call, right = the put) shows that option's candles (1 minute to a day, from Upstox, following its live price) with their volume in the same chart; S/R and order flow are Nifty's, so they step aside. The **Nifty 50** button above the chart brings Nifty back.
  - **Nifty Fut**, beside Nifty 50 (also in the chart window and on Market Pulse), shows the near-month Nifty future: candles of 1 minute to a day with their volume, following its live price, and its trades on the Tick view. The contract is looked up once a day with Upstox's instrument search, so it moves on to the next month after expiry, and it is streamed all day whether or not the chart shows it. Its name is in the status line under the chart. S/R and order flow belong to Nifty spot, so they step aside here too. The chart remembers that it was showing the future.
  - **Volume** (the future and options; Nifty is an index and has none): bars along the bottom of the chart, green when the candle closed up and red when down. The legend at the top left gives the hovered candle's volume in units and lots. The **Volume** button hides or shows them.
  - **Tick**: every trade of today, evenly spaced (a tick chart, not a time axis), with each trade's quantity as its volume bar. The time axis and the legend show when each trade happened, the crosshair to the millisecond. For Nifty a tick is each change of the index (no volume). The server records the trades off the live feed for Nifty, the future, the options it streams (15 strikes either side of the money) and whatever the chart shows. It records them only while it runs: a restart starts the day over, and earlier days have no ticks. They are kept in memory only (up to 150,000 per instrument). Order flow and trend lines are per candle, so they are off on this view.
  - **ƒx Indicators** is also in the chart on this screen (same menu and legend as in the window, remembered separately), and **New window** is there for every chart (Nifty, the future, an option; the window opens on the Nifty or the future, on the same timeframe).
  - **New window** opens the chart in its own window (`chart.html`) with the full tool set: **indicators** (SMA, EMA, Bollinger Bands, Supertrend on the price; RSI, MACD, ATR, Stochastic in their own panes; any parameters, several at once, ✕ in the legend removes one), chart types (candles, bars, Heikin Ashi, line, area), **drawings** (horizontal and trend lines; right-click one to remove it), log scale, PNG snapshot and full screen. Indicators and drawings are remembered.
  - History is read from the cached 1-minute Nifty files (`bt-cache/index`); today's candles come from the Upstox intraday endpoint (re-read every 30 s) and the last candle follows the live tick feed.
  - **Order flow** (a footprint, on by default on 1 to 120-minute candles): the candles are drawn thin, with the volume traded at each Nifty level beside them, **calls on the left and puts on the right**, and the candle's **Delta** and **Total** (in lots) underneath. A cell turns green when one side of it is 3:1 or more bought-calls / sold-puts (the market going up) and red for sold-calls / bought-puts; the busiest level of a candle is boxed. Nifty is an index with no volume, so the flow comes from the Nifty options within ±10 strikes of the money: each trade is classed as started by the buyer or the seller (at the ask / at the bid) and placed at the Nifty level at that moment. Delta = calls bought + puts sold − calls sold − puts bought. The chart zooms to the few candles that fit with readable numbers; zoom out and the cells shrink to colour only. Only days this app recorded have flow, so older candles show just the candle. Earlier days are read from the tape in the background (`ORDERFLOW_DAYS`, 10 by default) and cached in `events/_orderflow-cache/`.
  - **Δ / CVD** adds two panes under the candles instead: the net buying minus selling per candle, and its running total for the day (restarts each day).
- **Under the chain** is one of two panes as well: **Arbitrage**, the live vertical-spread arbitrage of the expiry shown (click its header to fold it away), or **Volume surge** (see *Volume surge and Surge charts*).
- **Support & resistance / Order flow panel** under the chart, two tabs (a dot on the Order flow tab shows the current lean):
  - **Support & resistance:** nearest major/minor resistance and support with distance from spot, and the full ladder around Nifty.
  - **Order flow:** what the flow of the Nifty options says right now. A verdict (buyers or sellers in control, or balanced) with a strength meter, then the reasons behind it: net flow over 15 and 5 minutes and which side drives it (calls or puts), the order-book lean against its day average, a **divergence** (Nifty makes a new high or low in the last 15 minutes without the cumulative delta following), **absorption** (heavy flow in 5 minutes that does not move Nifty), and whether flow confirms or contradicts the last 15 minutes of price. A table gives the call and put buys and sells, delta and bias over 1, 5, 15 and 30 minutes and the session. Outside market hours it reads the last recorded session. It is a read of the tape, not a prediction.
  - Click the panel header to collapse it (the chart takes the space).

## Support and resistance

| Class | How it is found |
| --- | --- |
| Major | swing highs/lows of daily bars over the last ~120 sessions, clustered within ~0.35%, ranked by touches and recency (a level that flipped from resistance to support counts extra), plus the range high/low |
| Minor | swing points of 15-minute bars over the last 5 sessions, clustered within ~0.12%, plus the previous day's high, low, close and floor pivots (P, R1, S1, R2, S2) |
| OI (live chain only) | the strikes with the highest and second-highest call OI (resistance) and put OI (support) |

A level below spot is support, above is resistance. Levels for a day use only earlier sessions, so backtests have no look-ahead. They are used on the Chain screen and its chart, by the Market Pulse (Live Ideas), in strategy conditions and strikes in Deploy live, and in the Builder.

## Signals

The **Signals** pane of the Chain screen shows a volume breadth meter (share of strikes near ATM trading above normal in the last minute), a flashing **BROAD VOLUME SURGE** banner when most strikes surge together, and today's spike log. Each entry shows what happened afterwards: the spot move, max up/down, and call/put volume before vs after.

The server watches the nearest expiry all through market hours, even with no browser open. It raises these signals:

| Signal | Fires when (defaults) |
| --- | --- |
| Strike spike | a strike's last-minute volume is ≥ 3× its normal per-minute volume (average of the previous 15 min) and ≥ 25,000 units |
| Broad surge | ≥ 60% of the strikes within ±10 of ATM trade ≥ 2× their normal volume at the same time |
| Nifty ▲ / Nifty ▼ | Nifty rises or falls ≥ 15 points within 20 s, or ≥ 25 points within 1 minute (separate signals, so a sharp fall right after a rise still fires) |
| Premium ▲ / Premium ▼ | a call or put near ATM rises or falls ≥ 10% within 1 minute (options under ₹5 are ignored). CE and PE are reported separately, so a sudden fall shows up as both "PE premium ▲" and "CE premium ▼" |
| CE + PE rising | on ≥ 3 of the 5 strikes around ATM, the call and the put are both up ≥ 3% within 1 minute. Normally one side falls when the other rises, so both rising means option prices (IV) are expanding, which often comes before a big move |

The Signals pane also shows the ATM call, put and straddle premium change over the last minute, and how many strikes around ATM have calls and puts rising together.

For each signal it saves the 5 minutes before, and keeps recording after it until things cool off: at least 1 minute after the last signal, then 30 seconds in a row with no volume or price condition active. The most it records after the last signal is 5 minutes. A new signal during a recording joins it. While a recording is running, the REC badge shows how long it has been going and how close it is to cooling off (for example `REC 1:12 · calm 18/30s`). Files go to `events/<date>/`:

- `events.csv` has one row per signal: spot before, at and after the signal, the move after it (change, max up and max down), and call/put volume added before vs after.
- `HHMMSS_<type>.csv` has every snapshot (one every ~3 s) for the strikes around ATM: LTP, volume, volume added since the previous snapshot, and OI for calls and puts. The `signal` column marks the moment each signal fired.

### Track record and high-probability signals

Every signal in the log also shows how the same kind of signal played out on earlier days, for example `▼ 81% Nifty fell 10 pts before rising 10, within 5 min, in 38 of 47 past cases (any moment: 52%)`.

- **Kinds:** the signal type plus its side (PE premium ▲, CE premium ▼, …). Volume spikes are split by the strongest strike's side and whether buyers or sellers led its trades in that minute (from the tick feed's bid/ask).
- **Outcome:** which came first within 5 minutes of the signal, Nifty +10 pts or −10 pts, read from that day's tape. Signals of one kind less than 3 minutes apart count as one case.
- **Any moment:** the same outcome measured every 30 s of the same days. On a falling day "falls first" is common anyway, so a signal only means something if it beats this.
- **HIGH PROBABILITY:** hit rate ≥ 70% over ≥ 15 cases, ≥ 15 percentage points above "any moment", and above it on each of at least 2 days. These entries are tinted in the log, and a banner with the percentage stays at the top of the Signals pane for the 5-minute outcome window.

The record is rebuilt when the server starts, from every finished day that has `events.jsonl` and a tape (cached in `events/signal-odds.json`), so it updates as more days are recorded. `node sigstats.js` prints the full table; the thresholds are constants at the top of `sigstats.js`. With only a few days recorded, treat the percentages as provisional.

## Volume surge

The **Volume surge** pane under the option chain is a column chart with call volume added growing up and put volume added growing down for each strike. The top 3 strikes on each side are numbered, and are listed on the left with their price change. Hover over a column to see exact values. The Calls Δ vs Puts Δ bar shows which side is more active. Each strike also shows its volume growth as a % of its volume at the start of the window ("new" means it had no volume before). Use **Bars: Qty / %** to size and rank by quantity or by %, and **Highlight ≥ 5 / 10 / 25 / 50%** to outline every strike that grew by at least that much. The window (1, 3, 5 or 15 minutes) is the one picked in the chain header.

The **Strikes: Fit screen** option shows as many strikes around ATM as fit, so the chain and the pane under it are visible without scrolling.

## Market Pulse (behind Live Ideas)

A live, plain-language read of what the market is doing, recomputed every 5 seconds from the tick data for the nearest expiry (`pulse.js`). It has no screen of its own: its one-line headline sits at the top of the Chain screen's Signals pane, and its trade idea, its option writers / buyers read and its bias drive the **Pulse trade idea**, **Option buyers** and **Option writers** sections of Live Ideas.

- **Headline and bias:** the trend (sideways, rising or falling, strong rise or fall) plus whether it is accelerating, pausing or reversing, and whether three independent reads agree: the trend, what option writers and buyers are doing, and the order flow of the last minute (calls bought + puts sold against puts bought + calls sold, from the tick feed's bid / ask; `flow.js`, set by the `FLOW_*` values in `.env`).
- **Option writers & buyers:** for each strike within ATM ±5 over the last 15 minutes, OI change plus premium change classify the activity as long build-up (buying), short build-up (writing), short covering or long unwinding, for calls and puts.

It keeps about 100 minutes of context and refills it from today's tape after a restart. A summary is logged every minute to `events/<date>/pulse.jsonl`, and the trade idea's paper trades to `events/<date>/pulse-signals.jsonl` (`node pulse-backtest.js` replays recorded days). It describes what the data shows and is not a trading recommendation: the Pulse idea lost money after costs on the recorded days.

## Zerodha Kite login, and orders from Live Ideas

Logging in to Kite (the session lasts until about 6 AM IST the next day and is saved in `.kite-token.json`). There is one login for the whole app: the **Kite** chip in the top bar (also in the Live Ideas order dialog) opens the same controls, and a login or logout anywhere updates every screen:

- **Kite Connect** (the official API; quotes and streaming need the paid Connect plan): type the app's **API key** and **API secret** into the Kite chip (kept in `.kite-app.json`, never shown again; **Change** / **Remove** there), or put `KITE_API_KEY` and `KITE_API_SECRET` in `.env`, and set the app's Redirect URL to the address the chip shows (`http://localhost:3000/kite/callback`). Then use **Login with Kite**. **Log out of Kite here** also ends the Kite Connect session at Kite. If you are already logged in to Kite in the browser, Kite usually sends you straight back. Tick **Auto-login** to do this by itself whenever the screen opens without a Kite login. `KITE_ACCESS_TOKEN` in `.env`, or **Use a token…**, takes an access token directly.
- **Kite web session (enctoken)**, which is unofficial and undocumented, so Zerodha can change or block it: drag **Send Kite login here** to the bookmarks bar, then click it on kite.zerodha.com while logged in. It hands your web session to this app, which checks it with Kite before keeping it. You can also paste the enctoken and user ID under **Use a token…**, or set `KITE_ENCTOKEN` and `KITE_USER_ID` in `.env`.

**Trade with Zerodha Kite (Live Ideas, real money).** Every idea on Live Ideas (cards, table, arbitrage rows, the Pulse idea) has an orange **Trade with Zerodha Kite** button before **Open in Builder**. It opens a dialog with the legs as Kite instruments, quantities, the price shown and the order that will be sent, an editable **Lots** box (every leg is multiplied by it; the figures follow), **Limit** or **Market price** orders, the product (**NRML** carry or **MIS** intraday), for limit orders a **limit buffer** (points added to a buy and taken off a sell, rounded to the 0.05 tick; 0.5 by default), the credit or debit, the estimated charges and a **lot suggestion**: your available funds are read from Kite, the margin of the whole basket is asked of Kite's own calculator (a spread's long leg hedges its short leg; if Kite cannot answer, the larger of the debit and the max loss is used), and the suggestion is the lots the funds cover (keeping 10% spare), limited by the loss limit set on the Live Ideas screen and by Nifty's freeze quantity, with a **Use N lots** button. **Market price** orders fill at once at the best price on the book, which can be worse than the price shown (`KITE_MARKET_PROTECTION` in `.env` is sent with them if you set it). Nothing is sent until you tick *I understand these are real orders* and press **Place N orders on Kite**. The order sequence, limit or market: the **BUY legs first** and the **SELL legs only when every BUY has filled**, so the shorts are never uncovered; a leg that has not filled after about 20 s is cancelled (a BUY that fails means nothing is sold; a SELL that fails leaves the bought legs open in Kite, reported as *partly filled*). A basket with no BUY leg, more than 8 legs or an order above Nifty's freeze quantity (1,800) is refused; only one basket is sent at a time and the same basket is not sent twice within 15 s. Orders go out only in market hours and before 15:25 IST, and only with a Kite Connect login, or an enctoken web session when `KITE_ORDERS_ENCTOKEN=1` is set in `.env` (the web session is unofficial; the dialog says so when that is the reason an order cannot go out). In demo mode the fills are simulated and nothing is sent, even if a real Kite login is saved. Every basket is logged in `logs/kite-baskets.jsonl`. The prices shown follow the screen's **Prices** switch (LTP by default): a limit order at the last traded price may not fill, so raise the buffer or switch to **Bid / Ask**. The code is `kitebasket.js` (tested against a fake Kite in `test/kitebasket.test.js`).

## Colours

Calls (CE) are **green** and puts (PE) are **red** on every screen (chain, signals, order flow, charts). Support / resistance levels keep their own colours: **S** green, **R** red. Up / down moves are green / red as before.

## Does an indicator actually help? (scorecard)

```
node study.js 2026-10-01
```

For every minute of a recorded day, this takes each reading's direction (up, down or no call) and checks Nifty's move over the next 5 and 15 minutes. It scores:
- the trend baseline (follow the 15-minute move)
- order flow, both aggressor and premium-direction
- the order book compared with its own 30-minute average, and its change over 5 minutes
- combinations such as "trend and order book agree"

Order-book readings are shown in Market Pulse as information only. They won't vote in its alignment until the scorecard shows they beat the trend baseline across several different days.

## What is saved

Everything for a day is in `events/<date>/`:

| File | Contents |
| --- | --- |
| `tape-HHMMSS.jsonl.gz` | **The market tape**: one compressed line per second for the nearest expiry, holding Nifty spot plus, for CE and PE at ATM ±15 strikes, LTP, volume and OI. With the tick feed it also holds buyer- and seller-initiated volume, best bid and ask with the quantity at each, and the total buy and sell queue. Each server start begins a new part. About 15 MB per trading day. Everything below can be recomputed from it. |
| `pulse.jsonl` | Market Pulse summary once a minute (headline, bias, trend, OI activity totals, levels, straddle, IV, flow) |
| `predictions.csv` / `.jsonl` | Each order-flow prediction with its outcome (written when it finishes) |
| `events.csv` / `.jsonl` | Each spike signal with the before/after summary |
| `HHMMSS_<type>.csv` | Snapshots around each spike, for ATM ±10 (also covered by the tape) |

The live CE/PE flow curve isn't saved separately, because a replay rebuilds it exactly from the tape.

## Where the live data comes from

The **Live data: Upstox | Kite** switch at the top of the page picks the source (see the next section). What follows describes Upstox; with Kite the same happens on Kite's own tick feed and quotes.

- **Tick feed (WebSocket):** Nifty, the near-month Nifty future and 15 strikes either side of ATM (calls and puts) stream live from Upstox's Market Data Feed V3, plus any option the chart is showing. Ticks are folded into a snapshot every 500 ms, and the page refreshes every 400 ms. Subscriptions follow ATM as it moves.
- **REST option chain:** gives the full strike list, previous OI and the strikes outside the streamed range. It refreshes every 15 s while the feed is live, or every `POLL_MS` (1.5 s) if the feed is down. If the feed drops, the app falls back to polling and reconnects on its own.

The status at the top right says which one is in use. Set `FEED_STRIKES` in `.env` to stream more or fewer strikes.

## Live data from Upstox or Kite, and orders on Kite

Both logins stay available side by side. The **Live data** switch in the top bar (a green dot = logged in to that broker) picks where every live screen gets its prices: the chain and its signals, the Nifty and Nifty Fut charts and the option charts, the Market Pulse, Live Ideas, the Builder's live mode, Strategies › Deploy live (and the anomaly scanner behind it), the Covered call paper and live trade, and the Hedge planner's chains. The choice is kept in `bt-data/live-source.json` (`LIVE_DATA_SOURCE=kite` in `.env` sets the default) and takes effect at once: the chains are read again from the new source, the per-strike history (volume windows, signals) carries on. When the picked broker is not logged in, the screen shows its login (and a link to switch back).

What stays on Upstox whichever is picked: the Builder's historical replay, the Covered call and Strategy lab backtests, the Data screen and the Hedge price history (Kite has no expired option contracts).

**Kite as the source** (`lib/kitedata.js`). It answers the server's questions in Upstox's shapes, so every screen works unchanged:

- **Contracts:** expiries, lot size and the Nifty futures from Kite's NFO instrument list (read once a day).
- **Chain:** one full-quote request per expiry (up to 500 instruments; Kite allows one quote request a second, which the app keeps to): LTP, previous close, volume, OI, best bid / ask and their quantities. Kite gives **no greeks**: IV, delta, gamma, theta and vega are worked out here with Black-76 on the forward implied by put-call parity at the strikes nearest the money (falling back to spot carried at 6.5 % when the quotes do not agree within 0.25 %), from the mid of a two-sided quote or else the last price. An option priced at or below its intrinsic value gets no IV.
- **Previous day's OI:** Kite's quote has none, so it is read from the daily candles with OI in the background, once a day per expiry (kept in `bt-data/kite-prev-oi.json`). This needs Kite's historical data; without it the OI change reads against zero.
- **Ticks:** Kite's WebSocket in full mode (5-level depth, OI) for Nifty, the future and the strikes around the money, with the same buyer / seller split of new volume as the Upstox feed.
- **Candles:** today's Nifty candles and the option / future charts come from Kite's historical API (1-minute candles, the last 4 weeks).
- **Login:** live data needs a **Kite Connect** login (API key + secret): Kite's web session (the enctoken from the bookmarklet) has no quote API, and the chain says so. A token Kite refuses is dropped, and the page asks for a new login.

**Orders on Kite from every screen** (`public/kite-order.js`, sent by `kitebasket.js`). An orange **Trade on Kite** button sits beside the legs on the Builder (live mode: the open legs ticked in Positions, at the live prices; **Close on Kite** sends the reverse of each), Strategies › Deploy live, the Hedge planner's selected structure and every live vertical-spread arbitrage row (Chain and Builder); Live Ideas keeps its own dialog with the lot suggestion. The dialog is the same one everywhere: the legs as Kite instruments, a × lots multiplier, Limit (with a buffer) or Market, NRML or MIS, the credit or debit and the charges, max profit / loss at expiry (with a red warning when the loss is unlimited), your funds and Kite's margin for the basket, and nothing is sent before *I understand these are real orders* is ticked. The rules are those of Live Ideas above: BUY legs first, SELL legs only after every BUY filled, unfilled legs cancelled after about 20 s, market hours only. A basket made only of SELL legs is sent only when each of them **closes a long Kite already holds** (same instrument and product, enough quantity): an exit, never a new short. Only `kite-order.js`, `ideas-view.js` and the server reach the basket, which `test/no-orders.test.js` checks.

### How volume change is calculated

The server keeps 16 minutes of snapshots per strike (every 500 ms with the tick feed). For each window, Vol Δ is the current cumulative volume minus the volume at the start of the window. History starts when the server starts. Until it has a full window of data, the widget says how much it has collected so far. Outside market hours, the server stops calling Upstox if no browser has asked for data in the last 30 seconds.

---

## Part 2 · Strategies

## Historical data (checked against the Upstox API)

| Data | Source | Range |
| --- | --- | --- |
| Expired Nifty options, every strike, 1-minute OHLC + OI | `/v2/expired-instruments/expiries`, `/option/contract`, `/historical-candle` | ~2 years: 105 weekly + monthly expiries, 3 Oct 2024 → latest expired |
| Nifty 50 and India VIX, 1-minute | `/v3/historical-candle` | since Jan 2022 |

- **How data is fetched:** one request returns a contract's whole last month of minute candles in about 100 ms.
- **Download on demand:** backtests fetch only the contracts they need, the first time they need them.
- **Cache:** everything is saved under `bt-cache/` as gzip files and kept in memory, so re-running a 6-month backtest takes milliseconds.
- **Rate limits:** Upstox allows about 500 requests/min and 2,000 per 30 minutes. The downloader stays under both and waits when needed (the progress bar says so).
- **Data screen:** shows coverage per expiry and downloads what the cache lacks. Choose the expiries: **New** (since the last one downloaded, the latest 8 at most), **Recent** (the last 1 to 12 months, or everything Upstox has), a **Date range**, or **Pick expiries** (also by clicking the coverage bars; Shift-click for a range), weekly, monthly or both. Choose how much of each: every strike within ± N strikes of the Nifty range over the last D trading days before the expiry, calls and puts. The screen says how many of those contracts are missing and how many requests they take; **Download missing data** fetches only those. **Stop** ends a download early; what it fetched stays.
- **Automatic update:** while the server runs it does the **New** download by itself, about 20 seconds after the start (or after the login) and then every 30 minutes, with the strikes and days set on the Data screen. So a week's options are in the cache the day after they expire, without opening the Data screen; a check that finds nothing new costs four requests an hour at most. The checkbox on the Data screen switches it off (kept in `bt-data/data-sync.json`). It does not run in demo mode or while logged out.
- **Lot size:** history uses lots of 25, then 75, then 65. Backtests use a fixed lot (today's) by default so years compare fairly; switch to **As traded** to use each expiry's real lot.

## How a strategy is defined

Strategies are defined *relative to the market*, so one definition works on every expiry (`bt/strategy.js` fills in the defaults; `bt/library.js` has the ready-made ones; your own are in `bt-data/strategies.json`).

- **Type:** intraday (entry and exit times on the same day, chosen weekdays and days to expiry) or positional (entered N trading days before the weekly or monthly expiry).
- **Each leg** (up to 12): Buy / Sell, CE / PE, lots, expiry (this week, next week, this month, next month; calendars and diagonals mix them) and a strike rule:

  | Rule | Picks the strike… |
  | --- | --- |
  | ATM ± strikes | N strikes from ATM: OTM *n* (or ITM *n*) |
  | Premium | closest to ₹X, the cheapest at or above ₹X, or the dearest at or below ₹X |
  | Delta | closest to the given delta |
  | % / points from spot | at that distance from spot |
  | Straddle width | at ATM ± (ATM straddle price × multiplier) |
  | From another leg | that leg's strike ± points |
  | Anomaly strike / S/R | the strike a live anomaly flags, or the nearest support / resistance level |

- **Stop-loss is judged on the whole strategy's loss, never a single leg.**
- **Entry trigger:** *at the entry time*, or *on a signal* (an anomaly firing, Nifty near or through a support / resistance level, a Nifty move, the day's range). Deploy live evaluates the signal conditions on the live chain right now.

## Strategies and live deployment

Ready-made strategies are grouped by outlook:

| Group | Strategies |
| --- | --- |
| Neutral | 9:20 straddle (plain, MTM lock & trail), ₹50 strangle, expiry-day straddle, intraday and weekly iron condors, iron butterfly, 0.2-delta weekly strangle, weekly iron condor with the tested side rolled when a short doubles, multi-week monthly iron condor, butterfly |
| Bullish / bearish | debit and credit spreads, long call / put, jade lizard, 1×2 ratio spreads |
| Volatility | long straddle, long strangle, trailing straddle buy |
| Calendar | call calendar, double calendar |
| Bi-weekly | the bi-weekly hedge, its reverse and their variations |
| Back spread | 1×2 back spread + 2 butterflies, put and call side |
| Arbitrage | one signal strategy per anomaly type and direction, entered when the background scanner fires |

Each card shows a payoff sketch and its buttons:
- **Builder ▸:** opens it in the Builder on the live chain, to paper trade or customise it (and save it back as a strategy).
- **Deploy live:** resolves the strategy on the current option chain for the expiry you pick, then shows:
  - each leg's strike, price, bid/ask, IV and delta
  - net credit or debit, max profit and loss, breakevens
  - chance of profit, estimated margin, net greeks
  - a payoff chart at expiry, today (T+0), and on any day in between

  Nudge strikes with − / +, change lots, or switch between LTP and bid/ask pricing. **Save as my strategy** stores changed strikes as ATM offsets, so the saved strategy applies to all future expiries.

## Anomaly scanner (in the background)

The server scans the nearest expiry every 5 s during market hours for prices that break a no-arbitrage bound (box, butterfly, broken-wing butterfly, vertical, calendar) or stray from fair value (`anomaly-live.js`, `bt/anomalies.js`). It has no screen: **Strategies › Deploy live** reads it for the entry conditions of signal strategies (the library's **Arbitrage** category) and their "anomaly strike" legs. Its thresholds and quality gates are in `bt-data/anomaly-config.json`, and what it finds is logged to `bt-data/anomaly-log/<date>.jsonl`. **It never places an order.** Live Ideas' own arbitrage sections scan the chain they show in the browser.

## Strategy Builder (Builder screen)

- **Source:** *Historical replay* (any expired expiry, start on any day of its last ~5 weeks at any time) or *Live (paper)* on an upcoming expiry (prices refresh every 5 s; entries/exits are recorded at LTP — no orders are sent).
- **Chain (left):** LTP, delta, IV (and OI live) with **B** / **S** buttons per strike, S/R tags, open-position markers. Or pick any built-in / saved strategy and **Apply** it at the current time (strike rules resolved on the chain; lots multiplier).
- **Payoff (right):** at expiry and now (T+0), spot, ±1σ and breakevens; credit/debit, max profit/loss, chance of profit, net Greeks.
- **Saved trades:** **💾 Save trade** keeps the position in the Builder — a live paper trade or a replay — with its legs, entries and exits, log and P&L (`bt-data/paper-trades.json`). The **Trades** screen lists them all: mode, expiry, open legs, realised / open / total P&L at the last save and, for live paper trades, the total at current prices (**↻ Live P&L**). **Load** puts a trade back in the Builder with its payoff, positions and P&L; adjust it and press **Save changes** (or **Save as new…** for a copy).
- **Replay:** step 1, 3, 5, 10, 15, 30 min, 1 h, 2 h or 1 day — **▶ Step** manually or **⏵ Auto play** at 0.5–4 s per step. *Intraday* stops (and squares off) at the close; *Multi-day* carries the position overnight to expiry, where open legs settle.
- **Positions & P&L:** every leg with entry/now/exit, P&L, delta, **Exit**, roll one strike ◀ ▶, realised/open/total, a P&L-vs-Nifty chart over the replay, and a trade log.
- **Vertical spread arbitrage** (beside Positions): the Chain screen's live list, for the expiry shown in the Builder's chain.

Other screens hand positions to the Builder: a strategy (**Builder ▸**), an idea or arbitrage from Live Ideas and the Chain, a Covered call month (**▶ Replay in Builder**) or trade, and a portfolio hedge from the Hedge screen.

---

## Trading Ideas · Covered call (Modified covered call)

The Covered call screen (`bt/mcc.js`, `mccpaper.js`, `bt/mcclive.js`, `public/mcc-view.js`, `public/mcclive-view.js`) has four tabs: Strategy & rules, Backtest, Paper trade and Live trade. NIFTYBEES worth one lot (65 × Nifty) plus, on the first trading day of every **monthly** series, held to the monthly expiry: a **call ratio spread** (buy 1 lot CE at ATM + 100, sell 2 lots at ATM + 200) and a **2-3-1 put butterfly** (buy 2 lots PE at ATM − 100, sell 3 at ATM − 300, buy 1 at ATM − 400). NIFTYBEES is modelled at ₹1 per 100 Nifty points (price = Nifty ÷ 100), so 6,500 units move like one lot; the recorded ETF prices are a setting.

- **Adjustments** move only the sold strikes (market up → sold puts back to 300 pts under the new ATM, never above the bought puts; market down → sold calls to 200 pts over it, never under the bought call). When is a setting: a Nifty move of N % from that side's last roll, or the sold leg decayed to N % of its premium; checked at 15:00 (or hourly); none in the last 3 trading days; at most 3 per side a month. Variants: move the whole spread / butterfly, and up-market extras (roll the call ratio up, buy one sold call back, buy a hedge call over the sold strike).
- **Two structures, kept apart everywhere**: the call ratio spread (CE legs) and the put 2-3-1 butterfly (PE legs) have their own P&L (each net of its own costs) in the backtest cards, month and direction tables, study, charts, month details and the paper trade.
- **Strategy & rules** also has *What happens when Nifty moves* (one expiry, Nifty −25 % … +25 %: ▶ Play, ▲ / ▼, slider; bars and payoff for NIFTYBEES, the call ratio, the butterfly, options and total, with a sentence on the zone; source: the example month, your paper month or the last backtest month) and *Month by month* (a model path priced by Black-Scholes with the same rolls, `/api/mcc/model`, or the backtest's real months, played month by month); *When Nifty rises: what you can do* (the up-market variants from the study per up / flat / down month, incl. selling 1 call instead of 2); *Payoff diagram of the month* (editable strikes and premiums per structure, a key-levels table).
- **Month details** (Backtest › Month by month, click a month or *Show every month's details*): every leg the month traded under its structure — held to expiry or closed by a roll, with opened / closed time and price — each structure's result after its costs, the options total, NIFTYBEES held and rebought, the totals, the payoff and the events. *Every adjustment* lists all rolls of the run (click one to open its month). **Clicking a study rule** (either tab) runs that rule's full backtest (`/api/mcc/run`, not saved) and shows it the same way, with *Back to your backtest* and *Use these settings*.
- **Adjustment study** is listed best first (options P&L; the order is the same with NIFTYBEES) with a line naming the best and the steadiest rule; the variants start from the default rules whatever the Backtest settings.
- **Backtest** runs the settings and the same without adjustments, each shown options only, with NIFTYBEES bought once, with NIFTYBEES sold at each expiry and rebought, and against buy and hold (0.5 % slippage, ₹20 an order, taxes by date). **Run adjustment study** runs every rule on the same months (`bt-data/mcc-study.json`; the backtest in `mcc-backtest.json`).
- **Paper trade** follows the same rules on the live chain every 30 s (`bt-data/mcc-paper.json`), opens the next series at 09:30 after each monthly expiry. No orders.

What the history says (Nov 2024 – Sep 2026, 21 series; Dec 2024 and Mar 2025 have no option prices in the cache): options alone +₹1.93 L without adjustments; the sold-strike rolls at 2 % +₹2.11 L (1 % −₹46 K, 1.5 % and 3 % ≈ none); moving the whole spread / butterfly at 1.5 % +₹2.83 L with a deeper worst month; none of the up-market extras made money (the hedge call cut the worst month from −₹61 K to −₹19 K for most of the profit). With NIFTYBEES held: +₹1.20 L vs buy and hold −₹0.91 L.

## Trading Ideas · Strategy lab

Try a new options structure the way the Modified covered call is tested, without writing code (`bt/lab.js`, `public/lab-view.js`). A structure is up to 8 legs, each *buy / sell, CE / PE, points from ATM (Nifty rounded to 50), lots*. History and models only: nothing here trades.

- **Idea: profit from a fall** works out where the Modified covered call loses when Nifty falls (NIFTYBEES falls point for point; the 2-3-1 put butterfly pays at most ~300 points) and three simpler versions, each priced by Black-Scholes at Nifty now (13 % IV, 28 days) from −10 % to +5 %:
  1. **Bear spread combo** (drop NIFTYBEES and flip both sides): buy the ATM put, sell ATM−300; sell the ATM+100 call, buy ATM+300. Defined risk both ways, near zero cost, pays up to ~300 points in a fall. A trade on its own: one lot of it does not hedge one lot of NIFTYBEES in a big fall.
  2. **Put ratio backspread 1×2 instead of the butterfly** (keep NIFTYBEES): sell 1 put at ATM−100, buy 2 at ATM−400. The put bought net gives NIFTYBEES a floor under the bought strike for a small debit.
  3. Either **only in a downtrend** (Nifty under its N-day average at entry).

  It also lists what to check before trusting any of them (Nifty's upward drift, put skew, the small sample, costs).
- **Presets**: bear spread combo, bear put spread, bear call spread, the MCC's put 2-3-1 butterfly alone, put ratio backspread 1×2, and the MCC's options alone without NIFTYBEES (a reference: one call is naked). Any preset can be edited into a custom structure.
- **Build & payoff**: the legs table, Nifty / IV / days / lots, net premium, the most it makes and loses (open-ended where the payoff keeps sloping past the outer strikes), breakevens, the payoff at expiry and today, and a −10 % … +10 % table, optionally with one lot of NIFTYBEES on top.
- **Backtest** (`/api/lab/backtest`, kept in `bt-data/lab-backtest.json`): every monthly series (or every weekly expiry) in the chosen period, entered at 09:30 on its first trading day at the strikes above, held to expiry and settled at intrinsic, or closed at 15:00 at a **target** (% of the most it can make) or **stop** (% of the most it can lose). 0.5 % slippage, ₹20 an order, taxes by date (the MCC's fills and settlement, `bt/mcc.js`). **Filter**: always, only when Nifty is under its N-day average (downtrend) or only over it. Results: total, per series, worst, drawdown, % a year on the most it can lose, by direction of the series (down / flat / up more than 2 %, 1 % for weekly), the running total against one lot of NIFTYBEES and the two together, and every series with its legs, fills and events. Series a filter sits out count as NIFTYBEES alone in the "+ NIFTYBEES" figures.
- **Compare** (`/api/lab/compare`, `bt-data/lab-compare.json`): every preset twice (always in, and only in a downtrend) on the same series and settings, ranked by total, with the best in falling series and the best laid over NIFTYBEES named. Click a row to open it on the Backtest tab.

## Part 3 · Portfolio

## Hedge (protect your portfolio with Nifty options)

The Hedge screen (Portfolio group) starts empty: upload your holdings statement (`.xlsx`) from the screen, or type a portfolio value and Nifty-equivalent exposure straight into the tiles (typed values override the ones from holdings). It works out how much Nifty exposure the portfolio really carries, then searches the live option chains for the cheapest hedge that keeps your loss within a limit you set.

1. **Exposure.** Each holding's beta to the Nifty 50 is measured from 3 years of weekly returns: Upstox prices for stocks and ETFs, AMFI NAVs for mutual funds. By default it uses **downside beta**, i.e. how the holding moved in weeks when Nifty fell. Nifty-equivalent exposure = Σ value × beta. Gold, silver and liquid funds come out near 0, so they need no index hedge. You can edit any beta or untick a holding.
2. **Target.** "Protect against Nifty falling X%, keep my loss within Y% of portfolio", plus:
   - the hedge period
   - whether an upside cap is allowed, and above what level
   - beta type, pricing and the maximum hedge size
3. **Strategies.** For every liquid expiry in the period, each strategy is built from live prices: buy at the ask, sell at the bid, plus about ₹30 of charges per leg. Each is sized to the fewest lots that meet your target, never more than your exposure (rounded up to whole lots). The left column has two views:
   - **Strategies:** a board with one card per strategy, each tuned for its own purpose and marked *meets your target*, *best it can do*, *crash cover* or *caps upside*:

     | | Strategy | What it does |
     | --- | --- | --- |
     | A | Protective put | Buy puts: full protection below the strike, upside fully open |
     | B | Put spread | Buy a put, sell a lower put: cheaper, protection stops at the lower strike |
     | C | Put spread + tail put | A spread for the likely fall, plus a far put so a crash below the spread is covered (removes at least 70% of a −25% loss) |
     | D | Partial collar | Puts on all lots, calls sold on half: cheaper, and keeps half the upside above the call |
     | E | Seagull | A put spread paid for by selling far calls; gains stop above the call |
     | F | Collar | Puts plus calls sold on all lots; gains stop above the call |
     | G | Tail hedge | Cheap far-OTM puts on the full exposure, judged on how much of a −25% loss they remove |
     | H | Your structure | Press **Customise** on any hedge to edit its legs (buy/sell, CE/PE, strike, lots, expiry). It is priced live and judged the same way, and warns if you sell more puts than you buy or sell calls |

     Strategies that sell calls (D, E, F) appear only for comparison until you allow an upside cap.
   - **Cheapest overall:** every structure that meets the target, ranked by **cost per year** so short and long expiries compare fairly.
4. **Results:** **Builder ▸** opens the selected hedge in the Strategy Builder as a paper position on the live chain of its expiry (payoff on any date, Greeks). Below it: the selected hedge's exact legs (strike, quantity, price, bid/ask, OI), a payoff chart against no hedge, a scenario table from −30% to +20%, and a comparison table of all strategies (cost per year, loss at your fall and at −25%, upside kept, where gains stop). Everything updates as you change an input, and prices refresh every minute.

Limits: payoffs are at the option's expiry, beta is a historical estimate, and non-index holdings won't track Nifty exactly. Sold calls need margin and cap gains above their strike. It's a calculator, not advice.

### Backtest (second tab inside Hedge)

Replays hedges over past Nifty moves and compares how each one did. Daily Nifty 50 and India VIX closes since 2008 are downloaded from Upstox once and kept in `hedge-cache/history.json`; after that only new days are fetched. These hedges run for months and the test goes back to 2008, far beyond the ~2 years of real option prices Upstox keeps (those drive the Builder's historical replay), so every leg is priced with **Black-Scholes**. The volatility is that day's India VIX (or realised or fixed volatility, if you pick one), plus put/call skew and an optional term-structure adjustment. You pay half the bid/ask spread when you buy and when you sell, plus charges per leg.

- **Strategies to test:** templates A–G (built from the strike settings), your own **custom legs** (strike % from spot, size % of exposure, or *Copy selected hedge* from the Planner), and every hedge currently on the Planner (A–G, H and saved S1…, converted to strikes as % of today's spot with the same expiry length).
- **Settings:**
  - Period, starting value, beta, hedge size, lot size, whole lots.
  - Expiry length, roll early with N days left, take profit when Nifty falls X% or the hedge is worth N× its cost, and only buy when IV ≤ X%.
  - Strikes (put, spread width, tail put, sold call, strike step).
  - Pricing model (volatility source, multiplier, skew, term structure, bid/ask, charges, risk-free rate, dividend yield).
- **Results:**
  - Portfolio value, drawdown and "vs no hedge" curves.
  - A sortable table: final value, return/yr, max drawdown and how much it improved, volatility, Sharpe, Sortino, Calmar, worst month/3M/year, options P&L, premium paid, cost/yr, trades, % that paid off, best and worst trade.
  - The biggest Nifty falls in the period.
  - **Returns by period**, switchable between **Yearly** and **Monthly**. Rows are the periods (newest first; the monthly view puts each year's total above its months). Columns are Nifty, No hedge and every strategy, and periods that beat no hedge are in bold. The footer shows the average, best and worst period, the share of periods that were up, and how often each strategy beat no hedge.
  - A full trade log for the selected strategy.

The model assumes holdings move beta × Nifty, premiums come out of cash with no interest, and no margin is needed for sold legs. Use it to compare strategies, not to predict exact rupees.

This is a different test from the Covered call and Strategy lab backtests: those replay real 1-minute option prices of the last two years; this one prices months-long hedges with a model over 17 years, so it covers 2008 and 2020.

---

## Reference

## Error log

Server errors (Upstox failures, crashes, file-writing problems) and errors from the browser page are appended to `logs/errors.log`, one line each with IST time. Repeats of the same error are written at most once a minute. If the page says the server is running older code, restart it with Ctrl+C and then `npm start`.

## Checks and CI pipelines

| Command | What it does |
| --- | --- |
| `npm run lint` | ESLint: undefined names, unused code, unreachable branches (`eslint.config.js`) |
| `npm run format` | Prettier rewrites the JavaScript in the project's layout (`.prettierrc.json`; `.prettierignore` lists what it leaves alone). `npm run format:check` only reports the files that differ |
| `npm test` | Unit tests (`test/`) |
| `npm run test:ci` | The unit tests with coverage; writes `reports/junit.xml` and `reports/coverage.lcov` |
| `npm run test:e2e` | End-to-end tests (`e2e/`): starts the app in demo mode on port 3210 and drives it in a browser with Playwright |
| `npm run check` | Lint, format check and unit tests in one go, before a commit |

The end-to-end tests need a browser. `npx playwright install chromium` downloads Playwright's own once; or set the environment variable `PW_CHANNEL` to `chrome` or `msedge` to use the one already installed. They only look and navigate: they never run a backtest or a download, and the demo server's recordings go to a temp folder. `E2E_PORT` changes the port.

The same checks run in **GitHub Actions** (`.github/workflows/ci.yml`) and in **Azure Pipelines** (`azure-pipelines.yml`) on every push to `main`, on every pull request and once a week. Both call the npm scripts above, so a check is changed in one place.

| Job | Runs |
| --- | --- |
| Lint and format | ESLint and the Prettier check |
| Unit tests | Linux on Node 22 and 24, Windows on Node 22. Test results and coverage are published; coverage is reported, not enforced |
| End-to-end tests | Playwright on Chromium against the demo server; the HTML report is kept with the run |
| Security checks | `npm audit` (high and critical advisories in the packages the app runs on), `npm audit signatures`, and gitleaks over the whole git history (`ci/gitleaks.sh`) |

- **GitHub:** the workflow runs once the file is pushed; nothing to configure. To stop a pull request with a failed run from being merged, require the **CI passed** check in the branch protection rule for `main`.
- **Azure DevOps:** Pipelines → New pipeline → pick where the code is (GitHub or Azure Repos) → *Existing Azure Pipelines YAML file* → `/azure-pipelines.yml`. It uses Microsoft-hosted agents (a new organisation has to enable the free tier of parallel jobs first); for your own agent, change `pool` in the file. With the code in Azure Repos, pull requests are checked by adding the pipeline as a *Build validation* policy on `main`.
- A secret reported by gitleaks that is not one: add the fingerprint printed with the finding to a `.gitleaksignore` file.

## Files

| Path | What |
| --- | --- |
| `server.js` | HTTP server, Upstox login, live chain, the contract list and REST chains everything else prices from |
| `lib/upstox.js` | The one Upstox REST client and rate limiter (live calls and historical downloads share the limits); option-chain parser |
| `lib/ticks.js`, `lib/optcandles.js` | Today's trades of the streamed instruments, in memory (the chart's Tick view); candles with volume of one option or future contract (the chart's option and Nifty Fut views) |
| `lib/pricing.js` | Normal CDF, Black-Scholes-Merton, Black-76: used by the server and, as `/lib/pricing.js`, by the page |
| `lib/costs.js` | Brokerage and taxes on option trades by date: used by the server (Pulse paper trades, Covered call) and, as `/lib/costs.js`, by the page |
| `lib/time.js`, `lib/env.js` | IST dates and market hours; `.env` loader |
| `feed.js`, `tape.js` | Tick feed (WebSocket); the all-day market tape |
| `lib/kite.js` | Zerodha Kite API: login, instruments, quotes, historical candles, orders, margins, the binary tick feed |
| `lib/kitedata.js` | Kite as the live data source: Upstox-shaped contracts and chains (IV and greeks worked out), the tick feed, candles |
| `kitebasket.js`, `public/kite-order.js`, `public/kite-login.js` | Orders to Kite (the basket and its rules); the shared Trade on Kite dialog; the Kite login and the Live data switch |
| `signals.js`, `sigstats.js` | Spike signals and recordings; their track record |
| `flow.js` | The live order-flow read of the last minute (an input of the Market Pulse) and its predictions |
| `pulse.js`, `pulse-signals.js`, `pulse-backtest.js`, `study.js` | Market Pulse and its trade idea; the idea's paper trades; their replay over recorded days (a command); the indicator scorecard (a command) |
| `orderflow.js` | Order flow of the options as minute rows (today live, earlier days from the tape) and the read shown under the chart |
| `hedge/` | Portfolio hedge: holdings (`holdings.js`, `xlsx.js`), betas, planner (`engine.js`), daily history and backtest |
| `bt/data.js` | Historical data download, disk + memory cache |
| `bt/sync.js` | What the cache lacks for a selection of expiries, the download job, the automatic update |
| `bt/strategy.js` | A strategy's definition: defaults and the whole-strategy stop |
| `bt/library.js` | Ready-made strategies |
| `bt/index.js` | Strategies API: saved / edited strategies, live deploy, levels, Nifty candles, Builder replay data and saved trades, the data cache |
| `bt/levels.js` | Major / minor support and resistance, and the levels projected past the last swing level |
| `bt/anomalies.js` | The scanners (no-arbitrage bounds and fair value), their quality gates and rejected signals, trading-time IV, suggested trades |
| `bt/histchain.js` | Rebuilds a past chain from cached candles (the scanner's realised volatility) |
| `bt/conditions.js` | Signal entry conditions (anomaly, S/R, move, range) |
| `bt/mcc.js`, `mccpaper.js`, `bt/mcclive.js`, `public/mcc-view.js`, `public/mcclive-view.js` | Trading Ideas › Covered call (Modified covered call): the rules, backtest and adjustment study; the live paper trade; the live trade; the screen |
| `bt/lab.js`, `public/lab-view.js` | Trading Ideas › Strategy lab: structures as legs from ATM, their backtest and the preset comparison; the screen |
| `anomaly-live.js` | Background anomaly scanner (Deploy live's signal conditions), its daily log |
| `public/app.js` | The page: screens and groups, option chain, signals pane, volume surge, support / resistance |
| `public/chain-chart.js` | Nifty candle chart (Chain, Live Ideas, Builder, and its own window `chart.html`) |
| `public/hedge-view.js`, `hedge-backtest.js` | The Hedge screen: planner and backtest |
| `public/ideas-view.js`, `arb.js` | Live Ideas; the vertical-spread arbitrage list (Chain, Builder, Live Ideas) |
| `public/sb-view.js`, `public/sb-adjust.js` | Strategy Builder; structure names (iron condor, bull put spread, …) |
| `public/bt-common.js`, `lib-view.js`, `data-view.js`, `payoff.js` | Shared helpers and charts; the Strategies and Data screens; payoff charts |
| `public/styles.css`, `live.css`, `hedge.css`, `bt.css`, `ideas.css`, `cc.css`, `lab.css`, `themes.css` | Styles: base and chain, live pieces, hedge, strategy screens (and shared components), Live Ideas, Covered call, Strategy lab, colour themes |
| `test/` | Unit tests (`npm test`) |
| `e2e/`, `playwright.config.js` | End-to-end tests of the page in demo mode (`npm run test:e2e`) |
| `.github/workflows/ci.yml`, `azure-pipelines.yml`, `ci/` | The CI pipelines for GitHub Actions and Azure Pipelines, and the scripts they share |
| `eslint.config.js`, `.prettierrc.json`, `.prettierignore`, `.gitattributes` | Lint rules, code layout, and LF line endings on every platform |

Recordings go to `events/` (`events-demo/` in demo mode), downloaded history to `bt-cache/`, saved strategies, results and trades to `bt-data/`, hedge betas, history and saved structures to `hedge-cache/`, replays to `replays/`.

This is an analysis tool, not investment advice. Backtests and replays use historical 1-minute candles and modelled costs, so real fills, margins and liquidity will differ.
