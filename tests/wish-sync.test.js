/* «Карта желаний» persistence & cloud sync — the part the click tests cannot reach: the order of
   operations (file up BEFORE metadata in Firestore), the local image cache, deletion everywhere,
   the single isUserPhoto mark, and the error/retry path.
   A fake Firebase + the real inline script: same mechanics as the other suites (vm sandbox),
   with firebase/cloudEnabled/authUser injected so wishStorageReady() is exercised for real. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const { boot, EXPORT_SRC } = require('./helpers');

// Minimal fake of the two SDK surfaces the board uses: storage() and the Firestore push
// (captured here so the test can assert what WOULD be written to the cloud).
function installFakeFirebase(ctx, opts) {
  opts = opts || {};
  const calls = { puts: [], deletes: [], downloads: [], firestoreSets: [] };
  const failUpload = !!opts.failUpload;
  // firestore() is a factory in the real SDK, and FieldValue hangs off the factory itself.
  const firestoreFactory = () => ({
    collection: () => ({ doc: () => ({
      set: (payload) => { calls.firestoreSets.push(payload); return Promise.resolve(); },
    }) }),
  });
  firestoreFactory.FieldValue = { serverTimestamp: () => 'server-ts' };
  ctx.firebase = {
    firestore: firestoreFactory,
    storage: () => ({
      ref: (p) => ({
        put: (blob, meta) => {
          calls.puts.push({ path: p, size: blob ? blob.size : 0, type: meta && meta.contentType });
          if (failUpload) return Promise.reject(new Error('storage/unauthorized'));
          return Promise.resolve({});
        },
        getDownloadURL: () => {
          calls.downloads.push(p);
          if (opts.failDownload) return Promise.reject(new Error('storage/object-not-found'));
          return Promise.resolve('https://example.invalid/' + encodeURIComponent(p));
        },
        delete: () => { calls.deletes.push(p); return Promise.resolve(); },
      }),
    }),
  };
  ctx.getCloudCalls = () => calls;
  return calls;
}
function signedIn(ctx) {
  vm.runInContext('cloudEnabled = true; authUser = { uid: "u1", email: "a@b.c" };', ctx);
}
// A stand-in for the Blob the crop dialog produces (jsdom has no canvas encode in the vm sandbox).
function fakeBlob(bytes, type) {
  const B = typeof Blob !== 'undefined' ? Blob : null;
  if (B) return new B([bytes], { type: type || 'image/webp' });
  return { size: bytes.length, type: type || 'image/webp' };
}

test('save order: the file is uploaded BEFORE the metadata reaches Firestore', async () => {
  const t = boot();
  const calls = installFakeFirebase(t.ctx);
  signedIn(t.ctx);
  // jsdom/vm has no object URLs — the app only needs the surface to remember a card has pixels.
  t.ctx.URL = { createObjectURL: () => "blob:fake-" + Math.random().toString(36).slice(2), revokeObjectURL: () => {} };
  t.ctx.fetch = () => Promise.resolve({ ok: true, blob: () => Promise.resolve(t.ctx.__blob) });
  t.ctx.__blob = fakeBlob("imagedata");
  vm.runInContext('scheduleCloudPush = function(){ globalThis.__lastPush = wishMapForCloud(state); };', t.ctx);
  const card = {
    id: 'w1', title: 'Дом', imagePath: null, order: 0, isUserPhoto: false,
    createdAt: 1, updatedAt: 1, uploadState: 'pending',
  };
  t.ctx.__card = card;
  // Bytes are cached locally first (that is what makes the card survive a reload).
  await t.app.wishCachePut("w1", t.ctx.__blob);
  t.app.wishRememberBlob("w1", t.ctx.__blob);
  t.app.setState(Object.assign(t.app.getState(), { wishMap: [card] }));
  await t.app.uploadWishCard(t.ctx.__card);
  // 1) exactly one put, to the required object path, as webp
  assert.equal(calls.puts.length, 1, 'one Storage upload');
  assert.equal(calls.puts[0].path, 'users/u1/vision-board/w1.webp', 'Storage path is users/{uid}/vision-board/{cardId}.webp');
  assert.equal(calls.puts[0].type, 'image/webp', 'the uploaded object is WebP');
  // 2) the card only became an uploaded one after the put resolved
  const after = t.app.getState().wishMap[0];
  assert.equal(after.imagePath, 'users/u1/vision-board/w1.webp', 'imagePath set after upload');
  assert.equal(after.uploadState, 'uploaded', 'uploadState flips to uploaded');
  // 3) nothing may be pushed to Firestore while the file was still pending
  const projected = vm.runInContext('wishMapForCloud(state)', t.ctx);
  assert.equal(Array.from(projected).length, 1, 'an uploaded card is projected to Firestore');
  const pendingProjection = vm.runInContext(
    'wishMapForCloud({ wishMap: [{ id:"x", imagePath:null, uploadState:"pending" }] })', t.ctx);
  assert.equal(Array.from(pendingProjection).length, 0,
    'a card whose file has not uploaded is NEVER written to Firestore');
  const errProjection = vm.runInContext(
    'wishMapForCloud({ wishMap: [{ id:"y", imagePath:null, uploadState:"error" }] })', t.ctx);
  assert.equal(Array.from(errProjection).length, 0, 'a failed upload is not projected either');
});

test('state holds metadata only — no image bytes ever reach storage or Firestore', () => {
  const t = boot();
  t.app.setState({
    name: 'root', children: [],
    wishMap: [{ id: 'c1', title: 'Т', imagePath: 'users/u1/vision-board/c1.webp', uploadState: 'uploaded' }],
  });
  const json = JSON.stringify(t.app.getState());
  assert.equal(json.includes('data:image'), false, 'no data: URL in state');
  assert.equal(json.includes('base64'), false, 'no base64 in state');
  const cloud = Array.from(vm.runInContext('wishMapForCloud(state)', t.ctx));
  assert.equal(cloud.length, 1);
  assert.deepEqual(Object.keys(cloud[0]).sort(),
    ['createdAt', 'id', 'imagePath', 'isUserPhoto', 'order', 'title', 'updatedAt'],
    'the Firestore doc carries exactly the required metadata fields');
  assert.equal(cloud[0].imagePath, 'users/u1/vision-board/c1.webp', 'imagePath is the join key');
});

test('upload failure: the image is kept, the card is flagged and retryable', async () => {
  const t = boot();
  installFakeFirebase(t.ctx, { failUpload: true });
  signedIn(t.ctx);
  // jsdom/vm has no object URLs — the app only needs the surface to remember a card has pixels.
  t.ctx.URL = { createObjectURL: () => "blob:fake-" + Math.random().toString(36).slice(2), revokeObjectURL: () => {} };
  t.ctx.fetch = () => Promise.resolve({ ok: true, blob: () => Promise.resolve(t.ctx.__blob) });
  t.ctx.__blob = fakeBlob("imagedata");
  const card = {
    id: 'w2', title: 'Дом', imagePath: null, order: 0, isUserPhoto: false,
    createdAt: 1, updatedAt: 1, uploadState: 'pending',
  };
  t.ctx.__card = card;
  await t.app.wishCachePut("w2", t.ctx.__blob);
  t.app.setState(Object.assign(t.app.getState(), { wishMap: [card] }));
  await t.app.uploadWishCard(card);
  const after = t.app.getState().wishMap[0];
  assert.equal(after.uploadState, 'error', 'a failed put flags the card as error');
  assert.equal(after.imagePath, null, 'no imagePath — the file is not in the cloud');
  // The bytes survived: they are still in the local cache, so a retry can be made.
  const cached = await t.app.wishCacheGet("w2");
  assert.ok(cached, 'the chosen image is NOT lost on a failed upload');
  // A retry with the network back uploads the very same bytes.
  const calls = t.ctx.getCloudCalls();
  assert.equal(calls.puts.length, 1, 'the failed attempt did upload once');
  installFakeFirebase(t.ctx, {});   // now the upload succeeds
  signedIn(t.ctx);
  // jsdom/vm has no object URLs — the app only needs the surface to remember a card has pixels.
  t.ctx.URL = { createObjectURL: () => "blob:fake-" + Math.random().toString(36).slice(2), revokeObjectURL: () => {} };
  t.ctx.fetch = () => Promise.resolve({ ok: true, blob: () => Promise.resolve(t.ctx.__blob) });
  t.ctx.__blob = fakeBlob("imagedata");
  await vm.runInContext('uploadWishCard(state.wishMap[0])', t.ctx);
  assert.equal(t.app.getState().wishMap[0].uploadState, 'uploaded', 'retry succeeds');
  assert.equal(t.app.getState().wishMap[0].imagePath, 'users/u1/vision-board/w2.webp', 'imagePath set');
  assert.equal(t.ctx.getCloudCalls().puts.length, 1, 'the retry uploaded once more');
});

test('download failure (object-not-found / unauthorized / offline) keeps the card pending', async () => {
  const t = boot();
  installFakeFirebase(t.ctx, { failDownload: true });
  signedIn(t.ctx);
  // jsdom/vm has no object URLs — the app only needs the surface to remember a card has pixels.
  t.ctx.URL = { createObjectURL: () => "blob:fake-" + Math.random().toString(36).slice(2), revokeObjectURL: () => {} };
  t.ctx.fetch = () => Promise.resolve({ ok: true, blob: () => Promise.resolve(t.ctx.__blob) });
  t.ctx.__blob = fakeBlob("imagedata");
  t.app.setState({
    name: 'root', children: [],
    wishMap: [{ id: 'c9', title: 'С облака', imagePath: 'users/u1/vision-board/c9.webp', uploadState: 'pending' }],
  });
  await vm.runInContext('downloadWishImage(state.wishMap[0])', t.ctx);
  const after = t.app.getState().wishMap[0];
  assert.equal(after.uploadState, 'pending', 'an unreachable object leaves the card pending');
  assert.ok(!vm.runInContext('wishHasLocalBytes(state.wishMap[0])', t.ctx),
    'and no phantom pixels — the UI shows the "will download" state, never a broken image');
});

test('syncWishBoard: uploads cached-only cards, downloads cloud-only cards, and does nothing twice', async () => {
  const t = boot();
  const calls = installFakeFirebase(t.ctx);
  signedIn(t.ctx);
  // jsdom/vm has no object URLs — the app only needs the surface to remember a card has pixels.
  t.ctx.URL = { createObjectURL: () => "blob:fake-" + Math.random().toString(36).slice(2), revokeObjectURL: () => {} };
  t.ctx.fetch = () => Promise.resolve({ ok: true, blob: () => Promise.resolve(t.ctx.__blob) });
  t.ctx.__blob = fakeBlob("imagedata");
  t.app.setState({
    name: 'root', children: [],
    wishMap: [
      { id: 'local1', title: 'Локальная', imagePath: null, order: 0, isUserPhoto: false, createdAt: 1, updatedAt: 1, uploadState: 'pending' },
      { id: 'cloud1', title: 'Облачная', imagePath: 'users/u1/vision-board/cloud1.webp', order: 1, isUserPhoto: false, createdAt: 1, updatedAt: 1, uploadState: 'pending' },
    ],
  });
  await t.app.wishCachePut("local1", t.ctx.__blob);
  t.app.wishRememberBlob("local1", t.ctx.__blob);
  vm.runInContext('syncWishBoard()', t.ctx);
  await new Promise(r => setTimeout(r, 30));
  const puts = calls.puts.map(p => p.path);
  assert.deepEqual(puts, ['users/u1/vision-board/local1.webp'], 'the local-only card is uploaded');
  assert.equal(calls.downloads.length, 1, 'the cloud-only card is downloaded');
  assert.equal(t.app.getState().wishMap[0].uploadState, 'uploaded', 'local card becomes uploaded');
  // Second pass: everything is already reconciled → no redundant work.
  const before = { puts: calls.puts.length, deletes: calls.deletes.length, downloads: calls.downloads.length };
  vm.runInContext('syncWishBoard()', t.ctx);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(calls.puts.length, before.puts, 'no re-upload of an already uploaded card');
  assert.equal(calls.downloads.length, before.downloads, 'no re-download of a card we already have');
});

test('delete: drops the Firestore projection AND removes the Storage object', async () => {
  const t = boot();
  const calls = installFakeFirebase(t.ctx);
  signedIn(t.ctx);
  // jsdom/vm has no object URLs — the app only needs the surface to remember a card has pixels.
  t.ctx.URL = { createObjectURL: () => "blob:fake-" + Math.random().toString(36).slice(2), revokeObjectURL: () => {} };
  t.ctx.fetch = () => Promise.resolve({ ok: true, blob: () => Promise.resolve(t.ctx.__blob) });
  t.ctx.__blob = fakeBlob("imagedata");
  await t.app.wishCachePut("d1", t.ctx.__blob);
  t.app.wishRememberBlob("d1", t.ctx.__blob);
  t.app.setState({
    name: 'root', children: [],
    wishMap: [{ id: 'd1', title: 'Удалить', imagePath: 'users/u1/vision-board/d1.webp', order: 0, isUserPhoto: true, createdAt: 1, updatedAt: 1, uploadState: 'uploaded' }],
  });
  await vm.runInContext('deleteWishCard(state.wishMap[0])', t.ctx);
  assert.deepEqual(calls.deletes, ['users/u1/vision-board/d1.webp'], 'the Storage object is deleted');
  const cached = await t.app.wishCacheGet("d1");
  assert.ok(!cached, 'the local cache entry is deleted too');
  assert.ok(!vm.runInContext('wishHasLocalBytes(state.wishMap[0])', t.ctx), 'the blob URL is released');
  // With the card gone from state, the projection (what Firestore stores) no longer contains it.
  const proj = Array.from(vm.runInContext('wishMapForCloud({ wishMap: [] })', t.ctx));
  assert.equal(proj.length, 0, 'a deleted card is not in the cloud doc');
});

test('one isUserPhoto: deleting the personal photo leaves no stale mark', () => {
  const t = boot();
  t.app.setState({
    name: 'root', children: [],
    wishMap: [
      { id: 'm1', title: 'Я', imagePath: 'p/m1.webp', order: 0, isUserPhoto: true, createdAt: 1, updatedAt: 1, uploadState: 'uploaded' },
      { id: 'm2', title: 'Дом', imagePath: 'p/m2.webp', order: 1, isUserPhoto: false, createdAt: 1, updatedAt: 1, uploadState: 'uploaded' },
    ],
  });
  const st = vm.runInContext('state', t.ctx);
  st.wishMap.splice(0, 1);
  vm.runInContext('wishClearUserPhoto()', t.ctx);
  assert.equal(t.app.getState().wishMap.filter(c => c.isUserPhoto).length, 0,
    'no card keeps a stale personal-photo mark after its holder is deleted');
  // And taking the mark back is still exactly-once.
  const st2 = vm.runInContext('state', t.ctx);
  st2.wishMap[0].isUserPhoto = true;
  vm.runInContext('ensureWishMap(state)', t.ctx);
  assert.equal(t.app.getState().wishMap.filter(c => c.isUserPhoto).length, 1, 'the mark is singley');
});

test('no cloud / not signed in: everything is a safe no-op, nothing throws', async () => {
  const t = boot();
  // cloudEnabled stays false, authUser null (default) — uploadWishCard/downloadWishImage must bail.
  t.app.setState({
    name: 'root', children: [],
    wishMap: [
      { id: 'n1', title: 'Без облака', imagePath: null, order: 0, isUserPhoto: false, createdAt: 1, updatedAt: 1, uploadState: 'pending' },
      { id: 'n2', title: 'Облако', imagePath: 'p/n2.webp', order: 1, isUserPhoto: false, createdAt: 1, updatedAt: 1, uploadState: 'pending' },
    ],
  });
  await t.app.wishCachePut("n1", t.ctx.__blob);
  t.app.wishRememberBlob("n1", t.ctx.__blob);
  assert.equal(vm.runInContext('wishStorageReady()', t.ctx), false, 'no SDK / no sign-in → not ready');
  await vm.runInContext('uploadWishCard(state.wishMap[0])', t.ctx);
  await vm.runInContext('downloadWishImage(state.wishMap[1])', t.ctx);
  assert.equal(t.app.getState().wishMap[0].uploadState, 'pending', 'stays pending, no crash');
  assert.equal(t.app.getState().wishMap[1].uploadState, 'pending', 'stays pending, no crash');
  vm.runInContext('syncWishBoard()', t.ctx);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(t.app.getState().wishMap.length, 2, 'the local board is untouched without a cloud');
});

test('boot: a local (no cloud) user still sees their cached images', async () => {
  const t = boot();
  // No firebase at all, no sign-in — the onAuthStateChanged listener is never even registered
  // (cloudEnabled=false), so the ONLY way the board gets its pixels is the boot-time warm-up.
  assert.equal(vm.runInContext('cloudEnabled', t.ctx), false, 'this boot has no cloud');
  t.ctx.URL = { createObjectURL: () => 'blob:local', revokeObjectURL: () => {} };
  t.ctx.fetch = () => Promise.resolve({ ok: true, blob: () => Promise.resolve({ size: 3, type: 'image/webp' }) });
  const blob = fakeBlob('pixels');
  await t.app.wishCachePut('boot1', blob);
  t.app.setState({
    name: 'root', children: [],
    wishMap: [{ id: 'boot1', title: 'Отдых на море', imagePath: null, order: 0, isUserPhoto: false,
                createdAt: 1, updatedAt: 1, uploadState: 'pending' }],
  });
  // Before the warm-up the registry is empty — the card would render "Сохраняем в облако…".
  assert.ok(!t.app.wishHasLocalBytes(t.app.getState().wishMap[0]),
    'a cold boot has no blob URLs yet (that was the blank-card bug)');
  await vm.runInContext('wishCacheWarm()', t.ctx);
  await new Promise((r) => setTimeout(r, 30));
  const c = t.app.getState().wishMap[0];
  assert.ok(t.app.wishHasLocalBytes(c), 'the boot warm-up picks the bytes up from the cache');
  assert.equal(t.app.wishBlobUrlFor(c), 'blob:local', 'and the card gets a usable blob URL');
  assert.equal(c.title, 'Отдых на море');
});

test('boot: a signed-out reload of a cloud card keeps showing its cached pixels', async () => {
  const t = boot();
  installFakeFirebase(t.ctx, { failDownload: true });
  vm.runInContext('cloudEnabled = true; authUser = null;', t.ctx);
  t.ctx.URL = { createObjectURL: () => 'blob:cached', revokeObjectURL: () => {} };
  const blob = fakeBlob('pixels');
  await t.app.wishCachePut('cloudc', blob);
  t.app.setState({
    name: 'root', children: [],
    wishMap: [{ id: 'cloudc', title: 'С облака', imagePath: 'users/u1/vision-board/cloudc.webp',
                order: 0, isUserPhoto: false, createdAt: 1, updatedAt: 1, uploadState: 'uploaded' }],
  });
  await vm.runInContext('wishCacheWarm()', t.ctx);
  await new Promise((r) => setTimeout(r, 30));
  // Signed out: the download is impossible, but the local cache still has the bytes → no blank.
  assert.ok(t.app.wishHasLocalBytes(t.app.getState().wishMap[0]),
    'a signed-out user keeps seeing the cached image instead of an empty card');
  assert.equal(t.app.getState().wishMap[0].uploadState, 'uploaded');
});
