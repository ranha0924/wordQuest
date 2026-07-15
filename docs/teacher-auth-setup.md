# 선생님 권한 보안 셋업 (2026-07-15)

## 왜 바꿨나 — 취약점

기존에는 "선생님으로 승격"의 **유일한 방어선이 클라이언트에 하드코딩된 비밀번호**
(`index.html` 의 `const TEACHER_PW='8889'`)였다. 이건 소프트 게이트라서:

1. 소스(또는 브라우저 개발자도구)를 열면 비밀번호가 그대로 보이고,
2. 비밀번호를 몰라도 콘솔에서 `Cloud.chooseRole('teacher')` 한 줄이면 승격됐다.
   (Firestore 규칙이 `role` 값이 문자열이기만 하면 통과시켜, 서버 통제가 없었음.)

실제로 한 학생이 이 방식으로 스스로 선생님이 되었다.

## 어떻게 고쳤나 — 서버 강제

선생님 승격을 **위조 불가능한 커스텀 클레임**(`request.auth.token.teacher == true`)으로만
인정한다. 이 클레임은 **Cloudflare Worker(`teacher-worker/`)가 비밀번호를 서버에서
확인한 뒤 Firebase Admin 으로만** 부여할 수 있다.

- `firestore.rules`: `role='teacher'` 쓰기, 반 생성/수정/코드, 반 배포(classPacks)를
  `isTeacher()`(클레임) 또는 마스터만 허용. → **콘솔 우회가 서버에서 거부됨.**
- 비밀번호는 **Worker 의 Secret(`TEACHER_PW`)에만** 존재. 앱·소스·저장소엔 없음.
- 클라이언트(`teacherGate`)는 비번을 Worker 로 보내 검증받고, 성공 시 토큰을
  강제 갱신(`getIdToken(true)`)해 새 클레임을 받는다.

```
학생(로그인) ─{idToken, 비번}→ teacher-worker ─(비번 OK)→ uid 에 teacher=true 클레임
        ↑                                                         │
        └──────────── 토큰 갱신 후 role='teacher' 쓰기 → 규칙 통과 ─┘
비번 모르면 Worker 통과 못 함 → 클레임 없음 → 규칙이 선생님 쓰기 전부 거부
```

## 배포 순서 (중요 — 순서 지킬 것)

> 규칙(4번)을 먼저 배포하면, Worker/URL 이 준비되기 전까진 **아무도 선생님이 될 수
> 없다**(안전한 실패). 그러니 아래 순서대로.

1. **Worker 배포** — `teacher-worker/README.md` 참고.
   ```bash
   cd teacher-worker
   npx wrangler login                       # 처음 한 번
   npx wrangler secret put TEACHER_PW       # 길고 무작위한 비번!
   npx wrangler secret put FIREBASE_SERVICE_ACCOUNT   # 서비스계정 JSON 통째로
   # (권장) npx wrangler kv namespace create TEACHER_KV → id 를 wrangler.toml 에
   npx wrangler deploy                      # → https://wordquest-teacher.<계정>.workers.dev
   ```
   - 서비스계정 JSON: Firebase 콘솔 → ⚙ **프로젝트 설정 → 서비스 계정 →
     "새 비공개 키 생성"**.
2. **앱에 Worker 주소 연결** — `firebase-config.js`:
   ```js
   window.TEACHER_AUTH_URL = "https://wordquest-teacher.<계정>.workers.dev";
   ```
3. **사이트 배포** — `main` 에 반영(캐시 무효화를 위해 `?v=` 올리기 권장, 아래 참고).
4. **Firestore 규칙 배포** — 이 저장소엔 firebase CLI 설정이 없으므로 **콘솔에 수동 반영**:
   Firebase 콘솔 → **Firestore Database → 규칙** 탭에 `firestore.rules` 내용을
   붙여넣고 **게시**.
5. **본인을 선생님으로** — 앱에서 로그인 → 설정/영입소 → "선생님으로 시작" →
   비밀번호 입력 → 통과하면 선생님 대시보드 사용 가능.

## 재성(무단 승격 학생) 정리 — 라이브 데이터

> 규칙 배포(4번) 이후엔 재성 계정은 **선생님 쓰기가 전부 막힌다**(반 생성·배포 불가).
> 다만 이미 저장된 데이터(그의 `role='teacher'`, 그가 만든 반)는 남아 있으니 정리한다.
> 이건 코드가 아니라 **Firestore 데이터**라 콘솔에서 수동으로 한다.

Firebase 콘솔 → Firestore Database:

1. **그가 만든 반 삭제** — `classes` 컬렉션에서 `ownerUid` 가 재성 uid 인 문서 삭제.
   그리고 `classCodes` 에서 그 반 `code` 문서, `classPacks/{그 classId}` 문서도 함께 삭제.
2. **역할 초기화** — `users/{재성 uid}` 문서의 `role` 을 `student` 로(또는 필드 삭제).
   - 재성 uid 는 `classes` 문서의 `ownerUid`, 또는 콘솔 Authentication 탭에서 확인.
3. (선택) **클레임 회수** — 혹시 이번 작업 전에 클레임을 받은 계정이 있다면,
   `teacher-worker` 없이도 회수하려면 콘솔이 아니라 Admin 스크립트가 필요하다.
   이번 사건의 재성은 **클레임을 받은 적이 없다**(클레임 체계가 이번에 처음 생김).
   그의 `role` 문자열만 있었을 뿐이라, 규칙 배포만으로 이미 무력화된다.

## 흥덕고등학교 1학년 9반 만들기

재성이 만든 반은 위에서 삭제했으니, **본인(선생님) 계정으로 새로 만든다**:
앱 → 선생님 대시보드 → 반 만들기 → 이름 `흥덕고등학교 1학년 9반` → 생성되면
나오는 **반 코드**를 학생들에게 배포. (반 이름은 규칙상 생성 후 변경 불가라, 새로
만드는 게 가장 깔끔하다.)

## 검증 체크리스트

- [ ] 로그인 후 "선생님으로 시작" → 올바른 비번 → 선생님 됨.
- [ ] 틀린 비번 → "비밀번호가 올바르지 않습니다."
- [ ] `TEACHER_AUTH_URL` 비었을 때 → "인증 서버가 설정되지 않았어요" (안전한 실패).
- [ ] **콘솔 우회 테스트**(핵심): 학생 계정 콘솔에서
      `await Cloud.chooseRole('teacher')` 실행 → Firestore 쓰기가
      `permission-denied` 로 거부되는지. (거부돼야 정상.)
- [ ] 학생 계정 콘솔에서 반 생성 시도 → 거부되는지.

## 주의

- **공유 비밀번호**라 유출되면 아는 사람은 누구나 선생님이 된다. 길게 설정하고,
  샜다 싶으면 `wrangler secret put TEACHER_PW` 로 즉시 교체(기존 선생님 클레임은
  유지되므로 재로그인 불필요).
- 더 엄격히 계정 단위로 통제하려면 비밀번호 대신 **이메일 허용목록**으로 바꿀 수
  있다(그땐 Worker 가 idToken 의 이메일이 목록에 있는지만 확인). 필요 시 요청.
- `sw.js` 의 `VERSION` / `?v=` 를 올려 구 캐시의 옛 `index.html`(하드코딩 비번 포함)이
  남지 않게 한다.
