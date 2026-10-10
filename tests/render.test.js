'use strict';
/* Render-layer guards (refactoring plan, stage 1):
   1) render() must survive every open panel/menu — it rebuilds the whole #app innerHTML;
   2) every id the handler layer binds to must exist in the markup — a typo'd id silently
      kills a button (the if(el) guards swallow it);
   3) the checklist lifecycle (fractional credit → collapse) stays intact end to end. */
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const { boot, readProjectFile } = require('./helpers');

/* Top-level panel/menu flags in index.html. Kept as an explicit list: renaming a flag
   in prod must fail this guard (typeof check below), not silently skip the render path. */
const PANEL_FLAGS = [
  'topMenuOpen', 'installPanelOpen', 'aboutPanelOpen', 'instructionsPanelOpen',
  'checklistDeletePanelOpen', 'searchPanelOpen', 'authPanelOpen', 'signupPanelOpen',
  'accountMenuOpen', 'editAccountOpen', 'updatePanelOpen',
  'wishAddOpen', 'wishEditIdx', 'wishLightboxIdx', 'wishMapOpen', 'wishCropSrc', 'wishManageOpen',
  'goodTodayEntriesOpen', 'goodTodayHistoryOpen', 'goodTodayEditId',
  'goodTodayHistoryEditId', 'goodTodayHistoryPage', 'goodTodayFormOpen',
  'goodTodayDeleteId', 'goodTodayWeekPauseOpen', 'goodTodayWeekEditing',
];

/* document.getElementById hands out a FRESH stub per call, so the HTML render() builds is
   unreachable through it. Swap in a keeper for #app, delegate everything else upstream. */
function captureAppElement(t) {
  const appStub = {
    innerHTML: '', value: '', textContent: '', dataset: {}, style: {},
    classList: { add() {}, remove() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {},
    setAttribute() {}, getAttribute: () => null,
    appendChild() {}, click() {}, focus() {},
    querySelectorAll: () => [], querySelector: () => null,
  };
  const original = t.document.getElementById;
  t.document.getElementById = (id) => (id === 'app' ? appStub : original(id));
  return appStub;
}

test('render(): every panel flag exists; opening each panel never throws', () => {
  const t = boot();
  for (const flag of PANEL_FLAGS) {
    const declared = vm.runInContext(`typeof ${flag} !== 'undefined'`, t.ctx);
    assert.ok(declared, `flag ${flag} is no longer declared — update PANEL_FLAGS (guard must not go blind)`);
    vm.runInContext(`${flag} = true`, t.ctx);
    assert.doesNotThrow(() => vm.runInContext('render()', t.ctx), `render() must survive ${flag} = true`);
    vm.runInContext(`${flag} = false`, t.ctx);
    assert.doesNotThrow(() => vm.runInContext('render()', t.ctx), `render() must survive ${flag} = false`);
  }
});

test('render(): footer carries APP_VERSION; topbar and balance wheel render', () => {
  const t = boot();
  const appStub = captureAppElement(t);
  vm.runInContext('render()', t.ctx);
  const html = appStub.innerHTML;
  assert.ok(html.includes(`· v${t.app.APP_VERSION}`), 'footer must show the app version');
  assert.ok(html.includes('id="btnTopMenu"'), 'topbar menu button missing');
  assert.ok(html.includes('id="wheelWrap"'), 'balance wheel missing on the home screen');
  assert.ok(html.length > 1000, 'render must produce a real document, not an empty shell');
});

test('id guard: every getElementById(...) target has a matching id in index.html', () => {
  const src = readProjectFile('index.html');
  const used = [...src.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(used.length >= 60, `expected the handler layer to bind dozens of ids, saw ${used.length}`);
  for (const id of used) {
    assert.ok(src.includes(`id="${id}"`), `getElementById('${id}') has no id="${id}" in the markup — dead handler`);
  }
});

test('checklist lifecycle: fractional credit collapses back after the last line', () => {
  const t = boot();
  const n = t.app.checklistLeaf('L', ['a', 'b', 'c', 'd'], [true, true, false, false]);
  assert.equal(t.app.wheelLeafFraction(n), 0.5, '2/4 ticked = half credit');
  while (n.checklist && n.checklist.length) t.app.removeChecklistItem(n, 0);
  assert.ok(!('checklist' in n), 'last line removal must collapse the phantom [] away');
  assert.equal(n.done, false, 'collapses to an unchecked plain checkbox');
  assert.equal(t.app.wheelLeafFraction(n), 0, 'plain unchecked leaf contributes 0');
});
