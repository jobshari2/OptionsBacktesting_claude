// ESLint looks for real mistakes only (undefined names, unused code, unreachable branches). Formatting is Prettier's job.
const js = require('@eslint/js');
const globals = require('globals');
const prettier = require('eslint-config-prettier');
const { defineConfig, globalIgnores } = require('eslint/config');

module.exports = defineConfig([
  globalIgnores([
    'node_modules/',
    'bt-cache/',
    'bt-data/',
    'events/',
    'events-demo/',
    'hedge-cache/',
    'logs/',
    'replays/',
    'reports/',
    'playwright-report/',
    'test-results/',
  ]),
  {
    files: ['**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'commonjs', globals: globals.node },
    rules: {
      // `try { ... } catch {}` is used on purpose for best-effort work (deleting a temp file, parsing a partial line)
      'no-empty': ['error', { allowEmptyCatch: true }],
      // `const { omitted, ...rest } = o` is how a key is dropped from an object here
      'no-unused-vars': ['error', { caughtErrors: 'none', ignoreRestSiblings: true }],
      // `let rows = []; try { rows = read(); } catch { return []; }` states the type up front; that is not a mistake
      'no-useless-assignment': 'off',
    },
  },
  {
    // The page's scripts are plain <script> files. They share code through these namespaces on `window`
    // (bt-common.js, bt-view.js, bw-view.js, sb-adjust.js, /lib/costs.js) and use Chart.js from /vendor/chart.js.
    files: ['public/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        ...globals.browser,
        BT: 'readonly',
        BTView: 'readonly',
        BWView: 'readonly',
        SBAdjust: 'readonly',
        Costs: 'readonly',
        Chart: 'readonly',
      },
    },
    rules: {
      // app.js has its own reportError(), which replaces the browser's built-in of that name
      'no-redeclare': ['error', { builtinGlobals: false }],
    },
  },
  {
    // Loaded by the server with require() and by the page as /lib/*.js
    files: ['lib/pricing.js', 'lib/costs.js'],
    languageOptions: { globals: { self: 'readonly' } },
  },
  {
    // Playwright tests: functions passed to page.evaluate() run in the browser
    files: ['e2e/**/*.js'],
    languageOptions: { globals: globals.browser },
  },
  prettier,
]);
