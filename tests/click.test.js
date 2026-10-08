'use strict';
/* Click tests (jsdom): simulate real user actions against the REAL inline script from
   index.html. Owner-approved exception (08.10.2026): jsdom is the project's only dependency
   (devDependencies). These cover what the vm harness cannot: event handlers actually fire,
   mutate state and trigger a re-render. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM, VirtualConsole } = require('jsdom');
const { readProjectFile, leaf, container, EXPORT_SRC } = require('./helpers');

function bootDom() {
  let html = readProjectFile('index.html');
  // External Firebase SDKs are never fetched in tests → cloudEnabled stays false (same
  // prod guard: typeof firebase !== 'undefined').
  html = html.replace(/<script src="https:\/\/www\.gstatic\.com[^"]*"><\/script>\s*/g, '');
  // Publish internals: a second classic script shares the global lexical scope with the app
  // script (same mechanics as EXPORT_SRC in the vm harness).
  html = html.replace('</body>', `<script>${EXPORT_SRC}</script></body>`);

  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => {
    // jsdom's CSS parser chokes on some modern syntax — cosmetic, not an app bug.
    if (!/Could not parse CSS/.test(String(e.message))) errors.push(e);
  });
  const dom = new JSDOM(html, {
    url: 'http://localhost/', // localStorage requires a non-opaque origin
    runScripts: 'dangerously',
    pretendToBeVisual: true, // requestAnimationFrame for the drag layer
    virtualConsole: vc,
  });
  assert.deepEqual(errors.map(String), [], 'the app must boot without jsdom errors');
  const appDiv = dom.window.document.getElementById('app');
  assert.ok(appDiv && appDiv.innerHTML.length > 1000, 'initial render() must produce markup');
  assert.ok(dom.window.__APP__, 'EXPORT_SRC must publish internals');
  assert.ok(typeof dom.window.render === 'function', 'render() must be reachable on window');
  return {
    window: dom.window,
    document: dom.window.document,
    app: dom.window.__APP__,
    click(sel) {
      const el = typeof sel === 'string' ? this.document.querySelector(sel) : sel;
      assert.ok(el, `element not found: ${sel}`);
      el.click();
      return el;
    },
  };
}

test('top menu opens; picking English re-renders the UI in English', () => {
  const t = bootDom();
  t.click('#btnTopMenu');
  assert.ok(t.document.querySelector('.lang-menu'), 'dropdown must open');
  t.click('.lang-option[data-lang="en"]');
  assert.equal(t.document.documentElement.lang, 'en', 'html lang must switch');
  assert.ok(!t.document.querySelector('.lang-menu'), 'menu must close after picking');
});

test('add-sphere button appends a child through the real handler', () => {
  const t = bootDom();
  t.app.setState({ name: 'root', children: [container([]), container([])] });
  t.window.render();
  t.click('#btnAddGoal');
  const kids = t.app.getState().children;
  assert.equal(kids.length, 3, 'a third sphere must appear');
  assert.match(kids[2].name, /^Goal|^Цель/, 'new sphere gets the localized auto-name');
});

test('card click navigates one level deeper; #btnBack returns home', () => {
  const t = bootDom();
  const card = t.document.querySelector('[data-nav]');
  assert.ok(card, 'home must show a clickable card');
  card.click();
  assert.equal(t.app.getPath().length, 1, 'path must deepen');
  t.click('#btnBack');
  assert.equal(t.app.getPath().length, 0, 'back must return to home');
});

test('leaf page: done-toggle flips the goal through a real click', () => {
  const t = bootDom();
  t.app.setState({ name: 'root', children: [leaf(false, { name: 'Цель X' })] });
  t.window.render();
  t.click('[data-nav]');
  assert.ok(t.document.getElementById('leafToggle'), 'leaf page must show the toggle');
  t.click('#leafToggle');
  assert.equal(t.app.getState().children[0].done, true, 'goal must become done');
});

test('checklist: submitting the add-form appends an item', () => {
  const t = bootDom();
  t.app.setState({ name: 'root', children: [leaf(false, { name: 'L', checklist: [{ text: 'a', done: false }] })] });
  t.app.setPath([0]);
  t.window.render();
  const form = t.document.getElementById('checklistAddForm');
  assert.ok(form, 'checklist page must render the add form');
  t.document.getElementById('checklistInput').value = 'второй пункт';
  form.dispatchEvent(new t.window.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(t.app.getState().children[0].checklist.length, 2, 'item must be appended');
});

test('checklist delete: confirm panel opens, Yes removes the checklist and goes back', () => {
  const t = bootDom();
  t.app.setState({ name: 'root', children: [leaf(false, { name: 'L', checklist: [{ text: 'a', done: false }] })] });
  t.app.setPath([0]);
  t.window.render();
  t.click('#btnDeleteChecklist');
  assert.ok(t.document.getElementById('checklistDeleteOverlay'), 'confirm panel must open');
  t.click('#btnChecklistDeleteYes');
  assert.ok(!('checklist' in t.app.getState().children[0]), 'checklist must be removed');
  assert.equal(t.app.getState().children[0].done, false, 'collapses to an unchecked plain leaf');
  assert.equal(t.app.getPath().length, 0, 'must navigate back one level');
});
