/** 감사 로그: 로그인 성공·실패와 관리 작업을 남긴다. 기록 실패가 본 작업을 막지 않도록 오류는 삼키고 서버 로그에만 남긴다. */
import { and, desc, eq, gte, ilike, lt, or, sql } from "drizzle-orm";
import { auditLogs, users } from "../db/schema";
import type { Db } from "./indicators";

export const AUDIT_ACTIONS = [
  "login_success",
  "login_fail",
  "login_locked",
  "login_ip_denied",
  "logout",
  "user_create",
  "user_role_change",
  "user_unlock",
  "user_otp_reset",
  "ip_add",
  "ip_remove",
  "whitelist_add",
  "whitelist_remove",
  "report_download",
  "apikey_create",
  "apikey_revoke",
  "source_create",
  "source_update",
  "asset_create",
  "asset_update",
  "asset_delete",
  "reputation_add",
  "reputation_vt_lookup",
] as const;

export type AuditInput = {
  userId?: string | null;
  action: string;
  target?: string | null;
  detail?: Record<string, unknown>;
  ip?: string | null;
  now?: Date;
};

/** 비밀번호·OTP 코드 같은 비밀값은 detail에 넣지 않는다 (호출하는 쪽 규칙). */
export async function writeAudit(db: Db, input: AuditInput): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      userId: input.userId ?? null,
      action: input.action,
      target: input.target ?? null,
      detail: input.detail ?? null,
      ip: input.ip ?? null,
      occurredAt: input.now ?? new Date(),
    });
  } catch (e) {
    console.error("[audit] 기록 실패:", e instanceof Error ? e.message : e);
  }
}

export type AuditFilter = {
  action?: string;
  keyword?: string;
  from?: Date;
  /** 이 시각 이전(미포함) */
  to?: Date;
  page?: number;
  pageSize?: number;
};

export async function listAudit(db: Db, f: AuditFilter = {}) {
  const pageSize = Math.min(Math.max(f.pageSize ?? 50, 1), 200);
  const page = Math.max(f.page ?? 1, 1);
  const kw = f.keyword?.trim();
  const where = and(
    f.action ? eq(auditLogs.action, f.action) : undefined,
    f.from ? gte(auditLogs.occurredAt, f.from) : undefined,
    f.to ? lt(auditLogs.occurredAt, f.to) : undefined,
    kw
      ? or(
          ilike(auditLogs.target, `%${kw.replace(/[%_\\]/g, "\\$&")}%`),
          ilike(users.username, `%${kw.replace(/[%_\\]/g, "\\$&")}%`),
          ilike(auditLogs.ip, `%${kw.replace(/[%_\\]/g, "\\$&")}%`),
        )
      : undefined,
  );
  const rows = await db
    .select({
      id: auditLogs.id,
      occurredAt: auditLogs.occurredAt,
      action: auditLogs.action,
      target: auditLogs.target,
      detail: auditLogs.detail,
      ip: auditLogs.ip,
      username: users.username,
    })
    .from(auditLogs)
    .leftJoin(users, eq(auditLogs.userId, users.id))
    .where(where)
    .orderBy(desc(auditLogs.occurredAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(auditLogs)
    .leftJoin(users, eq(auditLogs.userId, users.id))
    .where(where);
  return { rows, total: count, page, pageSize };
}
