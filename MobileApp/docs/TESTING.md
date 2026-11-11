# Testing

All commands run in `MobileApp/`. One-time setup:

```bash
npm install
```

## Unit tests (Node, no browser)

```bash
npm test
```

21 tests over the code that runs on the phone: Black-Scholes and implied volatility, IST market hours and token expiry,
charges, chain analytics (ATM, PCR, max pain, support/resistance), the bid/ask mark, monthly expiry choice for the
collars, payoff/breakevens/extremes, collar legs, NIFTYBEES sizing, position valuation (live and expired), the collar's Live trade (P&L by structure at LTP, the move grid, NIFTYBEES cover, closed legs), Upstox reply
parsing and errors (401, offline, bad request), the login URL and token exchange, the demo market, and the store with
backup/restore.

## End-to-end tests in Android phone emulation

```bash
npm run test:e2e
```

Playwright starts `tools/serve.js` on port 8191 and runs every test twice:

| Project | Device | Screen |
| --- | --- | --- |
| `pixel-7` | Pixel 7: Android Chrome user agent, touch, DPR 2.625 | 412 × 839 |
| `galaxy-s9` | Galaxy S9+ profile, narrowed | 360 × 740 |

What they check:

- Market, Chain, Strategies, Positions and Settings render, with no sideways scrolling.
- Chain: tapping a price opens the sheet; Buy/Sell puts the leg in the Builder, which draws the payoff.
- Collars: both shapes have the right legs; saving one makes a paper position, which is valued, opened, closed, and
  survives a restart.
- Put spread collar: a strike and a price edited on New trade, Nifty and NIFTYBEES at the entry typed, saved; the
  Live trade shows the KPIs, legs, NIFTYBEES cover, line, 42-row grid and payoff; a leg is closed at a typed price;
  the whole trade is closed at typed prices and reopened.
- Settings persist across reloads.
- Upstox source with **mocked** Upstox replies (`e2e/upstox-fixture.js`): asks to log in; a bad token is rejected
  and forgotten; a good one shows live numbers; the lot size comes from Upstox.
- Upstox login return: `?code=…` is exchanged for a token on the phone; a reply with a forged `state` is ignored.
- PWA: the manifest is installable (standalone, 192 and 512 icons, maskable); the service worker takes control; the
  app starts and works **offline**.
- Offline on Upstox: the last saved prices stay on screen, marked "(saved)".
- Every test fails if the page contacts any host other than its own and `api.upstox.com`.

If Playwright's own Chromium is not downloaded, use the Edge or Chrome already installed:

```bash
PW_CHANNEL=msedge npm run test:e2e
```

(PowerShell: `$env:PW_CHANNEL='msedge'; npm run test:e2e`.) Or download Chromium once with `npx playwright install chromium`.

## Screenshots

```bash
npm run screenshots
```

This saves Pixel 7 screenshots of every screen to `docs/screenshots/`.

## Try it by hand in a desktop browser

```bash
npm run serve
```

Open <http://localhost:8080/>, press F12, and switch on the device toolbar (Ctrl+Shift+M) with a phone such as
"Pixel 7". *Application › Service workers* shows the offline cache; *Network › Offline* simulates no signal.

## On a real phone

See [INSTALL-ANDROID.md, Option D](INSTALL-ANDROID.md#option-d-from-your-pc-for-testing-only). The simplest route is a
USB cable plus `adb reverse tcp:8080 tcp:8080`. With the phone connected, Chrome on the PC at `chrome://inspect`
shows the phone's console.

## In the Android Studio emulator

This PC has no Android SDK, so the tests above use Chromium's phone emulation. With Android Studio installed:

1. *Device Manager › Create device* (for example Pixel 7, a recent Google Play image), then start it.
2. Run `npm run serve`. Inside the emulator, the PC is `10.0.2.2`, but install needs `localhost`, so run
   `adb reverse tcp:8080 tcp:8080` and open `http://localhost:8080/` in the emulator's Chrome.
3. ⋮ › **Install app**, then test from the home-screen icon.

## Before publishing

```bash
npm run check
```

This stamps the service worker, then runs the unit tests and the end-to-end tests.
