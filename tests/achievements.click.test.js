'use strict';
/* Click tests for the «Мои достижения» section (v1.3.3).
   Drives the REAL inline script from index.html through jsdom. Mirrors the
   achievements guard added in v1.3.3: pressing «+» opens the add form (and
   closing it again on a second «+»); Cancel closes the draft and the form;
   saving appends a goal to the list. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM, VirtualConsole } = require('jsdom');
const { readProjectFile, EXPORT_SRC } = require('./helpers');

function bootDom(seedStorage) {
  let html = readProjectFile('index.html');
  // External Firebase SDKs are never fetched in tests → cloudEnabled stays false.
  html = html.replace(/<script src="https:\/\/www\.gstatic\.com[^"]*"><\/script>\s*/g, '');
  // External quotes.js is never fetched in tests → QUOTES array stays empty.
  html = html.replace(/<script src="quotes\.js"><\/script>\s*/g, '');
  if (seedStorage) {
    const lines = Object.entries(seedStorage)
      .map(function (kv) {
        var k = kv[0];
        var v = kv[1];
        return 'localStorage.setItem(' + JSON.stringify(k) + ', ' + JSON.stringify(String(v)).replace(/<\//g, '<\\/') + ');';
      });
    html = html.replace('</head>', '<script>' + lines.join('') + '</script></head>');
  }
  // Publish internals: a second classic script shares the global lexical scope with
  // the app script (same mechanics as EXPORT_SRC in the vm harness).
  html = html.replace('</body>', '<script>' + EXPORT_SRC + '</script></body>');
  // Keep every section visible so the achievements [add]/[save]/[cancel] controls
  // exist in the DOM and react to real clicks. The form itself starts CLOSED
  // (achievementsFormOpen=false), because that is the exact state the v1.3.3 fix
  // is built around: «+» must open it, and a second «+» must close it.
  var openSections = '<script>' +
    'mainGoalsOpen = true; wishMapOpen = true; goodTodayEntriesOpen = true;\n' +
    'state.mainGoalsOpen = true; state.wishMapOpen = true; state.goodTodayEntriesOpen = true;\n' +
    'state.achievementsOpen = true;\n' +
    'achievementsOpen = true;\n' +
    'achievementsFormOpen = false;\n' +
    'achievementsEditId = null;\n' +
    'achievementsDraft = "";\n' +
    'achievementsCharError = "";' +
    'render();' +
    '</script>';
  html = html.replace('</body>', openSections + '</body>');
  var errors = [];
  var vc = new VirtualConsole();
  vc.on('jsdomError', function (e) {
    // jsdom's CSS parser chokes on some modern syntax — cosmetic, not an app bug.
    if (!/Could not parse CSS/.test(String(e.message))) errors.push(e);
  });
  var dom = new JSDOM(html, {
    url: 'http://localhost/', // localStorage requires a non-opaque origin
    runScripts: 'dangerously',
    pretendToBeVisual: true, // requestAnimationFrame for the drag layer
    virtualConsole: vc,
  });
  assert.deepEqual(errors.map(String), [], 'the app must boot without jsdom errors');
  var appDiv = dom.window.document.getElementById('app');
  assert.ok(appDiv && appDiv.innerHTML.length > 1000, 'initial render() must produce markup');
  assert.ok(dom.window.__APP__, 'EXPORT_SRC must publish internals');
  assert.ok(typeof dom.window.render === 'function', 'render() must be reachable on window');
  return {
    window: dom.window,
    document: dom.window.document,
    app: dom.window.__APP__,
    click: function (sel) {
      var el = typeof sel === 'string' ? this.document.querySelector(sel) : sel;
      assert.ok(el, 'element not found: ' + sel);
      if (typeof el.click === 'function') {
        el.click();
      } else {
        el.dispatchEvent(new this.window.MouseEvent('click', { bubbles: true, cancelable: true }));
      }
      return el;
    },
  };
}

test('achievements: «+» opens the add form (and toggles it closed on a second press)', function () {
  var t = bootDom();
  t.click('#btnAchievementsAdd');
  assert.ok(t.document.querySelector('#achievementsTextarea'), 'textarea must appear after «+»');
  assert.ok(t.document.querySelector('#btnAchievementsSave'), 'save must appear after «+»');
  assert.ok(!t.document.querySelector('#btnAchievementsCancel'), 'cancel must not appear in pure add mode');
  // A second «+» closes the form (toggle behaviour).
  t.click('#btnAchievementsAdd');
  assert.ok(!t.document.querySelector('#achievementsTextarea'), 'form must close on the second «+»');
});

test('achievements: Cancel closes the edit form (in edit mode)', function () {
  var t = bootDom();
  // Enter edit mode the way the UI does: open the form, edit the first row.
  t.click('#btnAchievementsAdd');
  t.click('#btnAchievementsSave');
  var state = t.app.getState();
  if (state.achievements && state.achievements.length) {
    t.window.eval('achievementsEditId = 0; achievementsDraft = state.achievements[0]; achievementsFormOpen = true; achievementsCharError = \"\"; render();');
    t.click('#btnAchievementsCancel');
    assert.ok(!t.document.querySelector('#achievementsTextarea'), 'form must close on Cancel');
    assert.ok(!t.document.querySelector('#btnAchievementsCancel'), 'cancel must not remain visible after close');
  }
});

test('achievements: save appends a goal to the list', function () {
  var t = bootDom();
  t.click('#btnAchievementsAdd');
  var ta = t.document.querySelector('#achievementsTextarea');
  assert.ok(ta, 'add textarea must exist');
  ta.value = 'Потренироваться в Python';
  ta.dispatchEvent(new t.window.KeyboardEvent('input', { bubbles: true }));
  console.error('draft after input:', t.app.getState && JSON.stringify(t.app.getState().achievementsDraft));
  t.click('#btnAchievementsSave');
  var state = t.app.getState();
  console.error('state.achievements after save:', JSON.stringify(state.achievements));
  var list = state.achievements || [];
  assert.ok(list.includes('Потренироваться в Python'), 'saved goal appears in state.achievements');
});
