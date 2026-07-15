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
  var auth = authMod.getAuth(app);
  var db = fsMod.getFirestore(app);

  // ── 문서 참조 헬퍼 ──
  var userRef = function (uid) { return fsMod.doc(db, 'users', uid); };
  var stateRef = function (uid) { return fsMod.doc(db, 'users', uid, 'private', 'state'); };
  var classRef = function (cid) { return fsMod.doc(db, 'classes', cid); };
  var classesCol = function () { return fsMod.collection(db, 'classes'); };
  var codeRef = function (code) { return fsMod.doc(db, 'classCodes', code); }; // 코드→반 매핑(코드 유일성·비열거)
  var packRef = function (cid) { return fsMod.doc(db, 'classPacks', cid); };   // 반 배포 단어(선생님→반 학생 전원)

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
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function addDaysStr(ds, n) {
    var p = ds.split('-').map(Number);
    var d = new Date(p[0], p[1] - 1, p[2] + n);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  // 이번 주(월요일~오늘) 날짜들 — 반 랭킹의 '이번 주' 기준(읽는 시점에 다시 계산해 오래된 점수 자동 제외)
  function weekDates(t) {
    var p = t.split('-').map(Number);
    var sinceMon = (new Date(p[0], p[1] - 1, p[2]).getDay() + 6) % 7; // 월=0 … 일=6
    var out = [];
    for (var i = 0; i <= sinceMon; i++) out.push(addDaysStr(t, -i));
    return out;
  }
  // 일자별 단어수 맵(days)에서 '이번 주' 합을 낸다. days 없으면 0.
  function weekSum(days, t) {
    if (!days) return 0;
    var wd = weekDates(t), s = 0;
    for (var i = 0; i < wd.length; i++) s += (days[wd[i]] || 0);
    return s;
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
    // 최고기록성 값은 LWW가 아니라 max로 보존(다른 기기에서 사소한 저장에 덮이지 않게)
    mergedMeta.bestCombo = Math.max((lm.bestCombo || 0), (rm.bestCombo || 0));
    mergedMeta.exp = Math.max((lm.exp || 0), (rm.exp || 0));
    // streak/lastDay는 더 최근에 학습한(lastDay가 큰) 쪽을 채택
    var lDay = lm.lastDay || '', rDay = rm.lastDay || '';
    if (rDay > lDay) { mergedMeta.streak = rm.streak || 0; mergedMeta.lastDay = rm.lastDay || null; }
    else if (lDay) { mergedMeta.streak = lm.streak || 0; mergedMeta.lastDay = lm.lastDay || null; }
    return { map: mergedMap, arr: mergedArr, meta: mergedMeta };
  }

  // ── 학습 데이터 동기화(private/state) + 상단 요약 갱신 ──
  async function syncNow() {
    if (!user) return;
    try {
      status('동기화 중…');
      var local = (WQ().getState || function () { return { words: [], meta: {} }; })();
      var sRef = stateRef(user.uid);
      var snap = await fsMod.getDoc(sRef);
      var remote;
      if (snap.exists()) {
        remote = snap.data();
      } else {
        // 레거시(schema 1): users/{uid} 최상위에 words/meta 가 있던 시절 → 1회 이관
        var legacy = await fsMod.getDoc(userRef(user.uid));
        var ld = legacy.exists() ? legacy.data() : null;
        remote = (ld && ld.words) ? { words: ld.words, meta: ld.meta || {} } : { words: {}, meta: {} };
      }
      var m = merge(local, remote);
      var busy = false; try { busy = !!(WQ().isBusy && WQ().isBusy()); } catch (e) {}
      if (!busy && WQ().applyMerged) WQ().applyMerged({ words: m.arr, meta: m.meta });
      await fsMod.setDoc(sRef, { schema: 2, words: m.map, meta: m.meta, updatedAt: now() });
      // 최상위 요약 갱신(선생님 대시보드용 — Phase 1은 최소한만)
      await writeSummary(m.arr, m.meta);
      status('동기화됨 · ' + hhmm());
    } catch (e) {
      console.warn('[cloud] 동기화 실패', e);
      status('동기화 보류(오프라인?)');
    }
  }

  // ── users/{uid} 최상위 문서에 프로필/요약 기록(레거시 words 제거) ──
  async function writeSummary(arr, meta) {
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
        daily: daily
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
    // ── 반 주간 랭킹 항목 갱신(학생 + 반 소속) — 최근 8일 일자별 완료 단어수(days) + 연속 ──
    //    days 를 저장해두면, 조회하는 쪽에서 '이번 주(월~오늘)' 합을 언제든 다시 계산할 수 있다.
    //    → 오늘 안 해도 이번 주에 한 기록이 반영되고, 지난주 점수는 새 주가 되면 자동으로 빠진다.
    try {
      if (profile && profile.role === 'student' && profile.classId) {
        var days = {};
        for (var wi = 0; wi < 8; wi++) {
          var dk = addDaysStr(t, -wi), de = dh[dk];
          if (de) { var dv = (de.w != null ? de.w : de.ok) || 0; if (dv) days[dk] = dv; }
        }
        var lstreak = (meta && meta.lastDay && (meta.lastDay === t || meta.lastDay === addDaysStr(t, -1))) ? (meta.streak || 0) : 0;
        var lref = fsMod.doc(db, 'leaderboards', profile.classId, 'entries', user.uid);
        await fsMod.setDoc(lref, { name: (profile.displayName || profile.name || '익명').slice(0, 40), wk: weekSum(days, t), streak: lstreak, days: days, at: now() });
      }
    } catch (eL) { /* 랭킹 쓰기 실패는 조용히(규칙 미배포·오프라인 등) */ }
  }

  function notifyChanged() {
    if (!user) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(function () { syncNow(); }, 3000);
  }

  // ── Google 로그인 (팝업 → 실패 시 리디렉트 폴백) ──
  async function signInGoogle() {
    var provider = new authMod.GoogleAuthProvider();
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
  async function chooseRole(role) {
    if (!user) return;
    if (role !== 'student' && role !== 'teacher') return;
    try {
      await fsMod.setDoc(userRef(user.uid), {
        schema: 2, role: role,
        profile: { name: user.displayName || '', email: user.email || '', photo: user.photoURL || '' },
        updatedAt: now()
      }, { merge: true });
      if (profile) profile.role = role; else await loadProfile();
      accountChanged();
    } catch (e) {
      console.warn('[cloud] 역할 설정 실패', e);
      alert('역할 저장에 실패했어요: ' + (e && e.message ? e.message : e));
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
    try {
      var col = fsMod.collection(db, 'leaderboards', profile.classId, 'entries');
      var res = await fsMod.getDocs(col);
      var t = todayStr(), out = [];
      res.forEach(function (d) {
        var v = d.data() || {};
        // '이번 주' 합을 읽는 시점에 다시 계산(days 있으면). 옛 항목(days 없음)은 저장된 wk 폴백.
        var wk = v.days ? weekSum(v.days, t) : (v.wk || 0);
        out.push({ uid: d.id, name: (v.name || '익명'), wk: wk, streak: (v.streak || 0), me: d.id === user.uid });
      });
      out.sort(function (a, b) { return (b.wk - a.wk) || (b.streak - a.streak) || (a.name < b.name ? -1 : 1); });
      return out;
    } catch (e) {
      console.warn('[cloud] 랭킹 조회 실패', e);
      return null;
    }
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
    currentUser: function () { return user ? { uid: user.uid, email: user.email, name: user.displayName, photo: user.photoURL } : null; },
    getIdToken: function () { return user ? user.getIdToken() : Promise.resolve(null); }, // OCR 프록시 인증용

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
    setClassPack: setClassPack,
    getClassPack: getClassPack,
    getRank: getRank,
    isMaster: isMaster,
    onChange: function (cb) { document.addEventListener('cloud-account', cb); }
  };

  // 리디렉트 로그인 결과 처리(팝업 폴백 경로)
  try { await authMod.getRedirectResult(auth); } catch (e) { /* 무시 */ }
  ready();
})();
