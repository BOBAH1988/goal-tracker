'use strict';
/* «Челленж» (v1.2.62) — habit/challenge block under the wheel (unit side).
   Click-through scenarios live in click.test.js next to the bootDom harness; this file
   covers the pure logic: sanitizer, date math, stats, plurals and the section HTML.
   All tests run the REAL inline script from index.html via the vm harness. */
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const { boot } = require('./helpers');

test('challenge: fresh state carries the default shape, the section is collapsed', () => {
  const t = boot();
  const ch = t.app.getState().challenge;
  assert.ok(ch, 'state.challenge must exist after loadState');
  assert.equal(ch.title, '', 'no title on a fresh install');
  assert.equal(ch.startedAt, '', 'no start date yet');
  assert.equal(ch.duration, 21, 'default duration = 21 days');
  assert.deepEqual(Array.from(Object.keys(ch.days)), [], 'no marks on a fresh install');
  assert.equal(t.app.getChallengeOpen(), false, 'the section starts COLLAPSED by default');
});

test('challenge: ensureChallenge repairs a corrupted save instead of throwing', () => {
  const t = boot();
  const bad = { challenge: { title: 42, startedAt: 'junk', duration: -5,
    days: { 'not-a-date': true, '2026-10-01': true, '2026-10-02': false } } };
  t.app.ensureChallenge(bad);
  assert.equal(bad.challenge.title, '', 'a non-string title is dropped');
  assert.equal(bad.challenge.startedAt, '', 'a non-ISO start date is dropped');
  assert.equal(bad.challenge.duration, 21, 'a negative duration falls back to the default');
  assert.deepEqual(Array.from(Object.keys(bad.challenge.days)), ['2026-10-01'],
    'junk keys and falsy marks are dropped');
  const none = {};
  t.app.ensureChallenge(none);
  assert.equal(none.challenge.duration, 21, 'a missing challenge is created with defaults');
  const arr = { challenge: [] };
  t.app.ensureChallenge(arr);
  assert.equal(arr.challenge.title, '', 'an array is not a challenge — replaced by the default');
});

test('challenge: date math helpers (add days, signed distance, Monday-first month grid)', () => {
  const t = boot();
  assert.equal(t.app.challengeAddDays('2026-01-31', 1), '2026-02-01', 'month rollover');
  assert.equal(t.app.challengeAddDays('2026-12-31', 1), '2027-01-01', 'year rollover');
  assert.equal(t.app.challengeAddDays('2026-03-01', -1), '2026-02-28', 'backwards across months');
  assert.equal(t.app.challengeDaysBetween('2026-10-01', '2026-10-11'), 10);
  assert.equal(t.app.challengeDaysBetween('2026-10-11', '2026-10-01'), -10, 'signed distance');
  const cells = t.app.challengeMonthCells(2026, 9);   // October 2026 (months are 0-based)
  assert.equal(cells.length, 35, 'a month that fits in five weeks gets exactly five rows');
  assert.equal(cells[0].iso, '2026-09-28', 'the grid starts on the Monday before Oct 1 2026');
  assert.equal(new Date(2026, 8, 28).getDay(), 1, 'and that day really is a Monday');
  assert.equal(cells[0].inMonth, false, 'the leading cells belong to the previous month');
  assert.equal(cells[6].iso, '2026-10-04', 'the 7th cell is Sunday Oct 4 2026');
  assert.equal(cells[6].inMonth, true, 'and belongs to the visible month');
  assert.equal(cells[30].iso, '2026-10-28', 'the 31st cell is the Wednesday of the 5th week');
  assert.equal(cells[34].iso, '2026-11-01', 'the last cell of a five-row grid is the next Sunday');
});

/* v1.2.64: the grid is five rows tall for most months — but a month that starts late in
   the week and has 31 days (март, август, ноябрь 2026) needs a sixth row. A hard five-row
   cut would drop the last days of those months from the calendar, and they could not be
   marked at all. The guard: EVERY day of EVERY month must be present in the grid, and the
   grid is never taller than six rows. */
test('challenge: the month grid is five rows tall — but never drops a day of the month', () => {
  const t = boot();
  for(let y = 2026; y <= 2027; y++){
    for(let m = 0; m < 12; m++){
      const cells = t.app.challengeMonthCells(y, m);
      const rows = cells.length / 7;
      assert.ok(rows === 5 || rows === 6,
        `${y}-${m + 1}: the grid must be five or six rows, got ${rows}`);
      const daysInMonth = new Date(y, m + 1, 0).getDate();
      const shown = cells.filter(c => c.inMonth).map(c => c.day);
      assert.equal(shown.length, daysInMonth,
        `${y}-${m + 1}: all ${daysInMonth} days of the month must be in the grid`);
      assert.equal(new Set(shown).size, daysInMonth, `${y}-${m + 1}: no duplicated days`);
      for(let d = 1; d <= daysInMonth; d++){
        assert.ok(shown.includes(d), `${y}-${m + 1}: day ${d} is missing from the grid`);
      }
    }
  }
  // The known six-row months (a Monday-first grid that starts late in the week).
  assert.equal(t.app.challengeMonthCells(2026, 2).length, 42, 'March 2026 needs a sixth row');
  assert.equal(t.app.challengeMonthCells(2026, 7).length, 42, 'August 2026 needs a sixth row');
  assert.equal(t.app.challengeMonthCells(2026, 10).length, 42, 'November 2026 needs a sixth row');
  assert.equal(t.app.challengeMonthCells(2026, 9).length, 35, 'October 2026 fits in five rows');
  assert.equal(t.app.challengeMonthCells(2027, 1).length, 35, 'February 2027 fits in five rows');
});

test('challenge: stats — countdown, day number, progress, finished term', () => {
  const t = boot();
  const today = t.app.isoToday();
  const start = t.app.challengeAddDays(today, -3);
  // Started 3 days ago, 7-day term → day 4, 4 days left (today..lastDay inclusive).
  const s1 = t.app.challengeStats({ title: 'x', startedAt: start, duration: 7, days: {} });
  assert.equal(s1.dayNum, 4);
  assert.equal(s1.total, 7);
  assert.equal(s1.remaining, 4);
  assert.equal(s1.finished, false);
  assert.equal(s1.done, 0);
  assert.equal(s1.pct, 0);
  assert.equal(s1.lastDay, t.app.challengeAddDays(start, 6), 'the term ends on day 7');
  // Two marks → progress against the chosen duration.
  const s2 = t.app.challengeStats({ title: 'x', startedAt: start, duration: 7,
    days: { [start]: true, [today]: true } });
  assert.equal(s2.done, 2);
  assert.equal(s2.pct, Math.round(100 * 2 / 7));
  // A term that ended 30 days ago is finished — no countdown left.
  const s3 = t.app.challengeStats({ title: 'x', startedAt: t.app.challengeAddDays(today, -30),
    duration: 7, days: {} });
  assert.equal(s3.finished, true);
  assert.equal(s3.remaining, 0);
  // No limit: day number instead of a countdown, total = days that COULD be marked.
  const s4 = t.app.challengeStats({ title: 'x', startedAt: t.app.challengeAddDays(today, -9),
    duration: 0, days: {} });
  assert.equal(s4.lastDay, null);
  assert.equal(s4.dayNum, 10);
  assert.equal(s4.total, 10);
  assert.equal(s4.remaining, 0);
  // No start date at all (empty challenge) — the renderer must not divide by zero.
  const s5 = t.app.challengeStats({ title: '', startedAt: '', duration: 21, days: {} });
  assert.equal(s5.dayNum, 0);
  assert.equal(s5.pct, 0);
});

test('challenge: plural key selection + every renderer key exists in ru AND en', () => {
  const t = boot();
  assert.equal(t.app.challengePlural(1, '1', 'Few', 'Many'), '1');
  assert.equal(t.app.challengePlural(21, '1', 'Few', 'Many'), '1', '21 день');
  assert.equal(t.app.challengePlural(2, '1', 'Few', 'Many'), 'Few');
  assert.equal(t.app.challengePlural(4, '1', 'Few', 'Many'), 'Few');
  assert.equal(t.app.challengePlural(5, '1', 'Few', 'Many'), 'Many');
  assert.equal(t.app.challengePlural(11, '1', 'Few', 'Many'), 'Many');
  assert.equal(t.app.challengePlural(12, '1', 'Few', 'Many'), 'Many');
  assert.equal(t.app.challengePlural(0, '1', 'Few', 'Many'), 'Many');
  for(const lang of ['ru', 'en']){
    const s = t.app.STRINGS[lang];
    ['challengeTitle','challengeHint','challengePlaceholder','challengeDurationLabel',
     'challengeNoTerm','challengeStart','challengeSave','challengeCancel','challengeEdit',
     'challengeNew','challengeResetConfirm','challengeEmptyTitle','challengeDayN',
     'challengeFinished','challengeProgress1','challengeProgressFew','challengeProgressMany',
     'challengeRemain1','challengeRemainFew','challengeRemainMany','challengeWeekdays',
     'challengeMonths','challengeDayHint','challengePrevMonth','challengeNextMonth']
      .forEach(k => assert.ok(typeof s[k] === 'string' && s[k].length,
        `${lang}.${k} must be a non-empty string`));
  }
});

test('challenge: collapsed section renders only the header (default view)', () => {
  const t = boot();
  const html = vm.runInContext('challengeSectionHTML()', t.ctx);
  assert.ok(html.includes('id="challengeToggle"'), 'the toggle header must exist on home');
  assert.ok(html.includes('▸'), 'the collapsed arrow points right');
  assert.ok(!html.includes('challengeTitleInput'), 'no form while collapsed');
  assert.ok(!html.includes('challenge-grid'), 'no calendar while collapsed');
  assert.ok(!html.includes('id="btnChallengeEdit"'), 'header buttons belong to the OPEN block');
  assert.ok(!html.includes('id="btnChallengeReset"'), 'and so does the reset button');
});

test('challenge: create form offers the title input, duration chips and «Начать»', () => {
  const t = boot();
  vm.runInContext('challengeOpen = true;', t.ctx);
  const html = vm.runInContext('challengeSectionHTML()', t.ctx);
  assert.ok(html.includes('id="challengeTitleInput"'), 'the title input is shown');
  assert.ok(html.includes('id="btnChallengeSave"'), 'the primary button exists');
  assert.ok(html.includes(t.app.STRINGS.ru.challengeStart),
    'a brand-new challenge says «Начать», not «Сохранить»');
  for(const n of [7, 14, 21, 30]){
    assert.ok(html.includes(`data-challenge-days="${n}"`), `the ${n}-day chip exists`);
  }
  assert.ok(html.includes('data-challenge-days="0"'), 'the no-limit chip exists');
  assert.ok(html.includes('active'), 'one duration chip is pre-selected');
  assert.ok(!html.includes('btnChallengeCancel'), 'nothing to cancel on the create form');
  assert.ok(html.includes('▾'), 'the expanded arrow points down');
});

test('challenge: calendar renders ✓ / ✗ marks, countdown, grid and header buttons', () => {
  const t = boot();
  const today = t.app.isoToday();
  const start = t.app.challengeAddDays(today, -3);
  t.app.setState(Object.assign(t.app.getState(), {
    challenge: { title: 'Отжимания', startedAt: start, duration: 7, days: { [start]: true } }
  }));
  t.app.setChallengeOpen(true);
  const html = vm.runInContext('challengeSectionHTML()', t.ctx);
  assert.ok(html.includes('Отжимания'), 'the saved title is shown');
  assert.ok(!html.includes('id="challengeTitleInput"'), 'a saved challenge shows the calendar, not the form');
  assert.ok(html.includes('class="challenge-grid"'), 'the month grid is rendered');
  assert.ok(html.includes(`data-challenge-day="${start}"`), 'day 1 of the term is on the grid');
  assert.ok(html.includes('✓'), 'the marked day renders a green check');
  assert.ok(html.includes('✗'), 'a passed unmarked day renders a red cross');
  assert.ok(/Осталось|left/i.test(html), 'the countdown line is present');
  assert.ok(html.includes('id="btnChallengePrevMonth"') && html.includes('id="btnChallengeNextMonth"'),
    'month navigation exists');
  assert.ok(html.includes('id="btnChallengeEdit"') && html.includes('id="btnChallengeReset"'),
    'the header edit/reset buttons appear for a saved challenge');
  assert.ok(html.includes('data-tip='), 'and they carry the custom tooltip, not a native title');
  // Срок вышел → строка-констатация вместо обратного отсчёта.
  t.app.setState(Object.assign(t.app.getState(), {
    challenge: { title: 'Old', startedAt: t.app.challengeAddDays(today, -30), duration: 7, days: {} }
  }));
  const html2 = vm.runInContext('challengeSectionHTML()', t.ctx);
  assert.ok(html2.includes(t.app.STRINGS.ru.challengeFinished), 'an ended term says «срок вышел»');
});
