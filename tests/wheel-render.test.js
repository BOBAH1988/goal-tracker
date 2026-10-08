'use strict';
/* SVG wheel geometry: sectors, arcs and labels must stay well-formed for any sphere count. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, leaf, container } = require('./helpers');

const t = boot();
const { polarToCartesian, wedgePath, arcPath, wheelHTML } = t.app;

test('polarToCartesian: 0° is top, 90° is right', () => {
  const top = polarToCartesian(100, 100, 50, 0);
  const right = polarToCartesian(100, 100, 50, 90);
  assert.ok(Math.abs(top.x - 100) < 1e-9 && Math.abs(top.y - 50) < 1e-9);
  assert.ok(Math.abs(right.x - 150) < 1e-9 && Math.abs(right.y - 100) < 1e-9);
});

test('wedgePath/arcPath: emit SVG arc commands', () => {
  assert.match(wedgePath(100, 100, 50, 0, 90), /^M 100 100 L [\d.]+ [\d.]+ A 50 50/);
  assert.match(arcPath(100, 100, 50, 0, 90), /^M [\d.]+ [\d.]+ A 50 50/);
});

test('wheelHTML: shape scales with sphere count', () => {
  const mk = (i) => container([leaf(i % 2 === 0)], { name: `s${i}`, total: 1 });
  assert.equal(wheelHTML([]), '', 'empty wheel must render nothing');
  for (const n of [1, 2, 4, 6]) {
    const svg = wheelHTML(Array.from({ length: n }, (_, i) => mk(i)));
    assert.ok(svg.startsWith('<svg'), `n=${n}: must start with <svg`);
    assert.ok(svg.endsWith('</svg>'), `n=${n}: must close </svg>`);
    const labels = (svg.match(/<textPath/g) || []).length;
    assert.equal(labels, n, `n=${n}: must label every sector`);
    for (let i = 0; i < n; i++) {
      assert.ok(svg.includes(`wheelArc${i}`), `n=${n}: arc id wheelArc${i} missing`);
    }
  }
});

test('wheelHTML: always draws 10 grid rings + center dot', () => {
  const svg = wheelHTML([container([leaf(true)], { total: 1 })]);
  const rings = (svg.match(/fill="none" stroke="var\(--muted\)"/g) || []).length;
  assert.equal(rings, 10, 'grid scale must stay at 10 rings');
  assert.ok(svg.includes('<circle cx="286" cy="160" r="3"'), 'center dot missing');
});

test('wheelHTML: escapes hostile sphere names (XSS guard)', () => {
  const evil = container([leaf(true)], { name: '<script>alert(1)</script>', total: 1 });
  const svg = wheelHTML([evil]);
  assert.ok(!svg.includes('<script>alert(1)'), 'raw script tag must not leak into SVG');
  assert.ok(svg.includes('&lt;script&gt;'), 'name must be escaped');
});
