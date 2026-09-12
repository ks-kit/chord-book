/* sw.js — オフラインで開けるようにする
   方針を2つに分ける。
     vendor/ とアイコン … 中身が変わらず大きい（OCRエンジンで約7MB）ので【キャッシュ優先】
     アプリ本体のファイル … 直した結果をすぐ反映したいので【ネット優先】
*/
const CACHE = 'chordbook-v3';

const CORE = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './chords.js',
  './parser.js',
  './ocr.js',
  './manifest.webmanifest'
];

/** 中身が変わらないもの（先に取りに行かず、キャッシュがあればそれを使う） */
function isImmutable(url) {
  return url.pathname.indexOf('/vendor/') !== -1 || /icon-\d+\.png$/.test(url.pathname);
}

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(CORE))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== location.origin) return;      // 外部への通信には触らない

  if (isImmutable(url)) {
    // キャッシュ優先。無ければ取ってきて貯める
    e.respondWith(
      caches.match(req).then(hit => {
        if (hit) return hit;
        return fetch(req).then(res => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
          }
          return res;
        });
      })
    );
    return;
  }

  // ネット優先。失敗したらキャッシュ、それも無ければトップページ
  e.respondWith(
    fetch(req)
      .then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
  );
});
