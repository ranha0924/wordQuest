# WordQuest — 클라우드 동기화 + 복귀 알림 설계

작성: 2026-07-11 · 상태: A 구현 중

평가에서 지목된 두 최대 약점을 해결한다.
- **①** SRS인데 복귀 유도 수단이 없다 → 이메일 리마인더
- **②** localStorage 단독이라 진도가 유리처럼 깨진다 → 클라우드 동기화

## 원칙
- **오프라인 우선 유지.** localStorage가 여전히 주 저장소. 로그인은 **선택**이며, 로그인/설정이 없으면 앱은 지금과 100% 동일하게 로컬 전용으로 동작한다(무설정 배포 안전).
- **빌드 도구 없음 유지.** Firebase는 `https://www.gstatic.com/firebasejs/...` ESM CDN으로 로드. 단일 정적 사이트 성격 보존.
- **비용 0.** Firebase 무료(Spark) 플랜 + (알림용) GitHub Actions 크론 + SendGrid 무료. 카드 등록(Blaze) 불필요.

## 스택
- **Auth**: Firebase Auth — 이메일 링크(패스워드리스). 비밀번호를 앱이 다루지 않는다.
- **DB**: Firestore — 사용자별 문서 1개.
- **알림(C)**: GitHub Actions 스케줄 → Firebase Admin(서비스 계정)으로 due 사용자 조회 → SendGrid로 "오늘 복습 N마리" 메일.

## 작업 분해
- **A. 동기화 [②]** ← 지금. 로그인 + Firestore 저장/병합, 오프라인 우선.
- **B. PWA**. manifest + service worker(앱 셸·에셋 오프라인 캐시, 설치형). A에 곁들임.
- **C. 이메일 리마인더 [①]**. A 완료 후. 매일 크론 메일. SendGrid + GitHub 시크릿.

---

## A. 동기화 상세 설계

### 파일 구성
- `cloud.js` (신규) — Firebase 초기화·인증·동기화 로직을 캡슐화. `window.Cloud` API 노출. index.html 비대화 방지(분리).
- `firebase-config.js` (신규, 사용자가 값 채움) — Firebase 웹 config. 없으면 `window.FIREBASE_CONFIG` 미정의 → cloud.js가 로컬 전용으로 no-op.
- `index.html` — 로그인 UI + `Cloud` 연동 훅.

### 데이터 모델 (Firestore)
`users/{uid}` 문서 1개(602단어 × ~200B ≈ 120KB < 1MB 한도):
```
{
  schema: 1,
  words: { <id>: { ...word, updatedAt: <ms> } },   // 배열 아닌 맵(병합 용이)
  meta:  { ...S.meta, updatedAt: <ms> }
}
```

### 병합 (단어별 최신 우선 — 한 기기가 다른 기기 진도를 덮어쓰지 않게)
- 로컬 변경 지점(`resolveAnswer`, 등록/삭제, 포획)에서 해당 단어에 `updatedAt=Date.now()` 스탬프. meta 변경 시 `meta.updatedAt`.
- 동기화 = pull → merge → push:
  - 각 단어 id의 합집합에서 `updatedAt` 큰 쪽 채택. 삭제는 `{deleted:true, updatedAt}` tombstone.
  - meta는 `updatedAt` 큰 쪽 채택(필드 단위 아님, 단순).
  - 병합 결과를 로컬(S) in-place 반영 → `persist()` → 재렌더, 그리고 원격에 write.
- 트리거: 로그인 직후, 로그인 상태로 앱 로드 시, 변경 후 디바운스(~3s), `visibilitychange`(hidden) 플러시.
- Firestore 오프라인 지속성 on → 연결 끊겨도 로컬 동작, 복구 시 자동 반영.

### 인증 흐름 (이메일 링크)
1. "☁ 동기화" → 이메일 입력 → `sendSignInLinkToEmail(url=현재 앱 URL, handleCodeInApp)`; 이메일을 localStorage에 임시 저장.
2. 사용자가 메일의 링크 클릭 → 앱 로드 시 `isSignInWithEmailLink` 감지 → `signInWithEmailLink` → 로그인 → 최초 동기화.
3. localhost는 기본 승인 도메인이라 로컬 검증 가능. 배포 도메인은 사용자가 Firebase 승인 목록에 추가.

### UI/상태
- 홈에 "☁ 동기화" 항목: 미로그인=이메일 로그인, 로그인=이메일/로그아웃/동기화 상태(대기·완료·오프라인) 표시.
- 미설정(`firebase-config.js` 없음)이면 항목 숨김 → 오늘과 동일.

### 보안 규칙 (`firestore.rules`)
- `users/{uid}`는 `request.auth.uid == uid`인 사용자만 read/write. 그 외 전면 거부.

### 검증 계획
- 무설정/미로그인 상태에서 기존 게임 전 기능 무결(회귀 0) — localhost에서 브라우저 검증.
- 사용자가 Firebase 프로젝트 셋업(~10분, 가이드 제공) 후: 두 브라우저에서 로그인→한쪽 진도→다른 쪽 반영(병합) 라이브 검증.

## 사용자 셋업 (A) — 코드·가이드는 전부 준비
1. Firebase 프로젝트 생성 → 웹앱 등록 → config 6줄을 `firebase-config.js`에 붙여넣기.
2. Authentication → 이메일/이메일 링크 사용 설정.
3. Firestore 생성 + `firestore.rules` 배포.
4. (배포용) 승인 도메인에 실제 URL 추가.

## 알려진 제약
- 이메일 링크는 앱 URL로 리다이렉트되므로 실제 배포 URL 필요(HANDOFF §7: URL 미확인). A는 localhost에서 완성·검증 후 배포 URL 연결.
- 라이브 동기화 최종 검증은 사용자의 Firebase config가 있어야 가능.
