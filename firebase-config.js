/* ================================================================
   Firebase 웹 앱 설정 (클라우드 동기화·알림용)
   ----------------------------------------------------------------
   아래 값을 본인 Firebase 프로젝트 값으로 교체하면 ☁ 동기화가 켜집니다.
   값이 비어 있으면 앱은 지금처럼 100% 로컬 전용으로 동작합니다(안전).

   값 얻는 곳:
     Firebase Console → ⚙ 프로젝트 설정 → 일반 → 내 앱(웹) → "SDK 설정 및 구성"
   자세한 셋업은 docs/firebase-setup.md 참고.
   ※ 이 값들은 클라이언트에 노출돼도 되는 공개 식별자입니다(비밀키 아님).
   ================================================================ */
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyBeJFT8TIhx3vxuKdruF6G4G5ZNfHoJpX8",
  authDomain: "wordquest-a250d.firebaseapp.com",
  projectId: "wordquest-a250d",
  storageBucket: "wordquest-a250d.firebasestorage.app",
  messagingSenderId: "363343730753",
  appId: "1:363343730753:web:8d580304c92874405e0ec0"
};
