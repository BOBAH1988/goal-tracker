'use strict';
/* Tests for the «Хорошее сегодня» journal module (v1.1.19): entry/date helpers,
   ensureGoodToday backfill, history grouping, and state round-trips. All run
   against the REAL inline script from index.html via the vm harness. */
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const { boot } = require('./helpers');

test('ensureGoodToday: backfills missing entries array + open flag', () => {
  const t = boot();
  const node = { name: 'root', children: [] };
  t.app.ensureGoodToday(node);
  assert.ok(Array.isArray(node.goodTodayEntries), 'entries must be an array');
  assert.equal(node.goodTodayEntries.length, 0, 'empty on fresh backfill');
  assert.equal(node.goodTodayEntriesOpen, true, 'default-open');
});

test('ensureGoodToday: backfills week reflections array', () => {
  const t = boot();
  const node = { name: 'root', children: [] };
  t.app.ensureGoodToday(node);
  assert.ok(Array.isArray(node.goodTodayWeekReflections), 'week reflections must be an array');
  assert.equal(node.goodTodayWeekReflections.length, 0);
});

test('ensureGoodToday: drops corrupted entries and heals text fields', () => {
  const t = boot();
  const node = {
    name: 'root', children: [],
    goodTodayEntries: [
      { id: 'a', date: '2026-10-05', text: 'ok' },       // valid
      { id: 42, date: '2026-10-06' },                      // bad id type
      null,                                                // null
      { date: '2026-10-07', text: 'no id' },             // missing id
      { id: 'b', date: '2026-10-08', text: null },       // null text → ''
    ],
    goodTodayWeekReflections: [
      { week: '2026-10-05', q1: 'a', q2: 'b', q3: 'c', createdAt: 1, updatedAt: 2 },  // valid
      { q1: 'no week' },                                                             // missing week
      null,                                                                          // null
    ],
  };
  t.app.ensureGoodToday(node);
  assert.equal(node.goodTodayEntries.length, 2, 'corrupted entries dropped');
  assert.equal(node.goodTodayEntries[0].text, 'ok', 'valid entry preserved');
  assert.equal(node.goodTodayEntries[1].text, '', 'null text backfilled to empty string');
  assert.equal(node.goodTodayWeekReflections.length, 1, 'corrupted reflections dropped');
  assert.equal(node.goodTodayWeekReflections[0].week, '2026-10-05');
  assert.equal(node.goodTodayWeekReflections[0].q1, 'a');
});

test('weekStartISO: Monday of the week for a given ISO date', () => {
  const t = boot();
  // 2026-10-08 is a Thursday → Monday is 2026-10-05
  assert.equal(t.app.weekStartISO('2026-10-08'), '2026-10-05');
  // 2026-10-05 is a Monday itself → stays
  assert.equal(t.app.weekStartISO('2026-10-05'), '2026-10-05');
  // 2026-10-04 is a Sunday → belongs to the previous week's Monday 2026-09-28
  assert.equal(t.app.weekStartISO('2026-10-04'), '2026-09-28');
  // 2026-10-11 is a Sunday → Monday is 2026-10-05
  assert.equal(t.app.weekStartISO('2026-10-11'), '2026-10-05');
  // Junk input → ''
  assert.equal(t.app.weekStartISO('not-a-date'), '');
  assert.equal(t.app.weekStartISO(''), '');
  assert.equal(t.app.weekStartISO(null), '');
});

test('formatDateISO: ru vs en formatting', () => {
  const t = boot();
  // Default lang is 'ru' in the vm harness (loadTheme/loadLang defaults)
  vm.runInContext("lang = 'ru'", t.ctx);
  assert.equal(t.app.formatDateISO('2026-10-05'), '5 октября 2026');
  assert.equal(t.app.formatDateISO('2026-01-03'), '3 января 2026');
  vm.runInContext("lang = 'en'", t.ctx);
  assert.equal(t.app.formatDateISO('2026-10-05'), '10/05/2026');
});

test('formatWeekLabel: ru week range', () => {
  const t = boot();
  vm.runInContext("lang = 'ru'", t.ctx);
  // Week starting Monday 2026-10-05 → ends Sunday 2026-10-11
  const label = t.app.formatWeekLabel('2026-10-05');
  assert.ok(label.includes('5 октября 2026'), 'week label must include start date');
  assert.ok(label.includes('11 октября 2026'), 'week label must include end date');
});

test('goodTodayAllEntries: newest first', () => {
  const t = boot();
  t.app.setState({
    name: 'root',
    children: [],
    goodTodayEntries: [
      { id: 'a', date: '2026-10-05', text: 'older' },
      { id: 'b', date: '2026-10-10', text: 'newer' },
      { id: 'c', date: '2026-10-08', text: 'middle' },
    ],
  });
  const all = t.app.goodTodayAllEntries();
  assert.equal(all.length, 3);
  assert.equal(all[0].date, '2026-10-10', 'newest first');
  assert.equal(all[1].date, '2026-10-08');
  assert.equal(all[2].date, '2026-10-05', 'oldest last');
});

test('goodTodayTodayEntries: filters to today only', () => {
  const t = boot();
  // Patch isoToday via the context — it reads `new Date()` internally, but we can't easily
  // stub that. Instead test the filtering logic directly by setting entries and checking
  // the function filters by the date returned by isoToday.
  t.app.setState({
    name: 'root',
    children: [],
    goodTodayEntries: [
      { id: 'a', date: '2099-12-31', text: 'future' },
      { id: 'b', date: '2000-01-01', text: 'past' },
    ],
  });
  const today = vm.runInContext('isoToday()', t.ctx);
  const todays = t.app.goodTodayTodayEntries();
  // Neither entry matches "today" (whatever that is in the test env), so both are filtered out
  const dates = todays.map(e => e.date);
  assert.ok(!dates.includes('2099-12-31'), 'future entry excluded');
  assert.ok(!dates.includes('2000-01-01'), 'past entry excluded');
  assert.ok(dates.every(d => d === today), 'only today entries included');
});

test('goodTodayEntryById: null for missing / junk id', () => {
  const t = boot();
  t.app.setState({
    name: 'root',
    children: [],
    goodTodayEntries: [
      { id: 'xyz', date: '2026-10-05', text: 'hello' },
    ],
  });
  const found = t.app.goodTodayEntryById('xyz');
  assert.equal(found.text, 'hello');
  assert.equal(t.app.goodTodayEntryById('nope'), null);
  assert.equal(t.app.goodTodayEntryById(null), null);
  assert.equal(t.app.goodTodayEntryById(42), null);
});

test('goodTodayHistoryGroups: groups entries by week, newest first', () => {
  const t = boot();
  t.app.setState({
    name: 'root',
    children: [],
    goodTodayEntries: [
      { id: 'a', date: '2026-10-05', text: 'mon-week' },  // week of 2026-10-05
      { id: 'b', date: '2026-10-11', text: 'sun-same-week' }, // week of 2026-10-05 (Sunday)
      { id: 'c', date: '2026-10-04', text: 'sun-prev-week' }, // week of 2026-09-28
      { id: 'd', date: '2026-09-30', text: 'mid-prev-week' }, // week of 2026-09-28
    ],
  });
  const groups = t.app.goodTodayHistoryGroups();
  assert.equal(groups.length, 2, 'two weeks');
  assert.equal(groups[0].week, '2026-10-05', 'newest week first');
  assert.equal(groups[0].entries.length, 2, 'week 1 has 2 entries');
  assert.equal(groups[1].week, '2026-09-28', 'older week');
  assert.equal(groups[1].entries.length, 2, 'week 2 has 2 entries');
});

test('goodTodayWeekReflectionsFor: finds reflection by week', () => {
  const t = boot();
  t.app.setState({
    name: 'root',
    children: [],
    goodTodayWeekReflections: [
      { week: '2026-10-05', q1: 'a', q2: 'b', q3: 'c', createdAt: 1, updatedAt: 2 },
      { week: '2026-09-28', q1: 'x', q2: 'y', q3: 'z', createdAt: 3, updatedAt: 4 },
    ],
  });
  assert.equal(t.app.goodTodayWeekReflectionsFor('2026-10-05').q1, 'a');
  assert.equal(t.app.goodTodayWeekReflectionsFor('2026-09-28').q2, 'y');
  assert.equal(t.app.goodTodayWeekReflectionsFor('2026-01-01'), null, 'no reflection for unknown week');
  assert.equal(t.app.goodTodayWeekReflectionsFor(null), null);
});

test('render: home view survives with good-today module open and populated', () => {
  const t = boot();
  const appStub = {
    innerHTML: '', value: '', textContent: '', dataset: {}, style: {},
    classList: { add() {}, remove() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {},
    setAttribute() {}, getAttribute: () => null,
    appendChild() {}, click() {}, focus() {},
    querySelectorAll: () => [], querySelector: () => null,
  };
  // Capture the #app stub so we can inspect rendered HTML.
  const original = t.document.getElementById;
  t.document.getElementById = (id) => (id === 'app' ? appStub : original(id));
  t.app.setState({
    name: 'root',
    children: [{ name: 'Цель 1', done: false, children: [] }],
    goodTodayEntries: [
      { id: 'e1', date: '2026-10-05', text: 'Сегодня было хорошее!' },
    ],
  });
  // Set the transient flags via context to ensure the open path renders
  vm.runInContext('goodTodayEntriesOpen = true; goodTodayHistoryOpen = false;', t.ctx);
  assert.doesNotThrow(() => vm.runInContext('render()', t.ctx), 'render() must not throw with entries');
  assert.ok(appStub.innerHTML.includes('Хорошее сегодня'), 'module title must appear in rendered HTML');
  assert.ok(appStub.innerHTML.includes('Сегодня было хорошее!'), 'entry text must appear in rendered HTML');
  // Restore
  t.document.getElementById = original;
});

test('render: history view renders grouped entries', () => {
  const t = boot();
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
  t.app.setState({
    name: 'root',
    children: [{ name: 'Цель 1', done: false, children: [] }],
    goodTodayEntries: [
      { id: 'e1', date: '2026-10-05', text: 'Понедельник' },
      { id: 'e2', date: '2026-10-08', text: 'Четверг той же недели' },
    ],
  });
  vm.runInContext('goodTodayEntriesOpen = true; goodTodayHistoryOpen = true;', t.ctx);
  assert.doesNotThrow(() => vm.runInContext('render()', t.ctx));
  // History view title
  assert.ok(appStub.innerHTML.includes('История'), 'history title in markup');
  // Back button
  assert.ok(appStub.innerHTML.includes('id="btnGoodTodayHistoryBack"'), 'back button in markup');
});

test('saveState/loadState round-trip preserves goodTodayEntries', () => {
  const t = boot();
  const entries = [
    { id: 'gt-abc', date: '2026-10-05', text: 'persisted entry' },
  ];
  t.app.setState({
    name: 'root',
    children: [{ name: 'Test', done: false, children: [] }],
    goodTodayEntries: entries,
    goodTodayWeekReflections: [{ week: '2026-10-05', q1: 'q1', q2: 'q2', q3: 'q3', createdAt: 1, updatedAt: 2 }],
  });
  t.app.saveState();
  const raw = t.localStorage.getItem(t.app.STORAGE_KEY);
  assert.ok(raw.includes('goodTodayEntries'), 'entries must persist in localStorage');
  assert.ok(raw.includes('persisted entry'));
  const loaded = vm.runInContext('loadState()', t.ctx);
  assert.ok(Array.isArray(loaded.goodTodayEntries), 'loaded entries must be an array');
  assert.equal(loaded.goodTodayEntries.length, 1);
  assert.equal(loaded.goodTodayEntries[0].text, 'persisted entry');
  assert.ok(Array.isArray(loaded.goodTodayWeekReflections), 'loaded week reflections must be an array');
  assert.equal(loaded.goodTodayWeekReflections.length, 1);
});

test('loadState: fresh seed has empty goodTodayEntries + open flag', () => {
  const t = boot();
  // boot() runs loadState() internally with empty localStorage → fresh SEED path.
  // Check the global state directly (getState returns the live state object).
  const loaded = t.app.getState();
  assert.ok(Array.isArray(loaded.goodTodayEntries), 'fresh load must have entries array');
  assert.equal(loaded.goodTodayEntries.length, 0, 'fresh load starts with no entries');
  assert.equal(loaded.goodTodayEntriesOpen, true, 'fresh load must be open by default');
  assert.ok(Array.isArray(loaded.goodTodayWeekReflections), 'fresh load must have week reflections array');
});
