# Nifty Options Mobile — design

## 1. Goal and constraints

Use the Nifty options portal from an Android phone.

| Constraint (from the request) | What it means for the design |
| --- | --- |
| Android phone | Chrome on Android is the runtime. The app must be usable one-handed on a ~390 px wide screen. |
| Not a native app | No Kotlin/Java, no Android Studio project. The app is written in HTML/CSS/JavaScript. |
| No server except Upstox or Zerodha | All logic runs on the phone. The phone talks to `api.upstox.com` and nothing else. No backend, no proxy, no database server. |
| Isolated, self-sustaining, in `MobileApp/` | Nothing in `MobileApp/` imports from the rest of the repository, and the rest of the repository does not import from it. It has its own `package.json`, its own tests, and its own docs. It can be copied into its own Git repository and work as-is. |

## 2. Decision: an installable Progressive Web App (PWA)

A PWA is a web page that Chrome on Android can install onto the home screen. It then opens full-screen with its own
icon, like an app, and runs from files cached on the phone.

Options compared:

| Option | Native code? | Needs a server of ours? | Can call Upstox? | Can call Kite? | Verdict |
| --- | --- | --- | --- | --- | --- |
| **PWA (chosen)** | No | No. The files are downloaded once from any static host, then run from the phone's cache. | **Yes**: Upstox sends CORS headers (`access-control-allow-origin: *` on data, the caller's origin on the token exchange). Checked on 2026-11-11. | **No**: `api.kite.trade` sends no CORS headers, so a browser may not read its replies. | Fits every constraint. |
| Thin client of the desktop portal | No | **Yes**: the PC portal must be running and reachable | through the portal | through the portal | Breaks "no server". |
| Capacitor / Cordova hybrid APK | A generated Android shell (no hand-written native code) | No | Yes | Yes, through the native HTTP plugin, which is not subject to CORS | Possible later for Kite (section 9). Needs Android Studio and the SDK to build. |
| Native Kotlin app | Yes | No | Yes | Yes | Ruled out by the request. |

**Zerodha Kite is not supported by the PWA.** Kite Connect's REST API does not allow browser (cross-origin) calls,
and a PWA has no way around that without a proxy server, which the request rules out. Upstox gives the same market
data (chain, quotes, candles), so the app uses Upstox only. Section 9 describes the route to Kite if it is ever needed.

## 3. Architecture

```
 Android phone ──────────────────────────────────────────────────────────────┐
 │  Chrome (installed PWA, standalone window)                                │
 │  ┌──────────────┐   ┌───────────────────────────────────────────────┐     │
 │  │ Service      │   │ App (ES modules)                              │     │
 │  │ worker       │   │  views/  Market · Chain · Strategies ·        │     │
 │  │ sw.js        │   │          Positions · Settings                 │     │
 │  │ caches the   │   │  market.js  one data API, two sources:        │     │
 │  │ app files    │   │     upstox.js (real)  ·  demo.js (simulated)  │     │
 │  │ offline      │   │  analytics.js  bs.js  strategy.js  costs.js   │     │
 │  └──────────────┘   │  store.js  localStorage (settings, token,     │     │
 │                     │            paper positions, last quotes)      │     │
 │                     └──────────────────────┬────────────────────────┘     │
 └────────────────────────────────────────────┼──────────────────────────────┘
                                              │ HTTPS, Bearer token
                                              ▼
                                      api.upstox.com (only)
```

- **Hosting is only a delivery step.** The files in `www/` are static. They are put on any static HTTPS host once
  (GitHub Pages is the documented default; Netlify Drop or Cloudflare Pages also work). Chrome downloads them, the
  service worker caches them, and from then on the app starts from the phone even with no connection to the host.
  The host never sees market data or the token. A new version reaches the phone when the host's files change.
- **No build step.** Plain ES modules, no framework, no bundler, no runtime dependencies. What is in `www/` is
  exactly what runs on the phone.
- **Two data sources behind one interface** (`js/market.js`): `upstox` (real) and `demo` (a simulated market, so the
  app can be tried and tested with no account and no network).

## 4. Screens

Bottom tab bar, five tabs. Every screen works in portrait at 360–430 px width, uses system dark/light theme, and has
touch targets of at least 44 px.

| Tab | What it shows | Source of the numbers |
| --- | --- | --- |
| **Market** | Nifty 50 (last, change, day range), India VIX, NIFTYBEES, intraday Nifty chart (5-minute), market open/closed (IST). Snapshot of the nearest expiry: ATM, ATM straddle, implied move to expiry, PCR (OI), max pain, support (highest put OI) and resistance (highest call OI). | Upstox `/v2/market-quote/quotes`, `/v3/historical-candle/intraday`, `/v2/option/chain` |
| **Chain** | Expiry picker, strikes around ATM (±N, adjustable): call and put LTP, change, OI, change in OI, IV, with OI bars and ATM marked. Tap a price → add that option (Buy / Sell) to the Builder. | `/v2/option/contract` (expiries, lot size), `/v2/option/chain` |
| **Strategies** | **Collars**: Put spread collar (NIFTYBEES + sell CE ATM+100 + buy PE ATM−100 + sell PE ATM−200) and Bull put collar (NIFTYBEES + sell CE ATM+100 + sell PE ATM−100 + buy PE ATM−200), the same legs as the desktop portal's Trading Ideas. Live legs at bid/ask mid, net credit/debit, NIFTYBEES units for one lot's worth, charges, payoff at expiry (options, ETF, total), max profit/loss over ±10 %, breakevens. Offsets, lots and expiry are editable. **Builder**: any legs picked from the chain; payoff at expiry and today (Black-Scholes at each leg's IV), Greeks, max P/L, breakevens. Both can be saved as a paper position. | Chain + quotes; payoff and Greeks computed on the phone |
| **Positions** | Paper positions saved on the phone: live mark-to-market (legs at bid/ask mid, NIFTYBEES at LTP), P&L after estimated charges, days to expiry, payoff with today's Nifty marked; close (books exit prices), rename, delete. Closed positions keep their realised P&L. | Chain of each position's expiry |
| **Settings** | Data source (Upstox / Demo). Upstox: API key, secret, redirect URL, **Log in with Upstox**, or paste a token; token status. Refresh interval. Lot size override, slippage %, brokerage per order. Theme. Backup (export / import JSON), reset. App version and update. | — |

The app places **no orders**. It shows numbers and keeps paper positions. (The desktop portal also removed live
orders; ordering stays on the broker's own app.)

## 5. Upstox sign-in on the phone

Upstox access tokens expire at about 03:30 IST every day, so sign-in is a daily step. Two ways, both on the phone:

1. **Log in with Upstox (OAuth).** The user creates an Upstox developer app whose Redirect URL is the app's own URL
   (for example `https://<user>.github.io/nifty-mobile/`). Settings stores the API key and secret on the phone.
   The button opens Upstox's login page; Upstox sends the browser back to the app with `?code=…`; the app exchanges
   the code for a token with `POST /v2/login/authorization/token` (allowed cross-origin, checked) and removes the code
   from the address bar.
2. **Paste a token.** Any valid Upstox access token (for example the desktop portal's `UPSTOX_ACCESS_TOKEN`).

A separate Upstox app for the phone is recommended, so the phone's daily login never disturbs the desktop
portal's token. The API secret is kept only in this browser's storage on the phone; the paste-a-token route avoids
storing it at all.

## 6. Data and storage

`localStorage`, namespaced `nom.*`, every access wrapped in try/catch (private mode and cleared storage must not
break the app):

| Key | Content |
| --- | --- |
| `nom.settings` | data source, Upstox key/secret/redirect, refresh seconds, lot size override, slippage, brokerage, theme, strikes shown |
| `nom.token` | `{ token, savedAt, expiresAt }` (expires 03:30 IST the next day) |
| `nom.positions` | paper positions `[{ id, name, kind, createdAt, expiry, lotSize, legs[], bees, status, exit }]` |
| `nom.builder` | Builder legs in progress |
| `nom.cache.*` | last quotes and chain per expiry, shown with their time when the network is down |

Nothing leaves the phone except the requests to Upstox. Backup is a JSON file the user exports and imports.

**Refresh.** Only while the app is visible (`visibilitychange`), every 5 s by default during market hours
(09:15–15:30 IST, Monday–Friday) and every 60 s outside them. Upstox allows 50 requests a second; one refresh is
2–3 requests.

## 7. Calculations (all on the phone)

- **Charges**: the desktop portal's schedule (STT, NSE transaction charge, SEBI fee, stamp duty, GST, ₹20 per
  order), copied into `js/costs.js` (not imported, to keep the app isolated). Slippage default 0.5 % of premium.
- **Payoff at expiry**: Σ side × lots × lot size × (intrinsic − entry). NIFTYBEES is modelled as moving with Nifty
  (units × entry price × S / S₀).
- **Payoff today and Greeks**: Black-Scholes on Nifty spot, r = 6.5 %, no dividend, each leg's IV from the chain
  (an implied vol solved from its price when the chain has none), time to 15:30 IST on expiry.
- **Max profit / loss**: over a Nifty grid of ±10 % (collars) or ±15 % (Builder); "unlimited" when the outermost
  slope is not flat.
- **Chain analytics**: ATM = strike nearest spot; PCR = Σ put OI / Σ call OI; max pain = strike minimising the
  option writers' payout; implied move = ATM straddle × 0.85 (approximation, labelled as such).

## 8. Quality

- **Unit tests** (`node --test`): Black-Scholes and IV, payoff and breakevens, collar legs, chain analytics,
  charges, IST time helpers, Upstox reply parsing.
- **End-to-end tests** (Playwright) in **Android phone emulation** (Pixel 7: 412×839 viewport, Android Chrome user
  agent, touch, device-pixel-ratio 2.625, plus a 360 px wide phone) on the demo source: every tab renders, a collar is saved as a paper position,
  the Builder takes a leg from the chain, settings persist, the service worker installs and the app reloads offline,
  the manifest is installable.
- No Android emulator is installed on the development PC (no Android SDK), so the phone is emulated in Chromium.
  `docs/TESTING.md` also explains how to test on a real phone over Wi-Fi and with the Android Studio emulator.

## 9. Kite later, if needed

Kite's REST API cannot be called from a browser. Two routes that keep "no server of ours":

1. Wrap this same `www/` folder with **Capacitor** (`npx cap add android`) and route Kite calls through
   `CapacitorHttp`, which uses Android's HTTP stack and is not subject to CORS. This produces an APK and needs
   Android Studio to build, but no hand-written native code. The data layer already isolates the source
   (`js/market.js`), so a `kite.js` source would slot in next to `upstox.js`.
2. Stay on Upstox (current design).
