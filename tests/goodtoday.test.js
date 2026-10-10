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

test('render: history view inline edit form appears when goodTodayHistoryEditId is set', () => {
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
      { id: 'e1', date: '2026-10-05', text: 'Первая запись' },
    ],
  });
  vm.runInContext('goodTodayEntriesOpen = true; goodTodayHistoryOpen = true; goodTodayHistoryEditId = "e1"; goodTodayHistoryDraftText = "Первая запись";', t.ctx);
  assert.doesNotThrow(() => vm.runInContext('render()', t.ctx));
  assert.ok(appStub.innerHTML.includes('id="goodTodayHistoryTextarea"'), 'inline textarea must appear in history view');
  assert.ok(appStub.innerHTML.includes('id="btnGoodTodayHistorySave"'), 'save button must appear');
  assert.ok(appStub.innerHTML.includes('id="btnGoodTodayHistoryCancel"'), 'cancel button must appear');
  // e1 is the only entry → neither prev nor next should appear
  assert.ok(!appStub.innerHTML.includes('id="btnGoodTodayHistoryPrev"'), 'prev nav must be absent when only one entry');
  assert.ok(!appStub.innerHTML.includes('id="btnGoodTodayHistoryNext"'), 'next nav must be absent when only one entry');
  assert.ok(appStub.innerHTML.includes('selected'), 'edited entry must be highlighted as selected');
  t.document.getElementById = original;
});

test('render: history view shows next nav when editing newest entry', () => {
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
    children: [],
    goodTodayEntries: [
      { id: 'e1', date: '2026-10-05', text: 'Первая запись' },
      { id: 'e2', date: '2026-10-06', text: 'Вторая запись' },
      { id: 'e3', date: '2026-10-07', text: 'Третья запись' },
    ],
  });
  // Edit the newest entry (e3, index 0) → next present, prev absent
  vm.runInContext('goodTodayEntriesOpen = true; goodTodayHistoryOpen = true; goodTodayHistoryEditId = "e3"; goodTodayHistoryDraftText = "Третья запись";', t.ctx);
  assert.doesNotThrow(() => vm.runInContext('render()', t.ctx));
  assert.ok(!appStub.innerHTML.includes('id="btnGoodTodayHistoryPrev"'), 'prev nav must be absent when editing newest entry');
  assert.ok(appStub.innerHTML.includes('id="btnGoodTodayHistoryNext"'), 'next nav must appear when editing newest entry');
  // The edited entry (e2) should be highlighted as selected
  const selectedCount = (appStub.innerHTML.match(/selected/g) || []).length;
  assert.ok(selectedCount >= 1, 'at least one history item must be selected');
  t.document.getElementById = original;
});

test('goodTodayEntryById: finds entry by id across all entries', () => {
  const t = boot();
  t.app.setState({
    name: 'root',
    children: [],
    goodTodayEntries: [
      { id: 'e1', date: '2026-10-05', text: 'Первая' },
      { id: 'e2', date: '2026-10-06', text: 'Вторая' },
    ],
  });
  assert.doesNotThrow(() => {
    const e1 = vm.runInContext('goodTodayEntryById("e1")', t.ctx);
    const e2 = vm.runInContext('goodTodayEntryById("e2")', t.ctx);
    assert.ok(e1 && e1.text === 'Первая', 'e1 must be found');
    assert.ok(e2 && e2.text === 'Вторая', 'e2 must be found');
    const missing = vm.runInContext('goodTodayEntryById("nope")', t.ctx);
    assert.equal(missing, null, 'non-existent id must return null');
  });
});

test('goodTodayHistoryHTML: inline edit form with prev/next renders correctly', () => {
  const t = boot();
  t.app.setState({
    name: 'root',
    children: [],
    goodTodayEntries: [
      { id: 'e1', date: '2026-10-05', text: 'A' },
      { id: 'e2', date: '2026-10-06', text: 'B' },
    ],
  });
  vm.runInContext('goodTodayHistoryEditId = "e1"; goodTodayHistoryDraftText = "A";', t.ctx);
  const html = vm.runInContext('goodTodayHistoryHTML()', t.ctx);
  // e1 sorted first (newest 2026-10-06? no — e1=10-05, e2=10-06, so e2 is newest)
  // In sorted order: e2 (index 0) then e1 (index 1). Editing e1 → prev present, next absent.
  assert.ok(html.includes('id="btnGoodTodayHistoryPrev"'), 'prev present when editing oldest entry');
  assert.ok(!html.includes('id="btnGoodTodayHistoryNext"'), 'next absent when editing oldest entry');
  assert.ok(html.includes('id="btnGoodTodayHistoryCancel"'), 'cancel button must render');
});

test('goodTodayHistoryHTML: last entry shows prev but no next', () => {
  const t = boot();
  t.app.setState({
    name: 'root',
    children: [],
    goodTodayEntries: [
      { id: 'e1', date: '2026-10-05', text: 'A' },
      { id: 'e2', date: '2026-10-06', text: 'B' },
    ],
  });
  vm.runInContext('goodTodayHistoryEditId = "e2"; goodTodayHistoryDraftText = "B";', t.ctx);
  const html = vm.runInContext('goodTodayHistoryHTML()', t.ctx);
  // e2 sorted first (newest 2026-10-06). Editing e2 → next present, prev absent.
  assert.ok(!html.includes('id="btnGoodTodayHistoryPrev"'), 'prev absent when editing newest entry');
  assert.ok(html.includes('id="btnGoodTodayHistoryNext"'), 'next present when editing newest entry');
});

test('goodTodayHistoryHTML: no inline edit form when goodTodayHistoryEditId is null', () => {
  const t = boot();
  t.app.setState({
    name: 'root',
    children: [],
    goodTodayEntries: [
      { id: 'e1', date: '2026-10-05', text: 'A' },
    ],
  });
  const html = vm.runInContext('goodTodayHistoryHTML()', t.ctx);
  assert.ok(!html.includes('id="goodTodayHistoryTextarea"'), 'textarea must not render without edit id');
  assert.ok(!html.includes('id="btnGoodTodayHistorySave"'), 'save button must not render without edit id');
  assert.ok(html.includes('data-goodtoday-history-edit="e1"'), 'history entries still listed');
});

test('STRUNAS goodTodayHistoryHTML: no crash with no entries', () => {
  const t = boot();
  t.app.setState({
    name: 'root',
    children: [],
    goodTodayEntries: [],
  });
  assert.doesNotThrow(() => {
    vm.runInContext('goodTodayHistoryEditId = null; goodTodayHistoryDraftText = "";', t.ctx);
    const html = vm.runInContext('goodTodayHistoryHTML()', t.ctx);
    assert.ok(html.includes('История'), 'history title present');
  });
});

test('goodTodayHistoryHTML: shows 7 entries per page with pagination nav', () => {
  const t = boot();
  const entries = [];
  for(let i = 1; i <= 10; i++){
    entries.push({ id: `e${i}`, date: `2026-10-${String(i).padStart(2,'0')}`, text: `Запись ${i}` });
  }
  t.app.setState({
    name: 'root',
    children: [],
    goodTodayEntries: entries,
  });
  // Page 0: newest 7 (e10..e4)
  vm.runInContext('goodTodayHistoryPage = 0;', t.ctx);
  const html0 = vm.runInContext('goodTodayHistoryHTML()', t.ctx);
  assert.ok(html0.includes('id="btnGoodTodayHistoryPagePrevBottom"'), 'prev page nav on page 0');
  assert.ok(!html0.includes('id="btnGoodTodayHistoryPageNextBottom"'), 'next page nav absent on page 0');
  // Count how many entry IDs appear in page 0 (should be 7)
  const page0Ids = [...html0.matchAll(/data-goodtoday-history-edit="([^"]+)"/g)].map(m => m[1]);
  assert.equal(page0Ids.length, 7, 'page 0 shows exactly 7 entries');
  assert.ok(page0Ids.includes('e10'), 'e10 (newest) on page 0');
  assert.ok(!page0Ids.includes('e1'), 'e1 not on page 0');
});

test('goodTodayHistoryHTML: page 1 shows entries 8-10 with correct nav', () => {
  const t = boot();
  const entries = [];
  for(let i = 1; i <= 10; i++){
    entries.push({ id: `e${i}`, date: `2026-10-${String(i).padStart(2,'0')}`, text: `Запись ${i}` });
  }
  t.app.setState({
    name: 'root',
    children: [],
    goodTodayEntries: entries,
  });
  // Page 1: older entries (e3..e1)
  vm.runInContext('goodTodayHistoryPage = 1;', t.ctx);
  const html1 = vm.runInContext('goodTodayHistoryHTML()', t.ctx);
  assert.ok(!html1.includes('id="btnGoodTodayHistoryPagePrevBottom"'), 'prev page nav absent on page 1 (no older entries)');
  assert.ok(html1.includes('id="btnGoodTodayHistoryPageNextBottom"'), 'next page nav (back to newer) on page 1');
  const page1Ids = [...html1.matchAll(/data-goodtoday-history-edit="([^"]+)"/g)].map(m => m[1]);
  assert.equal(page1Ids.length, 3, 'page 1 shows remaining 3 entries');
  assert.ok(page1Ids.includes('e1'), 'e1 (oldest) on page 1');
  assert.ok(!page1Ids.includes('e10'), 'e10 not on page 1');
});

test('goodTodayHistoryGroups: accepts optional entries array', () => {
  const t = boot();
  t.app.setState({
    name: 'root',
    children: [],
    goodTodayEntries: [
      { id: 'e1', date: '2026-10-05', text: 'A' },
      { id: 'e2', date: '2026-10-09', text: 'B' },
    ],
  });
  assert.doesNotThrow(() => {
    const allGroups = vm.runInContext('goodTodayHistoryGroups()', t.ctx);
    assert.ok(allGroups.length >= 1, 'groups without arg returns all entries');
    const paged = vm.runInContext('goodTodayHistoryGroups(goodTodayAllEntries().slice(0,1))', t.ctx);
    assert.equal(paged[0].entries.length, 1, 'paged groups only include provided entries');
  });
});

test('goodTodayHistoryHTML: page nav absent with <=7 entries', () => {
  const t = boot();
  t.app.setState({
    name: 'root',
    children: [],
    goodTodayEntries: [
      { id: 'e1', date: '2026-10-05', text: 'A' },
      { id: 'e2', date: '2026-10-06', text: 'B' },
    ],
  });
  const html = vm.runInContext('goodTodayHistoryHTML()', t.ctx);
  assert.ok(!html.includes('id="btnGoodTodayHistoryPagePrevBottom"'), 'no page nav when <=7 entries');
});

test('goodTodaySectionHTML: entry form collapsed by default (+ button shown)', () => {
  const t = boot();
  t.app.setState({
    name: 'root',
    children: [],
    goodTodayEntries: [
      { id: 'e1', date: '2026-10-05', text: 'A' },
    ],
  });
  // Collapsed: no textarea, no save button, but subtitle + '+' button present
  vm.runInContext('goodTodayFormOpen = false; goodTodayEditId = null;', t.ctx);
  const html = vm.runInContext('goodTodaySectionHTML()', t.ctx);
  assert.ok(html.includes('id="btnGoodTodayAdd"'), "'+' button must be present");
  assert.ok(html.includes('Что было хорошего сегодня?'), 'subtitle must be present');
  assert.ok(!html.includes('id="goodTodayTextarea"'), 'textarea must be hidden when form closed');
  assert.ok(!html.includes('id="btnGoodTodaySave"'), 'save button must be hidden when form closed');
});

test('goodTodaySectionHTML: entry form expands when goodTodayFormOpen is true', () => {
  const t = boot();
  t.app.setState({
    name: 'root',
    children: [],
    goodTodayEntries: [
      { id: 'e1', date: '2026-10-05', text: 'A' },
    ],
  });
  vm.runInContext('goodTodayFormOpen = true; goodTodayEditId = null;', t.ctx);
  const html = vm.runInContext('goodTodaySectionHTML()', t.ctx);
  assert.ok(html.includes('id="goodTodayTextarea"'), 'textarea must appear when form open');
  assert.ok(html.includes('id="btnGoodTodaySave"'), 'save button must appear when form open');
  assert.ok(html.includes('id="btnGoodTodayAdd"'), "'+' button stays present");
});

test('goodTodaySectionHTML: entry form auto-opens while editing an entry', () => {
  const t = boot();
  t.app.setState({
    name: 'root',
    children: [],
    goodTodayEntries: [
      { id: 'e1', date: '2026-10-05', text: 'A' },
    ],
  });
  // Editing without goodTodayFormOpen — form still shows (edit needs the field)
  vm.runInContext('goodTodayFormOpen = false; goodTodayEditId = "e1"; goodTodayDraftText = "A";', t.ctx);
  const html = vm.runInContext('goodTodaySectionHTML()', t.ctx);
  assert.ok(html.includes('id="goodTodayTextarea"'), 'textarea must appear while editing');
  assert.ok(html.includes('id="btnGoodTodayCancel"'), 'cancel button must appear while editing');
});

test('weekShiftISO: moves Monday-start ISO by whole weeks', () => {
  const t = boot();
  assert.equal(vm.runInContext('weekShiftISO("2026-10-05", -1)', t.ctx), '2026-09-28', 'one week earlier');
  assert.equal(vm.runInContext('weekShiftISO("2026-10-05", 1)', t.ctx), '2026-10-12', 'one week later');
  assert.equal(vm.runInContext('weekShiftISO("2026-10-05", 0)', t.ctx), '2026-10-05', 'zero weeks is a no-op');
  assert.equal(vm.runInContext('weekShiftISO("", 1)', t.ctx), '', 'empty input stays empty');
  assert.equal(vm.runInContext('weekShiftISO("not-a-date", 1)', t.ctx), '', 'bad input stays empty');
});

test('goodTodayWeekHistoryHTML: shows one report with prev/next week navigation', () => {
  const t = boot();
  t.app.setState({
    name: 'root',
    children: [],
    goodTodayWeekReflections: [
      { week: '2026-09-28', q1: 'A1', q2: 'A2', q3: 'A3', createdAt: 1, updatedAt: 1 },
      { week: '2026-10-05', q1: 'B1', q2: 'B2', q3: 'B3', createdAt: 2, updatedAt: 2 },
    ],
  });
  // Defaults to the newest saved report.
  const html = vm.runInContext('goodTodayWeekHistoryOpen = true; goodTodayWeekHistoryWeek = null; goodTodayWeekHistoryEditing = false; goodTodayWeekHistoryHTML()', t.ctx);
  assert.ok(html.includes('История побед'), 'history subtitle must render');
  assert.ok(html.includes('B1') && html.includes('B2') && html.includes('B3'), 'the newest report is shown');
  assert.ok(!html.includes('A1'), 'the older report is not mixed in');
  assert.ok(html.includes('id="btnGoodTodayWeekPrev"'), 'prev week button must be present (older report exists)');
  assert.ok(html.includes('id="btnGoodTodayWeekNext"') === false, 'no next week on the newest report up to today');
  assert.ok(html.includes('id="btnGoodTodayWeekHistoryBack"'), 'back button must render');
});

test('goodTodayWeekHistoryHTML: oldest report hides the prev button', () => {
  const t = boot();
  t.app.setState({
    name: 'root',
    children: [],
    goodTodayWeekReflections: [
      { week: '2026-09-28', q1: 'A1', q2: 'A2', q3: 'A3', createdAt: 1, updatedAt: 1 },
    ],
  });
  const html = vm.runInContext('goodTodayWeekHistoryWeek = "2026-09-28"; goodTodayWeekHistoryEditing = false; goodTodayWeekHistoryHTML()', t.ctx);
  assert.ok(html.includes('A1'), 'the oldest report is shown');
  assert.ok(html.includes('id="btnGoodTodayWeekPrev"') === false, 'no prev week past the oldest report');
  // Today's week is newer than the report → next week is available.
  assert.ok(html.includes('id="btnGoodTodayWeekNext"'), 'next week is available towards today');
});

test('goodTodayWeekHistoryHTML: week without a report says so', () => {
  const t = boot();
  t.app.setState({
    name: 'root',
    children: [],
    goodTodayWeekReflections: [
      { week: '2026-09-28', q1: 'A1', q2: '', q3: '', createdAt: 1, updatedAt: 1 },
    ],
  });
  const html = vm.runInContext('goodTodayWeekHistoryWeek = "2026-10-12"; goodTodayWeekHistoryEditing = false; goodTodayWeekHistoryHTML()', t.ctx);
  assert.ok(html.includes('За эту неделю отчёта нет'), 'empty week gets a friendly note');
  assert.ok(html.includes('A1') === false, 'no report content leaks into an empty week');
});

test('goodTodayWeekHistoryHTML: edit form renders for the shown week', () => {
  const t = boot();
  t.app.setState({
    name: 'root',
    children: [],
    goodTodayWeekReflections: [
      { week: '2026-09-28', q1: 'A1', q2: 'A2', q3: 'A3', createdAt: 1, updatedAt: 1 },
    ],
  });
  const html = vm.runInContext('goodTodayWeekHistoryWeek = "2026-09-28"; goodTodayWeekHistoryEditing = true; goodTodayWeekDrafts = {q1:"A1",q2:"A2",q3:"A3"}; goodTodayWeekHistoryHTML()', t.ctx);
  assert.ok(html.includes('id="goodTodayWeekHistoryQ1"'), 'q1 textarea must render');
  assert.ok(html.includes('id="btnGoodTodayWeekHistorySave"'), 'save button must render');
  assert.ok(html.includes('id="btnGoodTodayWeekHistoryEditCancel"'), 'cancel button must render');
  assert.ok(html.includes('A1'), 'the draft value must be inside the textarea');
});

test('goodTodayWeekHistoryHTML: no reports at all renders the empty note', () => {
  const t = boot();
  t.app.setState({
    name: 'root',
    children: [],
    goodTodayWeekReflections: [],
  });
  const html = vm.runInContext('goodTodayWeekHistoryWeek = null; goodTodayWeekHistoryEditing = false; goodTodayWeekHistoryHTML()', t.ctx);
  assert.ok(html.includes('История побед'), 'history subtitle still renders');
  assert.ok(html.includes('За эту неделю отчёта нет'), 'current week has no report → note');
});

test('goodTodaySectionHTML: weekly history view replaces the weekly section', () => {
  const t = boot();
  t.app.setState({
    name: 'root',
    children: [],
    goodTodayWeekReflections: [
      { week: '2026-09-14', q1: 'A1', q2: 'A2', q3: 'A3', createdAt: 1, updatedAt: 1 },
      { week: '2026-09-21', q1: 'B1', q2: 'B2', q3: 'B3', createdAt: 2, updatedAt: 2 },
    ],
  });
  // Normal view: the weekly section and its history button are on screen.
  vm.runInContext('goodTodayEntriesOpen = false; goodTodayWeekHistoryOpen = false; goodTodayWeekHistoryWeek = null;', t.ctx);
  const normal = vm.runInContext('goodTodaySectionHTML()', t.ctx);
  assert.ok(normal.includes('id="btnGoodTodayWeekHistory"'), 'history button must sit in the weekly header');
  // History view: the weekly section is replaced by the history viewer.
  vm.runInContext('goodTodayWeekHistoryOpen = true;', t.ctx);
  const hist = vm.runInContext('goodTodaySectionHTML()', t.ctx);
  assert.ok(hist.includes('id="btnGoodTodayWeekHistoryBack"'), 'the weekly history view takes over the section');
  // Both saved weeks are in the past → both directions are available from the newest one.
  assert.ok(hist.includes('id="btnGoodTodayWeekPrev"'), 'prev week navigation is present');
  assert.ok(hist.includes('id="btnGoodTodayWeekNext"'), 'next week navigation is present');
});
