'use strict';
/* State shell: paths, guards, seeding, persistence, and invariants prod must never break. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, leaf, container } = require('./helpers');

test('resolve/validatePath: navigation survives deleted nodes', () => {
  const t = boot();
  t.app.setState({ name: 'root', children: [container([leaf(true)], { total: 1 })] });
  t.app.setPath([0, 0]);
  assert.equal(t.app.resolve([0, 0]).done, true);
  t.app.setState({ name: 'root', children: [] });
  t.app.validatePath();
  assert.deepEqual(t.app.getPath(), []);
});

test('protectedCountFor/minChildrenFor: home keeps 1, deeper levels can empty', () => {
  const t = boot();
  assert.equal(t.app.protectedCountFor(0), 1);
  assert.equal(t.app.protectedCountFor(1), 0);
  assert.equal(t.app.minChildrenFor(2), 0);
});

test('emptyTemplate/seed: valid trees with expected shape', () => {
  const t = boot();
  const tpl = t.app.emptyTemplate();
  assert.ok(t.app.isValidGoalTree(tpl));
  assert.equal(tpl.children.length, 1);
  assert.ok(t.app.isValidGoalTree(t.app.SEED));
  assert.ok(t.app.SEED.children.length >= 4, 'demo spheres must survive');
});

test('saveState/loadState round-trip preserves the sticky wheel totals', () => {
  const t = boot();
  t.app.setState({
    name: 'root',
    children: [container([leaf(true), leaf(false)], { total: 5 })],
  });
  t.app.saveState();
  const raw = t.localStorage.getItem(t.app.STORAGE_KEY);
  assert.ok(raw.includes('totalGoalsAdded'), 'counter must persist in localStorage');
  const loaded = t.app.loadState();
  assert.equal(loaded.children[0].totalGoalsAdded, 5);
  assert.equal(loaded.children[0].children.length, 2);
});

test('collectPriorityItems: skips archived subtrees', () => {
  const t = boot();
  const open = leaf(false, { priority: true });
  const hidden = leaf(false, { priority: true, archived: true });
  t.app.setState({ name: 'root', children: [open, hidden] });
  const items = t.app.collectPriorityItems();
  assert.equal(items.length, 1);
  assert.equal(items[0].node, open);
});

test('locales: ru and en carry the same key set', () => {
  const t = boot();
  const ru = Object.keys(t.app.STRINGS.ru).sort();
  const en = Object.keys(t.app.STRINGS.en).sort();
  assert.deepEqual(en, ru, 'a missing key in either locale breaks the UI');
  for (const lang of ['ru', 'en']) {
    assert.ok(
      t.app.STRINGS[lang].instructionsText.includes('92') === false,
      'instruction text must not hardcode percents'
    );
  }
});
