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
   ★ KV 네임스페이스 바인딩 이름: OCR_KV  — 카운터 저장용.
     이 바인딩이 있어야 학생별 하루 상한이 서버에서 "우회 불가"로 강제됩니다.
     (바인딩이 없으면 클라이언트 소프트 제한만 적용 = 우회 가능.)
   ============================================================================ */

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
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, cors);

    try {
      if (!env.ANTHROPIC_API_KEY) return json({ error: 'server_misconfig' }, 500, cors);

      // 1) 로그인 토큰 검증 — 이 앱의 로그인 사용자만
      const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      const uid = await verifyFirebase(token, env.FIREBASE_API_KEY);
      if (!uid) return json({ error: 'unauthorized' }, 401, cors);

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
      const ar = await fetch('https://api.anthropic.com/v1/messages', {
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

function json(o, status, cors) {
  return new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...cors } });
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
