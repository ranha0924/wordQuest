/* ============================================================================
   WordQuest 랭킹 집계 프록시 (Cloudflare Worker)
   ----------------------------------------------------------------------------
   목적: "이번 주 완료한 배포 단어 수"를 서버가 세서, 학생이 콘솔로 점수를 위조하지
        못하게 한다(근본 차단). 점수는 클라이언트가 못 쓰고 이 워커만 KV에 기록한다.

   핵심 아이디어(상한 없이 위조만 차단):
     · 클라가 "이번 주 완료한 단어 id 목록"을 보고 → 워커가 로그인 토큰을 검증하고,
       그 반의 배포 단어(classPacks)와 **교집합**을 세어 점수로 삼는다.
     · 따라서 점수의 자연 천장 = "배정된 단어를 전부 했을 때" 이다. 99999 같은 임의
       숫자가 원천 불가하고, 진짜 열심히 한 학생의 값은 상한 없이 그대로 반영된다.
     · 배포 단어 검증은 학생 '본인 토큰'으로 Firestore REST 를 읽어 수행(규칙이 허용).

   엔드포인트:
     POST /sync   body {week, ids[], streak, name}  → 카운트 계산·KV 저장, {wk} 반환
     GET  /board?scope=class|global&week=YYYY-MM-DD  → 정렬된 순위 반환

   필요한 바인딩/환경변수(Cloudflare 대시보드):
     RANK_KV            (KV 네임스페이스 바인딩)  — 점수 저장(키 메타데이터에 표시값)
     FIREBASE_API_KEY   (Variable) — firebase-config.js 의 apiKey(공개값)
     PROJECT_ID         (Variable) — Firebase projectId (예: wordquest-a250d)
     ALLOW_ORIGIN       (선택)      — 허용 도메인(기본 *)
   ============================================================================ */

export default {
  async fetch(req, env) {
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
    const uid = await verifyFirebase(token, env.FIREBASE_API_KEY);
    if (!uid) return json({ error: 'unauthorized' }, 401, cors);

    try {
      if (req.method === 'POST' && path.endsWith('/sync')) return await handleSync(req, env, uid, token, cors);
      if (req.method === 'GET' && path.endsWith('/board')) return await handleBoard(env, uid, token, url, cors);
      return json({ error: 'not_found' }, 404, cors);
    } catch (e) {
      return json({ error: 'server_error', detail: String((e && e.message) || e).slice(0, 200) }, 500, cors);
    }
  },
};

const TTL = 60 * 60 * 24 * 16; // 16일(지난 주 자동 만료)

async function handleSync(req, env, uid, token, cors) {
  const body = await req.json().catch(() => ({}));
  const week = validWeek(body.week) ? body.week : null;
  const today = validWeek(body.today) ? body.today : null;
  if (!week || !today) return json({ error: 'bad_date' }, 400, cors);
  const ids = normIds(body.ids);              // 이번 주 완료 단어 id
  const todayIds = normIds(body.todayIds);    // 오늘 완료 단어 id(연속일수 산정용)
  const name = String(body.name || '').slice(0, 40);

  const cid = await getClassId(env, uid, token);
  const classSet = cid ? await getClassWords(env, cid, token) : null;
  const wk = classSet ? countIntersection(ids, classSet) : 0;                 // 천장=배정 단어수
  // 연속일수: 클라가 보낸 값은 무시하고, '오늘 실제로 배포단어를 완료했는지'를 서버가 보고 산정.
  const activeToday = classSet ? countIntersection(todayIds, classSet) > 0 : false;
  const streak = await updateStreak(env, uid, today, activeToday);

  const meta = { n: name, w: wk, s: streak };
  if (cid) await env.RANK_KV.put('c:' + week + ':' + cid + ':' + uid, '', { metadata: meta, expirationTtl: TTL });
  await env.RANK_KV.put('g:' + week + ':' + uid, '', { metadata: meta, expirationTtl: TTL });
  return json({ wk: wk, streak: streak, cid: cid || null, ceiling: classSet ? classSet.size : 0 }, 200, cors);
}

const STREAK_TTL = 60 * 60 * 24 * 45; // 45일 무활동 시 기록 만료(어차피 연속은 하루만 빠져도 끊김)
// 연속일수 순수 전이: rec={last,n} → 오늘 활동 여부로 다음 상태·표시값 계산.
//   활동한 날만 늘고, 오늘/어제까지 이어질 때만 표시(끊기면 0). 클라가 못 부풀린다(서버 관측일 기준).
function streakCompute(rec, today, activeToday) {
  var n = (rec && rec.n) || 0, last = (rec && rec.last) || null, store = null;
  if (activeToday) {
    if (last === today) { /* 오늘 이미 반영됨 */ }
    else if (last === isoAddDays(today, -1)) { n = n + 1; } // 어제 이어서 → +1
    else { n = 1; }                                          // 공백/최초 → 1
    last = today; store = { last: last, n: n };
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

/* ── 순수 로직(단위 테스트 대상) ── */
function validWeek(w) { return typeof w === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(w); }
function clampInt(n, lo, hi) { n = parseInt(n, 10); if (!isFinite(n)) n = 0; return n < lo ? lo : (n > hi ? hi : n); }
function normIds(a) { return Array.isArray(a) ? a.slice(0, 2000).map(function (x) { return String(x).toLowerCase(); }) : []; }
function isoAddDays(ds, n) { var p = ds.split('-').map(Number); var d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)); var z = function (x) { return String(x).padStart(2, '0'); }; return d.getUTCFullYear() + '-' + z(d.getUTCMonth() + 1) + '-' + z(d.getUTCDate()); }
function countIntersection(ids, classSet) {
  const seen = new Set(); let c = 0;
  for (let i = 0; i < ids.length; i++) { const id = ids[i]; if (classSet.has(id) && !seen.has(id)) { seen.add(id); c++; } }
  return c;
}
function sortBoard(a, b) { return (b.wk - a.wk) || (b.streak - a.streak) || (a.name < b.name ? -1 : 1); }
// Firestore REST 문서에서 배포 단어(소문자 텍스트) 집합 추출
function parseClassWords(doc) {
  const vals = doc && doc.fields && doc.fields.words && doc.fields.words.arrayValue && doc.fields.words.arrayValue.values;
  const set = new Set();
  if (vals) for (let i = 0; i < vals.length; i++) {
    const f = vals[i] && vals[i].mapValue && vals[i].mapValue.fields;
    const w = f && f.w && f.w.stringValue;
    if (w) set.add(String(w).toLowerCase());
  }
  return set;
}

/* ── 외부 I/O ── */
async function getClassId(env, uid, token) {
  const doc = await fsGet(env, 'users/' + uid, token);
  return (doc && doc.fields && doc.fields.classId && doc.fields.classId.stringValue) || null;
}
async function getClassWords(env, cid, token) {
  // Firestore 읽기 절감을 위해 반 배포단어를 KV에 5분 캐시.
  const cacheKey = 'pack:' + cid;
  const cached = await env.RANK_KV.get(cacheKey, { type: 'json' });
  if (cached && Array.isArray(cached)) return new Set(cached);
  const doc = await fsGet(env, 'classPacks/' + cid, token);
  if (!doc) return null;
  const set = parseClassWords(doc);
  try { await env.RANK_KV.put(cacheKey, JSON.stringify([...set]), { expirationTtl: 300 }); } catch (e) { /* 캐시 실패 무시 */ }
  return set;
}
async function fsGet(env, docPath, idToken) {
  const r = await fetch(
    'https://firestore.googleapis.com/v1/projects/' + env.PROJECT_ID + '/databases/(default)/documents/' + docPath,
    { headers: { Authorization: 'Bearer ' + idToken } }
  );
  if (!r.ok) return null;
  return await r.json();
}
// Firebase ID 토큰 검증(OCR 워커와 동일 방식): Identity Toolkit accounts:lookup.
async function verifyFirebase(idToken, apiKey) {
  if (!idToken || !apiKey) return null;
  try {
    const r = await fetch(
      'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + encodeURIComponent(apiKey),
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken }) }
    );
    if (!r.ok) return null;
    const d = await r.json();
    return (d.users && d.users[0] && d.users[0].localId) || null;
  } catch (e) { return null; }
}
function json(o, status, cors) {
  return new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...cors } });
}

// 단위 테스트용 export(브라우저/워커 런타임엔 영향 없음)
export const _internals = { validWeek, clampInt, countIntersection, sortBoard, parseClassWords, normIds, isoAddDays, streakCompute };
