const test = require('node:test');
const assert = require('node:assert/strict');
const { createAuth } = require('../lib/auth');

const req = (headers = {}) => ({ headers, socket: { remoteAddress: '1.2.3.4' } });
const env = { AUTH_USERNAME: 'trader', AUTH_PASSWORD: 's3cret' };
const cookieOf = (setCookie) => setCookie.split(';')[0];

test('sign-in is off unless both username and password are set', () => {
  assert.equal(createAuth({}).enabled, false);
  assert.equal(createAuth({ AUTH_USERNAME: 'a' }).enabled, false);
  assert.equal(createAuth({}).isAuthed(req()), true);
  assert.equal(createAuth(env).enabled, true);
});

test('a request is refused until it signs in', () => {
  const a = createAuth(env);
  assert.equal(a.isAuthed(req()), false);
  assert.equal(a.login(req(), 'trader', 'wrong').ok, false);
  const r = a.login(req(), 'trader', 's3cret');
  assert.equal(r.ok, true);
  assert.match(r.cookie, /HttpOnly/);
  assert.equal(a.isAuthed(req({ cookie: cookieOf(r.cookie) })), true);
  assert.equal(a.isAuthed(req({ cookie: 'nifty_session=forged' })), false);
});

test('signing out ends the session', () => {
  const a = createAuth(env);
  const c = cookieOf(a.login(req(), 'trader', 's3cret').cookie);
  a.logout(req({ cookie: c }));
  assert.equal(a.isAuthed(req({ cookie: c })), false);
});

test('a session expires', () => {
  let t = 0;
  const a = createAuth({ ...env, AUTH_SESSION_HOURS: '1' }, () => t);
  const c = cookieOf(a.login(req(), 'trader', 's3cret').cookie);
  assert.equal(a.isAuthed(req({ cookie: c })), true);
  t = 3_600_001;
  assert.equal(a.isAuthed(req({ cookie: c })), false);
});

test('an HTTP Basic header signs a request in', () => {
  const a = createAuth(env);
  const h = (s) => ({ authorization: 'Basic ' + Buffer.from(s).toString('base64') });
  assert.equal(a.isAuthed(req(h('trader:s3cret'))), true);
  assert.equal(a.isAuthed(req(h('trader:nope'))), false);
  assert.equal(a.isAuthed(req(h('nocolon'))), false);
});

test('repeated wrong passwords lock the address out for a minute', () => {
  let t = 0;
  const a = createAuth(env, () => t);
  for (let i = 0; i < 5; i++) assert.equal(a.login(req(), 'trader', 'x').status, 401);
  assert.equal(a.login(req(), 'trader', 's3cret').status, 429); // even the right password
  t = 60_001;
  assert.equal(a.login(req(), 'trader', 's3cret').ok, true);
});
