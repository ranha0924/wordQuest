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
     RL_SYNC_PER_MIN    (선택)      — /sync uid·분당 상한(기본 10, P1 가용성 방어)
     RL_BOARD_PER_MIN   (선택)      — /board uid·분당 상한(기본 30, P1)
     AUTH_CACHE_SEC     (선택)      — verifyFirebase 결과 KV 캐시 TTL초(기본 300, P2)
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
    RANK_WEEK_CAP: (typeof RANK_WEEK_CAP !== 'undefined') ? RANK_WEEK_CAP : '',
    // ── r13 서버 세션 채점 env(★신규 — 모듈 형식과 동일하게 통과시켜야 SW 배포에서도 동작) ──
    QUIZ_SECRET: (typeof QUIZ_SECRET !== 'undefined') ? QUIZ_SECRET : '',
    ANSWER_SALT: (typeof ANSWER_SALT !== 'undefined') ? ANSWER_SALT : '',
    PROJECT_NUMBER: (typeof PROJECT_NUMBER !== 'undefined') ? PROJECT_NUMBER : '',
    APPCHECK_ENFORCE: (typeof APPCHECK_ENFORCE !== 'undefined') ? APPCHECK_ENFORCE : '',
    ATT_RETIRED: (typeof ATT_RETIRED !== 'undefined') ? ATT_RETIRED : '',
    PACK_WEEK_CAP: (typeof PACK_WEEK_CAP !== 'undefined') ? PACK_WEEK_CAP : '',
    // PERSONAL_WEEK_CAP: r16 에서 개인단어 랭킹 크레딧 제거로 미사용(셔임 패스스루 삭제).
    PACK_DAILY_BURST: (typeof PACK_DAILY_BURST !== 'undefined') ? PACK_DAILY_BURST : '',
    SESSION_MAX: (typeof SESSION_MAX !== 'undefined') ? SESSION_MAX : '',
    SESSION_TTL: (typeof SESSION_TTL !== 'undefined') ? SESSION_TTL : '',
    RL_SESS_PER_MIN: (typeof RL_SESS_PER_MIN !== 'undefined') ? RL_SESS_PER_MIN : '',
    RL_ANS_PER_MIN: (typeof RL_ANS_PER_MIN !== 'undefined') ? RL_ANS_PER_MIN : '',
    FLAG_FAST_MS: (typeof FLAG_FAST_MS !== 'undefined') ? FLAG_FAST_MS : '',
    // ── r17 서버 출제 MC(2단계) env ──
    MC_WEEK_CAP: (typeof MC_WEEK_CAP !== 'undefined') ? MC_WEEK_CAP : '',
    MC_ATTEMPTS_PER_ID: (typeof MC_ATTEMPTS_PER_ID !== 'undefined') ? MC_ATTEMPTS_PER_ID : '',
    FLAG_LOWACC_MIN: (typeof FLAG_LOWACC_MIN !== 'undefined') ? FLAG_LOWACC_MIN : '',
    FLAG_LOWACC_RATE: (typeof FLAG_LOWACC_RATE !== 'undefined') ? FLAG_LOWACC_RATE : ''
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
  const authUser = await verifyFirebaseCached(env, token);
  if (!authUser || !authUser.uid) return json({ error: 'unauthorized' }, 401, cors);
  const uid = authUser.uid;

  try {
    if (req.method === 'POST' && path.endsWith('/sync')) { const rl = await rlHit(env, 'rlsync:' + uid + ':' + Math.floor(Date.now() / 60000), capOf(env.RL_SYNC_PER_MIN, 10), 120); if (!rl.ok) return json({ error: 'rate_limited' }, 429, cors); const ac = await verifyAppCheck(req.headers.get('X-Firebase-AppCheck'), env); if (!ac.ok) return json({ error: 'appcheck', reason: ac.reason }, 403, cors); return await handleSync(req, env, uid, token, cors); }  // r16: /sync 도 App Check 게이트(크레딧·att 기록 경로). APPCHECK_ENFORCE 켜기 전엔 도먼트(무해).
    if (req.method === 'GET' && path.endsWith('/board')) { const rl = await rlHit(env, 'rlboard:' + uid + ':' + Math.floor(Date.now() / 60000), capOf(env.RL_BOARD_PER_MIN, 30), 120); if (!rl.ok) return json({ error: 'rate_limited' }, 429, cors); return await handleBoard(env, uid, token, url, cors); }
    if (req.method === 'GET' && path.endsWith('/teacher')) return await handleTeacher(env, authUser, token, url, cors);
    // 서버 세션 채점(r13): 랭킹 크레딧을 '서버 발급 세션에서 정답 대조 통과' 로만. App Check 게이트.
    if (req.method === 'POST' && path.endsWith('/quiz/start')) { const ac = await verifyAppCheck(req.headers.get('X-Firebase-AppCheck'), env); if (!ac.ok) return json({ error: 'appcheck', reason: ac.reason }, 403, cors); return await handleQuizStart(req, env, uid, token, cors); }
    if (req.method === 'POST' && path.endsWith('/quiz/submit')) { const ac = await verifyAppCheck(req.headers.get('X-Firebase-AppCheck'), env); if (!ac.ok) return json({ error: 'appcheck', reason: ac.reason }, 403, cors); return await handleQuizSubmit(req, env, uid, token, cors); }
    return json({ error: 'not_found' }, 404, cors);
  } catch (e) {
    return json({ error: 'server_error', detail: String((e && e.message) || e).slice(0, 200) }, 500, cors);
  }
}

const REV = 'r17';             // 코드 리비전 — 배포 확인용(모든 응답 v 필드). 로직 바꾸면 올릴 것.
//   r17: 서버 출제 MC·index 채점(2단계) — /quiz/start 가 뜻 4지선다를 내고 정답 index 는 세션에만, /quiz/submit 은 '고른 번호'만 채점.
//        → id-echo 원천 무효. 랭킹 = 서버 MC 검증분(ver_mc)만(rankWk) — att·hash 은퇴 = 랭킹 리셋. 재시도상한·저정답률 탐지 추가.
//        ★정직한 한계: 뜻이 공개파일이라 '뜻 긁는 인페이지 스크립터'는 여전히 통과(App Check enforce=앱 밖 차단·탐지 미탐). PACK_MC 평문 번들 배포 필요.
//   r16: App Check 우선(1단계) — /sync 에도 App Check 게이트(enforce 전 도먼트) + /quiz/submit 무채점 개인단어 크레딧 제거(위조 곁길 봉쇄).
//        랭킹은 팩 검증분만(개인은 att 관측으로만 반영). 인페이지 위조(팩 id-에코·att 시딩)는 미제거 — App Check enforce 로 '앱 밖'만 차단(정직).
//   r15: 가용성 방어 — /sync·/board 에 uid·분당 rate-limit(P1), verifyFirebase 결과 KV 캐시(P2, accounts:lookup 증폭 제거).
                              //   r14: 이상 탐지 — /quiz/submit 이 비인간적 제출속도(클라 t 중앙간격)·일 버스트 초과를
                              //        flag:{uid} 에 누적, /teacher 가 학생별 반환 → 대시보드 ⚠️. 완전차단 불가(C1)의 실용 대안(탐지+교사 실격).
                              //   r13: 서버 세션 채점 — /quiz/start·/quiz/submit. 랭킹 크레딧을 '서버 발급 세션에서 정답 대조
                              //        통과(팩) 또는 세션정합(개인)' 로만 인정 → 콘솔 doneByDay '한 줄 위조'는 무력화(트리비얼 위조 사망).
                              //        ★단 id-에코(답=id)로 결정적 스크립터는 상한까지 위조 가능 = 완전차단 아님(C1). 이상탐지(r14)+상한으로 억제.
                              //        팩=무제한(PACK_WEEK_CAP)·개인=상한, 버스트 PACK_DAILY_BURST. App Check(JWKS) 심층방어.
                              //        전환기 점수 = ATT_RETIRED? verWk : max(attWk, verWk)(회귀0·att 은퇴 시 완전 ver). REV 는
                              //        정답번들(PACK_ANSWERS)·클라 세션훅과 함께 배포.
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

// ── 팩 정답 해시 번들 (빌드 산출물 · scripts/build-pack-answers.mjs 가 마커 사이를 채운다) ──
//   r17: 서버 출제 4지선다용 평문 번들 — PACK_MC[id]={m:뜻, w:단어}. 정답 텍스트를 클라가 못 보내므로 해시/솔트 불요.
//   ★단어파일이 바뀌면 build-pack-answers.mjs 재실행→두 트윈 갱신→재배포. 비어 있으면 팩 출제 0건(랭킹 크레딧 없음).
/*__PACK_ANSWERS_START__*/
// 생성물: scripts/build-pack-answers.mjs (id 1131개). 직접 수정 금지 — 스크립트로 재생성.
const PACK_MC = {"abandon":{"m":"버리다; 포기하다","w":"abandon"},"abnormal":{"m":"비정상적인","w":"abnormal"},"abroad":{"m":"해외로","w":"abroad"},"absorb":{"m":"흡수하다","w":"absorb"},"abstract":{"m":"추상적인","w":"abstract"},"abundant":{"m":"풍부한","w":"abundant"},"abuse":{"m":"학대; 남용","w":"abuse"},"accept":{"m":"받아들이다","w":"accept"},"access":{"m":"접근, 이용(권리); 접근하다","w":"access"},"accompany":{"m":"동반하다","w":"accompany"},"accomplish":{"m":"해내다","w":"accomplish"},"accurate":{"m":"정확한","w":"accurate"},"accuse":{"m":"고발하다","w":"accuse"},"achieve":{"m":"성취하다","w":"achieve"},"achievement":{"m":"성취; 업적","w":"achievement"},"acquire":{"m":"습득하다","w":"acquire"},"activate":{"m":"활성화하다","w":"activate"},"active":{"m":"활동적인","w":"active"},"adapt":{"m":"적응하다","w":"adapt"},"address":{"m":"다루다 (문제를)","w":"address"},"adequate":{"m":"적절한","w":"adequate"},"adjust":{"m":"조정하다","w":"adjust"},"admire":{"m":"감탄하다","w":"admire"},"admit":{"m":"인정하다","w":"admit"},"adopt":{"m":"채택하다","w":"adopt"},"advent":{"m":"출현, 도래","w":"advent"},"adventure":{"m":"모험","w":"adventure"},"advocate":{"m":"옹호하다","w":"advocate"},"affect":{"m":"영향을 미치다","w":"affect"},"afford":{"m":"~할 여유가 있다","w":"afford"},"aggressive":{"m":"공격적인","w":"aggressive"},"agree":{"m":"동의하다","w":"agree"},"alleviate":{"m":"경감하다 (고통을)","w":"alleviate"},"alter":{"m":"바꾸다","w":"alter"},"amaze":{"m":"놀라게 하다","w":"amaze"},"ambiguous":{"m":"모호한","w":"ambiguous"},"ambition":{"m":"야망","w":"ambition"},"amount":{"m":"양","w":"amount"},"analyze":{"m":"분석하다","w":"analyze"},"ancient":{"m":"고대의","w":"ancient"},"annoy":{"m":"짜증나게 하다","w":"annoy"},"antibiotic":{"m":"항생제","w":"antibiotic"},"anticipate":{"m":"예상하다","w":"anticipate"},"anxiety":{"m":"불안","w":"anxiety"},"anxious":{"m":"불안한","w":"anxious"},"apologize":{"m":"사과하다","w":"apologize"},"apparent":{"m":"명백한","w":"apparent"},"apparently":{"m":"보아하니","w":"apparently"},"appeal":{"m":"호소하다","w":"appeal"},"appreciate":{"m":"감사하다; 진가를 알다","w":"appreciate"},"appropriate":{"m":"적절한","w":"appropriate"},"approve":{"m":"승인하다","w":"approve"},"approximate":{"m":"대략적인","w":"approximate"},"aptitude":{"m":"적성, 재능","w":"aptitude"},"arbitrary":{"m":"임의의; 제멋대로인","w":"arbitrary"},"argue":{"m":"논쟁하다","w":"argue"},"arrange":{"m":"정리하다","w":"arrange"},"arrive":{"m":"도착하다","w":"arrive"},"art":{"m":"예술; 미술","w":"art"},"artificial":{"m":"인공의","w":"artificial"},"artist":{"m":"예술가","w":"artist"},"ashamed":{"m":"부끄러운","w":"ashamed"},"aspire":{"m":"열망하다","w":"aspire"},"assert":{"m":"주장하다","w":"assert"},"assess":{"m":"평가하다","w":"assess"},"assign":{"m":"할당하다","w":"assign"},"assist":{"m":"돕다","w":"assist"},"associate":{"m":"연관짓다","w":"associate"},"assume":{"m":"가정하다","w":"assume"},"astrology":{"m":"점성술","w":"astrology"},"astronomy":{"m":"천문학","w":"astronomy"},"atmosphere":{"m":"대기; 분위기","w":"atmosphere"},"attach":{"m":"붙이다","w":"attach"},"attempt":{"m":"시도하다","w":"attempt"},"attitude":{"m":"태도","w":"attitude"},"attract":{"m":"끌어당기다","w":"attract"},"audience":{"m":"관객; 청중","w":"audience"},"authority":{"m":"권위","w":"authority"},"autobiography":{"m":"자서전","w":"autobiography"},"autonomy":{"m":"자율성","w":"autonomy"},"available":{"m":"이용 가능한","w":"available"},"avoid":{"m":"피하다","w":"avoid"},"aware":{"m":"알고 있는","w":"aware"},"awkward":{"m":"어색한","w":"awkward"},"balance":{"m":"균형","w":"balance"},"banish":{"m":"추방하다","w":"banish"},"barely":{"m":"간신히","w":"barely"},"bargain":{"m":"싼 물건","w":"bargain"},"behavior":{"m":"행동","w":"behavior"},"beneficial":{"m":"유익한, 이로운","w":"beneficial"},"benefit":{"m":"이익; 이롭게 하다","w":"benefit"},"beside":{"m":"~ 옆에","w":"beside"},"besides":{"m":"게다가; ~ 이외에도","w":"besides"},"betray":{"m":"배신하다","w":"betray"},"biology":{"m":"생물학","w":"biology"},"biped":{"m":"두 발 동물","w":"biped"},"blade":{"m":"날 (칼·도구 등의)","w":"blade"},"blame":{"m":"비난하다","w":"blame"},"blaze":{"m":"불, 화재; 활활 타다","w":"blaze"},"bleed":{"m":"피를 흘리다, 출혈하다","w":"bleed"},"boast":{"m":"자랑하다","w":"boast"},"bother":{"m":"귀찮게 하다","w":"bother"},"breathe":{"m":"숨쉬다","w":"breathe"},"breed":{"m":"새끼를 낳다; 사육하다; 품종","w":"breed"},"brief":{"m":"간단한","w":"brief"},"briefly":{"m":"잠시; 간략히","w":"briefly"},"broad":{"m":"넓은","w":"broad"},"budget":{"m":"예산","w":"budget"},"burden":{"m":"부담","w":"burden"},"calculate":{"m":"계산하다","w":"calculate"},"capable":{"m":"유능한","w":"capable"},"career":{"m":"진로; 경력","w":"career"},"careless":{"m":"부주의한","w":"careless"},"carve":{"m":"조각하다, 새기다","w":"carve"},"casual":{"m":"격식 없는","w":"casual"},"cease":{"m":"중단하다","w":"cease"},"celebrate":{"m":"축하하다","w":"celebrate"},"cemetery":{"m":"묘지 (공동)","w":"cemetery"},"century":{"m":"세기; 100년","w":"century"},"certainly":{"m":"틀림없이","w":"certainly"},"challenge":{"m":"도전","w":"challenge"},"cherish":{"m":"소중히 하다","w":"cherish"},"choir":{"m":"합창단, 성가대","w":"choir"},"chore":{"m":"잡일, 자질구레한 일","w":"chore"},"circumstance":{"m":"상황, 환경","w":"circumstance"},"circumstantial":{"m":"정황적인","w":"circumstantial"},"circumvent":{"m":"피하다, 회피하다","w":"circumvent"},"cite":{"m":"인용하다","w":"cite"},"citizen":{"m":"시민","w":"citizen"},"civil":{"m":"시민의; 민간의","w":"civil"},"civilize":{"m":"문명화하다, 교화하다","w":"civilize"},"claim":{"m":"주장하다","w":"claim"},"clarify":{"m":"명확히 하다","w":"clarify"},"classify":{"m":"분류하다","w":"classify"},"climate":{"m":"기후","w":"climate"},"clue":{"m":"단서","w":"clue"},"cognitive":{"m":"인지의","w":"cognitive"},"coherent":{"m":"일관된; 논리적인","w":"coherent"},"collaborate":{"m":"협력하다","w":"collaborate"},"collapse":{"m":"붕괴하다","w":"collapse"},"colleague":{"m":"동료","w":"colleague"},"combine":{"m":"결합하다","w":"combine"},"comet":{"m":"혜성","w":"comet"},"commit":{"m":"저지르다","w":"commit"},"common":{"m":"흔한; 공통의","w":"common"},"commotion":{"m":"소동, 소요","w":"commotion"},"communicate":{"m":"의사소통하다","w":"communicate"},"community":{"m":"공동체; 지역사회","w":"community"},"companion":{"m":"동반자","w":"companion"},"compare":{"m":"비교하다","w":"compare"},"compassion":{"m":"연민, 동정","w":"compassion"},"compensate":{"m":"보상하다","w":"compensate"},"compete":{"m":"경쟁하다","w":"compete"},"competent":{"m":"유능한, 능숙한","w":"competent"},"competitive":{"m":"경쟁의, 경쟁적인; 경쟁력 있는","w":"competitive"},"complain":{"m":"불평하다","w":"complain"},"complete":{"m":"완전한","w":"complete"},"complex":{"m":"복잡한","w":"complex"},"comply":{"m":"따르다; 준수하다","w":"comply"},"component":{"m":"구성 요소","w":"component"},"compose":{"m":"작곡하다","w":"compose"},"comprehend":{"m":"이해하다","w":"comprehend"},"comprehensive":{"m":"포괄적인","w":"comprehensive"},"comprise":{"m":"구성하다, ~으로 이루어지다","w":"comprise"},"compromise":{"m":"타협; 타협하다","w":"compromise"},"conceal":{"m":"숨기다","w":"conceal"},"conceive":{"m":"상상하다; 생각해내다","w":"conceive"},"concentrate":{"m":"집중하다","w":"concentrate"},"concept":{"m":"개념","w":"concept"},"conclude":{"m":"결론짓다","w":"conclude"},"concur":{"m":"동의하다; 일치하다","w":"concur"},"confer":{"m":"상의하다; 수여하다","w":"confer"},"confess":{"m":"고백하다","w":"confess"},"confidence":{"m":"자신감","w":"confidence"},"confident":{"m":"자신 있는","w":"confident"},"confidential":{"m":"비밀의, 기밀의","w":"confidential"},"confirm":{"m":"확인하다","w":"confirm"},"conflict":{"m":"갈등","w":"conflict"},"conform":{"m":"따르다, 순응하다","w":"conform"},"confront":{"m":"맞서다","w":"confront"},"confuse":{"m":"혼란시키다","w":"confuse"},"congenial":{"m":"마음이 맞는, 적합한","w":"congenial"},"congratulate":{"m":"축하하다","w":"congratulate"},"connect":{"m":"연결하다","w":"connect"},"conquer":{"m":"정복하다","w":"conquer"},"conscience":{"m":"양심","w":"conscience"},"conscientious":{"m":"양심적인, 성실한","w":"conscientious"},"conscious":{"m":"의식하고 있는; 의식이 있는","w":"conscious"},"consensus":{"m":"합의","w":"consensus"},"consequence":{"m":"결과","w":"consequence"},"conserve":{"m":"보존하다","w":"conserve"},"consider":{"m":"고려하다","w":"consider"},"considerable":{"m":"상당한 (수량·정도가)","w":"considerable"},"considerate":{"m":"사려 깊은, 배려하는","w":"considerate"},"conspire":{"m":"공모하다, 음모를 꾸미다","w":"conspire"},"constant":{"m":"끊임없는; 상수","w":"constant"},"constantly":{"m":"끊임없이","w":"constantly"},"construct":{"m":"건설하다","w":"construct"},"consult":{"m":"상담하다","w":"consult"},"consume":{"m":"소비하다","w":"consume"},"contain":{"m":"포함하다","w":"contain"},"contemplate":{"m":"심사숙고하다","w":"contemplate"},"context":{"m":"맥락","w":"context"},"continent":{"m":"대륙","w":"continent"},"continue":{"m":"계속하다","w":"continue"},"contradict":{"m":"모순되다; 반박하다","w":"contradict"},"contribute":{"m":"기여하다","w":"contribute"},"convene":{"m":"소집하다, 모이다","w":"convene"},"convenient":{"m":"편리한","w":"convenient"},"convert":{"m":"전환하다","w":"convert"},"convey":{"m":"전달하다","w":"convey"},"convince":{"m":"확신시키다","w":"convince"},"cooperate":{"m":"협력하다","w":"cooperate"},"cope":{"m":"대처하다","w":"cope"},"correlate":{"m":"상관관계가 있다","w":"correlate"},"correlation":{"m":"상관관계","w":"correlation"},"correspond":{"m":"일치하다, 부합하다","w":"correspond"},"cosmetic":{"m":"화장용의, 성형의; 화장품","w":"cosmetic"},"cosmic":{"m":"우주의; 어마어마한","w":"cosmic"},"cost":{"m":"비용","w":"cost"},"countless":{"m":"셀 수 없이 많은","w":"countless"},"courage":{"m":"용기","w":"courage"},"crave":{"m":"갈망하다, 열망하다","w":"crave"},"create":{"m":"창조하다; 만들다","w":"create"},"creative":{"m":"창의적인","w":"creative"},"crime":{"m":"범죄","w":"crime"},"crowd":{"m":"군중","w":"crowd"},"crucial":{"m":"중요한","w":"crucial"},"cruel":{"m":"잔인한","w":"cruel"},"cultivate":{"m":"경작하다","w":"cultivate"},"culture":{"m":"문화","w":"culture"},"cure":{"m":"치료하다","w":"cure"},"curious":{"m":"호기심 많은","w":"curious"},"current":{"m":"현재의","w":"current"},"curriculum":{"m":"교육과정","w":"curriculum"},"custom":{"m":"관습; 풍습","w":"custom"},"customer":{"m":"고객","w":"customer"},"dairy":{"m":"유제품의, 낙농의","w":"dairy"},"dangerous":{"m":"위험한","w":"dangerous"},"data":{"m":"자료; 데이터","w":"data"},"decade":{"m":"십 년","w":"decade"},"decease":{"m":"사망","w":"decease"},"deceive":{"m":"속이다","w":"deceive"},"decide":{"m":"결정하다","w":"decide"},"decision":{"m":"결정","w":"decision"},"decisive":{"m":"결정적인","w":"decisive"},"declare":{"m":"선언하다","w":"declare"},"decline":{"m":"감소하다; 거절하다","w":"decline"},"decrease":{"m":"감소하다","w":"decrease"},"dedicate":{"m":"헌신하다","w":"dedicate"},"deeply":{"m":"깊이","w":"deeply"},"defeat":{"m":"패배시키다","w":"defeat"},"defend":{"m":"방어하다","w":"defend"},"defer":{"m":"미루다, 연기하다","w":"defer"},"define":{"m":"정의하다","w":"define"},"definitely":{"m":"확실히","w":"definitely"},"delay":{"m":"지연시키다","w":"delay"},"deliberate":{"m":"고의적인","w":"deliberate"},"deliberately":{"m":"고의로","w":"deliberately"},"delicate":{"m":"섬세한","w":"delicate"},"delight":{"m":"기쁨","w":"delight"},"deliver":{"m":"배달하다","w":"deliver"},"demand":{"m":"요구하다; 수요","w":"demand"},"deny":{"m":"부인하다","w":"deny"},"depart":{"m":"출발하다","w":"depart"},"depend":{"m":"의존하다","w":"depend"},"depress":{"m":"우울하게 하다","w":"depress"},"derive":{"m":"끌어내다; 유래하다","w":"derive"},"describe":{"m":"묘사하다","w":"describe"},"deserve":{"m":"~할 자격이 있다","w":"deserve"},"design":{"m":"디자인; 설계","w":"design"},"desire":{"m":"욕망","w":"desire"},"despair":{"m":"절망","w":"despair"},"desperate":{"m":"필사적인","w":"desperate"},"destination":{"m":"목적지","w":"destination"},"destroy":{"m":"파괴하다","w":"destroy"},"detach":{"m":"분리하다, 떼어내다","w":"detach"},"detect":{"m":"탐지하다","w":"detect"},"deteriorate":{"m":"악화되다","w":"deteriorate"},"determine":{"m":"결정하다","w":"determine"},"detest":{"m":"혐오하다, 몹시 싫어하다","w":"detest"},"develop":{"m":"개발하다; 발달하다","w":"develop"},"device":{"m":"장치; 기기","w":"device"},"devote":{"m":"헌신하다","w":"devote"},"devour":{"m":"게걸스럽게 먹어 치우다","w":"devour"},"diary":{"m":"일기(장)","w":"diary"},"differ":{"m":"다르다","w":"differ"},"digital":{"m":"디지털의","w":"digital"},"dilemma":{"m":"딜레마; 진퇴양난","w":"dilemma"},"diminish":{"m":"줄어들다","w":"diminish"},"diploma":{"m":"졸업장; 수료증","w":"diploma"},"diplomat":{"m":"외교관","w":"diplomat"},"disappoint":{"m":"실망시키다","w":"disappoint"},"disapprove":{"m":"반대하다, 승인하지 않다","w":"disapprove"},"discern":{"m":"식별하다","w":"discern"},"discomfort":{"m":"불편","w":"discomfort"},"discord":{"m":"불화, 불일치","w":"discord"},"discourage":{"m":"낙담시키다","w":"discourage"},"discover":{"m":"발견하다","w":"discover"},"discriminate":{"m":"차별하다; 식별하다","w":"discriminate"},"discuss":{"m":"논의하다","w":"discuss"},"disease":{"m":"질병","w":"disease"},"disguise":{"m":"변장하다","w":"disguise"},"dismiss":{"m":"일축하다","w":"dismiss"},"display":{"m":"전시하다","w":"display"},"dispose":{"m":"처리하다","w":"dispose"},"dispute":{"m":"논쟁, 분쟁","w":"dispute"},"disrespect":{"m":"무례, 결례","w":"disrespect"},"disrupt":{"m":"방해하다, 혼란시키다","w":"disrupt"},"distance":{"m":"거리","w":"distance"},"distant":{"m":"먼","w":"distant"},"distinct":{"m":"뚜렷한; 별개의","w":"distinct"},"distinguish":{"m":"구별하다","w":"distinguish"},"distract":{"m":"산만하게 하다","w":"distract"},"distribute":{"m":"분배하다","w":"distribute"},"disturb":{"m":"방해하다","w":"disturb"},"diverse":{"m":"다양한","w":"diverse"},"divide":{"m":"나누다","w":"divide"},"dominant":{"m":"지배적인; 우세한","w":"dominant"},"dominate":{"m":"지배하다","w":"dominate"},"donate":{"m":"기부하다","w":"donate"},"doubt":{"m":"의심","w":"doubt"},"draw":{"m":"그리다; 끌다","w":"draw"},"dreadful":{"m":"끔찍한, 지독한","w":"dreadful"},"dreary":{"m":"음울한, 적막한","w":"dreary"},"drift":{"m":"표류하다","w":"drift"},"dwell":{"m":"거주하다","w":"dwell"},"dynamic":{"m":"역동적인","w":"dynamic"},"eager":{"m":"열망하는","w":"eager"},"earn":{"m":"벌다","w":"earn"},"ease":{"m":"완화하다; 덜어주다","w":"ease"},"economic":{"m":"경제의","w":"economic"},"economical":{"m":"경제적인, 절약하는","w":"economical"},"economy":{"m":"경제","w":"economy"},"edge":{"m":"가장자리","w":"edge"},"educate":{"m":"교육하다","w":"educate"},"effect":{"m":"영향; 결과; 효과","w":"effect"},"effective":{"m":"효과적인","w":"effective"},"efficient":{"m":"효율적인","w":"efficient"},"effort":{"m":"노력","w":"effort"},"elaborate":{"m":"정교한","w":"elaborate"},"election":{"m":"선거, 투표","w":"election"},"elegant":{"m":"우아한","w":"elegant"},"eliminate":{"m":"제거하다","w":"eliminate"},"embarrass":{"m":"당황하게 하다","w":"embarrass"},"embrace":{"m":"받아들이다","w":"embrace"},"emerge":{"m":"나타나다","w":"emerge"},"emit":{"m":"방출하다, 내뿜다","w":"emit"},"emotion":{"m":"감정","w":"emotion"},"emphasize":{"m":"강조하다","w":"emphasize"},"empirical":{"m":"경험적인; 실증적인","w":"empirical"},"employ":{"m":"고용하다","w":"employ"},"enable":{"m":"가능하게 하다","w":"enable"},"encounter":{"m":"마주치다","w":"encounter"},"encourage":{"m":"격려하다","w":"encourage"},"endangered":{"m":"멸종 위기의","w":"endangered"},"endure":{"m":"견디다","w":"endure"},"energy":{"m":"에너지","w":"energy"},"enhance":{"m":"향상시키다","w":"enhance"},"enormous":{"m":"거대한","w":"enormous"},"ensure":{"m":"보장하다","w":"ensure"},"entertain":{"m":"즐겁게 하다","w":"entertain"},"enthusiasm":{"m":"열정","w":"enthusiasm"},"entirely":{"m":"전적으로","w":"entirely"},"environment":{"m":"환경","w":"environment"},"envy":{"m":"부러움","w":"envy"},"equal":{"m":"평등한; 동등한","w":"equal"},"equip":{"m":"갖추다","w":"equip"},"erection":{"m":"건립, 건설","w":"erection"},"essential":{"m":"필수적인","w":"essential"},"establish":{"m":"설립하다","w":"establish"},"estimate":{"m":"추정하다","w":"estimate"},"ethic":{"m":"윤리, 도덕","w":"ethic"},"ethnic":{"m":"민족의, 인종의","w":"ethnic"},"evaluate":{"m":"평가하다","w":"evaluate"},"eventually":{"m":"결국","w":"eventually"},"evidence":{"m":"증거","w":"evidence"},"evident":{"m":"명백한","w":"evident"},"evolve":{"m":"진화하다","w":"evolve"},"exceed":{"m":"초과하다","w":"exceed"},"excess":{"m":"초과, 과잉","w":"excess"},"excessive":{"m":"과도한","w":"excessive"},"exclude":{"m":"제외하다","w":"exclude"},"excursion":{"m":"여행 (짧은), 소풍","w":"excursion"},"exercise":{"m":"운동","w":"exercise"},"exhaust":{"m":"지치게 하다","w":"exhaust"},"exhibit":{"m":"전시하다","w":"exhibit"},"exist":{"m":"존재하다","w":"exist"},"exotic":{"m":"이국적인, 외래의","w":"exotic"},"expand":{"m":"확장하다; 팽창하다","w":"expand"},"expedition":{"m":"탐험(대), 원정대","w":"expedition"},"expel":{"m":"추방하다, 쫓아내다","w":"expel"},"expense":{"m":"비용","w":"expense"},"expensive":{"m":"비싼","w":"expensive"},"experiment":{"m":"실험","w":"experiment"},"expire":{"m":"만료되다, 끝나다","w":"expire"},"explain":{"m":"설명하다","w":"explain"},"explore":{"m":"탐험하다","w":"explore"},"expose":{"m":"노출시키다","w":"expose"},"express":{"m":"표현하다","w":"express"},"extend":{"m":"연장하다","w":"extend"},"external":{"m":"외부의","w":"external"},"extinct":{"m":"멸종된","w":"extinct"},"extracurricular":{"m":"과외의, 정규 교육과정 외의","w":"extracurricular"},"extraordinary":{"m":"비범한","w":"extraordinary"},"extraterrestrial":{"m":"외계인; 외계의","w":"extraterrestrial"},"extremely":{"m":"극도로","w":"extremely"},"facility":{"m":"시설","w":"facility"},"factor":{"m":"요인","w":"factor"},"fade":{"m":"바래다","w":"fade"},"faint":{"m":"희미한","w":"faint"},"fame":{"m":"명성","w":"fame"},"familiar":{"m":"익숙한","w":"familiar"},"famine":{"m":"기근, 굶주림","w":"famine"},"fascinate":{"m":"매혹하다","w":"fascinate"},"fatigue":{"m":"피로","w":"fatigue"},"fault":{"m":"잘못","w":"fault"},"favor":{"m":"호의","w":"favor"},"fear":{"m":"두려움","w":"fear"},"feasible":{"m":"실현 가능한","w":"feasible"},"feather":{"m":"깃털","w":"feather"},"fee":{"m":"요금","w":"fee"},"fertile":{"m":"비옥한","w":"fertile"},"fierce":{"m":"사나운","w":"fierce"},"flash":{"m":"번쩍이다, 빛나다; 섬광","w":"flash"},"flavor":{"m":"맛, 풍미","w":"flavor"},"flee":{"m":"도망치다","w":"flee"},"flesh":{"m":"살, 육체","w":"flesh"},"flexible":{"m":"유연한","w":"flexible"},"float":{"m":"뜨다","w":"float"},"flourish":{"m":"번성하다","w":"flourish"},"fluctuate":{"m":"변동하다","w":"fluctuate"},"flush":{"m":"물을 내리다 (변기의); 붉어지다","w":"flush"},"focus":{"m":"집중하다","w":"focus"},"forbid":{"m":"금지하다","w":"forbid"},"forecast":{"m":"예보","w":"forecast"},"foreign":{"m":"외국의","w":"foreign"},"forever":{"m":"영원히","w":"forever"},"former":{"m":"이전의","w":"former"},"foundation":{"m":"기초","w":"foundation"},"fraction":{"m":"일부, 부분","w":"fraction"},"fragile":{"m":"연약한","w":"fragile"},"freedom":{"m":"자유","w":"freedom"},"frequent":{"m":"잦은","w":"frequent"},"frequently":{"m":"자주","w":"frequently"},"fresh":{"m":"신선한, 새로운","w":"fresh"},"friction":{"m":"마찰","w":"friction"},"friendship":{"m":"우정","w":"friendship"},"frighten":{"m":"겁먹게 하다","w":"frighten"},"frustrate":{"m":"좌절시키다","w":"frustrate"},"fulfill":{"m":"성취하다","w":"fulfill"},"function":{"m":"기능","w":"function"},"fund":{"m":"자금","w":"fund"},"fundamental":{"m":"근본적인","w":"fundamental"},"furnish":{"m":"비치하다 (가구를); 제공하다","w":"furnish"},"furthermore":{"m":"게다가","w":"furthermore"},"futile":{"m":"헛된, 소용없는","w":"futile"},"gain":{"m":"얻다","w":"gain"},"gather":{"m":"모으다","w":"gather"},"gaze":{"m":"응시하다","w":"gaze"},"generate":{"m":"발생시키다","w":"generate"},"generation":{"m":"세대","w":"generation"},"generous":{"m":"관대한","w":"generous"},"gently":{"m":"부드럽게","w":"gently"},"genuine":{"m":"진짜의","w":"genuine"},"geography":{"m":"지리학; 지형","w":"geography"},"geology":{"m":"지질학","w":"geology"},"gesture":{"m":"몸짓","w":"gesture"},"glance":{"m":"흘긋 보다","w":"glance"},"glory":{"m":"영광","w":"glory"},"glow":{"m":"빛나다","w":"glow"},"goal":{"m":"목표","w":"goal"},"govern":{"m":"통치하다","w":"govern"},"government":{"m":"정부","w":"government"},"grab":{"m":"붙잡다","w":"grab"},"gradual":{"m":"점진적인","w":"gradual"},"gradually":{"m":"점차","w":"gradually"},"graduate":{"m":"졸업하다","w":"graduate"},"grateful":{"m":"감사하는","w":"grateful"},"greed":{"m":"탐욕","w":"greed"},"grief":{"m":"슬픔","w":"grief"},"guarantee":{"m":"보장하다","w":"guarantee"},"guide":{"m":"안내자; 안내서","w":"guide"},"guilty":{"m":"죄책감의","w":"guilty"},"habit":{"m":"습관","w":"habit"},"handle":{"m":"다루다","w":"handle"},"hardly":{"m":"거의 않다","w":"hardly"},"harsh":{"m":"가혹한","w":"harsh"},"harvest":{"m":"수확","w":"harvest"},"heal":{"m":"치유하다","w":"heal"},"health":{"m":"건강","w":"health"},"heritage":{"m":"유산","w":"heritage"},"hesitate":{"m":"머뭇거리다","w":"hesitate"},"heterogeneous":{"m":"이종의, 이질적인","w":"heterogeneous"},"highly":{"m":"매우","w":"highly"},"hollow":{"m":"속이 빈","w":"hollow"},"homogeneous":{"m":"동종의, 동질적인","w":"homogeneous"},"honest":{"m":"정직한","w":"honest"},"honor":{"m":"명예","w":"honor"},"horror":{"m":"공포","w":"horror"},"hostile":{"m":"적대적인","w":"hostile"},"however":{"m":"그러나","w":"however"},"huge":{"m":"거대한","w":"huge"},"humble":{"m":"겸손한; 초라한","w":"humble"},"hypothesis":{"m":"가설","w":"hypothesis"},"identify":{"m":"확인하다","w":"identify"},"ignorant":{"m":"무지한","w":"ignorant"},"ignore":{"m":"무시하다","w":"ignore"},"illegal":{"m":"불법적인","w":"illegal"},"illogical":{"m":"비논리적인","w":"illogical"},"illustrate":{"m":"설명하다","w":"illustrate"},"imagination":{"m":"상상력","w":"imagination"},"imagine":{"m":"상상하다","w":"imagine"},"imitate":{"m":"모방하다","w":"imitate"},"immature":{"m":"미성숙한","w":"immature"},"immediate":{"m":"즉각적인","w":"immediate"},"immediately":{"m":"즉시","w":"immediately"},"immense":{"m":"거대한","w":"immense"},"immoral":{"m":"비도덕적인","w":"immoral"},"impatient":{"m":"참을성 없는","w":"impatient"},"impede":{"m":"방해하다","w":"impede"},"imply":{"m":"암시하다","w":"imply"},"impolite":{"m":"무례한","w":"impolite"},"impose":{"m":"부과하다","w":"impose"},"impossible":{"m":"불가능한","w":"impossible"},"impress":{"m":"감명을 주다","w":"impress"},"improve":{"m":"향상시키다","w":"improve"},"inaccurate":{"m":"부정확한","w":"inaccurate"},"inadequate":{"m":"부족한, 불충분한","w":"inadequate"},"include":{"m":"포함하다","w":"include"},"income":{"m":"수입","w":"income"},"incomplete":{"m":"미완성의","w":"incomplete"},"inconsistent":{"m":"일관성 없는","w":"inconsistent"},"increase":{"m":"증가하다","w":"increase"},"incur":{"m":"초래하다 (좋지 못한 결과를)","w":"incur"},"indeed":{"m":"실로","w":"indeed"},"indefinite":{"m":"무기한의, 불확정한","w":"indefinite"},"independent":{"m":"독립적인","w":"independent"},"indicate":{"m":"나타내다","w":"indicate"},"indigenous":{"m":"토착의, 고유한","w":"indigenous"},"individual":{"m":"개인","w":"individual"},"industry":{"m":"산업","w":"industry"},"inevitable":{"m":"불가피한","w":"inevitable"},"infect":{"m":"감염시키다, 전염시키다","w":"infect"},"infer":{"m":"추론하다","w":"infer"},"infinite":{"m":"무한한","w":"infinite"},"influence":{"m":"영향","w":"influence"},"inform":{"m":"알리다","w":"inform"},"ingenious":{"m":"기발한, 독창적인","w":"ingenious"},"inhabit":{"m":"서식하다","w":"inhabit"},"inherent":{"m":"내재된; 고유의","w":"inherent"},"inherit":{"m":"물려받다","w":"inherit"},"inject":{"m":"주사하다; 주입하다","w":"inject"},"injure":{"m":"부상을 입히다","w":"injure"},"injury":{"m":"부상","w":"injury"},"innocent":{"m":"무죄의","w":"innocent"},"inquire":{"m":"문의하다","w":"inquire"},"insert":{"m":"삽입하다, 끼워넣다","w":"insert"},"inspire":{"m":"영감을 주다","w":"inspire"},"install":{"m":"설치하다","w":"install"},"instant":{"m":"즉각적인","w":"instant"},"instantly":{"m":"즉각","w":"instantly"},"instead":{"m":"대신에","w":"instead"},"instinct":{"m":"본능","w":"instinct"},"instruct":{"m":"지시하다","w":"instruct"},"instrument":{"m":"악기; 도구","w":"instrument"},"insult":{"m":"모욕하다","w":"insult"},"intend":{"m":"의도하다","w":"intend"},"intense":{"m":"강렬한","w":"intense"},"interact":{"m":"상호작용하다","w":"interact"},"interfere":{"m":"간섭하다","w":"interfere"},"intermit":{"m":"중단하다","w":"intermit"},"intermittent":{"m":"간헐적인","w":"intermittent"},"interpret":{"m":"해석하다; 통역하다","w":"interpret"},"interrupt":{"m":"방해하다","w":"interrupt"},"intervene":{"m":"개입하다, 중재하다","w":"intervene"},"intrinsic":{"m":"본질적인","w":"intrinsic"},"intuition":{"m":"직관","w":"intuition"},"invade":{"m":"침략하다","w":"invade"},"invent":{"m":"발명하다","w":"invent"},"invention":{"m":"발명(품)","w":"invention"},"inventory":{"m":"물품 목록, 재고","w":"inventory"},"invest":{"m":"투자하다","w":"invest"},"investigate":{"m":"조사하다","w":"investigate"},"involve":{"m":"관련시키다","w":"involve"},"irrational":{"m":"비이성적인","w":"irrational"},"irregular":{"m":"불규칙한","w":"irregular"},"irrelevant":{"m":"관련 없는","w":"irrelevant"},"irresponsible":{"m":"무책임한","w":"irresponsible"},"irrigate":{"m":"물을 대다 (땅에), 관개하다","w":"irrigate"},"irritate":{"m":"짜증나게 하다, 화나게 하다","w":"irritate"},"jealous":{"m":"질투하는","w":"jealous"},"journey":{"m":"여행","w":"journey"},"judge":{"m":"판단하다","w":"judge"},"justice":{"m":"정의","w":"justice"},"justify":{"m":"정당화하다","w":"justify"},"keen":{"m":"열망하는","w":"keen"},"knowledge":{"m":"지식","w":"knowledge"},"labor":{"m":"노동","w":"labor"},"lack":{"m":"부족","w":"lack"},"launch":{"m":"시작하다","w":"launch"},"lean":{"m":"기대다","w":"lean"},"leap":{"m":"뛰어오르다","w":"leap"},"leather":{"m":"가죽","w":"leather"},"legitimate":{"m":"정당한; 합법적인","w":"legitimate"},"lengthen":{"m":"늘이다, 길게 하다","w":"lengthen"},"liberal":{"m":"진보적인, 자유주의의","w":"liberal"},"liberty":{"m":"자유","w":"liberty"},"likewise":{"m":"마찬가지로","w":"likewise"},"literal":{"m":"문자 그대로의","w":"literal"},"literature":{"m":"문학","w":"literature"},"local":{"m":"지역의; 현지의","w":"local"},"locate":{"m":"위치를 찾다","w":"locate"},"locomotive":{"m":"기관차","w":"locomotive"},"loyal":{"m":"충성스러운","w":"loyal"},"luggage":{"m":"짐; 수하물","w":"luggage"},"magnificent":{"m":"웅장한","w":"magnificent"},"maintain":{"m":"유지하다; 주장하다","w":"maintain"},"major":{"m":"전공","w":"major"},"majority":{"m":"대다수","w":"majority"},"malnutrition":{"m":"영양실조","w":"malnutrition"},"manufacture":{"m":"제조하다","w":"manufacture"},"marital":{"m":"결혼(생활)의, 부부의","w":"marital"},"martial":{"m":"싸움의, 무술의","w":"martial"},"massive":{"m":"거대한","w":"massive"},"mature":{"m":"성숙한","w":"mature"},"means":{"m":"수단","w":"means"},"meanwhile":{"m":"그동안","w":"meanwhile"},"measure":{"m":"측정하다","w":"measure"},"medicine":{"m":"약; 의학","w":"medicine"},"mental":{"m":"정신의","w":"mental"},"mention":{"m":"언급하다","w":"mention"},"mercy":{"m":"자비","w":"mercy"},"mere":{"m":"~에 불과한","w":"mere"},"merely":{"m":"단지","w":"merely"},"method":{"m":"방법","w":"method"},"migrate":{"m":"이주하다","w":"migrate"},"mimic":{"m":"흉내내다","w":"mimic"},"minimal":{"m":"최소의","w":"minimal"},"minor":{"m":"사소한; 작은","w":"minor"},"misbehave":{"m":"못된 짓을 하다","w":"misbehave"},"miscalculate":{"m":"잘못 계산하다","w":"miscalculate"},"misfortune":{"m":"불운, 불행","w":"misfortune"},"misinterpret":{"m":"잘못 해석하다","w":"misinterpret"},"mislead":{"m":"오도하다, 속이다","w":"mislead"},"mission":{"m":"임무","w":"mission"},"mixture":{"m":"혼합물","w":"mixture"},"moan":{"m":"신음하다; 투덜거리다","w":"moan"},"mob":{"m":"군중, 무리","w":"mob"},"mobile":{"m":"이동하는, 기동성 있는","w":"mobile"},"moderate":{"m":"적당한; 온건한","w":"moderate"},"modern":{"m":"현대의","w":"modern"},"modify":{"m":"수정하다","w":"modify"},"moment":{"m":"순간","w":"moment"},"momentary":{"m":"순간적인, 찰나의","w":"momentary"},"momentous":{"m":"중대한, 중요한","w":"momentous"},"monitor":{"m":"감시하다","w":"monitor"},"mood":{"m":"기분","w":"mood"},"moral":{"m":"도덕적인","w":"moral"},"moreover":{"m":"게다가","w":"moreover"},"mostly":{"m":"대부분","w":"mostly"},"motivate":{"m":"동기를 부여하다","w":"motivate"},"motive":{"m":"동기, 이유","w":"motive"},"mourn":{"m":"슬퍼하다, 애도하다","w":"mourn"},"multiply":{"m":"곱하다","w":"multiply"},"muscle":{"m":"근육","w":"muscle"},"mutual":{"m":"상호의","w":"mutual"},"naive":{"m":"순진한","w":"naive"},"namely":{"m":"즉","w":"namely"},"narrow":{"m":"좁은","w":"narrow"},"natural":{"m":"자연의; 자연스러운","w":"natural"},"nature":{"m":"자연","w":"nature"},"nearly":{"m":"거의","w":"nearly"},"neat":{"m":"깔끔한","w":"neat"},"neglect":{"m":"방치하다","w":"neglect"},"negotiate":{"m":"협상하다","w":"negotiate"},"neighbor":{"m":"이웃","w":"neighbor"},"nevertheless":{"m":"그럼에도","w":"nevertheless"},"noble":{"m":"고귀한","w":"noble"},"notice":{"m":"알아차리다","w":"notice"},"notion":{"m":"개념","w":"notion"},"nourish":{"m":"영양을 주다","w":"nourish"},"novel":{"m":"소설","w":"novel"},"numerous":{"m":"수많은","w":"numerous"},"nutrition":{"m":"영양","w":"nutrition"},"objective":{"m":"목표","w":"objective"},"observe":{"m":"관찰하다","w":"observe"},"obstacle":{"m":"장애물","w":"obstacle"},"obtain":{"m":"얻다","w":"obtain"},"obtainable":{"m":"얻을 수 있는","w":"obtainable"},"obvious":{"m":"명백한","w":"obvious"},"obviously":{"m":"분명히","w":"obviously"},"occasionally":{"m":"가끔","w":"occasionally"},"occur":{"m":"발생하다","w":"occur"},"offend":{"m":"기분 상하게 하다","w":"offend"},"omit":{"m":"빠뜨리다, 생략하다","w":"omit"},"operate":{"m":"작동하다","w":"operate"},"opinion":{"m":"의견","w":"opinion"},"oppose":{"m":"반대하다","w":"oppose"},"oppress":{"m":"억압하다","w":"oppress"},"optimistic":{"m":"낙관적인","w":"optimistic"},"ordinary":{"m":"평범한","w":"ordinary"},"organize":{"m":"조직하다","w":"organize"},"origin":{"m":"기원","w":"origin"},"originate":{"m":"비롯하다, 유래하다","w":"originate"},"otherwise":{"m":"그렇지 않으면","w":"otherwise"},"outcome":{"m":"결과","w":"outcome"},"outdo":{"m":"~보다 더 잘하다","w":"outdo"},"outlast":{"m":"~보다 더 오래가다","w":"outlast"},"outshine":{"m":"~보다 더 뛰어나다","w":"outshine"},"outstanding":{"m":"뛰어난","w":"outstanding"},"overcome":{"m":"극복하다","w":"overcome"},"overlook":{"m":"간과하다; 내려다보다","w":"overlook"},"oversee":{"m":"감독하다, 감시하다","w":"oversee"},"paint":{"m":"그리다; 칠하다","w":"paint"},"panic":{"m":"당황하다","w":"panic"},"participate":{"m":"참여하다","w":"participate"},"particularly":{"m":"특히","w":"particularly"},"passion":{"m":"열정","w":"passion"},"passport":{"m":"여권","w":"passport"},"patience":{"m":"인내심","w":"patience"},"patient":{"m":"참을성 있는","w":"patient"},"patrol":{"m":"순찰(대); 순찰하다","w":"patrol"},"patron":{"m":"후원자; 단골 고객","w":"patron"},"peace":{"m":"평화","w":"peace"},"peculiar":{"m":"이상한","w":"peculiar"},"peddle":{"m":"팔러 다니다, 행상하다","w":"peddle"},"pedestal":{"m":"받침대; 기초","w":"pedestal"},"pedestrian":{"m":"보행자","w":"pedestrian"},"perceive":{"m":"인식하다","w":"perceive"},"perform":{"m":"공연하다","w":"perform"},"period":{"m":"기간; 시기","w":"period"},"permanent":{"m":"영구적인","w":"permanent"},"permanently":{"m":"영구히","w":"permanently"},"permit":{"m":"허가하다","w":"permit"},"perspective":{"m":"관점","w":"perspective"},"persuade":{"m":"설득하다","w":"persuade"},"phenomenon":{"m":"현상","w":"phenomenon"},"physical":{"m":"신체의; 물리적인","w":"physical"},"plausible":{"m":"그럴듯한","w":"plausible"},"polite":{"m":"예의 바른","w":"polite"},"politic":{"m":"현명한, 신중한","w":"politic"},"political":{"m":"정치의; 정당의","w":"political"},"pollute":{"m":"오염시키다","w":"pollute"},"pollution":{"m":"오염","w":"pollution"},"population":{"m":"인구","w":"population"},"portion":{"m":"부분","w":"portion"},"portray":{"m":"묘사하다","w":"portray"},"possess":{"m":"소유하다","w":"possess"},"postpone":{"m":"연기하다","w":"postpone"},"potential":{"m":"잠재적인","w":"potential"},"poverty":{"m":"가난","w":"poverty"},"praise":{"m":"칭찬하다","w":"praise"},"precede":{"m":"앞서다","w":"precede"},"precious":{"m":"소중한","w":"precious"},"precise":{"m":"정확한","w":"precise"},"precisely":{"m":"정확히","w":"precisely"},"precursor":{"m":"선구자; 전조","w":"precursor"},"predict":{"m":"예측하다","w":"predict"},"prediction":{"m":"예측","w":"prediction"},"prefer":{"m":"선호하다","w":"prefer"},"prejudice":{"m":"편견","w":"prejudice"},"prepare":{"m":"준비하다","w":"prepare"},"preserve":{"m":"보존하다","w":"preserve"},"pretend":{"m":"~인 척하다","w":"pretend"},"prevail":{"m":"만연하다; 우세하다","w":"prevail"},"prevent":{"m":"예방하다","w":"prevent"},"previous":{"m":"이전의","w":"previous"},"price":{"m":"가격","w":"price"},"primary":{"m":"주요한","w":"primary"},"principal":{"m":"주요한; 교장","w":"principal"},"principle":{"m":"원칙","w":"principle"},"prior":{"m":"이전의","w":"prior"},"prioritize":{"m":"우선순위를 매기다","w":"prioritize"},"private":{"m":"사적인; 개인의","w":"private"},"privilege":{"m":"특권","w":"privilege"},"proceed":{"m":"진행하다","w":"proceed"},"process":{"m":"과정","w":"process"},"product":{"m":"제품","w":"product"},"profit":{"m":"이익","w":"profit"},"profound":{"m":"심오한","w":"profound"},"progress":{"m":"진전; 발전","w":"progress"},"prohibit":{"m":"금지하다","w":"prohibit"},"prolong":{"m":"연장하다","w":"prolong"},"prominent":{"m":"저명한","w":"prominent"},"promote":{"m":"촉진하다","w":"promote"},"prompt":{"m":"신속한","w":"prompt"},"proper":{"m":"적절한","w":"proper"},"property":{"m":"재산; 특성, 속성","w":"property"},"prophecy":{"m":"예언","w":"prophecy"},"prophesy":{"m":"예언하다","w":"prophesy"},"propose":{"m":"제안하다","w":"propose"},"prospective":{"m":"장래의, 유망한","w":"prospective"},"prosper":{"m":"번영하다","w":"prosper"},"prosperity":{"m":"번영, 번창","w":"prosperity"},"protect":{"m":"보호하다","w":"protect"},"protest":{"m":"항의하다","w":"protest"},"proud":{"m":"자랑스러운","w":"proud"},"prove":{"m":"증명하다","w":"prove"},"provide":{"m":"제공하다","w":"provide"},"public":{"m":"공공의; 대중의","w":"public"},"publish":{"m":"출판하다","w":"publish"},"punish":{"m":"처벌하다","w":"punish"},"purchase":{"m":"구매하다","w":"purchase"},"pure":{"m":"순수한","w":"pure"},"purpose":{"m":"목적","w":"purpose"},"pursue":{"m":"추구하다","w":"pursue"},"qualify":{"m":"자격을 얻다","w":"qualify"},"quantity":{"m":"양","w":"quantity"},"quit":{"m":"그만두다","w":"quit"},"ragged":{"m":"누더기의; 덥수룩한","w":"ragged"},"rapid":{"m":"빠른","w":"rapid"},"rare":{"m":"드문","w":"rare"},"rarely":{"m":"드물게","w":"rarely"},"rather":{"m":"오히려; 상당히","w":"rather"},"react":{"m":"반응하다","w":"react"},"realize":{"m":"깨닫다","w":"realize"},"reap":{"m":"수확하다, 거두다","w":"reap"},"reason":{"m":"이유; 이성","w":"reason"},"reasonable":{"m":"합리적인; 적당한","w":"reasonable"},"rebel":{"m":"반항하다","w":"rebel"},"recall":{"m":"기억해내다","w":"recall"},"recede":{"m":"물러가다, 퇴각하다","w":"recede"},"receipt":{"m":"영수증","w":"receipt"},"recent":{"m":"최근의","w":"recent"},"recipe":{"m":"조리법","w":"recipe"},"recognize":{"m":"인식하다","w":"recognize"},"recommend":{"m":"추천하다","w":"recommend"},"recover":{"m":"회복하다; 되찾다","w":"recover"},"recur":{"m":"반복되다, 재발하다","w":"recur"},"recycle":{"m":"재활용하다","w":"recycle"},"reduce":{"m":"줄이다","w":"reduce"},"refer":{"m":"언급하다","w":"refer"},"reflect":{"m":"반영하다","w":"reflect"},"reform":{"m":"개혁","w":"reform"},"refuse":{"m":"거절하다","w":"refuse"},"regard":{"m":"여기다","w":"regard"},"region":{"m":"지역, 지방","w":"region"},"register":{"m":"등록하다","w":"register"},"regret":{"m":"후회하다","w":"regret"},"regulate":{"m":"규제하다","w":"regulate"},"reinforce":{"m":"강화하다","w":"reinforce"},"reject":{"m":"거절하다","w":"reject"},"relate":{"m":"관련시키다","w":"relate"},"relationship":{"m":"관계","w":"relationship"},"relative":{"m":"친척","w":"relative"},"release":{"m":"발표하다","w":"release"},"relevant":{"m":"관련 있는","w":"relevant"},"reliable":{"m":"믿을 수 있는","w":"reliable"},"relief":{"m":"안도","w":"relief"},"religion":{"m":"종교","w":"religion"},"reluctant":{"m":"꺼리는","w":"reluctant"},"rely":{"m":"의존하다","w":"rely"},"remain":{"m":"남다; 여전히 ~이다","w":"remain"},"remark":{"m":"발언","w":"remark"},"remedy":{"m":"해결책; 치료법","w":"remedy"},"remind":{"m":"상기시키다","w":"remind"},"remit":{"m":"송금하다; 면제하다","w":"remit"},"remove":{"m":"제거하다","w":"remove"},"repair":{"m":"수리하다","w":"repair"},"replace":{"m":"대체하다","w":"replace"},"represent":{"m":"대표하다","w":"represent"},"reputation":{"m":"명성","w":"reputation"},"require":{"m":"요구하다","w":"require"},"rescue":{"m":"구조하다","w":"rescue"},"research":{"m":"연구","w":"research"},"resemble":{"m":"닮다","w":"resemble"},"reserve":{"m":"예약하다","w":"reserve"},"reside":{"m":"거주하다, 살다","w":"reside"},"resign":{"m":"사직하다, 물러나다","w":"resign"},"resist":{"m":"저항하다","w":"resist"},"resolve":{"m":"해결하다","w":"resolve"},"resource":{"m":"자원","w":"resource"},"respect":{"m":"존중하다","w":"respect"},"respectable":{"m":"존경할 만한, 훌륭한","w":"respectable"},"respective":{"m":"각각의, 각자의","w":"respective"},"respire":{"m":"호흡하다","w":"respire"},"respond":{"m":"응답하다","w":"respond"},"responsible":{"m":"책임이 있는","w":"responsible"},"responsive":{"m":"즉각 반응하는","w":"responsive"},"rest":{"m":"휴식","w":"rest"},"restore":{"m":"복원하다","w":"restore"},"restrict":{"m":"제한하다","w":"restrict"},"retain":{"m":"유지하다","w":"retain"},"retire":{"m":"은퇴하다","w":"retire"},"reveal":{"m":"드러내다; 폭로하다","w":"reveal"},"revenge":{"m":"복수","w":"revenge"},"revenue":{"m":"세입, 수익","w":"revenue"},"reverse":{"m":"뒤집다","w":"reverse"},"revise":{"m":"수정하다","w":"revise"},"revive":{"m":"되살리다, 소생시키다","w":"revive"},"revolve":{"m":"회전하다, 돌다","w":"revolve"},"reward":{"m":"보상","w":"reward"},"ridiculous":{"m":"우스꽝스러운","w":"ridiculous"},"rigid":{"m":"뻣뻣한","w":"rigid"},"rigorous":{"m":"엄격한","w":"rigorous"},"roar":{"m":"으르렁거리다","w":"roar"},"rob":{"m":"약탈하다, 빼앗다","w":"rob"},"role":{"m":"역할","w":"role"},"rough":{"m":"거친","w":"rough"},"roughly":{"m":"대략","w":"roughly"},"route":{"m":"경로","w":"route"},"routine":{"m":"일상","w":"routine"},"rub":{"m":"문지르다, 비비다","w":"rub"},"rugged":{"m":"울퉁불퉁한, 험한","w":"rugged"},"rule":{"m":"규칙","w":"rule"},"rural":{"m":"시골의","w":"rural"},"sacred":{"m":"신성한, 성스러운","w":"sacred"},"sacrifice":{"m":"희생하다","w":"sacrifice"},"safety":{"m":"안전","w":"safety"},"satisfactory":{"m":"만족스러운","w":"satisfactory"},"satisfy":{"m":"만족시키다","w":"satisfy"},"scarce":{"m":"부족한","w":"scarce"},"scared":{"m":"무서워하는, 겁먹은","w":"scared"},"scatter":{"m":"흩뿌리다","w":"scatter"},"scene":{"m":"장면","w":"scene"},"scent":{"m":"향기","w":"scent"},"schedule":{"m":"일정","w":"schedule"},"scold":{"m":"꾸짖다","w":"scold"},"scream":{"m":"비명 지르다","w":"scream"},"seek":{"m":"찾다","w":"seek"},"seize":{"m":"붙잡다","w":"seize"},"seldom":{"m":"좀처럼 않다","w":"seldom"},"select":{"m":"선택하다","w":"select"},"sensible":{"m":"분별 있는","w":"sensible"},"sensitive":{"m":"민감한","w":"sensitive"},"separate":{"m":"분리하다","w":"separate"},"seriously":{"m":"진지하게; 심각하게","w":"seriously"},"sermon":{"m":"설교","w":"sermon"},"service":{"m":"서비스; 봉사","w":"service"},"settle":{"m":"정착하다","w":"settle"},"severe":{"m":"심각한","w":"severe"},"shallow":{"m":"얕은","w":"shallow"},"shame":{"m":"부끄러움","w":"shame"},"share":{"m":"공유하다; 나누다","w":"share"},"shelter":{"m":"피난처","w":"shelter"},"shift":{"m":"옮기다","w":"shift"},"shrink":{"m":"줄어들다","w":"shrink"},"shy":{"m":"수줍은","w":"shy"},"sigh":{"m":"한숨 쉬다","w":"sigh"},"significant":{"m":"중요한","w":"significant"},"silly":{"m":"어리석은","w":"silly"},"similar":{"m":"비슷한","w":"similar"},"simplify":{"m":"단순화하다","w":"simplify"},"simply":{"m":"그냥; 단순히","w":"simply"},"simulate":{"m":"모의실험을 하다; ~인 척하다","w":"simulate"},"sincere":{"m":"진실한","w":"sincere"},"situation":{"m":"상황","w":"situation"},"skeptical":{"m":"회의적인","w":"skeptical"},"skill":{"m":"기술; 능력","w":"skill"},"slightly":{"m":"약간","w":"slightly"},"society":{"m":"사회","w":"society"},"solve":{"m":"해결하다","w":"solve"},"somewhat":{"m":"다소","w":"somewhat"},"source":{"m":"원천","w":"source"},"spare":{"m":"여분의","w":"spare"},"sparkle":{"m":"반짝이다; 반짝임","w":"sparkle"},"species":{"m":"종","w":"species"},"specific":{"m":"구체적인","w":"specific"},"specimen":{"m":"표본, 견본","w":"specimen"},"spend":{"m":"쓰다 (돈·시간을)","w":"spend"},"spill":{"m":"쏟다","w":"spill"},"split":{"m":"나누다","w":"split"},"spoil":{"m":"망치다","w":"spoil"},"spontaneous":{"m":"자발적인","w":"spontaneous"},"spread":{"m":"퍼지다","w":"spread"},"sprinkle":{"m":"뿌리다","w":"sprinkle"},"stable":{"m":"안정적인","w":"stable"},"staff":{"m":"직원","w":"staff"},"stare":{"m":"응시하다","w":"stare"},"startle":{"m":"깜짝 놀라게 하다","w":"startle"},"starve":{"m":"굶주리다","w":"starve"},"statue":{"m":"조각상","w":"statue"},"status":{"m":"지위; 상태","w":"status"},"steady":{"m":"꾸준한","w":"steady"},"stem":{"m":"기인하다; 유래하다","w":"stem"},"stern":{"m":"엄격한","w":"stern"},"stimulate":{"m":"자극하다","w":"stimulate"},"strategy":{"m":"전략","w":"strategy"},"strengthen":{"m":"강화하다","w":"strengthen"},"stretch":{"m":"늘이다","w":"stretch"},"strict":{"m":"엄격한","w":"strict"},"strive":{"m":"노력하다","w":"strive"},"struggle":{"m":"분투하다","w":"struggle"},"stubborn":{"m":"고집 센","w":"stubborn"},"stuff":{"m":"물건; 물질; 채워 넣다","w":"stuff"},"style":{"m":"양식; 방식","w":"style"},"submit":{"m":"제출하다","w":"submit"},"subside":{"m":"진정되다, 가라앉다","w":"subside"},"subsidy":{"m":"보조금","w":"subsidy"},"substance":{"m":"물질","w":"substance"},"substantial":{"m":"상당한","w":"substantial"},"substitute":{"m":"대체하다","w":"substitute"},"subtle":{"m":"미묘한","w":"subtle"},"succeed":{"m":"성공하다","w":"succeed"},"successful":{"m":"성공한, 성공적인","w":"successful"},"successive":{"m":"연속적인, 연이은","w":"successive"},"sudden":{"m":"갑작스러운","w":"sudden"},"suddenly":{"m":"갑자기","w":"suddenly"},"sufficient":{"m":"충분한","w":"sufficient"},"suggest":{"m":"제안하다","w":"suggest"},"suitable":{"m":"적합한","w":"suitable"},"summit":{"m":"정상","w":"summit"},"summon":{"m":"소환하다, 호출하다","w":"summon"},"superficial":{"m":"피상적인, 표면적인","w":"superficial"},"superior":{"m":"우수한","w":"superior"},"supervise":{"m":"감독하다","w":"supervise"},"supply":{"m":"공급","w":"supply"},"support":{"m":"지지하다; 지원하다","w":"support"},"suppose":{"m":"가정하다","w":"suppose"},"suppress":{"m":"억누르다","w":"suppress"},"surface":{"m":"표면","w":"surface"},"surpass":{"m":"능가하다, 초과하다","w":"surpass"},"surround":{"m":"둘러싸다","w":"surround"},"survive":{"m":"생존하다","w":"survive"},"suspect":{"m":"의심하다","w":"suspect"},"suspend":{"m":"정지시키다","w":"suspend"},"sustain":{"m":"지속하다","w":"sustain"},"swear":{"m":"맹세하다","w":"swear"},"symbiotic":{"m":"공생하는","w":"symbiotic"},"sympathy":{"m":"동정","w":"sympathy"},"symptom":{"m":"증상","w":"symptom"},"synthetic":{"m":"합성의","w":"synthetic"},"system":{"m":"체계; 시스템","w":"system"},"tackle":{"m":"다루다","w":"tackle"},"talent":{"m":"재능","w":"talent"},"tame":{"m":"길들이다","w":"tame"},"tease":{"m":"놀리다","w":"tease"},"technology":{"m":"기술","w":"technology"},"temperature":{"m":"온도; 기온","w":"temperature"},"temporary":{"m":"일시적인","w":"temporary"},"tend":{"m":"~하는 경향이 있다","w":"tend"},"tense":{"m":"긴장한","w":"tense"},"terrain":{"m":"지형, 지역","w":"terrain"},"terrestrial":{"m":"지구의; 육지의","w":"terrestrial"},"territory":{"m":"영토, 영역","w":"territory"},"terror":{"m":"공포","w":"terror"},"text":{"m":"글, 문서","w":"text"},"textile":{"m":"직물, 섬유","w":"textile"},"theme":{"m":"주제","w":"theme"},"theory":{"m":"이론","w":"theory"},"therefore":{"m":"그러므로","w":"therefore"},"thorough":{"m":"철저한","w":"thorough"},"thoroughly":{"m":"철저히","w":"thoroughly"},"thread":{"m":"실, 가닥","w":"thread"},"threat":{"m":"위협, 협박","w":"threat"},"threaten":{"m":"위협하다","w":"threaten"},"thrive":{"m":"번성하다","w":"thrive"},"tidy":{"m":"깔끔한","w":"tidy"},"tiny":{"m":"아주 작은","w":"tiny"},"tolerate":{"m":"참다","w":"tolerate"},"tourist":{"m":"관광객","w":"tourist"},"trace":{"m":"흔적","w":"trace"},"trade":{"m":"무역; 거래","w":"trade"},"tradition":{"m":"전통","w":"tradition"},"traffic":{"m":"교통(량)","w":"traffic"},"tragedy":{"m":"비극","w":"tragedy"},"transfer":{"m":"옮기다","w":"transfer"},"transform":{"m":"변형시키다","w":"transform"},"translate":{"m":"번역하다","w":"translate"},"transmit":{"m":"전송하다; 전염시키다","w":"transmit"},"transport":{"m":"운송하다","w":"transport"},"treasure":{"m":"보물","w":"treasure"},"treat":{"m":"다루다","w":"treat"},"tremble":{"m":"떨다","w":"tremble"},"tremendous":{"m":"엄청난","w":"tremendous"},"trend":{"m":"경향","w":"trend"},"trial":{"m":"시험","w":"trial"},"trigger":{"m":"유발하다","w":"trigger"},"triumph":{"m":"승리","w":"triumph"},"trust":{"m":"신뢰","w":"trust"},"typical":{"m":"전형적인","w":"typical"},"ultimate":{"m":"궁극적인","w":"ultimate"},"ultimately":{"m":"궁극적으로","w":"ultimately"},"unbelievable":{"m":"믿을 수 없는","w":"unbelievable"},"uncertain":{"m":"불확실한","w":"uncertain"},"uncover":{"m":"밝히다; 벗기다","w":"uncover"},"undergo":{"m":"겪다","w":"undergo"},"underlying":{"m":"근본적인, 기저의","w":"underlying"},"undermine":{"m":"약화시키다","w":"undermine"},"undertake":{"m":"착수하다","w":"undertake"},"unfair":{"m":"불공평한","w":"unfair"},"unique":{"m":"독특한","w":"unique"},"unite":{"m":"연합하다","w":"unite"},"universal":{"m":"보편적인","w":"universal"},"unnecessary":{"m":"불필요한","w":"unnecessary"},"unpredictable":{"m":"예측 불가능한","w":"unpredictable"},"unusual":{"m":"드문, 특이한","w":"unusual"},"uplift":{"m":"향상시키다, 고양하다","w":"uplift"},"uproot":{"m":"근절하다, 뿌리 뽑다","w":"uproot"},"urban":{"m":"도시의","w":"urban"},"urge":{"m":"촉구하다","w":"urge"},"urgent":{"m":"긴급한","w":"urgent"},"utilize":{"m":"활용하다","w":"utilize"},"vague":{"m":"모호한","w":"vague"},"vain":{"m":"헛된","w":"vain"},"valid":{"m":"유효한","w":"valid"},"validate":{"m":"입증하다, 확인하다","w":"validate"},"valuable":{"m":"귀중한","w":"valuable"},"value":{"m":"가치","w":"value"},"vanish":{"m":"사라지다","w":"vanish"},"variety":{"m":"다양성","w":"variety"},"various":{"m":"다양한","w":"various"},"vary":{"m":"다양하다","w":"vary"},"vast":{"m":"광대한","w":"vast"},"venture":{"m":"모험","w":"venture"},"venue":{"m":"장소 (행사), 개최지","w":"venue"},"victim":{"m":"희생자","w":"victim"},"vital":{"m":"필수적인; 생명의","w":"vital"},"vivid":{"m":"생생한","w":"vivid"},"vogue":{"m":"유행","w":"vogue"},"volunteer":{"m":"자원하다","w":"volunteer"},"vote":{"m":"투표하다","w":"vote"},"wander":{"m":"헤매다","w":"wander"},"warn":{"m":"경고하다","w":"warn"},"waste":{"m":"쓰레기; 낭비","w":"waste"},"weaken":{"m":"약화시키다","w":"weaken"},"wealth":{"m":"부","w":"wealth"},"weary":{"m":"지친, 싫증이 난","w":"weary"},"weep":{"m":"울다","w":"weep"},"weird":{"m":"이상한","w":"weird"},"welfare":{"m":"복지","w":"welfare"},"widely":{"m":"널리","w":"widely"},"widespread":{"m":"널리 퍼진","w":"widespread"},"wisdom":{"m":"지혜","w":"wisdom"},"withdraw":{"m":"철회하다","w":"withdraw"},"witness":{"m":"목격하다; 증인","w":"witness"},"wonder":{"m":"궁금해하다","w":"wonder"},"worship":{"m":"숭배하다","w":"worship"},"worth":{"m":"~의 가치가 있는","w":"worth"},"yield":{"m":"산출하다","w":"yield"}};
const PACK_IDS = new Set(["abandon","abnormal","abroad","absorb","abstract","abundant","abuse","accept","access","accompany","accomplish","accurate","accuse","achieve","achievement","acquire","activate","active","adapt","address","adequate","adjust","admire","admit","adopt","advent","adventure","advocate","affect","afford","aggressive","agree","alleviate","alter","amaze","ambiguous","ambition","amount","analyze","ancient","annoy","antibiotic","anticipate","anxiety","anxious","apologize","apparent","apparently","appeal","appreciate","appropriate","approve","approximate","aptitude","arbitrary","argue","arrange","arrive","art","artificial","artist","ashamed","aspire","assert","assess","assign","assist","associate","assume","astrology","astronomy","atmosphere","attach","attempt","attitude","attract","audience","authority","autobiography","autonomy","available","avoid","aware","awkward","balance","banish","barely","bargain","behavior","beneficial","benefit","beside","besides","betray","biology","biped","blade","blame","blaze","bleed","boast","bother","breathe","breed","brief","briefly","broad","budget","burden","calculate","capable","career","careless","carve","casual","cease","celebrate","cemetery","century","certainly","challenge","cherish","choir","chore","circumstance","circumstantial","circumvent","cite","citizen","civil","civilize","claim","clarify","classify","climate","clue","cognitive","coherent","collaborate","collapse","colleague","combine","comet","commit","common","commotion","communicate","community","companion","compare","compassion","compensate","compete","competent","competitive","complain","complete","complex","comply","component","compose","comprehend","comprehensive","comprise","compromise","conceal","conceive","concentrate","concept","conclude","concur","confer","confess","confidence","confident","confidential","confirm","conflict","conform","confront","confuse","congenial","congratulate","connect","conquer","conscience","conscientious","conscious","consensus","consequence","conserve","consider","considerable","considerate","conspire","constant","constantly","construct","consult","consume","contain","contemplate","context","continent","continue","contradict","contribute","convene","convenient","convert","convey","convince","cooperate","cope","correlate","correlation","correspond","cosmetic","cosmic","cost","countless","courage","crave","create","creative","crime","crowd","crucial","cruel","cultivate","culture","cure","curious","current","curriculum","custom","customer","dairy","dangerous","data","decade","decease","deceive","decide","decision","decisive","declare","decline","decrease","dedicate","deeply","defeat","defend","defer","define","definitely","delay","deliberate","deliberately","delicate","delight","deliver","demand","deny","depart","depend","depress","derive","describe","deserve","design","desire","despair","desperate","destination","destroy","detach","detect","deteriorate","determine","detest","develop","device","devote","devour","diary","differ","digital","dilemma","diminish","diploma","diplomat","disappoint","disapprove","discern","discomfort","discord","discourage","discover","discriminate","discuss","disease","disguise","dismiss","display","dispose","dispute","disrespect","disrupt","distance","distant","distinct","distinguish","distract","distribute","disturb","diverse","divide","dominant","dominate","donate","doubt","draw","dreadful","dreary","drift","dwell","dynamic","eager","earn","ease","economic","economical","economy","edge","educate","effect","effective","efficient","effort","elaborate","election","elegant","eliminate","embarrass","embrace","emerge","emit","emotion","emphasize","empirical","employ","enable","encounter","encourage","endangered","endure","energy","enhance","enormous","ensure","entertain","enthusiasm","entirely","environment","envy","equal","equip","erection","essential","establish","estimate","ethic","ethnic","evaluate","eventually","evidence","evident","evolve","exceed","excess","excessive","exclude","excursion","exercise","exhaust","exhibit","exist","exotic","expand","expedition","expel","expense","expensive","experiment","expire","explain","explore","expose","express","extend","external","extinct","extracurricular","extraordinary","extraterrestrial","extremely","facility","factor","fade","faint","fame","familiar","famine","fascinate","fatigue","fault","favor","fear","feasible","feather","fee","fertile","fierce","flash","flavor","flee","flesh","flexible","float","flourish","fluctuate","flush","focus","forbid","forecast","foreign","forever","former","foundation","fraction","fragile","freedom","frequent","frequently","fresh","friction","friendship","frighten","frustrate","fulfill","function","fund","fundamental","furnish","furthermore","futile","gain","gather","gaze","generate","generation","generous","gently","genuine","geography","geology","gesture","glance","glory","glow","goal","govern","government","grab","gradual","gradually","graduate","grateful","greed","grief","guarantee","guide","guilty","habit","handle","hardly","harsh","harvest","heal","health","heritage","hesitate","heterogeneous","highly","hollow","homogeneous","honest","honor","horror","hostile","however","huge","humble","hypothesis","identify","ignorant","ignore","illegal","illogical","illustrate","imagination","imagine","imitate","immature","immediate","immediately","immense","immoral","impatient","impede","imply","impolite","impose","impossible","impress","improve","inaccurate","inadequate","include","income","incomplete","inconsistent","increase","incur","indeed","indefinite","independent","indicate","indigenous","individual","industry","inevitable","infect","infer","infinite","influence","inform","ingenious","inhabit","inherent","inherit","inject","injure","injury","innocent","inquire","insert","inspire","install","instant","instantly","instead","instinct","instruct","instrument","insult","intend","intense","interact","interfere","intermit","intermittent","interpret","interrupt","intervene","intrinsic","intuition","invade","invent","invention","inventory","invest","investigate","involve","irrational","irregular","irrelevant","irresponsible","irrigate","irritate","jealous","journey","judge","justice","justify","keen","knowledge","labor","lack","launch","lean","leap","leather","legitimate","lengthen","liberal","liberty","likewise","literal","literature","local","locate","locomotive","loyal","luggage","magnificent","maintain","major","majority","malnutrition","manufacture","marital","martial","massive","mature","means","meanwhile","measure","medicine","mental","mention","mercy","mere","merely","method","migrate","mimic","minimal","minor","misbehave","miscalculate","misfortune","misinterpret","mislead","mission","mixture","moan","mob","mobile","moderate","modern","modify","moment","momentary","momentous","monitor","mood","moral","moreover","mostly","motivate","motive","mourn","multiply","muscle","mutual","naive","namely","narrow","natural","nature","nearly","neat","neglect","negotiate","neighbor","nevertheless","noble","notice","notion","nourish","novel","numerous","nutrition","objective","observe","obstacle","obtain","obtainable","obvious","obviously","occasionally","occur","offend","omit","operate","opinion","oppose","oppress","optimistic","ordinary","organize","origin","originate","otherwise","outcome","outdo","outlast","outshine","outstanding","overcome","overlook","oversee","paint","panic","participate","particularly","passion","passport","patience","patient","patrol","patron","peace","peculiar","peddle","pedestal","pedestrian","perceive","perform","period","permanent","permanently","permit","perspective","persuade","phenomenon","physical","plausible","polite","politic","political","pollute","pollution","population","portion","portray","possess","postpone","potential","poverty","praise","precede","precious","precise","precisely","precursor","predict","prediction","prefer","prejudice","prepare","preserve","pretend","prevail","prevent","previous","price","primary","principal","principle","prior","prioritize","private","privilege","proceed","process","product","profit","profound","progress","prohibit","prolong","prominent","promote","prompt","proper","property","prophecy","prophesy","propose","prospective","prosper","prosperity","protect","protest","proud","prove","provide","public","publish","punish","purchase","pure","purpose","pursue","qualify","quantity","quit","ragged","rapid","rare","rarely","rather","react","realize","reap","reason","reasonable","rebel","recall","recede","receipt","recent","recipe","recognize","recommend","recover","recur","recycle","reduce","refer","reflect","reform","refuse","regard","region","register","regret","regulate","reinforce","reject","relate","relationship","relative","release","relevant","reliable","relief","religion","reluctant","rely","remain","remark","remedy","remind","remit","remove","repair","replace","represent","reputation","require","rescue","research","resemble","reserve","reside","resign","resist","resolve","resource","respect","respectable","respective","respire","respond","responsible","responsive","rest","restore","restrict","retain","retire","reveal","revenge","revenue","reverse","revise","revive","revolve","reward","ridiculous","rigid","rigorous","roar","rob","role","rough","roughly","route","routine","rub","rugged","rule","rural","sacred","sacrifice","safety","satisfactory","satisfy","scarce","scared","scatter","scene","scent","schedule","scold","scream","seek","seize","seldom","select","sensible","sensitive","separate","seriously","sermon","service","settle","severe","shallow","shame","share","shelter","shift","shrink","shy","sigh","significant","silly","similar","simplify","simply","simulate","sincere","situation","skeptical","skill","slightly","society","solve","somewhat","source","spare","sparkle","species","specific","specimen","spend","spill","split","spoil","spontaneous","spread","sprinkle","stable","staff","stare","startle","starve","statue","status","steady","stem","stern","stimulate","strategy","strengthen","stretch","strict","strive","struggle","stubborn","stuff","style","submit","subside","subsidy","substance","substantial","substitute","subtle","succeed","successful","successive","sudden","suddenly","sufficient","suggest","suitable","summit","summon","superficial","superior","supervise","supply","support","suppose","suppress","surface","surpass","surround","survive","suspect","suspend","sustain","swear","symbiotic","sympathy","symptom","synthetic","system","tackle","talent","tame","tease","technology","temperature","temporary","tend","tense","terrain","terrestrial","territory","terror","text","textile","theme","theory","therefore","thorough","thoroughly","thread","threat","threaten","thrive","tidy","tiny","tolerate","tourist","trace","trade","tradition","traffic","tragedy","transfer","transform","translate","transmit","transport","treasure","treat","tremble","tremendous","trend","trial","trigger","triumph","trust","typical","ultimate","ultimately","unbelievable","uncertain","uncover","undergo","underlying","undermine","undertake","unfair","unique","unite","universal","unnecessary","unpredictable","unusual","uplift","uproot","urban","urge","urgent","utilize","vague","vain","valid","validate","valuable","value","vanish","variety","various","vary","vast","venture","venue","victim","vital","vivid","vogue","volunteer","vote","wander","warn","waste","weaken","wealth","weary","weep","weird","welfare","widely","widespread","wisdom","withdraw","witness","wonder","worship","worth","yield"]);
/*__PACK_ANSWERS_END__*/

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

  // ★ r17: 랭킹 점수 = 서버 MC 검증분(ver_mc)만(rankWk). att·hash 은퇴 → 콘솔·att 시딩·id-에코 위조가 랭킹에 안 들어감.
  //   att 는 아래 출석·연속(streak) 표시용으로만 유지. 배포 즉시 랭킹은 'MC 퀴즈 푼 만큼'으로 재정비(리셋).
  const wkC = await rankWk(env, uid, week, today);
  const meta = { n: name, w: wkC, s: streak, d: anchor };
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

  return json({ wk: wkC, attWk: wk, streak: streak, cid: cid || null, ceiling: countAllDone(doneByDay, wordIds), bound: bound, dailyCap: dailyCap, weekCap: weekCap, degraded: degraded, attDegraded: att.degraded }, 200, cors);
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
      const fl = await readFlag(env, suid);   // 이상 탐지 플래그(빠른제출·상한초과) — 대시보드 ⚠️ 표시용
      out.push({ uid: suid, name: nm, streak: streakFromDays(att, today), studyDays: Object.keys(att).length, days: att, weekWords: weekWords, flag: fl });
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
      const wkLiveC = await rankWk(env, uid, week, sToday);   // ★ r17: 내 행도 ver_mc(rankWk)만 — 대시보드·남의 행과 동일 산식
      const idx = out.findIndex(function (e) { return e.uid === uid; });
      const meRow = { uid: uid, name: info.name || (idx >= 0 ? out[idx].name : '') || '익명', wk: wkLiveC, streak: stLive, me: true };
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

/* ── 서버 세션 채점 핸들러 (C4/C5/C6) ── */
// 점수 결합: ver(세션 검증) 원장 유니크×상한 + (비은퇴 시) att 상한값과 max. 회귀0(ver 비면 attWk).
// r17: 랭킹 = 서버 MC 검증분(ver_mc)만. att·옛 hash(ver_pack)는 랭킹에서 은퇴(개인·타이핑·소탕 미반영).
//   att 원장은 교사 대시보드 출석·연속(streak) 표시용으로만 유지(랭킹 wk 엔 미반영).
async function rankWk(env, uid, week, today) {
  let vmc = null;
  try { vmc = await env.RANK_KV.get('ver_mc:' + uid, { type: 'json' }); } catch (e) { /* */ }
  const cap = capOf(env.MC_WEEK_CAP, 2000);
  const u = verWeekUnique(vmc || {}, week, today).size;
  return u < cap ? u : cap;
}
// 세션 발급: 이번 판 due 단어를 서버가 실재·분류 확인 후 서명 세션(sid) 발급.
// r17: 시작 — due 팩 id 로 '서버 출제 4지선다(뜻)' 생성. 정답 index 는 세션(KV)에만, 클라엔 보기 4개만 반환.
//   → 답 텍스트를 서버가 받지 않으므로 id-echo 원천 무효. (팩만 랭킹 대상 · 개인/타이핑은 학습 전용.)
async function handleQuizStart(req, env, uid, token, cors) {
  const body = await req.json().catch(() => ({}));
  const smax = capOf(env.SESSION_MAX, 40);
  let ids = Array.isArray(body.ids) ? body.ids : [];
  ids = ids.slice(0, smax).map((x) => String(x).toLowerCase()).filter(Boolean);
  if (!ids.length) return json({ error: 'no_ids' }, 400, cors);
  const rl = await rlHit(env, 'rls:' + uid + ':' + Math.floor(Date.now() / 60000), capOf(env.RL_SESS_PER_MIN, 5), 120);
  if (!rl.ok) return json({ error: 'rate_limited' }, 429, cors);
  const pst = await getState(env, uid, token);
  const wordIds = pst.wordIds;                              // Set(실재 판정) 또는 null(읽기실패/빈words → 가용성 통과)
  const cid = await getClassId(env, uid, token);
  const dyn = cid ? await getClassPackMc(env, cid, token) : { ids: new Set(), mc: {} };
  const pool = mcPool(dyn.mc);                              // 오답 후보 풀(정적 PACK_MC ∪ 동적 배포팩 뜻)
  const sess = { q: {}, exp: 0, used: false };
  const questions = [];
  for (const id of ids) {
    if (!wordIds || !wordIds.has(id)) continue;             // ★실재 요구(빈 words→null 로 임의 id 청구 차단). 정상 학생 무영향.
    if (classifyId(id, dyn.ids) !== 'pack') continue;       // 팩만 랭킹 대상(개인단어 제외)
    const rec = (typeof PACK_MC !== 'undefined' && PACK_MC[id]) || dyn.mc[id];
    if (!rec || !rec.m) continue;                           // 뜻 없음 → 스킵
    const built = mcBuild(String(rec.m), pool);
    if (!built) continue;                                   // 오답 후보 부족 → 스킵
    sess.q[id] = { c: built.c };                            // ★정답 index 는 세션에만(클라 미고지)
    questions.push({ id: id, opts: built.opts });
    if (questions.length >= smax) break;
  }
  if (!questions.length) return json({ error: 'no_valid_ids' }, 400, cors);
  const ttl = capOf(env.SESSION_TTL, 1200);
  sess.exp = Math.floor(Date.now() / 1000) + ttl;
  const nonce = b64urlFromBytes(crypto.getRandomValues(new Uint8Array(12)));
  const sid = await hmacSign(env.QUIZ_SECRET || '', uid + '|' + nonce + '|' + sess.exp);
  try { await env.RANK_KV.put('qs:' + uid + ':' + sid, JSON.stringify(sess), { expirationTtl: ttl + 60 }); }
  catch (e) { return json({ error: 'kv' }, 503, cors); }
  return json({ sid: sid, exp: sess.exp, questions: questions }, 200, cors);
}
// 제출: 세션 로드·1회성 소비 → 각 답 검증(팩=정답대조·개인=세션정합) → ver 원장 적립(버스트 상한) → 보드 갱신.
async function handleQuizSubmit(req, env, uid, token, cors) {
  const body = await req.json().catch(() => ({}));
  const sid = String(body.sid || ''), ans = Array.isArray(body.ans) ? body.ans : [];
  if (!sid || !ans.length) return json({ error: 'bad_req' }, 400, cors);
  const skey = 'qs:' + uid + ':' + sid;
  let sess = null; try { sess = await env.RANK_KV.get(skey, { type: 'json' }); } catch (e) { /* */ }
  if (!sess || !sess.q) return json({ error: 'no_session' }, 400, cors);
  if (sess.used) return json({ error: 'used' }, 400, cors);
  sess.used = true; try { await env.RANK_KV.put(skey, JSON.stringify(sess), { expirationTtl: 120 }); } catch (e) { /* */ }
  const rlA = await rlHit(env, 'rlq:' + uid + ':' + Math.floor(Date.now() / 60000), capOf(env.RL_ANS_PER_MIN, 90), 120);
  if (!rlA.ok) return json({ error: 'rate_limited' }, 429, cors);
  const today = kstToday(Date.now()), week = weekMondayKST(Date.now()), yesterday = isoAddDays(today, -1);
  let vmc = null; try { vmc = await env.RANK_KV.get('ver_mc:' + uid, { type: 'json' }); } catch (e) { /* */ }
  vmc = (vmc && typeof vmc === 'object') ? vmc : {};
  const akey = 'amc:' + uid + ':' + week;                    // r17: id별 주간 채점시도 상한(브루트포스 억제)
  let amc = null; try { amc = await env.RANK_KV.get(akey, { type: 'json' }); } catch (e) { /* */ }
  amc = (amc && typeof amc === 'object') ? amc : {};
  const kmax = capOf(env.MC_ATTEMPTS_PER_ID, 4), burst = capOf(env.PACK_DAILY_BURST, 350);
  const priorWeek = verWeekUnique(vmc, week, yesterday);     // 이번 주 어제까지 검증(신규 판정)
  let newToday = newThisWeekCount(vmc, week, today);         // 오늘 이미 센 '이번주 신규' 수
  const accepted = []; let capped = false, graded = 0, correct = 0;
  for (const a of ans) {
    const id = String((a && a.id) || '').toLowerCase(); if (!id) continue;
    const rec = sess.q[id]; if (!rec) continue;                       // 세션 대상 아님
    if ((amc[id] | 0) >= kmax) continue;                             // r17: 재시도 상한 소진 → 크레딧 불가(브루트포스 억제)
    amc[id] = (amc[id] | 0) + 1; graded++;
    if (Number(a && a.pick) !== rec.c) continue;                     // 오답(고른 번호≠정답 번호) 미집계
    correct++;
    const already = Array.isArray(vmc[today]) && vmc[today].indexOf(id) >= 0;
    const isNew = !priorWeek.has(id) && !already;
    if (isNew && newToday >= burst) { capped = true; continue; }     // 버스트 초과 드롭
    verAddDay(vmc, today, id);
    if (isNew) newToday++;
    if (!already) accepted.push(id);
  }
  try { await env.RANK_KV.put('ver_mc:' + uid, JSON.stringify(vmc), { expirationTtl: TTL }); } catch (e) { /* */ }
  try { await env.RANK_KV.put(akey, JSON.stringify(amc), { expirationTtl: 60 * 60 * 24 * 8 }); } catch (e) { /* */ }
  const cid = await getClassId(env, uid, token);
  const wk = await updateQuizBoard(env, uid, cid, week);
  // ── 이상 탐지(교사 대시보드 ⚠️ 플래그용) ── C1(공개 뜻)로 완전차단 불가 → '탐지+교사 실격'이 실용적 최선.
  //   ① 비인간적 제출 속도(computeFast) ② 버스트 초과(capped) ③ 저정답률(블라인드 추측=25%).
  //   ★뜻을 긁는 인페이지 스크립터는 ~100% 정답이라 저정답률 미탐지 — App Check enforce 로 앱 밖만 차단.
  const fastFlag = computeFast(ans, capOf(env.FLAG_FAST_MS, 500));
  const lowAcc = graded >= capOf(env.FLAG_LOWACC_MIN, 5) && (correct / graded) < (Number(env.FLAG_LOWACC_RATE) || 0.5);
  if (fastFlag || capped || lowAcc) await recordFlag(env, uid, fastFlag, capped, lowAcc, today);
  return json({ accepted: accepted, wk: wk, capped: capped }, 200, cors);
}
// r17: 보드(c:/g:) w 를 rankWk(ver_mc)로 직접 기록 → 이전 부풀린 값 하향(‘max’·att·hash 폐기). 이름/연속(n/s/d) 보존.
async function updateQuizBoard(env, uid, cid, week) {
  const today = kstToday(Date.now());
  const newW = await rankWk(env, uid, week, today);                   // r17: ver_mc 기반 — att·hash 미반영
  const nowSec = Math.floor(Date.now() / 1000);
  const keys = ['g:' + week + ':' + uid]; if (cid) keys.push('c:' + week + ':' + cid + ':' + uid);
  for (const key of keys) {
    let prev = null; try { prev = (await env.RANK_KV.getWithMetadata(key)).metadata; } catch (e) { /* */ }
    if (prev && prev.w === newW) continue;                            // 변화 없음 → 쓰기 절약(이전 부풀린 값은 하향 기록)
    const meta = prev ? { n: prev.n || '익명', w: newW, s: prev.s || 0, d: prev.d || null, at: nowSec }
      : { n: '익명', w: newW, s: 0, d: null, at: nowSec };
    try { await env.RANK_KV.put(key, '', { metadata: meta, expirationTtl: TTL }); } catch (e) { /* */ }
  }
  return newW;
}

/* ── 이상 탐지(교사 플래그) — 완전차단 불가(C1)의 실용 대안: 탐지+교사 실격 ── */
// 비인간적 제출 속도: 클라 t(제출시각) 중앙 간격이 thresholdMs 미만이면 true(≥5개일 때만).
//   클라 t 는 위조 가능이라 '게으른 스크립트'만 잡는 best-effort 신호(선생님 확인용, 자동 차단 아님).
function computeFast(ans, thresholdMs) {
  var t = []; for (var i = 0; i < ans.length; i++) { var v = ans[i] && +ans[i].t; if (v > 0) t.push(v); }
  if (t.length < 5) return false;
  t.sort(function (a, b) { return a - b; });
  var gaps = []; for (var i = 1; i < t.length; i++) gaps.push(t[i] - t[i - 1]);
  gaps.sort(function (a, b) { return a - b; });
  return gaps[Math.floor(gaps.length / 2)] < thresholdMs;
}
// 플래그 누적: flag:{uid} = { f:빠른제출, b:상한초과, l:저정답률, at:마지막날 }. 21일 롤링. (r17: l 추가)
async function recordFlag(env, uid, fast, burst, lowacc, today) {
  var key = 'flag:' + uid, cur = null;
  try { cur = await env.RANK_KV.get(key, { type: 'json' }); } catch (e) { /* */ }
  cur = (cur && typeof cur === 'object') ? cur : { f: 0, b: 0, l: 0, at: null };
  if (fast) cur.f = (cur.f | 0) + 1;
  if (burst) cur.b = (cur.b | 0) + 1;
  if (lowacc) cur.l = (cur.l | 0) + 1;
  cur.at = today;
  try { await env.RANK_KV.put(key, JSON.stringify(cur), { expirationTtl: 60 * 60 * 24 * 21 }); } catch (e) { /* */ }
}
async function readFlag(env, uid) {
  try { var c = await env.RANK_KV.get('flag:' + uid, { type: 'json' }); if (c && typeof c === 'object') return { fast: c.f | 0, burst: c.b | 0, lowacc: c.l | 0, at: c.at || null }; } catch (e) { /* */ }
  return null;
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
// P2(가용성): verifyFirebase 결과를 '토큰 해시' 키로 KV 캐시(TTL AUTH_CACHE_SEC·기본 300s). 같은 토큰의
//   반복 요청이 Identity Toolkit(accounts:lookup) 을 매번 때리는 증폭을 제거한다(브라우저 루프 방어).
//   원문 토큰은 저장하지 않는다(sha256 앞 40hex). 폐기/만료 토큰이 최대 TTL 잔존하나 저위험(수용).
async function verifyFirebaseCached(env, idToken) {
  if (!idToken) return null;
  const ck = 'auth:' + (await sha256hex(idToken)).slice(0, 40);
  try { const c = await env.RANK_KV.get(ck, { type: 'json' }); if (c && c.uid) return c; } catch (e) { /* 캐시 미스/장애 → 정규 검증 */ }
  const u = await verifyFirebase(idToken, env.FIREBASE_API_KEY);
  if (u && u.uid) { try { await env.RANK_KV.put(ck, JSON.stringify(u), { expirationTtl: capOf(env.AUTH_CACHE_SEC, 300) }); } catch (e) { /* 무시 */ } }
  return u;
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
/* ============================================================================
   서버 세션 채점 — 순수·암호 유틸 (C2) + App Check JWKS 검증 (C3)
   ★ normEn/normKo 는 scripts/build-pack-answers.mjs 와 '바이트 동일' 이어야 한다
     (팩 정답 he/hk 대조가 build↔runtime 라운드트립이라 불일치 시 전 팩 검증 실패).
   ============================================================================ */
const _te = new TextEncoder();
function b64urlFromBytes(bytes) { let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function bytesFromB64url(str) { str = String(str || '').replace(/-/g, '+').replace(/_/g, '/'); while (str.length % 4) str += '='; const bin = atob(str); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
// HMAC-SHA256 서명(base64url) — 세션 sid 위조 방지.
async function hmacSign(secret, msg) {
  const key = await crypto.subtle.importKey('raw', _te.encode(String(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, _te.encode(String(msg)));
  return b64urlFromBytes(new Uint8Array(sig));
}
async function hmacVerify(secret, msg, sig) {
  const expect = await hmacSign(secret, msg);
  if (typeof sig !== 'string' || sig.length !== expect.length) return false;
  let diff = 0; for (let i = 0; i < expect.length; i++) diff |= expect.charCodeAt(i) ^ sig.charCodeAt(i); return diff === 0;
}
async function sha256hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', _te.encode(String(str)));
  const b = new Uint8Array(buf); let h = ''; for (let i = 0; i < b.length; i++) h += b[i].toString(16).padStart(2, '0'); return h;
}
// ★ scripts/build-pack-answers.mjs 와 동일 정의(변경 시 양쪽 동시).
function normEn(x) { return String(x == null ? '' : x).toLowerCase().trim().replace(/\s+/g, ' '); }
function normKo(x) { return String(x == null ? '' : x).trim().replace(/\s+/g, ' '); }
// 팩/개인 분류: 정적 PACK_IDS(번들) ∪ 동적 배포팩 id.
function classifyId(id, dynIds) { id = String(id).toLowerCase(); if (typeof PACK_IDS !== 'undefined' && PACK_IDS.has(id)) return 'pack'; if (dynIds && dynIds.has && dynIds.has(id)) return 'pack'; return 'personal'; }
// rate-limit(KV 카운터·근사·비원자적). 읽기 실패는 통과(가용성 우선).
async function rlHit(env, key, limit, windowSec) {
  let n = 0; try { const v = await env.RANK_KV.get(key); n = v ? (parseInt(v, 10) || 0) : 0; } catch (e) { return { ok: true, n: 0 }; }
  if (n >= limit) return { ok: false, n: n };
  try { await env.RANK_KV.put(key, String(n + 1), { expirationTtl: windowSec }); } catch (e) { /* 무시 */ }
  return { ok: true, n: n + 1 };
}
// ver 원장 { 'YYYY-MM-DD':[id…] } — (id×날짜) 유니크.
function verAddDay(map, day, id) { if (!map[day]) map[day] = []; if (map[day].indexOf(id) < 0) map[day].push(id); }
function verWeekUnique(map, weekMon, today) { const s = new Set(); if (map) for (const d in map) { if (d >= weekMon && d <= today) { const a = map[d]; if (Array.isArray(a)) for (let i = 0; i < a.length; i++) s.add(a[i]); } } return s; }
// 하루 '이번 주 신규' 팩 id 수(버스트 판정) — 오늘치 중 이번 주 이전 날에 없던 id.
function newThisWeekCount(map, weekMon, today) {
  const prior = new Set(); for (const d in map) { if (d >= weekMon && d < today) { const a = map[d]; if (Array.isArray(a)) for (let i = 0; i < a.length; i++) prior.add(a[i]); } }
  const t = Array.isArray(map[today]) ? map[today] : []; let n = 0; for (let i = 0; i < t.length; i++) if (!prior.has(t[i])) n++; return n;
}
// r17: 동적 배포팩 평문(뜻 m·단어 w)+id — classPacks/{cid} 읽어 계산(워커=소유교사 토큰 read·학생 write 불가). 5분 KV 캐시.
async function getClassPackMc(env, cid, token) {
  if (!cid) return { ids: new Set(), mc: {} };
  const ck = 'cmc:' + cid;                                  // r17: 신규 캐시 키(옛 cpa: he/hk shape 와 분리)
  try { const c = await env.RANK_KV.get(ck, { type: 'json' }); if (c && c.mc && Array.isArray(c.ids)) return { ids: new Set(c.ids), mc: c.mc }; } catch (e) { /* 없음 */ }
  const doc = await fsGet(env, 'classPacks/' + cid, token);
  const vals = doc && doc.fields && doc.fields.words && doc.fields.words.arrayValue && doc.fields.words.arrayValue.values;
  const mc = {}, ids = [];
  if (Array.isArray(vals)) for (const wv of vals) {
    const f = wv && wv.mapValue && wv.mapValue.fields; if (!f) continue;
    const w = f.w && f.w.stringValue, m = (f.m && f.m.stringValue) || '';
    if (!w) continue; const id = String(w).toLowerCase();
    mc[id] = { m: m, w: w };                                // 평문(뜻은 이미 공개) — 서버 출제 4지선다 정답·오답풀에 사용
    ids.push(id);
  }
  try { await env.RANK_KV.put(ck, JSON.stringify({ ids: ids, mc: mc }), { expirationTtl: 300 }); } catch (e) { /* 무시 */ }
  return { ids: new Set(ids), mc: mc };
}
// r17: 서버 출제 4지선다 — 오답 후보 풀(정적 PACK_MC ∪ 동적 배포팩 뜻).
function mcPool(dynMc) {
  const s = [];
  if (typeof PACK_MC !== 'undefined') for (const k in PACK_MC) { const m = PACK_MC[k] && PACK_MC[k].m; if (m) s.push(String(m)); }
  if (dynMc) for (const k in dynMc) { const m = dynMc[k] && dynMc[k].m; if (m) s.push(String(m)); }
  return s;
}
// 정답 뜻 + 오답 3개(풀에서·정답과 동일/부분겹침 제거=near-synonym 혼동 방지)를 섞어 {opts:[4], c:정답idx}. 후보<3 이면 null.
function mcBuild(correct, pool, rnd) {
  const r = rnd || Math.random;
  const seen = {}; seen[correct] = 1;
  const cand = [];
  for (let i = 0; i < pool.length; i++) {
    const p = pool[i];
    if (!p || seen[p]) continue;
    if (p === correct || p.indexOf(correct) >= 0 || correct.indexOf(p) >= 0) continue;
    seen[p] = 1; cand.push(p);
  }
  if (cand.length < 3) return null;
  for (let i = cand.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); const t = cand[i]; cand[i] = cand[j]; cand[j] = t; }
  const opts = [correct, cand[0], cand[1], cand[2]];
  for (let i = opts.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); const t = opts[i]; opts[i] = opts[j]; opts[j] = t; }
  return { opts: opts, c: opts.indexOf(correct) };
}
// App Check JWKS 공개키(kid) — Firebase App Check jwks, 1h KV 캐시.
async function getAppCheckJwk(env, kid) {
  let jwks = null;
  try { jwks = await env.RANK_KV.get('acjwks', { type: 'json' }); } catch (e) { /* */ }
  if (!jwks) { try { const r = await fetch('https://firebaseappcheck.googleapis.com/v1/jwks'); if (r.ok) { jwks = await r.json(); try { await env.RANK_KV.put('acjwks', JSON.stringify(jwks), { expirationTtl: 3600 }); } catch (e) { } } } catch (e) { } }
  if (!jwks || !Array.isArray(jwks.keys)) return null;
  for (const k of jwks.keys) if (k.kid === kid) return k;
  return null;
}
// App Check 토큰(JWT, RS256) 검증. PROJECT_NUMBER 미설정→스킵. APPCHECK_ENFORCE!=='true'→실패해도 통과(모니터링).
async function verifyAppCheck(token, env) {
  const projNum = env.PROJECT_NUMBER;
  if (!projNum) return { ok: true, skipped: true };
  const enforce = String(env.APPCHECK_ENFORCE || '') === 'true';
  const fail = (reason) => enforce ? { ok: false, reason: reason } : { ok: true, degraded: reason };
  if (!token) return fail('no_token');
  try {
    const parts = String(token).split('.');
    if (parts.length !== 3) return fail('malformed');
    const header = JSON.parse(new TextDecoder().decode(bytesFromB64url(parts[0])));
    const payload = JSON.parse(new TextDecoder().decode(bytesFromB64url(parts[1])));
    const now = Math.floor(Date.now() / 1000);
    if (!payload.exp || payload.exp < now - 60) return fail('expired');
    const aud = payload.aud, audArr = Array.isArray(aud) ? aud : [aud];
    if (!audArr.some((x) => x === 'projects/' + projNum)) return fail('aud');
    if (payload.iss !== 'https://firebaseappcheck.googleapis.com/' + projNum) return fail('iss');
    const jwk = await getAppCheckJwk(env, header.kid);
    if (!jwk) return fail('no_key');
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, bytesFromB64url(parts[2]), _te.encode(parts[0] + '.' + parts[1]));
    if (!valid) return fail('bad_sig');
    return { ok: true, sub: payload.sub };
  } catch (e) { return fail('error'); }
}
// (단위 테스트용 export 는 모듈 형식인 worker.js 에만 있다 — 이 파일은 붙여넣기 전용)
