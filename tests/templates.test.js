/* Шаблоны (п.6), v1.1.99. До подтверждения пользователь видит, что РЕАЛЬНО добавится, с учётом
   лимита 10 сфер и уже существующих данных; нет молчаливого частичного добавления; после
   выполнения — честный результат (добавлено/пропущено и почему). Сравнение имён игнорирует
   регистр и пробелы по краям, существующие записи НЕ переименовываются, защита от дублей сохранена.
   Preview и подтверждение используют ОДИН план (planTemplates), поэтому список = реальность. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boot, container, leaf } = require('./helpers');

function withSel(t, ids) {
  t.app.setSelectedTemplates(ids);
}

test('п.6: план отличает новую сферу, слияние и пропуск по лимиту', () => {
  const t = boot();
  t.app.setState({ name: 'root', children: [container([], { name: 'Здоровье' })] });
  withSel(t, ['health', 'work']);
  const plan = t.app.planTemplates();
  const byName = Object.fromEntries(plan.spheres.map(s => [s.name, s.status]));
  assert.equal(byName['Здоровье'], 'merge', 'существующая сфера — слияние');
  assert.equal(byName['Работа'], 'create', 'новая сфера — создание');
});

test('п.6: лимит 10 сфер — сфера сверху помечена skip, а не теряется молча', () => {
  const t = boot();
  const kids = [];
  for (let i = 0; i < 10; i++) kids.push(container([], { name: 'Сфера ' + i }));
  t.app.setState({ name: 'root', children: kids });
  withSel(t, ['work']);
  const plan = t.app.planTemplates();
  assert.equal(plan.spheres[0].status, 'skip', 'при 10 сферах новая помечена skip');
  assert.equal(plan.counts.skippedSpheres, 1, 'пропуск учтён в счётчике');
  // Применение НЕ добавляет ничего сверх лимита.
  t.app.applyTemplates();
  assert.equal(t.app.getState().children.length, 10, 'активных сфер по-прежнему 10');
});

test('п.6: preview совпадает с реальным применением (единый план)', () => {
  const t = boot();
  t.app.setState({ name: 'root', children: [container([leaf(false, { name: 'Сон' })], { name: 'Здоровье' })] });
  withSel(t, ['health', 'work']);
  const preview = t.app.templatesPreviewHTML();
  // «Сон» уже есть в «Здоровье» — в preview помечен как пропущенная цель.
  assert.match(preview, /уже есть/, 'повторяющаяся цель помечена «уже есть»');
  // Применение: в «Здоровье» «Сон» не продублирован, но остальные 3 цели шаблона добавлены (итого 4).
  const counts = t.app.applyTemplates();
  const st = t.app.getState();
  const health = st.children.find(s => s.name === 'Здоровье');
  assert.equal(health.children.filter(c => c.name === 'Сон').length, 1, 'повтор «Сон» не продублирован');
  assert.equal(health.children.length, 4, 'в «Здоровье» 1 своя + 3 добавленные цели шаблона');
  const work = st.children.find(s => s.name === 'Работа');
  assert.equal(work.children.length, 4, 'новая сфера создана полностью');
  assert.equal(counts.created, 1, 'создана 1 сфера');
  assert.equal(counts.goalsAdded, 7, 'добавлено 7 целей (3 в «Здоровье» + 4 в «Работе»), «Сон» пропущен');
});

test('п.6: сравнение имён игнорирует регистр и пробелы, но НЕ переименовывает', () => {
  const t = boot();
  // Пользовательская сфера с тем же именем, но другим регистром/пробелами.
  t.app.setState({ name: 'root', children: [container([], { name: '  здоРОВье  ' })] });
  withSel(t, ['health']);
  const plan = t.app.planTemplates();
  assert.equal(plan.spheres[0].status, 'merge', '«  здоРОВье  » распознана как «Здоровье»');
  t.app.applyTemplates();
  const st = t.app.getState();
  assert.equal(st.children.length, 1, 'дубль сферы не создан');
  assert.equal(st.children[0].name, '  здоРОВье  ', 'имя пользователя НЕ переименовано');
  assert.equal(st.children[0].children.length, 4, 'цели шаблона добавились в существующую сферу');
});

test('п.6: защита от дублей целей при повторном применении', () => {
  const t = boot();
  withSel(t, ['health']);
  t.app.applyTemplates();
  t.app.applyTemplates();
  const st = t.app.getState();
  const healthSpheres = st.children.filter(s => s.name === 'Здоровье');
  assert.equal(healthSpheres.length, 1, 'сфера не дублируется');
  assert.equal(healthSpheres[0].children.length, 4, 'цели не дублируются при повторном применении');
});

test('п.6: результат честно сообщает пропуск по лимиту', () => {
  const t = boot();
  const kids = [];
  for (let i = 0; i < 10; i++) kids.push(container([], { name: 'Сфера ' + i }));
  t.app.setState({ name: 'root', children: kids });
  withSel(t, ['work']);
  const counts = t.app.applyTemplates();
  assert.equal(counts.created, 0, 'ничего не создано — лимит');
  assert.equal(counts.skippedSpheres, 1, 'одна сфера пропущена');
});
