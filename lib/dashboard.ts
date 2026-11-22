/** 대시보드 집계 (6.5): 신규 지표, 출처별 수집 상태, 자산 수, 알림 요약. */
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { assets, indicators, notifications, sources } from "../db/schema";
import type { Db } from "./indicators";

const HOUR = 3600_000;

export type Dashboard = {
  indicators: { total: number; active: number; excluded: number; new24h: number; new7d: number; byType: Record<string, number> };
  sources: { id: string; name: string; enabled: boolean; lastSuccessAt: Date | null; lastStatus: "success" | "fail" | null; lastError: string | null; stale: boolean }[];
  assets: { total: number; enabled: number };
  notifications: { unread: number; recent: { id: string; kind: string; message: string; assetId: string; assetName: string; occurredAt: Date; read: boolean }[] };
};

export async function getDashboard(db: Db, now: Date = new Date()): Promise<Dashboard> {
  const since = (h: number) => new Date(now.getTime() - h * HOUR);
  const [ind] = await db
    .select({
      total: sql<number>`count(*)::int`,
      active: sql<number>`count(*) filter (where ${indicators.status} = 'active')::int`,
      excluded: sql<number>`count(*) filter (where ${indicators.excluded})::int`,
      new24h: sql<number>`count(*) filter (where ${indicators.firstSeenAt} >= ${since(24).toISOString()}::timestamptz)::int`,
      new7d: sql<number>`count(*) filter (where ${indicators.firstSeenAt} >= ${since(24 * 7).toISOString()}::timestamptz)::int`,
    })
    .from(indicators);
  const byTypeRows = await db
    .select({ type: indicators.type, n: sql<number>`count(*)::int` })
    .from(indicators)
    .where(eq(indicators.status, "active"))
    .groupBy(indicators.type);

  const srcRows = await db
    .select({
      id: sources.id,
      name: sources.name,
      enabled: sources.enabled,
      lastSuccessAt: sources.lastSuccessAt,
      lastStatus: sql<"success" | "fail" | null>`(select r.status from collect_runs r where r.source_id = "sources"."id" order by r.started_at desc limit 1)`,
      lastError: sql<string | null>`(select r.error_message from collect_runs r where r.source_id = "sources"."id" order by r.started_at desc limit 1)`,
    })
    .from(sources)
    .orderBy(sources.name);

  const [ast] = await db
    .select({ total: sql<number>`count(*)::int`, enabled: sql<number>`count(*) filter (where ${assets.enabled})::int` })
    .from(assets);
  const [{ unread }] = await db.select({ unread: sql<number>`count(*)::int` }).from(notifications).where(eq(notifications.read, false));
  const recent = await db
    .select({
      id: notifications.id, kind: notifications.kind, message: notifications.message, assetId: notifications.assetId,
      assetName: assets.name, occurredAt: notifications.occurredAt, read: notifications.read,
    })
    .from(notifications)
    .innerJoin(assets, eq(assets.id, notifications.assetId))
    .where(and(gte(notifications.occurredAt, since(24 * 7))))
    .orderBy(desc(notifications.occurredAt))
    .limit(5);

  return {
    indicators: { ...ind, byType: Object.fromEntries(byTypeRows.map((r) => [r.type, r.n])) },
    // 사용 중인데 3시간 넘게 성공이 없으면 "지연"으로 표시 (매시간 수집 기준)
    sources: srcRows.map((s) => ({ ...s, stale: s.enabled && (!s.lastSuccessAt || now.getTime() - s.lastSuccessAt.getTime() > 3 * HOUR) })),
    assets: ast,
    notifications: { unread, recent },
  };
}
