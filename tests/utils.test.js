'use strict';
/* Pure helpers shared by the whole UI: escaping, colors, validation, ids. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers');

const t = boot();
const { esc, barColor, isoToday, normalizeUsername, isPasswordStrong, isValidGoalTree } = t.app;

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
