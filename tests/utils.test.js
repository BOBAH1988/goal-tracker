'use strict';
/* Pure helpers shared by the whole UI: escaping, colors, validation, ids. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, leaf, container } = require('./helpers');

const t = boot();
const { esc, barColor, isoToday, normalizeUsername, isPasswordStrong, isValidGoalTree, sortHomeGoals } = t.app;

test('esc: neutralizes HTML metacharacters', () => {
  assert.equal(esc('<b>"a"&\'b\'</b>'), '&lt;b&gt;&quot;a&quot;&amp;&#39;b&#39;&lt;/b&gt;');
  assert.equal(esc('plain'), 'plain');
  assert.equal(esc(''), '');
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
});

test('barColor: green >= 70, yellow >= 40, red below', () => {
  assert.equal(barColor(100), 'var(--green)');
  assert.equal(barColor(70), 'var(--green)');
  assert.equal(barColor(69), 'var(--yellow)');
  assert.equal(barColor(40), 'var(--yellow)');
  assert.equal(barColor(39), 'var(--red)');
  assert.equal(barColor(0), 'var(--red)');
});

test('isoToday: local YYYY-MM-DD, zero-padded', () => {
  assert.match(isoToday(), /^\d{4}-\d{2}-\d{2}$/);
});

test('normalizeUsername: trims, lowercases, collapses spaces, strips slashes', () => {
  assert.equal(normalizeUsername('  John   DOE  '), 'john doe');
  assert.equal(normalizeUsername('a/b/c'), 'a-b-c');
  assert.equal(normalizeUsername(''), '');
});

test('isPasswordStrong: min 6 chars with a letter and a digit', () => {
  assert.equal(isPasswordStrong('abc123'), true);
  assert.equal(isPasswordStrong('пароль1'), true);
  assert.equal(isPasswordStrong('12345'), false);
  assert.equal(isPasswordStrong('abcdef'), false);
  assert.equal(isPasswordStrong('ab12'), false);
});

test('isValidGoalTree: shape gate for import/sync', () => {
  assert.equal(isValidGoalTree({ name: 'x', children: [] }), true);
  assert.equal(isValidGoalTree({ name: 'x', children: 'nope' }), false);
  assert.equal(isValidGoalTree({ children: [] }), false);
  assert.equal(isValidGoalTree(null), false);
  assert.equal(isValidGoalTree('x'), false);
});

// Home goals sort dropdown (btnFilter). Each entry keeps its ORIGINAL index into the source
// array — that's what data-nav / data-drag-idx / data-delete-idx resolve against, so sorting
// must never renumber. Archived goals sink to the bottom in every mode.
function names(entries) { return Array.from(entries.map(e => e.node.name)); }
function idxs(entries) { return Array.from(entries.map(e => e.idx)); }

test('sortHomeGoals: desc orders by completion high→low, archived last, indices preserved', () => {
  const kids = [
    leaf(false, { name: 'low' }),                 // 0%
    container([leaf(true), leaf(true)], { name: 'full', total: 2 }), // 100%
    leaf(true, { name: 'done', archived: true }), // archived — must sink regardless of 100%
    container([leaf(true), leaf(false)], { name: 'half', total: 2 }), // 50%
  ];
  const out = sortHomeGoals(kids, 'desc');
  assert.deepEqual(names(out), ['full', 'half', 'low', 'done']);
  // Original indices travel with each entry (0..3 in source order), so handlers stay correct.
  assert.deepEqual(idxs(out), [1, 3, 0, 2]);
});

test('sortHomeGoals: asc orders by completion low→high, archived still last', () => {
  const kids = [
    leaf(false, { name: 'low' }),
    container([leaf(true), leaf(true)], { name: 'full', total: 2 }),
    leaf(true, { name: 'done', archived: true }),
    container([leaf(true), leaf(false)], { name: 'half', total: 2 }),
  ];
  const out = sortHomeGoals(kids, 'asc');
  assert.deepEqual(names(out), ['low', 'half', 'full', 'done']);
  assert.deepEqual(idxs(out), [0, 3, 1, 2]);
});

test('sortHomeGoals: custom keeps stored order but still sinks archived to the end', () => {
  const kids = [
    leaf(true, { name: 'a', archived: true }),
    leaf(false, { name: 'b' }),
    container([leaf(true), leaf(true)], { name: 'c', total: 2 }),
    leaf(true, { name: 'd', archived: true }),
  ];
  const out = sortHomeGoals(kids, 'custom');
  assert.deepEqual(names(out), ['b', 'c', 'a', 'd']);
  assert.deepEqual(idxs(out), [1, 2, 0, 3]);
});

test('sortHomeGoals: stable ties keep stored order (desc/asc)', () => {
  const kids = [
    leaf(false, { name: 'x0' }),
    leaf(false, { name: 'x1' }),
    leaf(false, { name: 'x2' }),
  ];
  assert.deepEqual(names(sortHomeGoals(kids, 'desc')), ['x0', 'x1', 'x2']);
  assert.deepEqual(names(sortHomeGoals(kids, 'asc')), ['x0', 'x1', 'x2']);
});

test('sortHomeGoals: unknown mode falls back to stored (custom) order', () => {
  const kids = [leaf(false, { name: 'a' }), leaf(true, { name: 'b' })];
  assert.deepEqual(names(sortHomeGoals(kids, 'nonsense')), ['a', 'b']);
});
