/**
 * 데이터 표 정의 [고정] - design.md 3절과 prd.md 5절이 기준이다.
 * 시각은 UTC로 저장하고, 화면에서 한국시간(KST)으로 보여 준다.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// 공통 열
// ---------------------------------------------------------------------------
const id = () => uuid().defaultRandom().primaryKey();
const createdAt = () =>
  timestamp({ withTimezone: true }).notNull().defaultNow();

// ---------------------------------------------------------------------------
// 1.1 사용자
// ---------------------------------------------------------------------------
export const userRole = pgEnum("user_role", ["admin", "viewer"]);

export const users = pgTable("users", {
  id: id(),
  createdAt: createdAt(),
  username: text().notNull().unique(),
  name: text().notNull(),
  passwordHash: text().notNull(),
  role: userRole().notNull().default("viewer"),
  /** AES-256-GCM으로 암호화한 OTP 비밀키 */
  otpSecretEnc: text(),
  otpEnabled: boolean().notNull().default(false),
  /** false 이면 아이디·비밀번호(와 허용 IP)만으로 로그인한다 (관리자가 계정별로 선택) */
  otpRequired: boolean().notNull().default(true),
  failedCount: integer().notNull().default(0),
  locked: boolean().notNull().default(false),
  lastLoginAt: timestamp({ withTimezone: true }),
});

export const userAllowedIps = pgTable(
  "user_allowed_ips",
  {
    id: id(),
    createdAt: createdAt(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** 예: 1.2.3.4/32 */
    cidr: text().notNull(),
    memo: text(),
    createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [unique("user_allowed_ips_user_cidr_uq").on(t.userId, t.cidr)],
);

// ---------------------------------------------------------------------------
// 1.2 수집 출처·수집 이력
// ---------------------------------------------------------------------------
export const sourceKind = pgEnum("source_kind", ["api", "html", "pdf"]);
export const runStatus = pgEnum("run_status", ["success", "fail"]);

export const sources = pgTable("sources", {
  id: id(),
  createdAt: createdAt(),
  /** 제공 기관명 (필수). 모든 위협정보의 출처 표시에 쓰인다. */
  name: text().notNull(),
  kind: sourceKind().notNull(),
  url: text().notNull(),
  /** 키 위치, CSS 선택자, 응답 필드 매핑 등 수집 방식별 설정 */
  config: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  /** AES-256-GCM으로 암호화한 API 키 */
  apiKeyEnc: text(),
  enabled: boolean().notNull().default(true),
  lastSuccessAt: timestamp({ withTimezone: true }),
});

export const collectRuns = pgTable(
  "collect_runs",
  {
    id: id(),
    createdAt: createdAt(),
    sourceId: uuid()
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    startedAt: timestamp({ withTimezone: true }).notNull(),
    status: runStatus().notNull(),
    newCount: integer().notNull().default(0),
    errorMessage: text(),
  },
  (t) => [index("collect_runs_source_started_idx").on(t.sourceId, t.startedAt)],
);

// ---------------------------------------------------------------------------
// 1.3 위협정보(지표)·출처 연결
// ---------------------------------------------------------------------------
export const indicatorType = pgEnum("indicator_type", [
  "ip",
  "domain",
  "url",
  "hash",
  "email",
]);
export const hashKind = pgEnum("hash_kind", ["md5", "sha1", "sha256"]);
export const indicatorStatus = pgEnum("indicator_status", [
  "active",
  "inactive",
]);

export const indicators = pgTable(
  "indicators",
  {
    id: id(),
    createdAt: createdAt(),
    type: indicatorType().notNull(),
    /** 정규화된 값 (소문자, 방어 표기 복원 등) */
    value: text().notNull(),
    /** type = 'hash'일 때만 값이 있다 */
    hashKind: hashKind(),
    status: indicatorStatus().notNull().default("active"),
    /** 화이트리스트·우리 자산과 일치하면 true → SIEM 제공 목록에서만 제외 */
    excluded: boolean().notNull().default(false),
    firstSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    memo: text(),
  },
  (t) => [
    // (종류, 값) 한 쌍은 한 건만 존재 [고정]
    unique("indicators_type_value_uq").on(t.type, t.value),
    // 해시 종류는 type = 'hash'일 때만
    check(
      "indicators_hash_kind_ck",
      sql`(${t.type} = 'hash') = (${t.hashKind} is not null)`,
    ),
    // 인덱스 크기 한계를 넘는 아주 긴 값 방지
    check("indicators_value_len_ck", sql`length(${t.value}) <= 2000`),
    index("indicators_last_seen_idx").on(t.lastSeenAt),
    index("indicators_status_excluded_idx").on(t.status, t.excluded),
  ],
);

export const indicatorSources = pgTable(
  "indicator_sources",
  {
    id: id(),
    createdAt: createdAt(),
    indicatorId: uuid()
      .notNull()
      .references(() => indicators.id, { onDelete: "cascade" }),
    /** 출처가 삭제되어도 기록은 남도록 set null */
    sourceId: uuid().references(() => sources.id, { onDelete: "set null" }),
    /** 기관명 복사본 (출처 필수 규칙 [고정]) */
    sourceName: text().notNull(),
    firstSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    refUrl: text(),
    note: text(),
  },
  (t) => [
    unique("indicator_sources_indicator_source_uq").on(
      t.indicatorId,
      t.sourceId,
    ),
  ],
);

// ---------------------------------------------------------------------------
// 1.4 화이트리스트·자산
// ---------------------------------------------------------------------------
export const whitelistType = pgEnum("whitelist_type", [
  "ip",
  "cidr",
  "domain",
]);

export const whitelist = pgTable(
  "whitelist",
  {
    id: id(),
    createdAt: createdAt(),
    type: whitelistType().notNull(),
    value: text().notNull(),
    reason: text(),
    createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [unique("whitelist_type_value_uq").on(t.type, t.value)],
);

export const assets = pgTable(
  "assets",
  {
    id: id(),
    createdAt: createdAt(),
    name: text().notNull(),
    /** 도메인 또는 IP */
    target: text().notNull(),
    owner: text(),
    department: text(),
    /** 중요도 1~5 */
    importance: smallint().notNull().default(3),
    /** 점검 강도 1~5 (기본 3) */
    scanLevel: smallint().notNull().default(3),
    /** 점검 허가 확인. 등록하려면 반드시 true [고정] */
    scanPermitted: boolean().notNull(),
    enabled: boolean().notNull().default(true),
    memo: text(),
  },
  (t) => [
    check("assets_importance_ck", sql`${t.importance} between 1 and 5`),
    check("assets_scan_level_ck", sql`${t.scanLevel} between 1 and 5`),
    check("assets_scan_permitted_ck", sql`${t.scanPermitted} = true`),
    index("assets_target_idx").on(t.target),
  ],
);

// ---------------------------------------------------------------------------
// 1.5 점검 결과·알림
// ---------------------------------------------------------------------------
export const scanStatus = pgEnum("scan_status", [
  "success",
  "fail",
  "partial",
]);
export const notificationKind = pgEnum("notification_kind", [
  "port_opened",
  "port_closed",
  "page_exposed",
  "cert_expiring",
  "asset_down",
]);

export type OpenPort = {
  port: number;
  protocol: string;
  service?: string;
  version?: string;
};
export type ExposedPage = {
  path: string;
  statusCode: number;
  kind: string;
};

export const scanResults = pgTable(
  "scan_results",
  {
    id: id(),
    createdAt: createdAt(),
    assetId: uuid()
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    /** 점검일 (KST 기준 날짜) */
    scanDate: date({ mode: "string" }).notNull(),
    scanLevel: smallint().notNull(),
    status: scanStatus().notNull(),
    openPorts: jsonb().$type<OpenPort[]>().notNull().default([]),
    exposedPages: jsonb().$type<ExposedPage[]>().notNull().default([]),
    certExpiresAt: timestamp({ withTimezone: true }),
    errorMessage: text(),
    durationSec: integer(),
  },
  (t) => [
    // 하루 한 건, 재실행하면 덮어쓴다 [고정]
    unique("scan_results_asset_date_uq").on(t.assetId, t.scanDate),
    // 1년 지난 결과 삭제용
    index("scan_results_scan_date_idx").on(t.scanDate),
  ],
);

export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    createdAt: createdAt(),
    kind: notificationKind().notNull(),
    assetId: uuid()
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    message: text().notNull(),
    read: boolean().notNull().default(false),
    occurredAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("notifications_read_occurred_idx").on(t.read, t.occurredAt)],
);

// ---------------------------------------------------------------------------
// 1.6 감사 로그·SIEM API 키
// ---------------------------------------------------------------------------
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: id(),
    createdAt: createdAt(),
    /** 로그인 실패처럼 사용자를 특정할 수 없는 경우는 비어 있다 */
    userId: uuid().references(() => users.id, { onDelete: "set null" }),
    action: text().notNull(),
    target: text(),
    detail: jsonb().$type<Record<string, unknown>>(),
    ip: text(),
    occurredAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_logs_occurred_idx").on(t.occurredAt)],
);

export const apiKeys = pgTable("api_keys", {
  id: id(),
  createdAt: createdAt(),
  name: text().notNull(),
  /** 키 원문은 저장하지 않고 해시만 저장한다 [고정] */
  keyHash: text().notNull().unique(),
  createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
  lastUsedAt: timestamp({ withTimezone: true }),
  revoked: boolean().notNull().default(false),
});

// ---------------------------------------------------------------------------
// 1.7 평판 기록 (VirusTotal 분석 결과·분석가 판정) - 지표마다 이력으로 쌓는다
// ---------------------------------------------------------------------------
export const reputationVerdict = pgEnum("reputation_verdict", [
  "malicious",
  "suspicious",
  "harmless",
  "unknown",
]);

export const indicatorReputations = pgTable(
  "indicator_reputations",
  {
    id: id(),
    createdAt: createdAt(),
    indicatorId: uuid()
      .notNull()
      .references(() => indicators.id, { onDelete: "cascade" }),
    /** manual = 사람이 직접 기록, virustotal = VirusTotal API 조회 */
    origin: text().notNull().default("manual"),
    verdict: reputationVerdict().notNull().default("unknown"),
    /** VirusTotal 분석 엔진 집계 (직접 기록할 때는 비어 있을 수 있다) */
    vtMalicious: integer(),
    vtSuspicious: integer(),
    vtHarmless: integer(),
    vtUndetected: integer(),
    /** VirusTotal 커뮤니티 평판 점수 */
    vtReputation: integer(),
    note: text(),
    createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    index("indicator_reputations_indicator_idx").on(t.indicatorId, t.createdAt),
    check("indicator_reputations_origin_ck", sql`${t.origin} in ('manual', 'virustotal')`),
  ],
);

// ---------------------------------------------------------------------------
// 1.8 도메인이 가리키는 IP, 그리고 IP 대역의 국가 정보 (whois 후속 표준 RDAP 조회 결과)
// ---------------------------------------------------------------------------
export const domainIps = pgTable(
  "domain_ips",
  {
    indicatorId: uuid()
      .primaryKey()
      .references(() => indicators.id, { onDelete: "cascade" }),
    /** ok = IP를 찾음, unresolved = DNS에 없음(사라진 도메인 등) */
    status: text().notNull(),
    ip: text(),
    /** IPv4를 숫자로 바꾼 값 (대역 비교용) */
    ipNum: bigint({ mode: "number" }),
    resolvedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("domain_ips_status_ck", sql`${t.status} in ('ok', 'unresolved')`), index("domain_ips_resolved_idx").on(t.resolvedAt)],
);

export const netRanges = pgTable(
  "net_ranges",
  {
    id: id(),
    startNum: bigint({ mode: "number" }).notNull(),
    endNum: bigint({ mode: "number" }).notNull(),
    /** 두 글자 국가 코드 (KR, US ...). 알 수 없으면 비어 있음 */
    countryCode: text(),
    netName: text(),
    fetchedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("net_ranges_range_uq").on(t.startNum, t.endNum), index("net_ranges_start_idx").on(t.startNum, t.endNum)],
);
