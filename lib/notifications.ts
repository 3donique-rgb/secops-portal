/** 브라우저 안 알림 (6.4). 점검(2차)이 만든 알림을 보여 주고 읽음 처리한다. 알림은 모든 사용자에게 같이 보이고, 읽음 여부도 공유한다. */
import { and, desc, eq, sql } from "drizzle-orm";
import { assets, notifications } from "../db/schema";
import type { Db } from "./indicators";

export const NOTIFICATION_LABEL: Record<string, string> = {
  port_opened: "새 포트 열림",
  port_closed: "포트 닫힘",
  page_exposed: "노출 페이지 발견",
  cert_expiring: "인증서 만료 임박",
  asset_down: "접속 불가",
};

export async function unreadCount(db: Db): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(notifications).where(eq(notifications.read, false));
  return r.n;
}

export async function listNotifications(db: Db, f: { unreadOnly?: boolean; page?: number; pageSize?: number } = {}) {
  const pageSize = Math.min(Math.max(f.pageSize ?? 50, 1), 200);
  const page = Math.max(f.page ?? 1, 1);
  const where = f.unreadOnly ? eq(notifications.read, false) : undefined;
  const rows = await db
    .select({
      id: notifications.id, kind: notifications.kind, message: notifications.message, read: notifications.read,
      occurredAt: notifications.occurredAt, assetId: notifications.assetId, assetName: assets.name,
    })
    .from(notifications)
    .innerJoin(assets, eq(assets.id, notifications.assetId))
    .where(where)
    .orderBy(desc(notifications.occurredAt), desc(notifications.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(notifications).where(where);
  return { rows, total: n, page, pageSize };
}

export async function markRead(db: Db, id: string): Promise<boolean> {
  const rows = await db.update(notifications).set({ read: true }).where(and(eq(notifications.id, id), eq(notifications.read, false))).returning({ id: notifications.id });
  return rows.length > 0;
}

export async function markAllRead(db: Db): Promise<number> {
  const rows = await db.update(notifications).set({ read: true }).where(eq(notifications.read, false)).returning({ id: notifications.id });
  return rows.length;
}
