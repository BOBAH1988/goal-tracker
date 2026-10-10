// Service worker «Только важное» — офлайн-first. Приложение открывается из кэша, даже если сеть
// на устройстве недоступна или работает через «белые списки» мобильного оператора (браузер
// считает, что интернет есть, но запрос к сайту блокируется или зависает).
//
// Версия кэша = версия приложения (см. APP_VERSION в index.html): каждый бамп версии
// гарантированно сносит старый кэш у всех, кто уже установил приложение, и тянет свежие файлы.
const CACHE_NAME = 'goal-tracker-v1.1.50';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './quotes.js'
];

// Фрагмент, который есть ТОЛЬКО в настоящей «оболочке» приложения. На «белых списках» оператор
// может ответить на заблокированный запрос своей страницей-заглушкой с кодом 200 и тем же
// content-type — если отдать/закэшировать её, пользователь увидит чёрный экран вместо приложения.
// Поэтому HTML без этого маркера считается «не нашим» и не используется.
const APP_MARKER = 'id="app"';

// Таймаут на сетевой запрос: на «белом списке» fetch к github.io может долго висеть вместо
// быстрого отказа. Без ограничения интерфейс ждал бы его и показывал чёрный экран.
function fetchWithTimeout(request, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(request, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

// Проверяет, что ответ — действительно ожидаемый файл, а не страница-заглушка оператора (на
// «белых списках» она может приходить с кодом 200 и тем же content-type). Разные типы ресурсов
// проверяются разным маркером; чужой контент в кэш не попадает.
async function isExpectedPayload(url, response) {
  if (!response || !response.ok) return false;
  if (response.type && response.type !== 'basic') return false;
  try {
    let path;
    try {
      path = new URL(url).pathname;
    } catch (e) {
      path = String(url).split('?')[0].split('#')[0]; // относительный URL
    }
    if (path.endsWith('.png')) {
      // Магические байты PNG — HTML-заглушка под видом иконки не пройдёт.
      const head = new Uint8Array(await response.clone().arrayBuffer());
      return head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
    }
    const body = await response.clone().text();
    if (path.endsWith('/') || path.endsWith('.html')) return body.indexOf(APP_MARKER) !== -1;
    if (path.endsWith('manifest.json')) return body.indexOf('"start_url"') !== -1;
    if (path.endsWith('quotes.js')) return body.indexOf('MOTIV_QUOTES') !== -1;
    return true;
  } catch (e) {
    return false;
  }
}

// Кэш-ключ навигации: запрос приходит с cache-busting «?_sw=<ts>» после применения обновления
// (см. controllerchange в index.html). Если писать ответ под таким ключом, каждый апдейт растил
// бы кэш новым дублем оболочки. Приводим любой такой URL к каноническому './index.html'.
function navCacheKey(request) {
  try {
    const url = new URL(request.url);
    // Корень и любой html-запрос пишутся под './index.html' — единственный ключ оболочки.
    if (url.pathname === '/' || url.pathname.endsWith('/') || url.pathname.endsWith('.html')) {
      return './index.html';
    }
  } catch (e) { /* относительный URL — отдаём как есть ниже */ }
  return request;
}

// Кэширует HTML-оболочку, но только если ответ прошёл валидацию маркером. true при успехе.
async function cacheIfAppShell(request, cache, response) {
  try {
    if (!(await isExpectedPayload(request.url, response))) return false;
    await cache.put(navCacheKey(request), response);
    return true;
  } catch (e) {
    return false;
  }
}

self.addEventListener('install', (event) => {
  // Кэшируем каждый ассет по отдельности: один недоступный URL (например, заблокированный
  // «белым списком») НЕ должен ронять всю установку через addAll(), иначе новый воркер не
  // активируется и приложение навсегда остаётся на старом кэше. skipWaiting() НЕ вызываем:
  // новый воркер ждёт в состоянии waiting, пока пользователь подтвердит обновление в диалоге
  // index.html (сообщение SKIP_WAITING) — так обновление не перезагружает приложение в самый
  // неподходящий момент и не ломает работу без сети.
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(ASSETS.map(async (url) => {
      try {
        const req = new Request(url, { cache: 'reload' }); // минуя HTTP-кэш браузера
        const res = await fetch(req);
        // Каждый ассет проходит валидацию маркером — заглушка оператора не закэшируется.
        if (res && res.ok && await isExpectedPayload(req.url, res)) {
          await cache.put(req, res);
        }
      } catch (e) { /* офлайн/блокировка — догрузим фоновым запросом позже */ }
    }));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Защита от «пустого» обновления: всё, что не удалось скачать при установке (обрыв или
    // блокировка сети в момент установки), подтягиваем из старого кэша ДО его удаления — иначе
    // activate стёр бы рабочий файл, и пользователь без сети увидел бы офлайн-заглушку вместо
    // приложения (чёрный экран при обновлении без сети). Оболочка, цитаты, манифест и иконки
    // переезжают под теми же ключами; каждый перенос проходит ту же валидацию маркером.
    for (const url of ASSETS) {
      if (await cache.match(url)) continue;
      for (const key of await caches.keys()) {
        if (key === CACHE_NAME) continue;
        const old = await caches.open(key);
        const saved = await old.match(url);
        if (saved && await isExpectedPayload(saved.url || url, saved)) {
          await cache.put(url, saved);
          break;
        }
      }
    }
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
  })());
  self.clients.claim();
});

// Activate a waiting worker only on the user's consent: index.html shows an "update available"
// dialog when this worker sits in "waiting", and posts this message when the user confirms.
// The guarded controllerchange listener in index.html then reloads the tab once.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const isPage = event.request.mode === 'navigate' ||
    (event.request.headers.get('accept') || '').includes('text/html');

  if (isPage) {
    // ОФЛАЙН-FIRST для «оболочки»: если она уже в кэше — отдаём мгновенно, чтобы заблокированная
    // или «белым списком» отфильтрованная сеть никогда не давала чёрный экран тем, кто хоть раз
    // загрузил приложение. Сеть используется только для фонового обновления кэша и НЕ задерживает
    // ответ; страница-заглушка оператора отсекается проверкой маркера и в кэш не попадает.
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      // Канонический ключ первым: запрос после применения обновления приходит с «?_sw=<ts>» и
      // под своим ключом в кэше не нашёлся бы. './' оставлен как второй вариант — ранние версии
      // воркера писали оболочку именно под ним.
      const cached = (await cache.match(navCacheKey(event.request))) ||
                     (await cache.match('./index.html')) ||
                     (await cache.match('./'));
      if (cached) {
        // Фоновое обновление (не задерживает ответ). Офлайн/блокировка — просто сохраняем кэш.
        // try/catch вокруг waitUntil: даже если браузер отклонит расширение жизни события,
        // respondWith обязан вернуть кэш, иначе возможен тот самый чёрный экран.
        const refresh = (async () => {
          try {
            const res = await fetchWithTimeout(event.request, 8000);
            await cacheIfAppShell(event.request, cache, res);
          } catch (e) { /* офлайн/блокировка — оставляем имеющийся кэш */ }
        })();
        try { event.waitUntil(refresh); } catch (e) { /* best effort */ }
        return cached;
      }
      // Кэша нет: живая сеть всегда в приоритете над офлайн-заглушкой. Заглушка — ТОЛЬКО когда
      // fetch реально упал (нет сети/таймаут «белого списка»). Раньше сетевой ответ отбрасывался,
      // если маркер не совпал или cache.put бросил исключение — и пользователь с РАБОТАЮЩИМ
      // интернетом видел «Нет соединения» (так ломался, в частности, первый запуск на новом
      // localhost-порту). Кэшируем КЛОН: cache.put потребляет тело оригинала, а клиенту нужен
      // нетронутый ответ. Провал маркера лишь означает «не кэшируем» (страница оператора отдаётся
      // один раз, как и без service worker), но НЕ «врём про отсутствие соединения».
      try {
        const res = await fetchWithTimeout(event.request, 8000);
        if (res && res.ok) {
          try { await cacheIfAppShell(event.request, cache, res.clone()); } catch (e) { /* не закэшировали — не беда */ }
          return res;
        }
        if (res) return res; // 404/500 — честный ответ сервера вместо ложной «нет соединения»
      } catch (e) { /* переходим к офлайн-заглушке ниже */ }
      // Ни кэша, ни сети — показываем понятную офлайн-страницу вместо чёрного экрана.
      return new Response(
        '<!doctype html><html lang="ru"><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<title>Нет соединения</title>' +
        '<body style="font-family:sans-serif;text-align:center;padding:48px;color:#333">' +
        '<h2>Нет соединения</h2><p>Откройте приложение ещё раз, когда интернет станет доступен.</p>' +
        '</body></html>',
        { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
      );
    })());
    return;
  }

  // Статика (иконки, манифест, цитаты) — cache-first с фоновым обновлением: офлайн-безопасно,
  // обновляется в фоне. Ресурсы меняются редко и в основном same-origin.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(event.request);
    const refresh = (async () => {
      try {
        const res = await fetchWithTimeout(event.request, 8000);
        // Та же валидация маркером: заглушка оператора не затрёт рабочий ассет в кэше.
        if (res && res.ok && await isExpectedPayload(event.request.url, res)) {
          await cache.put(event.request, res);
        }
      } catch (e) { /* офлайн — оставляем кэш */ }
    })();
    try { event.waitUntil(refresh); } catch (e) { /* best effort */ }
    return cached || fetch(event.request);
  })());
});
