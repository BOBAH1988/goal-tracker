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
/* The full <style> text (with comments), for guards that must see comments. */
function rawCss(html) {
  return [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n');
}
/* CSS without block comments — the splitCss parser treats a leading comment as part of
   the selector text, which would confuse guards that match selector prefixes. Returns
   the HTML with the <style> tags intact, so splitCss() can still find the blocks. */
function cssNoComments(html) {
  return html.replace(/<style[^>]*>([\s\S]*?)<\/style>/g,
    (m) => m.replace(/\/\*[\s\S]*?\*\//g, ''));
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

/* A long press in the installed app opened the copy/paste selection menu — easy to fire by
   accident while scrolling, and a native app never does that for chrome text. The fix lives in
   the standalone block and exempts real fields, so your own goal text stays selectable. */
test('CSS guard: the standalone PWA has no accidental text-copy callout', () => {
  const rules = splitCss(HTML);
  // The PLAIN standalone block — not the hover:none variant, and not the comma list that also
  // carries max-width:480px. splitCss keeps the leading comment and splits media lists on the
  // comma, so anchor on the query ENDING the selector string.
  const standalone = rules.find(r => /@media \(display-mode: standalone\)\s*$/.test(r.selectors.join(' ').trim()));
  assert.ok(standalone, 'the standalone block must exist');
  const body = standalone.body.replace(/\s+/g, ' ');
  assert.match(body, /body\{[^}]*user-select:none[^}]*\}/,
    'the PWA shell must disable text selection (a long press then has nothing to select)');
  assert.match(body, /-webkit-touch-callout:none/,
    'iOS needs -webkit-touch-callout:none — it is the property that hides the native copy menu');
  assert.match(body, /input, textarea\{[^}]*-webkit-user-select:text/,
    'real fields must stay selectable — you copy your own goal text from them');
  assert.match(body, /input, textarea\{[^}]*-webkit-touch-callout:default/,
    'and the callout must come back for them, or pasting into a field is impossible');
});

test('CSS guard: the narrow/PWA topbar moves the whole title wrap and puts ☰ last on its row', () => {
  const rules = splitCss(HTML);
  const narrow = rules.find(r => /@media \(max-width:480px\)/.test(r.selectors.join(' ')));
  assert.ok(narrow, 'the 480px block must exist');
  const body = narrow.body.replace(/\s+/g, ' ');
  // order/width must sit on .app-title-wrap — the actual flex item of .topbar. On .topbar h1 they
  // do nothing at topbar level AND reorder the wrap's own column, putting the subtitle ABOVE the
  // title (the reported bug). The ☰ then lands mid-row instead of at the right edge.
  // The wrap carries order:1 and the flexible slot, so the title shares the top row with the
  // buttons (title left, buttons right) instead of dropping to a row of its own. The point of the
  // assertion is order+flex TOGETHER on the wrap, never on .topbar h1.
  assert.match(body, /\.app-title-wrap\{[^}]*order:1[^}]*flex:1 1 auto[^}]*min-width:0/,
    'the title wrap must get order+flex, not .topbar h1');
  // Auto margin on .actions pushes itself AND the ☰ behind it to the right edge, so ☰ still
  // anchors its dropdown (right:0) where it always did.
  assert.match(body, /\.actions\{[^}]*order:2[^}]*margin-left:auto/,
    'the actions row must push itself (and ☰) to the right edge');
  assert.match(body, /\.top-menu-dropdown\{[^}]*order:3[^}]*\}/,
    'the menu button must come last (right) in the shared top row');
  assert.doesNotMatch(body, /\.topbar h1\{[^}]*order:/,
    'an order on h1 re-orders the wrap column — subtitle above title');
  assert.match(body, /\.lang-menu\{left:auto; right:0;?\}/,
    'a right-edge ☰ needs its dropdown anchored right');
});

/* On touch, WebKit deliberately keeps :hover sticky after a tap (see the long note in index.html).
   iOS reports `hover: hover` while still doing it, so a hover:none-only fix never fires there.
   Two independent defences must therefore exist: the hover painting is gated to real pointers,
   and the stuck-hover neutralisation also matches a coarse pointer. */
/* Длинная подсказка у кнопки у краю вылезала за границу экрана (репорт владельца). Пузырь теперь
   переносится по строкам с потолком ширины, а положение у края двигает positionTip(). */
test('CSS guard: the tip bubble wraps instead of running off the screen', () => {
  const rules = splitCss(HTML);
  const tip = rules.find(r => r.selectors.some(s => /\[data-tip\]:hover::after/.test(s)));
  assert.ok(tip, 'the tip bubble rule must exist');
  const body = tip.body.replace(/\s+/g, ' ');
  assert.match(body, /white-space:normal/, 'long labels must wrap instead of overflowing');
  assert.match(body, /max-width:min\(64vw, ?240px\)/, 'and be capped so the wrap has a limit');
  assert.match(body, /width:max-content/, 'short labels stay one line wide');
  // Прижатие к краю: классы, которые вешает positionTip().
  const hasLeft = rules.some(r => r.selectors.some(s => /\[data-tip\]\.tip-left::after/.test(s))
    && /left:0/.test(r.body));
  const hasRight = rules.some(r => r.selectors.some(s => /\[data-tip\]\.tip-right::after/.test(s))
    && /right:0/.test(r.body));
  assert.ok(hasLeft, 'a bubble at the left edge must be able to hug it');
  assert.ok(hasRight, 'a bubble at the right edge must be able to hug it');
});

/* Репорт владельца: тап «Печать» в PWA убирал всё приложение с экрана и оставлял пустой экран,
   который нельзя ни закрыть, ни отправить на печать. Причина: правило, скрывающее приложение ради
   печати, висело ВНЕ @media print, поэтому срабатывало сразу на экране, а печатный узел оставался
   display:none. Оно обязано жить внутри @media print — и только там. */
test('CSS guard: hiding the app for print happens ONLY inside @media print', () => {
  const rules = splitCss(HTML);
  // Внутри @media print скрытие приложения и показ печатного узла.
  const printBlocks = rules.filter(r => /@media print/.test(r.selectors.join(' ')));
  assert.ok(printBlocks.length >= 1, 'the @media print block must exist');
  const hiding = printBlocks.filter(r => /body\.wish-printing/.test(r.body));
  assert.ok(hiding.length >= 1, 'the print block must hide the app');
  assert.ok(printBlocks.some(r => /#wishPrintRoot\{[^}]*display:flex/.test(r.body.replace(/\s+/g, ' '))),
    'and must show the print node there');
  // И НИГДЕ больше: вне печати это правило не имеет права существовать — именно оно, висевшее без
  // обёртки, убирало всё приложение с экрана сразу после тапа «Печать» (репорт владельца).
  const strayHide = rules.filter(r => !/@media print/.test(r.selectors.join(' '))
    && /body\.wish-printing/.test(r.body));
  assert.equal(strayHide.length, 0,
    'no hide rule outside @media print — on screen it blanked the whole app');
  // Экранное правило узла (невидим + print-color-adjust). Парсер правил здесь грубоват из-за
  // соседнего @page, поэтому проверяем прямо по CSS.
  assert.match(HTML, /#wishPrintRoot\{[^}]*display:none[^}]*\}/s,
    'on screen the print node must stay display:none');
  assert.match(HTML, /#wishPrintRoot\{[^}]*-webkit-print-color-adjust:exact[^}]*\}/s,
    'and must ask the printer to keep the theme background');
});

/* Репорт владельца: меню кнопки «Аккаунт» рисовало слово «Выйти» вертикально —
   по букве на строку. Причина: .account-menu абсолютно позиционирован БЕЗ
   width/min-width, поэтому его ширина сжималась до ширины триггера (#btnAccount
   — 38 px в PWA и на узком экране), а внутренние отступы кнопки (24 px)
   съедали почти всю её. Меню обязано размериться по содержимому (как .lang-menu),
   а слова — не переноситься. */
test('CSS guard: the account menu sizes to its content, words stay horizontal', () => {
  const rules = splitCss(HTML);
  const menu = rules.find(r => r.selectors.includes('.account-menu'));
  assert.ok(menu, 'the .account-menu rule must exist');
  assert.match(menu.body, /width:max-content/,
    'the menu must size to its content, not to the narrow #btnAccount');
  const btn = rules.find(r => r.selectors.includes('.account-menu button'));
  assert.ok(btn, 'the .account-menu button rule must exist');
  assert.match(btn.body, /white-space:nowrap/,
    'every word in the account menu stays horizontal');
});

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

/* Репорт владельца 11.10.2026: «↕ снова голубая в PWA». iOS рапортует
   hover:hover ВМЕСТЕ с pointer:fine — гейт hover-правил срабатывает, а
   глушение по pointer:coarse нет: WebKit оставляет :hover после тапа, кнопка
   «Перемещение» светится акцентом. Третья линия обороны не зависит от
   медиа-фич: документ помечается на первом touchstart, ховеры глушатся
   классом; цвета режимов (.active) остаются — они вне :not(). */
test('CSS guard: no // comments inside <style> (they invalidate whole rules)', () => {
  // Аудит: внутри CSS были //-комментарии — невалидный синтаксис. Парсер браузера
  // отбрасывает правило, на котором стоит такая строка, целиком: .touch-mode
  // .wheel-sector-hit:hover и .touch-mode .sphere-reminder-actions… молча не работали.
  const css = rawCss(HTML);
  const bad = [];
  css.split('\n').forEach((line, i) => {
    if (/^\s*\/\//.test(line)) bad.push(`line ${i + 1}: ${line.trim().slice(0, 60)}`);
  });
  assert.deepEqual(bad, [],
    `// inside CSS is invalid syntax — the rule it sits on is dropped by the parser: ${bad.join('; ')}`);
  // And the two rules that were lost must actually parse now.
  const rules = splitCss(cssNoComments(HTML));
  const touchRules = rules.filter(r => r.selectors.some(s => /^\.touch-mode /.test(s)));
  assert.ok(touchRules.some(r => r.selectors.some(s => /\.wheel-sector-hit:hover/.test(s))),
    'the .touch-mode .wheel-sector-hit:hover rule must survive the parser');
  assert.ok(touchRules.some(r => r.selectors.some(s => /\.sphere-reminder-actions/.test(s))),
    'the .touch-mode .sphere-reminder-actions rule must survive the parser');
});

/* Аудит: ховер-правила вне гейта (hover: hover) and (pointer: fine) залипают на
   тач-устройствах после тапа (баг v1.1.87, «↕ голубая в PWA»). Сторож: каждое
   :hover-правило с цветом/рамкой либо внутри гейта, либо в списке .touch-mode. */
test('CSS guard: every paint-changing :hover rule is gated or neutralised for touch', () => {
  const rules = splitCss(cssNoComments(HTML));
  const isGated = (r) => r.selectors.join(' ').startsWith('@media (hover: hover) and (pointer: fine)');
  const isTouchNeutral = (r) => r.selectors.some(s => /^\.touch-mode /.test(s));
  const strays = [];
  rules.forEach(r => {
    if (isGated(r) || isTouchNeutral(r)) return;
    if (/\[data-tip\]/.test(r.selectors.join(' '))) return; // tooltip bubble has its own rules
    if (/::file-selector-button|::after|::before/.test(r.selectors.join(' '))) return;
    r.selectors.forEach(s => {
      if (/:hover/.test(s) && /color|background|border|fill|opacity|transform/.test(r.body)) {
        strays.push(s);
      }
    });
  });
  assert.deepEqual(strays, [],
    `these :hover rules paint outside the hover/pointer gate and stick after a tap on iOS/Android: ${strays.join(', ')}`);
});

/* Аудит: тап-таргеты 18–24px вместо ≥44px на частых действиях (.chk, .star-btn,
   .priority-remove, .crumb). Прозрачный ::after{inset:-Npx} доводит зону до 44px,
   не меняя вид. Сторож: у каждого такого элемента есть и position:relative, и ::after. */
test('CSS guard: the small frequent targets carry a ≥44px hit area', () => {
  const rules = splitCss(cssNoComments(HTML));
  const find = (sel) => rules.find(r => r.selectors.includes(sel));
  ['.chk', '.star-btn', '.priority-remove', '.breadcrumb span.crumb'].forEach(sel => {
    const base = find(sel);
    assert.ok(base, `${sel} rule must exist`);
    assert.match(base.body, /position\s*:\s*relative/,
      `${sel} needs position:relative so its hit-area ::after anchors to it`);
    const after = find(`${sel}::after`);
    assert.ok(after, `${sel}::after hit-area rule must exist`);
    assert.match(after.body, /inset\s*:\s*-\d+px/,
      `${sel}::after must expand the tap target (inset:-Npx)`);
    // Math check: on at least one axis the visible box plus the inset must reach 44px.
    const insets = [...after.body.matchAll(/inset\s*:\s*-(\d+)px(?:\s+-(\d+)px)?/g)]
      .map(m => [Number(m[1]), m[2] ? Number(m[2]) : Number(m[1])]);
    const bestInset = Math.max(...insets.flat());
    // The real box is width/height when present; font-size is the fallback for bare text
    // glyphs (.star-btn, .priority-remove) that have no explicit box.
    const box = [...base.body.matchAll(/(?:width|height)\s*:\s*(\d+)px/g)].map(m => Number(m[1]));
    const font = [...base.body.matchAll(/font-size\s*:\s*(\d+)px/g)].map(m => Number(m[1]));
    // A padded text chip (breadcrumb) has no explicit box: padding + the inherited line box
    // is its size, so fall back to padding×2 + a conservative 13px line height.
    const pad = [...base.body.matchAll(/padding\s*:\s*(\d+)px/g)].map(m => Number(m[1]));
    const measured = box.length ? box : (font.length ? font : pad.map(p => p * 2 + 13));
    assert.ok(measured.length > 0, `${sel}: no measurable size found`);
    measured.forEach(size => {
      assert.ok(size + 2 * bestInset >= 44,
        `${sel}: ${size}px + 2×${bestInset}px must reach ≥44px on one axis, got ${size + 2 * bestInset}px`);
    });
  });
});

test('CSS guard: the touch-mode class neutralises every stuck hover', () => {
  const rules = splitCss(HTML);
  const move = rules.find(r => r.selectors.includes('.touch-mode #btnMove:hover:not(.active)'));
  assert.ok(move, 'the .touch-mode guard rule must exist');
  assert.match(move.body, /color:var\(--muted\)/, 'and drop the accent back to muted');
  assert.ok(rules.some(r => r.selectors.includes('.touch-mode .topbar button:hover')),
    'topbar buttons are covered too');
  assert.ok(rules.some(r => r.selectors.includes('.touch-mode .goal-row .actions button:hover')),
    'card action buttons are covered too');
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

/* Репорт владельца: клик по сектору колеса рисует вокруг SVG фокусный
   прямоугольник. Базовое правило обязано гасить outline (никакого
   прямоугольника ни мышью, ни тачем), а :focus-visible — оставаться
   для клавиатуры (Tab + Enter/Space): доступность не жертвуется. */
test('CSS guard: wheel sectors show no focus rectangle on click, but keep a keyboard ring', () => {
  const rules = splitCss(HTML);
  // splitCss keeps a leading comment inside the selector text, so match the
  // selector ENDING: the base rule ends with the bare class, the others with
  // :hover / :focus-visible / .is-active.
  const base = rules.find(r => r.selectors.some(s => /\.wheel-sector-hit\s*$/.test(s)));
  assert.ok(base, 'the base .wheel-sector-hit rule must exist');
  assert.match(base.body, /outline\s*:\s*none/,
    'the base rule must suppress the outline — a click on a sector must not draw a focus rectangle');
  const kb = rules.find(r => r.selectors.some(s => /\.wheel-sector-hit:focus-visible/.test(s)));
  assert.ok(kb, 'the :focus-visible rule must exist for keyboard users');
  assert.match(kb.body, /outline\s*:\s*2px solid var\(--accent\)/,
    'keyboard focus keeps a visible accent ring');
});

/* Аудит: модалки на статическом 100vh уезжали за экран на iPhone (клавиатура/панель браузера),
   а кнопки формы — под home-indicator. Сторож: overlay обязан нести safe-area-отступы,
   scrollable-панель — dvh-фолбэк после vh. */
test('CSS guard: modals carry safe-area padding and a 100dvh fallback', () => {
  // cssNoComments: у .auth-modal-overlay перед селектором стоит блочный комментарий-заголовок,
  // иначе splitCss склеивает его с селектором.
  const rules = splitCss(cssNoComments(HTML));
  const overlay = rules.find(r => r.selectors.includes('.auth-modal-overlay'));
  assert.ok(overlay, 'the modal overlay rule must exist');
  assert.match(overlay.body, /env\(safe-area-inset-bottom\)/,
    'the overlay must pad for the home indicator');
  assert.match(overlay.body, /env\(safe-area-inset-top\)/,
    'the overlay must pad for the notch/status bar');
  const panel = rules.find(r => r.selectors.includes('.auth-panel.scrollable'));
  assert.ok(panel, 'the scrollable panel rule must exist');
  const maxes = [...panel.body.matchAll(/max-height\s*:\s*calc\(100(v|d)?vh/g)].map(m => m[1] || 'v');
  assert.deepEqual(maxes, ['v', 'd'],
    'max-height must be declared twice: 100vh fallback first, then 100dvh');
});

/* ===== Аудит: доступность и контраст ===== */

test('CSS guard: prefers-reduced-motion is honoured', () => {
  const css = rawCss(HTML);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/,
    'the app must respect the reduced-motion preference');
  const block = css.match(/@media \(prefers-reduced-motion: reduce\)\{[\s\S]*?\}\s*\}/);
  assert.ok(block, 'the reduced-motion block must contain a rule');
  assert.match(block[0], /transition-duration\s*:\s*0\.01ms\s*!important/,
    'transitions must be neutralised');
  assert.match(block[0], /animation-duration\s*:\s*0\.01ms\s*!important/,
    'animations must be neutralised');
});

/* WCAG relative luminance + contrast ratio — used by the palette guard below. */
function hexLum(hex) {
  const m = hex.match(/^#([0-9a-f]{6})$/i);
  assert.ok(m, `not a 6-digit hex colour: ${hex}`);
  const ch = [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16) / 255)
    .map(c => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
function contrastRatio(a, b) {
  const [hi, lo] = [hexLum(a), hexLum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('CSS guard: --muted text meets WCAG AA (4.5:1) against its own card background', () => {
  // Аудит: в розовой теме --muted:#a1657f давал ≈3.7:1 на card2. Сторож проверяет все темы.
  const themes = [...rawCss(HTML).matchAll(/(?:--card2:(#[0-9a-f]{6}).*?--muted:(#[0-9a-f]{6}))/gi)];
  assert.ok(themes.length >= 3, `expected three themes, got ${themes.length}`);
  themes.forEach(([, card2, muted]) => {
    const ratio = contrastRatio(muted, card2);
    assert.ok(ratio >= 4.5,
      `--muted:${muted} on card2:${card2} is ${ratio.toFixed(2)}:1 — must be ≥4.5:1`);
  });
});

/* Аудит: шрифт 11px — ниже комфортного минимума на телефоне (6 мест). Сторож: в CSS не
   должно остаться ни одного кегля меньше 12px. */
test('CSS guard: no font-size below 12px', () => {
  const sizes = [...rawCss(HTML).matchAll(/font-size:\s*(\d+)px/g)].map(m => Number(m[1]));
  assert.ok(sizes.length > 100, `expected plenty of font-size declarations, got ${sizes.length}`);
  const tooSmall = [...new Set(sizes.filter(s => s < 12))].sort((a, b) => a - b);
  assert.deepEqual(tooSmall, [],
    `font sizes below 12px are unreadable on touch: ${tooSmall.join(', ')}px`);
});

/* Аудит: два дубля @media (max-width:360px) для .wish-grid были разбросаны по файлу.
   Собраны в один блок — и он должен стоять ПОСЛЕ data-cols-правил, иначе каскад
   (та же специфичность 0-2-0) отдаст узкому экрану «3/4 в ряд» вместо сжатия до двух. */
test('CSS guard: exactly one max-width:360px block, after the wish-grid data-cols rules', () => {
  const css = rawCss(HTML);
  const blocks = [...css.matchAll(/@media \(max-width:360px\)/g)];
  assert.equal(blocks.length, 1,
    `expected a single max-width:360px block, found ${blocks.length}`);
  const blockPos = css.search(/@media \(max-width:360px\)/);
  const colsPos = css.search(/\.wish-grid\[data-cols="4"\]/);
  assert.ok(colsPos > -1, 'the data-cols rules must still exist');
  assert.ok(blockPos > colsPos,
    'the 360px block must come AFTER the data-cols rules (same specificity — order decides)');
});

