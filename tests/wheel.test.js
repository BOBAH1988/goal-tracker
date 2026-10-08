'use strict';
/* Balance wheel (sticky engine): percent = 100 * (1 - incomplete / totalGoalsAdded).
   Unit = active leaf goal at any depth. Containers and checklist items are never units.
   totalGoalsAdded never shrinks on delete/archive — only relocate moves it between spheres. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, leaf, container } = require('./helpers');

const t = boot();
const {
  wheelPercent, wheelFilledSteps, countWheelLeaves, isWheelLeafDone,
  ensureWheelTotals, bumpWheelTotals, setWheelTotal,
} = t.app;

const leaves = (n, doneCount) =>
  Array.from({ length: n }, (_, i) => leaf(i < doneCount));

test('spec examples: the eight canonical cases', () => {
  assert.equal(wheelPercent(container([], { total: 0 })), 100, 'no goals → 100');
  assert.equal(wheelPercent(container(leaves(5, 0), { total: 5 })), 0, '5 open → 0');
  assert.equal(wheelPercent(container(leaves(5, 1), { total: 5 })), 20, '1 of 5 → 20');
  assert.equal(wheelPercent(container(leaves(5, 3), { total: 5 })), 60, '3 of 5 → 60');
  assert.equal(wheelPercent(container(leaves(5, 5), { total: 5 })), 100, 'all done → 100');
  // 3 done deleted: 2 open remain, sticky total stays 5 → 60 (must NOT collapse to 0).
  assert.equal(wheelPercent(container(leaves(2, 0), { total: 5 })), 60);
  // All done deleted: nothing open, sticky total 5 → 100.
  assert.equal(wheelPercent(container([], { total: 5 })), 100);
  assert.equal(wheelPercent(container(leaves(5, 2), { total: 5 })), 40, '2 done + 3 open → 40');
});

test('deleting a done goal never lowers the sector; deleting an open goal raises it', () => {
  const before = container(leaves(5, 3), { total: 5 }); // 60%
  assert.equal(wheelPercent(before), 60);
  // Delete 1 done: total stays 5, open stays 2 → still 60 (was 50 under naive averaging).
  assert.equal(wheelPercent(container(leaves(4, 2), { total: 5 })), 60);
  // Delete 1 open: total stays 5, open drops to 1 → 80.
  assert.equal(wheelPercent(container(leaves(4, 3), { total: 5 })), 80);
});

test('nesting: only leaves count, at any depth', () => {
  const nested = container(
    [container(leaves(2, 2)), container([container(leaves(3, 1))])],
    { total: 5 }
  );
  assert.equal(countWheelLeaves(nested, false), 5);
  assert.equal(countWheelLeaves(nested, true), 3);
  assert.equal(wheelPercent(nested), 60);
});

test('archived goals are fully excluded from load', () => {
  const sphere = container(
    [leaf(false), leaf(false), leaf(false, { archived: true }), leaf(false, { archived: true })],
    { total: 5 }
  );
  assert.equal(countWheelLeaves(sphere, false), 2);
  assert.equal(wheelPercent(sphere), 60, 'archive must raise the sector');
  const archivedContainer = container([container(leaves(3, 0), { archived: true })], { total: 3 });
  assert.equal(countWheelLeaves(archivedContainer, false), 0);
});

test('checklist leaf: partial = open load, full = done; items are never units', () => {
  const partial = leaf(false, { checklist: [{ text: 'a', done: true }, { text: 'b', done: false }] });
  const full = leaf(false, { checklist: [{ text: 'a', done: true }, { text: 'b', done: true }] });
  assert.equal(isWheelLeafDone(partial), false);
  assert.equal(isWheelLeafDone(full), true);
  assert.equal(wheelPercent(container([partial], { total: 1 })), 0);
  assert.equal(wheelPercent(container([full], { total: 1 })), 100);
});

test('percent is clamped to 0..100', () => {
  assert.equal(wheelPercent(container(leaves(3, 0), { total: 2 })), 0, 'incomplete > total → 0');
  assert.equal(wheelPercent(container([], { total: 0 })), 100);
});

test('ensureWheelTotals: backfills missing counters from active leaves, never lowers', () => {
  const tree = container([leaf(true), leaf(false), leaf(false, { archived: true })]);
  ensureWheelTotals(tree);
  assert.equal(tree.totalGoalsAdded, 2, 'done + open leaves, archived excluded');
  tree.totalGoalsAdded = 7;
  ensureWheelTotals(tree);
  assert.equal(tree.totalGoalsAdded, 7, 'existing sticky totals must survive');
});

test('bumpWheelTotals: grows ancestors on add, shrinks (floor 0) on relocate', () => {
  t.app.setState({ name: 'root', children: [container([leaf(false)], { total: 1 })] });
  bumpWheelTotals([0], 2);
  assert.equal(t.app.getState().children[0].totalGoalsAdded, 3);
  bumpWheelTotals([0], -5);
  assert.equal(t.app.getState().children[0].totalGoalsAdded, 0, 'never below zero');
  setWheelTotal(t.app.getState().children[0], 4);
  assert.equal(t.app.getState().children[0].totalGoalsAdded, 4);
});

test('wheelFilledSteps: whole tens rounded DOWN (92% = 9 rings)', () => {
  const cases = [[0, 0], [5, 0], [9, 0], [10, 1], [19, 1], [20, 2], [92, 9], [99, 9], [100, 10]];
  for (const [pct, expected] of cases) {
    assert.equal(wheelFilledSteps(pct), expected, `${pct}% must fill ${expected} rings`);
  }
});

test('wheelHTML: 92% sector renders 9 filled rings', () => {
  const mkSphere = (done, total, name) => container(leaves(25, done), { total, name });
  // Two sectors so the filled shape is a wedge path (a single sector renders a <circle>).
  // Filled wedges are the only <path> elements starting at the wheel center "M 286 160 L";
  // label arcs live in <defs> and grid rings are <circle> — both must be ignored here.
  const filledRadii = (svg) =>
    [...svg.matchAll(/<path d="M 286 160 L [\d.]+ [\d.]+ A ([\d.]+)/g)]
      .map((m) => parseFloat(m[1]))
      .filter((r) => Number.isFinite(r) && r > 1);
  const svg92 = t.app.wheelHTML([mkSphere(23, 25, 'a'), mkSphere(25, 25, 'b')]);
  assert.equal(wheelPercent(mkSphere(23, 25)), 92);
  const filled92 = filledRadii(svg92).sort((a, b) => a - b);
  assert.equal(filled92.length, 2, 'both sectors must render a filled wedge');
  assert.ok(
    Math.abs(filled92[0] - (119 * 9) / 10) < 1,
    `92%: radius ${filled92[0]} must match 9/10 rings (${(119 * 9) / 10})`
  );
  assert.ok(Math.abs(filled92[1] - 119) < 1, `100%: radius ${filled92[1]} must be full (119)`);
});
