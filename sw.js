// Service Worker — ネットワーク優先キャッシュ v2
const CACHE_NAME = 'soap-recorder-v8';
const ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/recorder.js',
  '/recording-backup.js',
  '/manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  // 即座にアクティブ化
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // 古いキャッシュを全て削除
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // API呼び出しはキャッシュしない
  if (event.request.url.includes('googleapis.com') || 
      event.request.url.includes('script.google.com')) {
    return;
  }
  
  // ネットワーク優先 → 失敗時のみキャッシュ利用
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // 最新を取得できたらキャッシュも更新
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
