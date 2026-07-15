/* ============================================================================
   WordQuest 선생님 인증 (Cloudflare Worker)
   ----------------------------------------------------------------------------
   목적: "선생님으로 승격"을 서버에서만 판정한다. 학생이 소스/콘솔에서 스스로
        role='teacher' 를 쓰거나 반을 만드는 우회를 원천 차단.

   흐름:
     1) 앱(로그인 학생)이 { idToken, password } 를 이 Worker 로 POST.
     2) idToken 검증(Identity Toolkit accounts:lookup) → uid 확보(계정 위조 불가).
     3) password 를 서버 비밀값 TEACHER_PW 와 상수시간 비교.
     4) 맞으면 Firebase Admin(서비스계정)으로 그 uid 에 커스텀 클레임 teacher=true 부여.
     5) 앱은 토큰을 강제 갱신(getIdToken(true))해 새 클레임을 받는다.
   → 이후 firestore.rules 의 isTeacher()(=request.auth.token.teacher==true)만
     선생님 쓰기를 허용하므로, 비밀번호를 모르면(=이 Worker 를 못 통과하면) 승격 불가.

   ★ 비밀번호는 이 Worker 의 "환경변수(Secret)"에만 존재. 앱/소스에는 없음.
   ★ 비밀번호는 반드시 길고 무작위로(예: 20자+). 4자리 숫자는 무차별 대입에 취약.

   필요한 환경변수(Cloudflare 대시보드 → Worker → Settings → Variables):
     TEACHER_PW                (Secret)   — 선생님 전용 비밀번호(길게!).
     FIREBASE_SERVICE_ACCOUNT  (Secret)   — Firebase 서비스계정 JSON 전체 문자열.
                                            (콘솔 → 프로젝트 설정 → 서비스 계정 →
                                             새 비공개 키 생성 으로 받은 JSON)
     FIREBASE_API_KEY          (Variable) — firebase-config.js 의 apiKey(공개값).
     ALLOW_ORIGIN              (선택)      — 허용할 앱 도메인(기본 *).
                                            예: https://ranha0924.github.io
   ★ 선택 KV 바인딩 TEACHER_KV — 무차별 대입 방어(uid별/전체 시도 상한). 강력 권장.
   ============================================================================ */

const CLAIM = { teacher: true };            // 부여할 커스텀 클레임
const MAX_TRIES_PER_UID = 10;               // uid당 하루 비밀번호 시도 상한(KV 있을 때)
const MAX_TRIES_GLOBAL = 300;               // 전체 하루 시도 상한(KV 있을 때)

export default {
  async fetch(req, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (req.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405, cors);

    try {
      if (!env.TEACHER_PW || !env.FIREBASE_SERVICE_ACCOUNT || !env.FIREBASE_API_KEY) {
        return json({ ok: false, error: 'server_misconfig' }, 500, cors);
      }

      const body = await req.json().catch(() => ({}));
      const idToken = body.idToken || '';
      const password = typeof body.password === 'string' ? body.password : '';

      // 1) 로그인 토큰 검증 → uid (이 앱의 로그인 사용자만, 계정 위조 불가)
      const uid = await verifyFirebase(idToken, env.FIREBASE_API_KEY);
      if (!uid) return json({ ok: false, error: 'unauthorized' }, 401, cors);

      // 2) 무차별 대입 방어(선택 KV) — uid별 + 전체 시도 상한.
      const day = new Date().toISOString().slice(0, 10);
      if (env.TEACHER_KV) {
        const gKey = 'try:' + day;
        const gCur = parseInt((await env.TEACHER_KV.get(gKey)) || '0', 10) || 0;
        if (gCur >= MAX_TRIES_GLOBAL) return json({ ok: false, error: 'rate_limited' }, 429, cors);
        const uKey = 'try:' + uid + ':' + day;
        const uCur = parseInt((await env.TEACHER_KV.get(uKey)) || '0', 10) || 0;
        if (uCur >= MAX_TRIES_PER_UID) return json({ ok: false, error: 'rate_limited' }, 429, cors);
        // 시도 자체를 먼저 카운트(성공/실패 무관) → 대입 비용을 못 낮추게.
        await env.TEACHER_KV.put(gKey, String(gCur + 1), { expirationTtl: 172800 });
        await env.TEACHER_KV.put(uKey, String(uCur + 1), { expirationTtl: 172800 });
      }

      // 3) 비밀번호 상수시간 비교
      if (!password || !constEq(password, env.TEACHER_PW)) {
        return json({ ok: false, error: 'bad_password' }, 403, cors);
      }

      // 4) 서비스계정으로 커스텀 클레임 부여
      let sa;
      try { sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT); }
      catch (e) { return json({ ok: false, error: 'server_misconfig', detail: 'bad_service_account_json' }, 500, cors); }
      const accessToken = await getAccessToken(sa);
      await setCustomClaims(uid, CLAIM, sa.project_id, accessToken);

      return json({ ok: true }, 200, cors);
    } catch (e) {
      return json({ ok: false, error: 'server_error', detail: String((e && e.message) || e).slice(0, 200) }, 500, cors);
    }
  },
};

/* ── 응답 헬퍼 ── */
function json(o, status, cors) {
  return new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...cors } });
}

/* ── 상수시간 문자열 비교(타이밍 공격 완화) ── */
function constEq(a, b) {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  // 길이 차이도 상수시간에 흡수: 최대 길이만큼 순회.
  const n = Math.max(ea.length, eb.length);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < n; i++) diff |= (ea[i] || 0) ^ (eb[i] || 0);
  return diff === 0;
}

/* ── Firebase ID 토큰 검증: Identity Toolkit accounts:lookup(공개 apiKey) ── */
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

/* ── 커스텀 클레임 부여: projects/{pid}/accounts:update (Admin 권한 필요) ── */
async function setCustomClaims(uid, claims, projectId, accessToken) {
  const r = await fetch(
    'https://identitytoolkit.googleapis.com/v1/projects/' + encodeURIComponent(projectId) + '/accounts:update',
    {
      method: 'POST',
      headers: { 'authorization': 'Bearer ' + accessToken, 'content-type': 'application/json' },
      body: JSON.stringify({ localId: uid, customAttributes: JSON.stringify(claims) }),
    }
  );
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new Error('set_claim_failed: ' + ((d.error && d.error.message) || r.status));
  }
  return true;
}

/* ── 서비스계정 → OAuth2 access_token (RS256 JWT, Web Crypto 서명) ── */
async function getAccessToken(sa) {
  if (!sa || !sa.client_email || !sa.private_key) throw new Error('bad_service_account');
  const nowSec = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/identitytoolkit',
    aud: sa.token_uri || 'https://oauth2.googleapis.com/token',
    iat: nowSec,
    exp: nowSec + 3600,
  };
  const unsigned = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(claim));
  const key = await crypto.subtle.importKey(
    'pkcs8', pemToDer(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const jwt = unsigned + '.' + b64urlBytes(new Uint8Array(sig));

  const r = await fetch(sa.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + encodeURIComponent(jwt),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error('oauth_failed: ' + (d.error_description || d.error || r.status));
  return d.access_token;
}

/* ── PEM(PKCS#8) → DER ArrayBuffer ── */
function pemToDer(pem) {
  const b64 = String(pem).replace(/-----BEGIN [^-]+-----/, '').replace(/-----END [^-]+-----/, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

/* ── base64url 인코딩 ── */
function b64urlBytes(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64url(str) { return b64urlBytes(new TextEncoder().encode(str)); }
