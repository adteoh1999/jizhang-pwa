// 每次发布都要同时改 js/version.js 的 APP_VERSION 与 sw.js 的 VERSION（测试会检查两者相同、资产清单完整）
const VERSION = 'v2.2-2026-11-21';
const CACHE = `jizhang-${VERSION}`;

const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/chart.js',
  './js/csv.js',
  './js/dates.js',
  './js/db.js',
  './js/model.js',
  './js/money.js',
  './js/stats.js',
  './js/store.js',
  './js/ui/categories-page.js',
  './js/ui/components.js',
  './js/ui/dialogs.js',
  './js/ui/dom.js',
  './js/ui/entry-sheet.js',
  './js/ui/home.js',
  './js/ui/icons.js',
  './js/ui/install-hint.js',
  './js/ui/motion.js',
  './js/ui/nav.js',
  './js/ui/settings.js',
  './js/ui/sheet.js',
  './js/ui/stats-view.js',
  './js/ui/tabbar.js',
  './js/ui/toast.js',
  './js/ui/trend-chart.js',
  './js/update.js',
  './js/uuid.js',
  './js/version.js',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) =>
    cache.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' })))));
  // 不自动 skipWaiting：由页面上的「更新」按钮触发
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith('jizhang-') && n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return; // 非同源完全不处理
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (req.mode === 'navigate') {
      return (await cache.match('./index.html')) || fetch(req);
    }
    return (await cache.match(req)) || fetch(req);
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
