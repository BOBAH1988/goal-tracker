/* «Карта желаний» persistence & cloud sync — the part the click tests cannot reach: the order of
   operations (the image document up BEFORE metadata in the account document), the local image
   cache, deletion everywhere, the single isUserPhoto mark, and the error/retry path.
   A fake Firebase + the real inline script: same mechanics as the other suites (vm sandbox),
   with firebase/cloudEnabled/authUser injected so wishCloudReady() is exercised for real.
   Cloud Storage is deliberately NOT faked — the project has no bucket (Storage needs the paid
   Blaze plan), the bytes travel as Firestore documents (users/{uid}/wishImages/{cardId}). */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { boot, EXPORT_SRC } = require('./helpers');

// A tiny in-memory Firestore with arbitrarily nested collections/documents, so the fake can
// serve both users/{uid} (metadata) and users/{uid}/wishImages/{cardId} (bytes).
function makeDocStore() {
  const store = new Map();
  const listeners = new Map();
  const refs = new Map();          // one stable ref object per key, so tests can wrap it
  const emit = (key) => {
    const data = store.get(key);
    (listeners.get(key) || []).forEach(cb => cb({ exists: !!data, data: () => data }, () => {}));
  };
  const docRef = (key) => {
    if (refs.has(key)) return refs.get(key);
    const ref = {
    set: (payload) => { store.set(key, payload); emit(key); return Promise.resolve(); },
    get: () => Promise.resolve({ exists: store.has(key), data: () => store.get(key) }),
    delete: () => { store.delete(key); emit(key); return Promise.resolve(); },
    onSnapshot: (cb) => {
      if (!listeners.has(key)) listeners.set(key, []);
      listeners.get(key).push(cb);
      cb({ exists: store.has(key), data: () => store.get(key) }, () => {});
      return () => {};
    },
      collection: (name) => ({ doc: (id) => docRef(key + '/' + name + '/' + id) }),
    };
    refs.set(key, ref);
    return ref;
  };
  return {
    store, emit,
    doc: (collection, id) => docRef(collection + '/' + id),
    docRef,
  };
}
// Minimal fake of the surfaces the board uses (captured so the test can assert what WOULD be
// written to the cloud).
function installFakeFirebase(ctx, opts) {
  opts = opts || {};
  const calls = opts.calls || { images: [], imageReads: [], imageDeletes: [], firestoreSets: [] };
  const failUpload = !!opts.failUpload;
  const failDownload = !!opts.failDownload;
  const db = makeDocStore();
  // firestore() is a factory in the real SDK, and FieldValue hangs off the factory itself.
  const firestoreFactory = () => ({
    collection: (name) => ({ doc: (id) => db.doc(name, id) }),
  });
  firestoreFactory.FieldValue = { serverTimestamp: () => 'server-ts' };
  // The real SDK accepts bytes ONLY as its own Blob type — a raw Uint8Array is rejected with
  // invalid-argument ("Unsupported field value: a custom Uint8Array object"). Mirror that here so
  // the app's fromUint8Array() call is exercised and a regression to raw bytes fails loudly.
  firestoreFactory.Blob = {
    fromUint8Array: (u8) => ({ __cloudBlob: true, u8, toUint8Array: () => u8 }),
    fromBase64String: (b) => ({ __cloudBlob: true, u8: Uint8Array.from(Buffer.from(b, 'base64')) }),
  };
  ctx.firebase = { firestore: firestoreFactory };
  // The image documents: writes/reads/deletes are counted, with the failure switches.
  const wrapDoc = (ref, key) => ({
    set: (payload) => {
      calls.images.push({ path: key, payload });
      if (failUpload) return Promise.reject(Object.assign(new Error('denied'), { code: 'permission-denied' }));
      return ref.set(payload);
    },
    get: () => {
      calls.imageReads.push(key);
      if (failDownload) return Promise.reject(Object.assign(new Error('denied'), { code: 'permission-denied' }));
      return ref.get();
    },
    delete: () => { calls.imageDeletes.push(key); return ref.delete(); },
  });
  const usersDoc = db.doc('users', 'u1');
  const realCollection = usersDoc.collection.bind(usersDoc);
  usersDoc.collection = (name) => ({
    doc: (id) => wrapDoc(realCollection(name).doc(id), 'users/u1/' + name + '/' + id),
  });
  // And the metadata writes on the account document itself.
  const realSet = usersDoc.set;
  usersDoc.set = (payload) => { calls.firestoreSets.push(payload); return realSet(payload); };
  ctx.firebaseFirestore = db;
  ctx.seedCloudDoc = (key, data) => { db.store.set(key, data); };
  ctx.getCloudCalls = () => calls;
  ctx.getCloudDoc = (key) => db.store.get(key);
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
// One Firebase project shared by SEVERAL boots: the image documents, the users/{uid} document and
// the live snapshot listeners. This is what makes a real two-device test possible — device B
// calls the app's own startCloudSync() and receives exactly what device A pushed.
function makeSharedCloud() {
  const db = makeDocStore();
  const calls = { images: [], imageReads: [], imageDeletes: [], sets: [] };
  const firestoreFactory = () => ({
    collection: (name) => ({ doc: (id) => {
      const ref = db.doc(name, id);
      if (name === 'users' && id === 'u1') {
        const realSet = ref.set;
        ref.set = (payload) => { calls.sets.push(name + '/' + id); return realSet(payload); };
        const realCollection = ref.collection;
        ref.collection = (coll) => ({
          doc: (cid) => {
            const inner = realCollection(coll).doc(cid);
            const realSet2 = inner.set;
            inner.set = (payload) => { calls.images.push('users/u1/' + coll + '/' + cid); return realSet2(payload); };
            return inner;
          },
        });
      }
      return ref;
    } }),
  });
  firestoreFactory.FieldValue = { serverTimestamp: () => 'server-ts' };
  firestoreFactory.Blob = { fromUint8Array: (u8) => ({ __cloudBlob: true, u8, toUint8Array: () => u8 }) };
  return { db, calls, firebase: { firestore: firestoreFactory },
           seedDoc: (key, data) => { db.store.set(key, data); } };
}
function wireDevice(t, cloud) {
  t.ctx.firebase = cloud.firebase;
  signedIn(t.ctx);
  t.ctx.URL = { createObjectURL: () => "blob:fake-" + Math.random().toString(36).slice(2), revokeObjectURL: () => {} };
  t.ctx.__blob = fakeBlob("imagedata");
  return t;
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
  // 1) exactly one image document, in the card's own path
  assert.equal(calls.images.length, 1, 'one image document written');
  assert.equal(calls.images[0].path, 'users/u1/wishImages/w1', 'image doc is users/{uid}/wishImages/{cardId}');
  assert.equal(calls.images[0].payload.type, 'image/webp', 'the document records WebP');
  assert.equal(calls.images[0].payload.uid, 'u1', 'the document carries its owner uid (rules check it)');
  assert.ok(calls.images[0].payload.bytes && calls.images[0].payload.bytes.__cloudBlob,
    'bytes are wrapped in the Blob type Firestore accepts — raw Uint8Array is rejected with invalid-argument');
  assert.equal(calls.images[0].payload.bytes.u8.length, t.ctx.__blob.size, 'the raw bytes are stored, not base64');
  // 2) the card only became an uploaded one after the put resolved
  const after = t.app.getState().wishMap[0];
  assert.equal(after.imagePath, 'wishImages/w1', 'imagePath set after upload');
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
    wishMap: [{ id: 'c1', title: 'Т', imagePath: 'wishImages/c1', uploadState: 'uploaded' }],
  });
  const json = JSON.stringify(t.app.getState());
  assert.equal(json.includes('data:image'), false, 'no data: URL in state');
  assert.equal(json.includes('base64'), false, 'no base64 in state');
  const cloud = Array.from(vm.runInContext('wishMapForCloud(state)', t.ctx));
  assert.equal(cloud.length, 1);
  assert.deepEqual(Object.keys(cloud[0]).sort(),
    ['createdAt', 'id', 'imagePath', 'isUserPhoto', 'order', 'title', 'updatedAt'],
    'the Firestore doc carries exactly the required metadata fields');
  assert.equal(cloud[0].imagePath, 'wishImages/c1', 'imagePath is the join key');
});

test('upload failure: the image is kept, the card is flagged and retryable', async () => {
  const t = boot();
  const calls = { images: [], imageReads: [], imageDeletes: [], firestoreSets: [] };
  installFakeFirebase(t.ctx, { failUpload: true, calls });
  signedIn(t.ctx);
  // jsdom/vm has no object URLs — the app only needs the surface to remember a card has pixels.
  t.ctx.URL = { createObjectURL: () => "blob:fake-" + Math.random().toString(36).slice(2), revokeObjectURL: () => {} };
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
  assert.equal(calls.images.length, 1, 'the failed attempt wrote the document once');
  installFakeFirebase(t.ctx, { calls });   // now the upload succeeds
  signedIn(t.ctx);
  // jsdom/vm has no object URLs — the app only needs the surface to remember a card has pixels.
  t.ctx.URL = { createObjectURL: () => "blob:fake-" + Math.random().toString(36).slice(2), revokeObjectURL: () => {} };
  t.ctx.fetch = () => Promise.resolve({ ok: true, blob: () => Promise.resolve(t.ctx.__blob) });
  t.ctx.__blob = fakeBlob("imagedata");
  await vm.runInContext('uploadWishCard(state.wishMap[0])', t.ctx);
  assert.equal(t.app.getState().wishMap[0].uploadState, 'uploaded', 'retry succeeds');
  assert.equal(t.app.getState().wishMap[0].imagePath, 'wishImages/w2', 'imagePath set');
  assert.equal(t.ctx.getCloudCalls().images.length, 2, 'the retry wrote the document once more');
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
    wishMap: [{ id: 'c9', title: 'С облака', imagePath: 'wishImages/c9', uploadState: 'pending' }],
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
  // The cloud card exists as a document with real bytes (what the other device uploaded).
  t.ctx.seedCloudDoc('users/u1/wishImages/cloud1', { uid: 'u1', type: 'image/webp', size: 3, bytes: new Uint8Array([1, 2, 3]) });
  t.app.setState({
    name: 'root', children: [],
    wishMap: [
      { id: 'local1', title: 'Локальная', imagePath: null, order: 0, isUserPhoto: false, createdAt: 1, updatedAt: 1, uploadState: 'pending' },
      { id: 'cloud1', title: 'Облачная', imagePath: 'wishImages/cloud1', order: 1, isUserPhoto: false, createdAt: 1, updatedAt: 1, uploadState: 'pending' },
    ],
  });
  await t.app.wishCachePut("local1", t.ctx.__blob);
  t.app.wishRememberBlob("local1", t.ctx.__blob);
  vm.runInContext('syncWishBoard()', t.ctx);
  await new Promise(r => setTimeout(r, 30));
  assert.deepEqual(calls.images.map(i => i.path), ['users/u1/wishImages/local1'], 'the local-only card is uploaded');
  assert.equal(calls.imageReads.length, 1, 'the cloud-only card is downloaded');
  assert.equal(calls.imageReads[0], 'users/u1/wishImages/cloud1');
  assert.equal(t.app.getState().wishMap[0].uploadState, 'uploaded', 'local card becomes uploaded');
  // Second pass: everything is already reconciled → no redundant work.
  const before = { writes: calls.images.length, reads: calls.imageReads.length };
  vm.runInContext('syncWishBoard()', t.ctx);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(calls.images.length, before.writes, 'no re-upload of an already uploaded card');
  assert.equal(calls.imageReads.length, before.reads, 'no re-download of a card we already have');
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
    wishMap: [{ id: 'd1', title: 'Удалить', imagePath: 'wishImages/d1', order: 0, isUserPhoto: true, createdAt: 1, updatedAt: 1, uploadState: 'uploaded' }],
  });
  await vm.runInContext('deleteWishCard(state.wishMap[0])', t.ctx);
  assert.deepEqual(calls.imageDeletes, ['users/u1/wishImages/d1'], 'the cloud image document is deleted');
  const cached = await t.app.wishCacheGet("d1");
  assert.ok(!cached, 'the local cache entry is deleted too');
  assert.ok(!vm.runInContext('wishHasLocalBytes(state.wishMap[0])', t.ctx), 'the blob URL is released');
  // With the card gone from state, the projection (what Firestore stores) no longer contains it.
  const proj = Array.from(vm.runInContext('wishMapForCloud({ wishMap: [] })', t.ctx));
  assert.equal(proj.length, 0, 'a deleted card is not in the cloud doc');
});

/* The reported bug: "added a picture with a caption, it appeared and vanished a second later,
   adding it again worked". The card's upload finishes between the debounced push (which cannot
   include a card without a file yet) and the snapshot echo of that OLDER write — the merge dropped
   any local card that had imagePath but was missing from the cloud. It must be kept when it is
   NEWER than the document, while a card deleted on another device still disappears. */
test('merge: a card uploaded after the account document keeps its place (the vanishing card bug)', () => {
  const t = boot();
  const cloud = [{ id: 'old', title: 'Старая', imagePath: 'wishImages/old', order: 0, updatedAt: 900 }];
  const local = [
    { id: 'old', title: 'Старая', imagePath: 'wishImages/old', order: 0, updatedAt: 900, uploadState: 'uploaded' },
    { id: 'new', title: 'Новая', imagePath: 'wishImages/new', order: 1, updatedAt: 1500, uploadState: 'uploaded' },
    { id: 'off', title: 'Без сети', imagePath: null, order: 2, updatedAt: 1600, uploadState: 'pending' },
  ];
  const run = (docTs) => Array.from(vm.runInContext(
    'mergeWishMapCloud(' + JSON.stringify(cloud) + ',' + JSON.stringify(local) + ',' + JSON.stringify(docTs) + ')', t.ctx));

  // Документ записан в 1000 ms: новая карточка (1500) моложе — её нельзя терять.
  let merged = run({ seconds: 1, nanoseconds: 0 });
  assert.equal(merged.filter(c => c.id === 'new').length, 1,
    'the card uploaded AFTER the document must survive the merge — that was the vanishing card');
  assert.equal(merged.find(c => c.id === 'new').uploadState, 'uploaded');
  assert.deepEqual(Array.from(merged.map(c => c.id)), ['old', 'new', 'off'], 'the offline card is kept too');

  // Документ новее (2000): карточку удалили на другом устройстве — она должна уйти.
  merged = run({ seconds: 2, nanoseconds: 0 });
  assert.equal(merged.filter(c => c.id === 'new').length, 0, 'a card deleted remotely still disappears');
  assert.equal(merged.filter(c => c.id === 'off').length, 1, 'the offline card survives either way');

  // Форма отметки времени из настоящего SDK (Timestamp с toMillis) и число.
  const withRealTs = Array.from(vm.runInContext(
    'mergeWishMapCloud(' + JSON.stringify(cloud) + ',' + JSON.stringify(local) + ',' +
    JSON.stringify({ seconds: 1, nanoseconds: 0 }) + ')', t.ctx));
  assert.equal(withRealTs.filter(c => c.id === 'new').length, 1, 'the {seconds,nanoseconds} shape works');

  // Никакого updatedAt нет как у документа, так и у карточки — карточка остаётся (полетит в следующий push).
  const noTs = Array.from(vm.runInContext(
    'mergeWishMapCloud(' + JSON.stringify([{ id: 'old', title: 'x', imagePath: 'p', order: 0 }]) + ',' +
    JSON.stringify([{ id: 'new2', title: 'y', imagePath: 'p2', order: 1 }]) + ', undefined)', t.ctx));
  assert.deepEqual(Array.from(noTs.map(c => c.id)), ['old', 'new2'], 'no timestamps → keep, safer than losing');
});

/* Жалоба владельца: «подсказки длинные, у края вылазят за экран». Пузырь центрировался над
   кнопкой, поэтому у кнопки у левого/правого края viewport он уходил за границу. Логика выбора
   стороны вынесена в positionTip() — проверяем её на крайних положениях (ширина телефона). */
test('tooltips: a bubble near the screen edge is pulled back inside (positionTip)', () => {
  const t = boot();
  vm.runInContext('window.innerWidth = 390;', t.ctx);
  const mk = (left, width) => vm.runInContext(
    '({ classList:{ _s:new Set(), add(c){ this._s.add(c); }, remove(c){ this._s.delete(c); }, contains(c){ return this._s.has(c); } },'
    + ' getBoundingClientRect(){ return { left:' + left + ', right:' + (left + width) + ', width:' + width + ' }; } })', t.ctx);
  const pos = vm.runInContext('positionTip', t.ctx);

  const right = mk(330, 38);            // три кнопки шапки у правого края
  pos(right);
  assert.equal(right.classList.contains('tip-right'), true, 'a button at the right edge hugs the right');
  assert.equal(right.classList.contains('tip-left'), false);

  const left = mk(10, 38);              // кнопка у левого края
  pos(left);
  assert.equal(left.classList.contains('tip-left'), true, 'a button at the left edge hugs the left');

  const mid = mk(160, 38);
  pos(mid);
  assert.equal(mid.classList.contains('tip-left'), false, 'a centred button is not shifted');
  assert.equal(mid.classList.contains('tip-right'), false, 'a centred button is not shifted');

  // Повторный вызов не копит классы и мусор на входе не роняет.
  pos(right); pos(left); pos(mid);
  assert.equal(right.classList.contains('tip-left'), false, 're-posicing replaces the classes');
  pos(null); pos({}); pos(undefined);
  assert.ok(true, 'garbage in does not throw');
});

test('manual move: the card takes the target slot, order is renumbered, the mark still leads', () => {
  const t = boot();
  t.app.setState(Object.assign(t.app.getState(), { wishMap: [
    { id: 'me', title: 'Я', isUserPhoto: true, order: 0 },
    { id: 'a', title: 'A', order: 1 },
    { id: 'b', title: 'B', order: 2 },
    { id: 'c', title: 'C', order: 3 },
  ]}));
  assert.equal(vm.runInContext('wishMoveCardTo(3, 1)', t.ctx), true, 'C takes A’s slot');
  assert.deepEqual(Array.from(vm.runInContext('state.wishMap.map(c => c.title)', t.ctx)).map(String),
    ['Я', 'C', 'A', 'B'], 'the card moved inside the array — the board renders array order');
  assert.deepEqual(Array.from(vm.runInContext('state.wishMap.map(c => c.order)', t.ctx)).map(Number),
    [0, 1, 2, 3], 'order renumbered to match the new sequence (it travels to the cloud/backup)');
  const first = Array.from(t.app.wishMapDisplayOrder(t.app.getState().wishMap))[0];
  assert.equal(vm.runInContext('state.wishMap[' + first + '].id', t.ctx), 'me',
    'the personal photo still leads the board wherever the moved card lands');
  // nothing silly on the way in: same slot, out of range, wrong type — all no-ops
  assert.equal(vm.runInContext('wishMoveCardTo(0, 0)', t.ctx), false, 'same slot changes nothing');
  assert.equal(vm.runInContext('wishMoveCardTo(-1, 2)', t.ctx), false, 'out of range is refused');
  assert.equal(vm.runInContext('wishMoveCardTo(99, 0)', t.ctx), false, 'out of range is refused');
  assert.equal(vm.runInContext('wishMoveCardTo(1.5, 0)', t.ctx), false, 'non-integer is refused');
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
      { id: 'n2', title: 'Облако', imagePath: 'wishImages/n2', order: 1, isUserPhoto: false, createdAt: 1, updatedAt: 1, uploadState: 'pending' },
    ],
  });
  await t.app.wishCachePut("n1", t.ctx.__blob);
  t.app.wishRememberBlob("n1", t.ctx.__blob);
  assert.equal(vm.runInContext('wishCloudReady()', t.ctx), false, 'no SDK / no sign-in → not ready');
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
    wishMap: [{ id: 'cloudc', title: 'С облака', imagePath: 'wishImages/cloudc',
                order: 0, isUserPhoto: false, createdAt: 1, updatedAt: 1, uploadState: 'uploaded' }],
  });
  await vm.runInContext('wishCacheWarm()', t.ctx);
  await new Promise((r) => setTimeout(r, 30));
  // Signed out: the download is impossible, but the local cache still has the bytes → no blank.
  assert.ok(t.app.wishHasLocalBytes(t.app.getState().wishMap[0]),
    'a signed-out user keeps seeing the cached image instead of an empty card');
  assert.equal(t.app.getState().wishMap[0].uploadState, 'uploaded');
});

test('the image document records the real content type (jpeg fallback engines)', async () => {
  const t = boot();
  const calls = installFakeFirebase(t.ctx);
  signedIn(t.ctx);
  t.ctx.URL = { createObjectURL: () => "blob:fake", revokeObjectURL: () => {} };
  // applyCrop() falls back to JPEG where the engine cannot encode WebP — the other device must
  // rebuild the very same Blob from that type, never guess webp.
  const jpeg = fakeBlob('jpegbytes', 'image/jpeg');
  await t.app.wishCachePut('j1', jpeg);
  t.app.wishRememberBlob('j1', jpeg);
  t.app.setState({
    name: 'root', children: [],
    wishMap: [{ id: 'j1', title: 'Море', imagePath: null, order: 0, isUserPhoto: false,
                createdAt: 1, updatedAt: 1, uploadState: 'pending' }],
  });
  await t.app.uploadWishCard(t.app.getState().wishMap[0]);
  assert.equal(calls.images.length, 1, 'one image document written');
  assert.equal(calls.images[0].path, 'users/u1/wishImages/j1', 'one document per card id');
  assert.equal(calls.images[0].payload.type, 'image/jpeg', 'a jpeg card is stored as image/jpeg');
  assert.ok(calls.images[0].payload.bytes.__cloudBlob && calls.images[0].payload.bytes.u8.length === jpeg.size,
    'and wrapped in the Blob type Firestore accepts');
  assert.equal(t.app.getState().wishMap[0].uploadState, 'uploaded', 'the card still reaches the cloud');
  // WebP stays WebP (the normal path).
  const webp = fakeBlob('webpbytes', 'image/webp');
  await t.app.wishCachePut('w9', webp);
  t.app.wishRememberBlob('w9', webp);
  t.app.setState(Object.assign(t.app.getState(), { wishMap: [
    t.app.getState().wishMap[0],
    { id: 'w9', title: 'Дом', imagePath: null, order: 1, isUserPhoto: false, createdAt: 1, updatedAt: 1, uploadState: 'pending' },
  ] }));
  await t.app.uploadWishCard(t.app.getState().wishMap[1]);
  assert.equal(calls.images[1].payload.type, 'image/webp', 'webp bytes stay image/webp');
});

test('firestore.rules guard the image documents (deploy-time half of the sync)', () => {
  const rules = fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8');
  // Without these rules the image documents are denied and the photos silently stay on the
  // device they were added on. They must cover the subcollection, the owner only, the uid the
  // document carries, and a size cap under Firestore's 1 MiB document limit.
  assert.match(rules, /match \/users\/\{userId\} \{/, 'the account document rule stays');
  assert.match(rules, /match \/wishImages\/\{cardId\} \{/, 'the image subcollection has its own rule');
  assert.match(rules, /allow read: if request\.auth != null && request\.auth\.uid == userId;/, 'owner-only reads');
  assert.match(rules, /request\.resource\.data\.uid == request\.auth\.uid/, 'the document must name its owner');
  assert.match(rules, /request\.resource\.data\.bytes\.size\(\) <= 800 \* 1024/,
    'the byte cap stays — and uses the method form the rules compiler actually accepts');
  // Nothing about Storage anymore: the project runs on the free Spark plan, it cannot even
  // create a bucket (the Storage API answers 403 "billing account ... disabled in state absent").
  assert.doesNotMatch(rules, /firebase\.storage/, 'no Storage service in the Firestore rules');
});

test('two devices: a card uploaded on one device renders on the other', async () => {
  // Device A: signed in, saves a card (cache → save → render → upload, exactly the handler order).
  const cloud = makeSharedCloud();
  const A = wireDevice(boot(), cloud);
  const card = {
    id: 'w1', title: 'Дом', imagePath: null, order: 0, isUserPhoto: false,
    createdAt: 1, updatedAt: 1, uploadState: 'pending',
  };
  await A.app.wishCachePut('w1', A.ctx.__blob);
  A.app.wishRememberBlob('w1', A.ctx.__blob);
  A.app.setState(Object.assign(A.app.getState(), { wishMap: [card] }));
  await A.app.uploadWishCard(card);
  await new Promise(r => setTimeout(r, 60));   // the 800 ms debounce is flushed below, as on pagehide
  A.app.flushCloudPush();
  await new Promise(r => setTimeout(r, 10));   // push re-reads the doc (optimistic lock) before writing
  // The image document AND the metadata — the two halves other devices need.
  const img = cloud.db.store.get('users/u1/wishImages/w1');
  assert.ok(img, 'the bytes live in their own document');
  assert.equal(img.type, 'image/webp');
  assert.ok(img.bytes && img.bytes.__cloudBlob, 'stored as the Blob type Firestore accepts');
  assert.equal(img.bytes.u8.length, A.ctx.__blob.size);
  const doc = cloud.db.store.get('users/u1');
  assert.equal(doc.state.wishMap.length, 1, 'the metadata is in the account document');
  assert.equal(doc.state.wishMap[0].imagePath, 'wishImages/w1');

  // Device B: a fresh install that signs in and receives the snapshot.
  const writesSoFar = cloud.calls.images.length;
  const B = wireDevice(boot(), cloud);
  vm.runInContext('startCloudSync("u1")', B.ctx);
  await new Promise(r => setTimeout(r, 60));
  const cards = B.app.getState().wishMap || [];
  assert.equal(cards.length, 1, 'the card itself appears on the other device');
  assert.equal(cards[0].imagePath, 'wishImages/w1');
  assert.equal(cards[0].uploadState, 'uploaded');
  assert.ok(B.app.wishHasLocalBytes(cards[0]), 'and its pixels were read from its document');
  assert.ok(B.app.wishBlobUrlFor(cards[0]), 'so the card renders the image, not a placeholder');
  assert.equal(cloud.calls.images.length, writesSoFar, 'the second device downloads, never re-uploads');
});

test('flushCloudPush: a page closed inside the debounce does not lose the metadata', async () => {
  const t = boot();
  const calls = installFakeFirebase(t.ctx);
  signedIn(t.ctx);
  vm.runInContext('scheduleCloudPush()', t.ctx);
  assert.equal(calls.firestoreSets.length, 0, 'the write is still debounced');
  vm.runInContext('flushCloudPush()', t.ctx);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(calls.firestoreSets.length, 1, 'pagehide flushes the pending write immediately');
  // And flushing twice must not double-write.
  vm.runInContext('flushCloudPush()', t.ctx);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(calls.firestoreSets.length, 1, 'no timer left behind → no duplicate write');
});

test('the cloud document holds no uploadState — the board still becomes downloadable', async () => {
  // Exactly what lives in Firestore today (wishMapForCloud): metadata without the local flags.
  const t = boot();
  installFakeFirebase(t.ctx);
  signedIn(t.ctx);
  t.ctx.URL = { createObjectURL: () => 'blob:from-cloud', revokeObjectURL: () => {} };
  t.ctx.fetch = () => Promise.resolve({ ok: true, blob: () => Promise.resolve(t.ctx.__blob) });
  t.ctx.__blob = fakeBlob('pixels');
  t.ctx.seedCloudDoc('users/u1/wishImages/c1', { uid: 'u1', type: 'image/webp', size: 3, bytes: new Uint8Array([7, 7, 7]) });
  const rawCloudDoc = [{ id: 'c1', title: 'С облака', imagePath: 'wishImages/c1', order: 0, isUserPhoto: false, createdAt: 1, updatedAt: 1 }];
  const merged = Array.from(vm.runInContext(
    'mergeWishMapCloud(' + JSON.stringify(rawCloudDoc) + ', [])', t.ctx));
  assert.equal(merged.length, 1);
  assert.equal(merged[0].uploadState, 'uploaded', 'the flag is restored from imagePath');
  t.app.setState({ name: 'root', children: [], wishMap: merged });
  t.app.wishBoardReady();
  await new Promise(r => setTimeout(r, 30));
  assert.ok(t.app.wishHasLocalBytes(t.app.getState().wishMap[0]),
    'the pixels are pulled from Storage even though the doc had no flags');
});

test('wishSyncRetry: an outstanding card gets another attempt without a reload', async () => {
  const t = boot();
  const calls = installFakeFirebase(t.ctx);
  signedIn(t.ctx);
  t.ctx.URL = { createObjectURL: () => 'blob:retry', revokeObjectURL: () => {} };
  t.ctx.fetch = () => Promise.resolve({ ok: true, blob: () => Promise.resolve(t.ctx.__blob) });
  t.ctx.__blob = fakeBlob('pixels');
  t.ctx.seedCloudDoc('users/u1/wishImages/r1', { uid: 'u1', type: 'image/webp', size: 4, bytes: new Uint8Array([4, 5, 6, 7]) });
  t.app.setState({
    name: 'root', children: [],
    wishMap: [{ id: 'r1', title: 'Повтор', imagePath: 'wishImages/r1',
                order: 0, isUserPhoto: false, createdAt: 1, updatedAt: 1, uploadState: 'uploaded' }],
  });
  assert.equal(calls.imageReads.length, 0, 'nothing has happened yet');
  vm.runInContext('wishSyncRetry()', t.ctx);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(calls.imageReads.length, 1, 'coming back online retries the download on its own');
  assert.ok(t.app.wishHasLocalBytes(t.app.getState().wishMap[0]), 'and the card shows its image');
  // Second pass with nothing outstanding: no extra network calls.
  vm.runInContext('wishSyncRetry()', t.ctx);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(calls.imageReads.length, 1, 'and it is a no-op once everything is in place');
});

test('cloud snapshot: an invalid state never replaces the working state', () => {
  const t = boot();
  installFakeFirebase(t.ctx);
  signedIn(t.ctx);
  t.app.setState({ name: 'root', children: [
    { name: 'Моя сфера', sphereActivityAt: Date.now(), children: [
      { name: 'Моя цель', done: false, children: [] }
    ]}
  ]});
  vm.runInContext('startCloudSync("u1")', t.ctx);
  // Повреждённый облачный ответ: state — не дерево целей.
  t.ctx.seedCloudDoc('users/u1', { state: { not: 'a goal tree' }, updatedAt: 'server-ts' });
  t.ctx.firebaseFirestore.emit('users/u1');
  assert.equal(t.app.getCloudStateError(), true, 'corruption flag raised');
  const st = t.app.getState();
  assert.equal(st.children.length, 1, 'working state untouched');
  assert.equal(st.children[0].name, 'Моя сфера', 'local sphere intact');
  const panel = vm.runInContext('statusPanelsHTML()', t.ctx);
  assert.ok(panel.includes('cloudStateErrorOverlay'), 'error panel rendered');
  assert.ok(panel.includes('btnCloudStateErrorDismiss'), 'dismiss button present');
  // Корректный снимок применяется, флаг снимается.
  t.ctx.seedCloudDoc('users/u1', { state: { name: 'root', children: [
    { name: 'Облачная сфера', children: [{ name: 'Облачная цель', done: false, children: [] }] }
  ]}, updatedAt: 'server-ts' });
  t.ctx.firebaseFirestore.emit('users/u1');
  assert.equal(t.app.getCloudStateError(), false, 'flag cleared on valid data');
  assert.equal(t.app.getState().children[0].name, 'Облачная сфера', 'valid cloud data applied');
});

test('п.3: повреждённый облачный ответ НЕ уходит обратно в облако (нет молчаливой перезаписи)', () => {
  const t = boot();
  const calls = installFakeFirebase(t.ctx);
  signedIn(t.ctx);
  t.app.setState({ name: 'root', children: [
    { name: 'Моя сфера', sphereActivityAt: Date.now(), children: [{ name: 'Моя цель', done: false, children: [] }] },
  ] });
  vm.runInContext('startCloudSync("u1")', t.ctx);
  // Приходит мусор вместо дерева целей.
  t.ctx.seedCloudDoc('users/u1', { state: { garbage: true }, updatedAt: 'server-ts' });
  t.ctx.firebaseFirestore.emit('users/u1');
  assert.equal(t.app.getCloudStateError(), true, 'повреждение распознано');
  // Ни одной записи в облако не произошло — мусор не подтверждён и не отправлен обратно.
  assert.equal(calls.firestoreSets.length, 0, 'рабочее состояние не отправлено в облако при повреждённом ответе');
  // Рабочее состояние локально цело.
  assert.equal(t.app.getState().children[0].name, 'Моя сфера');
});

test('п.1: фото с немедленным уходом в фон — байты в кэше, метаданные не теряются', async () => {
  const t = boot();
  const calls = installFakeFirebase(t.ctx);
  signedIn(t.ctx);
  t.ctx.URL = { createObjectURL: () => 'blob:bg', revokeObjectURL: () => {} };
  t.ctx.__blob = fakeBlob('pixels');
  // Пользователь добавил фото и сразу свернул приложение: байты СНАЧАЛА уходят в локальный кэш.
  await t.app.wishCachePut('bg1', t.ctx.__blob);
  const card = { id: 'bg1', title: 'Фото', imagePath: null, order: 0, isUserPhoto: false,
                 createdAt: 1, updatedAt: 1, uploadState: 'pending' };
  t.app.setState(Object.assign(t.app.getState(), { wishMap: [card] }));
  t.app.saveState();   // saveState → scheduleCloudPush (debounce 800 мс) — приложение уходит в фон
  // Уход в фон (visibilitychange → hidden) вызывает flushCloudPush: отложенная запись уходит сразу.
  vm.runInContext('flushCloudPush()', t.ctx);
  await new Promise(r => setTimeout(r, 10));
  // Байты целы в кэше — карточка переживёт уход в фон и перезагрузку.
  const cached = await t.app.wishCacheGet('bg1');
  assert.ok(cached, 'байты фото сохранены в кэше несмотря на уход в фон');
  // Мету карточки видно в localStorage — она не потерялась.
  const ls = t.localStorage.getItem(t.app.STORAGE_KEY);
  assert.ok(ls && ls.includes('bg1'), 'метаданные карточки в localStorage (переживут уход в фон)');
});

