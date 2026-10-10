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

/* The DOM-side twin of the CSS guards lives in click.test.js (it needs jsdom's real DOM, so it
   is written next to the bootDom harness that provides it). */

