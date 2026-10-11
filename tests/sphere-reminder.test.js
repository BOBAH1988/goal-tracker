'use strict';
/* Мягкое напоминание о сферах («Только важное»). Гоняет РЕАЛЬНЫЙ код из index.html через
   boot(): порог 14 дней, выбор самой заброшенной сферы, исключение архивных и завершённых,
   «Скрыть», сброс отсчёта после взаимодействия и инициализация существующих данных.
   Клик-пути через настоящие обработчики — в click.test.js. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, leaf, container } = require('./helpers');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

// Сфера с одной открытой целью; daysAgo дней с последнего осознанного взаимодействия.
function sphere(name, daysAgo, opts = {}) {
  const node = container([leaf(false, { name: 'Цель' })], { name });
  node.sphereActivityAt = NOW - daysAgo * DAY;
  if (opts.archived) node.archived = true;
  if (opts.mutedIn) node.sphereMutedUntil = NOW + opts.mutedIn * DAY;
  if (opts.openGoal !== undefined) node.children = [opts.openGoal];
  return node;
}

function freshApp(children) {
  const t = boot();
  t.app.setState({ name: 'root', children });
  return t;
}

test('порог: напоминание появляется ровно через SPHERE_REMINDER_DAYS дней', () => {
  const t = boot();
  assert.equal(t.app.SPHERE_REMINDER_DAYS, 14, 'порог — именованная константа 14 дней');

  // Накануне порога (13 дней) — молчим.
  let app = freshApp([sphere('Здоровье', 13)]);
  assert.equal(app.app.pickSphereReminder(NOW), null, '13 дней — рано');

  // Ровно на пороге — напоминаем.
  app = freshApp([sphere('Здоровье', 14)]);
  const due = app.app.pickSphereReminder(NOW);
  assert.ok(due, '14 дней без взаимодействия — напоминание показано');
  assert.equal(due.node.name, 'Здоровье', 'напоминает о самой заброшенной сфере');

  // И без передачи now (путь интерфейса) поведение то же.
  assert.ok(freshApp([sphere('Здоровье', 14.5)]).app.pickSphereReminder(), 'и по текущему времени');
});

test('выбор сферы: показывается только одна — с самым давним взаимодействием', () => {
  const t = freshApp([
    sphere('Здоровье', 30),
    sphere('Финансы', 20),
    sphere('Свежая', 1),
  ]).app;
  const due = t.pickSphereReminder(NOW);
  assert.ok(due, 'есть за что напомнить');
  assert.equal(due.node.name, 'Здоровье', 'самая давняя из подходящих');
  assert.equal(due.idx, 0, 'индекс сферы в state.children');
});

test('исключение архивной сферы: следующая по давности', () => {
  const t = freshApp([
    sphere('Здоровье', 30, { archived: true }),
    sphere('Финансы', 20),
  ]).app;
  const due = t.pickSphereReminder(NOW);
  assert.ok(due, 'кто-то должен напомнить');
  assert.equal(due.node.name, 'Финансы', 'архивная сфера исключена');
});

test('исключение архивной сферы: если других нет — молчим', () => {
  const t = freshApp([sphere('Здоровье', 30, { archived: true })]).app;
  assert.equal(t.pickSphereReminder(NOW), null, 'архивная сфера не напоминает');
});

test('исключение сфер без активных незавершённых целей', () => {
  // Все цели выполнены.
  let t = freshApp([sphere('Здоровье', 30, { openGoal: leaf(true, { name: 'Готово' }) })]).app;
  assert.equal(t.pickSphereReminder(NOW), null, 'выполненная цель — не повод напоминать');

  // Все цели в архиве (архивный контейнер скрывает всё внутри).
  t = freshApp([sphere('Здоровье', 30, {
    openGoal: container([leaf(false)], { archived: true, name: 'В архиве' }),
  })]).app;
  assert.equal(t.pickSphereReminder(NOW), null, 'цель в архиве не считается открытой');

  // Частично заполненный чек-лист — цель ещё не завершена.
  t = freshApp([sphere('Здоровье', 30, {
    openGoal: leaf(false, { name: 'С чек-листом', checklist: [{ text: 'a', done: true }, { text: 'b', done: false }] }),
  })]).app;
  assert.ok(t.pickSphereReminder(NOW), 'частично выполненный чек-лист — ещё открытая цель');

  // Полностью закрытый чек-лист — цель завершена.
  t = freshApp([sphere('Здоровье', 30, {
    openGoal: leaf(false, { name: 'С чек-листом', checklist: [{ text: 'a', done: true }, { text: 'b', done: true }] }),
  })]).app;
  assert.equal(t.pickSphereReminder(NOW), null, 'закрытый чек-лист — цель завершена');

  // Одна выполненная + одна открытая — сфера ещё в работе.
  t = freshApp([{
    name: 'Здоровье',
    sphereActivityAt: NOW - 30 * DAY,
    children: [leaf(true, { name: 'Готово' }), leaf(false, { name: 'В работе' })],
  }]).app;
  assert.ok(t.pickSphereReminder(NOW), 'пока есть открытая цель — напоминаем');
});

test('скрытие: «Скрыть» убирает сферу на 14 дней и возвращает её после', () => {
  const t = freshApp([sphere('Здоровье', 30)]).app;
  const due = t.pickSphereReminder(NOW);
  assert.ok(due, 'до скрытия напоминаем');

  t.hideSphereReminder(due.node);
  assert.ok(Math.abs(due.node.sphereMutedUntil - (Date.now() + 14 * DAY)) < 5000,
    'mute ровно на SPHERE_REMINDER_DAYS дней');

  // Внутри окна молчания — молчим (даже если сфера всё так же заброшена).
  assert.equal(t.pickSphereReminder(NOW + 5 * DAY), null, '5 дней после «Скрыть» — молчим');
  assert.equal(t.pickSphereReminder(NOW + 13 * DAY), null, '13 дней после «Скрыть» — ещё молчим');

  // Окно истекло, взаимодействия всё нет — напоминаем снова.
  assert.ok(t.pickSphereReminder(NOW + 15 * DAY), 'после 14 дней тишины — снова напоминаем');

  // Скрытие влияет только на свою сферу.
  const both = freshApp([sphere('Здоровье', 30), sphere('Финансы', 25)]).app;
  both.hideSphereReminder(both.getState().children[0]);
  const next = both.pickSphereReminder(NOW);
  assert.ok(next && next.node.name === 'Финансы', 'другая сфера напоминает независимо');
});

test('сброс отсчёта: взаимодействие обнуляет давность (touchSphereAtPath)', () => {
  const app = freshApp([sphere('Здоровье', 30)]).app;
  assert.ok(app.pickSphereReminder(NOW), 'до взаимодействия напоминаем');

  // Любой путь внутри сферы [0] отмечает взаимодействие именно с ней.
  app.touchSphereAtPath([0]);
  assert.equal(app.pickSphereReminder(NOW), null, 'свежее взаимодействие — напоминание уходит');

  app.touchSphereAtPath([0, 0]);
  assert.equal(app.pickSphereReminder(NOW), null, 'и на глубину внутри сферы — тоже');

  // Домашний уровень и мусорные пути ничего не ломают и не отмечают.
  const before = app.getState().children[0].sphereActivityAt;
  app.touchSphereAtPath([]);
  app.touchSphereAtPath(null);
  app.touchSphereAtPath([5]);
  assert.equal(app.getState().children[0].sphereActivityAt, before, 'пустой/битый путь — no-op');
});

test('init: существующие сферы без даты получают отсчёт с первого запуска, не из прошлого', () => {
  // Сохранение «до обновления»: ни sphereActivityAt, ни sphereMutedUntil нет вообще.
  const legacy = {
    name: 'root',
    children: [
      { name: 'Здоровье', children: [{ name: 'Цель 1', done: false, children: [] }] },
      { name: 'Финансы', children: [{ name: 'Цель 2', done: false, children: [] }] },
    ],
  };
  const app = freshApp(legacy.children).app;
  app.ensureSphereActivity(app.getState());
  const kids = app.getState().children;
  kids.forEach((s, i) => {
    assert.ok(Number.isFinite(s.sphereActivityAt), `сфера ${i} получила дату`);
    assert.ok(s.sphereActivityAt > NOW - 5000, `сфера ${i}: отсчёт с момента запуска, не из прошлого`);
    assert.ok(s.sphereActivityAt <= Date.now() + 1000, `сфера ${i}: дата не в будущем`);
  });
  // И сразу ничего не напоминаем.
  assert.equal(app.pickSphereReminder(), null, 'сразу после обновления напоминаний нет');

  // Мусор в дате тишины вычищается.
  legacy.children[0].sphereMutedUntil = 'когда-нибудь';
  app.ensureSphereActivity(app.getState());
  assert.equal('sphereMutedUntil' in app.getState().children[0], false, 'битная дата тишины удалена');
});

test('init: новая сфера помечается при создании (btnAddGoal проставляет дату)', () => {
  const app = freshApp([]).app;
  const born = container([leaf(false)], { name: 'Новая' });
  app.touchSphere(born);
  assert.ok(born.sphereActivityAt > NOW - 5000, 'новая сфера начинает отсчёт с создания');
  app.setState({ name: 'root', children: [sphere('Старая', 30), born] });
  const due = app.pickSphereReminder(NOW);
  assert.ok(due && due.node.name === 'Старая', 'новая сфера не попадает в напоминание сразу');
});

test('init: дата читается из облачного состояния (обычные числа, без придумывания)', () => {
  // Firestore отдаёт state как обычный JSON — дата взаимодействия приезжает числом.
  const app = freshApp([{
    name: 'Здоровье',
    sphereActivityAt: NOW - 30 * DAY,
    sphereMutedUntil: NOW + 3 * DAY,
    children: [{ name: 'Цель 1', done: false, children: [] }],
  }]).app;
  assert.equal(app.pickSphereReminder(NOW), null, 'уважаем приехавшую дату тишины');
  assert.ok(app.pickSphereReminder(NOW + 4 * DAY), 'тишина истекла — напоминаем снова');
});

test('гейт готовности данных: до загрузки напоминание не считается', () => {
  const t = freshApp([sphere('Здоровье', 30)]);
  // Локальный пользователь (cloudEnabled = false) открывает гейт ещё на этапе парсинга.
  assert.equal(t.app.getSphereDataReady(), true, 'без облака гейт открыт до первой отрисовки');

  const html = t.app.homeViewHTML(0, '', null, 1);
  assert.ok(html.includes('sphere-reminder'), 'локальный пользователь видит блок');
  assert.ok(html.includes('Здоровье'), 'с названием своей сферы');
  assert.ok(html.includes('btnSphereReminderOpen'), 'кнопка «Открыть сферу»');
  assert.ok(html.includes('btnSphereReminderHide'), 'кнопка «Скрыть»');

  // С облаком: пока первый снапшот не применен, блок не рисуется.
  t.app.setSphereDataReady(false);
  const gated = t.app.homeViewHTML(0, '', null, 1);
  assert.ok(!gated.includes('sphere-reminder'), 'до загрузки данных напоминания нет');
  t.app.setSphereDataReady(true);
  assert.ok(t.app.homeViewHTML(0, '', null, 1).includes('sphere-reminder'), 'после загрузки — есть');
});

test('openSphereTree: открывает дерево сферы и отмечает взаимодействие', () => {
  const app = freshApp([sphere('Здоровье', 30), sphere('Финансы', 20)]).app;
  assert.ok(app.pickSphereReminder(NOW), 'напомнили бы');
  app.setPath([]);
  app.openSphereTree(0);
  assert.deepEqual(Array.from(app.getPath()), [0], 'страница = дерево сферы');
  assert.ok(app.getState().children[0].sphereActivityAt > NOW - 5000, 'взаимодействие отмечено');
  // Свежая сфера больше не напоминает, а заброшенная «Финансы» — ещё нет.
  const next = app.pickSphereReminder(NOW);
  assert.ok(next && next.node.name === 'Финансы', 'открытая сфера выпадает из напоминаний');

  // Несуществующий индекс ничего не ломает.
  app.setPath([]);
  app.openSphereTree(9);
  assert.deepEqual(Array.from(app.getPath()), [], 'битый индекс — no-op');
});

test('круг локулей ru/en: ключи напоминания есть в обоих языках', () => {
  const t = boot();
  for (const lang of ['ru', 'en']) {
    const s = t.app.STRINGS[lang];
    for (const key of ['sphereReminderText', 'sphereReminderOpen', 'sphereReminderHide']) {
      assert.ok(key in s, `${lang}.${key} обязателен`);
    }
    assert.equal(typeof s.sphereReminderText, 'function', `${lang}.sphereReminderText — функция имени`);
    assert.ok(s.sphereReminderText('Здоровье').includes('Здоровье'), `${lang}: имя подставляется`);
    assert.ok(s.sphereReminderOpen.length > 0 && s.sphereReminderHide.length > 0, `${lang}: кнопки непустые`);
  }
});
