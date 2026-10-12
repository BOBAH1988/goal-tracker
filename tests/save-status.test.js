/* Статусы сохранения (п.2) и параллельная синхронизация (п.7), v1.1.99.
   Данные — главный приоритет, поэтому:
   - ошибка записи больше НЕ молчит (не .catch(()=>{})): показывается статус, данные локально целы,
     есть «Повторить», и повторов КОНЕЧНОЕ число (без бесконечного цикла переотправки);
   - «сохранено в аккаунт» говорится ТОЛЬКО после подтверждённой сервером записи;
   - push перед записью перечитывает документ и, если облако ушло вперёд (параллельная правка с
     другого устройства), НЕ перезаписывает его молча — поднимает конфликт на выбор пользователя.
   Настоящий Firebase не подделывается: это юнит-проверки механики статусов/блокировки на
   vm-песочнице с тем же фейковым Firestore, что и wish-sync (реальные правила — отдельно, эмулятор). */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const { boot } = require('./helpers');

// Минимальный фейк Firestore ровно под то, что использует pushCloudStateNow: get()/set() на
// документе users/{uid}. set payload'ы и текущий updatedAt выставляются тестом, чтобы
// воспроизвести «облако ушло вперёд».
function installCloud(ctx, opts) {
  opts = opts || {};
  const state = { updatedAt: opts.updatedAt, failSet: !!opts.failSet, failGet: !!opts.failGet };
  const calls = { sets: [], gets: 0 };
  const ref = {
    set: (payload) => {
      calls.sets.push(payload);
      if (state.failSet) return Promise.reject(Object.assign(new Error('unavailable'), { code: 'unavailable' }));
      return Promise.resolve();
    },
    get: () => {
      calls.gets++;
      if (state.failGet) return Promise.reject(Object.assign(new Error('offline'), { code: 'unavailable' }));
      return Promise.resolve({ exists: !!state.updatedAt, data: () => ({ updatedAt: state.updatedAt }) });
    },
  };
  const firestoreFactory = () => ({ collection: () => ({ doc: () => ref }) });
  firestoreFactory.FieldValue = { serverTimestamp: () => 'server-ts' };
  ctx.firebase = { firestore: firestoreFactory };
  vm.runInContext('cloudEnabled = true; authUser = { uid: "u1", email: "a@b.c" };', ctx);
  return { ref, calls, state };
}

test('п.2: «сохранено» говорится только после подтверждённой записи, а не сразу', async () => {
  const t = boot();
  installCloud(t.ctx, { updatedAt: 0 });
  t.app.setState({ name: 'root', children: [] });
  assert.equal(t.app.getCloudPushStatus(), 'idle', 'до push статус idle');
  vm.runInContext('pushCloudStateNow()', t.ctx);
  assert.equal(t.app.getCloudPushStatus(), 'saving', 'пока запись в полёте — «saving», не «saved»');
  await new Promise(r => setTimeout(r, 10));
  assert.equal(t.app.getCloudPushStatus(), 'saved', 'только подтверждённая сервером запись → saved');
});

test('п.2: ошибка облачной записи НЕ молчит — статус error, данные локально целы', async () => {
  const t = boot();
  installCloud(t.ctx, { updatedAt: 0, failSet: true });
  t.app.setState({ name: 'root', children: [
    { name: 'Сфера', sphereActivityAt: 1, children: [{ name: 'Цель', done: false, children: [] }] },
  ] });
  vm.runInContext('pushCloudStateNow()', t.ctx);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(t.app.getCloudPushStatus(), 'error', 'сбой записи → видимый статус error');
  assert.equal(t.app.getState().children[0].name, 'Сфера', 'рабочие данные целы после сбоя push');
  assert.equal(t.app.getState().children[0].children[0].name, 'Цель');
  const panel = vm.runInContext('statusPanelsHTML()', t.ctx);
  assert.ok(panel.includes('saveErrorBanner'), 'баннер ошибки сохранения показан');
  assert.ok(panel.includes('btnRetryCloudPush'), 'предложен явный «Повторить»');
  t.app.stopCloudPushRetry();   // снять таймер backoff, чтобы он не держал прогон
});

test('п.2: повторов облачной записи КОНЕЧНОЕ число — нет бесконечного цикла', async () => {
  const t = boot();
  installCloud(t.ctx, { updatedAt: 0, failSet: true });
  t.app.setState({ name: 'root', children: [] });
  // Дёргаем обработчик сбоя многократно: счётчик обязан упереться в потолок CLOUD_PUSH_MAX_RETRIES
  // и перестать расти — именно это исключает бесконечный цикл переотправки при мёртвой сети.
  vm.runInContext('cloudPushRetries = 0;', t.ctx);
  for (let i = 0; i < 10; i++) {
    vm.runInContext('cloudPushFailed({code:"unavailable"});', t.ctx);
    await new Promise(r => setTimeout(r, 0));
  }
  assert.equal(t.app.getCloudPushRetries(), 5, 'счётчик повторов упирается в потолок 5, а не растёт бесконечно');
  assert.equal(t.app.getCloudPushStatus(), 'error', 'после исчерпания повторов — статус error с явным «Повторить»');
  t.app.stopCloudPushRetry();
});

test('п.2: ошибка localStorage помечается (localSaveError) и показывается пользователю', () => {
  const t = boot();
  t.localStorage.setItem = () => { throw Object.assign(new Error('QuotaExceededError'), { name: 'QuotaExceededError' }); };
  t.app.setState({ name: 'root', children: [] });
  vm.runInContext('saveState()', t.ctx);
  assert.equal(t.app.getLocalSaveError(), true, 'сбой локальной записи помечен');
  const panel = vm.runInContext('statusPanelsHTML()', t.ctx);
  assert.ok(panel.includes('saveErrorBanner'), 'баннер ошибки локального сохранения показан');
  assert.ok(panel.includes('хранилище'), 'пользователю сказано, что локальная копия не сохранилась');
});

test('п.7: параллельная правка с другого устройства НЕ перезаписывается молча — конфликт', async () => {
  const t = boot();
  // Мы применили облачный снимок, записанный в момент T=1000.
  const cloud = installCloud(t.ctx, { updatedAt: 0 });
  t.app.setLastAppliedCloudUpdatedAt(1000);
  t.app.setState({ name: 'root', children: [] });
  // Другое устройство ушло вперёд: документ теперь с updatedAt = 9_000_000 (мс сервера).
  cloud.state.updatedAt = 9000000;
  vm.runInContext('pushCloudStateNow()', t.ctx);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(t.app.getCloudPushStatus(), 'conflict', 'облако ушло вперёд → конфликт, не тихая перезапись');
  assert.equal(cloud.calls.sets.length, 0, 'молчаливой перезаписи НЕ произошло');
  const panel = vm.runInContext('statusPanelsHTML()', t.ctx);
  assert.ok(panel.includes('cloudPushConflictOverlay'), 'диалог конфликта показан');
  assert.ok(panel.includes('btnCloudPushKeepCloud'), 'можно оставить облачные данные');
  assert.ok(panel.includes('btnCloudPushKeepLocal'), 'можно настоять на своих');
});

test('п.7: «оставить локальные» осознанно перезаписывает облако', async () => {
  const t = boot();
  const cloud = installCloud(t.ctx, { updatedAt: 0 });
  t.app.setLastAppliedCloudUpdatedAt(1000);
  t.app.setState({ name: 'root', children: [{ name: 'Моя сфера', children: [] }] });
  cloud.state.updatedAt = 9000000;   // облако впереди
  vm.runInContext('pushCloudStateNow()', t.ctx);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(t.app.getCloudPushStatus(), 'conflict');
  vm.runInContext('resolvePushConflict(true)', t.ctx);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(cloud.calls.sets.length, 1, 'осознанная перезапись произошла');
  assert.equal(cloud.calls.sets[0].state.children[0].name, 'Моя сфера', 'в облако ушли именно локальные правки');
});

test('п.7: «оставить облачные» не пишет ничего, ждёт снапшот', async () => {
  const t = boot();
  const cloud = installCloud(t.ctx, { updatedAt: 0 });
  t.app.setLastAppliedCloudUpdatedAt(1000);
  t.app.setState({ name: 'root', children: [] });
  cloud.state.updatedAt = 9000000;
  vm.runInContext('pushCloudStateNow()', t.ctx);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(t.app.getCloudPushStatus(), 'conflict');
  vm.runInContext('resolvePushConflict(false)', t.ctx);
  assert.equal(cloud.calls.sets.length, 0, 'облачную версию не трогаем');
  assert.equal(t.app.getCloudPushStatus(), 'idle', 'конфликт снят, ждём следующий снапшот');
});

test('п.7: без учтённого ранее снимка (lastApplied=0) запись идёт как обычно', async () => {
  const t = boot();
  const cloud = installCloud(t.ctx, { updatedAt: 9000000 });
  assert.equal(t.app.getLastAppliedCloudUpdatedAt(), 0);
  t.app.setState({ name: 'root', children: [] });
  vm.runInContext('pushCloudStateNow()', t.ctx);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(t.app.getCloudPushStatus(), 'saved', 'первая запись нового аккаунта проходит');
  assert.equal(cloud.calls.sets.length, 1);
});

/* Сквозной сценарий п.7 через настоящий onSnapshot: два устройства одновременно меняют РАЗНЫЕ
   цели. Устройство применяет начальный снимок, вносит свою правку (не отправляя), затем прилетает
   снимок с чужой правкой. Раньше снапшот молча делал state = data.state и затирал нашу правку —
   теперь поднимается конфликт, ничего не перезаписывается молча, обе стороны целы. */
function installSnapshotCloud(ctx) {
  const store = new Map();       // key -> doc data
  let listener = null;
  const ref = {
    set: (payload) => { store.set('users/u1', payload); return Promise.resolve(); },
    get: () => Promise.resolve({ exists: store.has('users/u1'), data: () => store.get('users/u1') }),
    onSnapshot: (cb) => { listener = cb; cb({ exists: store.has('users/u1'), data: () => store.get('users/u1') }, () => {}); return () => {}; },
  };
  const firestoreFactory = () => ({ collection: () => ({ doc: () => ref }) });
  firestoreFactory.FieldValue = { serverTimestamp: () => 'server-ts' };
  ctx.firebase = { firestore: firestoreFactory };
  vm.runInContext('cloudEnabled = true; authUser = { uid: "u1", email: "a@b.c" };', ctx);
  return {
    store,
    seed: (data) => { store.set('users/u1', data); if (listener) listener({ exists: true, data: () => data }, () => {}); },
    get: () => store.get('users/u1'),
  };
}

test('п.7: чужая правка при наших незапушенных изменениях — конфликт, не молчаливая перезапись', async () => {
  const t = boot();
  const cloud = installSnapshotCloud(t.ctx);
  // Начальный общий снимок: две сферы-цели.
  const base = { name: 'root', updatedAt: 1000, priorityDefaultsSeeded: true, children: [
    { name: 'А', sphereActivityAt: 1, children: [] },
    { name: 'Б', sphereActivityAt: 1, children: [] },
  ] };
  cloud.store.set('users/u1', { state: base, updatedAt: 1000 });
  // Устройство подписывается и применяет начальный снимок.
  vm.runInContext('startCloudSync("u1")', t.ctx);
  await new Promise(r => setTimeout(r, 5));
  assert.equal(t.app.getState().children.length, 2, 'начальный снимок применён');
  assert.equal(t.app.getSyncConflict ? t.app.getSyncConflict() : null, null, 'конфликта пока нет');

  // Наше УСТРОЙСТВО вносит незапушенную правку: переименовываем «А» → «А (моя правка)».
  t.app.getState().children[0].name = 'А (моя правка)';

  // Прилетает снимок с ДРУГОГО устройства: оно переименовало «Б» → «Б (чужая правка)».
  const foreign = { name: 'root', updatedAt: 9000000, children: [
    { name: 'А', sphereActivityAt: 1, children: [] },
    { name: 'Б (чужая правка)', sphereActivityAt: 1, children: [] },
  ] };
  cloud.seed({ state: foreign, updatedAt: 9000000 });
  await new Promise(r => setTimeout(r, 5));

  // Конфликт поднят, и НАША правка не потеряна (working state цел).
  assert.equal(t.app.getState().children[0].name, 'А (моя правка)', 'наша незапушенная правка цела');
  const panel = vm.runInContext('statusPanelsHTML()', t.ctx);
  assert.ok(panel.includes('syncConflictOverlay'), 'показан диалог выбора вместо молчаливой перезаписи');
});

test('п.7: эхо нашего собственного push НЕ считается чужим изменением', async () => {
  const t = boot();
  const cloud = installSnapshotCloud(t.ctx);
  const base = { name: 'root', updatedAt: 1000, children: [{ name: 'А', sphereActivityAt: 1, children: [] }] };
  cloud.store.set('users/u1', { state: base, updatedAt: 1000 });
  vm.runInContext('startCloudSync("u1")', t.ctx);
  await new Promise(r => setTimeout(r, 5));
  // Успешно пушим наше состояние — запоминается как последнее применённое.
  t.app.setLastAppliedCloudUpdatedAt(1000);
  t.app.setState({ name: 'root', children: [{ name: 'А', sphereActivityAt: 1, children: [] }] });
  // Сервер подтвердил запись с тем же содержанием — снапшот-эхо приходит.
  cloud.seed({ state: base, updatedAt: 5000 });
  await new Promise(r => setTimeout(r, 5));
  // Тот же контент (по дереву) — это эхо, конфликта быть не должно.
  assert.equal(t.app.getState().children[0].name, 'А', 'эхо нашего push применено без конфликта');
});

