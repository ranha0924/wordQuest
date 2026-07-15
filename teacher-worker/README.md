# WordQuest 선생님 인증 Worker

학생의 **임의 선생님 승격을 서버에서 차단**하기 위한 Cloudflare Worker.

기존에는 클라이언트에 하드코딩된 비밀번호(`8889`)가 유일한 방어선이라, 소스를
열어보거나 브라우저 콘솔에서 `Cloud.chooseRole('teacher')` 한 줄이면 우회됐다.
이제 선생님 승격은 **위조 불가능한 커스텀 클레임**(`request.auth.token.teacher`)으로만
인정되고, 그 클레임은 이 Worker가 **비밀번호를 서버에서 확인한 뒤에만** 부여한다.

## 동작

```
앱(로그인 학생) ──{ idToken, password }──▶ Worker
                                           1) idToken 검증 → uid
                                           2) password == TEACHER_PW ? (상수시간)
                                           3) 서비스계정으로 uid 에 teacher=true 클레임 부여
앱 ◀────────────── { ok:true } ───────────
앱: getIdToken(true) 로 토큰 갱신 → 새 클레임 반영 → 선생님 쓰기 허용
```

비밀번호는 **이 Worker의 Secret에만** 존재한다(앱·소스·저장소 어디에도 없음).

## 배포 순서

> 이미 OCR 워커(`ocr-worker/`)를 쓰고 있으므로 Cloudflare/Wrangler는 익숙할 것.

1. **의존성 없음** — `worker.js` 한 파일. 프로젝트 루트에서:
   ```bash
   cd teacher-worker
   npx wrangler login          # 처음 한 번
   ```
2. **비밀값 등록**(암호화 저장):
   ```bash
   npx wrangler secret put TEACHER_PW
   #   → 길고 무작위한 비밀번호 입력(예: 20자 이상). 4자리 숫자 금지(무차별 대입 취약).
   npx wrangler secret put FIREBASE_SERVICE_ACCOUNT
   #   → Firebase 콘솔 → ⚙ 프로젝트 설정 → 서비스 계정 → "새 비공개 키 생성" 으로
   #     받은 JSON 파일 내용을 통째로 붙여넣기.
   ```
3. (권장) **무차별 대입 방어 KV**:
   ```bash
   npx wrangler kv namespace create TEACHER_KV
   #   → 출력된 id 를 wrangler.toml 의 [[kv_namespaces]] 에 채우고 주석 해제.
   ```
4. **배포**:
   ```bash
   npx wrangler deploy
   #   → https://wordquest-teacher.<계정>.workers.dev 주소가 출력됨.
   ```
5. **앱에 주소 연결** — `firebase-config.js` 의 `window.TEACHER_AUTH_URL` 에 위 주소를 넣고 커밋/배포.
6. **규칙 배포** — `firestore.rules` 를 Firebase 콘솔에 반영(이 저장소엔 CLI 설정이 없어 수동).
   자세한 순서·주의는 `docs/teacher-auth-setup.md` 참고.

## 필요한 환경변수

| 이름 | 종류 | 설명 |
|---|---|---|
| `TEACHER_PW` | Secret | 선생님 전용 비밀번호(길고 무작위로). |
| `FIREBASE_SERVICE_ACCOUNT` | Secret | 서비스계정 JSON 전체 문자열. |
| `FIREBASE_API_KEY` | Variable | `firebase-config.js` 의 apiKey(공개값). |
| `ALLOW_ORIGIN` | Variable(선택) | 허용 도메인. 기본 `*`. 실제 배포 도메인 권장. |
| `TEACHER_KV` | KV 바인딩(선택) | 시도 횟수 제한. 강력 권장. |

## 보안 메모

- 서비스계정 JSON은 **관리자 권한**이다. Secret으로만 두고, 저장소·앱에 절대 커밋 금지.
- 비밀번호는 공유형이라 유출되면 누구나 선생님이 될 수 있다 → **길게** 설정하고,
  샜다고 판단되면 `wrangler secret put TEACHER_PW` 로 즉시 교체.
- 더 엄격히 가려면(계정 단위 통제) 비밀번호 대신 **이메일 허용목록**으로 바꿀 수 있다.
  그 경우 이 Worker는 `password` 대신 idToken 의 이메일이 허용목록에 있는지만 확인하면 된다.
