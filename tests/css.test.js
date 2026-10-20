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
/* ---- recursive parser: rules nested in @media keep their media context ----
   splitCss() above treats an @media block as ONE rule (its selector text is the
   media query, its body the whole block), so a guard that walks the rules never
   sees the hover rules INSIDE the gate. This parser descends into @media and
   reports every leaf rule with the list of media conditions it lives under.
   At-rules that are not containers of style rules (@keyframes) are skipped. */
function splitCssNested(html) {
  const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n');
  const rules = [];
  const walk = (text, media) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open < 0) break;
      const prelude = text.slice(i, open).trim();
      // find the matching closing brace
      let depth = 0, j = open;
      for (; j < text.length; j++) {
        if (text[j] === '{') depth++;
        else if (text[j] === '}') { depth--; if (depth === 0) break; }
      }
      const body = text.slice(open + 1, j);
      if (prelude.startsWith('@media')) {
        walk(body, media.concat(prelude));
      } else if (prelude.startsWith('@keyframes') || prelude.startsWith('@font-face')) {
        // not a container of style rules — ignore
      } else {
        const selectors = prelude.split(',').map(s => s.trim()).filter(Boolean);
        rules.push({ selectors, body, media });
      }
      i = j + 1;
    }
  };
  walk(css, []);
  return rules;
}
/* the media condition of the fine-pointer gate — the one that holds the hover rules */
const FINE_POINTER = '@media (hover: hover) and (pointer: fine)';
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
  // The suppressor must NOT match .tip-live — it has the same specificity and comes later,
  // so it would kill the timed bubble that is the ONLY hint a touch user gets.
  const suppressed = rules.filter(r =>
    /@media \(display-mode: standalone\) and \(hover: none\)/.test(r.selectors.join(' ')) &&
    /\[data-tip\][^{]*:hover::after[^}]*\{[^}]*content:none/.test(r.body.replace(/\s+/g, ' ')));
  assert.equal(suppressed.length, 1, 'a touch standalone PWA must suppress the hanging :hover tooltip');
  assert.doesNotMatch(suppressed.map(r => r.body).join(' '), /\[data-tip\]:hover::after/,
    'the suppressor must skip .tip-live — otherwise it kills the timed bubble on touch');
  assert.match(suppressed.map(r => r.body).join(' '), /:not\(\.tip-live\)/,
    'the suppressor must exclude .tip-live explicitly');
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

test('CSS guard: the main menu items are button tiles — own background, border, padding and font', () => {
  const rules = splitCss(HTML);
  const item = rules.find(r => r.selectors.some(s => /\.lang-menu \.menu-item\s*$/.test(s)));
  assert.ok(item, 'the .lang-menu .menu-item rule must exist');
  const body = item.body.replace(/\s+/g, ' ');
  // A menu that reads as a plain text table is what the owner complained about (2026-10-20):
  // every item must look like a BUTTON — own background, own border, comfortable padding.
  assert.match(body, /background:var\(--card2\)/, 'the tile needs its own background');
  assert.match(body, /border:1px solid var\(--border\)/, 'the tile needs its own border');
  assert.match(body, /padding:7px 11px/, 'the tile keeps compact padding');
  assert.match(body, /font-size:14px/, 'the tile needs its own font size');
  assert.match(body, /display:flex/, 'icon + label must sit in a row');
  // The icon column is fixed-width so the labels line up.
  const iconRule = rules.find(r => r.selectors.some(s => /\.lang-menu \.menu-item > i\s*$/.test(s)));
  assert.ok(iconRule, 'the icon column rule must exist');
  assert.match(iconRule.body.replace(/\s+/g, ' '), /width:19px/, 'the icon column is fixed-width');
});

test('CSS guard: the main menu has a «Меню» caption right next to the ✕, in one row', () => {
  const css = rawCss(HTML);
  const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map(m => ({
    sel: m[1].trim().replace(/\s+/g, ' '), body: m[2],
  }));
  const find = (sel) => rules.find(r => r.sel.split(',').some(x => x.trim().replace(/\s+/g, ' ').endsWith(sel)));
  // The head row: the caption is CENTRED in the panel, the ✕ stays in the right corner.
  // Grid 1fr auto 1fr — the middle (auto) column is exactly in the middle of the panel,
  // the two side columns split the rest evenly.
  const head = find('.lang-menu .menu-head');
  assert.ok(head, 'the .menu-head rule must exist');
  assert.match(head.body, /display:grid/, 'the menu head must be a grid');
  assert.match(head.body, /grid-template-columns:1fr auto 1fr/, 'the caption column must sit exactly in the middle');
  assert.match(head.body, /align-items:center/, 'the caption and the ✕ must be centred on one line');
  // The caption itself.
  const title = find('.lang-menu .menu-title');
  assert.ok(title, 'the .menu-title rule must exist');
  assert.match(title.body, /grid-column:2/, 'the caption must live in the middle column');
  assert.match(title.body, /text-align:center/, 'the caption must be centred');
  assert.match(title.body, /font-size:15px/, 'the caption needs its own font size');
  assert.match(title.body, /white-space:nowrap/, 'the caption must stay on one line');
  // The ✕ is no longer absolutely positioned — it shares the row with the caption.
  const close = find('.lang-menu button.menu-close');
  assert.ok(close, 'the .menu-close rule must exist');
  assert.match(close.body, /position:static/, 'the ✕ must share the row with the caption, not float over it');
  assert.match(close.body, /grid-column:3/, 'the ✕ must live in the right column');
  assert.match(close.body, /justify-self:end/, 'the ✕ must stay in the right corner');
  assert.match(close.body, /background:none/, 'the ✕ keeps its own background');
  assert.match(close.body, /padding:6px/, 'the ✕ keeps its own padding');
  // The panel no longer reserves 40px of empty space at the top for the floating ✕.
  const panel = find('.lang-menu');
  assert.ok(panel, 'the .lang-menu rule must exist');
  assert.doesNotMatch(panel.body, /padding:40px/, 'the panel must not reserve empty space for an absolute ✕');
});

test('CSS guard: the language and theme switches are compact pills, not text rows', () => {
  const rules = splitCss(HTML);
  // splitCss keeps a leading comment inside the selector text — match on the tail, not equality.
  const find = (sel) => rules.find(r => r.selectors.some(x => {
    const tail = x.replace(/\s+/g, ' ').trim();
    return tail === sel || tail.endsWith(' ' + sel);
  }));
  for (const sel of ['.lang-menu .lang-option', '.lang-menu .theme-option']) {
    const r = find(sel);
    assert.ok(r, `the ${sel} rule must exist`);
    const body = r.body.replace(/\s+/g, ' ');
    assert.match(body, /background:var\(--card2\)/, `${sel}: the switch needs its own background`);
    assert.match(body, /border:1px solid var\(--border\)/, `${sel}: the switch needs its own border`);
    assert.match(body, /border-radius:9px/, `${sel}: the switch must be a pill`);
    assert.match(body, /padding:5px/, `${sel}: the switch must stay compact`);
    assert.match(body, /font-size:16px/, `${sel}: the switch needs its own font size`);
    // The ACTIVE variant is a filled pill — that is what makes it read as a switch.
    const active = find(sel + '.active');
    assert.ok(active, `the ${sel}.active rule must exist`);
    assert.match(active.body.replace(/\s+/g, ' '), /background:var\(--accent\)/,
      `${sel}.active: the chosen variant must be filled with the accent colour`);
  }
  // The two switch rows live in one block — no separator line between them.
  const row = rules.find(r => r.selectors.some(x => /\.menu-lang-row/.test(x)) && r.selectors.some(x => /\.menu-theme-row/.test(x)));
  assert.ok(row, 'the shared switch-row rule must exist');
  assert.doesNotMatch(row.body, /border-top/, 'the switch rows must not be split by a line');
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
  // Auto margin on .actions pushes itself AND the ☰ behind it to the right edge.
  assert.match(body, /\.actions\{[^}]*order:2[^}]*margin-left:auto/,
    'the actions row must push itself (and ☰) to the right edge');
  assert.match(body, /\.top-menu-dropdown\{[^}]*order:3[^}]*\}/,
    'the menu button must come last (right) in the shared top row');
  assert.doesNotMatch(body, /\.topbar h1\{[^}]*order:/,
    'an order on h1 re-orders the wrap column — subtitle above title');
  // Главное меню — центрированная модалка (.menu-backdrop — flex-контейнер, .lang-menu внутри
  // него), привязка к краю (left/right) запрещена: она уводила бы панель из центра.
  const cssText = rules.map(r => r.selectors.join(',') + '{' + r.body + '}').join('\n');
  assert.doesNotMatch(cssText, /\.lang-menu\{[^}]*\b(left|right)\s*:/,
    'the main menu is a centered modal — no left/right anchoring on .lang-menu');
  assert.match(cssText, /\.menu-backdrop\{[^}]*display:flex[^}]*justify-content:center/,
    'the backdrop must centre the menu (flex + justify-content:center)');
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
  /* Аудит: печать КОЛЕСА — та же механика (body.wheel-printing + #wheelPrintRoot), но до сих
     пор не была под guard'ом: одно случайное правило вне @media print снова пустит владельца
     на пустой экран. Те же четыре проверки. */
  const wheelHide = printBlocks.filter(r => /body\.wheel-printing/.test(r.body));
  assert.ok(wheelHide.length >= 1, 'the print block must hide the app for the WHEEL print too');
  assert.ok(printBlocks.some(r => /#wheelPrintRoot\{[^}]*display:flex/.test(r.body.replace(/\s+/g, ' '))),
    'and must show #wheelPrintRoot there');
  const strayWheelHide = rules.filter(r => !/@media print/.test(r.selectors.join(' '))
    && /body\.wheel-printing/.test(r.body));
  assert.equal(strayWheelHide.length, 0,
    'no wheel-print hide rule outside @media print — same blank-screen bug as the wish board');
  assert.match(HTML, /#wheelPrintRoot\{[^}]*display:none[^}]*\}/s,
    'on screen the wheel print node must stay display:none');
  assert.match(HTML, /#wheelPrintRoot\{[^}]*-webkit-print-color-adjust:exact[^}]*\}/s,
    'and must ask the printer to keep colours');
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
  const rules = splitCssNested(cssNoComments(HTML));
  const gated = rules.filter(r => r.media.includes(FINE_POINTER));
  assert.ok(gated.length >= 1, 'the hover/pointer:fine gate must exist');
  const gateSel = gated.flatMap(r => r.selectors).join(' ');
  assert.match(gateSel, /#btnMove:hover/, 'the ↕ hover accent must live INSIDE the gate — outside it, it sticks after a tap');
  assert.match(gateSel, /#btnMoveChecklist:hover/, 'the checklist ↕ too');
  const gateBody = gated.map(r => r.body).join(' ');
  assert.doesNotMatch(gateBody, /#btnMove\.active/,
    'the real move-mode colour must stay OUTSIDE the gate: a touch user must still see the mode');
  const neutral = rules.filter(r => r.media.some(m => /pointer: coarse/.test(m))
    && r.selectors.some(s => /#btnMove:hover:not\(\.active\)/.test(s)));
  assert.ok(neutral.length >= 1,
    'the stuck-hover neutralisation must also match a coarse pointer (iOS says hover: hover)');
});

/* Регресс-сторож на «ховеры внутри гейта ещё и с touch-mode префиксом».
   Смысл: гейт (hover: hover) and (pointer: fine) НЕ спасает iOS — он рапортует
   hover:hover вместе с pointer:fine, поэтому гейт срабатывает, а :hover после тапа
   остаётся (WebKit, баг 158517). Третья линия обороны — класс .touch-mode на
   <html>: каждый hover-селектор ВНУТРИ гейта дополнительно закрыт
   :where(html:not(.touch-mode)), поэтому после первого касания ховер не красит.
   :where() выбран не случайно — он не добавляет специфичности, в отличие от
   html:not(.touch-mode), поэтому каскад остальных правил не меняется.
   Сторож обходит @media рекурсивно: старый splitCss() схлопывал медиа-блок в
   одно «правило» и не видел вложенных hover-правил вовсе. */
test('CSS guard: every hover rule inside the fine-pointer gate is closed by the touch-mode guard', () => {
  const rules = splitCssNested(cssNoComments(HTML));
  const gated = rules.filter(r => r.media.includes(FINE_POINTER));
  assert.ok(gated.length >= 1, 'the hover/pointer:fine gate must exist');
  const bad = [];
  let checked = 0;
  gated.forEach(r => {
    r.selectors.forEach(s => {
      if (!/:hover/.test(s)) return;
      checked++;
      if (!/^:where\(html:not\(\.touch-mode\)\)/.test(s)) bad.push(s);
    });
  });
  assert.ok(checked >= 50, `expected many hover rules in the gate, got ${checked}`);
  assert.deepEqual(bad, [],
    `these hover rules inside the fine-pointer gate are not closed by html:not(.touch-mode) — they stick after a tap on iOS: ${bad.join(', ')}`);
});

/* Подсказки [data-tip] — тот же класс проблемы: на таче пузырь висит вечно,
   потому что :hover не уходит. Поэтому hover-пузырь закрыт тем же префиксом,
   а показывает подсказку JS-класс .tip-live (1 секунда) — и в PWA, и в обычном
   мобильном браузере. Сторож: hover-пузырь закрыт, .tip-live — нет. */
test('CSS guard: the tooltip hover bubble is closed by the touch-mode guard, .tip-live is not', () => {
  const rules = splitCssNested(cssNoComments(HTML));
  const tipHover = rules.filter(r => r.selectors.some(s => /\[data-tip\]:hover::(after|before)$/.test(s))
    && !/content\s*:\s*none/.test(r.body));   // the content:none rule is a SUPPRESSOR, it must stay plain
  assert.ok(tipHover.length >= 1, 'the tooltip hover bubble rules must exist');
  tipHover.forEach(r => {
    r.selectors.forEach(s => {
      if (!/\[data-tip\]:hover::(after|before)$/.test(s)) return;
      assert.match(s, /^:where\(html:not\(\.touch-mode\)\)/,
        `the tooltip hover bubble must be closed by the touch-mode guard, got: ${s}`);
    });
  });
  const live = rules.filter(r => r.selectors.some(s => /\[data-tip\]\.tip-live::(after|before)$/.test(s)));
  assert.ok(live.length >= 1,
    'the timed .tip-live bubble must exist — it is what shows the hint on a touch screen');
  live.forEach(r => {
    r.selectors.forEach(s => {
      if (!/\[data-tip\]\.tip-live::(after|before)$/.test(s)) return;
      assert.doesNotMatch(s, /touch-mode/,
        `.tip-live must NOT be gated by touch-mode — it is the touch bubble itself: ${s}`);
    });
  });
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

/* Репорт владельца 19.10.2026 (v1.2.55): в PWA на iPhone кнопка «↕» после тапа
   остаётся залита СВЕТЛО-СИНИМ. Разбор, почему прежние фиксы не помогали:
   наши :hover-правила меняют только ЦВЕТ ТЕКСТА и РАМКУ — фона они не красят
   (а .active дал бы надпись «Готово», а не стрелки «↕»). Значит заливку рисует
   САМ БРАУЗЕР поверх содержимого, и никакой авторский background её не перебьёт.
   Четыре предыдущие попытки (v1.1.61, v1.1.87, v1.2.52, v1.2.54) гасили только
   наш собственный :hover — поэтому и не помогали.
   Три линии защиты, каждая проверяется этим сторожем:
     1) -webkit-tap-highlight-color:transparent — гасит системную подсветку тапа;
     2) appearance:none на <button> — убирает нативную «стеклянную» отрисовку
        кнопки (iOS 26 рисует её поверх авторского фона);
     3) .touch-mode … :active — гасит залипающее нажатие. */
/* Разбор CSS на правила с ЧИСТЫМ селектором: комментарий перед правилом
   не должен попадать в селектор (иначе искажение селектора ломает проверки).
   Скан по глубине скобок — как в splitCss выше, только без @media-разбора. */
function rules_with_sel(css) {
  const out = [];
  let buf = '', depth = 0;
  for (const ch of css) {
    buf += ch;
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (ch === '}' && depth === 0) {
      const m = buf.trim().match(/^([^{]+)\{([\s\S]*)\}$/);
      if (m) {
        const sel = m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim();
        if (sel && !sel.startsWith('@')) out.push({ sel, body: m[2] });
      }
      buf = '';
    }
  }
  return out;
}

test('CSS guard: the UA press highlight and the native button chrome are switched off', () => {
  const css = rawCss(HTML);
  // 1) системная подсветка нажатия
  assert.match(css, /-webkit-tap-highlight-color\s*:\s*transparent/,
    'the UA tap highlight must be switched off — it is painted OVER the content');
  // Правило <html>{…} с этим свойством: свойство НАСЛЕДУЕТСЯ, поэтому одного
  // правила на <html> достаточно для всего документа.
  assert.match(css, /html\s*\{[^}]*-webkit-tap-highlight-color\s*:\s*transparent/,
    'the tap-highlight reset must sit on <html> — the property is inherited, so one rule covers the document');
  // 2) нативная отрисовка кнопки
  assert.match(css, /button\s*\{[^}]*appearance\s*:\s*none/,
    'the native button appearance must be switched off (appearance:none) — iOS 26 otherwise draws its own glass capsule over the button');
  // 3) залипающее нажатие. Проверяем СТРОГО: :active должен быть в СЕЛЕКТОРЕ
  // того же правила, что и .touch-mode (иначе регулярка нашла бы «чужое» :active
  // через запятую или закрывающую скобку — проверка вскрыла бы, но не поймала).
  const touchActive = rules_with_sel(css).filter(r =>
    r.sel.includes('.touch-mode') && r.sel.includes(':active'));
  assert.ok(touchActive.length >= 1,
    'the stuck :active state must be neutralised for touch');
  // Конкретно: единственные правила, красящие :active, — «Печать» на доске желаний
  // и ссылка в подвале. Обе должны быть погашены на тач.
  assert.ok(touchActive.some(r => r.sel.includes('.wish-print-btn:active')),
    'the wish «Печать» button paints :active with the accent — it must be neutralised for touch');
  assert.ok(touchActive.some(r => r.sel.includes('footer a:active')),
    'the footer link paints :active with the accent — it must be neutralised for touch');
  // Режимные цвета (.active) обязаны УЦЕЛЕТЬ — их тач-пользователь видит.
  assert.match(css, /#btnMove\.active\s*,\s*#btnMoveChecklist\.active\s*\{[^}]*background\s*:\s*var\(--accent\)/,
    'the real move-mode colour must survive the touch guards');
});

/* Снимает нативный вид кнопки — только если у КАЖДОЙ кнопки фон, рамка, отступы
   и кегль заданы явно. Иначе кнопка осталась бы «голой» (тот самый баг с
   белыми кнопками, что ловили четыре раза). */
function rules_with(css, selector) {
  const out = [];
  const re = new RegExp('(^|[},])\\s*' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'g');
  let m;
  while ((m = re.exec(css))) out.push(m[2]);
  return out;
}

test('CSS guard: every button keeps its own background, border, padding and font-size', () => {
  const css = rawCss(HTML);
  // Каждая кнопка получает вид из СВОЕГО правила (по id/классу) либо из правила
  // контейнера («.auth-panel button{…}», «.topbar button{…}») — и то и другое задано
  // автором. Проверяем инвариант по исходнику: у каждого <button> есть правило,
  // которое даёт ему фон (не none), рамку, отступы и кегль.
  const decl = (body, prop) => {
    const m = body.match(new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*([^;]+)'));
    return m ? m[1].trim() : null;
  };
  // Фон должен быть ЗАДАН автором — любым значением. `background:none` (голые иконки
  // .star-btn, .today-action, .quote-btn) — тоже авторское решение: заливки нет by design.
  // Важно лишь, что решение есть: без него appearance:none оставил бы кнопку с
  // НАТИВНОЙ заливкой браузера (тот баг с «белыми кнопками»).
  const hasBgDecl = (r) => decl(r.body, 'background') || decl(r.body, 'background-color');
  // Все правила CSS: селектор → тело.
  const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map(m => ({
    sel: m[1].trim().replace(/\s+/g, ' '), body: m[2],
  }));
  // <style> исключаем: текст «<button>» в CSS-комментарии не кнопка.
  const markup = HTML.replace(/<style[^>]*>[\s\S]*?<\/style>/g, '');
  const buttons = [...markup.matchAll(/<button\b[^>]*>/g)].map(m => m[0]);
  assert.ok(buttons.length > 100, `expected plenty of buttons, got ${buttons.length}`);
  const seen = new Set();
  const naked = [];
  for (const tag of buttons) {
    const id = (tag.match(/id="([^"]+)"/) || [])[1] || '';
    const cls = ((tag.match(/class="([^"]+)"/) || [])[1] || '').replace(/\$\{[^}]*\}/g, '').trim();
    const key = id + '|' + cls;
    if (seen.has(key)) continue;
    seen.add(key);
    // Классы-контейнеры вокруг кнопки: разметка собирается в шаблонных строках,
    // поэтому берём окно исходника вокруг тега.
    const at = HTML.indexOf(tag);
    const around = HTML.slice(Math.max(0, at - 4000), at + tag.length + 4000);
    const ctxClasses = [...around.matchAll(/class="([^"$]+)"/g)]
      .flatMap(m => m[1].split(/\s+/)).filter(Boolean);
    // Правила, которые могут красить эту кнопку: по её id/классу ИЛИ по контейнеру.
    const hits = rules.filter(r => {
      if (id && r.sel.includes('#' + id)) return true;
      if (cls.split(/\s+/).filter(Boolean).some(c => r.sel.includes('.' + c))) return true;
      // правило-контейнер: «.X … button»
      if (!/(^|[\s,>+~])button(?![\w-])/.test(r.sel)) return false;
      return ctxClasses.some(c => r.sel.includes('.' + c));
    });
    const hasBg = hits.some(r => hasBgDecl(r));
    const hasBorder = hits.some(r => decl(r.body, 'border'));
    const hasPad = hits.some(r => decl(r.body, 'padding'));
    const hasFont = hits.some(r => decl(r.body, 'font-size'));
    if (!(hasBg && hasBorder && hasPad && hasFont)) {
      naked.push({ id: id || '.' + cls, hasBg, hasBorder, hasPad, hasFont });
    }
  }
  // Кнопка должна получать от автора ВСЕ ЧЕТЫРЕ свойства: фон, рамку, отступы и кегль.
  // Фоном может быть и `background:none` (осознанный «голый» вид иконки — .star-btn,
  // .today-action, .checklist-remove): тогда и рамка должна быть none, иначе appearance:none
  // оставил бы кнопку с чужой нативной рамкой.
  const problems = naked.filter(b => !(b.hasBorder && b.hasPad && b.hasFont));
  assert.deepEqual(problems, [],
    `these buttons have no border/padding/font of their own — appearance:none would strip the native ones: ${JSON.stringify(problems)}`);
  const noBg = naked.filter(b => !b.hasBg).map(b => b.id);
  assert.deepEqual(noBg, [],
    `these buttons have no background of their own — appearance:none would leave them unpainted: ${noBg.join(', ')}`);
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

/* v1.2.61: iOS zoom-on-focus. Safari расширяет весь вьюпорт («экран расширяется, контент
   вылезает»), когда фокус падает на редактируемое поле с кеглем НИЖЕ 16px — это порог iOS.
   Владелец заметил на «Хорошем сегодня» и модалках; двойной тап возвращал зум. Сторож:
   у каждого редактируемого поля (открывает клавиатуру) кегль ≥ 16px. */
test('CSS guard: editable text fields are at least 16px (iOS zoom-on-focus)', () => {
  const css = rawCss(HTML);
  // Селекторы редактируемых полей, что открывают клавиатуру: инлайн-правка целей/дел,
  // дневник, недельная рефлексия, поиск по дереву, поиск в пикере переноса.
  const editable = [
    '.today-input{',            // «Три важных дела» — инлайн-правка
    '.good-today-textarea{',    // «Хорошее сегодня» + «Победы за неделю»
    '.goal-input{',             // инлайн-переименование карточек
    '.checklist-edit-input{',   // правка пункта чек-листа
    '.checklist-add-row input{',// добавление пункта чек-листа
    '.relocate-search{',        // поиск в пикере переноса
    '.auth-panel input{',       // формы авторизации/аккаунта
    '.wish-form input[type=text]{', // подпись карточки желаний
    '.challenge-title-input{',  // название челленджа (v1.2.62)
  ];
  for(const sel of editable){
    const rule = css.match(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^}]*\\}'));
    assert.ok(rule, `editable field rule ${sel} must exist`);
    const fs = rule[0].match(/font-size:\s*(\d+)px/);
    assert.ok(fs, `${sel} must declare a px font-size`);
    assert.ok(Number(fs[1]) >= 16,
      `${sel} is ${fs[1]}px — iOS zooms the PWA viewport on focus below 16px`);
  }
  // Глобальный поиск в модалке задаёт кегль инлайн-стилем, не CSS-правилом.
  const searchInput = HTML.match(/id="searchInput"[\s\S]*?>/);
  assert.ok(searchInput, 'searchInput must render');
  const inlineFs = searchInput[0].match(/font-size:\s*(\d+)px/);
  assert.ok(inlineFs && Number(inlineFs[1]) >= 16,
    'searchInput inline style must be at least 16px (iOS zoom-on-focus)');
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

/* v1.2.63: календарь челленджа стал компактнее — клетка 32px вместо 44px.
   Сторож фиксирует новую геометрию и то, что её НЕ сломали:
   - клетка ровно 32×32 (width+height, без aspect-ratio/min-height:44px);
   - колонки сетки фиксированной ширины (repeat(7,32px)) — 1fr растянул бы клетку
     обратно на всю карточку;
   - число дня и метка ✓/✗ стоят в разных углах (absolute), иначе в 32px они
     наезжают друг на друга;
   - кегль номера и метки ≥ 12px (общий сторож «no font-size below 12px»
     ловит кегль, но не ловит НАЛОЖЕНИЕ — это ловит здесь). */
test('CSS guard: the challenge calendar cells are 32px and their marks fit', () => {
  const css = rawCss(HTML);
  const rules = splitCss(cssNoComments(HTML));
  const find = (sel) => rules.find(r => r.selectors.includes(sel));
  const grid = rules.find(r => r.selectors.includes('.challenge-weekdays')
    && r.selectors.includes('.challenge-grid'));
  assert.ok(grid, 'the calendar grid rule must exist');
  assert.match(grid.body, /grid-template-columns\s*:\s*repeat\(\s*7\s*,\s*32px\s*\)/,
    'the grid must use FIXED 32px columns — 1fr would stretch the cells back to the card width');
  const day = find('.challenge-day');
  assert.ok(day, 'the .challenge-day rule must exist');
  assert.match(day.body, /width\s*:\s*32px/, '.challenge-day must be 32px wide');
  assert.match(day.body, /height\s*:\s*32px/, '.challenge-day must be 32px tall');
  assert.ok(!/min-height\s*:\s*44px/.test(day.body),
    '.challenge-day must not keep the old 44px min-height');
  const num = find('.challenge-day .cd-num');
  const mark = find('.challenge-day .cd-mark');
  assert.ok(num && mark, 'the day number and the ✓/✗ mark rules must exist');
  assert.match(num.body, /position\s*:\s*absolute/, 'the day number is pinned to the corner');
  assert.match(mark.body, /position\s*:\s*absolute/, 'the mark is pinned too — otherwise it overlaps the number');
  assert.match(num.body, /top\s*:/, 'the day number is pinned to the TOP edge');
  assert.match(mark.body, /bottom\s*:/, 'the mark is pinned to the BOTTOM edge — they must not share one edge');
});

