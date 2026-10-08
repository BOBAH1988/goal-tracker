'use strict';
/* Card/header progress (averaging engine): must NOT change with the wheel rework.
   Any edit to computePercent/doneCount/activeChildren that breaks these fails loudly. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, leaf, container } = require('./helpers');

const t = boot();
const { computePercent, doneCount, activeChildren, isLeaf } = t.app;

test('isLeaf: leaf = no children + done flag', () => {
  assert.equal(isLeaf(leaf(true)), true);
  assert.equal(isLeaf(container([leaf(true)])), false);
  assert.equal(isLeaf({ name: 'x', children: [] }), false, 'no done flag → not a leaf');
});

test('computePercent: plain leaf is 100 or 0', () => {
  assert.equal(computePercent(leaf(true)), 100);
  assert.equal(computePercent(leaf(false)), 0);
});

test('computePercent: checklist leaf fills by ticked items', () => {
  const mk = (flags) => leaf(false, { checklist: flags.map((done, i) => ({ text: `i${i}`, done })) });
  assert.equal(computePercent(mk([true, true, true])), 100);
  assert.equal(computePercent(mk([true, true, false, false])), 50);
  assert.equal(computePercent(mk([false, false])), 0);
});

test('computePercent: container averages over ACTIVE children, empty → 0', () => {
  assert.equal(computePercent(container([])), 0);
  assert.equal(
    computePercent(container([leaf(true), leaf(true), leaf(false), leaf(false), leaf(false)])),
    40
  );
  assert.equal(
    computePercent(container([leaf(false), leaf(false, { archived: true })])),
    0,
    'archived child must not drag the average'
  );
});

test('computePercent: nesting averages recursively', () => {
  const tree = container([
    container([leaf(true), leaf(true)]), // 100
    container([leaf(true), leaf(false)]), // 50
  ]);
  assert.equal(computePercent(tree), 75);
});

test('doneCount: counts active children at 100%', () => {
  assert.equal(doneCount(container([leaf(true), leaf(true), leaf(false)])), 2);
  assert.equal(doneCount(container([leaf(true, { archived: true }), leaf(false)])), 0);
  assert.equal(doneCount(leaf(true)), 0);
});

test('activeChildren: filters archived only', () => {
  const kids = [leaf(false), leaf(false, { archived: true }), container([])];
  assert.equal(activeChildren({ children: kids }).length, 2);
});
