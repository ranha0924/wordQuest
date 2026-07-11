# Firebase 셋업 가이드 (클라우드 동기화 켜기)

이 단계를 마치면 여러 기기에서 진도가 동기화됩니다. **약 10분, 전부 무료(Spark 플랜)**.
안 하면 앱은 지금처럼 이 기기에만 저장됩니다(문제 없음).

> 참고: `firebase-config.js` 의 값들은 클라이언트에 노출돼도 되는 **공개 식별자**입니다(비밀키 아님).
> 실제 보안은 `firestore.rules`(본인 문서만 접근)가 담당합니다.

---

## 1) 프로젝트 만들기
1. https://console.firebase.google.com 접속 → **프로젝트 추가**.
2. 이름 입력(예: `wordquest`) → 애널리틱스는 꺼도 됨 → 생성.

## 2) 웹 앱 등록 + config 복사
1. 프로젝트 개요 화면에서 **웹 아이콘 `</>`** 클릭.
2. 앱 닉네임 입력(예: `web`) → **앱 등록**. (Hosting 체크는 안 해도 됨)
3. 표시되는 `firebaseConfig` 객체의 6개 값을 복사해 저장소의 **`firebase-config.js`** 에 붙여넣기:
   ```js
   window.FIREBASE_CONFIG = {
     apiKey: "AIza...",
     authDomain: "wordquest-xxxx.firebaseapp.com",
     projectId: "wordquest-xxxx",
     storageBucket: "wordquest-xxxx.appspot.com",
     messagingSenderId: "1234567890",
     appId: "1:1234...:web:abcd..."
   };
   ```

## 3) 로그인(이메일 링크) 켜기
1. 좌측 **Authentication** → **시작하기**.
2. **Sign-in method** 탭 → **이메일/비밀번호** 선택.
3. 두 번째 토글 **"이메일 링크(비밀번호 없는 로그인)"** 를 **사용 설정** → 저장.
   (첫 번째 "이메일/비밀번호"는 켜도 되고 안 켜도 됩니다. 우리는 링크만 씀.)

## 4) 승인 도메인 추가
1. Authentication → **Settings** → **승인된 도메인**.
2. `localhost` 는 기본 포함(로컬 테스트 OK).
3. 배포 후 실제 도메인(예: `wordquest.vercel.app`)을 **도메인 추가**로 넣기.

## 5) Firestore 만들기 + 규칙 배포
1. 좌측 **Firestore Database** → **데이터베이스 만들기** → **프로덕션 모드** → 위치 선택(예: `asia-northeast3` 서울) → 사용 설정.
2. **규칙** 탭 → 내용을 저장소의 **`firestore.rules`** 로 통째로 교체 → **게시**:
   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /users/{uid} {
         allow read, write: if request.auth != null && request.auth.uid == uid;
       }
       match /{document=**} { allow read, write: if false; }
     }
   }
   ```

## 6) 테스트
1. 앱 열기 → **영입소** → 아래 **☁ 클라우드 동기화** 섹션이 나타남(설정됐다는 뜻).
2. 이메일 입력 → **로그인 링크 받기** → 받은 메일의 링크 클릭 → 자동 로그인 + 첫 동기화.
3. 다른 브라우저/기기에서 같은 이메일로 로그인 → 진도가 넘어오면 성공.

---

## 문제 해결
- **☁ 섹션이 안 보임**: `firebase-config.js` 의 `apiKey`/`projectId` 가 비었는지 확인. 새로고침.
- **`auth/unauthorized-domain`**: 4)에서 현재 도메인을 승인 목록에 추가.
- **`auth/operation-not-allowed`**: 3)의 이메일 링크 토글이 꺼져 있음.
- **`Missing or insufficient permissions`**: 5)의 규칙 게시 확인.
- **링크 클릭했는데 로그인 이메일을 물음**: 다른 기기/브라우저에서 링크를 열면 정상(원래 이메일 재입력).

## 다음 (선택)
- **알림(①)**: 매일 "오늘 복습 N마리" 메일. 별도 셋업(SendGrid + GitHub Actions) 필요 — 요청 시 진행.
