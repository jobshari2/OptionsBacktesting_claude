// Basic authentication: one username and password from the .env file (AUTH_USERNAME, AUTH_PASSWORD).
// The page signs in at /login.html, which sets a session cookie; scripts can send an HTTP Basic header instead.
// With either variable missing, authentication is off (and the server says so at start-up).
const crypto = require('crypto');

const COOKIE = 'nifty_session';
const LOGIN_PAGE = '/login.html';
const MAX_FAILS = 5; // wrong passwords from one address before it is locked out for LOCK_MS
const LOCK_MS = 60_000;

// SHA-256 first, so the comparison takes the same time whatever the lengths are.
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const same = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

function createAuth(env, now = Date.now) {
  const user = env.AUTH_USERNAME || '';
  const pass = env.AUTH_PASSWORD || '';
  const enabled = Boolean(user && pass);
  const ttlMs = Math.max(0.1, Number(env.AUTH_SESSION_HOURS) || 12) * 3_600_000;
  const sessions = new Map(); // token -> expiry (ms)
  const fails = new Map(); // address -> { n, until }

  const check = (u, p) => [same(u, user), same(p, pass)].every(Boolean); // both are compared, no early exit

  function cookies(req) {
    const out = {};
    for (const part of String(req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
  }

  function basicHeader(req) {
    const m = String(req.headers.authorization || '').match(/^Basic\s+(.+)$/i);
    if (!m) return false;
    const s = Buffer.from(m[1], 'base64').toString('utf8');
    const i = s.indexOf(':');
    return i >= 0 && check(s.slice(0, i), s.slice(i + 1));
  }

  function sessionOk(req) {
    const t = cookies(req)[COOKIE];
    const exp = t && sessions.get(t);
    if (!exp) return false;
    if (exp < now()) {
      sessions.delete(t);
      return false;
    }
    return true;
  }

  // Is this request signed in? (Always true while authentication is off.)
  const isAuthed = (req) => !enabled || sessionOk(req) || basicHeader(req);

  const cookieAttrs = (req, maxAgeS) =>
    `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}` + (req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted ? '; Secure' : '');

  // Returns { ok, cookie } or { ok: false, status, error }.
  function login(req, u, p) {
    const addr = req.socket.remoteAddress || '';
    const f = fails.get(addr);
    if (f && f.until > now()) return { ok: false, status: 429, error: 'Too many attempts. Try again in a minute.' };
    if (!check(u, p)) {
      const n = (f && f.n < MAX_FAILS ? f.n : 0) + 1; // a lockout that has run out starts the count again
      fails.set(addr, { n, until: n >= MAX_FAILS ? now() + LOCK_MS : 0 });
      return { ok: false, status: 401, error: 'Wrong username or password' };
    }
    fails.delete(addr);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, now() + ttlMs);
    for (const [t, exp] of sessions) if (exp < now()) sessions.delete(t);
    return { ok: true, cookie: `${COOKIE}=${token}; ${cookieAttrs(req, Math.round(ttlMs / 1000))}` };
  }

  function logout(req) {
    const t = cookies(req)[COOKIE];
    if (t) sessions.delete(t);
    return `${COOKIE}=; ${cookieAttrs(req, 0)}`;
  }

  return { enabled, user, isAuthed, login, logout, LOGIN_PAGE };
}

module.exports = { createAuth, LOGIN_PAGE };
