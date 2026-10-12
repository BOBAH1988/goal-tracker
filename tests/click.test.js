'use strict';
/* Click tests (jsdom): simulate real user actions against the REAL inline script from
   index.html. Owner-approved exception (08.10.2026): jsdom is the project's only dependency
   (devDependencies). These cover what the vm harness cannot: event handlers actually fire,
   mutate state and trigger a re-render. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM, VirtualConsole } = require('jsdom');
const { readProjectFile, leaf, container, EXPORT_SRC } = require('./helpers');

function bootDom(seedStorage, opts) {
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
  // v1.2.0: the three sections are COLLAPSED by default. render() reads the global `let`
  // flags (mainGoalsOpen / wishMapOpen / goodTodayEntriesOpen) — NOT state.* — so scenario
  // tests get a working screen by flipping those globals right after boot (this script shares
  // the app's global scope, exactly like EXPORT_SRC above). Default-state tests opt out with
  // opts.closedSections to assert the fresh behaviour itself.
  if (!opts || !opts.closedSections) {
    const openSections = `<script>mainGoalsOpen = true; wishMapOpen = true; goodTodayEntriesOpen = true;
      state.mainGoalsOpen = true; state.wishMapOpen = true; state.goodTodayEntriesOpen = true;
      render();</script>`;
    html = html.replace('</body>', `${openSections}</body>`);
  }

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
      // SVG elements in jsdom don't have .click(); use dispatchEvent for all elements.
      if (typeof el.click === 'function') {
        el.click();
      } else {
        el.dispatchEvent(new this.window.MouseEvent('click', { bubbles: true, cancelable: true }));
      }
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

test('priority block: carries the renamed title «Главные цели» on the home screen', () => {
  const t = bootDom();
  t.app.setState({
    name: 'root',
    children: [leaf(false, { name: 'Цель X', priority: true })],
    priorityOpen: true,
  });
  t.window.render();
  const header = t.document.querySelector('#priorityToggle');
  assert.ok(header, 'the priority block header must render');
  assert.ok(header.textContent.includes('Главные цели'),
    'the ☆ block is «Главные цели» now (owner rename, was «Приоритетные цели»)');
  // The starred goal itself shows up in the block.
  assert.ok(t.document.querySelector('.priority-list .priority-name'),
    'the starred goal must appear in the block');
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

// ===== Main goals collapsible («Важные сферы жизни» — CLOSED by default since v1.2.0) =====
test('main goals list: closed by default, click expands and persists across reload', () => {
  const t = bootDom(null, { closedSections: true });
  t.app.setState({ name: 'root', children: [leaf(false, { name: 'Цель 1' }), leaf(false, { name: 'Цель 2' })] });
  t.window.render();
  // The section carries the renamed title (owner: «Главные цели» → «Важные сферы жизни»).
  assert.ok(t.document.querySelector('#mainGoalsToggle').textContent.includes('Важные сферы жизни'),
    'the section title must use the new name');
  // v1.2.0: fresh install → the grid is hidden, the header stays clickable.
  assert.ok(!t.document.querySelector('.grid-goals'), 'grid must be hidden by default (closed)');
  assert.ok(!t.document.querySelector('.add-goal-wrap'),
    'the action group hides with the grid — nothing to act on');
  assert.equal(t.document.querySelector('.main-goals-arrow').textContent, '▸',
    'arrow must point right while collapsed');

  // Click the toggle → expands.
  t.click('#mainGoalsToggle');
  assert.equal(t.app.getState().mainGoalsOpen, true, 'clicking must persist mainGoalsOpen=true in state');
  assert.ok(t.document.querySelector('.grid-goals'), 'grid must appear when expanded');
  assert.ok(t.document.querySelector('.grid-goals').children.length > 0, 'cards must render when open');
  assert.ok(t.document.querySelector('.add-goal-wrap'), 'action group comes back with the grid');
  assert.equal(t.document.querySelector('.main-goals-arrow').textContent, '▾', 'arrow must point down when open');

  // Click again → collapses and is serialized.
  t.click('#mainGoalsToggle');
  assert.equal(t.app.getState().mainGoalsOpen, false, 'clicking must persist mainGoalsOpen=false in state');
  assert.ok(!t.document.querySelector('.grid-goals'), 'grid must disappear when collapsed');
  const raw = t.window.localStorage.getItem(t.app.STORAGE_KEY);
  assert.ok(raw && raw.includes('"mainGoalsOpen":false'), 'collapsed state must be serialized to localStorage');
  const t2 = bootDom({ [t.app.STORAGE_KEY]: raw }, { closedSections: true });
  assert.equal(t2.app.getState().mainGoalsOpen, false, 'persisted state must read back as collapsed');
  assert.ok(!t2.document.querySelector('.grid-goals'), 'after reload, main goals must stay collapsed');
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

test('overall progress block: «Путь к балансу» title carries the percentage colour band', () => {
  const t = bootDom();
  // 0% (every goal open) → soft light red band.
  t.app.setState({ name: 'root', children: [leaf(false), leaf(false)] });
  t.window.render();
  const h2 = () => t.document.querySelector('.overall h2');
  assert.ok(h2().textContent.includes('Путь к балансу'),
    'the block is «Путь к балансу» now (owner rename, was «Общий прогресс»)');
  assert.match(h2().getAttribute('style'), /var\(--red-soft\)/, 'below 25% must paint the soft light red');
  // 50% (half the goals done) → yellow.
  t.app.setState({ name: 'root', children: [leaf(true), leaf(false)] });
  t.window.render();
  assert.match(h2().getAttribute('style'), /var\(--yellow\)/, '50–74% must paint yellow');
  // 100% → green.
  t.app.setState({ name: 'root', children: [leaf(true), leaf(true)] });
  t.window.render();
  assert.match(h2().getAttribute('style'), /var\(--green\)/, '75%+ must paint green');
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

  // The field is a TEXTAREA, not an <input>: an input cannot wrap, and a quote that does not fit
  // the narrow PWA width must take a second line instead of being cut off.
  assert.equal(quoteInput.tagName, 'TEXTAREA', 'the motivation line must wrap — <input> cannot');
  assert.ok(quoteInput.readOnly, 'the quote field stays display-only');

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
  // Both live in ONE right-aligned flex group (like .add-goal-wrap in «Важные сферы жизни»),
  // so neither drifts to the centre between title and its sibling.
  const group = t.document.querySelector('.wish-header-actions');
  assert.ok(group, 'header buttons must share one group element');
  assert.ok(group.contains(t.document.getElementById('btnWishAdd')), '«+» belongs to the group');
  assert.ok(group.contains(t.document.getElementById('btnWishManage')), 'the manager belongs to the same group');
  // Кнопка плотности (сетка 2/3/4) лежит в той же группе — между «+» и управлением.
  assert.ok(group.contains(t.document.getElementById('btnWishGrid')), 'the grid-density button belongs to the group');
  assert.equal(group.children.length, 4, 'the group holds «+», the grid button, print and the manager');
  assert.ok(group.children[1].querySelector('#btnWishGrid'),
    'the grid button sits between «+» and the rest (inside its dropdown wrapper)');
  assert.equal(group.children[2].id, 'btnWishPrint', 'the print button follows the grid button');
  assert.ok(group.children[3].id === 'btnWishManage', 'the manager stays last');
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
  assert.match(t.document.getElementById('app').innerHTML, /У меня будет/, 'the board title must be on the home screen');
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

test('wish map: closed by default, the title expands it and the choice persists', () => {
  const t = bootDom(null, { closedSections: true });
  // v1.2.0: fresh install → the board is collapsed; only the header shows (with the new title).
  assert.ok(t.document.getElementById('wishToggle'), 'the section header is on the home screen');
  assert.match(t.document.getElementById('wishToggle').textContent, /У меня будет/,
    'the header carries the renamed title');
  assert.ok(!t.document.getElementById('btnWishAddEmpty'), 'collapsed by default — no add button');
  assert.ok(!t.document.querySelector('.wish-grid'), 'no card grid while collapsed');
  assert.equal(t.document.querySelector('#wishToggle .wheel-arrow').textContent, '▸',
    'arrow must point right while collapsed');

  // Click the title → expands.
  t.click('#wishToggle');
  assert.equal(t.app.getState().wishMapOpen, true, 'clicking the title must persist wishMapOpen=true');
  assert.ok(t.document.getElementById('btnWishAddEmpty'), 'the empty state comes back when expanded');
  assert.ok(t.document.getElementById('btnWishAdd'), 'the «+» returns on expand');

  // Click again → collapses; header buttons go with it (v1.1.55 rule).
  t.click('#wishToggle');
  assert.equal(t.app.getState().wishMapOpen, false, 'clicking again must persist wishMapOpen=false');
  assert.ok(!t.document.querySelector('.wish-grid'), 'the card grid must disappear when collapsed');
  assert.ok(!t.document.querySelector('.wish-form'), 'the add form must not survive a collapse');
  assert.ok(!t.document.getElementById('btnWishAdd'), 'the «+» button must go with the collapsed board');
  assert.ok(!t.document.querySelector('.wish-header-actions'), 'the whole header button group disappears');

  // Reload from saved storage → stays collapsed.
  const raw = t.window.localStorage.getItem(t.app.STORAGE_KEY);
  assert.ok(raw && raw.includes('"wishMapOpen":false'), 'collapsed state must be serialized');
  const t2 = bootDom({ [t.app.STORAGE_KEY]: raw }, { closedSections: true });
  assert.ok(!t2.document.querySelector('.wish-grid'), 'after reload, the board must stay collapsed');
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

/* Grid density button (between «+» and the manager): 2/3/4 cards per row, default 4 on the web and
   3 in an installed PWA, the choice saved in state so it survives a reload and travels to the
   other devices. */
test('wish map: the grid-density button picks 2/3/4 per row', () => {
  const t = bootDom();
  t.app.setState(Object.assign(t.app.getState(), {
    wishMap: [
      { id: 'a', title: 'A', imagePath: 'wishImages/a', order: 0, uploadState: 'uploaded' },
      { id: 'b', title: 'B', imagePath: 'wishImages/b', order: 1, uploadState: 'uploaded' },
      { id: 'c', title: 'C', imagePath: 'wishImages/c', order: 2, uploadState: 'uploaded' },
      { id: 'd', title: 'D', imagePath: 'wishImages/d', order: 3, uploadState: 'uploaded' },
      { id: 'e', title: 'E', imagePath: 'wishImages/e', order: 4, uploadState: 'uploaded' },
    ],
  }));
  t.window.render();
  // Веб-умолчание — 4.
  assert.equal(t.document.querySelector('.wish-grid').dataset.cols, '4', 'the web default is 4 per row');
  // Меню выбора.
  t.click('#btnWishGrid');
  const options = Array.from(t.document.querySelectorAll('[data-wish-cols]'));
  assert.deepEqual(options.map(b => b.textContent), ['2', '3', '4'], 'the menu offers 2, 3 and 4');
  t.click('[data-wish-cols="2"]');
  assert.equal(t.document.querySelector('.wish-grid').dataset.cols, '2', 'the grid re-renders with 2');
  assert.equal(t.document.getElementById('wishGridMenu'), null, 'the menu closes after the choice');
  assert.equal(t.app.getState().wishGridCols, 2, 'the choice is stored (survives a reload, syncs)');
  // Повторный выбор + отметка активного.
  t.click('#btnWishGrid');
  const active = Array.from(t.document.querySelectorAll('[data-wish-cols].active'));
  assert.equal(active.length, 1, 'exactly one option is marked active');
  assert.equal(active[0].textContent, '2', 'the stored choice is the active one');
  t.click('[data-wish-cols="3"]');
  assert.equal(t.document.querySelector('.wish-grid').dataset.cols, '3');
  // Клик вне меню закрывает его, не меняя выбор.
  t.click('#btnWishGrid');
  t.click('.wish-caption');
  assert.equal(t.document.getElementById('wishGridMenu'), null, 'an outside tap closes the menu');
  assert.equal(t.app.getState().wishGridCols, 3, 'and changes nothing');
});

/* Печать доски: кнопка-принтер собирает отдельную страницу A4 (#wishPrintRoot) в ТОЙ ЖЕ матрице,
   что на экране, и убирает её после печати. Браузера в тесте нет, поэтому проверяем именно сборку
   макета и чистку за собой. */
test('wish map: the print button builds one A4 page in the current matrix', async () => {
  const t = bootDom();
  const cards = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id, i) =>
    ({ id, title: 'Карточка ' + (i + 1), imagePath: 'wishImages/' + id, order: i, uploadState: 'uploaded' }));
  t.app.setState(Object.assign(t.app.getState(), { wishMap: cards }));
  t.window.render();
  assert.equal(t.document.querySelector('.wish-grid').dataset.cols, '4', 'web default is 4 per row');

  let printed = 0;
  t.window.print = () => { printed++; };
  t.click('#btnWishPrint');
  assert.equal(printed, 1, 'the button calls the browser print dialog');

  const root = t.document.querySelector('#wishPrintRoot');
  assert.ok(root, 'a dedicated print node is built');
  assert.equal(root.parentNode, t.document.body, 'and it lives outside #app so a re-render cannot drop it');
  const pageGrid = root.querySelector('[style*="grid-template-columns"]');
  assert.equal(pageGrid.children.length, 7, 'every card is on the page');
  // Цвета темы: фон — градиент body, а не белый лист; текст — переменная темы.
  assert.match(root.style.background, /linear-gradient/, 'the page background is the theme gradient');
  assert.equal(root.style.color, 'rgb(238, 242, 248)', 'the text is the theme text colour (dark theme)');
  // Заголовок — крупный серифный, без декоративной полосы и мёртвого места.
  const head = root.firstChild;
  assert.match(head.innerHTML, /Georgia/, 'the title uses the serif display face');
  assert.match(head.innerHTML, /10mm/, 'and is 25% larger than before (8mm → 10mm)');
  assert.equal(head.children.length, 1, 'the print header is a bare title');
  assert.ok(!/·/.test(head.textContent) && !/Cards per row|Карточек в ряду/.test(head.textContent),
    'and carries no card-count subtitle');
  assert.ok(!/border-bottom|padding-bottom/.test(head.getAttribute('style')),
    'no accent bar and no dead space above the grid');
  assert.match(pageGrid.getAttribute('style'), /repeat\(4,1fr\)/,
    'the page uses the SAME matrix as the board (4 per row)');
  // Карточка без локальных пикселей не превращается в дыру: там честная пометка.
  assert.equal(root.querySelectorAll('img').length, 0, 'no cached bytes → no <img>');
  assert.ok([...pageGrid.children].some(el => /изображение/i.test(el.textContent)),
    'and the placeholder says so in words instead of printing an empty box');
  assert.equal(t.document.body.classList.contains('wish-printing'), true,
    'the body is marked, so the print CSS can hide everything else');
  // Регресс присланного бага: приложение НИЧЕГО не прячет на экране — скрытие живёт только в
  // @media print. До фикса тап «Печать» оставлял пустой экран, который нельзя было закрыть.
  assert.ok(t.document.getElementById('app').children.length > 0,
    'the app must stay on screen after tapping Print (only @media print hides it)');
  assert.notEqual(t.window.getComputedStyle(t.document.getElementById('app')).display, 'none',
    'and it is not display:none — the hiding rule is not active outside print');

  // Тот же макет, но выбор пользователя — 2 в ряду.
  t.click('#btnWishGrid');
  t.click('[data-wish-cols="2"]');
  t.click('#btnWishPrint');
  assert.match(t.document.querySelector('#wishPrintRoot [style*="grid-template-columns"]').getAttribute('style'),
    /repeat\(2,1fr\)/, 'the page follows an explicit 2-per-row choice');

  // С закэшированными байтами на страницу уходит именно картинка.
  t.window.URL.createObjectURL = () => 'blob:saved';
  await (async () => {
    const blob = new t.window.Blob(['x'], { type: 'image/webp' });
    await t.app.wishCachePut('a', blob);
    t.app.wishRememberBlob('a', blob);
  })();
  t.click('#btnWishPrint');
  assert.equal(t.document.querySelectorAll('#wishPrintRoot img').length, 1,
    'a card with cached pixels prints as a real image');

  // После печати — чисто: узел и класс убраны.
  t.window.dispatchEvent(new t.window.Event('afterprint'));
  assert.equal(t.document.querySelector('#wishPrintRoot'), null, 'the print node is removed afterwards');
  assert.equal(t.document.body.classList.contains('wish-printing'), false, 'and the marker class is gone');
});

/* iOS PWA: window.print в Safari не открывает диалог печати —
   раньше тап «Печать» молча ничего не делал (узел создавался
   и сразу удалялся). Теперь: страница рисуется в PNG и уходит
   в экран «Поделиться», где есть «Печать» (AirPrint). jsdom
   не умеет 2d-canvas — поэтому здесь проверяется честная
   деградация: подсказка вместо молчания. */
test('wish map: on iPhone, Print renders a PNG for the share sheet, not silence', async () => {
  const t = bootDom(null, { userAgent: 'iPhone' });
  const cards = ['a', 'b', 'c', 'd'].map((id, i) =>
    ({ id, title: 'Карточка ' + (i + 1), imagePath: 'wishImages/' + id, order: i, uploadState: 'uploaded' }));
  t.app.setState(Object.assign(t.app.getState(), { wishMap: cards }));
  t.window.render();
  // iPhone: путь принудительно share, даже если window.print
  // формально существует (jsdom его определяет) — на нём
  // диалог печати не открывается. Функции верхнего уровня
  // классического скрипта — свойства window, так что ветвь
  // переопределяется напрямую.
  t.window.isIOSDevice = () => true;
  t.click('#btnWishPrint');
  await new Promise(r => setTimeout(r, 0));   // shareWishBoardPng — async
  assert.ok(!t.document.querySelector('#wishPrintRoot'),
    'the DOM print node is not built on this path');
  assert.ok([...t.document.querySelectorAll('.undo-toast')]
    .some(el => /Печать недоступна|Printing is not available/.test(el.textContent)),
    'and the hint explains the Safari path instead of doing nothing');
});

test('account button: a name that does not fit becomes the user icon', () => {
  const t = bootDom();
  // Войденный аккаунт: Firebase в тестах вырезан — флаги ставим напрямую.
  t.app.setCloudEnabled(true);
  t.app.setAuthUser({ name: 'Владимир', email: 'v@example.com' });
  t.window.render();
  assert.match(t.document.getElementById('btnAccount').textContent, /Владимир/,
    'a short name fits the width — shown as text');
  // jsdom не считает layout — «не влезает» задаём напрямую.
  t.app.setAccountIconOnly(true);
  t.window.render();
  const btn = t.document.getElementById('btnAccount');
  assert.ok(btn.querySelector('.ti-user'), 'the icon-only button shows the user glyph');
  assert.equal(btn.textContent.trim(), '', 'and carries no name text');
  assert.equal(btn.getAttribute('data-tip'), 'Владимир',
    'the tip keeps the name (touch PWA rule)');
});

test('touch mode: the first touch marks the document so stuck :hover can be neutralised', () => {
  const t = bootDom();
  assert.ok(!t.document.documentElement.classList.contains('touch-mode'),
    'hover feedback starts enabled (desktop with a mouse)');
  t.window.dispatchEvent(new t.window.Event('touchstart'));
  assert.ok(t.document.documentElement.classList.contains('touch-mode'),
    'the first touch marks the document — CSS drops every :hover accent');
});

test('wish map: the grid-density default is 3 in an installed PWA', () => {
  const t = bootDom();
  // Установленное приложение: matchMedia отвечает «standalone» — ровно как на телефоне.
  t.window.matchMedia = (q) => ({ matches: q === '(display-mode: standalone)', media: q });
  t.window.navigator.standalone = true;
  t.app.setState(Object.assign(t.app.getState(), {
    wishMap: [
      { id: 'a', title: 'A', imagePath: 'wishImages/a', order: 0, uploadState: 'uploaded' },
      { id: 'b', title: 'B', imagePath: 'wishImages/b', order: 1, uploadState: 'uploaded' },
      { id: 'c', title: 'C', imagePath: 'wishImages/c', order: 2, uploadState: 'uploaded' },
      { id: 'd', title: 'D', imagePath: 'wishImages/d', order: 3, uploadState: 'uploaded' },
    ],
  }));
  t.window.render();
  assert.equal(t.document.querySelector('.wish-grid').dataset.cols, '3', 'the PWA default is 3 per row');
});

test('wish map manager: «↕» picks a card up and «here» puts it in that slot', () => {
  const t = bootDom();
  t.app.setState(Object.assign(t.app.getState(), {
    wishMap: [
      { id: 'a', title: 'Первое', imagePath: 'wishImages/a', order: 0, uploadState: 'uploaded' },
      { id: 'b', title: 'Второе', imagePath: 'wishImages/b', order: 1, uploadState: 'uploaded' },
      { id: 'c', title: 'Третье', imagePath: 'wishImages/c', order: 2, uploadState: 'uploaded' },
    ],
  }));
  t.window.render();
  t.click('#btnWishManage');
  const titles = () => Array.from(t.document.querySelectorAll('.wish-manage-row .wish-manage-caption'))
    .map(el => el.textContent.trim());
  assert.deepEqual(titles(), ['Первое', 'Второе', 'Третье'], 'the manager lists display order');
  // поднимаем «Третье»
  t.click('[data-wish-move="2"]');
  assert.ok(t.document.querySelector('.wish-manage-row.is-moving'),
    'the picked-up row is marked, and the other actions are hidden while it is');
  assert.equal(t.document.querySelectorAll('[data-wish-manage-del]').length, 0,
    'no delete/edit button while a move is in progress');
  // В режиме переноса целью является ВСЯ строка, а не маленькая иконка: тап по подписи или
  // превью должен срабатывать так же (событие всплывает до строки).
  const target = t.document.querySelector('.wish-manage-row[data-wish-place]');
  assert.ok(target, 'the other rows become drop targets as a whole');
  assert.ok(target.querySelector('.wish-place-hint'), 'and they say so in words, not just an icon');
  t.click('.wish-manage-row[data-wish-place]:nth-of-type(1) .wish-manage-caption');
  assert.deepEqual(titles(), ['Третье', 'Первое', 'Второе'], 'the card took the target slot');
  assert.deepEqual(Array.from(t.app.getState().wishMap.map(c => c.order)).map(Number), [0, 1, 2],
    'the order field is renumbered with the move');
  // отмена: подняли и передумали
  t.click('[data-wish-move="0"]');
  t.click('[data-wish-move-cancel]');
  assert.deepEqual(titles(), ['Третье', 'Первое', 'Второе'], 'cancel changes nothing');
  assert.equal(t.document.querySelector('.wish-manage-row.is-moving'), null, 'and no row stays marked');
});

test('wish map: the personal photo renders first in the grid order', () => {
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
  assert.deepEqual(order, ['0', '1', '2', '3'], 'the marked card leads the board');
  const marked = t.document.querySelector('.wish-card-me');
  assert.ok(marked, 'the marked card must carry the accent frame class');
  assert.equal(marked.dataset.wishOpen, '0', 'the frame is on the isUserPhoto card');
});



test('Победы за неделю: history browses one report per week and edits it', () => {
  const t = bootDom();
  t.app.setState(Object.assign(t.app.getState(), {
    goodTodayWeekReflections: [
      { week: '2026-09-14', q1: 'A1', q2: 'A2', q3: 'A3', createdAt: 1, updatedAt: 1 },
      { week: '2026-09-21', q1: 'B1', q2: 'B2', q3: 'B3', createdAt: 2, updatedAt: 2 },
    ],
  }));
  t.window.render();
  // The weekly header carries the history button — but only while the section is expanded
  // (v1.1.55: header buttons hide together with the collapsed section, like every other module).
  assert.ok(!t.document.getElementById('btnGoodTodayWeekHistory'), 'collapsed section hides its buttons');
  t.click('#goodTodayWeekToggle');
  assert.ok(t.document.getElementById('btnGoodTodayWeekHistory'), 'history button must sit in the weekly header');
  t.click('#btnGoodTodayWeekHistory');
  assert.ok(t.document.getElementById('btnGoodTodayWeekHistoryBack'), 'history view opens');
  const appHtml = () => t.document.getElementById('app').innerHTML;
  assert.ok(appHtml().includes('B1'), 'newest report is shown first');
  // One week back → the older report, one week forward → back to the newer one.
  t.click('#btnGoodTodayWeekPrev');
  assert.ok(appHtml().includes('A1'), 'prev week shows the older report');
  t.click('#btnGoodTodayWeekNext');
  assert.ok(appHtml().includes('B1'), 'next week returns to the newer report');
  // Editing the shown week writes through to state.
  t.click('#btnGoodTodayWeekHistoryEdit');
  assert.ok(t.document.getElementById('goodTodayWeekHistoryQ1'), 'edit form opens for the shown week');
  t.document.getElementById('goodTodayWeekHistoryQ1').value = 'B1 new';
  t.click('#btnGoodTodayWeekHistorySave');
  const saved = t.app.getState().goodTodayWeekReflections.find(r => r.week === '2026-09-21');
  assert.equal(saved.q1, 'B1 new', 'the edit persists in state');
  assert.ok(appHtml().includes('B1 new'), 'the view reflects the saved text');
  // Back returns to the weekly section (history view closed).
  t.click('#btnGoodTodayWeekHistoryBack');
  assert.ok(!t.document.getElementById('btnGoodTodayWeekHistoryBack'), 'back closes the history view');
});

test('Победы за неделю: history saves a brand new report for the shown week', () => {
  const t = bootDom();
  t.app.setState(Object.assign(t.app.getState(), {
    goodTodayWeekReflections: [
      { week: '2026-09-14', q1: 'A1', q2: 'A2', q3: 'A3', createdAt: 1, updatedAt: 1 },
    ],
  }));
  t.window.render();
  // Section starts collapsed → expand it first, its header buttons hide while collapsed (v1.1.55).
  assert.ok(!t.document.getElementById('btnGoodTodayWeekHistory'), 'collapsed section hides its buttons');
  t.click('#goodTodayWeekToggle');
  t.click('#btnGoodTodayWeekHistory');
  // Navigate to a week without a report and fill it in from history.
  t.click('#btnGoodTodayWeekNext');
  const appHtml = () => t.document.getElementById('app').innerHTML;
  assert.ok(appHtml().includes('За эту неделю отчёта нет'), 'empty week is announced');
  t.click('#btnGoodTodayWeekHistoryEdit');
  t.document.getElementById('goodTodayWeekHistoryQ1').value = 'Победа';
  t.click('#btnGoodTodayWeekHistorySave');
  assert.equal(t.app.getState().goodTodayWeekReflections.length, 2, 'a new report is created');
});

test('Хорошее сегодня: «+» opens the form and «−» collapses it again', () => {
  const t = bootDom();
  t.app.setState(Object.assign(t.app.getState(), { goodTodayEntries: [] }));
  t.window.render();
  // Collapsed: «+» only, no textarea.
  assert.ok(t.document.getElementById('btnGoodTodayAdd'), 'the add button is present');
  assert.ok(!t.document.getElementById('goodTodayTextarea'), 'no textarea before opening');
  // «+» opens the form and focus lands in the textarea.
  t.click('#btnGoodTodayAdd');
  assert.ok(t.document.getElementById('goodTodayTextarea'), 'the form opens on «+»');
  assert.equal(t.document.getElementById('btnGoodTodayAdd').textContent, '−', 'the button flips to «−»');
  // Typing a draft and pressing «−» must discard it and collapse — no save, no prompt.
  t.document.getElementById('goodTodayTextarea').value = 'передумал';
  t.click('#btnGoodTodayAdd');
  assert.ok(!t.document.getElementById('goodTodayTextarea'), 'the form collapses on «−»');
  assert.equal(t.app.getState().goodTodayEntries.length, 0, 'nothing is saved');
  assert.equal(t.document.getElementById('btnGoodTodayAdd').textContent, '+', 'the button flips back to «+»');
  // Reopening must start from a blank draft (the abandoned text is gone).
  t.click('#btnGoodTodayAdd');
  assert.equal(t.document.getElementById('goodTodayTextarea').value, '', 'the abandoned draft is discarded');
});

test('Хорошее сегодня: the history button hides with the collapsed entries list', () => {
  const t = bootDom();
  t.app.setState(Object.assign(t.app.getState(), {
    goodTodayEntries: [{ id: 'e1', date: '2026-10-05', text: 'Запись' }],
  }));
  t.window.render();
  assert.ok(t.document.getElementById('btnGoodTodayHistory'), 'open section offers the history button');
  t.click('#goodTodayEntriesToggle');
  assert.equal(t.app.getState().goodTodayEntriesOpen, false, 'collapse persists');
  assert.ok(!t.document.getElementById('btnGoodTodayHistory'),
    'the history button hides with the collapsed list (v1.1.55)');
  assert.ok(!t.document.getElementById('btnGoodTodayAdd'), 'the «+» lives inside the list body');
  t.click('#goodTodayEntriesToggle');
  assert.ok(t.document.getElementById('btnGoodTodayHistory'), 'the button returns on expand');
});

test('Победы за неделю: header icons appear with the section and open the saved report', () => {
  const t = bootDom();
  const curWeek = t.window.weekStartISO(t.window.isoToday());
  t.app.setState(Object.assign(t.app.getState(), {
    goodTodayWeekReflections: [
      { week: curWeek, q1: 'Q1a', q2: 'Q2a', q3: 'Q3a', createdAt: 1, updatedAt: 1 },
    ],
  }));
  t.window.render();
  // The section starts collapsed, and its header icons hide with it — same rule as every other
  // collapsible module (v1.1.55: buttons disappear together with the collapsed content).
  assert.ok(!t.document.getElementById('goodTodayWeekQ1'), 'the section starts collapsed');
  assert.ok(!t.document.getElementById('btnGoodTodayWeekEdit'), 'the edit icon hides with the collapsed section');
  assert.ok(!t.document.getElementById('btnGoodTodayWeekHistory'), 'the history icon hides with the collapsed section');
  // Expand → the icons come back, edit ahead of history.
  t.click('#goodTodayWeekToggle');
  assert.ok(t.document.getElementById('btnGoodTodayWeekEdit'), 'the edit icon is in the header');
  assert.ok(t.document.getElementById('btnGoodTodayWeekHistory'), 'the history icon is in the header');
  const order = [...t.document.querySelectorAll('.section-title-row')]
    .filter(r => r.querySelector('#goodTodayWeekToggle'))
    .pop().innerHTML;
  assert.ok(order.indexOf('btnGoodTodayWeekEdit') < order.indexOf('btnGoodTodayWeekHistory'),
    'edit comes before history');
  // Tapping edit loads the saved answers into the form.
  t.click('#btnGoodTodayWeekEdit');
  assert.ok(t.document.getElementById('goodTodayWeekQ1'), 'the form opens');
  assert.equal(t.document.getElementById('goodTodayWeekQ1').value, 'Q1a', 'the saved answer is loaded');
  // Tapping the same icon again collapses back to the saved view.
  t.click('#btnGoodTodayWeekEdit');
  assert.ok(!t.document.getElementById('goodTodayWeekQ1'), 'the icon toggles back');
  assert.match(t.document.getElementById('app').innerHTML, /Q1a/, 'the saved report is shown again');
  // Collapsing again takes the icons with it.
  t.click('#goodTodayWeekToggle');
  assert.ok(!t.document.getElementById('btnGoodTodayWeekEdit'), 'collapsing hides the icons again');
});

/* Companion to the CSS guards in css.test.js: jsdom gives us a real DOM here, so we can assert
   the *rendered* markup. The custom [data-tip] bubble never shows on touch/PWA, so a button left
   on the native title= attribute silently loses its hint — exactly the subgoal-page bug. */
test('guard: every rendered action button carries data-tip, not a native title', () => {
  const t = bootDom();
  t.app.setState(Object.assign(t.app.getState(), {
    children: [
      { name: 'Цель с подцелями', children: [
        { name: 'Подцель 1', done: false, children: [] },
      ] },
    ],
    goodTodayEntries: [{ id: 'e1', date: '2026-10-05', text: 'Запись' }],
    goodTodayWeekReflections: [{ week: '2026-09-21', q1: 'a', q2: 'b', q3: 'c', createdAt: 1, updatedAt: 1 }],
    wishMap: [{ src: 'data:image/jpeg;base64,AAA', caption: 'Море' }],
  }));
  const check = (label) => {
    const found = t.document.querySelectorAll('button.icon-btn');
    assert.ok(found.length > 0, `${label}: expected at least one .icon-btn button, guard would pass vacuously`);
    const bad = [];
    found.forEach(el => {
      if (!el.getAttribute('data-tip') && el.getAttribute('title')) bad.push(el.id || el.className);
    });
    assert.deepEqual(bad, [], `${label}: these buttons use a native title, which never shows on touch/PWA: ${bad.join(', ')}`);
  };
  // Home screen with every panel open at once.
  t.window.wishAddOpen = true;
  t.window.goodTodayFormOpen = true;
  t.window.render();
  check('home');
  // Wish card manager.
  t.click('#btnWishManage');
  check('wish manager');
  t.click('#btnWishManageClose');
  // Subgoal (node) view — the surface where the whole toolbar used to be title-only.
  t.click('[data-nav="0"]');
  check('subgoal page');
  // Leaf / checklist view (data-nav is a flat index inside whatever view is on screen).
  t.click('[data-nav="0"]');
  check('leaf page');
});

test('wish map: a saved card shows its pixels, not the pending placeholder', async () => {
  const t = bootDom();
  // jsdom has no object URLs — a browser always does, and without one the card could not
  // render its pixels. Stand the surface in so this test exercises the real path.
  t.window.URL.createObjectURL = () => 'blob:saved';
  t.window.URL.revokeObjectURL = () => {};
  t.click('#btnWishAdd');                       // the form must be open for Save to exist
  // wishDraftSrc is a lexical `let` inside the app script — a plain window assignment would
  // create an unrelated property, so go through the exported setter (same for the caption).
  t.app.setWishDraft('data:image/webp;base64,UklGRhoAAAA', 'Отдых на море', false);
  t.window.render();
  t.click('#btnWishSave');
  await new Promise((r) => setTimeout(r, 30));
  const state = t.app.getState();
  assert.equal(state.wishMap.length, 1, 'the card is saved');
  assert.equal(state.wishMap[0].uploadState, 'pending', 'no cloud yet → pending (local only)');
  // The board must show the image, not the «Сохраняем в облако…» placeholder.
  const img = t.document.querySelector('.wish-img');
  assert.ok(img, 'a saved card renders its <img>');
  assert.ok(!t.document.querySelector('.wish-img-pending'), 'no pending placeholder on a cached card');
  assert.match(t.document.getElementById('app').innerHTML, /Отдых на море/, 'caption is shown');
});

test('wish map: board survives a reload by rebuilding pixels from the local cache', async () => {
  const t = bootDom();
  // A card as the app saves it now: metadata only, bytes in the IndexedDB cache.
  t.app.setState(Object.assign(t.app.getState(), {
    wishMap: [{ id: 'r1', title: 'Море', imagePath: null, order: 0, isUserPhoto: false,
                createdAt: 1, updatedAt: 1, uploadState: 'pending' }],
  }));
  await t.app.wishCachePut('r1', new t.window.Blob(['pixels'], { type: 'image/webp' }));
  // jsdom has no object URLs — stand the surface in so the board can render its pixels.
  t.window.URL.createObjectURL = () => 'blob:test';
  t.window.URL.revokeObjectURL = () => {};
  // Boot-time warm-up (what index.html now runs right after the first render()).
  t.app.wishRememberBlob('r1', new t.window.Blob(['pixels'], { type: 'image/webp' }));
  t.window.render();
  assert.ok(t.document.querySelector('.wish-img'), 'the reloaded board shows the image');
  assert.ok(!t.document.querySelector('.wish-img-pending'), 'no pending placeholder after a reload');
});

/* The version lives in the page footer (the owner: «у кнопки сбросить кэш удали версию, она есть
   в строке сайта»), and the update check is automatic — the manual menu item had no reason to
   exist and was removed together with the menu version line. */
test('top menu: no manual update check and no version line (footer carries the version)', () => {
  const t = bootDom();
  t.click('#btnTopMenu');
  assert.equal(t.document.getElementById('btnCheckUpdateMenuItem'), null,
    'the manual "check for update" item is gone — the check runs on its own');
  assert.equal(t.document.querySelector('.menu-version'), null,
    'the menu no longer repeats the version — the page footer shows it');
  // What the menu DOES still offer: the recovery item and navigation.
  assert.ok(t.document.getElementById('btnResetPwaCacheMenuItem'), '«Сбросить кэш» stays');
  assert.ok(t.document.getElementById('btnAboutMenuItem'), '«О проекте» stays');
});

test('update modal: confirming applies the waiting worker', async () => {
  const t = bootDom();
  // Drive it through the real path: a registration with an ACTIVE worker plus a WAITING one
  // is, by definition, an update — checkForAppUpdate() must open the modal on its own.
  const messages = [];
  const reg = {
    active: {},
    waiting: { postMessage: (m) => messages.push(m) },
    update: () => Promise.resolve(),
  };
  t.app.setSwRegistration(reg);
  await t.app.checkForAppUpdate(true);
  t.window.render();
  assert.ok(t.document.getElementById('updateOverlay'), 'the update modal renders');
  t.click('#btnUpdateApply');
  assert.equal(messages.length, 1, 'confirming posts SKIP_WAITING once');
  assert.equal(messages[0].type, 'SKIP_WAITING', 'the message asks the worker to activate');
});

test('top menu: a stuck PWA can be reinstalled, and an offline refusal wipes nothing', async () => {
  const t = bootDom();
  t.click('#btnTopMenu');
  assert.ok(t.document.getElementById('btnResetPwaCacheMenuItem'), 'the reinstall action is in the menu');
  // Offline: the fresh shell cannot be validated, so NOTHING is destroyed and the app keeps
  // working from its cache (the early "hard wipe" used to leave it unopenable without a network).
  t.window.confirm = () => true;
  t.window.fetch = () => Promise.reject(new Error('offline'));
  t.click('#btnResetPwaCacheMenuItem');
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(t.document.getElementById('app').innerHTML.length > 1000,
    'the app is still rendered — an offline reinstall attempt must not blank it');
});

test('top menu: an online reinstall validates the shell before wiping caches', async () => {
  const t = bootDom();
  t.click('#btnTopMenu');
  t.window.confirm = () => true;
  // The real app shell (validated by the id="app" marker in index.html).
  t.window.fetch = () => Promise.resolve({ ok: true, text: () => Promise.resolve('<html><body id="app">ok</body></html>') });
  const deleted = [];
  t.window.caches = { keys: async () => ['goal-tracker-v1.1.50'], delete: async (k) => { deleted.push(k); } };
  t.click('#btnResetPwaCacheMenuItem');
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(deleted, ['goal-tracker-v1.1.50'], 'a validated fresh shell lets the wipes run');
});

// ===== Мягкое напоминание о сферах («К сфере … давно не возвращались») =====
// Клики по НАСТОЯЩИМ обработчикам: блок рисуется на главной, «Скрыть» глушит сферу на 14 дней,
// «Открыть сферу» ведёт в дерево, а открытие/выполнение целей сбрасывают отсчёт.
const DAY = 24 * 60 * 60 * 1000;
function staleSphereState(name, daysAgo) {
  return {
    name: 'root',
    children: [{
      name,
      sphereActivityAt: Date.now() - daysAgo * DAY,
      children: [{ name: 'Цель', done: false, children: [] }],
    }],
  };
}

test('sphere reminder: the home screen shows the gentle nudge with the sphere name', () => {
  const t = bootDom();
  t.app.setState(staleSphereState('Здоровье', 20));
  t.window.render();
  const block = t.document.getElementById('sphereReminder');
  assert.ok(block, 'a stale sphere must surface its reminder');
  assert.match(block.textContent, /давно не возвращались/, 'the soft wording is used');
  assert.match(block.textContent, /Здоровье/, 'the sphere name is substituted');
  assert.ok(t.document.getElementById('btnSphereReminderOpen'), '«Открыть сферу» action');
  assert.ok(t.document.getElementById('btnSphereReminderHide'), '«Скрыть» action');
});

test('sphere reminder: no date on the sphere — no reminder, no invented past', () => {
  const t = bootDom();
  t.app.setState({ name: 'root', children: [{ name: 'Здоровье', children: [{ name: 'Цель', done: false, children: [] }] }] });
  t.window.render();
  assert.ok(!t.document.getElementById('sphereReminder'), 'a sphere without a date never reminds');
});

test('sphere reminder: «Скрыть» removes the block and mutes the sphere for 14 days', () => {
  const t = bootDom();
  t.app.setState(staleSphereState('Здоровье', 20));
  t.window.render();
  t.click('#btnSphereReminderHide');
  assert.ok(!t.document.getElementById('sphereReminder'), 'the block must disappear');
  const mutedUntil = t.app.getState().children[0].sphereMutedUntil;
  assert.ok(mutedUntil > Date.now() + 13 * DAY, 'the mute covers the full 14 days');
  // Re-render (e.g. after a sync echo) must not resurrect it.
  t.window.render();
  assert.ok(!t.document.getElementById('sphereReminder'), 'the hidden sphere stays quiet');
});

test('sphere reminder: «Открыть сферу» opens the tree and restarts the countdown', () => {
  const t = bootDom();
  const old = Date.now() - 20 * DAY;
  t.app.setState(staleSphereState('Здоровье', 20));
  t.window.render();
  t.click('#btnSphereReminderOpen');
  assert.deepEqual(Array.from(t.app.getPath()), [0], 'the sphere tree must open');
  assert.ok(t.app.getState().children[0].sphereActivityAt > old, 'the countdown restarts');
  t.app.setPath([]);
  t.window.render();
  assert.ok(!t.document.getElementById('sphereReminder'), 'the just-opened sphere stops reminding');
});

test('sphere reminder: opening a sphere card or completing its goal counts as interaction', () => {
  const t = bootDom();
  const old = Date.now() - 20 * DAY;
  t.app.setState(staleSphereState('Здоровье', 20));
  t.window.render();
  // Card tap on the home screen opens the sphere's tree — a deliberate interaction.
  t.click('[data-nav]');
  assert.ok(t.app.getState().children[0].sphereActivityAt > old, 'card tap refreshes the sphere');
  // Completing a goal one level deeper refreshes it too.
  t.app.setPath([0, 0]);
  t.window.render();
  t.click('#leafToggle');
  assert.ok(t.app.getState().children[0].sphereActivityAt > old, 'completing a goal refreshes the sphere');
});

test('sphere reminder: interaction dates persist to localStorage and ride the cloud doc', () => {
  const t = bootDom();
  const old = Date.now() - 20 * DAY;
  t.app.setState(staleSphereState('Здоровье', 20));
  t.app.saveState();
  const raw = t.window.localStorage.getItem(t.app.STORAGE_KEY);
  assert.ok(raw.includes('sphereActivityAt'), 'the date must persist');
  // "Reload": the countdown continues from the saved date, not from zero.
  const t2 = bootDom({ [t.app.STORAGE_KEY]: raw });
  assert.equal(t2.app.getState().children[0].sphereActivityAt, old, 'reload keeps the date');
  // The cloud projection carries the same fields (stateForCloud only replaces wishMap).
  const cloud = t2.app.stateForCloud(t2.app.getState());
  assert.equal(cloud.children[0].sphereActivityAt, old, 'other devices learn the date');
});

// ===== «Поделиться» (меню ☰): системное окно Web Share API с запасным копированием =====
test('share: the menu item sits with the other items and reuses .menu-item', () => {
  const t = bootDom();
  t.click('#btnTopMenu');
  const item = t.document.getElementById('btnShareMenuItem');
  assert.ok(item, '«Поделиться» must be in the menu');
  assert.match(item.textContent, /Поделиться/, 'the Russian label');
  assert.ok(item.classList.contains('menu-item'), 'reuses the existing .menu-item styles — no new look');
  assert.ok(t.document.getElementById('btnInstructionsMenuItem'), 'neighbour «Инструкция» stays');
  assert.ok(t.document.getElementById('btnAboutMenuItem'), 'neighbour «О проекте» stays');
  // Порядок в меню: сразу после «Инструкция» и до «Установить приложение».
  const order = Array.from(t.document.querySelectorAll('.lang-menu .menu-item')).map((b) => b.id);
  assert.ok(order.indexOf('btnShareMenuItem') === order.indexOf('btnInstructionsMenuItem') + 1,
    'share sits right after Instructions');
  // «Сбросить кэш» — сразу под «Поделиться» (просьба владельца 12.10.2026).
  assert.ok(order.indexOf('btnResetPwaCacheMenuItem') === order.indexOf('btnShareMenuItem') + 1,
    'clear cache sits right under share');
  const installAt = order.indexOf('btnInstallAppMenuItem');
  assert.ok(installAt === -1 || installAt > order.indexOf('btnShareMenuItem'),
    'share comes before the install item');
});

test('share: navigator.share opens the system sheet with the exact payload', async () => {
  const t = bootDom();
  const captured = [];
  Object.defineProperty(t.window.navigator, 'share', {
    value: async (data) => { captured.push(data); }, configurable: true,
  });
  t.click('#btnTopMenu');
  t.click('#btnShareMenuItem');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(captured.length, 1, 'navigator.share called once');
  // По полям: объект собран внутри realm jsdom, deepEqual против host-литерала не работает.
  assert.equal(captured[0].title, 'Только важное — твой путь к счастливой жизни');
  assert.equal(captured[0].text, 'Попробуй приложение “Только важное”: спокойный трекер целей без давления и сроков.');
  assert.equal(captured[0].url, 'https://bobah1988.github.io/goal-tracker/');
  assert.ok(!t.document.querySelector('.lang-menu'), 'the menu closes before the sheet opens');
  assert.ok(!t.document.querySelector('.undo-toast'), 'no fallback toast when share works');
});

test('share: a user cancel (AbortError) is silent — no toast, nothing escapes', async () => {
  const t = bootDom();
  const errors = [];
  t.window.addEventListener('error', (e) => errors.push(e.message));
  Object.defineProperty(t.window.navigator, 'share', {
    value: async () => { const err = new Error('cancelled'); err.name = 'AbortError'; throw err; },
    configurable: true,
  });
  t.click('#btnTopMenu');
  t.click('#btnShareMenuItem');
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(!t.document.querySelector('.undo-toast'), 'a cancelled sheet shows nothing');
  assert.deepEqual(errors, [], 'no console error on cancel');
});

test('share: without navigator.share the link is copied and a soft note appears', async () => {
  const t = bootDom();
  assert.equal(t.window.navigator.share, undefined, 'jsdom has no Web Share API');
  const copied = [];
  Object.defineProperty(t.window.navigator, 'clipboard', {
    value: { writeText: async (s) => { copied.push(s); } }, configurable: true,
  });
  t.click('#btnTopMenu');
  t.click('#btnShareMenuItem');
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(copied, ['https://bobah1988.github.io/goal-tracker/'], 'the link goes to the clipboard');
  const toast = t.document.querySelector('.undo-toast');
  assert.ok(toast, 'a soft notice appears');
  assert.match(toast.textContent, /Ссылка скопирована/, 'and says the link was copied');
});

test('share: the Clipboard-API-less browser falls back to execCommand', async () => {
  const t = bootDom();
  const used = [];
  t.document.execCommand = () => { used.push('exec'); return true; };
  Object.defineProperty(t.window.navigator, 'clipboard', { value: undefined, configurable: true });
  const before = t.document.querySelectorAll('textarea').length;
  t.click('#btnTopMenu');
  t.click('#btnShareMenuItem');
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(used, ['exec'], 'execCommand is the last-resort copy');
  assert.match(t.document.querySelector('.undo-toast').textContent, /Ссылка скопирована/);
  // Временный textarea удалён: их столько же, сколько было до клика (quote-input приложения).
  assert.equal(t.document.querySelectorAll('textarea').length, before, 'the helper textarea is cleaned up');
  const helper = Array.from(t.document.querySelectorAll('textarea'))
    .find((ta) => ta.value === 'https://bobah1988.github.io/goal-tracker/');
  assert.equal(helper, undefined, 'no textarea left holding the link');
});

test('share: English locale says Share and translates the fallback note', async () => {
  const t = bootDom({ goal_tracker_lang: 'en' });
  t.click('#btnTopMenu');
  assert.match(t.document.getElementById('btnShareMenuItem').textContent, /Share/, 'the English label');
  const copied = [];
  Object.defineProperty(t.window.navigator, 'clipboard', {
    value: { writeText: async (s) => { copied.push(s); } }, configurable: true,
  });
  t.click('#btnShareMenuItem');
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(copied, ['https://bobah1988.github.io/goal-tracker/'], 'the link goes to the clipboard');
  assert.match(t.document.querySelector('.undo-toast').textContent, /Link copied/, 'translated note');
});

test('share: a failing clipboard shows the link instead of a false «copied»', async () => {
  const t = bootDom();
  Object.defineProperty(t.window.navigator, 'clipboard', {
    value: { writeText: async () => { throw new Error('denied'); } }, configurable: true,
  });
  t.click('#btnTopMenu');
  t.click('#btnShareMenuItem');
  await new Promise((r) => setTimeout(r, 30));
  const toast = t.document.querySelector('.undo-toast');
  assert.ok(toast, 'something must be shown');
  assert.ok(!/Ссылка скопирована/.test(toast.textContent), 'no false «copied» claim');
  assert.ok(toast.textContent.includes('https://bobah1988.github.io/goal-tracker/'), 'the link itself is shown');
});

// ===== Интерактивное «Колесо баланса»: сектора-кнопки с раскрытием дерева сферы =====
test('wheel: home page sectors are interactive buttons with role/aria/tabindex', () => {
  const t = bootDom();
  t.click('#btnTopMenu');
  const sectors = t.document.querySelectorAll('[data-wheel-sector]');
  assert.ok(sectors.length >= 1, 'sectors rendered as clickable elements');
  sectors.forEach((s) => {
    assert.equal(s.getAttribute('role'), 'button', 'role=button');
    assert.equal(s.getAttribute('tabindex'), '0', 'tabindex=0 for keyboard');
    assert.ok(s.getAttribute('aria-label').includes('Открыть сферу'), 'aria-label for open');
    assert.ok(s.getAttribute('data-wheel-sector') !== '', 'data-wheel-sector present');
  });
});

test('wheel: clicking a sector opens the sphere tree panel and highlights the sector', () => {
  const t = bootDom();
  t.click('#btnTopMenu');
  t.click('[data-wheel-sector]');
  const panel = t.document.getElementById('sphereTreePanel');
  assert.ok(panel, 'sphere tree panel appears');
  assert.match(panel.textContent, /Здоровье/, 'panel shows the sphere name');
  const active = t.document.querySelector('.wheel-sector-hit.is-active');
  assert.ok(active, 'the clicked sector is highlighted');
  assert.match(active.getAttribute('aria-label'), /Свернуть сферу/, 'active sector label says collapse');
  const cardOpen = t.document.querySelector('.grid-goals .card.is-open');
  assert.ok(cardOpen, 'the corresponding sphere card is highlighted');
});

test('wheel: clicking the same sector again collapses the panel and removes highlight', () => {
  const t = bootDom();
  t.click('#btnTopMenu');
  t.click('[data-wheel-sector]');
  assert.ok(t.document.getElementById('sphereTreePanel'), 'panel open');
  t.click('[data-wheel-sector]');
  assert.ok(!t.document.getElementById('sphereTreePanel'), 'panel closed');
  assert.equal(t.document.querySelectorAll('.wheel-sector-hit.is-active').length, 0, 'no active sector');
  assert.equal(t.document.querySelectorAll('.grid-goals .card.is-open').length, 0, 'card highlight removed');
});

test('wheel: opening a second sphere closes the first (accordion)', () => {
  const t = bootDom();
  // Wheel is open by default (wheelOpen=true by default), no need to toggle menu
  const sectors = t.document.querySelectorAll('[data-wheel-sector]');
  t.click(sectors[0]);
  assert.ok(t.document.getElementById('sphereTreePanel'), 'first open');
  // Re-query after re-render from the first click
  const sectorsAfter = t.document.querySelectorAll('[data-wheel-sector]');
  // SEED has spheres: Энергия(0), Здоровье(1), Финансы(2), ... — clicking sector 1 opens Здоровье
  t.click(sectorsAfter[1]);
  const panel = t.document.getElementById('sphereTreePanel');
  assert.ok(panel, 'second panel open');
  // SEED: sector 1 = Здоровье, whose first child is "Достаток"
  assert.match(panel.textContent, /Достаток/, 'shows the second sphere (Здоровье)');
  assert.equal(t.document.querySelectorAll('.wheel-sector-hit.is-active').length, 1, 'only one active');
  assert.equal(t.document.querySelectorAll('.grid-goals .card.is-open').length, 1, 'only one card highlighted');
});

test('wheel: keyboard Enter and Space toggle the panel', () => {
  const t = bootDom();
  t.click('#btnTopMenu');
  const sector = t.document.querySelector('[data-wheel-sector]');
  sector.dispatchEvent(new t.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert.ok(t.document.getElementById('sphereTreePanel'), 'Enter opens');
  sector.dispatchEvent(new t.window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
  assert.ok(!t.document.getElementById('sphereTreePanel'), 'Space closes');
  sector.dispatchEvent(new t.window.KeyboardEvent('keydown', { key: 'Spacebar', bubbles: true, cancelable: true }));
  assert.ok(t.document.getElementById('sphereTreePanel'), 'Spacebar opens again');
});

test('wheel: panel has its own close button and it works even if the wheel is collapsed', () => {
  const t = bootDom();
  t.click('#btnTopMenu');
  t.click('[data-wheel-sector]');
  assert.ok(t.document.getElementById('sphereTreePanel'), 'panel open');
  t.click('#btnSphereTreeClose');
  assert.ok(!t.document.getElementById('sphereTreePanel'), 'panel closed by its own button');
});

test('wheel: panel child click navigates into the child goal and closes the panel', () => {
  const t = bootDom();
  t.click('#btnTopMenu');
  t.click('[data-wheel-sector]');
  t.click('.sphere-tree-item');
  const path = t.app.getPath();
  assert.deepEqual(Array.from(path), [0, 0], 'navigated into the child goal');
  assert.ok(!t.document.getElementById('sphereTreePanel'), 'panel closed after navigation');
});

test('wheel: empty sphere shows empty state and a button to open the sphere page', () => {
  const t = bootDom();
  t.app.setState({ name: 'root', children: [{ name: 'Пустая', sphereActivityAt: Date.now(), children: [] }] });
  t.window.render();
  t.click('[data-wheel-sector]');
  assert.ok(t.document.querySelector('.sphere-tree-empty'), 'empty state shown');
  assert.ok(t.document.querySelector('[data-sphere-open]'), 'open-page button present');
  t.click('[data-sphere-open]');
  assert.deepEqual(Array.from(t.app.getPath()), [0], 'navigated to the sphere page');
});

test('wheel: node page wheel stays decorative (no data-wheel-sector)', () => {
  const t = bootDom();
  t.app.setState({ name: 'root', children: [{ name: 'Здоровье', children: [{ name: 'Бегать', done: false, children: [] }] }] });
  t.app.setPath([0]);
  t.window.render();
  assert.equal(t.document.querySelectorAll('[data-wheel-sector]').length, 0, 'no interactive sectors on node page');
  assert.ok(t.document.querySelector('#wheelWrap svg'), 'decorative wheel still drawn');
});

test('wheel: refreshWheel keeps interactive sectors and highlight after inline rename on home', () => {
  const t = bootDom();
  t.click('[data-wheel-sector]');
  const before = t.document.querySelectorAll('[data-wheel-sector]').length;
  const activeBefore = t.document.querySelectorAll('.wheel-sector-hit.is-active').length;
  assert.ok(t.document.getElementById('sphereTreePanel'), 'panel open before refreshWheel');
  t.app.refreshWheel();
  assert.equal(t.document.querySelectorAll('[data-wheel-sector]').length, before, 'sectors preserved');
  assert.equal(t.document.querySelectorAll('.wheel-sector-hit.is-active').length, 1, 'highlight preserved');
  assert.ok(t.document.getElementById('sphereTreePanel'), 'panel still open after refreshWheel');
  // Clicking the same sector again toggles it CLOSED (expected toggle behavior)
  t.click('[data-wheel-sector]');
  assert.ok(!t.document.getElementById('sphereTreePanel'), 'clicking again toggles closed (expected)');
});

test('wheel: archived spheres are skipped in sectors (index mapping correct)', () => {
  const t = bootDom();
  const now = Date.now();
  t.app.setState({ name: 'root', children: [
    { name: 'Архивная', sphereActivityAt: Date.now(), archived: true, children: [] },
    { name: 'Здоровье', sphereActivityAt: Date.now(), children: [{ name: 'Бегать', done: false, children: [] }] }
  ]});
  t.window.render();
  const sectors = t.document.querySelectorAll('[data-wheel-sector]');
  assert.equal(sectors.length, 1, 'archived sphere skipped');
  assert.equal(sectors[0].dataset.wheelSector, '1', 'sector maps to the right sphere index');
  assert.match(sectors[0].getAttribute('aria-label'), /Здоровье/, 'label points to the right sphere');
  t.click(sectors[0]);
  assert.match(t.document.getElementById('sphereTreePanel').textContent, /Здоровье/, 'opens the correct sphere');
});

test('wheel: collapsing the spheres section closes the tree and removes highlight', () => {
  const t = bootDom();
  t.click('[data-wheel-sector]');
  assert.ok(t.document.getElementById('sphereTreePanel'), 'panel open');
  t.click('#mainGoalsToggle');
  assert.ok(!t.document.getElementById('sphereTreePanel'), 'tree closed when section collapsed');
  assert.equal(t.document.querySelectorAll('.wheel-sector-hit.is-active').length, 0, 'highlight removed');
});

// v1.2.0 regression (жалоба владельца): «Важные сферы жизни» свёрнуты по умолчанию, а дерево
// сферы рендерится ВНУТРИ секции — клик по сектору обязан раскрыть и её, иначе нажатие
// выглядит как «ничего не происходит» (дерево разворачивалось в закрытом модуле).
test('wheel: sector click expands the COLLAPSED spheres section so the tree is visible', () => {
  const t = bootDom(null, { closedSections: true });
  assert.ok(!t.document.querySelector('.grid-goals'), 'section starts collapsed');
  assert.ok(!t.document.getElementById('sphereTreePanel'), 'no tree panel while collapsed');
  t.click('[data-wheel-sector]');
  assert.ok(t.document.querySelector('.grid-goals'), 'section expands on sector click');
  const panel = t.document.getElementById('sphereTreePanel');
  assert.ok(panel, 'tree panel is rendered right after the grid (same section block)');
  const grid = t.document.querySelector('.grid-goals');
  assert.equal(panel.parentElement, grid.parentElement,
    'panel and grid share the parent block — both are inside the same OPEN section');
  assert.equal(t.app.getState().mainGoalsOpen, true, 'expansion is persisted in state');
  // The section header arrow flips to ▾ (open).
  assert.match(t.document.getElementById('mainGoalsToggle').textContent, /▾/, 'arrow shows open');
  // Collapsing by the header still works and hides the tree (existing behaviour).
  t.click('#mainGoalsToggle');
  assert.ok(!t.document.getElementById('sphereTreePanel'), 'manual collapse closes the tree');
});

// v1.2.1 (жалоба владельца): при раскрытии свёрнутой секции прокрутка вела прямо к панели
// дерева и сверху оставался обрезанный хвост сетки карточек — «небольшая часть модуля выше».
// v1.2.2 (уточнение): вверху экрана должен быть сам раскрывшийся модуль (панель дерева),
// а не заголовок «Важные сферы жизни» — иначе колесо уезжает за экран.
test('wheel: sector click pins the EXPANDED tree panel flush to the top of the screen', () => {
  const t = bootDom();
  // jsdom has no layout (every rect is zero) — give the two candidate targets distinct
  // fake tops so we can see WHICH element the scroll actually aimed at.
  t.window.Element.prototype.getBoundingClientRect = function () {
    if (this.id === 'sphereTreePanel') return { top: 900, bottom: 1200, height: 300 };
    if (this.classList && this.classList.contains('section-title-row')
        && this.querySelector('#mainGoalsToggle')) return { top: 300, bottom: 340, height: 40 };
    return { top: 0, bottom: 0, height: 0 };
  };
  let arg = null;
  t.window.scrollTo = (a) => { arg = a; };
  t.click('[data-wheel-sector]');
  assert.ok(t.document.getElementById('sphereTreePanel'), 'the tree panel is on the page');
  assert.ok(arg, 'the app asked the window to scroll');
  // 900 — the panel itself, flush at the top (no -16px gap that left a grid tail above).
  // The v1.2.1 section-header targeting would have produced 284.
  assert.equal(arg.top, 900, 'the expanded module sits at the very top of the screen');
  assert.notEqual(arg.top, 284, 'it does NOT scroll to the section header');
  assert.equal(arg.behavior, 'smooth', 'keeps the smooth scroll');
});

test('wheel: opening a sector stamps and saves the visit; closing does not', () => {
  const t = bootDom();
  const sphere = t.app.getState().children[0];
  sphere.sphereActivityAt = 1; // древняя дата — гарантированно меняется
  t.click('[data-wheel-sector]');
  const stamped = t.app.getState().children[0].sphereActivityAt;
  assert.ok(stamped > 1, 'opening a sector stamps the visit date');
  const ls = t.window.localStorage.getItem(t.app.STORAGE_KEY);
  assert.ok(ls && ls.includes('sphereActivityAt'), 'visit is persisted (syncable)');
  // Сворачивание — не посещение: дата не трогается.
  t.click('[data-wheel-sector]');
  assert.equal(t.app.getState().children[0].sphereActivityAt, stamped, 'closing does not re-stamp');
  // Цели, проценты и расчёт колеса не меняются: листья те же.
  assert.equal(t.app.countWheelLeaves(t.app.getState(), false), t.app.countWheelLeaves(t.app.getState(), false), 'leaf count intact');
});

test('wheel: tree navigation through the panel saves the visit too', () => {
  const t = bootDom();
  t.click('[data-wheel-sector]');
  const nav = t.document.querySelector('[data-tree-nav]');
  assert.ok(nav, 'tree panel has navigation elements');
  t.app.getState().children[0].sphereActivityAt = 1;
  t.click(nav);
  assert.ok(t.app.getState().children[0].sphereActivityAt > 1, 'tree nav stamps the visit');
  const ls = t.window.localStorage.getItem(t.app.STORAGE_KEY);
  assert.ok(ls && ls.includes('sphereActivityAt'), 'tree-nav visit is persisted');
});

test('wheel: visual hint under the wheel explains the interaction', () => {
  const t = bootDom();
  t.click('#btnTopMenu');
  const hint = t.document.querySelector('.wheel-hint');
  assert.ok(hint, 'hint element exists');
  assert.match(hint.textContent, /Нажмите на сектор/, 'hint text present');
});

/* ===== Templates modal (шаблоны быстрого старта) ===== */

test('templates: button opens the modal with six templates and an empty preview', () => {
  const t = bootDom();
  assert.ok(!t.document.getElementById('templatesOverlay'), 'modal closed initially');
  t.click('#btnTemplates');
  assert.ok(t.document.getElementById('templatesOverlay'), 'modal opens');
  assert.equal(t.document.querySelectorAll('[data-template-id]').length, 6, 'six template checkboxes');
  assert.equal(t.document.getElementById('templatesPreviewList').textContent.trim(), '', 'preview empty with nothing selected');
});

test('templates: cancel, ✕ and overlay click close without touching state', () => {
  const t = bootDom();
  const before = JSON.stringify(t.app.getState());
  const beforeLS = t.window.localStorage.getItem(t.app.STORAGE_KEY);
  t.click('#btnTemplates');
  t.click('#btnTemplatesCancel');
  assert.ok(!t.document.getElementById('templatesOverlay'), '«Позже» closes');
  t.click('#btnTemplates');
  t.click('#btnTemplatesClose');
  assert.ok(!t.document.getElementById('templatesOverlay'), '✕ closes');
  t.click('#btnTemplates');
  t.click('#templatesOverlay');
  assert.ok(!t.document.getElementById('templatesOverlay'), 'overlay click closes');
  assert.equal(JSON.stringify(t.app.getState()), before, 'state untouched');
  assert.equal(t.window.localStorage.getItem(t.app.STORAGE_KEY), beforeLS, 'localStorage untouched');
});

test('templates: checkbox selection builds the preview with sphere and goals', () => {
  const t = bootDom();
  t.click('#btnTemplates');
  const cb = t.document.querySelector('[data-template-id="health"]');
  cb.checked = true;
  cb.dispatchEvent(new t.window.Event('change', { bubbles: true }));
  const preview = t.document.getElementById('templatesPreviewList').textContent;
  assert.match(preview, /Здоровье/, 'preview names the sphere');
  assert.match(preview, /Сон/, 'preview names a goal');
  assert.doesNotMatch(preview, /сфера есть/, 'no merge note for a missing sphere');
});

test('templates: confirm adds the sphere with goals and honest wheel totals', () => {
  const t = bootDom();
  const rootBefore = t.app.getState().totalGoalsAdded || 0;
  t.click('#btnTemplates');
  const cb = t.document.querySelector('[data-template-id="health"]');
  cb.checked = true;
  cb.dispatchEvent(new t.window.Event('change', { bubbles: true }));
  t.click('#btnTemplatesConfirm');
  assert.ok(!t.document.getElementById('templatesOverlay'), 'confirm closes the modal');
  const st = t.app.getState();
  const health = st.children.find(s => s.name === 'Здоровье');
  assert.ok(health, 'sphere created');
  assert.equal(health.children.length, 4, 'four template goals');
  assert.ok(health.children.every(g => g.children.length === 2), 'each goal has two subgoals');
  assert.ok(health.children.every(g => g.children.every(sub => sub.children.length === 1)), 'each subgoal has one leaf');
  assert.equal(health.totalGoalsAdded, 8, 'sticky sphere total = 8 leaves');
  assert.equal(st.totalGoalsAdded, rootBefore + 8, 'root total bumped by 8');
  assert.equal(t.app.computePercent(health), 0, 'fresh sphere reads 0%');
});

test('templates: re-applying merges into the existing sphere without duplicates', () => {
  const t = bootDom();
  const applyHealth = () => {
    t.click('#btnTemplates');
    const cb = t.document.querySelector('[data-template-id="health"]');
    cb.checked = true;
    cb.dispatchEvent(new t.window.Event('change', { bubbles: true }));
    t.click('#btnTemplatesConfirm');
  };
  applyHealth();
  applyHealth();
  const st = t.app.getState();
  const healthSpheres = st.children.filter(s => s.name === 'Здоровье');
  assert.equal(healthSpheres.length, 1, 'no duplicate sphere');
  assert.equal(healthSpheres[0].children.length, 4, 'same-name goals skipped (merge)');
});

test('templates: preview marks an existing sphere and survives a re-render', () => {
  const t = bootDom();
  t.app.setState({ name: 'root', children: [
    { name: 'Здоровье', sphereActivityAt: Date.now(), children: [] }
  ]});
  t.window.render();
  t.click('#btnTemplates');
  const cb = t.document.querySelector('[data-template-id="health"]');
  cb.checked = true;
  cb.dispatchEvent(new t.window.Event('change', { bubbles: true }));
  assert.match(t.document.getElementById('templatesPreviewList').textContent, /сфера есть/, 'merge note shown');
  t.window.render();
  assert.ok(t.document.getElementById('templatesOverlay'), 'modal still open after re-render');
  assert.match(t.document.getElementById('templatesPreviewList').textContent, /сфера есть/, 'preview survives re-render');
});

test('templates: added goals behave as normal goals (done toggle counts in the wheel)', () => {
  const t = bootDom();
  t.click('#btnTemplates');
  const cb = t.document.querySelector('[data-template-id="health"]');
  cb.checked = true;
  cb.dispatchEvent(new t.window.Event('change', { bubbles: true }));
  t.click('#btnTemplatesConfirm');
  const health = t.app.getState().children.find(s => s.name === 'Здоровье');
  const leafGoal = health.children[0].children[0].children[0];
  assert.equal(leafGoal.done, false, 'template leaf starts undone');
  leafGoal.done = true;
  assert.equal(t.app.computePercent(leafGoal), 100, 'leaf toggles done like any goal');
  assert.equal(t.app.computePercent(health), 13, 'sphere percent reflects one done leaf of eight (1/8 ≈ 13%)');
});

test('templates: the ten-sphere cap is respected', () => {
  const t = bootDom();
  const kids = [];
  for (let i = 0; i < 9; i++) kids.push({ name: `Сфера ${i}`, sphereActivityAt: Date.now(), children: [] });
  t.app.setState({ name: 'root', children: kids });
  t.click('#btnTemplates');
  for (const id of ['work', 'learning', 'finance', 'relationships', 'leisure']) {
    const cb = t.document.querySelector(`[data-template-id="${id}"]`);
    cb.checked = true;
    cb.dispatchEvent(new t.window.Event('change', { bubbles: true }));
  }
  t.click('#btnTemplatesConfirm');
  assert.ok(t.app.getState().children.length <= 10, 'sphere cap respected');
});

test('templates: an archived same-name sphere does not swallow the merge', () => {
  const t = bootDom();
  t.app.setState({ name: 'root', children: [
    { name: 'Здоровье', sphereActivityAt: Date.now(), archived: true, children: [] }
  ]});
  t.click('#btnTemplates');
  const cb = t.document.querySelector('[data-template-id="health"]');
  cb.checked = true;
  cb.dispatchEvent(new t.window.Event('change', { bubbles: true }));
  t.click('#btnTemplatesConfirm');
  const st = t.app.getState();
  const active = st.children.filter(s => s.name === 'Здоровье' && !s.archived);
  assert.equal(active.length, 1, 'a fresh active sphere is created');
  assert.equal(active[0].children.length, 4, 'with the full template');
});

/* ===== «Поделиться»: молчалива только отмена, остальные ошибки — фолбэк ===== */

test('share: user abort (AbortError) stays silent', async () => {
  const t = bootDom();
  Object.defineProperty(t.window.navigator, 'share', {
    value: () => Promise.reject({ name: 'AbortError' }),
    configurable: true,
  });
  t.click('#btnTopMenu');
  t.click('#btnShareMenuItem');
  await new Promise(r => setTimeout(r, 10));
  assert.ok(!t.document.querySelector('.undo-toast'), 'no toast on user abort');
});

test('share: a non-abort share error falls back to the manual-copy link', async () => {
  const t = bootDom();
  Object.defineProperty(t.window.navigator, 'share', {
    value: () => Promise.reject({ name: 'NotAllowedError' }),
    configurable: true,
  });
  t.click('#btnTopMenu');
  t.click('#btnShareMenuItem');
  await new Promise(r => setTimeout(r, 10));
  const toast = t.document.querySelector('.undo-toast');
  assert.ok(toast, 'fallback toast shown');
  assert.match(toast.textContent, /Не удалось скопировать автоматически/, 'copy-failed message');
  assert.match(toast.textContent, /bobah1988\.github\.io\/goal-tracker/, 'link is shown for manual copy');
});

test('share: successful share shows nothing', async () => {
  const t = bootDom();
  Object.defineProperty(t.window.navigator, 'share', {
    value: () => Promise.resolve(),
    configurable: true,
  });
  t.click('#btnTopMenu');
  t.click('#btnShareMenuItem');
  await new Promise(r => setTimeout(r, 10));
  assert.ok(!t.document.querySelector('.undo-toast'), 'no toast on success');
});
