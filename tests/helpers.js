'use strict';
/* Test harness: boots the REAL inline <script> from index.html inside a vm sandbox with
   minimal browser stubs, so tests exercise production code — not copies of it.
   Any syntax error or missing browser global breaks boot loudly (that's the point:
   a broken file must fail tests before it can reach prod).

   Usage in a test file:
     const { boot } = require('./helpers');
     const t = boot();          // fresh isolated app instance per file
     t.app.computePercent(...); // production functions
     t.app.setState(tree);      // drive global state
*/
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

function readProjectFile(name) {
  return fs.readFileSync(path.join(ROOT, name), 'utf8');
}

function inlineScript(html) {
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  if (!blocks.length) throw new Error('inline <script> not found in index.html');
  return blocks.join('\n');
}

// Appends to the production source: publishes its internals for tests. Runs in the same
// script scope, so it sees top-level let/const/function bindings directly. If the app
// renames/removes any of these, boot throws a ReferenceError — an intentional loud failure.
const EXPORT_SRC = `
;globalThis.__APP__ = {
  APP_VERSION,
  computePercent, doneCount, isLeaf, activeChildren,
  wheelPercent, wheelFilledSteps, countWheelLeaves, countWheelDone, wheelLeafFraction, isWheelLeafDone,
  ensureWheelTotals, bumpWheelTotals, wheelTotal, setWheelTotal, sanitizeEmptyChecklists,
  sanitizeGoalTree, removeChecklistItem, relocateDestPath,
  isValidGoalTree, barColor, esc, isoToday,
  normalizeUsername, isPasswordStrong,
  polarToCartesian, wedgePath, arcPath, wheelHTML,
  emptyTemplate, emptyGoals, emptySteps, leafGoals, checklistLeaf,
  protectedCountFor, minChildrenFor, collectPriorityItems,
  resolve, validatePath, loadState, saveState, sortHomeGoals,
   STRINGS, SEED, LANG_KEY, STORAGE_KEY, QUOTES,
   ensureWishMap, wishCardAt, doImportData,
   WISH_MAX_CARDS, wishMapForCloud, mergeWishMapCloud, wishMapDisplayOrder,
   ensureGoodToday, goodTodayAllEntries, goodTodayEntriesFor, goodTodayTodayEntries,
   goodTodayLastEntry, goodTodayHistoryGroups, goodTodayEntryById,
    goodTodayWeekReflectionsFor, weekStartISO, formatDateISO, formatWeekLabel, weekShiftISO,
    goodTodaySectionHTML, goodTodayHistoryHTML, goodTodayWeekHistoryHTML,
  getState: () => state,
  setState: (v) => { state = v; },
  getPath: () => path,
  setPath: (v) => { path = v; },
  offerAppUpdate,
};`;

function makeElementStub() {
  return {
    innerHTML: '',
    value: '',
    textContent: '',
    dataset: {},
    style: {},
    classList: { add() {}, remove() {}, contains: () => false },
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    getAttribute: () => null,
    appendChild() {},
    click() {},
    focus() {},
    querySelectorAll: () => [],
    querySelector: () => null,
  };
}

function boot() {
  const html = readProjectFile('index.html');
  const src = inlineScript(html);

  const store = {};
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    _raw: store,
  };
  const document = {
    getElementById: () => makeElementStub(),
    querySelectorAll: () => [],
    querySelector: () => null,
    documentElement: makeElementStub(),
    title: '',
    createElement: () => makeElementStub(),
    body: makeElementStub(),
    // Top-menu handlers bind a document-level click listener while the menu is open.
    addEventListener() {},
    removeEventListener() {},
  };
  const window = {
    addEventListener() {},
    matchMedia: () => ({ matches: false }),
    location: { reload() {} },
  };
  const navigator = { userAgent: 'node-test', standalone: false };

  const sandbox = {
    console, localStorage, document, window, navigator, setTimeout, clearTimeout,
  };
  const ctx = vm.createContext(sandbox);
  // Throws on syntax errors AND on runtime errors during initial render() — both must
  // fail the test run, never slip into prod.
  vm.runInContext(src + EXPORT_SRC, ctx, { filename: 'index-inline.js' });
  const app = vm.runInContext('globalThis.__APP__', ctx);
  return { ctx, app, html, src, localStorage, document, window };
}

/* Small builders mirroring the app's data model (leaf vs container). */
function leaf(done, opts = {}) {
  const node = { name: opts.name || 'leaf', date: '', done: !!done, children: [] };
  if (opts.archived) node.archived = true;
  if (opts.checklist !== undefined) node.checklist = opts.checklist;
  if (opts.priority) node.priority = true;
  return node;
}

function container(kids, opts = {}) {
  const node = { name: opts.name || 'container', children: kids || [] };
  if (opts.total !== undefined) node.totalGoalsAdded = opts.total;
  if (opts.archived) node.archived = true;
  return node;
}

module.exports = { boot, readProjectFile, inlineScript, leaf, container, ROOT, EXPORT_SRC };
