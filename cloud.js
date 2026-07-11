/* ================================================================
   cloud.js — WordQuest 클라우드 동기화 (Firebase Auth + Firestore)
   ----------------------------------------------------------------
   · 오프라인 우선: 설정/로그인이 없으면 아무 것도 안 하고 앱은 로컬 전용.
   · 빌드 도구 없음: Firebase는 gstatic ESM CDN에서 동적 import.
   · window.Cloud API를 노출하고, 메인 앱이 심은 window.WQ 훅으로 상태를 주고받음.

   메인 앱(index.html)이 제공해야 하는 훅 (window.WQ):
     getState()      → { words:[...], meta:{...} }   (라이브 참조)
     applyMerged(m)  → 병합 결과 { words:[...], meta:{...} } 를 로컬에 반영(+저장+재렌더)
     setSyncStatus(s)→ UI 상태 문자열 표시
     isBusy()        → 전투 중이면 true (전투 중 로컬 덮어쓰기 회피)
   ================================================================ */
(async function () {
  'use strict';

  var FBVER = 'https://www.gstatic.com/firebasejs/10.12.2';
  var NOOP = {
    enabled: false,
    signIn: function () { alert('클라우드 동기화가 아직 설정되지 않았어요. docs/firebase-setup.md 를 참고해 firebase-config.js 를 채워주세요.'); },
    signOutUser: function () {},
    syncNow: function () {},
    notifyChanged: function () {},
    wipeRemote: function () {},
    currentEmail: function () { return null; }
  };

  function ready() { try { document.dispatchEvent(new Event('cloud-ready')); } catch (e) {} }
  function WQ() { return window.WQ || {}; }
  function status(s) { try { (WQ().setSyncStatus || function () {})(s); } catch (e) {} }

  var cfg = window.FIREBASE_CONFIG;
  var configured = !!(cfg && cfg.apiKey && cfg.projectId);
  if (!configured) { window.Cloud = NOOP; ready(); return; }

  // ── Firebase SDK 동적 로드 (오프라인이면 실패 → 로컬 전용으로 폴백) ──
  var appMod, authMod, fsMod;
  try {
    var loaded = await Promise.all([
      import(FBVER + '/firebase-app.js'),
      import(FBVER + '/firebase-auth.js'),
      import(FBVER + '/firebase-firestore.js')
    ]);
    appMod = loaded[0]; authMod = loaded[1]; fsMod = loaded[2];
  } catch (e) {
    console.warn('[cloud] Firebase 로드 실패(오프라인?) — 이번 세션은 로컬 전용', e);
    window.Cloud = NOOP; status('오프라인'); ready(); return;
  }

  var app = appMod.initializeApp(cfg);
  var auth = authMod.getAuth(app);
  var db = fsMod.getFirestore(app);
  var docRef = function (uid) { return fsMod.doc(db, 'users', uid); };

  var user = null;
  var debounce = null;

  function now() { return Date.now(); }
  function hhmm() {
    var d = new Date();
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  // ── 병합: 단어별 updatedAt 최신 우선, meta도 updatedAt 최신 우선 ──
  function merge(local, remote) {
    var lWords = (local && local.words) || [];
    var rWords = (remote && remote.words) || {};
    var map = {};
    var i, w;
    for (i = 0; i < lWords.length; i++) { w = lWords[i]; if (w && w.id) map[w.id] = { a: w, au: (w.updatedAt || 0) }; }
    for (var id in rWords) {
      if (!Object.prototype.hasOwnProperty.call(rWords, id)) continue;
      var rw = rWords[id]; var ru = (rw && rw.updatedAt) || 0;
      if (!map[id] || ru > map[id].au) map[id] = { a: rw, au: ru };
    }
    var mergedMap = {}, mergedArr = [];
    for (var k in map) {
      if (!Object.prototype.hasOwnProperty.call(map, k)) continue;
      var it = map[k].a;
      mergedMap[k] = it;
      if (!it.deleted) mergedArr.push(it);
    }
    var lm = (local && local.meta) || {}, rm = (remote && remote.meta) || {};
    var mergedMeta = ((lm.updatedAt || 0) >= (rm.updatedAt || 0)) ? lm : rm;
    return { map: mergedMap, arr: mergedArr, meta: mergedMeta };
  }

  async function syncNow() {
    if (!user) return;
    try {
      status('동기화 중…');
      var local = (WQ().getState || function () { return { words: [], meta: {} }; })();
      var ref = docRef(user.uid);
      var snap = await fsMod.getDoc(ref);
      var remote = snap.exists() ? snap.data() : { words: {}, meta: {} };
      var m = merge(local, remote);
      // 전투 중이 아니면 로컬에 반영(재렌더). 전투 중이면 로컬은 건드리지 않고 원격에만 반영.
      var busy = false; try { busy = !!(WQ().isBusy && WQ().isBusy()); } catch (e) {}
      if (!busy && WQ().applyMerged) WQ().applyMerged({ words: m.arr, meta: m.meta });
      await fsMod.setDoc(ref, { schema: 1, words: m.map, meta: m.meta });
      status('동기화됨 · ' + hhmm());
    } catch (e) {
      console.warn('[cloud] 동기화 실패', e);
      status('동기화 보류(오프라인?)');
    }
  }

  function notifyChanged() {
    if (!user) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(function () { syncNow(); }, 3000);
  }

  async function signIn(email) {
    email = (email || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { alert('올바른 이메일을 입력해 주세요.'); return; }
    var settings = { url: location.origin + location.pathname, handleCodeInApp: true };
    try {
      await authMod.sendSignInLinkToEmail(auth, email, settings);
      try { localStorage.setItem('wq_emailForSignIn', email); } catch (e) {}
      status('메일 전송됨 · 받은 편지함의 링크를 눌러주세요');
      alert(email + ' 로 로그인 링크를 보냈어요.\n메일의 링크를 열면 로그인이 완료됩니다.');
    } catch (e) {
      console.warn('[cloud] 링크 전송 실패', e);
      alert('로그인 메일 전송에 실패했어요: ' + (e && e.message ? e.message : e));
    }
  }

  async function completeLinkSignIn() {
    try {
      if (!authMod.isSignInWithEmailLink(auth, location.href)) return;
      var email = null; try { email = localStorage.getItem('wq_emailForSignIn'); } catch (e) {}
      if (!email) email = window.prompt('로그인에 사용한 이메일을 다시 입력해 주세요');
      if (!email) return;
      await authMod.signInWithEmailLink(auth, email, location.href);
      try { localStorage.removeItem('wq_emailForSignIn'); } catch (e) {}
      // URL에서 로그인 파라미터 제거
      try { history.replaceState(null, '', location.origin + location.pathname); } catch (e) {}
    } catch (e) {
      console.warn('[cloud] 링크 로그인 실패', e);
      alert('로그인 링크 처리에 실패했어요: ' + (e && e.message ? e.message : e));
    }
  }

  function signOutUser() {
    authMod.signOut(auth).catch(function () {});
  }

  async function wipeRemote() {
    if (!user) return;
    try { await fsMod.setDoc(docRef(user.uid), { schema: 1, words: {}, meta: { updatedAt: now() } }); } catch (e) {}
  }

  // ── 인증 상태 변화 → 상태표시 + 최초 동기화 ──
  authMod.onAuthStateChanged(auth, function (u) {
    user = u || null;
    if (user) { status('로그인됨 · ' + (user.email || '')); syncNow(); }
    else { status('로그아웃'); }
  });

  window.Cloud = {
    enabled: true,
    signIn: signIn,
    signOutUser: signOutUser,
    syncNow: syncNow,
    notifyChanged: notifyChanged,
    wipeRemote: wipeRemote,
    currentEmail: function () { return user ? user.email : null; }
  };

  await completeLinkSignIn();
  ready();
})();
