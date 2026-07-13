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

## 3) 로그인(구글) 켜기
1. 좌측 **Authentication** → **시작하기**.
2. **Sign-in method** 탭 → **새 제공업체 추가** → **Google** 선택.
3. **사용 설정** 토글을 켜고, 프로젝트 지원 이메일을 고른 뒤 **저장**.
   (앱은 구글 팝업 로그인을 쓰며, 팝업이 막히면 리디렉트로 자동 폴백합니다.)

## 4) 승인 도메인 추가
1. Authentication → **Settings** → **승인된 도메인**.
2. `localhost` 는 기본 포함(로컬 테스트 OK).
3. 배포 후 실제 도메인(예: `wordquest.vercel.app`)을 **도메인 추가**로 넣기.

## 5) Firestore 만들기 + 규칙 배포
1. 좌측 **Firestore Database** → **데이터베이스 만들기** → **프로덕션 모드** → 위치 선택(예: `asia-northeast3` 서울) → 사용 설정.
2. **규칙** 탭 → 내용을 저장소의 **`firestore.rules`** 로 통째로 교체 → **게시**.
   (본인 학습 데이터는 `users/{uid}/private/state`, 선생님은 자기 반 학생 문서만 읽음, 반은 `classes/{id}`.)

## 6) 테스트
1. 앱 열기 → **영입소** → 아래 **☁ 계정 · 클라우드** 섹션이 나타남(설정됐다는 뜻).
2. **구글로 로그인** → 역할 선택(학생/선생님).
   - **선생님**: 반 이름 입력 → **반 만들기** → 발급된 코드 확인.
   - **학생**: 선생님에게 받은 **반 코드** 입력 → **반 참여**.
3. 다른 브라우저/기기에서 같은 구글 계정으로 로그인 → 진도가 넘어오면 성공.

---

## 문제 해결
- **☁ 섹션이 안 보임**: `firebase-config.js` 의 `apiKey`/`projectId` 가 비었는지 확인. 새로고침.
- **`auth/unauthorized-domain`**: 4)에서 현재 도메인을 승인 목록에 추가.
- **`auth/operation-not-allowed`**: 3)의 구글 제공업체가 꺼져 있음.
- **`auth/popup-blocked`**: 브라우저 팝업 차단 → 앱이 리디렉트로 자동 재시도. 그래도 안 되면 팝업 허용.
- **`Missing or insufficient permissions`**: 5)의 규칙 게시 확인.

## 다음 (선택)
- **알림(①)**: 매일 "오늘 복습 N마리" 메일. 별도 셋업(SendGrid + GitHub Actions) 필요 — 요청 시 진행.
