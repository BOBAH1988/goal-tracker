'use strict';
/* Balance wheel (sticky engine): percent = 100 * (1 - incomplete / totalGoalsAdded).
   Unit = active leaf goal at any depth. Containers and checklist items are never units.
   totalGoalsAdded never shrinks on delete/archive — only relocate moves it between spheres. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, leaf, container } = require('./helpers');

const t = boot();
const {
  wheelPercent, wheelFilledSteps, countWheelLeaves, countWheelDone, wheelLeafFraction, isWheelLeafDone,
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

test('checklist leaf: fractional credit; items are never units', () => {
  const partial = leaf(false, { checklist: [{ text: 'a', done: true }, { text: 'b', done: false }] });
  const full = leaf(false, { checklist: [{ text: 'a', done: true }, { text: 'b', done: true }] });
  assert.equal(isWheelLeafDone(partial), false);
  assert.equal(isWheelLeafDone(full), true);
  assert.equal(wheelLeafFraction(partial), 0.5);
  assert.equal(wheelLeafFraction(full), 1);
  assert.equal(countWheelDone(container([partial], { total: 1 })), 0.5);
  // 1/2 checklist = half open load → 50, not the old all-or-nothing 0.
  assert.equal(wheelPercent(container([partial], { total: 1 })), 50);
  assert.equal(wheelPercent(container([full], { total: 1 })), 100);
  // Leaf-level sectors mirror card progress.
  assert.equal(wheelPercent(partial), 50);
});

test('deep nesting: done leaf + half-ticked checklist share one sector', () => {
  const doneLeaf = leaf(true);
  const cl = leaf(false, {
    checklist: [
      { text: 'a', done: true }, { text: 'b', done: true },
      { text: 'c', done: false }, { text: 'd', done: false },
    ],
  });
  const inner = container([doneLeaf, cl], { total: 2 });
  const sphere = container([container([inner])], { total: 2 });
  // 1 + 0.5 done of 2 → 75.
  assert.equal(wheelPercent(sphere), 75);
  // A stale sticky total below the live leaf count must not sink the sector to 0.
  assert.equal(wheelPercent(container([container([inner])], { total: 1 })), 75);
});

test('expand (leaf→container): no double-count on fresh convert, sticky on re-expand', () => {
  const { wheelTotal, setWheelTotal, ensureWheelTotals, countWheelLeaves } = t.app;
  // Mirrors the data-addsub-idx handler: capture prevTotal BEFORE the backfill.
  const expand = (node, sphere) => {
    node.children = [
      { name: 's1', date: '', done: false, children: [] },
      { name: 's2', date: '', done: false, children: [] },
    ];
    delete node.done; delete node.date;
    const prevTotal = wheelTotal(node);
    ensureWheelTotals(sphere);
    const freshLeaves = countWheelLeaves(node, false);
    setWheelTotal(node, prevTotal > 0 ? prevTotal + freshLeaves : freshLeaves);
    return node;
  };
  const node = leaf(false);
  const sphere = container([node], { total: 1 });
  expand(node, sphere);
  assert.equal(wheelTotal(node), 2, 'fresh convert: total = live leaves, not 4');
  expand(node, sphere);
  assert.equal(wheelTotal(node), 4, 're-expand: sticky trace survives (2 old + 2 new)');
});

test('sanitizeEmptyChecklists: phantom [] collapses to a plain leaf', () => {
  const { sanitizeEmptyChecklists } = t.app;
  const ghost = leaf(false, { checklist: [] });
  const tree = container([ghost, container([leaf(false, { checklist: [] })])]);
  sanitizeEmptyChecklists(tree);
  assert.ok(!('checklist' in ghost), 'empty checklist removed');
  assert.equal(ghost.done, false, 'falls back to unchecked checkbox');
  assert.equal(wheelPercent(ghost), 0, 'plain open leaf reads 0 with something to do');
  const innerGhost = tree.children[1].children[0];
  assert.ok(!('checklist' in innerGhost), 'nested ghosts heal too');
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
