# Nifty Options Lab — live chain and analysis, strategy backtester, portfolio hedge (Upstox)

A local web app for Nifty options on the Upstox API. Its screens are grouped in the top bar:

- **Live:** the option chain with a Nifty chart and support / resistance, volume-surge and price signals with their track record, volume-flow predictions, a plain-language market pulse and the order book. Everything is recorded, so a day can be replayed and the signals tested on it.
- **Strategies:** an arbitrage scanner, ready-made and your own strategies backtested on real 1-minute historical option prices, side-by-side comparison, live deployment, and a Builder to trade a position by hand on a historical replay or the live chain.
- **Portfolio:** hedge your holdings with Nifty options — the cheapest hedge for a loss limit you set, and a backtest of hedges back to 2008.
- **Data:** what history Upstox provides and what is cached.

You need Node.js 22 or newer. Run `npm install` once (installs `protobufjs` for the tick feed, `chart.js` and `lightweight-charts` for the charts, served locally, and `@anthropic-ai/sdk` for the Builder's online research).

## Setup

1. Create an app at <https://account.upstox.com/developer/apps> and set its Redirect URL to `http://localhost:3000/callback`.
2. Copy `.env.example` to `.env` and fill in `UPSTOX_API_KEY` and `UPSTOX_API_SECRET`, or paste a token into `UPSTOX_ACCESS_TOKEN`.
3. Set `AUTH_USERNAME` and `AUTH_PASSWORD` in `.env` to require a sign-in. The page then shows a login screen first, every `/api/*` route answers 401 without a session, and a **Sign out** button appears in the top bar. Scripts can send an HTTP Basic header (`curl -u user:pass ...`). With either value empty, sign-in is off and the server prints a warning. The sign-in lasts `AUTH_SESSION_HOURS` (default 12) and ends when the server restarts.
4. Run `npm start` and open <http://localhost:3000>.
5. Click **Login with Upstox** if asked. The token is saved to `.token.json` until it expires (about 3:30 AM IST the next day).

`npm run demo` shows the live screens with synthetic data. Backtesting and the Hedge screen need real Upstox data. `npm test` runs the tests.

To run it on Azure App Service (Node 22 LTS, Linux), see [docs/azure-deployment.md](docs/azure-deployment.md): the settings, the code changes still needed, and the VS Code steps.

## Screens

Pick a group in the top bar; its screens are in the row below. A group reopens on the screen you last used in it.

| Group | Screen | What it's for |
| --- | --- | --- |
| **Live** | **Chain** | Option chain; beside it the Nifty chart with support / resistance or the signals; under it spread arbitrage or the volume surge |
| | **Surge** | Five charts of the volume added per strike |
| | **Flow** | Volume-flow predictions, live and replayed from a recorded day |
| | **Pulse** | What the market is doing, in plain language |
| | **Book** | Order book: bid / ask queues and how Nifty reacted |
| | **Signal test** | Test the signals on recorded days: hit rate per kind of signal |
| | **Feeds** | Upstox vs Zerodha Kite ticks on the same options: where the prices differ, for how long, which feed moved first |
| **Strategies** | **Arbitrage** | Pricing bounds broken at the bid / ask and fair-value deviations: live scanner with rejected signals and data health, history scans on candles and on recorded quotes |
| | **Strategies** | Ready-made and saved strategies as cards (**+ New strategy**, edit / reset built-ins); **Deploy live** on an upcoming expiry |
| | **Backtest** | Build or load a strategy, run it over a period, study the results |
| | **Bi-weekly** | The bi-weekly hedge, its reverse and the two combined: every variation backtested over the whole history |
| | **Compare** | Backtest many strategies on the same days and rank them |
| | **Builder** | Manual / strategy trading on a historical replay or live (paper), payoff, P&L, adjustment suggestions |
| | **Trades** | Trades saved from the Builder; load one back |
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
- **Right half of the screen** shows one of two panes, picked with the switch above it: **Chart & levels** (below) or **Signals** (see *Signals*). New signals that arrive while the chart is showing are counted on the Signals button; the count turns red and blinks for a high-probability one.
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

A level below spot is support, above is resistance. Levels for a day use only earlier sessions, so backtests have no look-ahead. They are used on the Chain screen and its chart, on Market Pulse, in strategy conditions/strikes/stops, in Deploy live, and in the Builder's suggestions.

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

## Volume surge and Surge charts

The **Volume surge** pane under the option chain is a column chart with call volume added growing up and put volume added growing down for each strike. The top 3 strikes on each side are numbered, and are listed on the left with their price change. Hover over a column to see exact values. The Calls Δ vs Puts Δ bar shows which side is more active. Each strike also shows its volume growth as a % of its volume at the start of the window ("new" means it had no volume before). Use **Bars: Qty / %** to size and rank by quantity or by %, and **Highlight ≥ 5 / 10 / 25 / 50%** to outline every strike that grew by at least that much. The window (1, 3, 5 or 15 minutes) is the one picked in the chain header.

The **Strikes: Fit screen** option shows as many strikes around ATM as fit, so the chain and the pane under it are visible without scrolling.

### Surge screen

Five views of the same volume surge, all live:

1. **Calls vs puts by strike** shows CE volume added above zero and PE below, so you can see where new volume is going.
2. **Where and when** is a heatmap of strike × time (the last 15 minutes in 30 s, 1 m or 2 m buckets). Brighter cells mean more volume. It can show CE+PE, CE only or PE only.
3. **Volume added over time** shows total CE vs PE volume per time bucket, so you can see which side is speeding up.
4. **Volume vs price move** is a bubble chart with one bubble per strike and side: height = premium change %, size = volume added. Big bubbles above zero suggest buying pushing premiums up; big bubbles below zero suggest heavy volume while premiums fall (likely writing).
5. **Volume growth % by strike** is a dot plot of each strike's growth relative to its own volume, with the highlight threshold as a dashed line.

The window, time bucket and strike range are set in the bar at the top of the screen.

## Signal test (backtesting the signals)

The **Signal test** screen runs recorded days through the signal logic as it is now, so you can check a change against the data already collected. It only reads the recorded files, so it also works outside market hours and before logging in.

- **Days:** pick *All recorded days* or a single day, then **Run backtest** (changing the day runs it straight away).
- **Thresholds:** the inputs in the bar start at the live values from `.env` and apply to the backtest only (spike ratio and minimum quantity, premium %, Nifty points in 20 s and 1 min, cooldown).
- **Tiles:** days tested with their tape hours, signals raised by the current logic next to the number recorded live, the kinds that clear the high-probability bar, and the "any moment" rates for those days.
- **Hit rate by kind of signal:** one row per kind with the direction Nifty then took, the hit rate (same outcome rule as the track record above), cases, how many went against, the "any moment" rate, what the signals **recorded live** on those days scored, and on how many of the days it beat that day's "any moment" rate. ★ marks kinds that clear the high-probability bar. Click a row to list only that kind and see its day-by-day split.
- **Signals:** every signal the replay raised, newest first, with what Nifty did next (rose 10 first, fell 10 first, neither).

The backtest runs `signal-backtest.js` as a separate process, so live data keeps flowing and edits to `signals.js` are picked up without restarting the server. It only covers market hours that have a tape. The tape has one snapshot per second while live checks run every 0.5 s, so a replay of unchanged logic comes out close to the live record but not identical.

From the command line:

```
node signal-backtest.js                                   # every recorded day
node signal-backtest.js 2026-10-08                        # one day (several dates can be given)
node signal-backtest.js --spikeRatio 4 --priceSpikePct 8  # what-if thresholds
```

Volume signals start after 5 minutes of history. All thresholds can be changed in `.env` (see `.env.example`). Demo mode writes to `events-demo/` instead.

## Volume Flow (Flow screen)

This screen tests one idea: when bullish option flow dominates the last minute, Nifty tends to go up, and when bearish flow dominates, it tends to go down.

What counts as "bullish flow" is set by `FLOW_MODE`:

| Mode | Bullish flow | Bearish flow |
| --- | --- | --- |
| `aggressor` (default) | calls **bought** + puts **sold** | puts bought + calls sold |
| `premium` | call volume while the call premium rose + put volume while the put premium fell | the reverse |
| `volume` (the original rule) | all call volume | all put volume |

Aggressor mode classifies each trade from the tick feed by the live bid/ask: a trade at the ask is a buy and at the bid a sell, falling back to the price direction in between. It needs the WebSocket feed, so when the server is polling, or when replaying older tapes that have no bid/ask data, it falls back to `premium`. Each prediction records which mode it actually used.

Why not raw volume: heavy put volume can be put *buying* (bearish) or put *writing* (bullish), and puts usually trade more than calls anyway. On 1 Oct 2026, CE averaged only 43% of volume, so the raw rule fired DOWN almost every time and was no better than a coin flip.

- **Live flow:** CE vs PE volume added in the last minute, summed across the strikes within ±10 of ATM (nearest expiry). It also shows which side is leading and since when.
- **Prediction:** made when one side has ≥ 60% of the flow for 10 seconds in a row, with at least 50,000 traded. There is only one prediction per flow episode: the same direction can't fire again until the flow has flipped to the other side, and never within the 3-minute scoring window of its last prediction.
- **Outcome:** it is a **HIT** if Nifty moves 8 points the predicted way before moving 8 points against, a **MISS** if the reverse happens, and **FLAT** if neither happens within 3 minutes. The screen also records:
  - when the flow started building (when that side took the lead)
  - when the market first reacted (the first move of 3 points or more either way)
  - the best and worst move within 3 minutes
  - Nifty 1 minute and 3 minutes later
  - the ATM CE and PE premium before and after
- **Stats:** today's hit rate overall and separately for UP and DOWN calls, the average time until the market first reacted, the average time to a HIT, and the average best and worst moves.
- Everything is saved to `events/<date>/predictions.csv` (and `.jsonl`). Predictions still being tracked when the server stops are saved as INTERRUPTED.

All thresholds are in `.env` (see `.env.example`). Treat this as a measurement tool: the hit rate over several days tells you whether the idea holds.

## Market Pulse (Pulse screen)

A live, plain-language read of what the market is doing, recomputed every 5 seconds from the tick data for the nearest expiry. A one-line version sits at the top of the Signals pane; click it to open the screen.

- **Headline and bias:** the trend (sideways, rising or falling, strong rise or fall) plus whether it is accelerating, pausing or reversing. It also says whether three independent reads agree: the trend, what option writers and buyers are doing, and order flow.
- **Tiles:** Nifty change over 5, 15, 30 and 60 minutes; the typical 1-minute move now vs before (volatility); the ATM straddle and its 30-minute change; ATM IV; and the order-flow split.
- **What's happening:** a few sentences covering trend, volatility, the main OI activity, fresh writing levels, the largest OI, PCR, straddle/IV and recent signals.
- **Option writers & buyers:** for each strike within ATM ±5 over the last 15 minutes, OI change plus premium change classify the activity as long build-up (buying), short build-up (writing), short covering or long unwinding, for calls and puts.
- **Key levels:** the nearest major and minor resistance and support (the same levels as on the Chain screen, see *Support and resistance*), then fresh call writing above and put writing below, the largest call and put OI, and the most OI added today. The Nifty chart underneath is the Chain screen's chart (it opens on 1-minute candles and keeps its own settings).

It keeps about 100 minutes of context and refills it from today's tape after a restart. A summary is logged every minute to `events/<date>/pulse.jsonl`. It describes what the data shows and is not a trading recommendation.

## Order Book (Book screen)

This screen shows what is waiting in the order book and how the market is reacting, for strikes within ATM ±10 of the nearest expiry. It needs the tick feed. The full day's history is kept and refilled from the tape after a restart.

- **Tiles:**
  - book pressure: the bullish share of waiting quantity, i.e. calls waiting to be bought + puts waiting to be sold, for ATM ±5
  - pressure compared with its 30-minute average, and its change over 5 and 15 minutes
  - ATM call and put spreads
  - the buyer vs seller split of trades in the last minute
  - today's "reaction" rate: how often Nifty moved the way the book leaned
- **1 · Who is waiting, by strike:** the % of each strike's queue on the buy side, for calls and puts (50% = balanced).
- **2 · Queue size by strike:** quantity waiting to buy (up) vs to sell (down), for CE or PE. Hover for the best bid and ask with their quantities.
- **3 · Book pressure vs Nifty:** Nifty on top, and below it book pressure with its 30-minute average, so you can see whether shifts in the book came before moves.
- **4 · Buy share of the queue over time:** a strike × minute heatmap for the last 60 minutes. Green = buy-heavy, red = sell-heavy, grey = balanced.
- **5 · Who actually traded:** per minute, trades by buyers vs sellers. Up = calls bought + puts sold; down = puts bought + calls sold.
- **6 · How Nifty reacted:** each minute plotted as the book's lean (vs its 30-minute average) against Nifty's move over the next 5 minutes, with the correlation. Green = Nifty moved the way the book leaned, red = it didn't.

Option queues are normally lopsided (puts usually have far more resting buy orders), and orders can be cancelled before they trade. That's why the charts compare the book with its own recent average. Use chart 6 and `study.js` to judge whether the book leads the market on your data.

## Upstox vs Zerodha Kite (Feeds screen)

The Feeds screen streams the same Nifty options from Upstox and from Zerodha Kite and times every tick as it arrives. By default it watches ATM ±5, calls and puts, of the nearest expiry, plus the Nifty index; you can add strikes, pick another expiry, and also compare bid and ask. When the two feeds show different prices, a **difference** opens; it closes when they agree again. Each one records:

- when it started and ended (IST, to the millisecond) and how long it lasted
- the prices of both feeds when it started, the largest gap while they were apart, and the price they agreed on
- which feed **changed first**, and how it ended: the other feed **followed** (with its lag, measured from when the first feed showed that price), the first feed **went back** (the other never showed that price), **both moved** and met elsewhere, or **cut short** (a feed dropped)

The screen shows both feeds' prices live, with the rows that are apart right now highlighted. It also shows which feed is faster overall (lag histogram, median and 90th percentile, per instrument) and the day's differences, filtered by duration, gap, field, instrument and feed. Comparison runs during market hours whether or not the page is open. Every difference is appended to `events/<date>/feedcmp.jsonl`, and earlier days can be picked on the screen.

**Paper trades on big gaps.** When the two feeds' LTPs for an option are at least ₹5 apart (adjustable), a paper trade opens in the direction of the feed that moved first: BUY when it shows the higher price, SELL when it shows the lower one. The trade closes at +₹3 per unit, at an optional stop, after a maximum hold time (5 minutes by default) or at 15:25. With **Exit when feeds match** ticked, the +₹ profit target is replaced by the moment Upstox and Kite show the same LTP again (the gap has closed, whatever the profit then is); the stop, max hold and 15:25 still apply. The **At convergence** column shows, for every trade whether or not that exit is on, the profit after charges had it been closed the first time the feeds matched again, and how long that took. Fills use the live quote (ask to buy, bid to sell) of the feed that moved first, and later the quote that arrived most recently. An order fills at the exchange's price, not at the old price a slow or frozen feed still shows, so the P&L "if filled at the stale price" is listed separately as what the gap seems to offer but can't be had. Each trade shows charges, its best and worst points, and its P&L 30 s, 1 min, 5 min and 15 min after entry, so you can see what happened later. Trades are saved to `events/<date>/feedpaper.jsonl`. A trade still open when the server restarts can't be followed and is shown as lost.

**Only in a volume surge (optional gate).** Every paper trade is tagged with the volume breadth when it opened: the share of strikes near ATM trading at 2× their normal volume or more, the same figure as the Broad Volume Surge meter on the Signals pane (`surge` in `feedpaper.jsonl`, the Surge column of the table). A small table under the tiles splits the day's trades into those opened in a volume surge (breadth at or above the level, 60% by default), those opened in calmer volume, and older ones with no tag, each with its win rate, average P&L per unit and net. Tick **Only in a volume surge ≥ _n_ %** to make it a gate: no trade opens (paper or live) while the breadth is below the level or not yet known. It is off by default, so the split builds up over normal days first. On the one day it was checked (2026-10-14), trades opened in a broad surge did better after charges than the rest, but that rested on a handful of episodes: judge it on several recorded days before relying on it.

**Live orders on Kite (real money).** The **LIVE** switch in the same section makes every paper trade that opens also send a real MARKET order to Kite: 1 lot by default, MIS, the same side as the paper trade. When the paper trade closes (target, stop or max hold, as set above), the opposite MARKET order closes the position, and any live position still open at 15:15 is closed then. The trades table shows each real order and its P&L from the actual fills after charges, a tile totals it, and your Kite Nifty positions are listed under the switch. Under the switch, **Kite funds** shows what Kite says is available to trade (refreshed every 30 s, or with ↻), and how many lots of the ATM call and put that buys at the current ask. With **Size by budget** on, each live entry is sized automatically: the funds are read again just before the order, and the lots are as many as *use %* of them pays for (default 90%), at most *max lots* (default 10). A buy is costed at the premium; a sell uses the margin Kite's calculator asks for one lot. If that comes to less than one lot, the trade is skipped with the reason shown. Test buys stay at 1 lot. With **Kite trades only** (on by default), only trades where Kite moved first, entered at Kite's own quote, are sent; the others are listed as skipped. The **Show** filter splits the paper trades and their tiles into Kite trades and Upstox trades the same way. Limits: entries only from 09:15 to 15:10, at most *Max entries / day* (default 10) and *Max open* (default 1). Exits are always sent. **Square off all** closes every live position opened from the screen, and each open position also has its own **Close** button. You can also close a position in Kite itself. The app reads Kite's positions every 5 seconds while it holds any, and again just before every exit. Whatever Kite no longer holds is marked "closed in Kite", priced from the closing order in Kite's order book, and no exit order is sent for it, so the app can't open a reverse position. Open positions show their P&L at the current Kite bid (long) or ask (short), updating live, and the "Live on Kite" tile adds it to the closed P&L. **Test order** buys 1 lot of the ATM call or put (picked beside it) at MARKET, whether or not LIVE is on. It's a real position, listed under the switch and closed by **Square off all** or at 15:15. **Check only** instead sends a 1-lot LIMIT BUY at ₹0.05 of the ATM call, which can't fill and is cancelled at once if Kite accepts it. The switch is off after every server restart and whenever the Kite login changes, and turning it on asks for confirmation. Live orders need a Kite Connect login (set `KITE_ORDERS_ENCTOKEN=1` to allow the web-session login). Only `lib/kite.js` sends orders and only `feedlive.js` uses it, which `test/no-orders.test.js` checks; Upstox stays read-only.

Logging in to Kite (the session lasts until about 6 AM IST the next day and is saved in `.kite-token.json`):

- **Kite Connect** (the official API; streaming needs the data add-on): put `KITE_API_KEY` and `KITE_API_SECRET` in `.env` and set the app's Redirect URL to `http://localhost:3000/kite/callback`. Then use **Login with Kite**. If you are already logged in to Kite in the browser, Kite usually sends you straight back. Tick **Auto-login** to do this by itself whenever the screen opens without a Kite login. `KITE_ACCESS_TOKEN` in `.env`, or **Use a token…**, takes an access token directly.
- **Kite web session (enctoken)**, which is unofficial and undocumented, so Zerodha can change or block it: drag **Send Kite login here** to the bookmarks bar, then click it on kite.zerodha.com while logged in. It hands your web session to this app, which checks it with Kite before keeping it. You can also paste the enctoken and user ID under **Use a token…**, or set `KITE_ENCTOKEN` and `KITE_USER_ID` in `.env`.

## Colours

Calls (CE) are **green** and puts (PE) are **red** on every screen (chain, signals, order flow, order book, charts). Support / resistance levels keep their own colours: **S** green, **R** red. Up / down moves are green / red as before.

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

## What is saved, and replaying a day

Everything for a day is in `events/<date>/`:

| File | Contents |
| --- | --- |
| `tape-HHMMSS.jsonl.gz` | **The market tape**: one compressed line per second for the nearest expiry, holding Nifty spot plus, for CE and PE at ATM ±15 strikes, LTP, volume and OI. With the tick feed it also holds buyer- and seller-initiated volume, best bid and ask with the quantity at each, and the total buy and sell queue. Each server start begins a new part. About 15 MB per trading day. Everything below can be recomputed from it. |
| `pulse.jsonl` | Market Pulse summary once a minute (headline, bias, trend, OI activity totals, levels, straddle, IV, flow) |
| `predictions.csv` / `.jsonl` | Each Volume Flow prediction with its outcome (written when it finishes) |
| `events.csv` / `.jsonl` | Each spike signal with the before/after summary |
| `HHMMSS_<type>.csv` | Snapshots around each spike, for ATM ±10 (also covered by the tape) |

The live CE/PE flow curve isn't saved separately, because a replay rebuilds it exactly from the tape.

**Replay on screen:** on the Flow screen, pick a day in **Day**. The screen re-runs that day's tape through the same prediction logic and shows the predictions, stats and chart, next to what the live run recorded. Change the settings (share %, hold seconds, minimum volume, HIT/MISS points, horizon) and press **Replay** to see how other values would have done. Choose **Live (today)** to go back.

**Replay from the command line:**

```
node replay.js 2026-10-01                                  # with the settings in .env
node replay.js 2026-10-01 --imbalance 0.3 --holdSec 20     # what-if settings (imbalance 0.3 = 65% share)
node replay.js 2026-10-01 --mode volume                    # compare against another mode
node replay.js 2026-10-01 --sweep                          # compare modes × share % × hold time
```

Each run writes `replays/<date>_<settings>.csv` in the same format as `predictions.csv`.

## Where the live data comes from

- **Tick feed (WebSocket):** Nifty, the near-month Nifty future and 15 strikes either side of ATM (calls and puts) stream live from Upstox's Market Data Feed V3, plus any option the chart is showing. Ticks are folded into a snapshot every 500 ms, and the page refreshes every 400 ms. Subscriptions follow ATM as it moves.
- **REST option chain:** gives the full strike list, previous OI and the strikes outside the streamed range. It refreshes every 15 s while the feed is live, or every `POLL_MS` (1.5 s) if the feed is down. If the feed drops, the app falls back to polling and reconnects on its own.

The status at the top right says which one is in use. Set `FEED_STRIKES` in `.env` to stream more or fewer strikes.

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

## Building a strategy

Strategies are defined *relative to the market*, so one definition works on every past expiry and every future one.

**Type**
- **Intraday:** entry and exit times on the same day. Pick weekdays and **days to expiry** (0 = expiry day), e.g. "only Monday and Tuesday" or "only expiry day".
- **Positional (multi-day):** enter N trading days before the weekly or monthly expiry, exit M days before (0 = expiry day). Positions are held overnight. One trade per expiry; with a large N it spans multiple weeks.

**Each leg** (up to 12)
- **Basics:** Buy/Sell, CE/PE, lots, and expiry (this week, next week, this month, next month). Calendars and diagonals mix expiries.
- **Strike selection:**

  | Rule | Picks the strike… |
  | --- | --- |
  | ATM ± strikes | N strikes from ATM: OTM *n* (or ITM *n*) |
  | Premium | closest to ₹X, the cheapest at or above ₹X, or the dearest at or below ₹X |
  | Delta | closest to the given delta, from implied volatility at entry |
  | % / points from spot | at that distance from spot |
  | Straddle width | at ATM ± (ATM straddle price × multiplier) |

- **Target:** % of premium, ₹ points, or a Nifty move (% or points) in favour of the leg. Legs have no stop-loss of their own: the stop is on the whole strategy (below).
- **Re-entry** after a target, up to N times:
  - immediately at the same strike,
  - when the price returns to the original entry,
  - immediately at a freshly selected strike.

**Whole position**
- **Exits:** overall ₹ stop-loss and target.
- **Lock and trail:** "when MTM reaches ₹A, lock ₹B, then raise the lock ₹D for every ₹C more".
- **Stop-loss is judged on the whole strategy's loss, never a single leg** (Backtest, Compare and Bi-weekly screens): in ₹, % of capital or % of the entry premium. A strategy saved earlier with a leg stop in % of its premium gets a stop on the whole position at that % of the entry premium (the smallest if legs differed); leg stops on points, a Nifty move or S/R, their trailing and re-entry after a stop are dropped.

**Adjustment on market move** (one rule per strategy, `strategy.adjust`)
- **When:** Nifty moves X points or % from the entry (then from the last adjustment); Nifty comes within X points or % of a short strike (0 = touches it); or a short leg's premium reaches k × its entry price.
- **Then:** *roll the tested side out* (the side Nifty moved towards: its shorts and their wings get the strikes their own rules pick now, e.g. back to 0.2 delta), *roll the untested side in* (sold again closer for more credit), or *re-centre every leg*.
- At most N adjustments a trade, none in the last 30 minutes before the exit. Decided on a candle close, made at the next minute's open, in the same expiry; a wing set "from another leg" follows its short. A leg whose strike would not change is left alone, and if any new leg has no price the whole adjustment is skipped (a short never loses its wing). It is not a stop: it changes strikes, while the stop-loss still judges the whole strategy.
- What held up over Oct 2024 – Oct 2026 (0.5 % slippage, ₹5 L): on a weekly iron condor (0.2-delta shorts, wings 300 points out) rolling the tested side out when a short doubles (*Weekly Iron Condor (0.2 delta), tested side rolled* in the library) made more in both years and cut the drawdown from −₹1.15 L to −₹50K; it was profitable with every short delta (0.15–0.25) and wing (200–500 points) tried, but best at exactly 2× and only when entered 4 trading days before expiry. Re-centring a weekly strangle when Nifty came within 100 points of a short strike also halved its drawdown. Strong trends still lose. No rule helped the intraday straddles, and none beat the bi-weekly hedge's own week-1 exit.

**Filter:** India VIX range at entry.

**Entry trigger.** *At the entry time* (classic), or *On a signal*: from the entry time until a "watch until" time, the strategy enters at the next minute's open once **all** of its conditions hold, up to N trades a day (after an intraday trade closes it keeps watching). Conditions:

| Condition | Holds when |
| --- | --- |
| Anomaly | an anomaly type fires (its thresholds, optional CE/PE side and direction) |
| Near S/R | Nifty is within X points of a support / resistance level (major, minor or any) |
| S/R break | Nifty closes through a level this minute (above resistance / below support) by X points |
| Nifty move | Nifty is up / down / either way at least (or at most) X points or % from the open or previous close |
| Day range | high − low since the open is at least / at most X points |

**Signal-aware legs.** Strike *Anomaly strike* (the anomaly's flagged strike or its pair, ± n strikes) and *Support / resistance* (calls at the nearest resistance above, puts at the nearest support below, ± n strikes). Target *Nifty reaches S/R* exits a leg when Nifty reaches the level on the favourable side (± buffer). Levels are always computed from sessions **before** the trade day (no look-ahead).

**Saving.**
- **New** (Backtest screen) or **+ New strategy** (Strategies screen) starts a blank strategy.
- Your own strategies save in place with **Save**; **Save as…** makes a copy.
- **Built-in strategies can be edited:** **Save** asks whether to update the built-in (it is stored as an edited copy that replaces the original everywhere, marked *edited*) or save a new strategy. **Reset to original** restores it.
- Everything lives in `bt-data/strategies.json` and appears on every screen.

## Running a backtest

- **Period:** pick it, or use the 1M / 3M / 6M / 1Y / All shortcuts.
- **Expiries** (the expiries button): test all expiries in the period, or just some. You can tick single weeks, several weeks, monthly only, weekly only, or the last 4.
- **Costs:**
  - slippage % (applied against you on every fill)
  - brokerage per order
  - STT, exchange, SEBI, stamp and GST charges, at the rates in force on the day of each order (`lib/costs.js`: STT 0.10 % from Oct 2024, 0.15 % from Apr 2026); a leg that expires before the exit places no closing order (a bought one in the money pays STT on its settlement value)
- **Capital:** leave empty to use an estimated margin for ROI.

**Scenarios (every run)**
- **Nothing runs when the Backtest screen opens.** It opens on the **Summary** tab, built from the saved backtests (`bt-data/backtests.json`): the **top 5 of the Bi-weekly Hedge** and the **top 5 of the Bi-weekly Hedge Reverse** by % profit as defined (**Show all strategies** lists the rest), with a card for the best one (investment, net P&L, % profit, trades, winners vs losers, profit vs loss, drawdown, profit factor). Strategies whose short options are not fully covered carry an "unlimited risk" tag. Under them, **Other strategies — top 5 variants** lists the five best take-profit × stop-loss × exit variants of the saved backtests (limited risk only, at most 2 per strategy; backtests saved before this list existed show up once they are run again). Click a strategy to see its saved result in **Details** and **Adjustments** without running it again.
- **Run backtest** backtests the strategy in the editor with the settings in the bar and replaces its saved result; **Backtest all strategies** (Summary tab) does that for every strategy. Looking at a scenario or variation other than the stored one computes just that one.
- Each run tests the strategy as defined plus every combination of **take profit** (none, 10 % … 90 % of the net credit; up to 200 % for debit positions), **overall stop-loss** (none, 50 / 100 / 200 % of the credit; 25 / 50 / 75 % of a debit) and **exit** (positional: expiry day or 1–3 trading days before; intraday: 11:00, 12:30, 14:00, 15:15). Entries, strikes, leg targets, rolls, adjustments and filters stay as defined. **Every stop-loss judges the whole strategy's loss**, never a single leg (see *Building a strategy*).
- The table lists them with the most profitable on top (click a column to sort; combinations with the same result share a row). Click a row: the KPIs, **Monthly / Breakdown / Suggestions / Trades** tabs and the equity curve below show that scenario. **Use in editor** copies its rules into the strategy ("% of premium" under Overall position).
- **Suggestions** also has a *Reducing the max drawdown* card: when the deepest fall happened, and the tested scenarios and adjustment variations (once tested in the Adjustments tab) that had a smaller drawdown while staying profitable, each with a link to open it.
- **Suggestions** analyses the losing trades of the selected scenario: which tested rule did better, losers that were in profit first, which side (calls / puts) lost, how much room a stop needs, thin-credit entries.
- **Details / Adjustments tabs:** *Details* is everything above. *Adjustments* lists the strategy with one adjustment changed at a time (week-1 exit instead of the roll, roll timing, take profit, overall stop, leg stops and re-entry, market-move adjustments (roll the tested side, roll the untested side, re-centre), entry filters, the reverse position; `bt/adjustments.js`), each backtested with the same settings and ranked by net P&L. Click a variation to open it in Details; **◂ As defined** goes back, **Use in editor** copies it into the editor.
- **Investment and % profit:** the investment is the Capital in the settings bar (else the largest estimated margin of the trades). Net P&L is also shown as a % of it in the KPIs, both tables, the monthly grid, the breakdowns, each trade and the CSV.
- Scans are cached in `bt-data/scenario-cache.json` (expired data never changes), so repeats are instant. The best row is picked on the same trades it is measured on: confirm it on another period.

**How fills work**
- Entries and timed exits fill at that minute's **open**.
- Stops and targets are checked against each 1-minute candle's **high and low**. When both are hit in the same candle, the stop is assumed to come first (conservative). A candle that gaps through a level fills at its open.
- Overall MTM rules and market-move adjustments are checked on candle closes; an adjustment fills at the next minute's open.
- Minutes without trades carry the last price.
- Legs whose expiry comes before the position's exit settle at their expiry close.

**Results**

| Section | What it shows |
| --- | --- |
| Tiles | net P&L (gross and costs), win rate, average trade / win / loss, max drawdown and its dates, return ÷ drawdown, profit factor, ROI on margin, Sharpe / Sortino, best and worst trade, streaks |
| Equity curve | cumulative P&L with per-trade bars and a drawdown strip; click a bar to open that trade |
| Monthly | year × month P&L heat-table |
| Breakdown | by weekday, by days to expiry, how legs exited, and the P&L distribution |
| By market regime (Breakdown) | trades, win rate, P&L and average per kind of market, to see whether a strategy holds up in all of them. What Nifty did while each trade was open: **trend up / down** (moved more than 1 % × √sessions held, entry to exit), **whipsaw** (no such move, but a high–low range above 1.8 % × √sessions) or **range**. And India VIX at entry: below 13, 13–16, above 16. Also on the Bi-weekly screen. Backtests saved before this get both from the cached Nifty and VIX candles when opened |
| Trades | every trade with each leg's entry → exit; click a trade for its minute-by-minute P&L against Nifty and the full leg table. **Export CSV** saves all legs |
| Skipped | days that matched the rules but couldn't trade, with the reason |

Signal strategies also show how many sessions had a signal, and each trade lists the signal that triggered it (also in the CSV).

Margin is estimated: about 9% of notional per naked short lot, capped at the defined risk for spreads, with partial offset for straddles and strangles. Use **Capital** for your own figure.

## Bi-weekly (hedge, reverse, combined)

One screen for the two bi-weekly strategies. The menu on the left picks **Bi-weekly Hedge**, **Bi-weekly Hedge Reverse** or **Combined**; each has the same three tabs.

- **Backtest all variations** runs every variation of both strategies over the period in the bar (by default the whole option history, about two years, on ₹5 L): the adjustment variations of *BiWeekly Hedge-Hari* and of the built-in reverse (`bt/adjustments.js`) plus the built-in bi-weekly variants. The headline numbers are saved in `bt-data/biweekly.json` and shown next time without running anything.
- **Short strikes:** *By premium* keeps the strikes as the strategies define them (≈₹105 / ≈₹120); *Points OTM* sells the call and the put that many points from spot (100 by default) in every variation. It applies on the next **Backtest all variations**.
- **New trade every week (overlapping):** ticked (the default), a position is entered at the start of every weekly series even while the previous one is still open; each is its own trade and all are in the results, so up to two positions (twice the capital) are open at once. Unticked, those weeks are skipped as "previous trade still open".
- **Summary:** the best variation (highest net P&L among those whose short options stay hedged; "unlimited risk" ones are listed but never picked) and the top 5, with the P&L per year.
- **Details:** KPIs, monthly grid, breakdown, trades (click one for its minute-by-minute P&L, **▶ Replay** for the Builder), skipped expiries and the equity curve of one variation. **Open in Backtest ▸** puts it in the editor.
- **Adjustments:** every variation ranked; click a row to open it in Details.
- **Combined:** the hedge and the reverse as **one position**: the 4 legs of each (8 legs) are entered together, with one target / stop on the whole position, one exit, and one trade in the results (so **▶ Replay** puts all of them in the Builder). It has its own adjustment variations, plus the legs of the best hedge and best reverse variation put together. *Capital*, *Hedge lots* and *Reverse lots* are set at the top (2 + 2 lots to start with); **Apply** backtests the combined variations again. The net-credit and covered-risk entry checks are the two strategies' limits added up.

## Compare

Tick any number of library and saved strategies. They run on the same days and expiries with the same costs.

- **Table:** all strategies ranked by return ÷ max drawdown by default. Click a column to rank by it instead.
- **Summary cards:** best risk-adjusted, most profit, highest win rate, smallest drawdown.
- **Charts:** overlaid equity curves, and P&L by year with the count of profitable months.
- Click a strategy name to open its full backtest.

## Strategies and live deployment

Ready-made strategies are grouped by outlook:

| Group | Strategies |
| --- | --- |
| Neutral | 9:20 straddle (plain, MTM lock & trail), ₹50 strangle, expiry-day straddle, intraday and weekly iron condors, iron butterfly, 0.2-delta weekly strangle, weekly iron condor with the tested side rolled when a short doubles, multi-week monthly iron condor, butterfly |
| Bullish / bearish | debit and credit spreads, long call / put, jade lizard, 1×2 ratio spreads |
| Volatility | long straddle, long strangle, trailing straddle buy |
| Calendar | call calendar, double calendar |

Each card shows a payoff sketch and three buttons:
- **Backtest:** runs the strategy immediately.
- **Customise:** opens it in the editor.
- **Deploy live:** resolves the strategy on the current option chain for the expiry you pick, then shows:
  - each leg's strike, price, bid/ask, IV and delta
  - net credit or debit, max profit and loss, breakevens
  - chance of profit, estimated margin, net greeks
  - a payoff chart at expiry, today (T+0), and on any day in between

  Nudge strikes with − / +, change lots, or switch between LTP and bid/ask pricing. **Save as my strategy** stores changed strikes as ATM offsets, so the saved strategy applies to all future expiries.

## Arbitrage (anomaly scanner)

A research screen. It looks for prices on the Nifty chain that break a pricing bound, checks whether they could really have been traded, and works out what is left after costs. **It never places an order.**

Two kinds of signal are kept apart everywhere (live cards, log, history scan):

- **Arbitrage:** a bound that follows from the payoff alone. On Nifty's European, cash-settled options the suggested trade cannot lose if every leg is filled at the quoted prices and held to expiry, before brokerage and taxes.
- **Relative value:** a price out of line with the rest of the chain. A statistical edge, not a locked-in profit.

| Type | Bound tested | Fires when (defaults) | Suggested trade |
| --- | --- | --- | --- |
| Box spread (arbitrage) | `C(K1) − C(K2) + P(K2) − P(K1) = (K2 − K1)·e^(−rT)`: put-call parity at two strikes | a box up to 6 strikes wide can be bought ≥ 2 pts below its discounted width, or sold ≥ 2 pts above its full width | buy / sell the box |
| Butterfly (arbitrage) | `C(K − w) − 2·C(K) + C(K + w) ≥ 0`, same for puts: prices are convex in the strike | a 1 − 2 + 1 fly (equal wings, 1 strike by default) pays a credit ≥ 0.5 pts | buy the fly |
| Broken-wing butterfly (arbitrage) | `(K3 − K2)·C(K1) − (K3 − K1)·C(K2) + (K2 − K1)·C(K3) ≥ 0`, same for puts: convexity with unequal spacing | the strike-weighted fly (1- and 2-strike wings by default: buy 2, sell 3, buy 1) pays a credit ≥ 0.5 pts | buy the weighted fly |
| Vertical spread (arbitrage, from the Builder) | `0 ≤ C(K1) − C(K2) ≤ K2 − K1`, same for puts: monotonic in the strike, never worth more than the width | a further-OTM option costs more than a nearer one (**free-credit**), or two strikes are priced further apart than their gap (**over-width**), by ≥ 0.5 pts | the riskless vertical |
| Calendar, calls (arbitrage) | `C(K, T2) ≥ C(K, T1)` for the same strike | the next expiry's call can be bought ≥ 0.5 pts below what this expiry's call sells for | sell this expiry, buy the next |
| Fair value deviation (relative value) | fair = Black-76 on the chain's own forward at the volatility of the neighbouring strikes (a quadratic through up to 3 strikes either side, leaving the strike itself out) | an option can be sold above / bought below fair value by ≥ 2 pts and ≥ 5 % | rich: sell it, buy the next strike out; cheap: buy it, sell the next strike out; exit when it is back at fair value |

Each type's formula, assumptions and what to watch for are listed in **⚙ Tune**; every card and every history row shows the numbers that went into the check.

**Conventions, all on the cautious side.** Money received later is discounted (6.5 % a year over calendar days); money owed later is not, because a credit earns no interest in a trading account. So a sold box is tested against its full width and a vertical against its undiscounted width. Volatility runs on trading time (252 sessions of 375 minutes).

**What is not scanned, and why**

- *Conversions, reversals and synthetic-versus-futures:* they need a futures leg, the app has no futures feed, and only the monthly option expiry settles with the future. Parity is tested across strikes instead: that is the box, and the **Put-call parity by strike** panel shows the forward each strike's synthetic buys and sells at.
- *Call and put implied volatility at one strike differing:* with both priced off one forward this is the same statement as a parity break at that strike, so the box covers it.
- *Skew, implied versus realised volatility, term structure:* shown as context (Skew RR, IV / RV, forward and basis) but not as signals. They have no payoff bound; they belong in a backtested strategy.
- *Iron condors and butterflies, ratio spreads, expected-value screens:* defined risk is not arbitrage. Build and test those in **Backtest** and the **Builder**.
- *Order-book imbalance:* the **Book** screen.
- *Other expiries:* the scanner works on the nearest weekly expiry (and the next one for the calendar).

**Quality gates (one set for every type, under ⚙ Tune).** A mispricing counts only if it can be traded:

| Gate | Default | Applies |
| --- | --- | --- |
| Two-sided, uncrossed quote on every leg | always | live |
| Fillable ≥ | 1 lot of the whole structure at the best bid / ask (a butterfly body needs twice that) | live |
| Spread ≤ | 3 pts, or ≤ 1 % of the premium (either is enough) | live |
| Volume ≥ / Open interest ≥ | 500 / 5,000 lots | live |
| Quote age ≤ | 15 s since the quote was last refreshed | live |
| Seen for ≥ | 5 s: the opportunity must still be there on the next scan | live scanner |
| Traded within | 1 minute | history (candles) |
| In the money ≤ | 300 pts: candles carry no quotes, and far in the money a last trade is often one lot well away from the quote | history (candles) |
| Min premium | ₹0.05 | all |

The defaults come from a recorded session (8 Oct 2026): spreads were about 0.3 pts (0.25 % of premium) at the money, under 1 pt up to 300 points in the money, and 3 pts with a tail above 10 beyond 600. They are starting points; change them to suit the day.

The bar on top holds the types as chips, numbered by how easy each is to trade without slippage (1 box, 2 fair value deviation, 3 butterfly, 4 broken-wing butterfly, 5 vertical, 6 calendar): click a chip to switch a type on or off. **Strictness** (Strict / Balanced / Loose) scales the minimum edge and the lots that must be on the book; **Net ≥ ₹** hides live opportunities that leave less than that after costs; **⚙ Tune** opens every threshold, the quality gates and each type's cooldown (one log entry per opportunity and strike per N minutes). Changes apply to the live scanner as you make them (`bt-data/anomaly-config.json`).

**Costs** come from one dated schedule (`lib/costs.js`), used by the live cards and both history scans: ₹20 an order, STT on option sales, exchange and SEBI fees, 18 % GST on those, stamp duty on buys, and STT on bought options that settle in the money.

| From | STT on sales | STT on exercise | NSE transaction charge |
| --- | --- | --- | --- |
| 1 Apr 2023 | 0.0625 % | 0.125 % | 0.05 % |
| 1 Oct 2024 | 0.10 % | 0.125 % | 0.03503 % |
| 1 Apr 2026 | 0.15 % | 0.15 % | 0.03503 % |

Check them against NSE's charges page and your contract note after every budget. The Backtest screens still use their own fixed rates.

### Live

The server scans every 5 s during market hours, also with the page closed.

- **Arbitrage candidates** and **Relative value** are separate lists. A card shows the legs as an order ticket (bid or ask, lots waiting there, spread, age of the quote), the edge, and what is left **after costs** for 1 lot and for all the lots the book fills. For an arbitrage it also shows what is left if Nifty settles 3 % away, because the exercise STT grows as the bought legs go deeper in the money.
- Badges: *Confirming* (seen, but not yet for the "Seen for" time), *Profitable after costs*, *Profitable from N lots* (the fixed brokerage needs size), *Costs exceed the edge*, *Not executable at bid / ask*. Only confirmed opportunities are logged and alerted.
- **Scanner health:** age of the chain, tick feed up or down, how many contracts carry a two-sided quote, crossed and stale quotes, the spread near the money, the age of the next expiry's chain, how long the scan took.
- **Rejected signals:** structures that looked like an arbitrage at quote mids or last-traded prices but failed a check, with the reason (not there at the bid / ask, no quote, crossed, spread, stale, depth, volume, open interest).
- **Put-call parity by strike:** see above.
- **Today's log** (`bt-data/anomaly-log/<date>.jsonl`), **🔔 Alerts** (a beep and a desktop notification when a new opportunity that pays appears), **Deploy ▸** (resolves the trade on the live chain as a paper position) and **Backtest ▸** (opens it as a signal strategy).

### History scan

Pick the prices to scan on, press **Scan history**; **■ Stop** ends a scan and keeps what it has found. The last scan of each kind is saved (`bt-data/anomaly-scan.json`, `anomaly-scan-quotes.json`) and shown again when the screen opens. Costs are worked out for the **Size** you set (10 lots by default).

**1-minute candles** (about two years, from the Data screen). These are last-traded prices: no bid / ask, no depth, no volume. The closes of two contracts are trades a few seconds apart, so most "violations" between them are timing or the two sides of a spread. Each arbitrage signal is therefore taken through checks of rising strength:

| Check | Means |
| --- | --- |
| Signal | the bound is broken at the minute's closing prices |
| Robust | and at the worst prices traded in that minute: buys at each leg's high, sells at its low |
| Fillable | and again at the worst prices of the next minute |
| Pays | and what it locks in there exceeds the costs |

A minute with a single traded price does not say which side traded, so the other side is taken a full permitted spread away. Fillable signals are also settled at the expiry (the average of Nifty's last 30 one-minute closes stands in for the exchange's settlement price). What a signal that is not fillable made at expiry is market direction, so it is not reported. The table also shows the average edge at the next minute's open, and the same counts for the latest 30 % of the sessions and for expiry days.

**Recorded quotes.** The app records the nearest expiry's best bid and ask every second while it runs during market hours (the tape under `events/`, see *Recordings*); from this version on also the quantity at each. The same detectors run on those recordings, every leg at the side it would trade on:

| Check | Means |
| --- | --- |
| Signal | the bound is broken at the bid / ask with every quality gate passed |
| Fillable | and stays broken on every snapshot for the **Act after** seconds (3 by default), priced at the quotes at the end of them |
| Pays | and what it locks in there exceeds the costs |

plus how long each one lasted. A snapshot joins quotes that arrived a few hundred milliseconds apart, so a violation gone on the next snapshot was usually the quotes being out of step. This is the strongest evidence the app has, but it covers only the days it was running, and older recordings carry no quantities.

Fair value deviations are measured as a trade: entered at the next minute's open (candles) or at the bid / ask after the delay (quotes), then marked after 5 / 15 / 30 / 60 minutes and at the end, with entry and exit costs.

Every occurrence has a **▶ Replay** button (expired expiries) that opens it in the Builder at its entry minute with the same strikes and prices. **Backtest as strategy** turns a type into a full signal strategy with stops, costs and re-entries.

**Read the results with these limits in mind:** candles cannot prove a trade was possible; recordings cannot say how fast your own orders would fill; no scan knows the margin a sold structure blocks; and exchange holidays are not known to the app.

## Strategy Builder (Builder screen)

- **Source:** *Historical replay* (any expired expiry, start on any day of its last ~5 weeks at any time) or *Live (paper)* on an upcoming expiry (prices refresh every 5 s; entries/exits are recorded at LTP — no orders are sent).
- **Chain (left):** LTP, delta, IV (and OI live) with **B** / **S** buttons per strike, S/R tags, open-position markers. Or pick any built-in / saved strategy and **Apply** it at the current time (strike rules resolved on the chain; lots multiplier).
- **Payoff (right):** at expiry and now (T+0), spot, ±1σ and breakevens; credit/debit, max profit/loss, chance of profit, net Greeks.
- **Replaying a backtest trade (▶ Replay in the Backtest's Trades tab):** the Builder gets the trade's entry legs and everything the backtest did afterwards (roll, leg stops / targets, re-entries, partial booking, target / stop / time exit). They are listed above the suggestions as *Adjustments from the backtest* (Next / Later / Done). **▶ Step** and **⏵ Auto play** land on each one's minute, make the same trades at the backtest's prices and show an alert saying what was done and why; auto play stops when the trade is finished. The replay uses the backtest's fills (slippage included) and lot size, and the P&L header also shows the total **after costs** (the trade's brokerage and taxes), which ends on the trade's Net P&L in the backtest.
- **Saved trades:** **💾 Save trade** keeps the position in the Builder — a live paper trade or a replay — with its legs, entries and exits, log and P&L (`bt-data/paper-trades.json`). The **Trades** screen lists them all: mode, expiry, open legs, realised / open / total P&L at the last save and, for live paper trades, the total at current prices (**↻ Live P&L**). **Load** puts a trade back in the Builder with its payoff, positions and P&L; adjust it and press **Save changes** (or **Save as new…** for a copy).
- **Replay:** step 1, 3, 5, 10, 15, 30 min, 1 h, 2 h or 1 day — **▶ Step** manually or **⏵ Auto play** at 0.5–4 s per step. *Intraday* stops (and squares off) at the close; *Multi-day* carries the position overnight to expiry, where open legs settle.
- **Positions & P&L:** every leg with entry/now/exit, P&L, delta, **Exit**, roll one strike ◀ ▶, realised/open/total, a P&L-vs-Nifty chart over the replay, and a trade log.
- **Adjustment suggestions:** a rule book of published techniques, re-evaluated every step, ranked *Act now / Consider / Option / OK*, each with the reasoning, source and an **Apply** button that places the orders at current prices:
  - profit taking at 50% of the credit, stop at 2× the credit, debit positions at +100% / −50% (tastylive / Option Alpha management rules)
  - strangle / iron condor: roll the untested side to ~0.30 Δ, convert to a straddle / iron fly when a short strike is breached, close the untested side for pennies, roll the tested spread out in time, add wings when IV expands or the move accelerates
  - short straddle / iron fly: re-centre at the new ATM
  - credit spreads: roll down/up, or add the opposite spread to make an iron condor
  - long options: sell a further OTM option against a winner (vertical) or roll up; long straddles: gamma scalp, vol-crush warning
  - ratio spreads: buy a far wing; butterflies: re-centre / add a second fly
  - delta rebalancing, vega warnings, unhedged shorts, expiry-day gamma (close near-ATM shorts after 14:30), intraday square-off
  - support/resistance: shorts protected behind a major level, or a broken level heading toward a short strike
- **🔎 Research online:** sends the position, Greeks, chain, levels and rule suggestions to Claude (`claude-opus-5-5`) with web search; it returns a situation summary, 3–5 ranked concrete adjustments with strikes, rules of thumb and the sources it used. Needs `ANTHROPIC_API_KEY` in `.env` (or an `ant auth login` profile); results are cached for 30 minutes per position.

Other screens hand positions to the Builder: a backtest trade (**▶ Replay**), a strategy (**Builder ▸**), an arbitrage, and a portfolio hedge from the Hedge screen.

---

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
4. **Results:** **Builder ▸** opens the selected hedge in the Strategy Builder as a paper position on the live chain of its expiry (payoff on any date, Greeks, adjustment suggestions). Below it: the selected hedge's exact legs (strike, quantity, price, bid/ask, OI), a payoff chart against no hedge, a scenario table from −30% to +20%, and a comparison table of all strategies (cost per year, loss at your fall and at −25%, upside kept, where gains stop). Everything updates as you change an input, and prices refresh every minute.

Limits: payoffs are at the option's expiry, beta is a historical estimate, and non-index holdings won't track Nifty exactly. Sold calls need margin and cap gains above their strike. It's a calculator, not advice.

### Backtest (second tab inside Hedge)

Replays hedges over past Nifty moves and compares how each one did. Daily Nifty 50 and India VIX closes since 2008 are downloaded from Upstox once and kept in `hedge-cache/history.json`; after that only new days are fetched. These hedges run for months and the test goes back to 2008, far beyond the ~2 years of real option prices Upstox keeps (those drive the strategy Backtest screen), so every leg is priced with **Black-Scholes**. The volatility is that day's India VIX (or realised or fixed volatility, if you pick one), plus put/call skew and an optional term-structure adjustment. You pay half the bid/ask spread when you buy and when you sell, plus charges per leg.

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

This is a different test from the **Backtest** screen under Strategies: that one replays trading strategies on real 1-minute option prices of the last two years; this one prices months-long hedges with a model over 17 years, so it covers 2008 and 2020.

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

The end-to-end tests need a browser. `npx playwright install chromium` downloads Playwright's own once; or set the environment variable `PW_CHANNEL` to `chrome` or `msedge` to use the one already installed. They only look and navigate: they never run a backtest, a scan or a download, and the demo server's recordings go to a temp folder. `E2E_PORT` changes the port.

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
| `lib/costs.js` | Brokerage and taxes on option trades by date: used by the Arbitrage screen's history scans and, as `/lib/costs.js`, by its page |
| `lib/time.js`, `lib/env.js` | IST dates and market hours; `.env` loader |
| `feed.js`, `tape.js` | Tick feed (WebSocket); the all-day market tape |
| `signals.js`, `sigstats.js`, `signal-backtest.js` | Spike signals and recordings; their track record; the signal backtest (also a command) |
| `flow.js`, `replay.js` | Volume-flow predictions; replay of a recorded day (also a command) |
| `pulse.js`, `book.js`, `study.js` | Market Pulse; order book; the indicator scorecard (a command) |
| `orderflow.js` | Order flow of the options as minute rows (today live, earlier days from the tape) and the read shown under the chart |
| `hedge/` | Portfolio hedge: holdings (`holdings.js`, `xlsx.js`), betas, planner (`engine.js`), daily history and backtest |
| `bt/data.js` | Historical data download, disk + memory cache |
| `bt/sync.js` | What the cache lacks for a selection of expiries, the download job, the automatic update |
| `bt/engine.js` | Backtest engine (strike selection, fills, stops, re-entry, costs, margin) |
| `bt/metrics.js` | Performance statistics |
| `bt/library.js` | Ready-made strategies |
| `bt/index.js` | Backtest API: jobs, compare, scans, saved/edited strategies, live deploy, levels, Builder data |
| `bt/levels.js` | Major / minor support and resistance, and the levels projected past the last swing level |
| `bt/anomalies.js` | The scanners (no-arbitrage bounds and fair value), their quality gates and rejected signals, trading-time IV, suggested trades |
| `bt/histchain.js` | Rebuilds a past chain at any minute from cached candles |
| `bt/scan.js` | History scan on 1-minute candles: each signal checked against the worst prices of its minute and the next, settled at expiry |
| `bt/tapescan.js` | History scan on the recorded bid and ask: each signal followed second by second |
| `bt/conditions.js` | Signal entry conditions (anomaly, S/R, move, range) |
| `bt/biweekly.js`, `public/bw-view.js` | The Bi-weekly screen: variations of the hedge, of its reverse, and of the two as one position |
| `bt/research.js` | Online adjustment research (Claude + web search) |
| `anomaly-live.js` | Live scanner: opportunities, rejected signals, scanner health, parity by strike, daily log |
| `public/app.js` | The page: screens and groups, option chain, signals pane, volume surge, support / resistance |
| `public/chain-chart.js` | Nifty candle chart (Chain, Pulse, and its own window `chart.html`) |
| `public/charts.js`, `flow-view.js`, `pulse-view.js`, `book-view.js`, `signals-backtest.js` | The Surge, Flow, Pulse, Book and Signal test screens |
| `public/hedge-view.js`, `hedge-backtest.js` | The Hedge screen: planner and backtest |
| `public/an-view.js`, `arb.js` | Arbitrage screen; the arbitrage pane under the chain |
| `public/sb-view.js`, `public/sb-adjust.js` | Strategy Builder and its adjustment rule book |
| `public/bt-*.js`, `cmp-view.js`, `lib-view.js`, `data-view.js`, `payoff.js` | The backtest screens |
| `public/styles.css`, `live.css`, `hedge.css`, `bt.css`, `themes.css` | Styles: base and chain, live screens, hedge, strategy screens (and shared components), colour themes |
| `test/` | Unit tests (`npm test`) |
| `e2e/`, `playwright.config.js` | End-to-end tests of the page in demo mode (`npm run test:e2e`) |
| `.github/workflows/ci.yml`, `azure-pipelines.yml`, `ci/` | The CI pipelines for GitHub Actions and Azure Pipelines, and the scripts they share |
| `eslint.config.js`, `.prettierrc.json`, `.prettierignore`, `.gitattributes` | Lint rules, code layout, and LF line endings on every platform |

Recordings go to `events/` (`events-demo/` in demo mode), downloaded history to `bt-cache/`, saved strategies, results and trades to `bt-data/`, hedge betas, history and saved structures to `hedge-cache/`, replays to `replays/`.

This is an analysis tool, not investment advice. Backtests use historical 1-minute candles and modelled costs, so real fills, margins and liquidity will differ.
