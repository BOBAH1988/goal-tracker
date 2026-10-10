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
   // External quotes.js is never fetched in tests → QUOTES array stays empty (fallback in app script).
   html = html.replace(/<script src="quotes\.js"><\/script>\s*/g, '');
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

// ===== Undo-delete toast (lives in document.body, survives render()'s innerHTML rebuild) =====
test('delete shows an undo toast; clicking Undo restores the deleted goal', () => {
  const t = bootDom();
  // Two spheres so deleting one stays above the home floor (min 1) and doesn't collapse anything.
  t.app.setState({ name: 'root', children: [leaf(false, { name: 'Оставить' }), leaf(false, { name: 'Удалить' })] });
  t.window.render();
  assert.equal(t.app.getState().children.length, 2, 'seed must have two spheres');
  // Delete mode is two-step: arm it, then click the red card.
  t.click('#btnDelete');
  const redCard = t.document.querySelector('[data-delete-idx="1"]');
  assert.ok(redCard, 'delete mode must expose a red card for the second sphere');
  redCard.click();
  assert.equal(t.app.getState().children.length, 1, 'the second sphere must be deleted');
  // The toast is appended to document.body (outside #app), so it survives the re-render.
  const toast = t.document.querySelector('.undo-toast');
  assert.ok(toast, 'an undo toast must appear after a delete');
  const undoBtn = toast.querySelector('button');
  assert.ok(undoBtn, 'the toast must carry an Undo button');
  undoBtn.click();
  assert.equal(t.app.getState().children.length, 2, 'Undo must restore the deleted sphere');
  assert.equal(t.app.getState().children[1].name, 'Удалить', 'the restored sphere keeps its name');
  assert.ok(!t.document.querySelector('.undo-toast'), 'the toast must be gone after Undo');
});

// ===== Global search (opened from the topbar button; live results without losing input focus) =====
test('global search: opens from the topbar button, finds a goal by name and navigates to it', () => {
  const t = bootDom();
  t.app.setState({
    name: 'root',
    children: [
      leaf(false, { name: 'Выучить Go', checklist: [{ text: 'пройти туториал', done: false }] }),
      leaf(false, { name: 'Больше спорта' }),
    ],
  });
  t.window.render();

  // Launch the search panel from the topbar search button (no menu involved).
  t.click('#btnSearch');
  assert.ok(t.document.getElementById('searchOverlay'), 'search overlay must open from the topbar button');
  const input = t.document.getElementById('searchInput');
  assert.ok(input, 'search input must be present');

  // Typing re-renders results without a full render() (focus stays in the field).
  input.value = 'спорт';
  input.dispatchEvent(new t.window.Event('input', { bubbles: true }));
  const rows = t.document.querySelectorAll('#searchResults .search-result');
  assert.equal(rows.length, 1, 'exactly one goal must match «спорт»');
  assert.ok(rows[0].textContent.includes('Больше спорта'), 'the matching goal must be shown');

  // Tapping the result navigates to its path and closes the panel.
  rows[0].click();
  assert.deepEqual(Array.from(t.app.getPath()), [1], 'must navigate to the matched sphere');
  assert.ok(!t.document.getElementById('searchOverlay'), 'panel must close after picking a hit');
});

test('global search: matches checklist item text and reports empty for no match', () => {
  const t = bootDom();
  t.app.setState({
    name: 'root',
    children: [leaf(false, { name: 'Выучить Go', checklist: [{ text: 'пройти туториал', done: false }] })],
  });
  t.window.render();

  t.click('#btnSearch');
  const input = t.document.getElementById('searchInput');
  const box = t.document.getElementById('searchResults');

  // A checklist item's text is findable and navigates to its owning leaf.
  input.value = 'туториал';
  input.dispatchEvent(new t.window.Event('input', { bubbles: true }));
  assert.equal(box.querySelectorAll('.search-result').length, 1, 'checklist item must be findable');

  // A query that matches nothing shows the empty state, not a stale row.
  input.value = 'щщщ';
  input.dispatchEvent(new t.window.Event('input', { bubbles: true }));
  assert.equal(box.querySelectorAll('.search-result').length, 0, 'no rows for a non-match');
  assert.match(box.textContent, /Ничего не найдено/, 'empty state must be rendered');
});

// ===== Main goals collapsible («Главные цели» — open by default, click collapses, state saved) =====
test('main goals list: open by default, click collapses and persists across reload', () => {
  const t = bootDom();
  t.app.setState({ name: 'root', children: [leaf(false, { name: 'Цель 1' }), leaf(false, { name: 'Цель 2' })] });
  t.window.render();
  // By default the grid is open: cards are visible.
  assert.ok(t.document.querySelector('.grid-goals'), 'main goals grid must be visible by default (open)');
  assert.ok(t.document.querySelector('.grid-goals').children.length > 0, 'cards must render when open');
  // Arrow points down when expanded.
  assert.equal(t.document.querySelector('.main-goals-arrow').textContent, '▾', 'arrow must point down when open');

  // Click the toggle → collapses.
  t.click('#mainGoalsToggle');
  assert.equal(t.app.getState().mainGoalsOpen, false, 'clicking must persist mainGoalsOpen=false in state');
  assert.ok(!t.document.querySelector('.grid-goals'), 'grid must disappear when collapsed');
  assert.equal(t.document.querySelector('.main-goals-arrow').textContent, '▸', 'arrow must point right when collapsed');

  // Reload from saved storage → stays collapsed.
  const raw = t.window.localStorage.getItem(t.app.STORAGE_KEY);
  assert.ok(raw && raw.includes('"mainGoalsOpen":false'), 'collapsed state must be serialized to localStorage');
  const t2 = bootDom({ [t.app.STORAGE_KEY]: raw });
  assert.equal(t2.app.getState().mainGoalsOpen, false, 'persisted state must read back as collapsed');
  assert.ok(!t2.document.querySelector('.grid-goals'), 'after reload, main goals must stay collapsed');

  // Click again → expands.
  t2.click('#mainGoalsToggle');
  assert.equal(t2.app.getState().mainGoalsOpen, true, 'clicking again must persist mainGoalsOpen=true');
  assert.ok(t2.document.querySelector('.grid-goals'), 'grid must reappear when expanded');
});

// ===== Balance wheel collapsible («Колесо баланса» — open by default, click collapses, state saved) =====
test('balance wheel: open by default, click collapses and persists across reload', () => {
  const t = bootDom();
  t.app.setState({ name: 'root', children: [leaf(false, { name: 'Цель 1' }), leaf(false, { name: 'Цель 2' })] });
  t.window.render();
  // By default the wheel is visible.
  assert.ok(t.document.getElementById('wheelWrap'), 'balance wheel must be visible by default (open)');
  assert.equal(t.document.querySelector('.wheel-arrow').textContent, '▾', 'arrow must point down when open');

  // Click the toggle → collapses.
  t.click('#wheelToggle');
  assert.equal(t.app.getState().wheelOpen, false, 'clicking must persist wheelOpen=false in state');
  assert.ok(!t.document.getElementById('wheelWrap'), 'wheel must disappear when collapsed');
  assert.equal(t.document.querySelector('.wheel-arrow').textContent, '▸', 'arrow must point right when collapsed');

  // Reload from saved storage → stays collapsed.
  const raw = t.window.localStorage.getItem(t.app.STORAGE_KEY);
  assert.ok(raw && raw.includes('"wheelOpen":false'), 'collapsed state must be serialized to localStorage');
  const t2 = bootDom({ [t.app.STORAGE_KEY]: raw });
  assert.equal(t2.app.getState().wheelOpen, false, 'persisted state must read back as collapsed');
  assert.ok(!t2.document.getElementById('wheelWrap'), 'after reload, wheel must stay collapsed');

  // Click again → expands.
  t2.click('#wheelToggle');
  assert.equal(t2.app.getState().wheelOpen, true, 'clicking again must persist wheelOpen=true');
  assert.ok(t2.document.getElementById('wheelWrap'), 'wheel must reappear when expanded');
});

// ===== Search topbar button (quick-launch shortcut added alongside the menu item) =====
test('topbar search button opens the search panel without opening the menu', () => {
  const t = bootDom();
  assert.ok(t.document.getElementById('btnSearch'), 'topbar must show a search button');
  assert.ok(!t.document.getElementById('searchOverlay'), 'panel must start closed');
  t.click('#btnSearch');
  assert.ok(t.document.getElementById('searchOverlay'), 'clicking the topbar button must open the search panel');
  assert.ok(!t.document.querySelector('.lang-menu'), 'top menu must not be open at the same time');
  assert.ok(t.document.getElementById('searchInput'), 'search input must be focused-ready');
});

// ===== Reset to defaults (menu: «Сбросить на стандартные») =====
test('reset button: confirms, then wipes localStorage and reloads', () => {
  const t = bootDom();
  t.app.setState({ name: 'root', children: [leaf(true, { name: 'Готово' })] });
  t.app.saveState();
  assert.ok(t.window.localStorage.getItem(t.app.STORAGE_KEY), 'state must be saved before reset');

  // Stub confirm → true. reload() throws in jsdom, but localStorage.removeItem runs before it.
  t.window.confirm = () => true;
  t.click('#btnTopMenu');
  try { t.click('#btnResetData'); } catch(e) {}
  assert.ok(!t.window.localStorage.getItem(t.app.STORAGE_KEY), 'localStorage must be wiped after reset');
});

test('reset button: on cancel nothing is wiped', () => {
  const t = bootDom();
  t.app.setState({ name: 'root', children: [leaf(false, { name: 'Цель' })] });
  t.app.saveState();
  const before = t.window.localStorage.getItem(t.app.STORAGE_KEY);

  t.window.confirm = () => false;
  t.click('#btnTopMenu');
  t.click('#btnResetData');
  assert.equal(t.window.localStorage.getItem(t.app.STORAGE_KEY), before, 'localStorage must be untouched on cancel');
});

// ===== «Три важных дела на сегодня» — collapsible + checkbox + inline text edit =====
test('today block: open by default, toggle checkbox updates done, edit text saves on blur', () => {
  const t = bootDom();
  t.app.setState({ name: 'root', children: [leaf(false, { name: 'Цель' })], today: [{text:'Первое дело',done:false},{text:'Второе дело',done:true},{text:'',done:false}] });
  t.window.render();

  // Block is open by default with 3 items.
  assert.ok(t.document.getElementById('todayToggle'), 'today toggle header must exist');
  assert.ok(t.document.getElementById('wheelWrap') || true, 'wheel is not required for this test'); // sanity
  const rows = t.document.querySelectorAll('[data-today-toggle]');
  assert.equal(rows.length, 3, 'must render exactly 3 today items');

  // Checkbox toggle: click item 0 → done flips true.
  rows[0].click();
  assert.equal(t.app.getState().today[0].done, true, 'checkbox must flip done=true');
  t.window.render();
  assert.ok(t.document.querySelector('[data-today-toggle="0"]').classList.contains('done'), 'checkbox must show .done class');

  // Inline text edit: change input value, blur → saved.
  const input = t.document.querySelector('[data-today-edit="0"]');
  assert.ok(input, 'text input must be present');
  input.value = 'Отредактированное дело';
  input.dispatchEvent(new t.window.Event('input', { bubbles: true }));
  input.dispatchEvent(new t.window.Event('blur', { bubbles: true }));
  assert.equal(t.app.getState().today[0].text, 'Отредактированное дело', 'edited text must be saved on blur');

  // Collapse persists.
  t.click('#todayToggle');
  assert.equal(t.app.getState().todayOpen, false, 'todayOpen=false must persist');
  assert.ok(!t.document.querySelector('[data-today-toggle="0"]'), 'items must disappear when collapsed');
});

test('today block: collapses and remembers state across reload', () => {
  const t = bootDom();
  t.app.setState({ name: 'root', children: [leaf(false, { name: 'Цель' })], today: [{text:'a',done:false},{text:'b',done:false},{text:'c',done:false}] });
  t.window.render();

  // Collapse, then reload from saved storage → stays collapsed.
  t.click('#todayToggle');
  assert.equal(t.app.getState().todayOpen, false, 'clicking must persist todayOpen=false');
  const raw = t.window.localStorage.getItem(t.app.STORAGE_KEY);
  const t2 = bootDom({ [t.app.STORAGE_KEY]: raw });
  assert.equal(t2.app.getState().todayOpen, false, 'persisted state must read back as collapsed');
  assert.ok(!t2.document.querySelector('[data-today-toggle="0"]'), 'after reload, today items must stay collapsed');

  // Expand again.
  t2.click('#todayToggle');
  assert.equal(t2.app.getState().todayOpen, true, 'clicking again must persist todayOpen=true');
  assert.ok(t2.document.querySelector('[data-today-toggle="0"]'), 'items must reappear when expanded');
});

// ===== Today block: action button (trash ↔ green check), checkbox strike-through =====
test('today block: action button is trash by default, checkmark only during active input', () => {
  const t = bootDom();
  t.app.setState({
    name: 'root', children: [leaf(false, { name: 'Цель' })],
    today: [{text:'Готово',done:false},{text:'',done:true},{text:'Третье',done:false}],
  });
  t.window.render();

  // By default (no focus) all buttons show trash — even item 0 which has text.
  const btn0 = t.document.querySelector('[data-today-action="0"]');
  const btn1 = t.document.querySelector('[data-today-action="1"]');
  assert.ok(btn0 && btn1, 'action buttons must exist');
  assert.match(btn0.innerHTML, /ti-trash/, 'trash must show by default, even when text exists');
  assert.match(btn1.innerHTML, /ti-trash/, 'trash must show for empty item');

  // Item 1 is done=true → input has .done class (strikethrough).
  const input1 = t.document.querySelector('[data-today-edit="1"]');
  assert.ok(input1.classList.contains('done'), 'done item input must carry .done class for strikethrough');

  // Focus an empty input + type → button flips to checkmark.
  input1.focus();
  input1.value = 'Новое';
  input1.dispatchEvent(new t.window.Event('input', { bubbles: true }));
  assert.match(btn1.innerHTML, /ti-check/, 'button must flip to checkmark during active input with text');
  assert.equal(t.app.getState().today[1].text, 'Новое', 'typed text must land in state');

  // Click the checkmark (mousedown) → saves and re-renders; button reverts to trash.
  btn1.dispatchEvent(new t.window.Event('mousedown', { bubbles: true }));
  assert.equal(t.app.getState().today[1].text, 'Новое', 'checkmark click must persist text');

  // Checkbox toggle → done flips, strikethrough applies after re-render.
  const chk = t.document.querySelector('[data-today-toggle="2"]');
  chk.click();
  assert.equal(t.app.getState().today[2].done, true, 'checkbox must flip done');
  assert.ok(t.document.querySelector('[data-today-edit="2"]').classList.contains('done'), 'done input must get .done class after toggle');
});

// ===== Overall progress block: motivational quotes row =====
test('overall progress block: shows quote row with refresh button, clicking refresh updates state', () => {
  const t = bootDom();
  t.app.setState({
    name: 'root', children: [leaf(false, { name: 'Цель' })],
    today: [{text:'',done:false},{text:'',done:false},{text:'',done:false}],
    quoteText: 'Тестовая цитата для проверки.'
  });
  t.window.render();

  // Quote row must exist inside the overall progress block.
  const quoteInput = t.document.querySelector('[data-quote-display]');
  const refreshBtn = t.document.querySelector('[data-quote-refresh]');
  assert.ok(quoteInput, 'quote display input must exist in overall progress block');
  assert.ok(refreshBtn, 'quote refresh button must exist in overall progress block');
  // Quote lives under the progress bar, not in the collapsible today list.
  assert.ok(quoteInput.closest('.overall'), 'quote row must sit inside the overall progress card');

  // Input shows the quote text from state.
  assert.match(quoteInput.value, /Тестовая цитата/, 'quote input must show state.quoteText');

  // Clicking refresh updates state with a new quote from fallback array.
  refreshBtn.click();
  const newText = t.app.getState().quoteText;
  assert.ok(newText, 'refresh must set a new quoteText in state');
  assert.notEqual(newText, 'Тестовая цитата для проверки.', 'refresh must pick a different quote');

  // Quote row survives re-render.
  t.window.render();
  assert.ok(t.document.querySelector('[data-quote-display]'), 'quote row must survive re-render');
});

// ===== "Установить приложение" menu item =====
test('install app: menu item shows the instructions modal when no native prompt is available', () => {
  const t = bootDom();
  // Desktop UA in jsdom (no Android/iPhone) → not a mobile device, so the desktop instructions apply.
  t.click('#btnTopMenu');
  assert.ok(t.document.getElementById('btnInstallAppMenuItem'), 'install item must be present in the menu');
  t.click('#btnInstallAppMenuItem');
  const overlay = t.document.getElementById('installOverlay');
  assert.ok(overlay, 'clicking the item without a native prompt must open the instructions modal');
  // Desktop instructions (the ru locale default) must be shown, not the Android ones.
  assert.match(overlay.textContent, /адресной строке/i, 'desktop install instructions must be rendered');
  assert.ok(!t.document.getElementById('btnInstallNow'), 'no native "install now" button without a deferred prompt');
});

test('install app: a captured beforeinstallprompt installs directly instead of showing instructions', () => {
  const t = bootDom();
  // Simulate Chrome/Edge firing beforeinstallprompt before the user clicks the menu item.
  let prompted = false;
  const ev = new t.window.Event('beforeinstallprompt');
  ev.preventDefault = () => {};
  ev.prompt = () => { prompted = true; return Promise.resolve(); };
  ev.userChoice = Promise.resolve({ outcome: 'accepted' });
  t.window.dispatchEvent(ev);

  t.click('#btnTopMenu');
  t.click('#btnInstallAppMenuItem');
  assert.equal(prompted, true, 'the native install prompt() must fire immediately');
  assert.ok(!t.document.getElementById('installOverlay'), 'the instructions modal must NOT open when installing natively');
});

// ===== "Доступно обновление" offer modal (replaces the manual "Update app" menu item) =====
test('update offer: modal opens, ✕ postpones it, apply button closes it safely', () => {
  const t = bootDom();
  assert.ok(!t.document.getElementById('updateOverlay'), 'offer modal must start closed');
  t.app.offerAppUpdate();
  const overlay = t.document.getElementById('updateOverlay');
  assert.ok(overlay, 'offerAppUpdate() must open the modal');
  assert.match(overlay.textContent, /Доступно обновление/, 'ru title must be rendered');
  assert.match(overlay.textContent, /Обновить/, 'the confirm button label must be rendered');
  assert.ok(t.document.getElementById('btnUpdateClose'), '✕ (close) button must be present in the top-right');
  // ✕ = "not now": the modal hides and the pending update is simply left waiting.
  t.click('#btnUpdateClose');
  assert.ok(!t.document.getElementById('updateOverlay'), '✕ must dismiss the modal');
  // Confirming without a waiting worker (jsdom has no serviceWorker) must be a safe no-op:
  // no exception, modal closes, the app keeps running.
  t.app.offerAppUpdate();
  t.click('#btnUpdateApply');
  assert.ok(!t.document.getElementById('updateOverlay'), 'apply must close the modal');
  // Re-offering while already open must not stack a second prompt.
  t.app.offerAppUpdate();
  t.app.offerAppUpdate();
  assert.ok(t.document.getElementById('updateOverlay'), 'the modal stays open after a repeat offer');
});

test('menu: the manual "Update app" item is removed', () => {
  const t = bootDom();
  t.click('#btnTopMenu');
  assert.ok(t.document.querySelector('.lang-menu'), 'top menu must open');
  assert.ok(!t.document.getElementById('btnUpdateApp'), 'btnUpdateApp must be gone from the menu');
  assert.ok(t.document.getElementById('btnInstallAppMenuItem'), 'install item must stay untouched');
});

// ===== Home goals sort dropdown (#btnFilter) =====
function cardNavOrder(t) {
  return Array.from(t.document.querySelectorAll('.grid-goals [data-nav]')).map(el => el.dataset.nav);
}
test('goals sort: filter button opens a menu; picking an order re-ranks the cards and persists', () => {
  const t = bootDom();
  // children deliberately out of percent order: low(0), full(100), half(50), plus an archived one.
  t.app.setState({
    name: 'root',
    children: [
      leaf(false, { name: 'Низкая' }),
      container([leaf(true), leaf(true)], { name: 'Полная', total: 2 }),
      container([leaf(true), leaf(false)], { name: 'Половина', total: 2 }),
      container([leaf(true), leaf(true)], { name: 'В архиве', total: 2, archived: true }),
    ],
  });
  t.window.render();

  // Default is custom (stored) order; menu is closed until the button is pressed.
  assert.ok(!t.document.getElementById('filterMenu'), 'sort menu must be closed by default');
  assert.deepEqual(cardNavOrder(t), ['0', '1', '2', '3'], 'custom order keeps stored sequence (archived already last here)');

  t.click('#btnFilter');
  const menu = t.document.getElementById('filterMenu');
  assert.ok(menu, 'clicking the filter button must open the sort menu');
  assert.ok(t.document.querySelector('[data-sort="desc"]'), 'menu must offer descending');
  assert.ok(t.document.querySelector('[data-sort="asc"]'), 'menu must offer ascending');
  assert.ok(t.document.querySelector('[data-sort="custom"]'), 'menu must offer custom order');
  // Custom is the active default → its button carries .active.
  assert.ok(t.document.querySelector('[data-sort="custom"]').classList.contains('active'), 'custom must be marked active by default');

  // Pick "по убыванию": highest completion first, archived sinks to the end.
  t.click('[data-sort="desc"]');
  assert.equal(t.app.getState().goalsSort, 'desc', 'chosen sort must be written to state');
  assert.ok(!t.document.getElementById('filterMenu'), 'picking an option must close the menu');
  // indices: Полная(1,100%) → Половина(2,50%) → Низкая(0,0%) → В архиве(3, archived last)
  assert.deepEqual(cardNavOrder(t), ['1', '2', '0', '3'], 'desc must rank by completion high→low, archived last');

  // Pick "по возрастанию": reversed active order, archived still last.
  t.click('#btnFilter');
  t.click('[data-sort="asc"]');
  assert.deepEqual(cardNavOrder(t), ['0', '2', '1', '3'], 'asc must rank by completion low→high, archived last');

  // Choice persists across a reload (round-trips like the other home-screen toggles).
  const raw = t.window.localStorage.getItem(t.app.STORAGE_KEY);
  assert.ok(raw && raw.includes('"goalsSort":"asc"'), 'sort choice must serialize to localStorage');
  const t2 = bootDom({ [t.app.STORAGE_KEY]: raw });
  assert.equal(t2.app.getState().goalsSort, 'asc', 'persisted sort must read back');
  assert.deepEqual(cardNavOrder(t2), ['0', '2', '1', '3'], 'restored sort must re-rank on boot');
});

test('goals sort: same filter works on a subgoal page, not just the home screen', () => {
  const t = bootDom();
  // One top-level container holding subgoals with mixed completion (low/full/half) + archived.
  t.app.setState({
    name: 'root',
    children: [
      container([
        leaf(false, { name: 'Низкая' }),
        container([leaf(true), leaf(true)], { name: 'Полная', total: 2 }),
        container([leaf(true), leaf(false)], { name: 'Половина', total: 2 }),
        container([leaf(true), leaf(true)], { name: 'В архиве', total: 2, archived: true }),
      ], { name: 'Сфера', total: 4 }),
    ],
  });
  t.window.render();
  // Drill into the container (its page uses nodeViewHTML, not homeViewHTML).
  t.click('.grid-goals [data-nav]');
  assert.ok(t.document.getElementById('btnAddChild'), 'must be on the subgoal container page');
  assert.ok(t.document.getElementById('btnFilter'), 'filter button must exist on the subgoal page too');

  t.click('#btnFilter');
  t.click('[data-sort="desc"]');
  // Полная(1,100%) → Половина(2,50%) → Низкая(0,0%) → В архиве(3, archived last)
  assert.deepEqual(cardNavOrder(t), ['1', '2', '0', '3'], 'desc must rank subgoals by completion, archived last');
});

// ===== Wish map («Карта желаний») — optional vision board under the balance wheel =====

test('wish map: header card manager replaces per-card edit/delete buttons', () => {
  const t = bootDom();
  t.app.setState(Object.assign(t.app.getState(), {
    wishMap: [
      { src: 'data:image/jpeg;base64,AAA', caption: 'Море' },
      { src: 'data:image/jpeg;base64,BBB', caption: 'Горы' },
    ],
  }));
  t.window.render();
  // Cards no longer carry their own action buttons.
  assert.ok(t.document.querySelectorAll('.wish-card').length === 2, 'both cards render');
  assert.ok(!t.document.querySelector('[data-wish-edit]'), 'cards must not carry an edit button');
  assert.ok(!t.document.querySelector('[data-wish-del]'), 'cards must not carry a delete button');
  assert.ok(!t.document.querySelector('.wish-actions'), 'the corner action group is gone');
  // The header «+» and the manager button sit together.
  assert.ok(t.document.getElementById('btnWishAdd'), 'the add button stays in the header');
  assert.ok(t.document.getElementById('btnWishManage'), 'the manager button lives next to it');
  // Both live in ONE right-aligned flex group (like .add-goal-wrap in «Главные цели»),
  // so neither drifts to the centre between title and its sibling.
  const group = t.document.querySelector('.wish-header-actions');
  assert.ok(group, 'header buttons must share one group element');
  assert.ok(group.contains(t.document.getElementById('btnWishAdd')), '«+» belongs to the group');
  assert.ok(group.contains(t.document.getElementById('btnWishManage')), 'the manager belongs to the same group');
  assert.equal(group.children.length, 2, 'the group holds exactly the two buttons');
  // The group is the LAST child of the header row → pushed to the right by space-between.
  const headerRow = t.document.querySelector('.section-title-row:has(#wishToggle)');
  assert.ok(headerRow && headerRow.lastElementChild === group, 'the group must sit on the right edge');
  // Opening the manager lists every card with its caption.
  t.click('#btnWishManage');
  const overlay = t.document.getElementById('wishManageOverlay');
  assert.ok(overlay, 'the manager overlay must open');
  const rows = t.document.querySelectorAll('.wish-manage-row');
  assert.equal(rows.length, 2, 'every card gets a row');
  assert.match(t.document.getElementById('app').innerHTML, /Море/, 'captions are listed');
  assert.equal(t.document.querySelectorAll('[data-wish-manage-edit]').length, 2, 'each row can be edited');
  assert.equal(t.document.querySelectorAll('[data-wish-manage-del]').length, 2, 'each row can be deleted');
  // ✕ closes the manager without touching any card.
  t.click('#btnWishManageClose');
  assert.ok(!t.document.getElementById('wishManageOverlay'), 'close button dismisses the manager');
  assert.equal(t.app.getState().wishMap.length, 2, 'closing must not delete anything');
  // Adding a new card closes the manager so the form is not blocked by the list.
  t.click('#btnWishManage');
  t.click('#btnWishAdd');
  assert.ok(t.document.getElementById('wishFile'), 'the add form opens');
  assert.ok(!t.document.getElementById('wishManageOverlay'), 'opening the add form closes the manager');
  // Collapsing the section closes the manager too (no hidden overlay lingers).
  t.click('#btnWishCancel');
  t.click('#btnWishManage');
  assert.ok(t.document.getElementById('wishManageOverlay'), 'manager reopened');
  t.click('#wishToggle');
  assert.ok(!t.document.getElementById('wishManageOverlay'), 'collapsing the section closes the manager');
});

test('wish map: empty state offers the add button; Save without an image is refused', () => {
  const t = bootDom();
  assert.match(t.document.getElementById('app').innerHTML, /Карта желаний/, 'the board title must be on the home screen');
  assert.ok(t.document.getElementById('btnWishAddEmpty'), 'empty board must show «+ Добавить желание»');
  assert.ok(!t.document.querySelector('.wish-card'), 'a fresh board has no cards');
  t.click('#btnWishAddEmpty');
  assert.ok(t.document.getElementById('wishFile'), 'the add form must open with a file input');
  // A caption typed before picking a file must survive the refused save attempt.
  t.document.getElementById('wishCaptionInput').value = 'Дом у моря';
  t.click('#btnWishSave');
  assert.equal(t.app.getState().wishMap.length, 0, 'a card cannot be saved without an image');
  const err = t.document.querySelector('.wish-form .auth-error');
  assert.ok(err && /изображение/.test(err.textContent), 'the form must explain what is missing');
  assert.equal(t.document.getElementById('wishCaptionInput').value, 'Дом у моря', 'typed caption survives the refusal');
  t.click('#btnWishCancel');
  assert.ok(!t.document.getElementById('wishFile'), 'cancel must close the form');
  assert.ok(t.document.getElementById('btnWishAddEmpty'), 'empty state must come back after cancel');
});

test('wish map: card opens the lightbox, caption edits persist, delete asks first', () => {
  const t = bootDom();
  t.app.setState(Object.assign(t.app.getState(), {
    wishMap: [{ src: 'data:image/jpeg;base64,AAA', caption: 'Море' }],
  }));
  t.window.render();
  assert.ok(t.document.querySelector('.wish-card'), 'the seeded card must render');
  // Tap the card → enlarged image; ✕ closes it.
  t.click('[data-wish-open="0"]');
  assert.ok(t.document.getElementById('wishLightbox'), 'tapping a card must enlarge the image');
  t.click('#btnWishLightboxClose');
  assert.ok(!t.document.getElementById('wishLightbox'), '✕ must close the lightbox');
  // Header manager button → list of pictures; pencil opens the caption dialog.
  t.click('#btnWishManage');
  assert.ok(t.document.getElementById('wishManageOverlay'), 'manager button must open the card list');
  t.click('[data-wish-manage-edit="0"]');
  assert.ok(t.document.getElementById('wishEditOverlay'), 'pencil must open the caption dialog');
  t.document.getElementById('wishEditInput').value = 'Южное побережье';
  t.click('#btnWishEditSave');
  assert.equal(t.app.getState().wishMap[0].title, 'Южное побережье', 'new caption must persist in state');
  const raw = t.window.localStorage.getItem(t.app.STORAGE_KEY);
  assert.ok(raw && raw.includes('Южное побережье'), 'caption must round-trip through localStorage');
  // Trash in the manager → confirmation; declining keeps the card (and the list open),
  // confirming removes it.
  t.window.confirm = () => false;
  t.click('#btnWishManage');
  t.click('[data-wish-manage-del="0"]');
  assert.equal(t.app.getState().wishMap.length, 1, 'declined delete must keep the card');
  assert.ok(t.document.getElementById('wishManageOverlay'), 'declined delete keeps the manager open');
  t.window.confirm = () => true;
  t.click('[data-wish-manage-del="0"]');
  assert.equal(t.app.getState().wishMap.length, 0, 'confirmed delete must remove the card');
  assert.ok(t.document.getElementById('btnWishAddEmpty'), 'board falls back to the empty state');
});

test('wish map: cards never touch the wheel math and ride along in the backup import', async () => {
  const t = bootDom();
  const pctBefore = t.app.computePercent(t.app.getState());
  t.app.setState(Object.assign(t.app.getState(), {
    wishMap: [{ src: 'data:image/jpeg;base64,AAA', caption: 'Мечта' }],
  }));
  assert.equal(t.app.computePercent(t.app.getState()), pctBefore, 'wish cards must not affect any percent');
  // Import a backup payload that carries a wish map — it must restore as-is.
  t.window.alert = () => {};
  t.window.confirm = () => true;
  const payload = {
    app: 'goal-tracker-backup',
    version: 1,
    state: { name: 'Главная', children: [], wishMap: [{ src: 'data:image/jpeg;base64,AAA', caption: 'Из бэкапа' }] },
  };
  const file = new t.window.File([JSON.stringify(payload)], 'backup.json', { type: 'application/json' });
  t.app.doImportData(file);
  // FileReader is async — wait for the import itself to land (max ~2s), keyed on the
  // backup's distinctive caption so a pre-existing local card can't end the wait early.
  for (let i = 0; i < 200 && t.app.getState().wishMap[0]?.title !== 'Из бэкапа'; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(t.app.getState().wishMap.length, 1, 'imported backup must restore the wish map');
  assert.equal(t.app.getState().wishMap[0].title, 'Из бэкапа', 'restored caption must match');
  assert.ok(t.document.querySelector('.wish-card'), 'restored card must render on the board');
});

test('wish map: section collapses like the wheel and the choice persists', () => {
  const t = bootDom();
  assert.ok(t.document.getElementById('btnWishAddEmpty'), 'open by default — empty state visible');
  t.click('#wishToggle');
  assert.equal(t.app.getState().wishMapOpen, false, 'clicking the title must persist wishMapOpen=false');
  assert.ok(!t.document.querySelector('.wish-grid'), 'the card grid must disappear when collapsed');
  assert.ok(!t.document.querySelector('.wish-form'), 'the add form must not survive a collapse');
  assert.ok(t.document.getElementById('btnWishAdd'), 'the «+» button must stay in the collapsed header');
  t.click('#wishToggle');
  assert.equal(t.app.getState().wishMapOpen, true, 'clicking again must persist wishMapOpen=true');
  assert.ok(t.document.getElementById('btnWishAddEmpty'), 'empty state must come back when expanded');
});

test('wish map: at 15 cards «+» disappears and a calm note explains the limit', () => {
  const t = bootDom();
  const mk = (i) => ({
    id: 'c' + i, src: 'data:image/png;base64,AA', title: 'К' + i, imagePath: null,
    order: i, isUserPhoto: false, createdAt: 1, updatedAt: 1,
  });
  t.app.setState(Object.assign(t.app.getState(), {
    wishMap: Array.from({ length: 14 }, (_, i) => mk(i)),
  }));
  t.window.render();
  assert.ok(t.document.getElementById('btnWishAdd'), 'at 14 cards «+» is still offered');
  assert.ok(!t.document.querySelector('.wish-limit-note'), 'no note below the cap');
  t.app.setState(Object.assign(t.app.getState(), {
    wishMap: Array.from({ length: 15 }, (_, i) => mk(i)),
  }));
  t.window.render();
  assert.ok(!t.document.getElementById('btnWishAdd'), 'at the cap the header «+» must be hidden');
  const note = t.document.querySelector('.wish-limit-note');
  assert.ok(note, 'the calm limit note must render under the grid');
  assert.match(note.textContent, /15 изображений/, 'the note states the actual cap');
  assert.equal(t.document.querySelectorAll('.wish-card').length, 15, 'all 15 cards still render');
});

test('wish map: «Это моё фото» is locked while another card holds the mark', () => {
  const t = bootDom();
  t.app.setState(Object.assign(t.app.getState(), {
    wishMap: [
      { id: 'a', src: 'data:image/png;base64,AA', title: 'Личное', imagePath: null, order: 0, isUserPhoto: true, createdAt: 1, updatedAt: 1 },
      { id: 'b', src: 'data:image/png;base64,BB', title: 'Второе', imagePath: null, order: 1, isUserPhoto: false, createdAt: 2, updatedAt: 2 },
    ],
  }));
  t.window.render();
  // The personal photo is marked by the accent outline only — no «Я» badge clutter.
  assert.equal(t.document.querySelectorAll('.wish-you-badge').length, 0, 'no «Я» badge renders');
  assert.equal(t.document.querySelectorAll('.wish-card-me').length, 1, 'exactly one card carries the accent outline');
  // A second card cannot steal the mark: its editor checkbox is disabled with a hint.
  t.click('#btnWishManage');
  t.click('[data-wish-manage-edit="1"]');
  const editBox = t.document.getElementById('wishEditIsUserPhoto');
  assert.ok(editBox, 'the editor must carry the checkbox');
  assert.ok(editBox.disabled, 'the checkbox is disabled while another card is marked');
  assert.ok(t.document.querySelector('.wish-check-hint'), 'a hint explains why it is locked');
  // Saving keeps the old mark in place.
  t.click('#btnWishEditSave');
  assert.equal(t.app.getState().wishMap[0].isUserPhoto, true, 'the old mark stays');
  assert.equal(t.app.getState().wishMap[1].isUserPhoto, false, 'the second card stays unmarked');
  // The same lock applies to the add form.
  t.click('#btnWishAdd');
  const addBox = t.document.getElementById('wishIsUserPhoto');
  assert.ok(addBox, 'the add form must offer the checkbox');
  assert.ok(addBox.disabled, 'the add-form checkbox is disabled while a mark exists');
  // No empty preview block before a file is picked.
  assert.ok(!t.document.querySelector('.wish-preview'), 'no empty preview until an image is chosen');
});

test('wish map: the personal photo renders in the centre of the grid order', () => {
  const t = bootDom();
  t.app.setState(Object.assign(t.app.getState(), {
    wishMap: [
      { id: 'a', src: 'data:image/png;base64,AA', title: 'Личное', isUserPhoto: true },
      { id: 'b', src: 'data:image/png;base64,BB', title: 'Второе' },
      { id: 'c', src: 'data:image/png;base64,CC', title: 'Третье' },
      { id: 'd', src: 'data:image/png;base64,DD', title: 'Четвёртое' },
    ],
  }));
  t.window.render();
  const order = Array.from(t.document.querySelectorAll('.wish-card')).map(el => el.dataset.wishOpen);
  assert.deepEqual(order, ['1', '2', '0', '3'], 'the marked card sits in the centre slot');
  const marked = t.document.querySelector('.wish-card-me');
  assert.ok(marked, 'the marked card must carry the accent frame class');
  assert.equal(marked.dataset.wishOpen, '0', 'the frame is on the isUserPhoto card');
});


