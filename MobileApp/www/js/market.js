// The one data interface the screens use. Two sources behind it: the Upstox client (real) and the demo market.
// Results are shared for a moment (so two screens refreshing together make one request) and the last good answer is
// kept on the phone, so the screens can show it (with its time) while the network is down.
import { createUpstox, NIFTY, VIX, BEES } from './upstox.js';
import { createDemo } from './demo.js';
import * as store from './store.js';
import { tokenExpiry } from './time.js';

export { NIFTY, VIX, BEES };

export function getToken() {
  const t = store.get('token');
  if (!t?.token) return null;
  if (t.expiresAt && Date.now() >= t.expiresAt) return null;
  return t.token;
}

export function saveToken(token, user = '') {
  store.set('token', { token: token.trim(), user, savedAt: Date.now(), expiresAt: tokenExpiry() });
}

export function tokenInfo() {
  const t = store.get('token');
  if (!t?.token) return { state: 'none' };
  if (t.expiresAt && Date.now() >= t.expiresAt) return { state: 'expired', ...t };
  return { state: 'valid', ...t };
}

export function createMarket({ now = () => Date.now(), fetchImpl } = {}) {
  let unauthorized = () => {};
  const upstox = createUpstox({ getToken, fetchImpl, onUnauthorized: () => unauthorized() });
  const demo = createDemo({ now });
  const inflight = new Map();
  const TTL = 1500;

  const source = () => store.settings().source;
  const api = () => (source() === 'demo' ? demo : upstox);

  // Shares one request among callers for TTL ms; keeps the last good result under nom.cache.<name>.
  async function cached(name, fn) {
    const key = source() + ':' + name;
    const hit = inflight.get(key);
    if (hit && now() - hit.at < TTL) return hit.p;
    const p = fn().then(
      (data) => {
        store.set('cache.' + key, { at: now(), data });
        return { data, at: now(), stale: false };
      },
      (err) => {
        const last = store.get('cache.' + key);
        if (last) return { data: last.data, at: last.at, stale: true, error: err };
        throw err;
      },
    );
    inflight.set(key, { at: now(), p });
    p.catch(() => inflight.delete(key));
    return p;
  }

  return {
    source,
    onUnauthorized: (fn) => (unauthorized = fn),
    quotes: () => cached('quotes', () => api().quotes([NIFTY, VIX, BEES])),
    contracts: () => cached('contracts', () => api().contracts()),
    chain: (expiry) => cached('chain.' + expiry, () => api().chain(expiry)),
    intraday: () => cached('intraday', () => api().intraday(NIFTY, 5)),
    // Lot size: the setting when given, else what Upstox reports, else 65.
    lotSize: (reported) => store.settings().lotSize || reported || 65,
  };
}
