'use strict';
/* sw.js guards. The service worker is a plain script with no test coverage of its own, yet two
   of its decisions decide whether an installed PWA ever sees a new version:
     • the shell cache key (a cache-busting "?_sw=<ts>" reload must still resolve to the shell),
     • the marker validation (an operator's "white list" page must never be cached as the shell).
   These run the real sw.js in a vm with a fake CacheStorage + fetch. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SW_PATH = path.join(__dirname, '..', 'sw.js');
const SW_SRC = fs.readFileSync(SW_PATH, 'utf8');
// The build under test, read from the sources so a version bump cannot redden these guards.
const BUILD = (fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8').match(/APP_VERSION = '([^']+)'/) || [])[1];

// Fake CacheStorage: an in-memory map keyed by url, enough for match/put/keys/delete/open.
function fakeCaches(seed) {
  const store = new Map(Object.entries(seed || {}));
  return {
    keys: async () => [...store.keys()],
    open: async () => ({
      match: async (req) => {
        const key = typeof req === 'string' ? req : (req.url || String(req));
        if (store.has(key)) return store.get(key);
        // Query/relative fallbacks, same idea as the real Cache API.
        for (const [k, v] of store) { if (k.endsWith(key) || key.endsWith(k)) return v; }
        return undefined;
      },
      put: async (req, res) => { store.set(typeof req === 'string' ? req : (req.url || String(req)), res); },
    }),
  };
}
function res(text, ok) {
  return { ok: ok !== false, body: {}, clone() { return this; }, text: async () => String(text), type: 'basic', status: 200 };
}
function bootSw(opts) {
  opts = opts || {};
  const sandbox = {
    caches: fakeCaches(opts.seed),
    console,
    setTimeout, clearTimeout, AbortController,
    fetch: async (req) => {
      const url = typeof req === 'string' ? req : (req.url || String(req));
      const body = opts.responseFor ? opts.responseFor(url) : res('<html><body id="app">Shell</body></html>');
      if (opts.networkError) throw new Error('offline');
      return body;
    },
    self: { addEventListener() {}, skipWaiting() {}, clients: { claim() {} } },
    Request: class Request { constructor(u) { this.url = String(u); } },
    Response: class Response { constructor(body, init) { this.body = body; this.status = (init && init.status) || 200; this.headers = (init && init.headers) || {}; } },
    URL,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SW_SRC, sandbox, { filename: 'sw.js' });
  return sandbox;
}

test('sw: the shell cache key canonicalises a cache-busting navigation', async () => {
  const sw = bootSw({ seed: { './index.html': res('<html><body id="app">Fresh</body></html>') } });
  const key = vm.runInContext('navCacheKey(new Request("https://x.app/goal-tracker/?_sw=1697000000000"))', sw);
  assert.equal(key, './index.html', 'a ?_sw= navigation resolves to the canonical shell key');
  const root = vm.runInContext('navCacheKey(new Request("https://x.app/goal-tracker/"))', sw);
  assert.equal(root, './index.html', 'the start_url resolves to the same single key');
  const asset = vm.runInContext('navCacheKey(new Request("https://x.app/goal-tracker/manifest.json"))', sw);
  assert.equal(String(asset.url || asset), 'https://x.app/goal-tracker/manifest.json', 'assets keep their own key');
});

test('sw: an operator "white list" page is never cached as the shell', async () => {
  const sw = bootSw({
    responseFor: () => res('<html><body>Оператор: доступ ограничен</body></html>'), // no id="app"
  });
  const ok = await vm.runInContext('(async () => cacheIfAppShell(new Request("./index.html"), await caches.open("x"), await fetch("./index.html")))()', sw);
  assert.equal(ok, false, 'a response without the app marker is rejected');
  const keys = await vm.runInContext('caches.keys()', sw);
  assert.deepEqual(keys, [], 'and nothing lands in the cache');
});

test('sw: the real shell passes validation and is cached under the canonical key', async () => {
  const sw = bootSw();
  const ok = await vm.runInContext('(async () => cacheIfAppShell(new Request("https://x.app/g/?_sw=1"), await caches.open("goal-tracker-v1"), await fetch("./index.html")))()', sw);
  assert.equal(ok, true, 'a real shell is accepted');
  const put = await vm.runInContext('(async () => (await caches.open("goal-tracker-v1")).match("./index.html"))()', sw);
  assert.ok(put, 'cached under ./index.html even though the request carried ?_sw');
});

test('sw: a cached shell from an older build is detected as stale', async () => {
  const sw = bootSw();
  const shell = (version) => ({
    ok: true, body: {}, clone() { return this; },
    text: async () => '<html><body id="app">const APP_VERSION = \'' + version + '\';</body></html>',
  });
  // A shell stamped with an OLDER build than this worker is stale (the "stuck PWA" case).
  sw.__stale = shell('stale-' + BUILD);
  const stale = await vm.runInContext('(async () => isStaleShell(globalThis.__stale))()', sw);
  assert.equal(stale, true, 'a shell stamped with an older APP_VERSION is stale');
  // The shell of this worker's own build is current.
  sw.__fresh = shell(BUILD);
  const fresh = await vm.runInContext('(async () => isStaleShell(globalThis.__fresh))()', sw);
  assert.equal(fresh, false, "the shell of the worker's own build is not stale");
  // No recognisable stamp (an operator page) — never treat it as "just old", the cache wins.
  sw.__unknown = { ok: true, body: {}, clone() { return this; }, text: async () => '<html><body>оператор</body></html>' };
  const unknown = await vm.runInContext('(async () => isStaleShell(globalThis.__unknown))()', sw);
  assert.equal(unknown, false, 'an unrecognised stamp is not treated as stale (the cache wins)');
});

test('sw: SELF_VERSION comes from CACHE_NAME', () => {
  const sw = bootSw();
  assert.equal(vm.runInContext('SELF_VERSION', sw), BUILD, 'the worker knows its own build');
  const stamped = "shellVersion(\"<x>const APP_VERSION = 'stale-\" + SELF_VERSION + \"';</x>\")";
  assert.equal(vm.runInContext(stamped, sw), 'stale-' + BUILD, 'the shell version is read from the HTML');
});
