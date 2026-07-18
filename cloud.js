/* ================================================================
   cloud.js — WordQuest 클라우드 (Firebase Auth + Firestore)
   ----------------------------------------------------------------
   · 오프라인 우선: 설정/로그인이 없으면 앱은 로컬 전용으로 동작.
   · 빌드 도구 없음: Firebase는 gstatic ESM CDN에서 동적 import.
   · window.Cloud API를 노출하고, 메인 앱의 window.WQ 훅으로 상태를 주고받음.

   [문서 구조 — schema 2]
     users/{uid}                → 가벼운 공개 정보(선생님이 읽는 부분)
        { schema, role, classId, className, profile{name,email,photo},
          summary{ lastActive, ... }, updatedAt }
     users/{uid}/private/state  → 무거운 학습 데이터(본인만)
        { schema, words{ id: word }, meta{...} }
     classes/{classId}          → 반(선생님 소유)
        { ownerUid, name, code, createdAt }

   메인 앱(index.html)이 제공하는 훅 (window.WQ):
     getState()      → { words:[...], meta:{...} }   (라이브 참조)
     applyMerged(m)  → 병합 결과 { words:[...], meta:{...} } 를 로컬 반영
     setSyncStatus(s)→ UI 상태 문자열 표시
     isBusy()        → 전투 중이면 true (전투 중 로컬 덮어쓰기 회피)
   ================================================================ */
(async function () {
  'use strict';

  var FBVER = 'https://www.gstatic.com/firebasejs/10.12.2';
  var NOOP = {
    enabled: false,
    signInGoogle: function () { alert('클라우드 로그인이 아직 설정되지 않았어요. docs/firebase-setup.md 를 참고해 firebase-config.js 를 채워주세요.'); },
    signOutUser: function () {},
    syncNow: function () {},
    notifyChanged: function () {},
    wipeRemote: function () {},
    currentEmail: function () { return null; },
    currentUser: function () { return null; },
    getIdToken: function () { return Promise.resolve(null); },
    quizStart: function () { return Promise.resolve(null); },
    quizSubmit: function () { return Promise.resolve(null); },
    getProfile: function () { return null; },
    chooseRole: function () {},
    joinClassByCode: function () { return Promise.resolve({ ok: false }); },
    setDisplayName: function () { return Promise.resolve({ ok: false }); },
    createClass: function () { return Promise.resolve({ ok: false }); },
    deleteClass: function () { return Promise.resolve({ ok: false }); },
    removeStudent: function () { return Promise.resolve({ ok: false }); },
    unremoveStudent: function () { return Promise.resolve({ ok: false }); },
    listMyClasses: function () { return Promise.resolve([]); },
    listStudents: function () { return Promise.resolve([]); },
    setClassPack: function () { return Promise.resolve({ ok: false }); },
    getClassPack: function () { return Promise.resolve(null); },
    isMaster: function () { return false; },
    listTeachers: function () { return Promise.resolve([]); },
    addTeacher: function () { return Promise.resolve({ ok: false }); },
    removeTeacher: function () { return Promise.resolve({ ok: false }); },
    onChange: function () {}
  };

  function ready() { try { document.dispatchEvent(new Event('cloud-ready')); } catch (e) {} }
  function accountChanged() { try { document.dispatchEvent(new Event('cloud-account')); } catch (e) {} }
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
  // ── App Check (선택·심층방어) — 사이트키 있을 때만 초기화. ★import 를 '격리'한다:
  //   기본 Auth/Firestore 로드(Promise.all)에 섞으면 이 모듈만 실패해도 전체가 깨져 로컬 전용으로
  //   빠질 수 있다(사이트키 미설정 시 회귀). 그래서 사이트키 있을 때만 별도 try 로 로드한다.
  var acMod = null, appCheck = null;
  var acSiteKey = String((cfg.appCheckSiteKey || (typeof window !== 'undefined' && window.APPCHECK_SITE_KEY) || '')).trim();
  if (acSiteKey) {
    try {
      if (typeof window !== 'undefined' && window.APPCHECK_DEBUG_TOKEN) self.FIREBASE_APPCHECK_DEBUG_TOKEN = window.APPCHECK_DEBUG_TOKEN;
      acMod = await import(FBVER + '/firebase-app-check.js');
      appCheck = acMod.initializeAppCheck(app, { provider: new acMod.ReCaptchaV3Provider(acSiteKey), isTokenAutoRefreshEnabled: true });
    } catch (e) { console.warn('[cloud] App Check init 실패(무시 — 미강제면 무해)', e); acMod = null; appCheck = null; }
  }
  var auth = authMod.getAuth(app);
  // Firestore 초기화 — 앱 역사 내내 검증된 기본값(getFirestore).
  //   ★ 이 줄은 함부로 바꾸지 말 것: v94(persistentLocalCache)·v98(experimentalAutoDetectLongPolling)
  //     로 바꿨다가 각각 인앱/크롬 동기화를 깨뜨려 되돌렸다. 초기화 옵션 변경은 반드시 실기기
  //     (크롬·사파리·카톡 인앱 전부)에서 검증한 뒤에만.
  var db = fsMod.getFirestore(app);

  // ── 문서 참조 헬퍼 ──
  var userRef = function (uid) { return fsMod.doc(db, 'users', uid); };
  var stateRef = function (uid) { return fsMod.doc(db, 'users', uid, 'private', 'state'); };
  var classRef = function (cid) { return fsMod.doc(db, 'classes', cid); };
  var classesCol = function () { return fsMod.collection(db, 'classes'); };
  var codeRef = function (code) { return fsMod.doc(db, 'classCodes', code); }; // 코드→반 매핑(코드 유일성·비열거)
  var packRef = function (cid) { return fsMod.doc(db, 'classPacks', cid); };   // 반 배포 단어(선생님→반 학생 전원)
  var teacherAllowRef = function (email) { return fsMod.doc(db, 'teacherAllow', email); }; // 선생님 허용목록(문서 ID = 이메일)
  var teacherAllowCol = function () { return fsMod.collection(db, 'teacherAllow'); };

  // ── 마스터(운영자): 모든 반·학생 열람 권한. ★서버 강제는 firestore.rules 의 isMaster() 로.
  //   여기 이메일과 firestore.rules 의 이메일을 반드시 동일하게 유지할 것.
  var MASTER_EMAIL = 'ranha.park@gmail.com';
  function isMaster() { return !!(user && user.email && user.email.toLowerCase() === MASTER_EMAIL); }

  var user = null;      // Firebase 인증 사용자
  var profile = null;   // users/{uid} 문서(역할/반/프로필)
  var debounce = null;

  function now() { return Date.now(); }
  function hhmm() {
    var d = new Date();
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  // ★날짜 키 KST 고정(index.html today()/워커 kstToday 와 동일 계산) — 기기 시간대 skew 제거.
  //   KST 기기(한국 학생 대다수)는 로컬=KST 라 문자열 동일 → 회귀 0. 비-KST 기기만 서버와 정렬됨.
  function todayStr() {
    var d = new Date(Date.now() + 9 * 3600 * 1000);
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
  }
  function addDaysStr(ds, n) {
    var p = ds.split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
  }
  // 이번 주(월요일~오늘) 날짜들 — 반 랭킹의 '이번 주' 기준(읽는 시점에 다시 계산해 오래된 점수 자동 제외)
  function weekDates(t) {
    var p = t.split('-').map(Number);
    var sinceMon = (new Date(p[0], p[1] - 1, p[2]).getDay() + 6) % 7; // 월=0 … 일=6
    var out = [];
    for (var i = 0; i <= sinceMon; i++) out.push(addDaysStr(t, -i));
    return out;
  }
  // 숫자만 통과시키는 타입 가드(값의 상한은 걸지 않는다 — 열심히 한 학생의 큰 값도 그대로).
  //   문자열/NaN/음수 주입만 0으로 무력화해 정렬 오염(치팅 부작용)을 막는다.
  function numOr0(x) { return (typeof x === 'number' && isFinite(x) && x > 0) ? x : 0; }
  // 일자별 단어수 맵(days)에서 '이번 주' 합을 낸다. days 없으면 0.
  function weekSum(days, t) {
    if (!days) return 0;
    var wd = weekDates(t), s = 0;
    for (var i = 0; i < wd.length; i++) s += numOr0(days[wd[i]]);
    return s;
  }
  // 폴백(워커 OFF) 랭킹의 '읽기 시점 연속 감쇠': 저장된 days(최근 8일)에 오늘/어제 활동이 없으면
  //   그 연속은 이미 끊긴 것 → 0 으로 본다. 대시보드가 view 시점에 감쇠하는 것과 같은 철학이라
  //   폴백 랭킹의 낡은 연속 잔존(대시보드=0인데 랭킹만 🔥) 불일치를 없앤다. days 없는 옛 항목은 판정
  //   불가라 저장값 유지(근사). ★ leaderboards 쓰기는 firestore.rules 로 잠겨(2026-07-16) 이 폴백
  //   경로의 항목은 갱신되지 않는 '동결 레거시'다 → 읽기 감쇠가 이 경로의 유일한 정합 수단(영구 동작).
  function streakAliveByDays(days, t) {
    if (!days) return false;
    return !!(numOr0(days[t]) || numOr0(days[addDaysStr(t, -1)]));
  }

  // ── 서버 집계 랭킹(치팅 근본 차단) 도우미 ──
  //   window.RANK_ENDPOINT(랭킹 워커) 가 설정되면 점수를 클라가 못 쓰고 워커가 센다:
  //   클라는 '이번 주 완료 단어 id'만 보고 → 워커가 그 반 배포단어와 대조해 카운트(천장=배정 단어수).
  //   비어 있으면 아래 Firestore 경로로 폴백 → 워커 배포 전에도 앱은 그대로 동작한다.
  function rankEndpoint() { try { return (typeof window !== 'undefined' && (window.RANK_ENDPOINT || '')).trim().replace(/\/+$/, ''); } catch (e) { return ''; } }
  function weekMonday(t) { var wd = weekDates(t); return wd[wd.length - 1]; } // 이번 주 월요일(주 식별자)
  function collectWeekIds(meta, t) {
    var by = (meta && meta.doneByDay) || {}, wd = weekDates(t), seen = {}, out = [];
    for (var i = 0; i < wd.length; i++) {
      var a = by[wd[i]];
      if (a && a.length) for (var j = 0; j < a.length; j++) { var id = String(a[j]).toLowerCase(); if (!seen[id]) { seen[id] = 1; out.push(id); } }
    }
    return out.slice(0, 2000);
  }
  // 마지막 /sync 서버 응답(내 점수·연속·저장지연 여부) — 보드 조회가 실패해도 '내 점수'는 보여줄 수 있게 보관.
  var lastRank = null; // { wk, streak, degraded, at }
  function rankStatus() { return lastRank; }
  async function rankSync(meta, t, name) {
    var ep = rankEndpoint(); if (!ep || !user) return false;
    try {
      var tok = await user.getIdToken(); if (!tok) return false;
      var todayIds = (meta && meta.doneByDay && meta.doneByDay[t]) || [];
      var r = await fetch(ep + '/sync', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok },
        // streak 은 워커가 '오늘 실제 배포단어 완료' 관측으로 산정 → 클라는 보내지 않는다(위조 차단).
        body: JSON.stringify({ week: weekMonday(t), today: t, ids: collectWeekIds(meta, t), todayIds: todayIds.slice(0, 2000), name: name })
      });
      var d = null; try { d = await r.json(); } catch (e2) { /* 구버전 워커·비JSON — 무시 */ }
      // degraded=true: 워커가 KV 쓰기 한도(무료 1,000회/일) 등으로 보드 기록을 못 남겼다는 뜻.
      //   점수 계산 자체는 서버가 했으므로(wk) 내 점수 표시용으로 보관한다.
      if (r.ok && d && typeof d.wk === 'number') lastRank = { wk: d.wk | 0, streak: d.streak | 0, degraded: !!d.degraded, at: Date.now() };
      return r.ok;
    } catch (e) { return false; }
  }
  async function rankBoard(scope, t) {
    var ep = rankEndpoint(); if (!ep || !user) return null;
    try {
      var tok = await user.getIdToken(); if (!tok) return null;
      var r = await fetch(ep + '/board?scope=' + scope + '&week=' + encodeURIComponent(weekMonday(t)), { headers: { 'Authorization': 'Bearer ' + tok } });
      if (!r.ok) return null;
      var d = await r.json(), list = (d && d.list) || [];
      return list.map(function (e) { return { uid: e.uid, name: e.name || '익명', wk: e.wk | 0, streak: e.streak | 0, me: !!e.me }; });
    } catch (e) { return null; }
  }
  // 선생님 대시보드용 '서버 검증' 지표: 워커 /teacher 가 서버 시계로 관측한 학생별
  //   연속일수·학습일수·출석맵(uid→{streak,studyDays,days})을 준다. 학생이 콘솔로 못 바꾼다.
  //   워커 미배포/구버전(404)·권한없음(403)·오프라인이면 null → 대시보드가 자기보고 값으로 폴백.
  async function teacherBoard(classId) {
    var ep = rankEndpoint(); if (!ep || !user || !classId) return null;
    try {
      var tok = await user.getIdToken(); if (!tok) return null;
      var r = await fetch(ep + '/teacher?class=' + encodeURIComponent(classId), { headers: { 'Authorization': 'Bearer ' + tok } });
      if (!r.ok) return null;
      var d = await r.json(), list = (d && d.list) || [], byUid = {};
      for (var i = 0; i < list.length; i++) {
        var e = list[i]; if (!e || !e.uid) continue;
        byUid[e.uid] = { streak: e.streak | 0, studyDays: e.studyDays | 0, days: (e.days && typeof e.days === 'object') ? e.days : {}, weekWords: (typeof e.weekWords === 'number' ? e.weekWords : null) };
      }
      // dailyCap/weekCap: 워커가 내려준 서버 원장 상한 파라미터(대시보드 랭킹이 리더보드와 같은 산식으로
      //   자기보고 weekWords 를 att 로 상한하는 데 씀). 구버전 워커면 없음 → 기본값(워커 기본과 일치)으로 폴백.
      return { byUid: byUid, today: (d && d.today) || null,
               dailyCap: (d && +d.dailyCap) || 60, weekCap: (d && +d.weekCap) || 300 };
    } catch (e) { return null; }
  }

  // ── 서버 세션 채점(r13): 현재 App Check 토큰(없으면 null). ──
  async function getAppCheckToken() {
    if (!acMod || !appCheck) return null;
    try { var r = await acMod.getToken(appCheck, false); return (r && r.token) || null; } catch (e) { return null; }
  }
  // 이번 판 단어 id 를 서버에 알려 서명 세션(sid) 받기. 실패/미지원(404)/오프라인/미로그인 → null(로컬 폴백).
  async function quizStart(ids) {
    var ep = rankEndpoint(); if (!ep || !user || !Array.isArray(ids) || !ids.length) return null;
    try {
      var tok = await user.getIdToken(); if (!tok) return null;
      var h = { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' };
      var ac = await getAppCheckToken(); if (ac) h['X-Firebase-AppCheck'] = ac;
      var r = await fetch(ep + '/quiz/start', { method: 'POST', headers: h, body: JSON.stringify({ ids: ids.slice(0, 40) }) });
      if (!r.ok) return null;                      // 404(구버전 워커)·403(appcheck)·429 등 → 로컬 폴백
      var d = await r.json();
      return (d && d.sid) ? d : null;
    } catch (e) { return null; }
  }
  // 세션에 정답 배치 제출. 성공 시 서버가 정답 대조·원장 적립 후 점수 반환. 실패 → null(무해·로컬 진도 유지).
  async function quizSubmit(sid, ans) {
    var ep = rankEndpoint(); if (!ep || !user || !sid || !Array.isArray(ans) || !ans.length) return null;
    try {
      var tok = await user.getIdToken(); if (!tok) return null;
      var h = { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' };
      var ac = await getAppCheckToken(); if (ac) h['X-Firebase-AppCheck'] = ac;
      var r = await fetch(ep + '/quiz/submit', { method: 'POST', headers: h, body: JSON.stringify({ sid: sid, ans: ans.slice(0, 100) }) });
      if (!r.ok) return null;
      return await r.json();
    } catch (e) { return null; }
  }

  // ── 병합: 단어별 updatedAt 최신 우선, meta는 스칼라 LWW + dailyHistory 날짜별 병합 ──
  function merge(local, remote) {
    var lWords = (local && local.words) || [];
    var rWords = (remote && remote.words) || {};
    // 원격에 실제 단어가 있으면, 아직 동기화된 적 없는 로컬 샘플 단어(sample:true)는 버린다.
    // (새 기기에서 로그인 시 첫 방문 샘플 20개가 실제 계정에 주입되는 오염 방지)
    var remoteHasWords = false;
    for (var rk in rWords) { if (Object.prototype.hasOwnProperty.call(rWords, rk)) { remoteHasWords = true; break; } }
    var map = {};
    var i, w;
    for (i = 0; i < lWords.length; i++) {
      w = lWords[i]; if (!w || !w.id) continue;
      if (w.sample && remoteHasWords && !rWords[w.id]) continue; // 떠도는 샘플 제거
      map[w.id] = { a: w, au: (w.updatedAt || 0) };
    }
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
    // meta: 스칼라(streak/exp 등)는 updatedAt 최신 우선. dailyHistory는 날짜별로 합쳐(기기 간 손실 방지)
    var lm = (local && local.meta) || {}, rm = (remote && remote.meta) || {};
    var base = ((lm.updatedAt || 0) >= (rm.updatedAt || 0)) ? lm : rm;
    var mergedMeta = {};
    for (var mk in rm) if (Object.prototype.hasOwnProperty.call(rm, mk)) mergedMeta[mk] = rm[mk];
    for (var mk2 in base) if (Object.prototype.hasOwnProperty.call(base, mk2)) mergedMeta[mk2] = base[mk2];
    var dh = {};
    var ldh = lm.dailyHistory || {}, rdh = rm.dailyHistory || {};
    for (var d1 in rdh) if (Object.prototype.hasOwnProperty.call(rdh, d1)) dh[d1] = rdh[d1];
    for (var d2 in ldh) {
      if (!Object.prototype.hasOwnProperty.call(ldh, d2)) continue;
      // 같은 날짜는 시도수(a)가 더 많은 쪽 채택
      if (!dh[d2] || ((ldh[d2] && ldh[d2].a) || 0) >= ((dh[d2] && dh[d2].a) || 0)) dh[d2] = ldh[d2];
    }
    if (Object.keys(dh).length) mergedMeta.dailyHistory = dh;
    // doneByDay(날짜별 완료 단어 id 목록): 랭킹 집계('이번 주 완료 단어수')의 원천이라 절대 유실되면
    //   안 된다 → dailyHistory 처럼 '날짜별 union'으로 합친다. LWW로 덮으면 다른 세션/기기의 오래된
    //   값(이번 주 비어있는)에 밀려 로컬의 이번 주 완료가 0으로 사라질 수 있다(랭킹 미등재의 원인).
    var dbd = {};
    var ldbd = lm.doneByDay || {}, rdbd = rm.doneByDay || {};
    for (var dd1 in rdbd) if (Object.prototype.hasOwnProperty.call(rdbd, dd1) && Array.isArray(rdbd[dd1])) dbd[dd1] = rdbd[dd1].slice();
    for (var dd2 in ldbd) {
      if (!Object.prototype.hasOwnProperty.call(ldbd, dd2) || !Array.isArray(ldbd[dd2])) continue;
      var uni = {}, list = (dbd[dd2] || []).concat(ldbd[dd2]), o = [];
      for (var ui = 0; ui < list.length; ui++) { var iv = String(list[ui]).toLowerCase(); if (!uni[iv]) { uni[iv] = 1; o.push(list[ui]); } }
      dbd[dd2] = o.slice(0, 2000);
    }
    if (Object.keys(dbd).length) mergedMeta.doneByDay = dbd;
    // 최고기록성 값은 LWW가 아니라 max로 보존(다른 기기에서 사소한 저장에 덮이지 않게)
    mergedMeta.bestCombo = Math.max((lm.bestCombo || 0), (rm.bestCombo || 0));
    mergedMeta.exp = Math.max((lm.exp || 0), (rm.exp || 0));
    // streak/lastDay는 더 최근에 학습한(lastDay가 큰) 쪽을 채택
    var lDay = lm.lastDay || '', rDay = rm.lastDay || '';
    if (rDay > lDay) { mergedMeta.streak = rm.streak || 0; mergedMeta.lastDay = rm.lastDay || null; }
    else if (lDay) { mergedMeta.streak = lm.streak || 0; mergedMeta.lastDay = lm.lastDay || null; }
    return { map: mergedMap, arr: mergedArr, meta: mergedMeta };
  }

  // ── 동기화 성공/실패 시각(홈 '저장 안 됨' 경고 판정용) ──
  //   lastSyncOkAt: 마지막으로 학습데이터가 서버에 저장된 시각. lastSyncFailAt: 마지막 실패 시각.
  //   failing = fail > ok → '지금 서버 저장이 안 되고 있음'. 앱은 이 값으로 홈에 경고를 띄운다
  //   (오늘 학습이 로컬에만 남고 클라우드에 안 올라가는 상태를 학생이 알 수 있게).
  var lastSyncOkAt = 0, lastSyncFailAt = 0;
  // 일부 인앱 브라우저는 Firestore 요청이 reject 도 resolve 도 안 하고 '매달려(hang)' 있다 →
  //   그러면 catch 를 못 타서 실패로 감지되지 않고 오늘 학습이 조용히 로컬에만 갇힌다.
  //   네트워크 await 에 타임아웃을 걸어 hang 을 '실패'로 전환한다(→ lastSyncFailAt 세팅 → 홈 경고 표시).
  //   25초는 정상 Firestore 왕복(<5초)보다 넉넉해 느린-정상 sync 를 잘못 실패 처리하지 않는다.
  var SYNC_TIMEOUT_MS = 25000;
  function withTimeout(p, label) {
    return new Promise(function (resolve, reject) {
      var to = setTimeout(function () { reject(new Error('sync_timeout:' + (label || '') + ':' + SYNC_TIMEOUT_MS + 'ms')); }, SYNC_TIMEOUT_MS);
      Promise.resolve(p).then(function (v) { clearTimeout(to); resolve(v); }, function (e) { clearTimeout(to); reject(e); });
    });
  }

  // ── 학습 데이터 동기화(private/state) + 상단 요약 갱신 ──
  async function syncNow() {
    if (!user) return;
    try {
      status('동기화 중…');
      var local = (WQ().getState || function () { return { words: [], meta: {} }; })();
      var sRef = stateRef(user.uid);
      var snap = await withTimeout(fsMod.getDoc(sRef), 'read');
      var remote;
      if (snap.exists()) {
        remote = snap.data();
      } else {
        // 레거시(schema 1): users/{uid} 최상위에 words/meta 가 있던 시절 → 1회 이관
        var legacy = await withTimeout(fsMod.getDoc(userRef(user.uid)), 'read-legacy');
        var ld = legacy.exists() ? legacy.data() : null;
        remote = (ld && ld.words) ? { words: ld.words, meta: ld.meta || {} } : { words: {}, meta: {} };
      }
      var m = merge(local, remote);
      // 안전장치: 병합 결과가 '비었는데' 원격엔 단어가 있으면 원격을 덮어쓰지 않는다(빈 상태 업로드로 인한 진도 소실 방지).
      //   (권한오류로 읽기가 실패하면 위 getDoc 에서 throw → catch 로 빠지므로 애초에 쓰기까지 안 온다. 여기선 예외적 빈 병합 방어.)
      var mCount = m.map ? Object.keys(m.map).length : 0;
      var rCount = (remote && remote.words) ? Object.keys(remote.words).length : 0;
      if (mCount === 0 && rCount > 0) { status('동기화 보류(빈 병합 안전장치)'); return; }
      var busy = false; try { busy = !!(WQ().isBusy && WQ().isBusy()); } catch (e) {}
      if (!busy && WQ().applyMerged) WQ().applyMerged({ words: m.arr, meta: m.meta });
      // ① 선생님 대시보드용 요약(작음)을 '먼저' 확정한다.
      //    ~120KB짜리 private/state 쓰기 '뒤'에 두면, 그 사이 앱이 닫히거나 백그라운드로 가면
      //    요약 write 가 유실돼 DB(doneByDay)엔 기록이 있는데 대시보드는 '오늘 학습 없음'으로
      //    보이던 문제(표시 불일치)가 난다. 작아서 빨리 끝나는 요약을 앞에 둬 표시 원천부터 살린다.
      await withTimeout(writeSummaryDoc(m.arr, m.meta), 'summary');
      // ② 무거운 학습데이터(private/state) — doneByDay(랭킹 원천) 포함.
      await withTimeout(fsMod.setDoc(sRef, { schema: 2, words: m.map, meta: m.meta, updatedAt: now() }), 'state');
      // ★ 오늘치가 서버에 저장 완료된 시점 = '저장 안 됨' 경고 해제 신호. 랭킹 집계(③)보다 '앞'에 둔다:
      //    데이터는 이미 저장됐으므로 랭킹 워커 호출이 느리거나 실패해도 경고를 띄우면 안 된다(오탐 방지).
      lastSyncOkAt = now();
      // ③ 랭킹 집계 — 워커가 '방금 저장된' private/state.doneByDay 를 서버에서 직접 읽어 세므로
      //    ② 뒤에 호출해야 이번 학습분이 점수에 반영된다. 실패해도 '데이터 저장'과는 무관하므로
      //    자체 try/catch 로 삼켜 lastSyncFailAt(=저장 실패)을 세우지 않는다(경고 오탐 방지).
      try { await withTimeout(rankSyncNow(m.meta), 'rank'); } catch (eRank) { console.warn('[cloud] 랭킹 동기화 지연/실패(학습데이터는 저장됨)', eRank); }
      status('동기화됨 · ' + hhmm());
    } catch (e) {
      lastSyncFailAt = now();               // 저장 실패(hang 타임아웃 포함) — 홈 경고가 뜰 신호(조용한 유실 방지)
      console.warn('[cloud] 동기화 실패', e);
      status('동기화 보류(오프라인?)');
    }
  }

  // ── users/{uid} 최상위 문서에 프로필/요약 기록(레거시 words 제거) ──
  //    선생님 대시보드가 읽는 유일한 원천(summary.daily). syncNow 에서 무거운 쓰기보다 '먼저' 호출된다.
  //    (예전엔 랭킹 집계까지 한 함수였는데, 랭킹은 ②private/state 저장 '뒤'여야 해서 rankSyncNow 로 분리)
  async function writeSummaryDoc(arr, meta) {
    if (!user) return;
    var cap = 0, attempts = 0, wrong = 0, i, wd;
    arr = arr || [];
    for (i = 0; i < arr.length; i++) {
      wd = arr[i]; if (!wd) continue;
      if (wd.cap) cap++;
      attempts += (wd.seen || 0);
      wrong += (wd.wrong || 0);
    }
    var correct = Math.max(0, attempts - wrong);
    var accuracy = attempts ? Math.round(correct / attempts * 100) : 0;
    // 최근 35일 학습 히트맵(요약용, 크기 제한)
    var dh = (meta && meta.dailyHistory) || {};
    var daily = {}, t = todayStr();
    for (i = 0; i < 35; i++) { var ds = addDaysStr(t, -i); if (dh[ds]) daily[ds] = dh[ds]; }
    var todayE = dh[t] || null;
    // ── 이번 주(월~오늘) 완료 '유효' 단어 유니크 수 ──────────────────────────────────
    //   선생님 대시보드의 '이번 주 반 랭킹'이 인게임 랭킹(서버 워커 countWeekDone)과 '같은 원천
    //   (meta.doneByDay)·같은 의미(주간 유니크)'로 뜨게 하려고 여기서 미리 계산해 요약에 싣는다.
    //   기존 대시보드는 att/summary.daily 의 '날짜별 합'을 써서, KV 절약 스로틀로 undercount 된
    //   att 가 정확한 자기보고를 덮어 랭킹보다 작게 뜨던 불일치가 있었다(예: 대시보드 9 vs 랭킹 20).
    //   ★ 이 값은 학생이 자기 문서에 쓰는 '자기보고'다(정답률·포획과 동일 신뢰수준 — 서버 검증 아님).
    //     현재 단어목록(arr)에 실재하는 id 만 세어(collectWeekIds 의 주간 유니크와 결합) 정직한 학생은
    //     워커 집계와 정확히 일치하고, 흘러든 비단어 id 는 제외한다(위조 방지가 아니라 표시 일관성 목적).
    var validIds = {};
    for (i = 0; i < arr.length; i++) { if (arr[i] && arr[i].id) validIds[String(arr[i].id).toLowerCase()] = 1; }
    var weekIds = collectWeekIds(meta, t), weekWords = 0;
    for (i = 0; i < weekIds.length; i++) { if (validIds[weekIds[i]]) weekWords++; }
    var top = {
      schema: 2,
      profile: {
        name: user.displayName || '',
        email: user.email || '',
        photo: user.photoURL || ''
      },
      summary: {
        lastActive: now(),
        streak: (meta && meta.streak) || 0,
        lastDay: (meta && meta.lastDay) || null,
        total: arr.length,
        captured: cap,
        attempts: attempts,
        accuracy: accuracy,
        studiedToday: !!todayE,
        todayCount: todayE ? (todayE.a || 0) : 0,
        daily: daily,
        // 이번 주 완료 단어(유니크) + 그 값이 계산된 '이번 주 월요일'. 대시보드가 weekOf 로
        //   '이번 주에 계산된 값'만 신뢰해 인게임 랭킹과 같은 수를 보여준다(주 경계 stale 방지).
        weekWords: weekWords,
        weekOf: weekMonday(t)
      },
      updatedAt: now()
    };
    try {
      await fsMod.setDoc(userRef(user.uid), top, { merge: true });
      // 레거시 words/meta 필드가 최상위에 남아 있으면 제거
      try {
        await fsMod.updateDoc(userRef(user.uid), {
          words: fsMod.deleteField(), meta: fsMod.deleteField()
        });
      } catch (e2) { /* 필드 없으면 무시 */ }
    } catch (e) { console.warn('[cloud] 요약 기록 실패', e); }
  }

  // ── 주간 랭킹 집계(반·전체 공통) — syncNow ②(private/state 저장) '뒤'에 호출할 것 ──
  //    워커가 서버에 저장된 meta.doneByDay 를 직접 읽어 세므로, 저장 전에 부르면 이번 학습분이 빠진다.
  async function rankSyncNow(meta) {
    if (!user) return;
    var dh = (meta && meta.dailyHistory) || {};
    var t = todayStr();
    // 최근 8일 일자별 완료 단어수(days) + 연속 — 폴백(Firestore 랭킹) 저장용.
    //    days 를 저장해두면 조회 시 '이번 주(월~오늘)' 합을 다시 계산할 수 있다(지난주 점수는 새 주가 되면 자동 제외).
    var rkDays = {};
    for (var wi = 0; wi < 8; wi++) {
      var dk = addDaysStr(t, -wi), de = dh[dk];
      if (de) { var dv = (de.w != null ? de.w : de.ok) || 0; if (dv) rkDays[dk] = dv; }
    }
    var rkStreak = (meta && meta.lastDay && (meta.lastDay === t || meta.lastDay === addDaysStr(t, -1))) ? (meta.streak || 0) : 0;
    var rkName = ((profile && (profile.displayName || profile.name)) || user.displayName || '익명').slice(0, 40);
    if (rankEndpoint()) {
      // 서버 집계(워커): 워커가 doneByDay 를 읽어 점수·연속일수를 산정 → 콘솔 위조 불가.
      await rankSync(meta, t, rkName);
    } else {
      // 폴백(워커 미설정): 기존 Firestore 경로. days 로 조회 시 '이번 주' 합 재계산.
      try {
        if (profile && profile.role === 'student' && profile.classId) {
          await fsMod.setDoc(fsMod.doc(db, 'leaderboards', profile.classId, 'entries', user.uid),
            { name: rkName, wk: weekSum(rkDays, t), streak: rkStreak, days: rkDays, at: now() });
        }
      } catch (eL) { /* 규칙 미배포·오프라인 등 조용히 */ }
      try {
        await fsMod.setDoc(fsMod.doc(db, 'leaderboards', '_global', 'entries', user.uid),
          { name: rkName, wk: weekSum(rkDays, t), streak: rkStreak, days: rkDays, at: now() });
      } catch (eG) { /* 규칙 미배포·오프라인 등 조용히 */ }
    }
  }

  function notifyChanged() {
    if (!user) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(function () { syncNow(); }, 3000);
  }

  // ── Google 로그인 (팝업 → 실패 시 리디렉트 폴백) ──
  async function signInGoogle() {
    var provider = new authMod.GoogleAuthProvider();
    // 항상 계정 선택 화면을 띄운다 — 기기에 여러 구글 계정이 있어도 원하는 계정으로 로그인할 수 있게.
    // (이 파라미터가 없으면 마지막/단일 세션으로 자동 로그인돼 계정을 못 고른다)
    provider.setCustomParameters({ prompt: 'select_account' });
    try {
      await authMod.signInWithPopup(auth, provider);
    } catch (e) {
      // 팝업 차단/취소 등 → 리디렉트로 재시도
      if (e && (e.code === 'auth/popup-blocked' || e.code === 'auth/cancelled-popup-request' || e.code === 'auth/operation-not-supported-in-this-environment')) {
        try { await authMod.signInWithRedirect(auth, provider); return; } catch (e2) { e = e2; }
      }
      if (e && e.code === 'auth/popup-closed-by-user') return; // 사용자가 닫음 — 조용히
      console.warn('[cloud] Google 로그인 실패', e);
      alert('구글 로그인에 실패했어요: ' + (e && e.message ? e.message : e));
    }
  }

  function signOutUser() {
    authMod.signOut(auth).catch(function () {});
  }

  async function wipeRemote() {
    if (!user) return;
    try { await fsMod.setDoc(stateRef(user.uid), { schema: 2, words: {}, meta: { updatedAt: now() }, updatedAt: now() }); } catch (e) {}
  }

  // ── 프로필 로드(users/{uid}) ──
  async function loadProfile() {
    if (!user) { profile = null; return; }
    try {
      var snap = await fsMod.getDoc(userRef(user.uid));
      var d = snap.exists() ? snap.data() : {};
      profile = {
        role: d.role || null,
        classId: d.classId || null,
        className: d.className || null,
        displayName: d.displayName || '',               // 사용자가 입력한 표시 이름(대시보드용)
        name: user.displayName || (d.profile && d.profile.name) || '', // 구글 계정 이름
        email: user.email || (d.profile && d.profile.email) || ''
      };
    } catch (e) {
      console.warn('[cloud] 프로필 로드 실패', e);
      profile = { role: null, classId: null, className: null, displayName: '', name: user.displayName || '', email: user.email || '' };
    }
  }

  // ── 표시 이름 설정(학생이 입력한 실명 등) ──
  async function setDisplayName(name) {
    if (!user) return { ok: false };
    name = (name || '').trim().slice(0, 20);
    if (!name) return { ok: false, msg: '이름을 입력해 주세요.' };
    try {
      await fsMod.setDoc(userRef(user.uid), { schema: 2, displayName: name, updatedAt: now() }, { merge: true });
      if (profile) profile.displayName = name;
      accountChanged();
      return { ok: true, name: name };
    } catch (e) {
      console.warn('[cloud] 이름 저장 실패', e);
      return { ok: false, msg: (e && e.message ? e.message : '이름 저장에 실패했어요.') };
    }
  }

  // ── 역할 선택(학생/선생님) — 1회 ──
  //   선생님 전환은 서버(firestore.rules)의 허용목록(teacherAllow)이 판정한다.
  //   목록에 없는 계정이 role='teacher' 를 쓰면 permission-denied → 친절 안내 반환.
  async function chooseRole(role) {
    if (!user) return { ok: false, msg: '로그인이 필요해요.' };
    if (role !== 'student' && role !== 'teacher') return { ok: false };
    try {
      await fsMod.setDoc(userRef(user.uid), {
        schema: 2, role: role,
        profile: { name: user.displayName || '', email: user.email || '', photo: user.photoURL || '' },
        updatedAt: now()
      }, { merge: true });
      if (profile) profile.role = role; else await loadProfile();
      accountChanged();
      return { ok: true };
    } catch (e) {
      console.warn('[cloud] 역할 설정 실패', e);
      var denied = e && (e.code === 'permission-denied' || /permission|insufficient/i.test(e.message || ''));
      if (role === 'teacher' && denied) {
        return { ok: false, denied: true, msg: '이 계정은 선생님 권한이 없어요.\n관리자(마스터)가 선생님 목록(teacherAllow)에 이 이메일을 추가해야 선생님이 됩니다.' };
      }
      return { ok: false, msg: '역할 저장에 실패했어요: ' + (e && e.message ? e.message : e) };
    }
  }

  // ── 반 코드로 참여(학생) — 코드→반 매핑(classCodes) 조회 ──
  async function joinClassByCode(code, name) {
    if (!user) return { ok: false, msg: '로그인이 필요해요.' };
    name = (name || '').trim().slice(0, 20);
    if (!name) return { ok: false, msg: '이름을 입력해 주세요.' };
    code = (code || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{4,8}$/.test(code)) return { ok: false, msg: '올바른 반 코드를 입력해 주세요.' };
    try {
      var snap = await fsMod.getDoc(codeRef(code)); // 코드 doc-id로 O(1) 조회(열거 불가)
      if (!snap.exists()) return { ok: false, msg: '그런 반 코드가 없어요.' };
      var m = snap.data() || {};
      var cid = m.classId, cname = m.name || '';
      if (!cid) return { ok: false, msg: '반 정보를 찾을 수 없어요.' };
      await fsMod.setDoc(userRef(user.uid), {
        schema: 2, role: 'student', classId: cid, className: cname, displayName: name,
        updatedAt: now()
      }, { merge: true });
      if (profile) { profile.role = 'student'; profile.classId = cid; profile.className = cname; profile.displayName = name; }
      accountChanged();
      // 반 참여 직후 곧바로 한 번 동기화 — 랭킹 워커가 새 classId 를 보고 반 보드에 등록하게.
      //   (이게 없으면 다음 학습/재접속 때까지 반 랭킹에 학생이 안 보인다)
      try { syncNow(); } catch (eS) { /* 백그라운드 — 실패해도 참여 자체는 성공 */ }
      return { ok: true, name: cname, code: code };
    } catch (e) {
      console.warn('[cloud] 반 참여 실패', e);
      return { ok: false, msg: (e && e.message ? e.message : '반 참여에 실패했어요.') };
    }
  }

  // ── 반 생성(선생님) — 코드 유일성 보장(classCodes 생성 전용) ──
  function genCode() {
    var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 0/O/1/I 제외
    var s = '';
    for (var i = 0; i < 6; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
    return s;
  }
  async function createClass(name) {
    if (!user) return { ok: false, msg: '로그인이 필요해요.' };
    name = (name || '').trim().slice(0, 20);
    if (!name) return { ok: false, msg: '반 이름을 입력해 주세요.' };
    try {
      // 아직 안 쓰인 코드 확보(최대 6회 시도). classCodes 는 get 가능하므로 존재 확인.
      var code = null, tries = 0;
      while (tries < 6) {
        var c = genCode();
        var ex = await fsMod.getDoc(codeRef(c));
        if (!ex.exists()) { code = c; break; }
        tries++;
      }
      if (!code) return { ok: false, msg: '코드 생성에 실패했어요. 다시 시도해 주세요.' };
      var newRef = fsMod.doc(classesCol());
      // classCodes 는 '생성 전용' 규칙 → 동시에 같은 코드가 만들어지면 한쪽만 성공(유일성 보장)
      var batch = fsMod.writeBatch(db);
      batch.set(codeRef(code), { classId: newRef.id, ownerUid: user.uid, name: name, createdAt: now() });
      batch.set(newRef, { ownerUid: user.uid, name: name, code: code, removed: [], createdAt: now() });
      await batch.commit();
      // 선생님 역할 보장
      await fsMod.setDoc(userRef(user.uid), { schema: 2, role: 'teacher', updatedAt: now() }, { merge: true });
      if (profile) profile.role = 'teacher';
      accountChanged();
      return { ok: true, id: newRef.id, name: name, code: code };
    } catch (e) {
      console.warn('[cloud] 반 생성 실패', e);
      return { ok: false, msg: (e && e.message ? e.message : '반 생성에 실패했어요. 코드가 겹쳤을 수 있어요, 다시 시도해 주세요.') };
    }
  }

  // ── 기존 반(코드 매핑 없이 만들어진) 백필: 이미 나눠준 코드로 학생이 계속 참여하게 ──
  async function ensureCode(cls) {
    if (!user || !cls || !cls.code) return;
    var code = (cls.code || '').toUpperCase();
    try {
      var s = await fsMod.getDoc(codeRef(code));
      if (!s.exists()) {
        await fsMod.setDoc(codeRef(code), { classId: cls.id, ownerUid: user.uid, name: cls.name || '', createdAt: now() });
      }
    } catch (e) { /* 이미 있거나 코드 충돌 — 무시 */ }
  }

  // ── 내가 만든 반 목록(선생님) — 코드 매핑 백필 포함 ──
  async function listMyClasses() {
    if (!user) return [];
    try {
      // 마스터는 전체 반, 일반 선생님은 자기 소유 반만.
      var q = isMaster() ? classesCol() : fsMod.query(classesCol(), fsMod.where('ownerUid', '==', user.uid));
      var res = await fsMod.getDocs(q);
      var out = [];
      res.forEach(function (d) { var v = d.data(); out.push({ id: d.id, name: v.name || '', code: v.code || '', ownerUid: v.ownerUid || '' }); });
      out.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
      // 옛 반들의 코드 매핑을 백그라운드로 보강(내 반에 한함 — 마스터는 남의 반 코드에 손대지 않음)
      if (!isMaster()) { for (var i = 0; i < out.length; i++) { ensureCode(out[i]); } }
      return out;
    } catch (e) {
      console.warn('[cloud] 반 목록 조회 실패', e);
      return [];
    }
  }

  // ── 반 학생 목록 + 요약(선생님) — 제외 목록(removed) 은 flag 로 반환(복구 UI용) ──
  async function listStudents(classId) {
    if (!user || !classId) return [];
    try {
      var removed = {};
      try {
        var cs = await fsMod.getDoc(classRef(classId));
        var rr = cs.exists() ? (cs.data().removed || []) : [];
        for (var ri = 0; ri < rr.length; ri++) removed[rr[ri]] = true;
      } catch (e0) { /* 무시 */ }
      var q = fsMod.query(fsMod.collection(db, 'users'), fsMod.where('classId', '==', classId));
      var res = await fsMod.getDocs(q);
      var out = [];
      res.forEach(function (d) {
        var v = d.data() || {};
        if (d.id === user.uid) return; // 선생님 본인 제외
        out.push({
          uid: d.id,
          name: v.displayName || (v.profile && v.profile.name) || '',
          email: (v.profile && v.profile.email) || '',
          summary: v.summary || null,
          removed: !!removed[d.id]     // 제외 여부(대시보드가 활성/제외로 분리)
        });
      });
      out.sort(function (a, b) {
        var an = a.name || a.email, bn = b.name || b.email;
        return an < bn ? -1 : 1;
      });
      return out;
    } catch (e) {
      console.warn('[cloud] 학생 목록 조회 실패', e);
      return [];
    }
  }

  // ── 반에 단어 배포(선생님) — classPacks/{classId} 에 전체 교체 저장. ver=타임스탬프(학생 감지용) ──
  async function setClassPack(classId, words, name) {
    if (!user || !classId) return { ok: false, msg: '로그인이 필요해요.' };
    var w = (words || []).filter(function (x) { return x && x.w && x.m; })
      .slice(0, 500)
      .map(function (x) { return { w: String(x.w).slice(0, 60), m: String(x.m).slice(0, 160) }; });
    try {
      await fsMod.setDoc(packRef(classId), {
        words: w, ver: now(), name: name || '', ownerUid: user.uid, updatedAt: now()
      });
      return { ok: true, count: w.length };
    } catch (e) {
      console.warn('[cloud] 단어 배포 실패', e);
      return { ok: false, msg: (e && e.message) || '배포에 실패했어요.' };
    }
  }
  // ── 반 배포 단어 조회(선생님=편집용, 학생=가져오기용, 마스터) ──
  async function getClassPack(classId) {
    if (!user || !classId) return null;
    try {
      var snap = await fsMod.getDoc(packRef(classId));
      if (!snap.exists()) return null;
      var d = snap.data() || {};
      return { words: d.words || [], ver: d.ver || 0, name: d.name || '' };
    } catch (e) {
      console.warn('[cloud] 배포 단어 조회 실패', e);
      return null;
    }
  }

  // ── 반 주간 랭킹 조회(같은 반 학생/소유 선생님/마스터). 규칙 미배포·오프라인이면 null(그래스풀). ──
  async function getRank() {
    if (!user || !profile || !profile.classId) return null;
    if (rankEndpoint()) return await rankBoard('class', todayStr());
    try {
      var col = fsMod.collection(db, 'leaderboards', profile.classId, 'entries');
      var res = await fsMod.getDocs(col);
      var t = todayStr(), out = [];
      res.forEach(function (d) {
        var v = d.data() || {};
        // '이번 주' 합을 읽는 시점에 다시 계산(days 있으면). 옛 항목(days 없음)은 저장된 wk 폴백.
        var wk = v.days ? weekSum(v.days, t) : numOr0(v.wk);
        // 읽기 시점 연속 감쇠: days 가 있는데 오늘/어제 활동이 없으면 끊긴 연속 → 0(대시보드와 일치).
        var stk = numOr0(v.streak);
        if (v.days && !streakAliveByDays(v.days, t)) stk = 0;
        out.push({ uid: d.id, name: (v.name || '익명'), wk: wk, streak: stk, me: d.id === user.uid });
      });
      out.sort(function (a, b) { return (b.wk - a.wk) || (b.streak - a.streak) || (a.name < b.name ? -1 : 1); });
      return out;
    } catch (e) {
      console.warn('[cloud] 랭킹 조회 실패', e);
      return null;
    }
  }

  // ── 전체(글로벌) 랭킹 조회: 누적 마스터 단어수 내림차순. 규칙 미배포·오프라인이면 null(그레이스풀). ──
  async function getGlobalRank() {
    if (!user) return null;
    if (rankEndpoint()) return await rankBoard('global', todayStr());
    try {
      var col = fsMod.collection(db, 'leaderboards', '_global', 'entries');
      var res = await fsMod.getDocs(col);
      var t = todayStr(), out = [];
      res.forEach(function (d) {
        var v = d.data() || {};
        var wk = v.days ? weekSum(v.days, t) : numOr0(v.wk); // 조회 시점에 '이번 주' 합 재계산
        var stk = numOr0(v.streak);                          // 읽기 시점 연속 감쇠(getRank 와 동일)
        if (v.days && !streakAliveByDays(v.days, t)) stk = 0;
        out.push({ uid: d.id, name: (v.name || '익명'), wk: wk, streak: stk, me: d.id === user.uid });
      });
      out.sort(function (a, b) { return (b.wk - a.wk) || (b.streak - a.streak) || (a.name < b.name ? -1 : 1); });
      return out;
    } catch (e) {
      console.warn('[cloud] 전체 랭킹 조회 실패', e);
      return null;
    }
  }

  // ── 랭킹 조회(신) — '서버 오류'와 '빈 보드'를 구분해 돌려준다 ──
  //   기존 getRank/getGlobalRank 는 실패·미소속·빈보드가 전부 null/빈배열로 뭉개져,
  //   워커가 죽었을 때(KV 한도 등) UI가 "아직 푼 친구가 없어요"로 잘못 안내했다(실사고 2026-07-16).
  //   반환: { ok:true, list:[...] } | { ok:false, reason:'noauth'|'noclass'|'server' }
  //   (getRank/getGlobalRank 는 구버전 index.html 호환을 위해 기존 시그니처 그대로 유지)
  async function getRankInfo(scope) {
    if (!user) return { ok: false, reason: 'noauth' };
    if (scope !== 'global' && !(profile && profile.classId)) return { ok: false, reason: 'noclass' };
    var list = (scope === 'global') ? await getGlobalRank() : await getRank();
    return list ? { ok: true, list: list } : { ok: false, reason: 'server' };
  }

  // ── 반 삭제(소유 선생님) — 반 문서 먼저, 코드 매핑은 있으면 정리(없어도 무시) ──
  // (배치로 묶으면 옛 반처럼 코드 문서가 없을 때 배치 전체가 실패하므로 분리한다)
  async function deleteClass(classId, code) {
    if (!user || !classId) return { ok: false, msg: '로그인이 필요해요.' };
    try {
      await fsMod.deleteDoc(classRef(classId));
    } catch (e) {
      console.warn('[cloud] 반 삭제 실패', e);
      return { ok: false, msg: (e && e.message ? e.message : '반 삭제에 실패했어요.') };
    }
    if (code) { try { await fsMod.deleteDoc(codeRef((code || '').toUpperCase())); } catch (e2) { /* 옛 반은 코드 문서 없음 — 무시 */ } }
    return { ok: true };
  }

  // ── 학생 제외 / 복구(반 문서의 removed 목록) ──
  async function removeStudent(classId, studentUid) {
    if (!user || !classId || !studentUid) return { ok: false, msg: '잘못된 요청이에요.' };
    try {
      await fsMod.updateDoc(classRef(classId), { removed: fsMod.arrayUnion(studentUid) });
      return { ok: true };
    } catch (e) {
      console.warn('[cloud] 학생 제외 실패', e);
      return { ok: false, msg: (e && e.message ? e.message : '학생 제외에 실패했어요.') };
    }
  }
  async function unremoveStudent(classId, studentUid) {
    if (!user || !classId || !studentUid) return { ok: false, msg: '잘못된 요청이에요.' };
    try {
      await fsMod.updateDoc(classRef(classId), { removed: fsMod.arrayRemove(studentUid) });
      return { ok: true };
    } catch (e) {
      console.warn('[cloud] 학생 복구 실패', e);
      return { ok: false, msg: (e && e.message ? e.message : '학생 복구에 실패했어요.') };
    }
  }

  // ── 선생님 허용목록 관리(마스터 전용) — teacherAllow/{이메일} 추가·삭제·조회 ──
  //   · 서버 규칙(firestore.rules)이 teacherAllow 읽기·쓰기를 isMaster() 로만 허용한다.
  //     → 마스터가 아닌 계정이 아래를 호출해도 서버가 permission-denied 로 거부(이중 방어).
  //   · 문서 ID = 선생님 Google 이메일. 로그인 토큰의 email(구글은 소문자로 내려줌)과
  //     "정확히" 일치해야 규칙이 선생님으로 인정하므로, 저장 전 trim+소문자로 정규화한다.
  function normTeacherEmail(email) { return (email || '').trim().toLowerCase(); }
  function validTeacherEmail(email) {
    // 슬래시(/)는 Firestore 문서 ID 로 쓸 수 없고, 기본 이메일 형태만 통과.
    return /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(email);
  }
  // 현재 선생님 허용목록 조회 → [{ email, name }]. 실패 시 빈 배열.
  async function listTeachers() {
    if (!user) return [];
    try {
      var res = await fsMod.getDocs(teacherAllowCol());
      var out = [];
      res.forEach(function (d) { var v = d.data() || {}; out.push({ email: d.id, name: v.name || '' }); });
      out.sort(function (a, b) { return a.email < b.email ? -1 : (a.email > b.email ? 1 : 0); });
      return out;
    } catch (e) { console.warn('[cloud] 선생님 목록 조회 실패', e); return []; }
  }
  // 선생님 추가(허용목록에 이메일 문서 생성). 마스터만.
  async function addTeacher(email, name) {
    if (!user) return { ok: false, msg: '로그인이 필요해요.' };
    email = normTeacherEmail(email);
    if (!validTeacherEmail(email)) return { ok: false, msg: '올바른 이메일을 입력해 주세요. (예: teacher@goedu.kr)' };
    if (email === MASTER_EMAIL) return { ok: false, msg: '운영자(마스터) 계정은 이미 항상 선생님이에요. 추가할 필요 없어요.' };
    if (!isMaster()) return { ok: false, msg: '운영자(마스터)만 선생님을 추가할 수 있어요.' };
    try {
      await fsMod.setDoc(teacherAllowRef(email), { name: (name || '').trim().slice(0, 40), addedAt: now(), addedBy: user.email || '' }, { merge: true });
      return { ok: true, email: email };
    } catch (e) {
      console.warn('[cloud] 선생님 추가 실패', e);
      var denied = e && (e.code === 'permission-denied' || /permission|insufficient/i.test(e.message || ''));
      return { ok: false, msg: denied ? '권한이 없어요. 운영자(마스터) 계정으로 로그인했는지 확인해 주세요.' : ('선생님 추가에 실패했어요: ' + (e && e.message ? e.message : e)) };
    }
  }
  // 선생님 삭제(허용목록에서 제거 = 해임). 마스터만. 이미 만든 반은 남으니 필요 시 대시보드에서 별도 정리.
  async function removeTeacher(email) {
    if (!user) return { ok: false, msg: '로그인이 필요해요.' };
    email = normTeacherEmail(email);
    if (!email) return { ok: false, msg: '이메일이 비어 있어요.' };
    if (!isMaster()) return { ok: false, msg: '운영자(마스터)만 선생님을 삭제할 수 있어요.' };
    try {
      await fsMod.deleteDoc(teacherAllowRef(email));
      return { ok: true, email: email };
    } catch (e) {
      console.warn('[cloud] 선생님 삭제 실패', e);
      var denied = e && (e.code === 'permission-denied' || /permission|insufficient/i.test(e.message || ''));
      return { ok: false, msg: denied ? '권한이 없어요. 운영자(마스터) 계정으로 로그인했는지 확인해 주세요.' : ('선생님 삭제에 실패했어요: ' + (e && e.message ? e.message : e)) };
    }
  }

  // ── 인증 상태 변화 → 프로필 로드 + 상태표시 + 최초 동기화 ──
  authMod.onAuthStateChanged(auth, async function (u) {
    user = u || null;
    if (user) {
      status('로그인됨 · ' + (user.email || ''));
      await loadProfile();
      accountChanged();
      syncNow();
    } else {
      profile = null;
      status('로그아웃');
      accountChanged();
    }
  });

  window.Cloud = {
    enabled: true,
    signInGoogle: signInGoogle,
    signOutUser: signOutUser,
    syncNow: syncNow,
    notifyChanged: notifyChanged,
    wipeRemote: wipeRemote,
    currentEmail: function () { return user ? user.email : null; },
    // 홈 '오늘 학습 저장 안 됨' 경고 판정용: 로그인 여부 + 지금 서버 저장이 실패 중인지 + 마지막 성공 시각.
    syncState: function () { return { signedIn: !!user, failing: lastSyncFailAt > lastSyncOkAt, okAt: lastSyncOkAt }; },
    currentUser: function () { return user ? { uid: user.uid, email: user.email, name: user.displayName, photo: user.photoURL } : null; },
    getIdToken: function () { return user ? user.getIdToken() : Promise.resolve(null); }, // OCR 프록시 인증용
    quizStart: quizStart,     // 서버 세션 채점: 판 시작 시 세션 발급(index.html 전투 훅)
    quizSubmit: quizSubmit,   // 정답 배치 제출(랭킹 크레딧). 실패/미지원 시 null → 로컬 진도만.

    getProfile: function () { return profile; },
    chooseRole: chooseRole,
    joinClassByCode: joinClassByCode,
    setDisplayName: setDisplayName,
    createClass: createClass,
    deleteClass: deleteClass,
    removeStudent: removeStudent,
    unremoveStudent: unremoveStudent,
    listMyClasses: listMyClasses,
    listStudents: listStudents,
    teacherBoard: teacherBoard,
    setClassPack: setClassPack,
    getClassPack: getClassPack,
    getRank: getRank,
    getGlobalRank: getGlobalRank,
    getRankInfo: getRankInfo,
    rankStatus: rankStatus,
    isMaster: isMaster,
    listTeachers: listTeachers,
    addTeacher: addTeacher,
    removeTeacher: removeTeacher,
    onChange: function (cb) { document.addEventListener('cloud-account', cb); }
  };

  // 리디렉트 로그인 결과 처리(팝업 폴백 경로)
  try { await authMod.getRedirectResult(auth); } catch (e) { /* 무시 */ }
  ready();
})();
