/* Guards for the two bug classes that the DOM/click tests structurally cannot see:
   1. CSS cascade — jsdom never computes styles, so a button missing from the base
      action-button rule renders browser-white and no test complains. This recurred four
      times in one session (page-nav buttons v1.1.24/26, wish «Исправить» v1.1.35/41).
   2. Tooltips — the custom [data-tip] bubble never shows on touch/PWA, so a button left on
      the native `title=` attribute silently loses its hint (reported for the subgoal view,
      where half the buttons used `title=`).
   Both guards read the real source, not a copy. */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { boot } = require('./helpers');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

/* ---- tiny <style> parser (comments are inside rules, so brace depth is enough) ---- */
function splitCss(html) {
  const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n');
  const rules = [];
  let buf = '', depth = 0;
  for (const ch of css) {
    buf += ch;
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (ch === '}' && depth === 0) { rules.push(buf.trim()); buf = ''; }
  }
  return rules.map(r => {
    const m = r.match(/^([^{]+)\{([\s\S]*)\}$/);
    if (!m) return null;
    const selectors = m[1].split(',').map(s => s.trim()).filter(Boolean);
    return { selectors, body: m[2] };
  }).filter(Boolean);
}
/* id of a selector's subject — '#btnEdit.icon-btn' → 'btnEdit' */
function subjectId(sel) {
  const m = sel.match(/(^|[\s>])#([A-Za-z0-9_-]+)/);
  return m ? m[2] : null;
}

/* Buttons painted through an ANCESTOR rule instead of their own #id rule. Keep this list
   empty of anything that can simply be added to the base action-button rule — each entry
   must name the rule that actually paints it. */
const PAINTED_BY_ANCESTOR = {
  btnSearch: '.topbar button { background:var(--card2) }',
};

test('CSS guard: every compact .icon-btn id is painted with a real background', () => {
  const rules = splitCss(HTML);
  // The compact list carries font-size/padding/min-width — a button listed ONLY there is
  // the exact shape of the recurring white-button bug.
  const compactIds = new Set();
  rules.forEach(r => {
    r.selectors.forEach(s => {
      const id = subjectId(s);
      if (id && /\.icon-btn/.test(s)) compactIds.add(id);
    });
  });
  assert.ok(compactIds.size > 5, `expected a decent number of compact buttons, got ${compactIds.size}`);
  // Which ids are actually given a background somewhere?
  const painted = new Set();
  rules.forEach(r => {
    if (!/background\s*:\s*var\(--card2\)/.test(r.body)) return;
    r.selectors.forEach(s => {
      const id = subjectId(s);
      if (id) painted.add(id);
    });
  });
  const unpainted = [...compactIds]
    .filter(id => !painted.has(id) && !(id in PAINTED_BY_ANCESTOR))
    .sort();
  assert.deepEqual(unpainted, [],
    'these .icon-btn buttons get font-size/padding from the compact list but NO background, ' +
    'so they render browser-default white: ' + unpainted.join(', ') +
    '. Add each id to the base action-button rule (the one setting background:var(--card2)).');
});

test('CSS guard: the compact list exists and the painted list is not accidentally empty', () => {
  const rules = splitCss(HTML);
  const basePainted = rules.filter(r => /background\s*:\s*var\(--card2\)/.test(r.body) &&
    r.selectors.some(s => /^#(btnEdit|btnGoodTodayHistory|btnWishManage)/.test(s)));
  assert.ok(basePainted.length > 0, 'the base action-button rule must still exist');
});

/* The DOM-side twin of the CSS guards lives in click.test.js (it needs jsdom's real DOM, so it is
   written next to the bootDom harness that provides it). */

test('CSS guard: PWA tooltips time out — a .tip-live bubble exists and the stuck :hover one is off', () => {
  const rules = splitCss(HTML);
  // The class-driven bubble: JS adds .tip-live on tap and removes it after 1s.
  const bubble = rules.filter(r => r.selectors.some(s => /\[data-tip\]\.tip-live::after/.test(s)));
  assert.ok(bubble.length > 0, 'the PWA tooltip needs a [data-tip].tip-live::after bubble rule');
  // Touch has no hover to leave: without this the bubble hangs forever after a tap (owner report).
  const suppressed = rules.filter(r =>
    /@media \(display-mode: standalone\) and \(hover: none\)/.test(r.selectors.join(' ')) &&
    /\[data-tip\]:hover::after[^}]*\{[^}]*content:none/.test(r.body.replace(/\s+/g, ' ')));
  assert.equal(suppressed.length, 1, 'a touch standalone PWA must suppress the hanging :hover tooltip');
});

/* A double-tap used to zoom the page in the installed PWA: the app widened and ran off both
   edges, and only a deliberate pinch-out got you back. touch-action:manipulation kills the
   double-tap zoom while keeping panning and on-purpose pinch-zoom. */
test('CSS guard: a double-tap never zooms the PWA (touch-action:manipulation on the shell)', () => {
  const rules = splitCss(HTML);
  for (const sel of ['html', 'body']) {
    // splitCss keeps the leading comment inside the selector text, so match on the last token
    const r = rules.find(x => x.selectors.some(s => s.split(/\s+/).pop() === sel));
    assert.ok(r, sel + ' rule must exist');
    assert.match(r.body, /touch-action:manipulation/,
      sel + ' must set touch-action:manipulation — a missing one lets a double-tap zoom the app off-screen');
  }
  // The drag layer keeps its own gesture contract.
  const drag = rules.find(x => /touch-action:none/.test(x.body));
  assert.ok(drag, 'the drag handle must keep touch-action:none (drag-to-reorder)');
  // Никакого maximum-scale/user-scalable в мете: они ломают зум для слабовидящих, а iOS их и так
  // игнорирует — зум гасится жестом, а не запретом.
  assert.doesNotMatch(HTML, /user-scalable\s*=\s*no|maximum-scale/,
    'do not disable zoom in the viewport meta — touch-action is the right lever');
});

test('CSS guard: the narrow/PWA topbar moves the whole title wrap and puts ☰ last on its row', () => {
  const rules = splitCss(HTML);
  const narrow = rules.find(r => /@media \(max-width:480px\)/.test(r.selectors.join(' ')));
  assert.ok(narrow, 'the 480px block must exist');
  const body = narrow.body.replace(/\s+/g, ' ');
  // order/width must sit on .app-title-wrap — the actual flex item of .topbar. On .topbar h1 they
  // do nothing at topbar level AND reorder the wrap's own column, putting the subtitle ABOVE the
  // title (the reported bug). The ☰ then lands mid-row instead of at the right edge.
  // The wrap now carries order:3 (the three controls take the top row, the title moves below it)
  // — the point of the assertion is order+width TOGETHER on the wrap, never on .topbar h1.
  assert.match(body, /\.app-title-wrap\{[^}]*order:3[^}]*width:100%/,
    'the title wrap must get order+width, not .topbar h1');
  // Auto margin on .actions pushes the actions row AND the ☰ behind it to the right edge, so ☰
  // still anchors its dropdown (right:0) where it always did.
  assert.match(body, /\.actions\{[^}]*order:1[^}]*margin-left:auto/,
    'the actions row must come first and push itself (and ☰) to the right edge');
  assert.match(body, /\.top-menu-dropdown\{[^}]*order:2[^}]*\}/,
    'the menu button must sit with the other two, last (right) in the top row');
  assert.doesNotMatch(body, /\.topbar h1\{[^}]*order:/,
    'an order on h1 re-orders the wrap column — subtitle above title');
  assert.match(body, /\.lang-menu\{left:auto; right:0;?\}/,
    'a right-edge ☰ needs its dropdown anchored right');
});

/* On touch, WebKit deliberately keeps :hover sticky after a tap (see the long note in index.html).
   iOS reports `hover: hover` while still doing it, so a hover:none-only fix never fires there.
   Two independent defences must therefore exist: the hover painting is gated to real pointers,
   and the stuck-hover neutralisation also matches a coarse pointer. */
test('CSS guard: hover feedback is gated to real pointers, so no touch button can stay blue', () => {
  const rules = splitCss(HTML);
  const gated = rules.filter(r => /@media \(hover: hover\) and \(pointer: fine\)/.test(r.selectors.join(' ')));
  assert.ok(gated.length >= 1, 'the hover/pointer:fine gate must exist');
  const gateBody = gated.map(r => r.body).join(' ');
  assert.match(gateBody, /#btnMove:hover, #btnMoveChecklist:hover/,
    'the ↕ hover accent must live INSIDE the gate — outside it, it sticks after a tap');
  assert.doesNotMatch(gateBody, /#btnMove\.active/,
    'the real move-mode colour must stay OUTSIDE the gate: a touch user must still see the mode');
  const neutral = rules.filter(r => /pointer: coarse/.test(r.selectors.join(' '))
    && /#btnMove:hover:not\(\.active\)/.test(r.body));
  assert.ok(neutral.length >= 1,
    'the stuck-hover neutralisation must also match a coarse pointer (iOS says hover: hover)');
});

test('CSS guard: touch standalone PWA neutralizes the stuck hover on the goal action buttons', () => {
  const rules = splitCss(HTML);
  const block = rules.find(r =>
    /@media \(display-mode: standalone\) and \(hover: none\)/.test(r.selectors.join(' ')) &&
    /#btnMove:hover:not\(\.active\)/.test(r.body));
  assert.ok(block, 'the ↕ button must not stay stuck blue (accent border) after a tap in a touch PWA');
  // Real mode colours survive: an ACTIVE ↕ is still blue and says «Готово».
  assert.doesNotMatch(block.body, /#btnMove:hover\{/,
    'a blanket #btnMove:hover override would also erase the real move-mode colour');
});

