/* ================================================================
   sw.js — WordQuest 서비스 워커 (설치형 + 오프라인 셸)
   ----------------------------------------------------------------
   · 내비게이션: 네트워크 우선 → 실패 시 캐시된 셸(오프라인에서도 앱 로드).
   · 앱 자산(동일 출처 + 정적 CDN): stale-while-revalidate
       → 캐시 즉시 응답 + 백그라운드 갱신(배포 후 1회 리로드로 최신화).
   · Firebase Auth/Firestore 등 동적 API는 개입하지 않음(실시간성 보존).
   · 버전 올리려면 VERSION 변경 → 구 캐시 자동 삭제.
   ================================================================ */
'use strict';

var VERSION = 'v60';
var CACHE = 'wq-' + VERSION;

// 오프라인 부팅에 필요한 최소 셸(전부 동일 출처).
var SHELL = [
  './',
  './index.html',
  './words.js',
  './pack-hs1.js',
  './pack-confuse.js',
  './pack-vacation.js',
  './cloud.js',
  './firebase-config.js',
  './manifest.webmanifest',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png'
];

// 캐시해도 안전한 정적 CDN(폰트/CSS/Firebase SDK). 나머지 교차 출처는 통과.
var CACHE_HOSTS = {
  'fonts.googleapis.com': 1,
  'fonts.gstatic.com': 1,
  'www.gstatic.com': 1,
  'cdn.jsdelivr.net': 1
};

self.addEventListener('install', function (e) {
  e.waitUntil((async function () {
    var c = await caches.open(CACHE);
    // 개별 add + allSettled: 파일 하나가 없어도 설치가 통째로 실패하지 않게.
    await Promise.allSettled(SHELL.map(function (u) { return c.add(u); }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', function (e) {
  e.waitUntil((async function () {
    var keys = await caches.keys();
    await Promise.all(keys.map(function (k) { return k === CACHE ? null : caches.delete(k); }));
    await self.clients.claim();
  })());
});

// 내비게이션: 네트워크 우선(온라인이면 항상 최신 HTML) → 오프라인 폴백.
async function handleNavigate(req) {
  try {
    var res = await fetch(req);
    var c = await caches.open(CACHE);
    c.put('./index.html', res.clone());
    return res;
  } catch (e) {
    return (await caches.match('./index.html')) || (await caches.match('./')) || Response.error();
  }
}

// 자산: stale-while-revalidate.
async function handleAsset(req) {
  var c = await caches.open(CACHE);
  var cached = await c.match(req);
  var network = fetch(req).then(function (res) {
    if (res && (res.ok || res.type === 'opaque')) c.put(req, res.clone());
    return res;
  }).catch(function () { return null; });
  return cached || (await network) || Response.error();
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;                 // 비-GET(Firestore write 등) 통과
  if (req.mode === 'navigate') { e.respondWith(handleNavigate(req)); return; }

  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  var sameOrigin = url.origin === self.location.origin;
  if (sameOrigin || CACHE_HOSTS[url.host]) { e.respondWith(handleAsset(req)); return; }
  // 그 외 교차 출처(파이어베이스 Auth/Firestore API 등)는 개입하지 않음 → 기본 네트워크.
});
