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
