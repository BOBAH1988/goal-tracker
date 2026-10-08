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
  assert.match(sw, /CACHE_NAME\s*=\s*'goal-tracker-v[\d.]+'/);
  for (const asset of ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png']) {
    assert.ok(sw.includes(asset), `sw.js must cache ${asset}`);
  }
});

test('manifest.json: parses and declares icons', () => {
  const manifest = JSON.parse(readProjectFile('manifest.json'));
  assert.equal(manifest.display, 'standalone');
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0);
});

test('version: single source of truth, synced everywhere', () => {
  const t = boot();
  const v = t.app.APP_VERSION;
  assert.match(v, /^\d+\.\d+\.\d+$/, 'APP_VERSION must be MAJOR.MINOR.PATCH');
  const html = readProjectFile('index.html');
  assert.ok(html.includes(`const APP_VERSION = '${v}'`), 'APP_VERSION declaration missing');
  assert.ok(html.includes('· v${APP_VERSION}'), 'footer must render the version');
  assert.equal(JSON.parse(readProjectFile('package.json')).version, v, 'package.json out of sync');
  assert.equal(JSON.parse(readProjectFile('manifest.json')).version, v, 'manifest.json out of sync');
  assert.ok(
    readProjectFile('sw.js').includes(`goal-tracker-v${v}`),
    'sw.js CACHE_NAME must follow the app version so updates bust the cache'
  );
});

test('index.html: shells out the PWA hooks', () => {
  const html = readProjectFile('index.html');
  assert.ok(html.includes('manifest.json'), 'manifest link missing');
  assert.ok(html.includes('./sw.js') || html.includes("'./sw.js'"), 'service worker registration missing');
});
