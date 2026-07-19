/* ============================================================================
   WordQuest OCR 프록시 (Cloudflare Worker)
   ----------------------------------------------------------------------------
   목적: Claude(Anthropic) 비전 API 키를 학생 120명 손(클라이언트)에 노출하지
        않고, 사진 → "영어단어 - 한국어뜻" 목록으로 변환해 돌려준다.

   보안/비용 안전장치:
     · Firebase 로그인 토큰을 검증 → 이 앱의 로그인 사용자만 호출 가능(무단 사용 차단).
     · KV로 (a) 학생(uid)별 하루 상한, (b) 하루 전체 호출 상한 → 서버에서 강제.
       학생별 제한을 계정 기준으로 서버가 세므로, 기기·브라우저·시크릿창을 바꿔도
       우회 불가(클라이언트 localStorage 카운터는 빠른 표시용 힌트일 뿐).
     · 이미지 크기 제한. 최종 상한은 Anthropic 콘솔의 월 지출 한도로.

   필요한 환경변수(Cloudflare 대시보드 Settings → Variables):
     ANTHROPIC_API_KEY  (Secret)  — 본인 Claude API 키
     FIREBASE_API_KEY   (Variable) — firebase-config.js 의 apiKey(공개값)
     MODEL              (선택)      — 기본 claude-haiku-4-5-20251001
     USER_DAILY_LIMIT   (선택)      — 학생 1인당 하루 스캔 상한(기본 8). KV 바인딩 시 강제
     DAILY_CAP          (선택)      — 하루 전체 호출 상한(기본 500). KV 바인딩 시 적용
     ALLOW_ORIGIN       (선택)      — 허용할 앱 도메인(기본 *). 예: https://your-app.web.app
     PROJECT_NUMBER     (선택)      — Firebase 프로젝트 번호(=firebase-config.js 의 messagingSenderId).
                                      App Check 토큰(JWT) 의 aud/iss 검증에 사용(o2).
     APPCHECK_ENFORCE   (선택)      — 'true' 면 App Check 토큰 필수 = 앱 밖 스크립트의 유료 Claude 호출
                                      (비용·DAILY_CAP 소진 공격) 차단. ★PROJECT_NUMBER 와 함께 설정할 것
                                      (enforce=true 인데 번호 누락이면 misconfig 로 전부 거부 — 페일클로즈드).
                                      미설정/false = 기존과 100% 동일(도먼트·무회귀). 롤백 = false (재배포 불요).
                                      ★켜는 순서: 클라 v125(App Check 헤더 동봉) 전파 후에만. docs/appcheck-setup.md
   ★ KV 네임스페이스 바인딩 이름: OCR_KV  — 카운터 저장용(★필수).
     이 바인딩이 있어야 학생별/전체 하루 상한이 서버에서 "우회 불가"로 강제됩니다.
     ★ 바인딩이 없으면 유료 호출을 아예 거부한다(500) — 과거엔 무제한 과금 fail-open 이었음.
       배포 시 반드시 OCR_KV 를 바인딩할 것.
   ============================================================================ */

const REV = 'o2';   // 코드 리비전(모든 응답 v 필드) — 배포 확인: 워커 주소를 브라우저로 열면
                    // {"error":"method_not_allowed","v":"o2"} 가 보인다. 로직 바꾸면 올릴 것.
//   o2: App Check 게이트(도먼트) — PROJECT_NUMBER+APPCHECK_ENFORCE=true 설정 시 앱 밖 스크립트의
//       유료 Claude 호출 차단. CORS Allow-Headers 에 X-Firebase-AppCheck 추가(클라 v125 부터 동봉).
//       미설정이면 동작 변화 0. (그 이전 무리비전 코드 = o1 로 간주.)

const PROMPT =
  '이 이미지는 영어 단어 학습 자료(단어장/교재)입니다. ' +
  '영어 단어와 그 한국어 뜻만 뽑아 한 줄에 하나씩 정확히 "영어단어 - 한국어뜻" 형식으로만 출력하세요. ' +
  '규칙: (1) 예문(영어 문장), 발음기호, 품사표, 번호, 제목, 챕터명, 설명은 모두 제외. ' +
  '(2) 한 단어에 뜻이 여러 개면 세미콜론(;)으로 구분. ' +
  '(3) 목록 외의 인사말·설명·코드블록 표시는 절대 넣지 말 것. ' +
  '(4) 사진에 단어가 없으면 아무것도 출력하지 마세요.';

export default {
  async fetch(req, env) {
    const allow = env.ALLOW_ORIGIN || '*';
    const cors = {
      'Access-Control-Allow-Origin': allow,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Firebase-AppCheck',   // o2: App Check 헤더 허용(없으면 토큰 동봉 브라우저의 프리플라이트가 거부됨)
      'Access-Control-Max-Age': '86400',
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, cors);

    try {
      if (!env.ANTHROPIC_API_KEY) return json({ error: 'server_misconfig' }, 500, cors);
      // ★ 비용 방어(fail-closed): KV 미바인딩 = 서버측 상한 0 = 무제한 유료 호출.
      //   KV 가 없으면 유료 Claude 호출을 아예 막는다(과거엔 여기서 무제한 통과했음). OCR_KV 바인딩 필수.
      if (!env.OCR_KV) return json({ error: 'server_misconfig', detail: 'ocr_kv_required' }, 500, cors);

      // 1) 로그인 토큰 검증 — 이 앱의 로그인 사용자만
      const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      const uid = await verifyFirebase(token, env.FIREBASE_API_KEY);
      if (!uid) return json({ error: 'unauthorized' }, 401, cors);

      // 1b) App Check 게이트(o2·기본 도먼트) — env PROJECT_NUMBER+APPCHECK_ENFORCE=true 로 켜면
      //     앱 밖 스크립트(curl 등)의 유료 Claude 호출을 차단. 클라(v125+)는 403 'appcheck' 를 받으면
      //     기기 내 무료 OCR(Tesseract)로 강등하므로 학생 기능은 살아 있다.
      const ac = await verifyAppCheck(req.headers.get('X-Firebase-AppCheck'), env);
      if (!ac.ok) return json({ error: 'appcheck', reason: ac.reason }, 403, cors);

      // 2) 이미지 파싱
      const body = await req.json().catch(() => ({}));
      const m = /^data:(image\/(?:jpeg|png|webp));base64,([\s\S]+)$/.exec(body.image || '');
      if (!m) return json({ error: 'bad_image' }, 400, cors);
      const mediaType = m[1], b64 = m[2];
      if (b64.length > 7000000) return json({ error: 'image_too_large' }, 413, cors); // 약 5MB

      // 3) 한도 — KV 바인딩 시 서버에서 강제(우회 불가). 학생별 + 전체.
      const day = new Date().toISOString().slice(0, 10);
      const userLim = parseInt(env.USER_DAILY_LIMIT || '8', 10) || 8;
      let userKey = null, userCur = 0;
      if (env.OCR_KV) {
        // 3a) 하루 전체 상한(비용 폭주 차단) — 시도 기준 카운트(보수적).
        const gKey = 'cnt:' + day;
        const gCur = parseInt((await env.OCR_KV.get(gKey)) || '0', 10) || 0;
        const cap = parseInt(env.DAILY_CAP || '500', 10) || 500;
        if (gCur >= cap) return json({ error: 'daily_cap_reached' }, 429, cors);

        // 3b) 학생(uid)별 하루 상한 — 로그인 계정 기준이라 기기·브라우저를 바꿔도 못 넘김.
        userKey = 'u:' + uid + ':' + day;
        userCur = parseInt((await env.OCR_KV.get(userKey)) || '0', 10) || 0;
        if (userCur >= userLim) return json({ error: 'user_daily_cap_reached', limit: userLim, remaining: 0 }, 429, cors);

        // 근사 카운터(최종 상한은 Anthropic 지출 한도로 보장)
        await env.OCR_KV.put(gKey, String(gCur + 1), { expirationTtl: 172800 });
      }

      // 4) Claude 비전 호출
      // 기본은 Anthropic 직접 호출. 다만 Cloudflare Worker egress 가 Anthropic 에 막히는 리전
      // (403 "Request not allowed")이면, env.ANTHROPIC_BASE 에 Cloudflare AI Gateway 주소를 넣어
      // 게이트웨이 경유로 우회한다. 예: https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic
      //   (헤더·본문 동일. 게이트웨이가 /v1/messages 를 그대로 Anthropic 으로 전달.)
      const base = (env.ANTHROPIC_BASE || 'https://api.anthropic.com').replace(/\/+$/, '');
      const ar = await fetch(base + '/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: env.MODEL || 'claude-haiku-4-5-20251001',
          max_tokens: 1500,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
              { type: 'text', text: PROMPT },
            ],
          }],
        }),
      });
      if (!ar.ok) {
        const t = await ar.text();
        return json({ error: 'upstream_error', status: ar.status, detail: t.slice(0, 300) }, 502, cors);
      }
      const data = await ar.json();
      const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();

      // 학생별 카운터: 성공(2xx) 응답은 결과가 비어 있어도 실제 Anthropic 호출(=비용)이 일어났으므로 차감한다.
      //   (빈 이미지를 반복 전송해 계정별 한도를 우회하던 허점 차단. upstream 실패(502)는 위에서 이미 early-return
      //    되므로 여기 도달 = 실제 호출 발생. 정상 학생이 빈 사진을 하루 상한만큼 찍을 일은 없어 공정성 영향은 미미.)
      let remaining = null;
      if (env.OCR_KV && userKey) {
        userCur += 1;
        await env.OCR_KV.put(userKey, String(userCur), { expirationTtl: 172800 });
        remaining = Math.max(0, userLim - userCur);
      }
      return json({ text, remaining, limit: userLim }, 200, cors);
    } catch (e) {
      return json({ error: 'server_error', detail: String((e && e.message) || e).slice(0, 200) }, 500, cors);
    }
  },
};

// 모든 응답에 v(코드 리비전)를 실어 배포 확인을 쉽게 한다(rank-worker 와 동일 패턴).
function json(o, status, cors) {
  return new Response(JSON.stringify(Object.assign({ v: REV }, o)), { status, headers: { 'content-type': 'application/json', ...cors } });
}

// Firebase ID 토큰 검증: Google Identity Toolkit accounts:lookup 로 확인(간단·정확).
// FIREBASE_API_KEY 는 공개값(firebase-config.js의 apiKey)이라 서버에 둬도 안전.
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

/* ── App Check 검증(o2) — rank-worker r19 의 verifyAppCheck 와 동일 로직(자립 이식본).
      로직을 고치면 rank-worker/worker.js·worker-dashboard.js 의 쌍둥이도 함께 볼 것. ── */
const _te = new TextEncoder();
function bytesFromB64url(str) { str = String(str || '').replace(/-/g, '+').replace(/_/g, '/'); while (str.length % 4) str += '='; const bin = atob(str); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
// App Check JWKS 공개키(kid) — Firebase App Check jwks, OCR_KV 에 1h 캐시(캐시 실패해도 동작).
async function getAppCheckJwk(env, kid) {
  let jwks = null;
  try { jwks = await env.OCR_KV.get('acjwks', { type: 'json' }); } catch (e) { /* */ }
  if (!jwks) { try { const r = await fetch('https://firebaseappcheck.googleapis.com/v1/jwks'); if (r.ok) { jwks = await r.json(); try { await env.OCR_KV.put('acjwks', JSON.stringify(jwks), { expirationTtl: 3600 }); } catch (e) { } } } catch (e) { } }
  if (!jwks || !Array.isArray(jwks.keys)) return null;
  for (const k of jwks.keys) if (k.kid === kid) return k;
  return null;
}
// App Check 토큰(JWT, RS256) 검증. APPCHECK_ENFORCE!=='true'→실패해도 통과(모니터링·degraded 사유만 기록).
//   페일클로즈드: enforce=true 인데 PROJECT_NUMBER 미설정이면 misconfig 로 거부(조용한 무력화 방지).
async function verifyAppCheck(token, env) {
  const projNum = env.PROJECT_NUMBER;
  const enforce = String(env.APPCHECK_ENFORCE || '') === 'true';
  if (!projNum) return enforce ? { ok: false, reason: 'misconfig' } : { ok: true, skipped: true };
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
