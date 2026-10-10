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
3. Run `npm start` and open <http://localhost:3000>.
4. Click **Login with Upstox** if asked. The token is saved to `.token.json` until it expires (about 3:30 AM IST the next day).

`npm run demo` shows the live screens with synthetic data. Backtesting and the Hedge screen need real Upstox data. `npm test` runs the tests.

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
| **Strategies** | **Arbitrage** | Option arbitrage and fair-value deviations: live scanner, history scan, one-click strategy |
| | **Strategies** | Ready-made and saved strategies as cards (**+ New strategy**, edit / reset built-ins); **Deploy live** on an upcoming expiry |
| | **Backtest** | Build or load a strategy, run it over a period, study the results |
| | **Bi-weekly** | The bi-weekly hedge, its reverse and the two combined: every variation backtested over the whole history |
| | **Compare** | Backtest many strategies on the same days and rank them |
| | **Builder** | Manual / strategy trading on a historical replay or live (paper), payoff, P&L, adjustment suggestions |
| | **Trades** | Trades saved from the Builder; load one back |
| **Portfolio** | **Hedge** | Protect your holdings with Nifty options: planner and backtest |
| **Data** | **Data** | What history Upstox provides, what's cached, bulk prefetch |

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
- **Nifty chart** (Chart & levels): candles of 1, 5, 10, 15 minutes, 1 hour, 2 hours, day, week or month, with the support / resistance levels drawn across. Drag to move, wheel to zoom, scroll back to load older candles; **Candles / Line**, **S/R** on/off, **Latest**. The hovered candle's open / high / low / close is shown at the top left; hovering a support / resistance line shows its details (major / minor, distance from Nifty, source).
  - **New window** opens the chart in its own window (`chart.html`) with the full tool set: **indicators** (SMA, EMA, Bollinger Bands, Supertrend on the price; RSI, MACD, ATR, Stochastic in their own panes; any parameters, several at once, ✕ in the legend removes one), chart types (candles, bars, Heikin Ashi, line, area), **drawings** (horizontal and trend lines; right-click one to remove it), log scale, PNG snapshot and full screen. Indicators and drawings are remembered.
  - History is read from the cached 1-minute Nifty files (`bt-cache/index`); today's candles come from the Upstox intraday endpoint (re-read every 30 s) and the last candle follows the live tick feed.
- **Under the chain** is one of two panes as well: **Arbitrage**, the live vertical-spread arbitrage of the expiry shown (click its header to fold it away), or **Volume surge** (see *Volume surge and Surge charts*).
- **Support & resistance panel:** nearest major/minor resistance and support with distance from spot, and the full ladder around Nifty. Click its header to collapse it (the chart takes the space).

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
| `tape-HHMMSS.jsonl.gz` | **The market tape**: one compressed line per second for the nearest expiry, holding Nifty spot plus, for CE and PE at ATM ±15 strikes, LTP, volume and OI. With the tick feed it also holds buyer- and seller-initiated volume, best bid and ask, and the total buy and sell queue. Each server start begins a new part. About 15 MB per trading day. Everything below can be recomputed from it. |
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

- **Tick feed (WebSocket):** Nifty plus 15 strikes either side of ATM (calls and puts) stream live from Upstox's Market Data Feed V3. Ticks are folded into a snapshot every 500 ms, and the page refreshes every 400 ms. Subscriptions follow ATM as it moves.
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
- **Data screen:** shows coverage per expiry and can prefetch a range in bulk.
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

- **Stop-loss / target:** % of premium, ₹ points, or a Nifty move (% or points) against or in favour of the leg.
- **Trailing stop:** for every X move in your favour, move the stop by Y.
- **Re-entry** after a stop and/or target, up to N times:
  - immediately at the same strike,
  - when the price returns to the original entry,
  - immediately at a freshly selected strike.

**Whole position**
- **Exits:** overall ₹ stop-loss and target.
- **Lock and trail:** "when MTM reaches ₹A, lock ₹B, then raise the lock ₹D for every ₹C more".
- **When one leg's stop hits:** exit that leg only, or all legs. Optionally move the other legs' stop to cost.

**Filter:** India VIX range at entry.

**Entry trigger.** *At the entry time* (classic), or *On a signal*: from the entry time until a "watch until" time, the strategy enters at the next minute's open once **all** of its conditions hold, up to N trades a day (after an intraday trade closes it keeps watching). Conditions:

| Condition | Holds when |
| --- | --- |
| Anomaly | an anomaly type fires (its thresholds, optional CE/PE side and direction) |
| Near S/R | Nifty is within X points of a support / resistance level (major, minor or any) |
| S/R break | Nifty closes through a level this minute (above resistance / below support) by X points |
| Nifty move | Nifty is up / down / either way at least (or at most) X points or % from the open or previous close |
| Day range | high − low since the open is at least / at most X points |

**Signal-aware legs.** Strike *Anomaly strike* (the anomaly's flagged strike or its pair, ± n strikes) and *Support / resistance* (calls at the nearest resistance above, puts at the nearest support below, ± n strikes). Stop-loss *Nifty through S/R* exits a leg when Nifty closes through the level beyond it on the adverse side (± buffer); target *Nifty reaches S/R* exits when it reaches the level on the favourable side. Levels are always computed from sessions **before** the trade day (no look-ahead).

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
  - STT, exchange, SEBI, stamp and GST charges
- **Capital:** leave empty to use an estimated margin for ROI.

**Scenarios (every run)**
- **Nothing runs when the Backtest screen opens.** It opens on the **Summary** tab, built from the saved backtests (`bt-data/backtests.json`): the **top 5 of the Bi-weekly Hedge** and the **top 5 of the Bi-weekly Hedge Reverse** by % profit as defined (**Show all strategies** lists the rest), with a card for the best one (investment, net P&L, % profit, trades, winners vs losers, profit vs loss, drawdown, profit factor). Strategies whose short options are not fully covered carry an "unlimited risk" tag. Click a strategy to see its saved result in **Details** and **Adjustments** without running it again.
- **Run backtest** backtests the strategy in the editor with the settings in the bar and replaces its saved result; **Backtest all strategies** (Summary tab) does that for every strategy. Looking at a scenario or variation other than the stored one computes just that one.
- Each run tests the strategy as defined plus every combination of **take profit** (none, 10 % … 90 % of the net credit; up to 200 % for debit positions), **overall stop-loss** (none, 50 / 100 / 200 % of the credit; 25 / 50 / 75 % of a debit) and **exit** (positional: expiry day or 1–3 trading days before; intraday: 11:00, 12:30, 14:00, 15:15). Entries, strikes, leg stops, rolls and filters stay as defined.
- The table lists them with the most profitable on top (click a column to sort; combinations with the same result share a row). Click a row: the KPIs, **Monthly / Breakdown / Suggestions / Trades** tabs and the equity curve below show that scenario. **Use in editor** copies its rules into the strategy ("% of premium" under Overall position).
- **Suggestions** also has a *Reducing the max drawdown* card: when the deepest fall happened, and the tested scenarios and adjustment variations (once tested in the Adjustments tab) that had a smaller drawdown while staying profitable, each with a link to open it.
- **Suggestions** analyses the losing trades of the selected scenario: which tested rule did better, losers that were in profit first, which side (calls / puts) lost, how much room a stop needs, thin-credit entries.
- **Details / Adjustments tabs:** *Details* is everything above. *Adjustments* lists the strategy with one adjustment changed at a time (week-1 exit instead of the roll, roll timing, take profit, overall stop, leg stops and re-entry, entry filters, the reverse position; `bt/adjustments.js`), each backtested with the same settings and ranked by net P&L. Click a variation to open it in Details; **◂ As defined** goes back, **Use in editor** copies it into the editor.
- **Investment and % profit:** the investment is the Capital in the settings bar (else the largest estimated margin of the trades). Net P&L is also shown as a % of it in the KPIs, both tables, the monthly grid, the breakdowns, each trade and the CSV.
- Scans are cached in `bt-data/scenario-cache.json` (expired data never changes), so repeats are instant. The best row is picked on the same trades it is measured on: confirm it on another period.

**How fills work**
- Entries and timed exits fill at that minute's **open**.
- Stops and targets are checked against each 1-minute candle's **high and low**. When both are hit in the same candle, the stop is assumed to come first (conservative). A candle that gaps through a level fills at its open.
- Overall MTM rules are checked on candle closes.
- Minutes without trades carry the last price.
- Legs whose expiry comes before the position's exit settle at their expiry close.

**Results**

| Section | What it shows |
| --- | --- |
| Tiles | net P&L (gross and costs), win rate, average trade / win / loss, max drawdown and its dates, return ÷ drawdown, profit factor, ROI on margin, Sharpe / Sortino, best and worst trade, streaks |
| Equity curve | cumulative P&L with per-trade bars and a drawdown strip; click a bar to open that trade |
| Monthly | year × month P&L heat-table |
| Breakdown | by weekday, by days to expiry, how legs exited, and the P&L distribution |
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
| Neutral | 9:20 straddle (plain, with re-entry, SL-to-cost, MTM lock & trail, Nifty-move stop), ₹50 strangle, expiry-day straddle, intraday and weekly iron condors, iron butterfly, 0.2-delta weekly strangle, multi-week monthly iron condor, butterfly |
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

The screen runs only **arbitrages that can actually be traded**: structures on Nifty's European, cash-settled options that cannot lose if held to expiry (before brokerage and taxes). They run on the nearest weekly expiry, live and in history, nearest the money first.

| Anomaly | Fires when (defaults) | Suggested trade |
| --- | --- | --- |
| Vertical spread arbitrage (from the Builder) | a further-OTM option costs more than a nearer one (**free-credit**), or two strikes are priced further apart than their gap (**over-width**), by ≥ 0.5 pts | the riskless vertical |
| Butterfly arbitrage | a long 1 − 2 + 1 fly (equal wings, 1 strike by default) pays a credit ≥ 0.5 pts | buy the fly |
| Box spread arbitrage | a box between two strikes (up to 6 apart) can be bought for ≥ 2 pts less, or sold for ≥ 2 pts more, than its discounted width | buy / sell the box |
| Calendar arbitrage (calls) | the next expiry's call can be bought for ≥ 0.5 pts less than the same strike's call on this expiry sells for | sell this expiry, buy the next |
| Fair value deviation (a relative-value signal, **not** risk-free) | an option can be sold above / bought below its fair value by ≥ 2 pts and ≥ 5 %. Fair value = Black-76 on the chain's forward at the volatility of the neighbouring strikes | rich: sell it, buy the next strike out; cheap: buy it, sell the next strike out; exit when it is back at fair value |

**Only what can be filled is reported.** Live, every leg is priced where it would really trade (sells at the bid, buys at the ask) and the book must hold at least *Fillable ≥ N lots* of the whole structure on that side (a butterfly body needs twice that); a leg with no bid, no ask or too little quantity drops the hit, and each hit shows how many lots the book can fill. History has no order book, so every leg must have traded within the last minute (*Traded within*) and is priced at its last trade. Put-call parity / conversions and options below intrinsic value are left out on purpose: locking those in needs a futures or index leg.

The bar on top holds the types as chips, numbered by how easy each is to trade without slippage (1 box spread, 2 fair value deviation, 3 butterfly, 4 vertical spread, 5 calendar): click a chip to switch a type on or off. **Strictness** (Strict / Balanced / Loose) scales the minimum edge and the quantity that must be on the book for every type; **⚙ Tune** opens every threshold and the cooldown (one log entry per anomaly/strike per N minutes). Changes apply to the live scanner as you make them (`bt-data/anomaly-config.json`).

- **Live:** the server scans every 5 s during market hours (also with the page closed), with summary metrics (forward, basis, ATM IV), one card per opportunity and today's log (`bt-data/anomaly-log/<date>.jsonl`). A card shows the legs as an order ticket (bid or ask and the lots waiting there), the edge before costs, and what is left **after costs** for 1 lot and for all the lots the book fills — the backtester's charges (₹20 an order, STT, exchange fees, GST, stamp duty; an arbitrage is held to expiry, so entry orders only plus the exercise STT on long legs that are in the money; a fair-value trade pays entry and exit). Its badge says *Profitable after costs*, *Profitable from N lots* (the fixed brokerage needs size), *Costs exceed the edge* or *Not executable at bid / ask*; cards that pay come first. **🔔 Alerts** beeps and sends a desktop notification when a new opportunity that pays after costs appears. **Deploy ▸** resolves the suggested trade on the live chain; **Backtest ▸** opens it as a signal strategy.
- **History scan:** pick a period/expiries in the shared bar and press **Scan history**. **■ Stop** ends a running scan at any point and keeps what it has found so far. The last scan is saved (`bt-data/anomaly-scan.json`) and shown again when the screen is opened, until you run a new one. You get hits per type, days, directions, time-of-day histogram, and the suggested trade's average points and win rate after 5 / 15 / 30 / 60 minutes and to the end of the window (entered at the next minute's open, before costs, no stops), plus every occurrence with its P&L in ₹ per lot to the end of the window, before and after costs (entry and exit), and a **▶ Replay** button that opens it in the Builder at its entry minute with the same strikes and prices. **Backtest as strategy** turns a type into a full signal strategy with stops, costs and re-entries.

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

## Files

| Path | What |
| --- | --- |
| `server.js` | HTTP server, Upstox login, live chain, the contract list and REST chains everything else prices from |
| `lib/upstox.js` | The one Upstox REST client and rate limiter (live calls and historical downloads share the limits); option-chain parser |
| `lib/pricing.js` | Normal CDF, Black-Scholes-Merton, Black-76: used by the server and, as `/lib/pricing.js`, by the page |
| `lib/time.js`, `lib/env.js` | IST dates and market hours; `.env` loader |
| `feed.js`, `tape.js` | Tick feed (WebSocket); the all-day market tape |
| `signals.js`, `sigstats.js`, `signal-backtest.js` | Spike signals and recordings; their track record; the signal backtest (also a command) |
| `flow.js`, `replay.js` | Volume-flow predictions; replay of a recorded day (also a command) |
| `pulse.js`, `book.js`, `study.js` | Market Pulse; order book; the indicator scorecard (a command) |
| `hedge/` | Portfolio hedge: holdings (`holdings.js`, `xlsx.js`), betas, planner (`engine.js`), daily history and backtest |
| `bt/data.js` | Historical data download, disk + memory cache |
| `bt/engine.js` | Backtest engine (strike selection, fills, stops, re-entry, costs, margin) |
| `bt/metrics.js` | Performance statistics |
| `bt/library.js` | Ready-made strategies |
| `bt/index.js` | Backtest API: jobs, compare, scans, saved/edited strategies, live deploy, levels, Builder data |
| `bt/levels.js` | Major / minor support and resistance |
| `bt/anomalies.js` | The anomaly detectors, trading-time IV, suggested trades |
| `bt/histchain.js` | Rebuilds a past chain at any minute from cached candles |
| `bt/scan.js` | History scan with forward outcomes |
| `bt/conditions.js` | Signal entry conditions (anomaly, S/R, move, range) |
| `bt/biweekly.js`, `public/bw-view.js` | The Bi-weekly screen: variations of the hedge, of its reverse, and of the two as one position |
| `bt/research.js` | Online adjustment research (Claude + web search) |
| `anomaly-live.js` | Live anomaly scanner and daily log |
| `public/app.js` | The page: screens and groups, option chain, signals pane, volume surge, support / resistance |
| `public/chain-chart.js` | Nifty candle chart (Chain, Pulse, and its own window `chart.html`) |
| `public/charts.js`, `flow-view.js`, `pulse-view.js`, `book-view.js`, `signals-backtest.js` | The Surge, Flow, Pulse, Book and Signal test screens |
| `public/hedge-view.js`, `hedge-backtest.js` | The Hedge screen: planner and backtest |
| `public/an-view.js`, `arb.js` | Arbitrage screen; the arbitrage pane under the chain |
| `public/sb-view.js`, `public/sb-adjust.js` | Strategy Builder and its adjustment rule book |
| `public/bt-*.js`, `cmp-view.js`, `lib-view.js`, `data-view.js`, `payoff.js` | The backtest screens |
| `public/styles.css`, `live.css`, `hedge.css`, `bt.css`, `themes.css` | Styles: base and chain, live screens, hedge, strategy screens (and shared components), colour themes |
| `test/` | Tests (`npm test`) |

Recordings go to `events/` (`events-demo/` in demo mode), downloaded history to `bt-cache/`, saved strategies, results and trades to `bt-data/`, hedge betas, history and saved structures to `hedge-cache/`, replays to `replays/`.

This is an analysis tool, not investment advice. Backtests use historical 1-minute candles and modelled costs, so real fills, margins and liquidity will differ.
