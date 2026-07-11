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
