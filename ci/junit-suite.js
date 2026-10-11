// Node's JUnit reporter writes tests that are not inside a describe() straight under <testsuites>.
// Azure Pipelines' "Publish Test Results" only reads tests inside a <testsuite>, so this puts them in one.
// usage: node ci/junit-suite.js reports/junit.xml
const fs = require('fs');

const file = process.argv[2] || 'reports/junit.xml';
const xml = fs.readFileSync(file, 'utf8');
const m = xml.match(/^([\s\S]*?<testsuites[^>]*>)([\s\S]*)(<\/testsuites>\s*)$/);
if (!m) {
  console.error(`${file}: no <testsuites> element found`);
  process.exit(1);
}
if (/<testsuite[\s>]/.test(m[2])) {
  console.log(`${file}: already has test suites, left as it is`);
} else {
  const count = (re) => (m[2].match(re) || []).length;
  const attrs = `name="Unit tests" tests="${count(/<testcase[\s>]/g)}" failures="${count(/<failure[\s>]/g)}" skipped="${count(/<skipped[\s/>]/g)}"`;
  fs.writeFileSync(file, `${m[1]}\n<testsuite ${attrs}>${m[2]}</testsuite>\n${m[3]}`);
  console.log(`${file}: wrapped ${count(/<testcase[\s>]/g)} tests in one test suite`);
}
