// Builds public/terminal/terminal-gen.css: the part of the Terminal design that is derived from the Classic stylesheets.
//
// The Terminal design (public/terminal/) keeps every screen's markup and layout rules and re-dresses them. Three things
// in the Classic stylesheets are spread over hundreds of rules and cannot be changed from one place, so this script reads
// each rule and writes an override for it, scoped to the Terminal design:
//
//   text sizes    9 - 21 px, many of them fractional (10.5, 11.5, 12.5), become eight whole-pixel steps (--fs-1 .. --fs-8)
//                 that the Terminal's text-size setting moves together; nothing is drawn under 12 px
//   corners       rounded corners become the Terminal's square ones (--r); circles (50 %) stay
//   colours       colours written out for the Night theme (rgba(88,166,255,.07), #3fb68b ...) become the design's tokens,
//                 so tints follow the palette picked (Amber, Graphite, Paper)
//   weights       500 / 600 follow the typeface picked (--w-med, --w-semi): Tahoma has no semibold, Bahnschrift has every weight
//
// Run it after changing any stylesheet in SOURCES:   node tools/build-terminal-css.js
// test/terminal-css.test.js fails when the file on disk is not what this script builds.
const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'public');
const OUT = path.join(PUBLIC, 'terminal', 'terminal-gen.css');
const SOURCES = ['styles.css', 'live.css', 'hedge.css', 'bt.css', 'ideas.css', 'kite.css', 'cc.css', 'lab.css', 'adj.css', 'themes.css'];
const SCOPE = ':root[data-design="terminal"]';

// Classic px -> the step of the Terminal's type scale (the px of each step are set in terminal.css, per text size).
function fsStep(px) {
  if (px <= 10.5) return 1;
  if (px <= 11.5) return 2;
  if (px <= 12.5) return 3;
  if (px <= 13) return 4;
  if (px <= 14.5) return 5;
  if (px <= 16) return 6;
  if (px <= 18) return 7;
  return 8;
}

// Night-theme colours written out in the stylesheets -> the token they stand for.
const RGB_TOKENS = {
  '88,166,255': '--accent',
  '63,182,139': '--up',
  '240,113,107': '--down',
  '214,175,76': '--atm',
  '42,49,60': '--line',
  '230,237,243': '--text',
  '139,148,158': '--muted',
  '163,113,247': '--violet',
  '179,146,240': '--violet',
  '86,212,221': '--cyan',
};
const HEX_TOKENS = {
  '#3fb68b': '--up',
  '#f0616d': '--down',
  '#f0716b': '--down',
  '#0b1220': '--on-accent',
  '#111': '--on-atm',
  '#58a6ff': '--accent',
  '#e3b341': '--atm',
  '#d6af4c': '--atm',
  '#d9a000': '--atm',
  '#b392f0': '--violet',
  '#56d4dd': '--cyan',
  '#e6edf3': '--text',
  '#8b949e': '--muted',
  '#2a313c': '--line',
  '#3a4452': '--line',
  '#1c222b': '--panel-2',
  '#161b22': '--panel',
  '#0e1117': '--bg',
  '#0d1117': '--bg',
  '#c43f3a': '--pe-mark',
  '#2fa77a': '--ce-mark',
};

// ---------- a small CSS reader: rules, and the rules inside @media / @supports ----------
function parse(css) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let i = 0;
  function skipBlock() {
    for (let depth = 1; i < css.length && depth; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
    }
  }
  function block() {
    const out = [];
    while (i < css.length) {
      let j = i;
      while (j < css.length && css[j] !== '{' && css[j] !== '}') j++;
      if (j >= css.length) break;
      if (css[j] === '}') {
        i = j + 1;
        return out;
      }
      const prelude = css.slice(i, j).trim().replace(/\s+/g, ' ');
      i = j + 1;
      if (/^@(media|supports)\b/.test(prelude)) out.push({ at: prelude, children: block() });
      else if (prelude.startsWith('@'))
        skipBlock(); // @keyframes, @font-face: left as they are
      else {
        const k = css.indexOf('}', i);
        out.push({ sel: prelude, body: css.slice(i, k) });
        i = k + 1;
      }
    }
    return out;
  }
  return block();
}

// s split at sep, outside brackets and quotes.
function splitTop(s, sep) {
  const out = [];
  let depth = 0;
  let quote = '';
  let cur = '';
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === sep && !depth) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function scopeSelector(sel) {
  return splitTop(sel, ',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (/^:root(?![\w-])/.test(s) ? SCOPE + s.slice(5) : /^html(?![\w-])/.test(s) ? SCOPE + s.slice(4) : `${SCOPE} ${s}`))
    .join(', ');
}

// ---------- the changes ----------
const mix = (token, alpha) => (alpha >= 1 ? `var(${token})` : `color-mix(in srgb, var(${token}) ${Math.round(alpha * 1000) / 10}%, transparent)`);

function colours(val) {
  return val
    .replace(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/g, (m, r, g, b, a) => {
      const token = RGB_TOKENS[`${r},${g},${b}`];
      return token ? mix(token, a === undefined ? 1 : Number(a)) : m;
    })
    .replace(/#[0-9a-fA-F]{3,8}(?![0-9a-zA-Z])/g, (m) => (HEX_TOKENS[m.toLowerCase()] ? `var(${HEX_TOKENS[m.toLowerCase()]})` : m));
}

const weightToken = (w) => (w === '500' ? 'var(--w-med)' : w === '600' || w === '650' ? 'var(--w-semi)' : null);
const familyToken = (f) => (/inherit/.test(f) ? null : /monospace/.test(f) ? 'var(--font-mono)' : 'var(--font-ui)');

// One declaration -> the declarations that replace it in the Terminal design ([] = leave it alone).
function change(prop, val) {
  const important = /!important\s*$/.test(val) ? ' !important' : '';
  const v = val.replace(/\s*!important\s*$/, '').trim();
  if (prop.startsWith('--')) return []; // the themes' own tokens
  if (prop === 'font-size') {
    const m = v.match(/^([\d.]+)px$/);
    return m ? [['font-size', `var(--fs-${fsStep(Number(m[1]))})${important}`]] : [];
  }
  if (prop === 'font') {
    const m = v.match(/^(?:(\d{3})\s+)?([\d.]+)px(?:\/[\d.a-z%]+)?\s*(.*)$/);
    if (!m) return [];
    const out = [['font-size', `var(--fs-${fsStep(Number(m[2]))})${important}`]];
    if (m[1] && weightToken(m[1])) out.push(['font-weight', weightToken(m[1]) + important]);
    if (m[3] && familyToken(m[3])) out.push(['font-family', familyToken(m[3]) + important]);
    return out;
  }
  if (prop === 'font-family') return familyToken(v) ? [['font-family', familyToken(v) + important]] : [];
  if (prop === 'font-weight') return weightToken(v) ? [['font-weight', weightToken(v) + important]] : [];
  if (/^border(-[a-z]+)*-radius$/.test(prop)) {
    const next = v.replace(/([\d.]+)px/g, (m, n) => (Number(n) > 2 ? 'var(--r)' : m));
    return next !== v ? [[prop, next + important]] : [];
  }
  const next = colours(v);
  return next !== v ? [[prop, next + important]] : [];
}

function overrides(nodes, indent = '') {
  const lines = [];
  for (const n of nodes) {
    if (n.at) {
      const inner = overrides(n.children, indent + '  ');
      if (inner.length) lines.push(`${indent}${n.at} {`, ...inner, `${indent}}`);
      continue;
    }
    const decls = [];
    for (const d of splitTop(n.body, ';')) {
      const c = d.indexOf(':');
      if (c < 0) continue;
      for (const [p, v] of change(d.slice(0, c).trim().toLowerCase(), d.slice(c + 1).trim())) decls.push(`${p}: ${v};`);
    }
    if (decls.length) lines.push(`${indent}${scopeSelector(n.sel)} { ${decls.join(' ')} }`);
  }
  return lines;
}

function build() {
  const out = [
    '/* GENERATED by tools/build-terminal-css.js from the Classic stylesheets. Do not edit: change the stylesheet or the',
    '   script and run it again. Text sizes, corners, weights and written-out colours of every Classic rule, restated',
    "   with the Terminal design's tokens (see terminal.css for the tokens and everything written by hand). */",
  ];
  for (const file of SOURCES) {
    const lines = overrides(parse(fs.readFileSync(path.join(PUBLIC, file), 'utf8')));
    if (lines.length) out.push('', `/* ---------- ${file} ---------- */`, ...lines);
  }
  return out.join('\n') + '\n';
}

module.exports = { build, OUT, SOURCES, fsStep, change, scopeSelector };

if (require.main === module) {
  const css = build();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, css);
  console.log(`${path.relative(process.cwd(), OUT)}: ${css.split('\n').length} lines`);
}
