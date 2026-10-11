// Prints a Markdown table of the unit-test coverage from the lcov file `npm run test:ci` writes.
// The pipelines show it on the run's summary page.   usage: node ci/coverage-summary.js reports/coverage.lcov
const fs = require('fs');

const file = process.argv[2] || 'reports/coverage.lcov';
const KEYS = { LF: 'lines', LH: 'linesHit', BRF: 'branches', BRH: 'branchesHit', FNF: 'funcs', FNH: 'funcsHit' };
const blank = () => ({ lines: 0, linesHit: 0, branches: 0, branchesHit: 0, funcs: 0, funcsHit: 0 });

const files = [];
let cur = null;
for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
  const i = line.indexOf(':');
  const tag = i < 0 ? line : line.slice(0, i);
  if (tag === 'SF') files.push((cur = { name: line.slice(i + 1).replace(/\\/g, '/'), ...blank() }));
  else if (cur && KEYS[tag]) cur[KEYS[tag]] += Number(line.slice(i + 1));
}

const total = blank();
for (const f of files) for (const k of Object.keys(total)) total[k] += f[k];

const pct = (hit, all) => (all ? ((100 * hit) / all).toFixed(1) + '%' : '–');
const row = (name, c) => `| ${name} | ${pct(c.linesHit, c.lines)} | ${pct(c.branchesHit, c.branches)} | ${pct(c.funcsHit, c.funcs)} |`;

console.log('### Unit test coverage\n');
console.log('Files the tests load; a file no test loads is not listed.\n');
console.log('| File | Lines | Branches | Functions |');
console.log('| --- | ---: | ---: | ---: |');
console.log(row('**All files**', total));
for (const f of files.sort((a, b) => a.name.localeCompare(b.name))) console.log(row(f.name, f));
