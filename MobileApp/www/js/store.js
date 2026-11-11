// Everything the app keeps lives in this browser's localStorage under "nom.*". Storage can be missing or throw
// (private mode, cleared site data), so every access falls back to an in-memory copy and the app keeps working.
const PREFIX = 'nom.';
const memory = new Map();

function backend() {
  try {
    const s = globalThis.localStorage;
    if (!s) return null;
    s.setItem(PREFIX + '__probe', '1');
    s.removeItem(PREFIX + '__probe');
    return s;
  } catch {
    return null;
  }
}
let ls = backend();

export function get(key, fallback = null) {
  try {
    const raw = ls ? ls.getItem(PREFIX + key) : memory.get(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function set(key, value) {
  const raw = JSON.stringify(value);
  memory.set(key, raw);
  try {
    if (ls) ls.setItem(PREFIX + key, raw);
  } catch {
    // quota or a revoked permission: the in-memory copy still serves this session
  }
}

export function remove(key) {
  memory.delete(key);
  try {
    if (ls) ls.removeItem(PREFIX + key);
  } catch {}
}

export function keys() {
  const out = new Set([...memory.keys()]);
  try {
    if (ls) for (let i = 0; i < ls.length; i++) if (ls.key(i).startsWith(PREFIX)) out.add(ls.key(i).slice(PREFIX.length));
  } catch {}
  out.delete('__probe');
  return [...out];
}

export const persistent = () => Boolean(ls);

// For tests: start again with an empty in-memory store.
export function _reset(useStorage = true) {
  memory.clear();
  ls = useStorage ? backend() : null;
}

export const DEFAULT_SETTINGS = {
  source: 'demo', // 'upstox' | 'demo'
  apiKey: '',
  apiSecret: '',
  redirectUri: '', // empty = this page's own address
  refreshSec: 5,
  lotSize: 0, // 0 = the lot size Upstox reports (65 when unknown)
  slipPct: 0.5,
  brokerage: 20,
  theme: 'system', // 'system' | 'light' | 'dark'
  strikes: 10, // strikes either side of ATM on the Chain screen
};

export const settings = () => ({ ...DEFAULT_SETTINGS, ...(get('settings') || {}) });
export const saveSettings = (patch) => set('settings', { ...settings(), ...patch });
