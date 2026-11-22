# 설계서 (design.md) - 보안관제 위협정보·자산점검 시스템 v0.1

> prd.md가 기준이다. 이 문서의 **[고정]**은 prd.md의 [고정]과 같다. 충돌하면 prd.md를 따른다.

## 1. 기술 선택

| 영역 | 선택 | 비고 |
|---|---|---|
| 화면·API | Next.js (App Router) + TypeScript, Vercel 배포 | 화면과 API를 한 프로젝트에서 처리 |
| 화면 꾸미기 | Tailwind CSS + shadcn/ui | 표·폼·알림 부품이 잘 갖춰져 있음 |
| DB | PostgreSQL (Supabase 무료 플랜으로 시작) | Supabase는 DB로만 쓰고 로그인은 직접 만든다(허용 IP, OTP 규칙 때문) **[확인필요]** |
| DB 접근 | Drizzle ORM | 표 정의가 코드 한 곳에 모임 |
| 비밀번호 | argon2 해시 | |
| OTP | otplib (TOTP, 구글 오센티케이터 호환) + qrcode | 무료 |
| 세션 | 서명된 쿠키(jose), HttpOnly, 유효 8시간 | |
| 암호화 | AES-256-GCM (OTP 비밀키, 출처 API 키). 키는 환경변수 `APP_ENC_KEY` | |
| PDF 만들기 | pdf-lib + 한글 폰트(Noto Sans KR) 포함 | |
| PDF 읽기 | pdf-parse | 출처 PDF에서 지표 추출 |
| 수집·점검 실행 | GitHub Actions (정기 실행) + `worker/` 폴더의 TypeScript 스크립트 | |

## 2. 파일 구성

```
/
├─ prd.md, design.md, tasks.md, rules.md, CHANGELOG.md
├─ .github/workflows/
│  ├─ collect.yml        # 1시간마다 위협정보 수집
│  ├─ scan.yml           # 매일 자산 점검 (2차)
│  └─ cleanup.yml        # 매일 만료·보관기간 정리
├─ db/
│  ├─ schema.ts          # 표 정의 [고정]
│  ├─ index.ts           # DB 연결
│  └─ migrations/
├─ lib/                  # 핵심 기능 (화면과 분리, 테스트 대상)
│  ├─ normalize.ts       # 지표 값 정규화·종류 판별
│  ├─ indicators.ts      # 저장·중복 병합·만료 처리
│  ├─ whitelist.ts       # 화이트리스트·우리 자산 제외 판정
│  ├─ auth.ts            # 비밀번호·OTP·세션·허용 IP 판정
│  ├─ crypto.ts          # 암호화
│  └─ report-pdf.ts      # PDF 보고서
├─ worker/               # GitHub Actions에서 실행 (lib/ 재사용)
│  ├─ collect/           # api.ts, html.ts, pdf.ts 수집기
│  ├─ scan/              # ports.ts, tls.ts, paths.ts, diff.ts
│  └─ cleanup.ts
├─ app/                  # 화면과 API (아래 4, 5절)
├─ tests/                # test_logic 역할: lib/ 시험
└─ .env.example          # 필요한 환경변수 이름만 (값 없음)
```

## 3. 데이터 표 [고정]

공통: 모든 표에 `id`, `created_at`. 시각은 UTC 저장, 화면은 한국시간(KST) 표시.

### users
`username`(고유), `name`, `password_hash`, `role`(`admin`|`viewer`), `otp_secret_enc`, `otp_enabled`(bool), `failed_count`, `locked`(bool), `last_login_at`

### user_allowed_ips
`user_id`, `cidr`(예: 1.2.3.4/32), `memo`, `created_by`

### sources
`name`(기관명, 필수), `kind`(`api`|`html`|`pdf`), `url`, `config`(JSON: 키 위치, CSS 선택자, 응답 필드 매핑 등), `api_key_enc`, `enabled`, `last_success_at`

### collect_runs
`source_id`, `started_at`, `status`(`success`|`fail`), `new_count`, `error_message`

### indicators
`type`(`ip`|`domain`|`url`|`hash`|`email`), `value`(정규화 값), `hash_kind`(`md5`|`sha1`|`sha256`|null), `status`(`active`|`inactive`), `excluded`(bool), `first_seen_at`, `last_seen_at`, `memo`
- 고유 조건: (`type`, `value`) 한 쌍은 한 건만 존재

### indicator_sources
`indicator_id`, `source_id`, `source_name`(기관명 복사 보관), `first_seen_at`, `last_seen_at`, `ref_url`, `note`
- 고유 조건: (`indicator_id`, `source_id`)

### whitelist
`type`(`ip`|`cidr`|`domain`), `value`, `reason`, `created_by`

### assets
`name`, `target`(도메인 또는 IP), `owner`, `department`, `importance`(1~5), `scan_level`(1~5, 기본 3), `scan_permitted`(bool, 필수 true), `enabled`, `memo`

### scan_results
`asset_id`, `scan_date`(날짜), `scan_level`, `status`(`success`|`fail`|`partial`), `open_ports`(JSON: 포트, 프로토콜, 서비스, 버전), `exposed_pages`(JSON: 경로, 상태 코드, 종류), `cert_expires_at`, `error_message`, `duration_sec`
- 고유 조건: (`asset_id`, `scan_date`) 하루 한 건, 재실행하면 덮어씀

### notifications
`kind`(`port_opened`|`port_closed`|`page_exposed`|`cert_expiring`|`asset_down`), `asset_id`, `message`, `read`(bool), `occurred_at`

### audit_logs
`user_id`, `action`, `target`, `detail`(JSON), `ip`, `occurred_at`

### api_keys (SIEM용)
`name`, `key_hash`, `created_by`, `last_used_at`, `revoked`(bool)

## 4. 핵심 기능 (입력 → 출력) [고정 규칙 포함]

### 4.1 지표 정규화 `normalize(raw)`
- 입력: 문자열 한 개 (예: `HXXP://Evil[.]com/a`)
- 출력: `{ type, value }` 또는 판별 불가
- 규칙: 공백 제거, 소문자화(해시·도메인·이메일), 방어 표기 복원(`hxxp`→`http`, `[.]`→`.`, `[at]`→`@`), 도메인 끝 점 제거, IP는 IPv4·IPv6 형식 검증(사설·예약 대역은 `excluded` 후보로 표시), 해시는 길이로 종류 판별(32/40/64자리 16진수).

### 4.2 저장·병합 `saveIndicator(raw, source, refUrl)`
- 입력: 정규화된 지표, 출처, 원문 링크
- 처리: (type,value)가 있으면 `last_seen_at` 갱신, `inactive`면 `active`로 복귀, `indicator_sources`에 출처 추가(이미 있으면 `last_seen_at`만 갱신). 없으면 새로 만든다.
- 출처 없이는 저장하지 않는다 (출처 필수).

### 4.3 만료 처리 `expireIndicators()`
- `last_seen_at`이 90일 이전인 `active`를 `inactive`로 바꾼다. 매일 1회.

### 4.4 제외 판정 `isExcluded(indicator)`
- 화이트리스트(IP 일치, CIDR 포함, 도메인 일치·하위 도메인)나 `assets.target`과 일치하면 `excluded = true`.
- 화이트리스트·자산이 추가·삭제되면 전체 재계산한다.

### 4.5 SIEM 제공 `GET /api/siem/indicators`
- 인증: `Authorization: Bearer <API키>`
- 조건: `type`, `status`(기본 active), `since`(ISO 시각), `format`(`json`|`csv`|`txt`), `limit`
- 항상 `excluded = false`만 반환. 항목: 종류, 값, 해시종류, 출처 기관명 목록, 최초·최종 확인일.

### 4.6 PDF 보고서 `buildReport(filter)`
- 입력: 기간, 키워드(값·메모·기관명 부분 일치), 지표 종류, 출처 기관, 상태
- 출력: PDF (조건 요약, 건수, 종류별 표, 출처 기관). 한 번에 최대 5,000건 **[확인필요]**

### 4.7 수집기 `worker/collect`
- 활성 출처를 읽어 종류별로 수집:
  - `api`: 응답 JSON에서 `config` 매핑대로 값 추출
  - `html`: 게시글 목록·본문에서 값 추출 (이미 처리한 글은 건너뜀)
  - `pdf`: 새 PDF를 내려받아 본문에서 정규식으로 후보를 뽑고 `normalize` 통과 건만 저장
- 출처 하나가 실패해도 나머지는 계속한다. 결과는 `collect_runs`에 기록.
- 외부 요청에는 제한 시간(30초)과 재시도(2회)를 둔다.

### 4.8 로그인 판정 `lib/auth.ts` [고정]
1. 아이디·비밀번호 확인. 틀리면 `failed_count` 증가, 5회면 `locked`. 오류 문구는 "아이디 또는 비밀번호가 올바르지 않습니다" 하나로 통일.
2. 잠긴 계정이면 거부.
3. 허용 IP 확인: `role = admin`이면 통과. 아니면 접속 IP가 `user_allowed_ips`의 CIDR 중 하나에 포함돼야 통과. 등록이 없으면 거부. 접속 IP는 Vercel이 넘기는 `x-forwarded-for`의 맨 앞 값.
4. 1차 통과 시 5분짜리 임시 쿠키 발급 → OTP 화면.
5. OTP 미등록이면 QR 표시(등록 화면), 등록되면 6자리 코드 확인(앞뒤 30초 허용). 통과하면 8시간짜리 세션 쿠키 발급, `failed_count` 초기화, 로그인 성공·실패 모두 `audit_logs`에 기록.
6. 모든 화면·API는 세션과 권한을 확인한다. 관리자 전용 화면은 `viewer`에게 403.

### 4.9 점검기 `worker/scan` (2차)
- 입력: 활성 자산 목록(`scan_permitted = true`만)
- 단계별 동작 (prd 3.2): 포트는 TCP 연결 시도 방식(연결 가능 여부만 확인), 서비스 식별은 배너 읽기, 인증서는 TLS 핸드셰이크, 노출 페이지는 정해진 경로 목록에 대한 HTTP GET.
- 비침투: 로그인 시도, 입력값 주입, 취약점 공격 코드는 쓰지 않는다 [고정].
- 병렬 처리: 자산을 묶음으로 나눠 GitHub Actions 여러 작업으로 동시 실행. 자산당 시간 제한 초과 시 `partial`로 기록.
- 처리량 제한: 자산당 동시 연결 수와 초당 연결 수를 제한해 대상에 부하를 주지 않는다.

### 4.10 변화 감지 `worker/scan/diff.ts` (2차)
- 오늘과 가장 최근 성공 결과를 비교해 `notifications`를 만든다: 새 포트(`port_opened`), 닫힘(`port_closed`), 새 노출 페이지(`page_exposed`), 인증서 만료 30일 이내(`cert_expiring`, 같은 인증서는 하루 한 번만), 접속 불가(`asset_down`).
- 첫 점검은 비교 대상이 없으므로 알림을 만들지 않는다.

### 4.11 정리 `worker/cleanup.ts`
- 매일: 지표 만료 처리, `scan_results`·`notifications`는 1년(365일) 지난 것 삭제 [고정].

## 5. 화면 구성 (경로)

| 화면 | 경로 | 권한 |
|---|---|---|
| 로그인 | `/login` | 공개 |
| OTP 입력·등록 | `/login/otp` | 1차 통과자 |
| 대시보드 | `/` | 전체 |
| 위협정보 목록·검색 | `/indicators` | 전체 |
| 위협정보 상세 | `/indicators/[id]` | 전체 |
| PDF 보고서 추출 | `/reports` | 전체 |
| 출처 관리 | `/admin/sources` | 관리자 |
| 수집 이력 | `/admin/sources/[id]/runs` | 관리자 |
| 화이트리스트 | `/admin/whitelist` | 관리자 |
| 자산 목록 | `/assets` | 전체(수정은 관리자) |
| 자산 등록·수정 | `/assets/new`, `/assets/[id]/edit` | 관리자 |
| 자산 상세·점검 이력 | `/assets/[id]` | 전체 |
| 알림 목록 | `/notifications` | 전체 |
| 사용자 관리·허용 IP·OTP 초기화 | `/admin/users` | 관리자 |
| SIEM 연동 설정 | `/admin/siem` | 관리자 |
| 감사 로그 | `/admin/audit` | 관리자 |

- 공통 화면 틀: 왼쪽 메뉴, 위쪽에 알림 종 모양(안 읽은 개수), 사용자명·로그아웃.
- 화면 이동: 로그인 → OTP → 대시보드. 대시보드 카드에서 각 목록으로 이동.
- 디자인(색, 배치)은 자유롭게 다듬는다. [고정] 아님.

## 6. 환경변수 (값은 저장소에 넣지 않는다)

`DATABASE_URL`, `APP_ENC_KEY`, `SESSION_SECRET`, `INITIAL_ADMIN_USERNAME`, `INITIAL_ADMIN_PASSWORD`(최초 관리자 생성 후 삭제). 설정 위치: Vercel 환경변수와 GitHub Secrets.

## 7. 보안 원칙

- 저장소는 비공개. 실제 위협정보·자산정보는 보안정책 확인 전에는 올리지 않고, 개발 중에는 가짜 데이터(seed)만 쓴다.
- 비밀번호·OTP 비밀키·API 키는 화면, 로그, 오류 메시지에 노출하지 않는다.
- 모든 외부 입력(수집 값, 폼)은 검증 후 저장하고 화면에 출력할 때는 이스케이프한다(수집한 URL·도메인 값이 악성 문자열일 수 있음). 위협정보 URL은 클릭 가능한 링크로 만들지 않고 텍스트로만 표시한다.
- 점검은 `scan_permitted = true`인 자산에만 실행한다.
- Supabase의 모든 표는 행 단위 보안(RLS)을 켠 상태로 만들었고 별도 정책(policy)은 두지 않는다. 앱은 서버에서 DB에 직접 연결하므로 동작에 영향이 없고, Supabase 공개 키(anon)로는 어떤 표도 읽거나 쓸 수 없다. 새 표를 추가할 때도 반드시 RLS를 켠다.
