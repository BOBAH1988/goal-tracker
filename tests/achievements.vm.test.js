'use strict';
/* VM harness guard for the «Мои достижения» section (v1.3.3).
   The add form was gated only by `achievementsEditId !== null || achievementsDraft`,
   which is falsy in pure add mode (editId=null, draft='') — so the form never
   rendered when «+» was pressed. The fix uses an explicit `achievementsFormOpen`
   flag (mirroring goodTodayFormOpen). The vm harness evaluates the REAL inline
   script from index.html; rogues like `setAchievementsOpen` toggle the actual
   global state that the section reads. */
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const { boot } = require('./helpers');

test('achievements add form opens with «+» (achievementsFormOpen)', () => {
  const t = boot();
  t.app.setState({ name: 'root', children: [], achievements: [] });
  // The «+» handler now performs exactly this sequence:
  vm.runInContext('achievementsOpen = true; achievementsFormOpen = true; achievementsEditId = null; achievementsDraft = ""; achievementsCharError = "";', t.ctx);
  const html = vm.runInContext('achievementsSectionHTML()', t.ctx);
  assert.ok(html.includes('id="btnAchievementsAdd"'), '«+» button must stay present while adding');
  assert.ok(html.includes('id="achievementsTextarea"'), 'add form textarea must appear after «+»');
  assert.ok(html.includes('id="btnAchievementsSave"'), 'save button must appear in the add form');
});

test('achievements add form stays hidden without «+»', () => {
  const t = boot();
  t.app.setState({ name: 'root', children: [], achievements: ['one'] });
  vm.runInContext('achievementsOpen = true; achievementsFormOpen = false; achievementsEditId = null; achievementsDraft = "";', t.ctx);
  const html = vm.runInContext('achievementsSectionHTML()', t.ctx);
  assert.ok(!html.includes('id="achievementsTextarea"'), 'form must not appear before «+» is pressed');
  assert.ok(!html.includes('id="btnAchievementsSave"'), 'no save button before the form opens');
});

test('achievements edit form opens when a row is edited', () => {
  const t = boot();
  t.app.setState({ name: 'root', children: [], achievements: ['one', 'two'] });
  // Editing a row sets editId and seeds the draft; the form must render.
  vm.runInContext('achievementsOpen = true; achievementsFormOpen = true; achievementsEditId = 1; achievementsDraft = "two"; achievementsCharError = "";', t.ctx);
  const html = vm.runInContext('achievementsSectionHTML()', t.ctx);
  assert.ok(html.includes('id="achievementsTextarea"'), 'form must appear while editing a row');
  assert.ok(html.includes('id="btnAchievementsCancel"'), 'cancel button must appear in edit mode');
});

test('achievements form closes when editing is cancelled (like btnAchievementsCancel)', () => {
  const t = boot();
  t.app.setState({ name: 'root', children: [], achievements: ['one', 'two'] });
  vm.runInContext('achievementsOpen = true; achievementsFormOpen = true; achievementsEditId = 0; achievementsDraft = "one"; achievementsCharError = "";', t.ctx);
  const open = vm.runInContext('achievementsSectionHTML()', t.ctx);
  assert.ok(open.includes('id="btnAchievementsCancel"'), 'cancel button must be visible in edit mode');
  // Mirror the real Cancel handler: clear both the edit mode and the open flag.
  vm.runInContext('achievementsFormOpen = false; achievementsEditId = null;', t.ctx);
  const closed = vm.runInContext('achievementsSectionHTML()', t.ctx);
  assert.ok(!closed.includes('id="achievementsTextarea"'), 'form must hide when the draft is cleared');
  assert.ok(!closed.includes('id="btnAchievementsCancel"'), 'cancel button must be gone after cancel');
});
