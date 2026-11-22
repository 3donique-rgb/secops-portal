/** 변화 감지 (7.7): 오늘 결과를 직전 성공 결과와 비교해 알림(notifications)을 만든다. 첫 점검은 비교 대상이 없어 알림을 만들지 않는다. */
import { and, desc, eq, gte, lt } from "drizzle-orm";
import { notifications, scanResults } from "../../db/schema";
import type { Db } from "../../lib/indicators";

export const CERT_WARN_DAYS = 30;
const DAY = 86400000;
const kstDayStart = (scanDate: string) => new Date(`${scanDate}T00:00:00+09:00`);

type Row = typeof scanResults.$inferSelect;
export type Change = { kind: (typeof notifications.$inferInsert)["kind"]; message: string };

/** 두 결과의 차이를 알림 목록으로 만든다 (DB 접근 없음). */
export function diffResults(prev: Row, cur: Row, now: Date): Change[] {
  const out: Change[] = [];
  if (cur.status === "fail") {
    out.push({ kind: "asset_down", message: "자산에 접속할 수 없습니다(점검에 응답 없음)." });
    return out;
  }
  const had = new Set(prev.openPorts.map((p) => p.port));
  const has = new Set(cur.openPorts.map((p) => p.port));
  for (const p of cur.openPorts) {
    if (!had.has(p.port)) out.push({ kind: "port_opened", message: `${p.port}/tcp 새로 열림${p.service ? ` (${p.service}${p.version ? ` ${p.version}` : ""})` : ""}` });
  }
  // 시간 제한으로 일부만 점검됐다면 "닫힘"은 판단할 수 없다.
  if (cur.status === "success") {
    for (const p of prev.openPorts) if (!has.has(p.port)) out.push({ kind: "port_closed", message: `${p.port}/tcp 닫힘` });
  }
  const hadPages = new Set(prev.exposedPages.map((x) => x.path));
  for (const pg of cur.exposedPages) {
    if (!hadPages.has(pg.path)) out.push({ kind: "page_exposed", message: `${pg.path} 노출 (${pg.kind}, 응답 ${pg.statusCode})` });
  }
  if (cur.certExpiresAt) {
    const left = Math.floor((cur.certExpiresAt.getTime() - now.getTime()) / DAY);
    if (left <= CERT_WARN_DAYS) {
      const date = cur.certExpiresAt.toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" });
      out.push({ kind: "cert_expiring", message: left < 0 ? `인증서가 ${-left}일 전에 만료됨 (${date})` : `인증서 만료 ${left}일 전 (${date})` });
    }
  }
  return out;
}

/** 오늘 결과를 직전 성공 결과와 비교해 알림을 저장한다. 같은 날 다시 실행해도 같은 알림이 중복되지 않는다. */
export async function detectChanges(db: Db, assetId: string, scanDate: string, now: Date): Promise<number> {
  const [cur] = await db.select().from(scanResults).where(and(eq(scanResults.assetId, assetId), eq(scanResults.scanDate, scanDate))).limit(1);
  if (!cur) return 0;
  const [prev] = await db
    .select()
    .from(scanResults)
    .where(and(eq(scanResults.assetId, assetId), lt(scanResults.scanDate, scanDate), eq(scanResults.status, "success")))
    .orderBy(desc(scanResults.scanDate))
    .limit(1);
  if (!prev) return 0;

  const start = kstDayStart(scanDate);
  const existing = await db
    .select({ kind: notifications.kind, message: notifications.message })
    .from(notifications)
    .where(and(eq(notifications.assetId, assetId), gte(notifications.occurredAt, start)));
  const seen = new Set(existing.map((e) => `${e.kind}|${e.message}`));
  const fresh = diffResults(prev, cur, now).filter((c) => !seen.has(`${c.kind}|${c.message}`));
  if (fresh.length > 0) await db.insert(notifications).values(fresh.map((c) => ({ ...c, assetId, occurredAt: now })));
  return fresh.length;
}
