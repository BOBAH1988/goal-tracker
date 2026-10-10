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

// Regression (found 10.10.2026): the "today" checklist broke on the deployed site because
// ensureToday() only ran in loadState(), not in the cloud-sync / fresh-signup / import /
// sync-conflict paths (which only fire on https). Those paths replaced `state` with a doc
// lacking `today`, so homeViewHTML rendered 3 dead fallback rows — checkbox/edit/action all
// silently no-op'd. Fix: every state entry point now runs ensureToday, and emptyTemplate()
// carries a today array. Pin both invariants here.
test('emptyTemplate/seed carry a valid 3-item today checklist', () => {
  const t = boot();
  for (const [label, st] of [['emptyTemplate', t.app.emptyTemplate()], ['SEED', t.app.SEED]]) {
    assert.ok(Array.isArray(st.today), `${label}.today must be an array`);
    assert.equal(st.today.length, 3, `${label}.today must have exactly 3 items`);
    for (const item of st.today) {
      assert.equal(typeof item.text, 'string', `${label} item.text must be a string`);
      assert.equal(typeof item.done, 'boolean', `${label} item.done must be a boolean`);
    }
  }
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

test('resolve: broken path returns null instead of throwing', () => {
  const t = boot();
  t.app.setState({ name: 'root', children: [container([leaf(true)], { total: 1 })] });
  assert.equal(t.app.resolve([0, 0]).done, true, 'valid path still resolves');
  assert.equal(t.app.resolve([0, 5]), null, 'missing child index');
  assert.equal(t.app.resolve([9]), null, 'missing root index');
  assert.equal(t.app.resolve(null), null, 'null path (relocate source cleared)');
  assert.equal(t.app.resolve([]).name, 'root', 'empty path = root');
});

test('sanitizeGoalTree: deep corruption is pruned, not fatal', () => {
  const t = boot();
  const tree = {
    name: 'root',
    children: [
      { name: 'ok', children: [{ name: 'broken', children: {} }, null, { nope: 1 }, 'junk'] },
      'junk',
      42,
    ],
  };
  t.app.sanitizeGoalTree(tree);
  assert.equal(tree.children.length, 1, 'non-node root children dropped');
  const ok = tree.children[0];
  assert.equal(ok.children.length, 1, 'only the real child survives');
  assert.deepEqual(Array.from(ok.children[0].children), [], 'non-array children coerced to []');
  const cl = { name: 'l', children: [], done: false, checklist: 'not-an-array' };
  t.app.sanitizeGoalTree({ name: 'r', children: [cl] });
  assert.ok(!('checklist' in cl), 'non-array checklist removed');
  const cl2 = { name: 'l', children: [], done: false, checklist: [{ text: 7, done: 1 }, null] };
  t.app.sanitizeGoalTree({ name: 'r', children: [cl2] });
  assert.equal(cl2.checklist.length, 1, 'non-object checklist lines dropped');
  assert.equal(cl2.checklist[0].text, '7', 'text coerced to string');
  assert.equal(cl2.checklist[0].done, true, 'done coerced to boolean');
});

test('loadState: corrupt deep node heals instead of breaking render', () => {
  const t = boot();
  const bad = { name: 'root', children: [{ name: 'x', children: {} }, 'junk'] };
  t.localStorage.setItem(t.app.STORAGE_KEY, JSON.stringify(bad));
  const loaded = t.app.loadState();
  assert.ok(t.app.isValidGoalTree(loaded), 'loaded tree passes the gate');
  assert.equal(loaded.children.length, 1, 'junk sibling dropped');
  assert.deepEqual(Array.from(loaded.children[0].children), [], 'broken children healed to []');
});

test('relocateDestPath: pre-splice walk with same-parent index shift', () => {
  const t = boot();
  const a = container([leaf(false)], { name: 'A', total: 1 });
  const b = container([leaf(false)], { name: 'B', total: 1 });
  t.app.setState({ name: 'root', children: [a, b] });
  // Move A (idx 0) into B: B is at idx 1 pre-splice, lands at 0 after the removal.
  assert.deepEqual(Array.from(t.app.relocateDestPath([1], b, [], 0)), [0]);
  // Move B (idx 1) into A: A stays at 0 — no shift.
  assert.deepEqual(Array.from(t.app.relocateDestPath([0], a, [], 1)), [0]);
  // Deeper: source is a root child (idx 0), dest is a container inside the next root child —
  // the shift applies to the first index only, deeper indices of the destination subtree stay.
  const inner = container([leaf(false)], { name: 'D', total: 1 });
  const holder = container([inner], { name: 'B2', total: 1 });
  t.app.setState({ name: 'root', children: [a, holder] });
  assert.deepEqual(Array.from(t.app.relocateDestPath([1, 0], inner, [], 0)), [0, 0]);
  // Dest path that no longer resolves to destNode (stale after a remote edit) → null.
  assert.equal(t.app.relocateDestPath([1], a, [], 0), null, 'resolved node != destNode');
  assert.equal(t.app.relocateDestPath([9], b, [], 0), null, 'index out of range');
});

test('removeChecklistItem: middle keeps list, last line collapses to plain leaf', () => {
  const t = boot();
  const n = leaf(false, { checklist: [{ text: 'a', done: true }, { text: 'b', done: false }] });
  assert.equal(t.app.removeChecklistItem(n, 0), false, 'lines remain → no collapse');
  assert.equal(n.checklist.length, 1);
  assert.equal(n.checklist[0].text, 'b');
  assert.equal(t.app.removeChecklistItem(n, 0), true, 'last line → collapse reported');
  assert.ok(!('checklist' in n), 'phantom [] never exists');
  assert.equal(n.done, false, 'collapses to an unchecked plain checkbox');
  assert.equal(t.app.removeChecklistItem(n, 0), false, 'no checklist → no-op');
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

test('ensureWishMap: backfills a missing board and drops broken cards', () => {
  const t = boot();
  const st = { name: 'root', children: [] };
  t.app.ensureWishMap(st);
  assert.equal(st.wishMap.length, 0, 'a board-less state must be backfilled as []');
  st.wishMap = [
    { src: 'data:image/jpeg;base64,AA', caption: 'ok' },
    null,
    { caption: 'no src' },
    42,
    { src: '<script>alert(1)</script>', caption: 'not an image' },
    { src: 'data:image/png;base64,BB' },
  ];
  t.app.ensureWishMap(st);
  assert.equal(st.wishMap.length, 2, 'only cards with a data:image src survive the sanitize');
  assert.equal(st.wishMap[0].caption, 'ok', 'valid caption kept');
  assert.equal(st.wishMap[1].caption, '', 'missing caption defaults to empty string');
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
