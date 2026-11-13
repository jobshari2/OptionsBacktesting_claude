// The Terminal design (public/terminal/): its generated stylesheet is current, its text sizes are whole pixels of 12 or
// more, and the pages load the design the way public/design.js expects.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const gen = require('../tools/build-terminal-css.js');

const pub = (file) => fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8');

test('terminal-gen.css is what tools/build-terminal-css.js builds from the Classic stylesheets', () => {
  assert.equal(fs.readFileSync(gen.OUT, 'utf8'), gen.build(), 'a Classic stylesheet changed: run  node tools/build-terminal-css.js');
});

test('Classic text sizes map onto the eight steps, smallest first', () => {
  assert.deepEqual([9, 10.5, 11, 11.5, 12, 12.5, 13, 14, 14.5, 15, 16, 17, 18, 20, 21].map(gen.fsStep), [1, 1, 2, 2, 3, 3, 4, 5, 5, 6, 6, 7, 7, 8, 8]);
});

test('a rule is restated with the design tokens, and left alone when nothing in it changes', () => {
  assert.deepEqual(gen.change('font-size', '10.5px'), [['font-size', 'var(--fs-1)']]);
  assert.deepEqual(gen.change('font', '600 13px/1 system-ui, sans-serif'), [
    ['font-size', 'var(--fs-4)'],
    ['font-weight', 'var(--w-semi)'],
    ['font-family', 'var(--font-ui)'],
  ]);
  assert.deepEqual(gen.change('border-radius', '4px 4px 0 0'), [['border-radius', 'var(--r) var(--r) 0 0']]);
  assert.deepEqual(gen.change('border-radius', '50%'), []);
  assert.deepEqual(gen.change('background', 'rgba(88,166,255,.07)'), [['background', 'color-mix(in srgb, var(--accent) 7%, transparent)']]);
  assert.deepEqual(gen.change('color', '#0b1220 !important'), [['color', 'var(--on-accent) !important']]);
  assert.deepEqual(gen.change('--bg', '#0e1117'), []);
  assert.deepEqual(gen.change('padding', '4px 8px'), []);
  assert.equal(gen.scopeSelector(':root[data-theme="day"] .x, body'), ':root[data-design="terminal"][data-theme="day"] .x, :root[data-design="terminal"] body');
});

test('every text size of the Terminal design is a whole number of pixels, 12 or more', () => {
  const css = pub('terminal/terminal.css');
  const steps = [...css.matchAll(/--fs-\d:\s*([\d.]+)px/g)].map((m) => Number(m[1]));
  assert.ok(steps.length >= 32, 'four text sizes of eight steps');
  const written = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/font(?:-size)?:[^;{}]*?([\d.]+)px/g)].map((m) => Number(m[1]));
  for (const px of [...steps, ...written]) assert.ok(Number.isInteger(px) && px >= 12, `${px}px`);
});

test('the pages load design.js after the Classic stylesheets, and the sign-in page needs no other file', () => {
  for (const page of ['index.html', 'chart.html']) {
    const html = pub(page);
    assert.ok(html.indexOf('<script src="design.js">') > html.lastIndexOf('<link rel="stylesheet"'), page);
    assert.ok(html.indexOf('<script src="design.js">') < html.indexOf('</head>'), page);
  }
  assert.ok(pub('index.html').includes('<script src="terminal/terminal.js">'));
  const login = pub('login.html');
  assert.doesNotMatch(login, /<script[^>]+src=|<link[^>]+href=/, 'served before sign-in: nothing else is');
  // the keys it writes are the ones design.js reads
  const design = pub('design.js');
  for (const key of ['nifty-design', 'nifty-tm-theme', 'nifty-tm-accent', 'nifty-tm-face']) {
    assert.ok(login.includes(`'${key}'`) && design.includes(`'${key}'`), key);
  }
});
