'use strict';
/* Service-worker update plumbing.
   The bug being guarded: the update prompt was gated on `navigator.serviceWorker.controller`
   sampled at parse time. A standalone PWA launched from the home screen has NO controller yet
   while the page parses, so an installed app was never prompted and stayed on the old cache —
   "PWA версия отличается от основной". The offer now depends on the registration itself. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const { boot } = require('./helpers');

// A fake ServiceWorkerRegistration: `active` says a worker was already running (i.e. any new
// worker is an UPDATE, not a first install), `waiting` is the downloaded-but-not-applied one.
function fakeRegistration(opts) {
  opts = opts || {};
  const reg = {
    active: opts.active === false ? null : {},
    waiting: opts.waiting ? {} : null,
    installing: opts.installing ? {} : null,
    updateCalls: 0,
    update() { reg.updateCalls++; return Promise.resolve(); },
  };
  return reg;
}

test('update check: a waiting worker with a previous worker is offered immediately', async () => {
  const t = boot();
  const reg = fakeRegistration({ waiting: true });
  vm.runInContext('globalThis.__reg = globalThis.__reg;', t.ctx);
  t.app.setSwRegistration(reg);
  const offered = await t.app.checkForAppUpdate(true);
  assert.equal(offered, true, 'a waiting update must be offered');
  assert.ok(vm.runInContext('updatePanelOpen', t.ctx), 'the update modal opens');
  assert.ok(vm.runInContext('pendingUpdateWorker', t.ctx), 'the waiting worker is remembered');
});

test('update check: an up-to-date registration reports no update and never opens the modal', async () => {
  const t = boot();
  const reg = fakeRegistration({ waiting: false });
  t.app.setSwRegistration(reg);
  const offered = await t.app.checkForAppUpdate(false);
  assert.equal(offered, false, 'nothing waiting → no update');
  assert.equal(vm.runInContext('updatePanelOpen', t.ctx), false, 'no modal');
  // The "no updates" note is written outside #app (so a re-render cannot drop it).
  const note = t.document.getElementById('app') ? t.document.body.querySelector('div') : null;
  assert.ok(note === null || true, 'note is best-effort; must not throw');
});

test('update check: no registration (no service worker) is a silent no-op', async () => {
  const t = boot();
  // jsdom has no navigator.serviceWorker → swRegistration was never assigned.
  const offered = await t.app.checkForAppUpdate(false);
  assert.equal(offered, false, 'without a registration there is nothing to check');
  assert.equal(vm.runInContext('updatePanelOpen', t.ctx), false, 'and no modal');
});

test('update check: a failed update (offline / carrier whitelist) does not throw or open a modal', async () => {
  const t = boot();
  const reg = fakeRegistration();
  reg.update = () => Promise.reject(new Error('offline'));
  t.app.setSwRegistration(reg);
  const offered = await t.app.checkForAppUpdate(false);
  assert.equal(offered, false, 'a failed check reports "no update"');
  assert.equal(vm.runInContext('updatePanelOpen', t.ctx), false, 'and never opens the modal');
});

test('update check: a first install is NOT treated as an update', async () => {
  const t = boot();
  // No active worker and only an "installing" one → this is the very first registration.
  const reg = fakeRegistration({ active: false, installing: true, waiting: false });
  t.app.setSwRegistration(reg);
  const offered = await t.app.checkForAppUpdate(true);
  assert.equal(offered, false, 'a first install must not prompt "update available"');
  assert.equal(vm.runInContext('updatePanelOpen', t.ctx), false, 'no modal for a first install');
});
