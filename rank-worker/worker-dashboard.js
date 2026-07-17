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
     POST /sync   body {name}  → 서버가 doneByDay(유효 단어만)·서버시계로 카운트·KV 저장, {wk} 반환
                                 (week/today 는 신뢰 안 함 — 서버 KST 산정 / KV 쓰기 실패 시 degraded:true)
                                              (KV 쓰기 실패 시 degraded:true 로 알림)
     GET  /board?scope=class|global&week=YYYY-MM-DD  → 정렬된 순위 반환.
                                              '내 행'은 KV 와 무관하게 서버가 즉석 계산해 병합
                                              (쓰기 한도로 내 키가 밀려도 나는 항상 등재되어 보임)
     GET  /teacher?class=CLASSID  → (소유 선생님·마스터만) 반 학생별 '서버 관측' 연속일수·
                                    학습일수·출석맵 반환. 선생님 대시보드가 위조 불가값을 표시.
     모든 응답에 v(코드 리비전) 포함 → 배포 확인은 워커 주소를 브라우저로 열어
     {"error":"unauthorized","v":"…"} 의 v 값을 보면 된다(토큰 불필요).

   필요한 바인딩/환경변수(Cloudflare 대시보드 → Settings → Variables):
     RANK_KV            (KV 네임스페이스 바인딩)  — 점수 저장(키 메타데이터에 표시값)
     FIREBASE_API_KEY   (Variable) — firebase-config.js 의 apiKey(공개값)
     PROJECT_ID         (Variable) — Firebase projectId (예: wordquest-a250d)
     ALLOW_ORIGIN       (선택)      — 허용 도메인(기본 *)
     MASTER_EMAIL       (선택)      — 마스터 이메일 재정의
     RANK_STEP          (선택)      — 보드 키 갱신 최소 진행 단어수(기본 5)
     RANK_FLUSH_MIN     (선택)      — 잔여분 플러시 간격 분(기본 15)
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
    MASTER_EMAIL: (typeof MASTER_EMAIL !== 'undefined') ? MASTER_EMAIL : '',
    RANK_STEP: (typeof RANK_STEP !== 'undefined') ? RANK_STEP : '',
    RANK_FLUSH_MIN: (typeof RANK_FLUSH_MIN !== 'undefined') ? RANK_FLUSH_MIN : '',
    RANK_DAILY_CAP: (typeof RANK_DAILY_CAP !== 'undefined') ? RANK_DAILY_CAP : '',
    RANK_WEEK_CAP: (typeof RANK_WEEK_CAP !== 'undefined') ? RANK_WEEK_CAP : ''
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

const REV = 'r12';             // 코드 리비전 — 배포 확인용(모든 응답 v 필드). 로직 바꾸면 올릴 것.
                              //   r12: 랭킹 연속(🔥)을 att-only(streakFromDays)로 복원 → 자기보고(meta.streak) 위조 차단.
                              //        r11 이 unifiedStreak 로 자기보고를 max 합산해 학생이 콘솔로 meta.streak=99999 를 써서
                              //        연속을 위조하던 구멍을 닫음. 대시보드 /teacher 도 streakFromDays(att) 라 두 화면 값 일치 유지.
                              //        자기보고는 앱 표시 '미검증 힌트'로만(순위·헤드라인 미반영).
                              //   r11: 랭킹 연속(🔥)을 '대시보드와 동일한 max 산식'(unifiedStreak: att ∪ 자기보고 스칼라·활동일)으로 통일 →
                              //        대시보드 표시값과 100% 일치(사용자 요구). 보드 meta 에 감쇠 anchor(d) 저장 → 오늘/어제가 아니면 0 표시
                              //        (끊긴 연속이 랭킹에 잔존하던 역방향 불일치 해소). r10 레거시(d 없음)는 at 로 근사 감쇠 후 다음 sync 에 치유.
                              //   r10: 랭킹 연속(streak)을 att 기반(streakFromDays)으로 통일 → 대시보드 서버검증값(✓)과 일치. 취약한 st: 러닝카운터 제거. 위조불가 유지(att 는 서버 오늘키만·백데이트 불가).
                              //   r9: /teacher 가 학생별 반 보드 점수(weekWords) 실어보냄 → 대시보드가 인게임과 '같은 값' 표시(단일 소스·false-0 제거).
                              //   r8: 반 보드 점수 스로틀 완화(RANK_STEP 기본 5→1) → 인게임 반 랭킹이 대시보드만큼 신선(freshness 파리티).
                              //   r7: getState 빈 words→null(all-pass·하드제로 제거) · att 첫출석 write 유실 시 attDegraded 신호.
                              //   r6: 주간점수를 '서버 관측 원장(att)' 으로 상한(일 RANK_DAILY_CAP·주 RANK_WEEK_CAP,
                              //       백데이트 불가) → doneByDay+words 단독 위조 무력화. r5: 위조 id 필터 + 서버 KST 산정.
const TTL = 60 * 60 * 24 * 16; // 16일(지난 주 자동 만료)

async function handleSync(req, env, uid, token, cors) {
  const body = await req.json().catch(() => ({}));
  const name = String(body.name || '').slice(0, 40);
  // ★ 날짜(week/today)는 클라가 보낸 값을 쓰지 않는다. 서버 시계(KST)로만 산정한다.
  //    (과거: body.today 로 streak 을 계산 → 학생이 연속 날짜를 위조해 임의 연속일수를 만들 수 있었다.)
  const sToday = kstToday(Date.now());
  const week = weekMondayKST(Date.now());   // 이번 주 월요일(주 식별자·집계 창) — 서버가 정한다
  const today = sToday;

  // 집계 원천 = 학생 '본인'의 동기화된 완료기록(users/{uid}/private/state)을 서버가 직접 읽는다.
  //   ★ 위조 방지 1차선(값싼 필터): doneByDay 의 id 중 words 맵 키에 있는 것만 센다(가짜 id 탈락).
  //     단 words 맵도 학생이 자기 문서에 쓰므로 이 필터만으론 위조를 못 막는다(자기참조).
  //   ★ 실질 상한(핵심): 아래 weekLedgerBound — 서버가 관측한 '백데이트 불가 원장(att)' 으로
  //     주간 점수에 상한을 씌운다. att 는 '서버 오늘' 키에만 기록되어 과거를 소급 못 심고,
  //     하루 관측치는 DAILY_CAP, 주간 총합은 WEEK_CAP 으로 제한 → doneByDay 를 통째로 위조해도
  //     '서버가 실제로 며칠에 걸쳐 관측한 만큼'으로 묶인다(원샷 99999 = 즉시 무력화).
  //     (att 읽기 실패 시엔 무클립: 인프라 장애 시 가용성 우선 — 클라는 서버 KV 읽기를 못 건드림.)
  const pst = await getState(env, uid, token);
  const doneByDay = pst.doneByDay, wordIds = pst.wordIds;
  const rawWk = countWeekDone(doneByDay, week, today, wordIds);  // 이번 주(월~오늘) 유효 완료 유니크 수(스냅샷)
  const sCount = countDayDone(doneByDay, sToday, wordIds);       // 오늘 관측 유효수(활동판정·att·응답 공용)
  const activeToday = sCount > 0;                                // 오늘 실제 완료가 있는가(연속일수용)
  const att = await recordAttendance(env, uid, sToday, sCount);  // 서버 원장 읽기+오늘 갱신 → {map, ok, degraded}
  const dailyCap = capOf(env.RANK_DAILY_CAP, 60), weekCap = capOf(env.RANK_WEEK_CAP, 300);
  const bound = att.ok ? weekLedgerBound(att.map, week, today, dailyCap, weekCap) : rawWk; // 읽기실패→무클립(가용성)
  const wk = rawWk < bound ? rawWk : bound;                     // ★ 서버 원장 상한 적용 최종 점수
  // ★ 연속(streak) = 서버 관측 원장(att)만으로 산정(streakFromDays) → 위조 불가(att 는 서버 시계 오늘키에만
  //   기록·백데이트 불가). 자기보고(meta.streak/lastDay/dailyHistory)는 절대 섞지 않는다(2026-07-17 위조 차단):
  //   과거 r11 은 unifiedStreak 로 자기보고를 max 합산 → 학생이 meta.streak=99999 로 랭킹 연속을 위조했음.
  //   att 읽기 실패(인프라 장애·희귀) 시에만 서버관측 st: 카운터로 폴백(학생이 못 쓰는 값·자기보고 미포함).
  let streak, anchor;
  if (att.ok) {
    streak = streakFromDays(att.map, today);
    anchor = anchorDay(att.map, {}, today);        // self={} → att 만으로 anchor(감쇠 기준)
  } else {
    streak = await updateStreak(env, uid, today, activeToday);
    anchor = streak > 0 ? (activeToday ? today : isoAddDays(today, -1)) : null;
  }
  const cid = await getClassId(env, uid, token);             // 반 랭킹 보드 키에만 사용

  const meta = { n: name, w: wk, s: streak, d: anchor };
  // ── KV 쓰기 절약(무료 플랜 하루 1,000회 한도 보호) ──────────────────────────────
  //   실사고(2026-07-16): sync당 최대 5회 put × 전교생 종일 동기화 → 한도 초과 →
  //   put 이 throw → /sync 전체가 500 → 이후 학생들 점수가 안 올라갔다(랭킹 미등재).
  //   대책(boardWriteDue): ①이번 주 키가 없으면 무조건 기록 — '등재'가 최우선(한 주 2회면 됨)
  //   ②등재 후엔 이름·연속 변경, RANK_STEP(기본 1 → 점수 바뀌면 매번 기록: 인게임 반 랭킹을 대시보드와
  //   동일 신선도로 맞춤. Paid KV 라 안전. 옛 기본 5·RANK_FLUSH_MIN 15분은 무료 한도 보호용이었고 env 로 재설정 가능)
  //   ③put 은 개별 try/catch — 한도가 차도 /sync 는 200 + 점수 반환, 실패는 degraded 로 알린다.
  //   (내 점수 '표시'는 /board 가 KV 와 무관하게 즉석 계산해 병합하므로 put 이 밀려도 안 사라짐)
  const nowSec = Math.floor(Date.now() / 1000);
  const step = env.RANK_STEP ? clampInt(env.RANK_STEP, 1, 1000) : 1;  // 기본 1: 점수 바뀌면 매 sync 기록 → 인게임 반 랭킹을 대시보드만큼 신선하게(Paid KV 라 안전). env 로 상향 가능.
  const flushSec = (env.RANK_FLUSH_MIN ? clampInt(env.RANK_FLUSH_MIN, 1, 1440) : 15) * 60;
  let degraded = false;
  if (cid) { if (!(await putBoard(env, 'c:' + week + ':' + cid + ':' + uid, meta, nowSec, step, flushSec))) degraded = true; }
  if (!(await putBoard(env, 'g:' + week + ':' + uid, meta, nowSec, step, flushSec))) degraded = true;

  // ── 선생님 대시보드용 '서버 관측' 명단(att 기록은 위 recordAttendance 에서 이미 함) ──────────
  //   att 는 '서버 시계상 오늘' 키에만 기록되므로(클라가 보낸 today 무시) 학생이 과거 날짜/연속을 못 심는다.
  if (cid) await recordMember(env, cid, uid, name);       // 반 명단(선생님이 att를 조회하려면 uid 열거 필요)

  return json({ wk: wk, streak: streak, cid: cid || null, ceiling: countAllDone(doneByDay, wordIds), bound: bound, dailyCap: dailyCap, weekCap: weekCap, degraded: degraded, attDegraded: att.degraded }, 200, cors);
}

// 보드 키(c:/g:) 저장 — boardWriteDue 가 true 일 때만 put. 성공/생략 true, put 실패(한도 등) false.
async function putBoard(env, key, meta, nowSec, step, flushSec) {
  let prev = null;
  try { prev = (await env.RANK_KV.getWithMetadata(key)).metadata; } catch (e) { /* 없음 */ }
  if (!boardWriteDue(prev, meta, nowSec, step, flushSec)) return true;
  try {
    await env.RANK_KV.put(key, '', { metadata: { n: meta.n, w: meta.w, s: meta.s, d: meta.d || null, at: nowSec }, expirationTtl: TTL });
    return true;
  } catch (e) { return false; } // 한도 등 — 다음 sync 때 재시도
}

const ATT_TTL = 60 * 60 * 24 * 45;   // 45일 롤링(선생님 대시보드 히트맵 ~최근 5주)
const MEM_TTL = 60 * 60 * 24 * 45;   // 반 명단 마커: 45일 내 동기화한 학생만 열거

// att:{uid} = { 'YYYY-MM-DD': 그날 서버가 관측한 완료 단어수 } — 서버 시계상 오늘만 기록/증가.
//   KV 쓰기 절약: 오늘 첫 기록이거나 5단어 이상 늘었을 때만 저장(하루 최대 ~4단어 과소집계 허용
//   — 출석/학습일수 판정에는 영향 없음). 무료 한도(1,000/일) 보호.
async function recordAttendance(env, uid, today, count) {
  const key = 'att:' + uid;
  let map = null, ok = true, degraded = false;
  try { map = await env.RANK_KV.get(key, { type: 'json' }); } catch (e) { ok = false; /* 인프라 장애 — 무클립 신호 */ }
  map = pruneDays((map && typeof map === 'object') ? map : {}, 40, today);
  if (count > 0) {   // 완료 없는 sync 는 오늘 키를 만들지 않는다(studyDays/streak 오염 방지)
    const prev = (typeof map[today] === 'number') ? map[today] : 0;
    map[today] = prev > count ? prev : count;   // 하루 중 진행하며 늘어난 값 반영(감소 없음)
    if (map[today] > prev && (prev === 0 || map[today] - prev >= 5)) {
      try { await env.RANK_KV.put(key, JSON.stringify(map), { expirationTtl: ATT_TTL }); }
      catch (e) { if (prev === 0) degraded = true; /* '그날 첫 출석' 기록 유실 → 관측 신호. 다음 sync 가 prev=0 을 다시 보고 재기록=자기치유(재시도 안 함: 쓰기증폭 회피) */ }
    }
  }
  return { map: map, ok: ok, degraded: degraded };   // ok=false(읽기 throw)→무클립 · degraded=오늘 첫 출석 write 유실(관측용)
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
  const week = weekMondayKST(Date.now());   // 반 보드 키(c:주:반:uid) 조회용 — 인게임 랭킹과 같은 주 기준
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
      // ★ 인게임 반 랭킹과 '같은 값'으로 통일: /board 가 쓰는 반 보드 KV(c:주:반:uid)의 점수 w 를 실어 보낸다.
      //   대시보드가 이 값을 그대로 표시 → 두 화면 100% 일치(자체 att-상한 재계산 폐기 → false-0 제거).
      //   보드 키 없으면(0단어·미동기화) null → 대시보드가 기존 계산으로 폴백.
      let weekWords = null;
      try { const bm = (await env.RANK_KV.getWithMetadata('c:' + week + ':' + cid + ':' + suid)).metadata; if (bm && typeof bm.w === 'number') weekWords = bm.w; } catch (e) { /* 없음 → null */ }
      out.push({ uid: suid, name: nm, streak: streakFromDays(att, today), studyDays: Object.keys(att).length, days: att, weekWords: weekWords });
    }
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);
  const dailyCap = capOf(env.RANK_DAILY_CAP, 60), weekCap = capOf(env.RANK_WEEK_CAP, 300);
  return json({ list: out, today: today, dailyCap: dailyCap, weekCap: weekCap }, 200, cors);
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
  // 주(week)도 서버 시계로 고정한다(클라가 보낸 week 무시) — sync 가 서버 주 키로 저장하므로 일치시킨다.
  const week = weekMondayKST(Date.now());
  const today = kstToday(Date.now()), yesterday = isoAddDays(today, -1);   // 연속 감쇠 판정용
  const scope = url.searchParams.get('scope') === 'global' ? 'global' : 'class';

  // users/{uid} 를 한 번 읽어 반ID(반 보드 프리픽스)와 표시이름('내 행' 즉석 병합)을 얻는다.
  const info = await getUserInfo(env, uid, token);
  let prefix;
  if (scope === 'global') {
    prefix = 'g:' + week + ':';
  } else {
    if (!info.cid) return json({ list: [] }, 200, cors);
    prefix = 'c:' + week + ':' + info.cid + ':';
  }

  const out = [];
  let cursor;
  try {
    do {
      const res = await env.RANK_KV.list({ prefix: prefix, cursor: cursor, limit: 1000 });
      for (const k of res.keys) {
        const m = k.metadata || {};
        const kid = k.name.slice(prefix.length);
        // ★ 연속 감쇠(정렬 이전에 적용 → tiebreak 도 감쇠 후 값 사용): 끊긴 연속이 랭킹에 잔존하던 문제 해소.
        //   r11 meta 는 anchor(d) 로 오늘/어제가 아니면 0. r10 레거시(d 없음)는 at(마지막 기록)로 근사 감쇠.
        const rawS = m.s || 0;
        let dispS = rawS;
        if (rawS > 0) {
          if (typeof m.d === 'string') dispS = (m.d === today || m.d === yesterday) ? rawS : 0;
          else dispS = staleByAt(m.at, today) ? 0 : rawS;
        }
        out.push({ uid: kid, name: m.n || '익명', wk: m.w || 0, streak: dispS, me: kid === uid });
      }
      cursor = res.list_complete ? null : res.cursor;
    } while (cursor);
  } catch (e) {
    // KV list 한도(무료 1,000회/일) 등 — '빈 랭킹'으로 속이지 말고 오류임을 알린다(클라가 구분 표시).
    return json({ error: 'kv_limit', detail: String((e && e.message) || e).slice(0, 120) }, 503, cors);
  }

  // ── '내 행' 즉석 병합: 내 점수는 KV 키와 무관하게 서버가 지금 계산해 넣는다(읽기만, 쓰기 0회).
  //   쓰기 한도로 put 이 밀려도 "내가 랭킹에 안 보인다"는 일이 없고, 스로틀로 지연된 내 점수도
  //   보드에서는 항상 최신으로 보인다. (다른 학생 행은 KV 값 — 최대 RANK_STEP-1 단어 지연 가능)
  try {
    const pst = await getState(env, uid, token);  // words 포함(위조 id 필터용) — mask 없이 읽는다
    if (pst.wordIds !== null || Object.keys(pst.doneByDay).length) {
      const dbd = pst.doneByDay, wordIds = pst.wordIds;
      const sToday = kstToday(Date.now());
      // ★ 내 행도 서버 원장(att) 상한을 적용한다(sync 와 동일 산식) — 옛 비캡 위조 KV 값을 밀어낸다.
      let attMap = null, attOk = true;
      try { attMap = await env.RANK_KV.get('att:' + uid, { type: 'json' }); } catch (e) { attOk = false; }
      attMap = (attMap && typeof attMap === 'object') ? attMap : {};
      const liveToday = countDayDone(dbd, sToday, wordIds);
      if (liveToday > (attMap[sToday] | 0)) attMap[sToday] = liveToday;   // 오늘만 live 보정(이번 세션 즉시반영)
      const dailyCap = capOf(env.RANK_DAILY_CAP, 60), weekCap = capOf(env.RANK_WEEK_CAP, 300);
      const rawLive = countWeekDone(dbd, week, sToday, wordIds);          // 유효 단어만(스냅샷)
      const bound = attOk ? weekLedgerBound(attMap, week, sToday, dailyCap, weekCap) : rawLive; // 읽기실패→무클립
      const wkLive = rawLive < bound ? rawLive : bound;
      let st = null;
      try { st = await env.RANK_KV.get('st:' + uid, { type: 'json' }); } catch (e) { /* 없음 */ }
      // ★ 내 행 연속도 att 만으로 산정(streakFromDays) — 대시보드·남의 행과 동일 산식(오늘 live att 보정 포함).
      //   streakFromDays 는 오늘/어제 att 가 없으면 0 → 별도 감쇠 불필요(끊긴 내 연속도 0). 자기보고 미포함(위조 차단).
      //   att 읽기 실패 시에만 서버관측 st: 카운터 폴백(가용성).
      let stLive = streakFromDays(attMap, sToday);
      if (!attOk) { const _fb = streakCompute(st, sToday, countDayDone(dbd, sToday, wordIds) > 0).display; if (_fb > stLive) stLive = _fb; }
      const idx = out.findIndex(function (e) { return e.uid === uid; });
      const meRow = { uid: uid, name: info.name || (idx >= 0 ? out[idx].name : '') || '익명', wk: wkLive, streak: stLive, me: true };
      if (idx >= 0) out[idx] = meRow;   // 무조건 교체: wkLive 는 지금 계산한 캡 권위값(스로틀 지연·옛 위조 KV 모두 정정)
      else out.push(meRow);
    }
  } catch (e) { /* 상태문서 읽기 실패 — KV 행이라도 그대로 응답 */ }

  out.sort(sortBoard);
  // 전체 보드는 상위 100 — 단, '내 행'이 잘려나가면 끝에 보존(클라가 '⋯' 아래에 내 점수 표시).
  let list = out;
  if (scope === 'global' && out.length > 100) {
    list = out.slice(0, 100);
    const mi = out.findIndex(function (e) { return e.me; });
    if (mi >= 100) list.push(out[mi]);
  }
  return json({ list: list }, 200, cors);
}

/* ── 순수 로직(단위 테스트 대상) ── */
function validWeek(w) { return typeof w === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(w); }
function clampInt(n, lo, hi) { n = parseInt(n, 10); if (!isFinite(n)) n = 0; return n < lo ? lo : (n > hi ? hi : n); }
// 캡 파라미터 해석: env 값이 있으면 정수 클램프, 없으면 기본값. (RANK_DAILY_CAP/RANK_WEEK_CAP)
function capOf(v, def) { return (v === undefined || v === null || v === '') ? def : clampInt(v, 1, 1000000); }
// 서버 관측 원장(att)로 이번 주 점수 상한: Σ_{월≤d≤오늘} min(att[d], dailyCap), 총합은 weekCap 로 컷.
//   att 는 '서버 오늘' 키에만 기록(recordAttendance)되어 소급 위조 불가 → 클라 스냅샷 단독 위조를 무력화한다.
function weekLedgerBound(att, weekMonday, today, dailyCap, weekCap) {
  var sum = 0;
  for (var d in att) {
    if (Object.prototype.hasOwnProperty.call(att, d) && d >= weekMonday && d <= today) {
      var v = att[d];
      if (typeof v === 'number' && v > 0) { v = Math.floor(v); sum += (v < dailyCap ? v : dailyCap); }
    }
  }
  return sum < weekCap ? sum : weekCap;
}
function normIds(a) { return Array.isArray(a) ? a.slice(0, 2000).map(function (x) { return String(x).toLowerCase(); }) : []; }
function isoAddDays(ds, n) { var p = ds.split('-').map(Number); var d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)); var z = function (x) { return String(x).padStart(2, '0'); }; return d.getUTCFullYear() + '-' + z(d.getUTCMonth() + 1) + '-' + z(d.getUTCDate()); }
// KST(UTC+9, 서머타임 없음) 기준 'YYYY-MM-DD' — 클라이언트 today()(로컬=한국)·doneByDay 키와 일치시킨다.
//   nowMs 는 Date.now(). 서버 시계 기준이라 학생이 날짜를 못 바꾼다(출석·연속 위조 차단의 핵심).
function kstToday(nowMs) { var d = new Date(nowMs + 9 * 3600 * 1000); var z = function (x) { return String(x).padStart(2, '0'); }; return d.getUTCFullYear() + '-' + z(d.getUTCMonth() + 1) + '-' + z(d.getUTCDate()); }
// 출석맵에서 today-keepDays 보다 오래된 날짜 제거(KV 크기 억제).
function pruneDays(map, keepDays, today) { var cut = isoAddDays(today, -keepDays), out = {}; for (var d in map) { if (Object.prototype.hasOwnProperty.call(map, d) && d > cut) out[d] = map[d]; } return out; }
// 서버 관측 출석맵에서 연속일수: 오늘(없으면 어제)부터 하루도 안 빠지고 이어진 날 수. 끊기면 0.
function streakFromDays(days, today) { if (!days) return 0; var cur = today; if (!days[cur]) { cur = isoAddDays(today, -1); if (!days[cur]) return 0; } var n = 0; while (days[cur]) { n++; cur = isoAddDays(cur, -1); } return n; }
// Firestore REST 숫자 안전 파싱: 정수는 integerValue:"문자열", 실수는 doubleValue(숫자/문자열)로 온다.
function fsNum(v) {
  if (!v || typeof v !== 'object') return 0;
  var raw = (v.integerValue != null) ? v.integerValue : (v.doubleValue != null ? v.doubleValue : null);
  if (raw == null) return 0;
  var n = Number(raw); return isFinite(n) ? n : 0;
}
// 상태문서(private/state)의 meta 에서 '자기보고 연속 원천' 파싱 — 대시보드 card() 가 쓰는
//   summary.streak / summary.daily 와 같은 원천(meta.streak/lastDay/dailyHistory)·같은 창(35일)이다.
//   { streak: 0..99999(클램프), lastDay: 'YYYY-MM-DD'|null, activeDays: {날짜:1}(dailyHistory 의 a>0, 최근 35일) }
function parseSelfReport(doc, today) {
  var out = { streak: 0, lastDay: null, activeDays: {} };
  var meta = doc && doc.fields && doc.fields.meta && doc.fields.meta.mapValue && doc.fields.meta.mapValue.fields;
  if (!meta) return out;
  var s = Math.floor(fsNum(meta.streak));             // 스칼라 연속(콘솔 위조 상한 0..99999)
  out.streak = s < 0 ? 0 : (s > 99999 ? 99999 : s);
  var ld = meta.lastDay && meta.lastDay.stringValue;  // 'YYYY-MM-DD' 형식만 신뢰
  if (typeof ld === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ld)) out.lastDay = ld;
  var dh = meta.dailyHistory && meta.dailyHistory.mapValue && meta.dailyHistory.mapValue.fields;
  if (dh) {
    var cut = isoAddDays(today, -35);                 // 대시보드 summary.daily 창(최근 35일)과 동일
    for (var day in dh) {
      if (!Object.prototype.hasOwnProperty.call(dh, day)) continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day <= cut || day > today) continue;
      var ef = dh[day] && dh[day].mapValue && dh[day].mapValue.fields;
      if (ef && Math.floor(fsNum(ef.a)) > 0) out.activeDays[day] = 1;   // Math.floor = 대시보드 heatInt(trunc) 와 완전 동치(소수 a 경계까지)
    }
  }
  return out;
}
// ⚠ 미사용(2026-07-17~ r12): 연속은 att-only(streakFromDays)로만 산정한다 — 자기보고 위조 차단.
//   이 함수와 parseSelfReport(getState.self)는 프로덕션 streak 경로에서 호출하지 않는다. 삭제하지 않고
//   보존하는 이유: 히스토리 + 향후 '미검증 힌트'를 서버화할 때 참고용. ★호출부를 부활시키지 말 것.
// (원래 설명) 랭킹 연속 = 대시보드 card() 와 '동일한 max 산식':
//     max( att 걷기(위조불가), 살아있는 자기보고 스칼라, att∪자기보고활동일 합집합 걷기 )
//   대시보드가 이미 ✓ 없이 표시하는 자기보고를 att 와 합쳐, 두 화면이 같은 숫자를 낸다.
//   주 순위 지표 wk 는 여전히 att 상한(위조불가) — 연속은 동점 tiebreak·표시에만 쓰인다.
function unifiedStreak(attMap, self, today) {
  attMap = attMap || {}; self = self || { streak: 0, lastDay: null, activeDays: {} };
  var y = isoAddDays(today, -1);
  var aliveScalar = (self.lastDay === today || self.lastDay === y) ? (self.streak || 0) : 0;
  var srv = streakFromDays(attMap, today);
  var union = {}, d1, d2, ad = self.activeDays || {};
  for (d1 in attMap) { if (Object.prototype.hasOwnProperty.call(attMap, d1)) union[d1] = 1; }
  for (d2 in ad) { if (Object.prototype.hasOwnProperty.call(ad, d2)) union[d2] = 1; }
  var uni = streakFromDays(union, today);
  var m = srv; if (aliveScalar > m) m = aliveScalar; if (uni > m) m = uni; return m;
}
// 감쇠 anchor: 연속을 '살아있게' 하는 가장 최근 날짜(오늘/어제) — 없으면 null(연속 0).
//   union(att∪자기보고활동일)·자기보고 lastDay 를 모두 후보로 삼는다 → 프리즈(lastDay=어제, 활동일 없음)
//   학생도 anchor 를 얻는다. unifiedStreak>0 이면 세 성분 중 하나는 오늘/어제 anchor 를 가지므로 d 는 항상 존재.
function anchorDay(attMap, self, today) {
  attMap = attMap || {}; self = self || {};
  var y = isoAddDays(today, -1), ad = self.activeDays || {};
  if (attMap[today] || ad[today] || self.lastDay === today) return today;
  if (attMap[y] || ad[y] || self.lastDay === y) return y;
  return null;
}
// r10 레거시 meta(anchor d 없음) 근사 감쇠: 마지막 보드 기록 시각(at)의 KST 날짜가 오늘/어제가 아니면
//   그 학생은 그 뒤로 sync 를 안 했다는 뜻 → 연속이 끊겼다고 보고 0 처리(다음 sync 때 d 가 생겨 정밀 치유).
function staleByAt(atSec, today) {
  if (typeof atSec !== 'number') return false;   // 알 수 없음 → 무회귀(표시 유지)
  var atDay = kstToday(atSec * 1000), y = isoAddDays(today, -1);
  return !(atDay === today || atDay === y);
}
// id 가 '유효(실제 단어)'인지: wordIds 가 주어지면 그 집합에 있어야 통과, 없으면(null) 전부 통과.
//   wordIds=null 은 '읽기 실패 or words 맵 비어있음 → 판정 보류'(가용성 우선; getState 가 빈 words 를 null 로 승격).
function validId(id, wordIds) { return wordIds ? wordIds.has(id) : true; }
// 이번 주(week=월요일 ~ today, ISO 날짜 문자열 비교) '유효' 완료 단어 유니크 수. 종류(개인·기본팩·배포) 불문.
function countWeekDone(dbd, week, today, wordIds) {
  const seen = new Set();
  for (const d in dbd) {
    if (d >= week && d <= today) { const a = normIds(dbd[d]); for (let i = 0; i < a.length; i++) if (validId(a[i], wordIds)) seen.add(a[i]); }
  }
  return seen.size;
}
// 특정 날짜의 '유효' 완료 유니크 수(오늘 활동 여부·출석 카운트용).
function countDayDone(dbd, day, wordIds) {
  const a = normIds(dbd && dbd[day]); const seen = new Set();
  for (let i = 0; i < a.length; i++) if (validId(a[i], wordIds)) seen.add(a[i]);
  return seen.size;
}
// 보관된 완료기록(최근 9일 롤링) 전체의 '유효' 유니크 수 — 응답 참고값(ceiling)용.
function countAllDone(dbd, wordIds) {
  const seen = new Set();
  for (const d in dbd) { const a = normIds(dbd[d]); for (let i = 0; i < a.length; i++) if (validId(a[i], wordIds)) seen.add(a[i]); }
  return seen.size;
}
// 이번 주 월요일(KST) 'YYYY-MM-DD' — sync/board 의 주 식별자. 서버 시계 기준이라 클라가 못 바꾼다.
function weekMondayKST(nowMs) {
  const t = kstToday(nowMs), p = t.split('-').map(Number);
  const dow = (new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay() + 6) % 7; // 월=0 … 일=6
  return isoAddDays(t, -dow);
}
function sortBoard(a, b) { return (b.wk - a.wk) || (b.streak - a.streak) || (a.name < b.name ? -1 : 1); }
// 보드 키(c:/g:) put 필요 판정 — 무료 KV 쓰기 한도(1,000/일) 보호의 핵심 규칙.
//   ① 키가 없으면(이번 주 첫 sync) 무조건 기록: '랭킹 등재'가 최우선(학생당 주 2회 put 이면 된다).
//   ② 등재 후엔 이름/연속 변경 → 기록(연속은 하루 1번, 이름은 드묾).
//   ③ 점수 진행은 step 단어 이상 모였을 때만 기록(학습 중 sync 폭주 흡수).
//   ④ 다만 점수가 바뀐 채 flushSec 지났으면 잔여분 기록(세션 끝 점수도 결국 정확히 정착).
//   ⑤ 점수 감소(데이터 리셋 등 예외)는 즉시 기록.
function boardWriteDue(prev, meta, nowSec, step, flushSec) {
  if (!prev) return true;
  // 이름·연속(s)·감쇠 anchor(d) 변경 → 기록. (d 만 바뀌는 케이스: 연속이 끊겼다 같은 값으로 재시작하며
  //   w 도 불변인 복습날 등 — d 를 안 쓰면 남의 행이 낡은 anchor 로 잘못 감쇠. r10→r11 이관도 이 비교로 트리거.)
  if (prev.n !== meta.n || prev.s !== meta.s || (prev.d || null) !== (meta.d || null)) return true;
  var dw = (meta.w | 0) - (prev.w | 0);
  if (dw === 0) return false;
  if (dw < 0 || dw >= step) return true;
  var at = (typeof prev.at === 'number') ? prev.at : 0;
  return (nowSec - at) >= flushSec;
}
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
// 상태문서의 words 맵 '키(단어 id)' 집합 — 완료 id 위조 필터용. words 필드 없으면 빈 Set.
function parseWordIds(doc) {
  const w = doc && doc.fields && doc.fields.words && doc.fields.words.mapValue && doc.fields.words.mapValue.fields;
  const s = new Set();
  if (w) for (const id in w) { if (Object.prototype.hasOwnProperty.call(w, id)) s.add(String(id).toLowerCase()); }
  return s;
}

/* ── 외부 I/O ── */
async function getClassId(env, uid, token) {
  const doc = await fsGet(env, 'users/' + uid, token, 'classId');
  return (doc && doc.fields && doc.fields.classId && doc.fields.classId.stringValue) || null;
}
// users/{uid} 에서 반ID + 표시이름을 한 번에 읽는다(/board 의 '내 행' 즉석 병합용).
async function getUserInfo(env, uid, token) {
  const doc = await fsGet(env, 'users/' + uid, token, ['classId', 'profile.name']);
  const f = (doc && doc.fields) || {};
  const prof = f.profile && f.profile.mapValue && f.profile.mapValue.fields;
  return {
    cid: (f.classId && f.classId.stringValue) || null,
    name: String((prof && prof.name && prof.name.stringValue) || '').slice(0, 40)
  };
}
// 학생 본인 상태문서(users/{uid}/private/state)를 읽어 { doneByDay, wordIds } 반환.
//   ★ 위조 필터를 위해 words 맵 키가 필요해 mask 없이 읽는다(과거엔 mask=meta 로 words 를 안 받았음).
//     읽기 실패(null)면 wordIds=null → 판정 보류(가용성). 규칙상 본인 문서라 학생 토큰으로 읽힘.
async function getState(env, uid, token) {
  const doc = await fsGet(env, 'users/' + uid + '/private/state', token);
  const today = kstToday(Date.now());
  if (!doc) return { doneByDay: {}, wordIds: null, self: { streak: 0, lastDay: null, activeDays: {} } };
  const ids = parseWordIds(doc);
  // words 맵이 비어있으면(리셋 직후·부분쓰기 등 이상 상태) 필터 대상이 없다 → all-pass(null)로 승격.
  //   '문서는 있는데 words 없음'이 doneByDay 완료를 전부 탈락시켜 출석/연속을 0으로 만드는 하드제로 비대칭 제거
  //   (읽기 실패 null 과 동일 가용성 취급). 정상 학생(words 보유)은 무변경 · 위조상한은 att 캡이라 완화 무해.
  //   self = 자기보고 연속 원천(meta.streak/lastDay/dailyHistory) — mask 없이 읽으므로 추가 read 비용 0.
  return { doneByDay: parseDoneByDay(doc), wordIds: ids.size ? ids : null, self: parseSelfReport(doc, today) };
}
async function fsGet(env, docPath, idToken, mask) {
  var url = 'https://firestore.googleapis.com/v1/projects/' + env.PROJECT_ID + '/databases/(default)/documents/' + docPath;
  if (mask) {
    var mm = Array.isArray(mask) ? mask : [mask];
    url += '?' + mm.map(function (m) { return 'mask.fieldPaths=' + encodeURIComponent(m); }).join('&');
  }
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
// 모든 응답에 v(코드 리비전)를 실어 배포 확인을 쉽게 한다: 워커 주소를 그냥 열면
//   {"error":"unauthorized","v":"r4"} — v 가 보이면 이 코드가 라이브라는 뜻(토큰 불필요).
function json(o, status, cors) {
  return new Response(JSON.stringify(Object.assign({ v: REV }, o)), { status, headers: { 'content-type': 'application/json', ...cors } });
}
// (단위 테스트용 export 는 모듈 형식인 worker.js 에만 있다 — 이 파일은 붙여넣기 전용)
