# План рефакторинга — goal-tracker

> Как работать: каждый этап — отдельный коммит (зелёный `npm test` → коммит → отметить `[x]` здесь → сверка README → далее).
> Версия приложения (`APP_VERSION` и синхрон) бампается ТОЛЬКО при правках рантайма: `index.html` / `sw.js` / `manifest.json` / иконки / `package.json`. Тесты и этот файл — без бампа.
> Правила: без сборки и зависимостей, один монолит `index.html`, колесо и его формулы не трогать.

## Этап 1 — Тесты-страховки (перед любыми правками кода)

- [x] 1.1 Тест `render()`: не бросает при открытых панелях/меню, рендерит футер с версией и колесо
- [x] 1.2 Тест-сторож id: каждый `getElementById('X')` имеет реальный `id="X"` в шаблонах (ловит опечатку = мёртвая кнопка)
- [x] 1.3 Тест логики чек-листа: add/remove пункта через чистые функции
- [x] `npm test` зелёный → коммит → сверка README

## Этап 2 — Разбор `attachHandlers()` (685 строк; механический вынос, поведение не меняется)

- [x] 2.1 Разбить на секции-функции: `attachMainViewHandlers`, `attachTreeHandlers`, `attachLeafHandlers`, `attachChecklistDeleteHandlers`, `attachSyncConflictHandlers`, `attachChecklistHandlers`, `attachAccountHandlers`, `attachAuthHandlers`, `attachTopMenuHandlers`, `attachModalHandlers` (по порядку оригинала; границы — только между statement-ами верхнего уровня)
- [x] 2.2 Хелпер `on(id, event, fn)` введён и применён в 2 пилотных секциях (checklist-delete, sync-conflict). **Корректировка:** массовая замена остальных ~40 блоков отклонена — косметический выигрыш против риска сломать рабочие обработчики; boilerplate страхуется id-тестом из Этапа 1; `on()` применять при следующих правках секций
- [x] 2.3 Вынести `addChecklistItem` — **отменено по факту проверки**: реальный размер 9 строк (оценка «290» была ошибкой awk-подсчёта), вложенность безвредна
- [x] 2.4 Дубль обновления `wheelWrap` (2 места) → одна функция `refreshWheel()`
- [x] `npm test` зелёный → коммит → отметить → сверка README

## Этап 3 — Разбор `render()` (305 строк HTML-строкой)

- [x] 3.1 Вынести секции в `*HTML()` по фактической структуре: `topbarHTML()`, `systemPanelsHTML()` (install/about/instructions/checklist-delete), `statusPanelsHTML()` (sync-conflict/relocate/verify), `authPanelsHTML()` (вход/регистрация/аккаунт), `homeViewHTML()`, `nodeViewHTML()`, `footerHTML()`; уже существовавшие `renderBreadcrumb()`, `cardOrLeafHTML()`, `wheelHTML()`, `leafDetailHTML()`, `checklistHTML()` оставлены как есть
- [x] 3.2 `render()` — оркестратор (~55 строк: прелим drag-cleanup/`validatePath`, вызовы секций, `app.innerHTML` + `attachHandlers()` + `adjustWheelLabels()`)
- [x] `npm test` зелёный → коммит → отметить → сверка README

## Этап 4 — Делегирование событий (опционально, только после Этапов 1–3)

- [ ] 4.1 Один слушатель `click` на `#app` + `data-act` вместо ~90 привязок в `attachHandlers`
- [ ] 4.2 Отдельно: `submit`/`keydown`/`blur`-обработчики (делегируются сложнее)
- [ ] `npm test` зелёный → коммит → отметить → сверка README

## Этап 5 — Консолидация UI-состояния

- [ ] 5.1 22 разрозненных `let *Open/*Busy/*Msg/*Error` → объекты `ui` / `authUi`
- [ ] `npm test` зелёный → коммит → отметить → сверка README

## Этап 6 — Документы и CSS (дешёвые правки, без бампа версии)

- [ ] 6.1 README: слить дубли записи «v1.0.2» в истории изменений
- [ ] 6.2 AGENTS.md: «47 тестов» → фактическое число, «~190 КБ» → «~200 КБ», двойная нумерация «3.» → «4.»
- [ ] 6.3 CSS: разбить ~450 строк на прокомментированные секции
- [ ] `npm test` зелёный → коммит → отметить

## Что НЕ входит в план (запрещено правилами проекта)

- Разносить код на отдельные `.js`/`.css` файлы (сломает `sw.js ASSETS` и `tests/helpers.js`)
- Фреймворки, сборка, ESLint и другие зависимости
- Изменения формул колеса, липкой механики `totalGoalsAdded`, правил архива
- MINOR/MAJOR-без явной просьбы владельца

## Журнал выполнения

- Этап 3 — **выполнен** (08.10.2026): `render()` (300 строк) → оркестр ~55 строк + 7 секций-шаблонов (`topbarHTML`, `systemPanelsHTML`, `statusPanelsHTML`, `authPanelsHTML`, `homeViewHTML`, `nodeViewHTML`, `footerHTML`). **Бамп v1.0.7 → v1.0.8**: `APP_VERSION`, `package.json`, `manifest.json`, `sw.js`. Запись в README. `npm test` = 52/52 (тесты панелей проверяют каждую вынесенную секцию).
- Этап 2 — **выполнен** (08.10.2026): `attachHandlers()` разбит на 10 секций + оркестр; `refreshWheel()`; хелпер `on()` (пилот — 2 секции); п. 2.3 отменён по факту (функция 9 строк, а не 290). **Бамп v1.0.6 → v1.0.7** (правка `index.html`): `APP_VERSION`, `package.json`, `manifest.json`, `sw.js CACHE_NAME`. Запись добавлена в README. `npm test` = 52/52.
- Этап 1 — **выполнен** (08.10.2026): новый `tests/render.test.js` (4 теста: панели не роняют `render()`, футер/колесо в HTML, id-сторож `getElementById` ↔ `id="..."`, сквозной чек-лист). Стаб `document` в `tests/helpers.js` дополнен `addEventListener/removeEventListener` (нужно для открытого верхнего меню). `npm test` = 52/52. Версия не бампалась (рантайм не трогали). README сверен с кодом — расхождений нет.
