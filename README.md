# Nifty Options Lab — live chain + strategy backtester (Upstox)

A local web app with two halves:

- **Backtester:** test Nifty option strategies on real 1-minute historical option prices from Upstox. It includes ready-made strategies you can customise, a strategy builder, side-by-side comparison, and live deployment on an upcoming expiry.
- **Live chain:** the Nifty option chain with major/minor support and resistance.
- **Anomalies:** 13 option-pricing anomaly detectors, scanned live and across history, each convertible into a backtestable strategy.
- **Strategy Builder:** trade a position by hand on a minute-by-minute historical replay or the live chain, with payoff, P&L and adjustment suggestions (rule book + online research).

You need Node.js 22 or newer. Run `npm install` once (installs `protobufjs` for the tick feed, `chart.js` for charts, served locally, and `@anthropic-ai/sdk` for the Builder's online research).

## Setup

1. Create an app at <https://account.upstox.com/developer/apps> and set its Redirect URL to `http://localhost:3000/callback`.
2. Copy `.env.example` to `.env` and fill in `UPSTOX_API_KEY` and `UPSTOX_API_SECRET`, or paste a token into `UPSTOX_ACCESS_TOKEN`.
3. Run `npm start` and open <http://localhost:3000>.
4. Click **Login with Upstox** if asked. The token is saved to `.token.json` until it expires (about 3:30 AM IST the next day).

`npm run demo` shows the chain with synthetic data. Backtesting needs real Upstox data.

## Tabs

| Tab | What it's for |
| --- | --- |
| **Chain** | Live option chain with support / resistance |
| **Arbitrage** | Option arbitrage and fair-value deviations: live scanner, history scan, one-click strategy |
| **Builder** | Manual / strategy trading on a historical replay or live (paper), payoff, P&L, adjustment suggestions |
| **Backtest** | Build or load a strategy, run it over a period, study the results |
| **Bi-weekly** | The bi-weekly hedge, its reverse and the two combined: every variation backtested over the whole history |
| **Compare** | Backtest many strategies on the same days and rank them |
| **Strategies** | Ready-made and saved strategies as cards (**+ New strategy**, edit / reset built-ins); **Deploy live** on an upcoming expiry |
| **Data** | What history Upstox provides, what's cached, bulk prefetch |

## Historical data (checked against the Upstox API)

| Data | Source | Range |
| --- | --- | --- |
| Expired Nifty options, every strike, 1-minute OHLC + OI | `/v2/expired-instruments/expiries`, `/option/contract`, `/historical-candle` | ~2 years: 105 weekly + monthly expiries, 3 Oct 2024 → latest expired |
| Nifty 50 and India VIX, 1-minute | `/v3/historical-candle` | since Jan 2022 |

- **How data is fetched:** one request returns a contract's whole last month of minute candles in about 100 ms.
- **Download on demand:** backtests fetch only the contracts they need, the first time they need them.
- **Cache:** everything is saved under `bt-cache/` as gzip files and kept in memory, so re-running a 6-month backtest takes milliseconds.
- **Rate limits:** Upstox allows about 500 requests/min and 2,000 per 30 minutes. The downloader stays under both and waits when needed (the progress bar says so).
- **Data tab:** shows coverage per expiry and can prefetch a range in bulk.
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
- **New** (Backtest tab) or **+ New strategy** (Strategies tab) starts a blank strategy.
- Your own strategies save in place with **Save**; **Save as…** makes a copy.
- **Built-in strategies can be edited:** **Save** asks whether to update the built-in (it is stored as an edited copy that replaces the original everywhere, marked *edited*) or save a new strategy. **Reset to original** restores it.
- Everything lives in `bt-data/strategies.json` and appears in every tab.

## Running a backtest

- **Period:** pick it, or use the 1M / 3M / 6M / 1Y / All shortcuts.
- **Expiries** (the expiries button): test all expiries in the period, or just some. You can tick single weeks, several weeks, monthly only, weekly only, or the last 4.
- **Costs:**
  - slippage % (applied against you on every fill)
  - brokerage per order
  - STT, exchange, SEBI, stamp and GST charges
- **Capital:** leave empty to use an estimated margin for ROI.

**Scenarios (every run)**
- **Nothing runs when the Backtest tab opens.** It opens on the **Summary** tab, built from the saved backtests (`bt-data/backtests.json`): the **top 5 of the Bi-weekly Hedge** and the **top 5 of the Bi-weekly Hedge Reverse** by % profit as defined (**Show all strategies** lists the rest), with a card for the best one (investment, net P&L, % profit, trades, winners vs losers, profit vs loss, drawdown, profit factor). Strategies whose short options are not fully covered carry an "unlimited risk" tag. Click a strategy to see its saved result in **Details** and **Adjustments** without running it again.
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

## Live chain (Chain tab)

- **Top bar:** spot, ATM, PCR, the expiry and strike-range pickers, IST time, and data age and status.
- **Option chain:** calls on the left, puts on the right.
  - Bid/ask cells are tinted by order-book pressure.
  - Shading: ITM rows are shaded, ATM is gold, and a line marks spot.
  - The highest OI on each side is outlined.
  - Vol Δ shows volume added over the window picked in the chain header (1/3/5/15 min). LTP flashes when it ticks.
  - Strikes carrying a support (**S**, green) or resistance (**R**, red) level are tagged; filled tags are major levels. Hover for the source.
- **Nifty chart** (right half of the screen): candles of 1, 5, 10, 15 minutes, 1 hour, 2 hours, day, week or month, with the support / resistance levels drawn across. Drag to move, wheel to zoom, scroll back to load older candles; **Candles / Line**, **S/R** on/off, **Latest**. The hovered candle's open / high / low / close is shown at the top left; hovering a support / resistance line shows its details (major / minor, distance from Nifty, source).
  - **New window** opens the chart in its own window (`chart.html`) with the full tool set: **indicators** (SMA, EMA, Bollinger Bands, Supertrend on the price; RSI, MACD, ATR, Stochastic in their own panes; any parameters, several at once, ✕ in the legend removes one), chart types (candles, bars, Heikin Ashi, line, area), **drawings** (horizontal and trend lines; right-click one to remove it), log scale, PNG snapshot and full screen. Indicators and drawings are remembered.
  - History is read from the cached 1-minute Nifty files (`bt-cache/index`); today's candles come from the Upstox intraday endpoint (re-read every 30 s) and the last candle follows the live tick feed.
- **Support & resistance panel:** nearest major/minor resistance and support with distance from spot, and the full ladder around Nifty. Click its header to collapse it (the chart takes the space).

**Data source**
- **Tick feed:** a WebSocket feed (Upstox Market Data Feed V3) streams Nifty plus ATM ±15 strikes.
- **REST option chain:** refreshes every 15 s while the feed is live, or every `POLL_MS` if the feed is down.
- The background spike recorder (`events/<date>/`, thresholds in `.env.example`) still runs during market hours; its panels were removed from the screen.

## Support and resistance

| Class | How it is found |
| --- | --- |
| Major | swing highs/lows of daily bars over the last ~120 sessions, clustered within ~0.35%, ranked by touches and recency (a level that flipped from resistance to support counts extra), plus the range high/low |
| Minor | swing points of 15-minute bars over the last 5 sessions, clustered within ~0.12%, plus the previous day's high, low, close and floor pivots (P, R1, S1, R2, S2) |
| OI (live chain only) | the strikes with the highest and second-highest call OI (resistance) and put OI (support) |

A level below spot is support, above is resistance. Levels for a day use only earlier sessions, so backtests have no look-ahead. They are used on the Chain tab, in strategy conditions/strikes/stops, in Deploy live, and in the Builder's suggestions.

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

## Strategy Builder (Builder tab)

- **Source:** *Historical replay* (any expired expiry, start on any day of its last ~5 weeks at any time) or *Live (paper)* on an upcoming expiry (prices refresh every 5 s; entries/exits are recorded at LTP — no orders are sent).
- **Chain (left):** LTP, delta, IV (and OI live) with **B** / **S** buttons per strike, S/R tags, open-position markers. Or pick any built-in / saved strategy and **Apply** it at the current time (strike rules resolved on the chain; lots multiplier).
- **Payoff (right):** at expiry and now (T+0), spot, ±1σ and breakevens; credit/debit, max profit/loss, chance of profit, net Greeks.
- **Replaying a backtest trade (▶ Replay in the Backtest's Trades tab):** the Builder gets the trade's entry legs and everything the backtest did afterwards (roll, leg stops / targets, re-entries, partial booking, target / stop / time exit). They are listed above the suggestions as *Adjustments from the backtest* (Next / Later / Done). **▶ Step** and **⏵ Auto play** land on each one's minute, make the same trades at the backtest's prices and show an alert saying what was done and why; auto play stops when the trade is finished. The replay uses the backtest's fills (slippage included) and lot size, and the P&L header also shows the total **after costs** (the trade's brokerage and taxes), which ends on the trade's Net P&L in the backtest.
- **Saved trades:** **💾 Save trade** keeps the position in the Builder — a live paper trade or a replay — with its legs, entries and exits, log and P&L (`bt-data/paper-trades.json`). The **Trades** tab lists them all: mode, expiry, open legs, realised / open / total P&L at the last save and, for live paper trades, the total at current prices (**↻ Live P&L**). **Load** puts a trade back in the Builder with its payoff, positions and P&L; adjust it and press **Save changes** (or **Save as new…** for a copy).
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

## Files

| Path | What |
| --- | --- |
| `server.js` | HTTP server, Upstox login, live chain |
| `bt/data.js` | Historical data download, rate limiting, disk + memory cache |
| `bt/engine.js` | Backtest engine (strike selection, fills, stops, re-entry, costs, margin) |
| `bt/metrics.js` | Performance statistics |
| `bt/library.js` | Ready-made strategies |
| `bt/index.js` | Backtest API: jobs, compare, scans, saved/edited strategies, live deploy, levels, Builder data |
| `bt/levels.js` | Major / minor support and resistance |
| `bt/anomalies.js` | The 13 anomaly detectors, Black-76 / trading-time IV, suggested trades |
| `bt/histchain.js` | Rebuilds a past chain at any minute from cached candles |
| `bt/scan.js` | History scan with forward outcomes |
| `bt/conditions.js` | Signal entry conditions (anomaly, S/R, move, range) |
| `bt/biweekly.js`, `public/bw-view.js` | The Bi-weekly screen: variations of the hedge, of its reverse, and of the two as one position |
| `bt/research.js` | Online adjustment research (Claude + web search) |
| `anomaly-live.js` | Live anomaly scanner and daily log |
| `public/an-view.js` | Anomalies screen |
| `public/sb-view.js`, `public/sb-adjust.js` | Strategy Builder and its adjustment rule book |
| `public/bt-*.js`, `cmp-view.js`, `lib-view.js`, `data-view.js` | The backtest screens |
| `legacy/` | The removed Surge, Flow, Pulse, Book and Hedge screens (not loaded) |

Errors from the server and the page go to `logs/errors.log`.

This is an analysis tool, not investment advice. Backtests use historical 1-minute candles and modelled costs, so real fills, margins and liquidity will differ.
