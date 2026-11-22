# 작업 순서표 (tasks.md)

> 한 작업은 10~20분 안에 끝나는 크기. 끝나면 [x] 표시하고 멈춘다.
> 순서: 준비 → 데이터베이스 → (기존 데이터 옮기기: 해당 없음, 가짜 데이터로 대체) → 핵심 기능 → 화면 → 배포
> 1차 = 작업 0~6, 2차 = 작업 7

## 0. 준비
- [x] 0.1 GitHub 비공개 저장소 연결, prd.md·design.md·tasks.md·rules.md·CHANGELOG.md 올리기
- [x] 0.2 Next.js(TypeScript, Tailwind) 프로젝트 생성, 폴더 구조 만들기(design.md 2절)
- [x] 0.3 Supabase 프로젝트 만들고 DATABASE_URL 받기 (사용자가 직접 만들고 값은 Vercel/.env에만 넣음)
- [x] 0.4 .env.example 만들기, .gitignore에 .env 확인
- [x] 0.5 Vercel에 저장소 연결, 빈 화면 첫 배포 확인

## 1. 데이터베이스 (1차)
- [x] 1.1 Drizzle 설정, users·user_allowed_ips 표 정의 + 마이그레이션
- [x] 1.2 sources·collect_runs 표 정의
- [x] 1.3 indicators·indicator_sources 표 정의(고유 조건 포함)
- [x] 1.4 whitelist·assets 표 정의
- [x] 1.5 scan_results·notifications 표 정의
- [x] 1.6 audit_logs·api_keys 표 정의
- [x] 1.7 마이그레이션 실행, 표가 모두 생겼는지 확인 (Supabase SQL Editor에서 실행, 12개 표·RLS 켜짐 확인)
- [x] 1.8 개발용 가짜 데이터 스크립트(seed-demo): 출처 3개, 지표 50건, 자산 10개 (가짜 DB 시험 완료, 실제 DB 실행은 접속 설정 후: npm run seed:demo)

## 2. 핵심 기능 (화면 없이) (1차)
- [x] 2.1 lib/normalize.ts: 지표 정규화·종류 판별
- [x] 2.2 tests: normalize 시험 사례 6가지 이상(방어 표기, 해시 길이, 사설 IP 등) 통과
- [x] 2.3 lib/indicators.ts: 저장·중복 병합(출처 필수)
- [x] 2.4 lib/indicators.ts: 만료 처리·비활성 복귀
- [x] 2.5 tests: 병합·만료·복귀 시험 사례 통과
- [x] 2.6 lib/whitelist.ts: IP·CIDR·도메인·우리 자산 제외 판정
- [x] 2.7 tests: 제외 판정 시험 통과
- [x] 2.8 lib/crypto.ts: AES-256-GCM 암호화·복호화 + 시험
- [x] 2.9 lib/auth.ts: 비밀번호 해시·검증, 5회 잠금
- [x] 2.10 lib/auth.ts: OTP 비밀키 생성·QR·코드 검증
- [x] 2.11 lib/auth.ts: 허용 IP 판정(관리자 예외)
- [x] 2.12 lib/auth.ts: 임시 쿠키·세션 쿠키, 권한 확인 함수
- [x] 2.13 tests: 로그인 판정 시험 사례 6가지 이상 통과
- [x] 2.14 최초 관리자 생성 스크립트(seed-admin, 2.9의 비밀번호 해시 사용) (가짜 DB 시험 완료, 실제 DB 실행은 접속 설정 후: npm run seed:admin)

## 3. 로그인·공통 화면 (1차)
- [x] 3.1 /login 화면과 1차 인증 API
- [x] 3.2 /login/otp 화면: 최초 등록(QR)·코드 입력
- [x] 3.3 공통 화면 틀(메뉴, 알림 종, 로그아웃)과 권한별 메뉴 표시
- [x] 3.4 모든 경로 접근 제어(미로그인은 /login, viewer는 관리자 화면 403)
- [x] 3.5 /admin/users: 목록, 생성, 권한, 잠금 해제, OTP 초기화
- [x] 3.6 /admin/users: 계정별 허용 IP 등록·삭제
- [x] 3.7 /admin/audit 화면, 로그인·관리 작업 기록 연결

## 4. 위협정보 화면·API (1차)
- [x] 4.1 /indicators 목록: 표, 종류·상태·출처 필터, 페이지 나누기
- [x] 4.2 /indicators 키워드·기간 검색
- [x] 4.3 /indicators/[id] 상세: 출처 목록
- [x] 4.4 /admin/whitelist 화면 + 추가·삭제 시 제외 재계산
- [x] 4.5 lib/report-pdf.ts: PDF 보고서 생성(한글 폰트 포함)
- [x] 4.6 /reports 화면: 조건 입력, 미리보기 건수, PDF 내려받기
- [x] 4.7 /admin/siem 화면: API 키 발급·폐기(해시 저장)
- [x] 4.8 GET /api/siem/indicators (json·csv·txt, 인증, 조건)
- [x] 4.9 tests: SIEM API 시험(키 없음·폐기·excluded 제외)

## 5. 수집기 (1차)
- [x] 5.1 /admin/sources 화면: 출처 등록·수정·사용 여부(API 키 암호화 저장)
- [x] 5.2 worker/collect: 공통 실행 틀(출처 순회, 실패 격리, collect_runs 기록, 제한 시간·재시도)
- [x] 5.3 worker/collect/api.ts 수집기
- [x] 5.4 worker/collect/html.ts 수집기
- [x] 5.5 worker/collect/pdf.ts 수집기
- [x] 5.6 수집기 시험(가짜 응답으로 화면 없이 실행)
- [x] 5.7 /admin/sources/[id]/runs 수집 이력 화면
- [ ] 5.8 .github/workflows/collect.yml(1시간 주기) + GitHub Secrets 설정 — 파일 작성 완료, GitHub Secrets 입력은 사용자 확인 대기
- [x] 5.9 worker/cleanup.ts + cleanup.yml(만료 처리, 1년 보관 삭제)

## 6. 자산 등록·대시보드 (1차)
- [x] 6.1 /assets 목록
- [x] 6.2 /assets/new, /assets/[id]/edit: 등록·수정(점검 허가 확인 필수, 강도 1~5), 등록·수정·삭제 시 지표 제외 재계산 연결
- [x] 6.3 /assets/[id] 상세(점검 결과는 아직 비어 있음 표시)
- [x] 6.4 /notifications 화면과 상단 종 알림(읽음 처리, 화면을 열어 둔 동안 1분마다 새 알림 확인)
- [x] 6.5 대시보드: 신규 지표, 출처별 수집 상태, 자산 수, 알림 요약
- [ ] 6.6 1차 배포 점검: 다른 PC에서 로그인·OTP·허용 IP 실제 확인, 사용 안내문 1쪽

## 7. 자산 점검 (2차)
- [x] 7.1 worker/scan/ports.ts: 단계별 포트 목록, 연결 시도, 처리량 제한
- [x] 7.2 worker/scan/ports.ts: 서비스·배너 식별
- [x] 7.3 worker/scan/tls.ts: 인증서 만료일
- [x] 7.4 worker/scan/paths.ts: 노출 페이지 경로 목록·HTTP 확인
- [x] 7.5 worker/scan/index.ts: 단계별 조합, 자산당 시간 제한, 결과 저장(하루 한 건 덮어쓰기)
- [x] 7.6 tests: 가짜 서버(내 컴퓨터)로 점검 시험, 점검 허가 없는 자산은 건너뛰는지 확인
- [x] 7.7 worker/scan/diff.ts: 변화 감지·알림 생성 + 시험
- [x] 7.8 /assets/[id]: 점검 이력, 날짜 간 비교 화면
- [x] 7.9 .github/workflows/scan.yml: 매일 실행, 자산 묶음 병렬 실행
- [ ] 7.10 소수 자산(3~5개)으로 실제 시험 후 단계적 확대, 대상 보안장비 허용 확인

## 작업 메모 (하루 마칠 때 맨 아래에 3줄로 정리)
