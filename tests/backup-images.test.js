/* Резервная копия с фото «Карты желаний» (п.1), v1.1.99.
   Байты фото живут в IndexedDB-кэше, НЕ в state. Раньше экспорт сохранял только метаданные —
   восстановление на чистом браузере давало карточки без картинок. Теперь экспорт собирает байты
   ОТДЕЛЬНО (блок wishImages JSON), не касаясь рабочего состояния/localStorage, а импорт кладёт
   их обратно в кэш. Совместимость со старыми JSON (v1, без фото) сохранена. Если часть фото
   недоступна — об этом честно сообщается. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const { boot } = require('./helpers');

function makeBlob(bytes, type) {
  const u8 = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  return new Blob([u8], { type: type || 'image/webp' });
}

// Драйвер экспорта: URL.createObjectURL получает готовый Blob → читаем его как JSON-payload.
// confirm управляет ветку «часть фото недоступна»: true = скачать без них, false = отмена.
async function exportPayload(t, opts) {
  opts = opts || {};
  t.ctx.confirm = () => !!opts.confirmResult;
  t.ctx.__exportBlob = null;
  t.ctx.URL = {
    createObjectURL: (b) => { t.ctx.__exportBlob = b; return 'blob:export'; },
    revokeObjectURL: () => {},
  };
  const origCreate = t.document.createElement;
  t.document.createElement = (tag) => { const el = origCreate(tag); if (String(tag).toLowerCase() === 'a') el.click = () => {}; return el; };
  await vm.runInContext('doExportData()', t.ctx);
  t.document.createElement = origCreate;
  if (!t.ctx.__exportBlob) return { aborted: true, payload: null };
  const buf = new Uint8Array(await t.ctx.__exportBlob.arrayBuffer());
  return { aborted: false, payload: JSON.parse(Buffer.from(buf).toString('utf8')) };
}

// Драйвер импорта: FileReader в песочнице нет — подкладываем фейк, отдающий текст из file.__text.
// atob/btoa тоже отсутствуют в vm-контексте — добавляем из хоста (dataUrlToBlob их использует).
function runImport(t, payloadObj) {
  const text = typeof payloadObj === 'string' ? payloadObj : JSON.stringify(payloadObj);
  t.ctx.confirm = () => true;
  t.ctx.alert = () => {};
  t.ctx.atob = (s) => Buffer.from(s, 'base64').toString('binary');
  t.ctx.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
  t.ctx.URL = { createObjectURL: () => 'blob:restored', revokeObjectURL: () => {} };
  t.ctx.FileReader = class {
    constructor() { this.result = null; this.onload = null; }
    readAsText(file) { Promise.resolve().then(() => { this.result = file.__text; if (this.onload) this.onload(); }); }
  };
  return vm.runInContext('doImportData({ __text: ' + JSON.stringify(text) + ' })', t.ctx);
}

test('п.1: экспорт v2 несёт фото отдельным блоком, а state остаётся без байтов', async () => {
  const t = boot();
  const blob = makeBlob([1, 2, 3, 4, 5], 'image/webp');
  await t.app.wishCachePut('c1', blob);
  t.app.setState({
    name: 'root', children: [],
    wishMap: [{ id: 'c1', title: 'Дом', imagePath: 'wishImages/c1', order: 0,
                isUserPhoto: false, createdAt: 1, updatedAt: 1, uploadState: 'uploaded' }],
  });
  const { payload } = await exportPayload(t);
  assert.equal(payload.version, 2, 'backup помечен версией 2');
  assert.ok(payload.wishImages && payload.wishImages.c1, 'байты фото лежат в отдельном блоке wishImages');
  assert.match(payload.wishImages.c1, /^data:image\/webp;base64,/, 'фото закодировано как data: URL');
  const stateJson = JSON.stringify(payload.state);
  assert.equal(stateJson.includes('base64'), false, 'state внутри бэкапа без base64');
  assert.equal(stateJson.includes('data:image'), false, 'state внутри бэкапа без data: URL');
});

test('п.1: экспорт не трогает рабочее состояние и localStorage (байты не утекают)', async () => {
  const t = boot();
  const blob = makeBlob([9, 9, 9], 'image/webp');
  await t.app.wishCachePut('c1', blob);
  t.app.setState({
    name: 'root', children: [],
    wishMap: [{ id: 'c1', title: 'Т', imagePath: 'wishImages/c1', order: 0,
                isUserPhoto: false, createdAt: 1, updatedAt: 1, uploadState: 'uploaded' }],
  });
  const before = JSON.stringify(t.app.getState());
  await exportPayload(t);
  const after = JSON.stringify(t.app.getState());
  assert.equal(before, after, 'рабочее состояние не изменилось после экспорта');
  const ls = t.localStorage.getItem(t.app.STORAGE_KEY);
  assert.ok(!ls || !ls.includes('base64'), 'в localStorage нет байтов фото после экспорта');
});

test('п.1: импорт v2 кладёт фото в кэш — карточка рендерится с пикселями на чистом браузере', async () => {
  const t = boot();   // «чистый браузер»: кэш пуст, облака нет
  const backup = {
    app: 'goal-tracker-backup', version: 2, exportedAt: 'x',
    state: { name: 'root', children: [{ name: 'Сфера', children: [] }],
             wishMap: [{ id: 'c1', title: 'Дом', imagePath: 'wishImages/c1', order: 0,
                         isUserPhoto: false, createdAt: 1, updatedAt: 1, uploadState: 'uploaded' }] },
    wishImages: { c1: 'data:image/webp;base64,' + Buffer.from([1, 2, 3, 4, 5]).toString('base64') },
  };
  await runImport(t, backup);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(t.app.getState().children[0].name, 'Сфера', 'дерево целей восстановлено');
  const cached = await t.app.wishCacheGet('c1');
  assert.ok(cached, 'фото попало в кэш');
  const bytes = new Uint8Array(await cached.arrayBuffer());
  assert.deepEqual(Array.from(bytes), [1, 2, 3, 4, 5], 'байты фото восстановлены побайтно');
  assert.ok(t.app.wishHasLocalBytes(t.app.getState().wishMap[0]), 'карточка показывает пиксели, а не заглушку');
});

test('п.1: совместимость со старым JSON v1 (без фото) — цели импортируются как раньше', async () => {
  const t = boot();
  const backup = {
    app: 'goal-tracker-backup', version: 1, exportedAt: 'x',
    state: { name: 'root', children: [{ name: 'Старая сфера', children: [] }],
             wishMap: [{ id: 'c1', title: 'Без фото', imagePath: 'wishImages/c1', order: 0,
                         isUserPhoto: false, createdAt: 1, updatedAt: 1, uploadState: 'uploaded' }] },
  };
  await runImport(t, backup);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(t.app.getState().children[0].name, 'Старая сфера', 'старый бэкап v1 импортируется');
  assert.equal(t.app.getState().wishMap.length, 1, 'карточка метаданных на месте');
  const cached = await t.app.wishCacheGet('c1');
  assert.equal(cached, null, 'фото нет в старом бэкапе — кэш пуст (и не падаем)');
});

test('п.1: часть фото недоступна — экспорт честно помечает missingImages', async () => {
  const t = boot();
  await t.app.wishCachePut('c1', makeBlob([7, 7], 'image/webp'));   // c1 доступно, c2 — нет
  t.app.setState({
    name: 'root', children: [],
    wishMap: [
      { id: 'c1', title: 'Есть', imagePath: 'wishImages/c1', order: 0, isUserPhoto: false, createdAt: 1, updatedAt: 1, uploadState: 'uploaded' },
      { id: 'c2', title: 'Нет', imagePath: 'wishImages/c2', order: 1, isUserPhoto: false, createdAt: 1, updatedAt: 1, uploadState: 'pending' },
    ],
  });
  const { payload } = await exportPayload(t, { confirmResult: true });
  assert.ok(payload.wishImages && payload.wishImages.c1, 'доступное фото включено');
  assert.ok(!payload.wishImages.c2, 'недоступное фото не включено');
  assert.deepEqual(Array.from(payload.missingImages), ['c2'], 'недоступное фото перечислено в missingImages');
});

test('п.1: «Отмена» при недоступных фото НЕ создаёт неполную копию молча', async () => {
  const t = boot();
  t.app.setState({
    name: 'root', children: [],
    wishMap: [{ id: 'c2', title: 'Нет', imagePath: null, order: 0, isUserPhoto: false, createdAt: 1, updatedAt: 1, uploadState: 'pending' }],
  });
  const { aborted } = await exportPayload(t, { confirmResult: false });   // пользователь отменил
  assert.equal(aborted, true, 'после «Отмена» файл резервной копии не создаётся');
});

test('п.1: bytesToBase64 ↔ atob — round-trip байтов без потерь', () => {
  const t = boot();
  const samples = [Uint8Array.from([0]), Uint8Array.from([255, 254, 253]),
                   Uint8Array.from(Array.from({ length: 300 }, (_, i) => i % 256))];
  for (const bytes of samples) {
    const b64 = t.app.bytesToBase64(bytes);
    const back = new Uint8Array(Buffer.from(b64, 'base64'));
    assert.deepEqual(Array.from(back), Array.from(bytes), 'base64 round-trip сохраняет байты');
  }
});
