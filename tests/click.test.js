'use strict';
/* Click tests (jsdom): simulate real user actions against the REAL inline script from
   index.html. Owner-approved exception (08.10.2026): jsdom is the project's only dependency
   (devDependencies). These cover what the vm harness cannot: event handlers actually fire,
   mutate state and trigger a re-render. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM, VirtualConsole } = require('jsdom');
const { readProjectFile, leaf, container, EXPORT_SRC } = require('./helpers');

function bootDom(seedStorage) {
  let html = readProjectFile('index.html');
  // External Firebase SDKs are never fetched in tests → cloudEnabled stays false (same
  // prod guard: typeof firebase !== 'undefined').
  html = html.replace(/<script src="https:\/\/www\.gstatic\.com[^"]*"><\/script>\s*/g, '');
  // Optional pre-seed: this script runs BEFORE the app, so a simulated "reload" can boot
  // from previously saved localStorage data.
  if (seedStorage) {
    const lines = Object.entries(seedStorage)
      .map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(String(v)).replace(/<\//g, '<\\/')});`)
      .join('');
    html = html.replace('</head>', `<script>${lines}</script></head>`);
  }
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

test('persistence: a saved tree survives a page reload', () => {
  const t1 = bootDom();
  t1.app.setState({
    name: 'root',
    children: [leaf(true, { name: 'Готово' }), container([leaf(false)], { total: 3 })],
  });
  t1.app.saveState();
  const raw = t1.window.localStorage.getItem(t1.app.STORAGE_KEY);
  assert.ok(raw && raw.includes('Готово'), 'state must be persisted to localStorage');

  // "Reload": a fresh page booting from the same storage.
  const t2 = bootDom({ [t1.app.STORAGE_KEY]: raw });
  const loaded = t2.app.getState();
  assert.ok(t2.app.isValidGoalTree(loaded), 'reloaded tree must pass the shape gate');
  assert.equal(loaded.children.length, 2, 'both children must come back');
  assert.equal(loaded.children[0].name, 'Готово', 'names must survive');
  assert.equal(loaded.children[0].done, true, 'done flags must survive');
  assert.equal(loaded.children[1].totalGoalsAdded, 3, 'sticky wheel totals must survive');
});

// ===== Archive toggle (leaf page) =====
test('leaf page: archive button flips the archived flag and re-renders', () => {
  const t = bootDom();
  t.app.setState({ name: 'root', children: [leaf(false, { name: 'Цель X' })] });
  t.window.render();
  t.click('[data-nav]');
  assert.ok(t.document.getElementById('btnArchive'), 'leaf page must show the archive button');
  t.click('#btnArchive');
  assert.ok(t.app.getState().children[0].archived, 'goal must be marked archived');
  // after re-render the button has 'active' class
  assert.ok(t.document.getElementById('btnArchive').classList.contains('active'), 'archive button must become active');
});

// ===== Priority toggle (leaf page) =====
test('leaf page: priority star toggles and re-renders', () => {
  const t = bootDom();
  t.app.setState({ name: 'root', children: [leaf(false, { name: 'Цель X' })] });
  t.window.render();
  t.click('[data-nav]');
  assert.ok(t.document.getElementById('btnTogglePriority'), 'leaf page must show the priority star');
  t.click('#btnTogglePriority');
  assert.ok(t.app.getState().children[0].priority, 'goal must be marked priority');
  assert.ok(t.document.getElementById('btnTogglePriority').classList.contains('active'), 'star must become active');
});

// ===== Inline rename (edit mode turns every card into a text input) =====
// There is no dedicated "renameInput" element: entering edit mode re-renders each card as an
// inline <input class="goal-input" data-goal-idx>, whose blur/Enter handlers commit the new name
// (see attachInlineEditHandlers in index.html). So the real click-through is:
// tap #btnEdit → type into the card's input → press Enter → name is saved and edit mode exits.
test('container page: edit mode turns a card into an inline input; Enter saves the rename', () => {
  const t = bootDom();
  t.app.setState({ name: 'root', children: [container([leaf(false, { name: 'Старое имя' })])] });
  t.app.setPath([0]);
  t.window.render();
  const btnEdit = t.document.getElementById('btnEdit');
  assert.ok(btnEdit, 'container page must show the edit button');
  assert.ok(!btnEdit.classList.contains('active'), 'edit mode must start as off');
  t.click('#btnEdit');
  // Each card is now an editable input prefilled with its current name.
  const goalInput = t.document.querySelector('input.goal-input[data-goal-idx="0"]');
  assert.ok(goalInput, 'edit mode must render an inline rename input for the card');
  assert.equal(goalInput.value, 'Старое имя', 'input must be prefilled with the current name');
  goalInput.focus();
  goalInput.value = 'Новое имя';
  // Enter blurs the field (committing the name) and then turns edit mode off.
  goalInput.dispatchEvent(new t.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert.equal(t.app.getState().children[0].children[0].name, 'Новое имя', 'Enter must save the renamed child');
});

// ===== Move-checklist toggle (checklist page) =====
test('checklist page: move-checklist toggle turns on move mode', () => {
  const t = bootDom();
  t.app.setState({ name: 'root', children: [leaf(false, { name: 'L', checklist: [{ text: 'a', done: false }] })] });
  t.app.setPath([0]);
  t.window.render();
  // re-fetch after render
  let btnMoveChecklist = t.document.getElementById('btnMoveChecklist');
  assert.ok(btnMoveChecklist, 'checklist page must show the move-checklist button');
  assert.ok(!btnMoveChecklist.classList.contains('active'), 'move mode must start as off');
  t.click('#btnMoveChecklist');
  // after re-render, get the fresh element
  btnMoveChecklist = t.document.getElementById('btnMoveChecklist');
  assert.ok(btnMoveChecklist, 'move-checklist button must exist after click');
  assert.ok(btnMoveChecklist.classList.contains('active'), 'move checklist must become active');
});

// ===== Relocate (two-step: arm the mode, then tap a card to open the destination picker) =====
// Tapping #btnRelocate only flips relocateMode on (button turns .active, cards become selectable);
// it does NOT open the picker by itself. The picker (relocateOverlay) appears only after a card
// is tapped — that sets relocateSourcePath, which is what gates relocatePickerHTML() in render().
test('container page: relocate is two-step — arm mode, tap a card to open the picker, close dismisses', () => {
  const t = bootDom();
  t.app.setState({ name: 'root', children: [container([leaf(false, { name: 'Подвижная цель' })])] });
  t.app.setPath([0]);
  t.window.render();
  const btnRelocate = t.document.getElementById('btnRelocate');
  assert.ok(btnRelocate, 'container page must show the relocate button');
  assert.ok(!btnRelocate.classList.contains('active'), 'relocate mode must start as off');
  // Step 1: arm relocate mode — flips the button, but no picker yet.
  t.click('#btnRelocate');
  assert.ok(t.document.getElementById('btnRelocate').classList.contains('active'), 'relocate button must become active');
  assert.ok(!t.document.getElementById('relocateOverlay'), 'arming relocate alone must not open the picker');
  // Step 2: tap a card to choose the source — only now does the destination picker open.
  assert.ok(t.document.querySelector('[data-relocate-idx]'), 'relocate mode must make each card selectable');
  t.click('[data-relocate-idx]');
  assert.ok(t.document.getElementById('relocateOverlay'), 'tapping a card must open the destination picker');
  // Dismiss via the close button.
  t.click('#btnRelocateClose');
  assert.ok(!t.document.getElementById('relocateOverlay'), 'close must dismiss the picker');
});

test('theme switcher changes the root data-theme attribute', () => {
  const t = bootDom();
  let root = t.document.documentElement;
  let initial = root.getAttribute('data-theme');
  // open the top menu so the theme row is rendered
  t.click('#btnTopMenu');
  assert.ok(t.document.querySelector('.lang-menu'), 'menu must open');
  const options = t.document.querySelectorAll('.theme-option');
  assert.ok(options.length > 0, 'theme options must be rendered');
  const choice = [...options].find(opt => opt.dataset.themeChoice !== initial);
  assert.ok(choice, 'must be a different theme than the current one');
  choice.click();
  // the menu closes and the root theme updates
  assert.ok(!t.document.querySelector('.lang-menu'), 'menu must close');
  assert.equal(root.getAttribute('data-theme'), choice.dataset.themeChoice, 'root data-theme must update');
});
