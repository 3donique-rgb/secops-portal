/**
 * 데이터 표 정의 [고정] - design.md 3절과 prd.md 5절이 기준이다.
 * 시각은 UTC로 저장하고, 화면에서 한국시간(KST)으로 보여 준다.
 */
import {
  boolean,
  integer,
  pgEnum,
  pgTable,
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
