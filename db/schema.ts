/**
 * 데이터 표 정의 [고정] - design.md 3절과 prd.md 5절이 기준이다.
 * 시각은 UTC로 저장하고, 화면에서 한국시간(KST)으로 보여 준다.
 */
import { sql } from "drizzle-orm";
import {
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
