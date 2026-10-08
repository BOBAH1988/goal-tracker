'use strict';
/* Regression guard: the inline <script> in index.html must boot in isolation.
   Catches syntax errors, missing declarations, and browser-global leaks before prod. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, readProjectFile } = require('./helpers');

test('index.html: inline script parses and boots', () => {
  const t = boot();
  assert.ok(t.app, 'production functions must be published');
  assert.equal(typeof t.app.computePercent, 'function');
  assert.equal(typeof t.app.wheelPercent, 'function');
  assert.equal(typeof t.app.render, 'undefined', 'render internals must stay private');
});

test('sw.js: cache name and assets are sane', () => {
  const sw = readProjectFile('sw.js');
  assert.match(sw, /CACHE_NAME\s*=\s*'goal-tracker-v\d+'/);
  for (const asset of ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png']) {
    assert.ok(sw.includes(asset), `sw.js must cache ${asset}`);
  }
});

test('manifest.json: parses and declares icons', () => {
  const manifest = JSON.parse(readProjectFile('manifest.json'));
  assert.equal(manifest.display, 'standalone');
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0);
});

test('index.html: shells out the PWA hooks', () => {
  const html = readProjectFile('index.html');
  assert.ok(html.includes('manifest.json'), 'manifest link missing');
  assert.ok(html.includes('./sw.js') || html.includes("'./sw.js'"), 'service worker registration missing');
});
