# 사진 OCR 프록시 배포 (Cloudflare Workers · 무료)

Claude 비전으로 사진 → "영어단어 - 한국어뜻" 변환을 해주는 **중계 서버**입니다.
API 키를 앱(학생 손)에 노출하지 않으려고 둡니다. **약 10분, 카드 없이 무료.**

## 1) Anthropic 지출 한도 먼저 걸기 (안전벨트)
1. https://console.anthropic.com → **Settings → Limits(또는 Billing)**
2. **월 지출 한도**를 낮게 설정(예: **$5**). 이걸 넘으면 자동 차단 → 절대 폭탄 안 남.
3. **API 키**가 없으면 **API Keys**에서 하나 생성해 복사(이미 있으면 그거 사용).

## 2) Cloudflare Worker 만들기
1. https://dash.cloudflare.com 가입/로그인(무료).
2. 좌측 **Workers & Pages → Create → Create Worker** → 이름 입력(예: `wordquest-ocr`) → **Deploy**.
3. **Edit code** 클릭 → 편집기 내용을 **전부 지우고**, 이 폴더의 **`worker.js`** 내용을 **통째로 붙여넣기** → **Deploy**.

## 3) 환경변수 등록 (Settings → Variables and Secrets)
| 이름 | 종류 | 값 |
|---|---|---|
| `ANTHROPIC_API_KEY` | **Secret**(암호화) | 본인 Claude API 키 |
| `FIREBASE_API_KEY` | Variable(Text) | `firebase-config.js` 의 `apiKey` 값 (공개값이라 OK) |
| `MODEL` | Variable(선택) | 비우면 `claude-haiku-4-5-20251001` |
| `ALLOW_ORIGIN` | Variable(선택) | 앱 도메인(예: `https://내앱.web.app`). 모르면 `*` |
| `ANTHROPIC_BASE` | Variable(선택) | **워커가 `upstream_error`(403 "Request not allowed")로 실패할 때만** 필요. Cloudflare AI Gateway 주소를 넣어 리전 차단을 우회. 아래 §3.5 참고 |
| `PROJECT_NUMBER` | Variable(선택) | Firebase **프로젝트 번호**(= `firebase-config.js` 의 `messagingSenderId`). App Check(o2) 검증용 |
| `APPCHECK_ENFORCE` | Variable(선택) | `true` 면 App Check 토큰 필수 = **앱 밖 스크립트의 유료 Claude 호출 차단**(비용·`DAILY_CAP` 소진 공격 방어). `PROJECT_NUMBER` 와 **반드시 함께** 설정(누락 시 misconfig 로 전부 거부 — 페일클로즈드). ⚠️ 앱 v125(App Check 헤더 동봉) 전파 후에만 켤 것 — 구캐시 클라는 403을 받고 기기 내 무료 OCR 로 폴백된다. 순서 런북: `docs/appcheck-setup.md` |

저장 후 우측 상단 **Deploy** 한 번 더.

### (필요 시) 403 "Request not allowed" — AI Gateway 경유로 우회  §3.5
Cloudflare Worker 에서 나가는 요청을 Anthropic 이 리전 차단하면 `upstream_error`(403)가 난다
(같은 키를 PC 에서 `curl` 하면 정상이면 이 경우다). **AI Gateway** 를 끼우면 해결된다:
1. **Cloudflare 대시보드 → AI → AI Gateway → Create Gateway** → 이름 예: `wordquest`.
2. 만든 게이트웨이의 **Anthropic** 엔드포인트 주소를 확인:
   `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway>/anthropic`
3. 워커 **Settings → Variables** 에 `ANTHROPIC_BASE` = 위 주소(끝에 `/anthropic` 까지) 추가 → **Deploy**.
   - 워커는 자동으로 `<ANTHROPIC_BASE>/v1/messages` 로 호출한다(헤더·본문 동일).

### (선택) 하루 전체 상한 걸기 — 더 안전하게
1. **Workers & Pages → KV → Create namespace**(예: `ocr`).
2. 워커 **Settings → Variables → KV Namespace Bindings → Add**:
   - Variable name: `OCR_KV` / Namespace: 방금 만든 것
3. (선택) Variable `DAILY_CAP` = `500` 처럼 하루 상한 지정.

## 4) 워커 주소 복사해서 알려주기
- 배포 화면의 주소(예: `https://wordquest-ocr.<계정>.workers.dev`)를 복사.
- **그 주소를 저(Claude Code)에게 알려주시면** 앱이 그 주소로 사진을 보내도록 연결합니다.
- (직접 하려면: 저장소 `firebase-config.js` 의 `window.OCR_ENDPOINT` 에 주소를 넣고 배포.)

## 동작/폴백
- 주소가 설정되면: 로그인 학생이 사진 담기 → 워커가 Claude로 인식 → 결과를 앱이 채움.
- 주소가 없거나 실패하면: 자동으로 **기기 내 무료 OCR(Tesseract)** 로 폴백 → 앱은 안 깨짐.
- **배포 확인(o2~)**: 워커 주소를 브라우저로 그냥 열면 `{"error":"method_not_allowed","v":"o2"}` —
  `v` 값이 `worker.js` 상단 `REV` 와 같으면 새 코드가 라이브다(`v` 자체가 없으면 구버전).
- App Check 강제(`APPCHECK_ENFORCE=true`) 시 403 `appcheck` 응답도 앱(v125+)에선 기기 내 OCR 폴백으로 처리된다.

## 비용 감각 (Claude Haiku 기준)
- 사진 1장 ≈ 수천 토큰 → **대략 장당 1원 안팎**. 학생들이 가끔 쓰면 월 몇 백 원~몇 천 원.
- Anthropic 월 지출 한도가 최종 상한이라 그 이상은 절대 안 나갑니다.
