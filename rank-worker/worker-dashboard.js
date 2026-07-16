/* ============================================================================
   WordQuest 랭킹 집계 프록시 — Cloudflare 대시보드 붙여넣기용 (Service Worker 형식)
   ----------------------------------------------------------------------------
   ★ 이 파일은 worker.js(모듈 형식)와 로직이 동일한 '형식 변환본'이다.
     기존에 만들어진 워커가 Service Worker 형식이면 대시보드 편집기가 모듈 구문
     (`export default`)을 못 받아 "Unexpected token 'export'" 오류가 난다 →
     그럴 땐 이 파일 전체를 붙여넣는다(기존 KV/변수 바인딩·URL 그대로 유지).
   ★ 로직을 고칠 땐 worker.js 를 고치고 이 파일에 똑같이 반영할 것(둘은 쌍둥이).

   목적: "이번 주 완료한 단어 수"를 서버가 세서, 학생이 콘솔로 점수를 위조하지
        못하게 한다(근본 차단). 점수는 클라이언트가 못 쓰고 이 워커만 KV에 기록한다.

   엔드포인트:
     POST /sync   body {week, today, name}  → 서버가 doneByDay 읽어 카운트·KV 저장, {wk} 반환
     GET  /board?scope=class|global&week=YYYY-MM-DD  → 정렬된 순위 반환
     GET  /teacher?class=CLASSID  → (소유 선생님·마스터만) 반 학생별 '서버 관측' 연속일수·
                                    학습일수·출석맵 반환. 선생님 대시보드가 위조 불가값을 표시.

   필요한 바인딩/환경변수(Cloudflare 대시보드 → Settings → Variables):
     RANK_KV            (KV 네임스페이스 바인딩)  — 점수 저장(키 메타데이터에 표시값)
     FIREBASE_API_KEY   (Variable) — firebase-config.js 의 apiKey(공개값)
     PROJECT_ID         (Variable) — Firebase projectId (예: wordquest-a250d)
     ALLOW_ORIGIN       (선택)      — 허용 도메인(기본 *)
     MASTER_EMAIL       (선택)      — 마스터 이메일 재정의
   ============================================================================ */
'use strict';

addEventListener('fetch', function (event) {
  event.respondWith(handleFetch(event.request));
});

async function handleFetch(req) {
  // Service Worker 형식에선 바인딩이 전역 변수로 주입된다 → 모듈 형식의 env 객체 모양으로
  // 감싸서 아래 나머지 코드를 worker.js 와 한 글자도 다르지 않게 공유한다.
  var env = {
    RANK_KV: (typeof RANK_KV !== 'undefined') ? RANK_KV : null,
    FIREBASE_API_KEY: (typeof FIREBASE_API_KEY !== 'undefined') ? FIREBASE_API_KEY : '',
    PROJECT_ID: (typeof PROJECT_ID !== 'undefined') ? PROJECT_ID : '',
    ALLOW_ORIGIN: (typeof ALLOW_ORIGIN !== 'undefined') ? ALLOW_ORIGIN : '',
    MASTER_EMAIL: (typeof MASTER_EMAIL !== 'undefined') ? MASTER_EMAIL : ''
  };

  const allow = env.ALLOW_ORIGIN || '*';
  const cors = {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (!env.RANK_KV || !env.FIREBASE_API_KEY || !env.PROJECT_ID) {
    return json({ error: 'server_misconfig' }, 500, cors);
  }

  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const authUser = await verifyFirebase(token, env.FIREBASE_API_KEY);
  if (!authUser || !authUser.uid) return json({ error: 'unauthorized' }, 401, cors);
  const uid = authUser.uid;

  try {
    if (req.method === 'POST' && path.endsWith('/sync')) return await handleSync(req, env, uid, token, cors);
    if (req.method === 'GET' && path.endsWith('/board')) return await handleBoard(env, uid, token, url, cors);
    if (req.method === 'GET' && path.endsWith('/teacher')) return await handleTeacher(env, authUser, token, url, cors);
    return json({ error: 'not_found' }, 404, cors);
  } catch (e) {
    return json({ error: 'server_error', detail: String((e && e.message) || e).slice(0, 200) }, 500, cors);
  }
}

const TTL = 60 * 60 * 24 * 16; // 16일(지난 주 자동 만료)

async function handleSync(req, env, uid, token, cors) {
  const body = await req.json().catch(() => ({}));
  const week = validWeek(body.week) ? body.week : null;
  const today = validWeek(body.today) ? body.today : null;
  if (!week || !today) return json({ error: 'bad_date' }, 400, cors);
  const name = String(body.name || '').slice(0, 40);

  // 집계 원천 = 학생 '본인'의 동기화된 완료기록(users/{uid}/private/state 의 meta.doneByDay)을
  //   서버가 직접 읽어서 센다. 클라가 보낸 ids/숫자는 신뢰하지 않는다 → 콘솔로 점수 위조 불가.
  //   배포단어에 국한하지 않고 '완료한 모든 단어'(개인등록·기본팩·배포)를 종류 불문 카운트한다.
  const doneByDay = await getDoneByDay(env, uid, token);
  const wk = countWeekDone(doneByDay, week, today);          // 이번 주(week=월 ~ today) 유니크 완료 수
  const activeToday = normIds(doneByDay[today]).length > 0;  // 오늘 뭐라도 완료했는가(연속일수용)
  const streak = await updateStreak(env, uid, today, activeToday);
  const cid = await getClassId(env, uid, token);             // 반 랭킹 보드 키에만 사용

  const meta = { n: name, w: wk, s: streak };
  // ── KV 쓰기 절약(무료 플랜 하루 1,000회 한도 보호) ──────────────────────────────
  //   실사고(2026-07-16): sync당 최대 5회 put × 전교생 종일 동기화 → 한도 초과 →
  //   put 이 throw → /sync 전체가 500 → 이후 학생들 점수가 안 올라갔다.
  //   대책 ①값이 안 변했으면 put 생략(읽기는 하루 10만회로 여유) ②put 은 개별
  //   try/catch — 한도가 차도 집계·응답(wk)은 계속 되고 보드도 기존 값으로 살아있게.
  if (cid) {
    let cPrev = null;
    try { cPrev = (await env.RANK_KV.getWithMetadata('c:' + week + ':' + cid + ':' + uid)).metadata; } catch (e) { /* 없음 */ }
    if (!sameMeta(cPrev, meta)) { try { await env.RANK_KV.put('c:' + week + ':' + cid + ':' + uid, '', { metadata: meta, expirationTtl: TTL }); } catch (e) { /* 한도 등 — 다음 sync 때 재시도 */ } }
  }
  let gPrev = null;
  try { gPrev = (await env.RANK_KV.getWithMetadata('g:' + week + ':' + uid)).metadata; } catch (e) { /* 없음 */ }
  if (!sameMeta(gPrev, meta)) { try { await env.RANK_KV.put('g:' + week + ':' + uid, '', { metadata: meta, expirationTtl: TTL }); } catch (e) { /* 한도 등 */ } }

  // ── 선생님 대시보드용 '서버 관측' 출석·명단(위조 불가) ──────────────────────────
  //   랭킹(위 KV)과 별개로, 선생님 대시보드가 학생 자기보고(summary.streak/daily)를
  //   그대로 믿던 구멍을 막는다: '서버 시계상 오늘' 실제 완료가 있으면 그날을 att:{uid}에 남긴다.
  //   날짜 키를 서버가 정하므로(클라가 보낸 today 무시) 학생이 과거 날짜/연속을 심을 수 없다.
  const sToday = kstToday(Date.now());
  const sCount = normIds(doneByDay[sToday]).length;       // 오늘 서버가 관측한 완료 단어 수(자연 천장)
  if (sCount > 0) await recordAttendance(env, uid, sToday, sCount);
  if (cid) await recordMember(env, cid, uid, name);       // 반 명단(선생님이 att를 조회하려면 uid 열거 필요)

  return json({ wk: wk, streak: streak, cid: cid || null, ceiling: countAllDone(doneByDay) }, 200, cors);
}

const ATT_TTL = 60 * 60 * 24 * 45;   // 45일 롤링(선생님 대시보드 히트맵 ~최근 5주)
const MEM_TTL = 60 * 60 * 24 * 45;   // 반 명단 마커: 45일 내 동기화한 학생만 열거

// att:{uid} = { 'YYYY-MM-DD': 그날 서버가 관측한 완료 단어수 } — 서버 시계상 오늘만 기록/증가.
//   KV 쓰기 절약: 오늘 첫 기록이거나 5단어 이상 늘었을 때만 저장(하루 최대 ~4단어 과소집계 허용
//   — 출석/학습일수 판정에는 영향 없음). 무료 한도(1,000/일) 보호.
async function recordAttendance(env, uid, today, count) {
  const key = 'att:' + uid;
  let map = null;
  try { map = await env.RANK_KV.get(key, { type: 'json' }); } catch (e) { /* 없음 */ }
  map = pruneDays((map && typeof map === 'object') ? map : {}, 40, today);
  const prev = (typeof map[today] === 'number') ? map[today] : 0;
  map[today] = prev > count ? prev : count;   // 하루 중 진행하며 늘어난 값 반영(감소 없음)
  if (map[today] > prev && (prev === 0 || map[today] - prev >= 5)) {
    try { await env.RANK_KV.put(key, JSON.stringify(map), { expirationTtl: ATT_TTL }); } catch (e) { /* 무시 */ }
  }
  return map;
}
// 반 명단 마커 — 없거나 이름이 바뀐 경우에만 put(쓰기 절약). 45일 뒤 만료돼도 다음 sync 가 재생성.
async function recordMember(env, cid, uid, name) {
  const key = 'mem:' + cid + ':' + uid, nm = String(name || '').slice(0, 40);
  let cur = null;
  try { cur = (await env.RANK_KV.getWithMetadata(key)).metadata; } catch (e) { /* 없음 */ }
  if (cur && cur.n === nm) return;
  try { await env.RANK_KV.put(key, '', { metadata: { n: nm }, expirationTtl: MEM_TTL }); } catch (e) { /* 무시 */ }
}

// 소유 선생님(또는 마스터)만: 반 학생별 서버 관측 연속일수·학습일수·출석맵을 반환.
async function handleTeacher(env, authUser, token, url, cors) {
  const cid = String(url.searchParams.get('class') || '').slice(0, 64);
  if (!cid) return json({ error: 'bad_class' }, 400, cors);

  // 인가: 마스터거나, 이 반의 소유 선생님만. 반 문서 ownerUid 를 '요청자 토큰'으로 확인 →
  //   firestore.rules(소유 선생님만 classes 문서 read)와 동일한 신뢰선. 남의 반은 열람 불가.
  let ok = isMasterUser(authUser, env);
  if (!ok) {
    const cls = await fsGet(env, 'classes/' + cid, token);
    const owner = cls && cls.fields && cls.fields.ownerUid && cls.fields.ownerUid.stringValue;
    ok = !!owner && owner === authUser.uid;
  }
  if (!ok) return json({ error: 'forbidden' }, 403, cors);

  const today = kstToday(Date.now());
  const out = [];
  let cursor;
  const prefix = 'mem:' + cid + ':';
  do {
    const res = await env.RANK_KV.list({ prefix: prefix, cursor: cursor, limit: 1000 });
    for (const k of res.keys) {
      const suid = k.name.slice(prefix.length);
      const nm = (k.metadata && k.metadata.n) || '';
      let att = null;
      try { att = await env.RANK_KV.get('att:' + suid, { type: 'json' }); } catch (e) { /* 없음 */ }
      att = (att && typeof att === 'object') ? att : {};
      out.push({ uid: suid, name: nm, streak: streakFromDays(att, today), studyDays: Object.keys(att).length, days: att });
    }
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);
  return json({ list: out, today: today }, 200, cors);
}

const STREAK_TTL = 60 * 60 * 24 * 45; // 45일 무활동 시 기록 만료(어차피 연속은 하루만 빠져도 끊김)
// 연속일수 순수 전이: rec={last,n} → 오늘 활동 여부로 다음 상태·표시값 계산.
//   활동한 날만 늘고, 오늘/어제까지 이어질 때만 표시(끊기면 0). 클라가 못 부풀린다(서버 관측일 기준).
function streakCompute(rec, today, activeToday) {
  var n = (rec && rec.n) || 0, last = (rec && rec.last) || null, store = null;
  if (activeToday) {
    if (last === today) { /* 오늘 이미 반영됨 — 재저장 불필요(KV 쓰기 절약) */ }
    else {
      n = (last === isoAddDays(today, -1)) ? (n + 1) : 1;    // 어제 이어서 +1 / 공백·최초 1
      last = today; store = { last: last, n: n };            // '오늘 첫 활동'일 때만 저장
    }
  }
  var alive = (last === today || last === isoAddDays(today, -1));
  return { store: store, display: alive ? n : 0 };
}
async function updateStreak(env, uid, today, activeToday) {
  var key = 'st:' + uid, rec = null;
  try { rec = await env.RANK_KV.get(key, { type: 'json' }); } catch (e) { /* 없음 */ }
  var r = streakCompute(rec, today, activeToday);
  if (r.store) { try { await env.RANK_KV.put(key, JSON.stringify(r.store), { expirationTtl: STREAK_TTL }); } catch (e) { /* 무시 */ } }
  return r.display;
}

async function handleBoard(env, uid, token, url, cors) {
  const week = validWeek(url.searchParams.get('week')) ? url.searchParams.get('week') : null;
  if (!week) return json({ error: 'bad_week' }, 400, cors);
  const scope = url.searchParams.get('scope') === 'global' ? 'global' : 'class';

  let prefix;
  if (scope === 'global') {
    prefix = 'g:' + week + ':';
  } else {
    const cid = await getClassId(env, uid, token);
    if (!cid) return json({ list: [] }, 200, cors);
    prefix = 'c:' + week + ':' + cid + ':';
  }

  const out = [];
  let cursor;
  do {
    const res = await env.RANK_KV.list({ prefix: prefix, cursor: cursor, limit: 1000 });
    for (const k of res.keys) {
      const m = k.metadata || {};
      const kid = k.name.slice(prefix.length);
      out.push({ uid: kid, name: m.n || '익명', wk: m.w || 0, streak: m.s || 0, me: kid === uid });
    }
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);
  out.sort(sortBoard);
  return json({ list: scope === 'global' ? out.slice(0, 100) : out }, 200, cors);
}

/* ── 순수 로직 ── */
function validWeek(w) { return typeof w === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(w); }
function clampInt(n, lo, hi) { n = parseInt(n, 10); if (!isFinite(n)) n = 0; return n < lo ? lo : (n > hi ? hi : n); }
function normIds(a) { return Array.isArray(a) ? a.slice(0, 2000).map(function (x) { return String(x).toLowerCase(); }) : []; }
function isoAddDays(ds, n) { var p = ds.split('-').map(Number); var d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)); var z = function (x) { return String(x).padStart(2, '0'); }; return d.getUTCFullYear() + '-' + z(d.getUTCMonth() + 1) + '-' + z(d.getUTCDate()); }
// KST(UTC+9, 서머타임 없음) 기준 'YYYY-MM-DD' — 클라이언트 today()(로컬=한국)·doneByDay 키와 일치시킨다.
//   nowMs 는 Date.now(). 서버 시계 기준이라 학생이 날짜를 못 바꾼다(출석·연속 위조 차단의 핵심).
function kstToday(nowMs) { var d = new Date(nowMs + 9 * 3600 * 1000); var z = function (x) { return String(x).padStart(2, '0'); }; return d.getUTCFullYear() + '-' + z(d.getUTCMonth() + 1) + '-' + z(d.getUTCDate()); }
// 출석맵에서 today-keepDays 보다 오래된 날짜 제거(KV 크기 억제).
function pruneDays(map, keepDays, today) { var cut = isoAddDays(today, -keepDays), out = {}; for (var d in map) { if (Object.prototype.hasOwnProperty.call(map, d) && d > cut) out[d] = map[d]; } return out; }
// 서버 관측 출석맵에서 연속일수: 오늘(없으면 어제)부터 하루도 안 빠지고 이어진 날 수. 끊기면 0.
function streakFromDays(days, today) { if (!days) return 0; var cur = today; if (!days[cur]) { cur = isoAddDays(today, -1); if (!days[cur]) return 0; } var n = 0; while (days[cur]) { n++; cur = isoAddDays(cur, -1); } return n; }
// 이번 주(week=월요일 ~ today, ISO 날짜 문자열 비교) 완료 단어 유니크 수. 종류(개인·기본팩·배포) 불문.
function countWeekDone(dbd, week, today) {
  const seen = new Set();
  for (const d in dbd) {
    if (d >= week && d <= today) { const a = normIds(dbd[d]); for (let i = 0; i < a.length; i++) seen.add(a[i]); }
  }
  return seen.size;
}
// 보관된 완료기록(최근 9일 롤링) 전체의 유니크 수 — 응답 참고값(ceiling)용.
function countAllDone(dbd) {
  const seen = new Set();
  for (const d in dbd) { const a = normIds(dbd[d]); for (let i = 0; i < a.length; i++) seen.add(a[i]); }
  return seen.size;
}
function sortBoard(a, b) { return (b.wk - a.wk) || (b.streak - a.streak) || (a.name < b.name ? -1 : 1); }
// 랭킹 KV 메타데이터({n,w,s})가 동일한가 — 같으면 put 을 건너뛴다(무료 쓰기 한도 보호).
function sameMeta(a, b) { return !!a && !!b && a.n === b.n && a.w === b.w && a.s === b.s; }
// Firestore REST(state 문서, mask=meta)에서 meta.doneByDay { 'YYYY-MM-DD': [id,…] } 추출.
function parseDoneByDay(doc) {
  const meta = doc && doc.fields && doc.fields.meta && doc.fields.meta.mapValue && doc.fields.meta.mapValue.fields;
  const dbd = meta && meta.doneByDay && meta.doneByDay.mapValue && meta.doneByDay.mapValue.fields;
  const out = {};
  if (dbd) for (const day in dbd) {
    const vals = dbd[day] && dbd[day].arrayValue && dbd[day].arrayValue.values;
    if (vals) { const arr = []; for (let i = 0; i < vals.length; i++) { const s = vals[i] && vals[i].stringValue; if (s) arr.push(s); } out[day] = arr; }
  }
  return out;
}

/* ── 외부 I/O ── */
async function getClassId(env, uid, token) {
  const doc = await fsGet(env, 'users/' + uid, token);
  return (doc && doc.fields && doc.fields.classId && doc.fields.classId.stringValue) || null;
}
// 학생 본인 상태문서(users/{uid}/private/state)의 meta.doneByDay 만 읽는다.
//   mask=meta 로 words 맵(수백 KB)은 전송받지 않아 읽기 비용을 낮춘다. 규칙상 본인 문서라 학생 토큰으로 읽힘.
async function getDoneByDay(env, uid, token) {
  return parseDoneByDay(await fsGet(env, 'users/' + uid + '/private/state', token, 'meta'));
}
async function fsGet(env, docPath, idToken, mask) {
  var url = 'https://firestore.googleapis.com/v1/projects/' + env.PROJECT_ID + '/databases/(default)/documents/' + docPath;
  if (mask) url += '?mask.fieldPaths=' + encodeURIComponent(mask);
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + idToken } });
  if (!r.ok) return null;
  return await r.json();
}
// Firebase ID 토큰 검증(OCR 워커와 동일 방식): Identity Toolkit accounts:lookup.
//   { uid, email, emailVerified } 반환(선생님/마스터 판정에 email 필요). 실패 시 null.
async function verifyFirebase(idToken, apiKey) {
  if (!idToken || !apiKey) return null;
  try {
    const r = await fetch(
      'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + encodeURIComponent(apiKey),
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken }) }
    );
    if (!r.ok) return null;
    const d = await r.json();
    const u = d.users && d.users[0];
    if (!u || !u.localId) return null;
    return { uid: u.localId, email: u.email || '', emailVerified: u.emailVerified === true };
  } catch (e) { return null; }
}
// 마스터(운영자) 판정 — firestore.rules 의 isMaster() 와 동일 이메일. env.MASTER_EMAIL 로 재정의 가능.
function isMasterUser(authUser, env) {
  const master = String((env && env.MASTER_EMAIL) || 'ranha.park@gmail.com').toLowerCase();
  return !!(authUser && authUser.emailVerified && authUser.email && authUser.email.toLowerCase() === master);
}
function json(o, status, cors) {
  return new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...cors } });
}
// (단위 테스트용 export 는 모듈 형식인 worker.js 에만 있다 — 이 파일은 붙여넣기 전용)
