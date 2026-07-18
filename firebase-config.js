/* ================================================================
   Firebase 웹 앱 설정 (클라우드 동기화·알림용)
   ----------------------------------------------------------------
   ※ Firebase 웹 apiKey 는 "비밀키"가 아니라 공개 식별자입니다.
     배포된 웹앱의 JS에도 그대로 노출되며, 커밋해도 안전합니다.
     실제 보안은 firestore.rules(본인 문서만 접근) 와 (선택) Google Cloud
     콘솔의 "키 사용처 제한(HTTP 리퍼러)" 이 담당합니다.
   · 값이 비어 있으면 앱은 100% 로컬 전용으로 동작합니다.
   자세한 셋업: docs/firebase-setup.md
   ================================================================ */
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyBeJFT8TIhx3vxuKdruF6G4G5ZNfHoJpX8",
  authDomain: "wordquest-a250d.firebaseapp.com",
  projectId: "wordquest-a250d",
  storageBucket: "wordquest-a250d.firebasestorage.app",
  messagingSenderId: "363343730753",
  appId: "1:363343730753:web:8d580304c92874405e0ec0"
};

/* 사진 OCR 프록시(Cloudflare Worker) 주소.
   비어 있으면 기기 내 무료 OCR(Tesseract)로 동작. 워커 배포 후 주소를 넣으면
   Claude 비전으로 고품질 인식(로그인 학생만·하루 제한). 예: "https://wordquest-ocr.xxx.workers.dev" */
window.OCR_ENDPOINT = "https://crimson-leaf-7345.ranha-park.workers.dev/";
/* 학생 1인당 하루 AI 스캔 제한(비용 통제). */
window.OCR_DAILY_LIMIT = 8;

/* 랭킹 집계 프록시(Cloudflare Worker) 주소.
   비어 있으면 기존 Firestore 랭킹으로 동작(값 위조 가능). 워커 배포 후 주소를 넣으면
   "이번 주 완료한 배포 단어 수"를 서버가 세서(콘솔로 점수 위조 불가) 랭킹을 매긴다.
   배포 방법: rank-worker/README.md. 예: "https://wordquest-rank.xxx.workers.dev" */
window.RANK_ENDPOINT = "https://still-limit-42e2.ranha-park.workers.dev/";

/* ── App Check (★랭킹 위조 방어의 핵심 지렛대 · 봇/외부 스크립트 차단) ── 셋업: docs/appcheck-setup.md
   · APPCHECK_SITE_KEY: Firebase App Check 콘솔에서 발급한 reCAPTCHA v3 "사이트키"(공개값).
     비어 있으면 App Check 는 꺼진 상태 = 기존과 동일 동작(회귀 0).
   · PROJECT_NUMBER: Firebase "프로젝트 번호"(= messagingSenderId, 공개값). 워커가 App Check
     JWT 의 aud=projects/<번호> 를 검증하는 데 쓴다(워커 env PROJECT_NUMBER 도 같은 값으로).
   ★ 두 값 다 공개 식별자라 커밋 안전. QUIZ_SECRET·ANSWER_SALT 같은 '진짜 비밀'은 여기 넣지 말 것.
   ★★ 실효화(둘 다 동시에!): ① 이 site key 를 채우고 배포 → ② 워커 env APPCHECK_ENFORCE=true (+PROJECT_NUMBER).
       한쪽만 켜면 위험: key 없이 워커 enforce=true 면 /sync·/quiz 가 403 → 랭킹·출석·연속 동기화 '전체 중단'.
       즉시 롤백은 워커 변수 APPCHECK_ENFORCE=false (재배포 불요). 강제 전 며칠 모니터링 권장. r16 부터 /sync 도 게이트. */
window.APPCHECK_SITE_KEY = "";                 // 예: "6Lxxxxxx…" (콘솔에서 발급 후 기입 → App Check 켜짐 · 워커 enforce 와 동시에)
window.PROJECT_NUMBER = "363343730753";        // = messagingSenderId (공개). 워커 env 에도 동일값 설정.
/* 로컬 개발용 App Check 디버그 토큰(배포본엔 비워 둘 것 — 유효 토큰 커밋 금지). */
window.APPCHECK_DEBUG_TOKEN = "";
