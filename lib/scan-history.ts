/** 자산 상세 화면용 점검 이력 조회와 날짜 간 비교 (7.8). */
import { and, desc, eq, inArray } from "drizzle-orm";
import { scanResults } from "../db/schema";
import type { Db } from "./indicators";

export type ScanRow = typeof scanResults.$inferSelect;

export async function listScanHistory(db: Db, assetId: string, limit = 60) {
  return db
    .select({
      scanDate: scanResults.scanDate, status: scanResults.status, scanLevel: scanResults.scanLevel,
      openPorts: scanResults.openPorts, exposedPages: scanResults.exposedPages, certExpiresAt: scanResults.certExpiresAt,
    })
    .from(scanResults)
    .where(eq(scanResults.assetId, assetId))
    .orderBy(desc(scanResults.scanDate))
    .limit(limit);
}

export async function getScan(db: Db, assetId: string, scanDate: string): Promise<ScanRow | null> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(scanDate)) return null;
  const [r] = await db.select().from(scanResults).where(and(eq(scanResults.assetId, assetId), eq(scanResults.scanDate, scanDate))).limit(1);
  return r ?? null;
}

export type ScanComparison = {
  portsOpened: ScanRow["openPorts"];
  portsClosed: ScanRow["openPorts"];
  pagesAdded: ScanRow["exposedPages"];
  pagesRemoved: ScanRow["exposedPages"];
  certChanged: boolean;
};

/** from(이전) → to(이후)로 무엇이 달라졌는지 */
export function compareScans(from: ScanRow, to: ScanRow): ScanComparison {
  const fp = new Set(from.openPorts.map((p) => p.port));
  const tp = new Set(to.openPorts.map((p) => p.port));
  const fg = new Set(from.exposedPages.map((p) => p.path));
  const tg = new Set(to.exposedPages.map((p) => p.path));
  return {
    portsOpened: to.openPorts.filter((p) => !fp.has(p.port)),
    portsClosed: from.openPorts.filter((p) => !tp.has(p.port)),
    pagesAdded: to.exposedPages.filter((p) => !fg.has(p.path)),
    pagesRemoved: from.exposedPages.filter((p) => !tg.has(p.path)),
    certChanged: (from.certExpiresAt?.getTime() ?? null) !== (to.certExpiresAt?.getTime() ?? null),
  };
}

/** 자산별 가장 최근 점검 결과 (자산 id → 결과). 점검 이력이 없는 자산은 들어 있지 않다. */
export async function latestScans(db: Db, assetIds: string[]): Promise<Map<string, ScanRow>> {
  const map = new Map<string, ScanRow>();
  if (assetIds.length === 0) return map;
  const rows = await db.select().from(scanResults).where(inArray(scanResults.assetId, assetIds)).orderBy(desc(scanResults.scanDate));
  for (const r of rows) if (!map.has(r.assetId)) map.set(r.assetId, r);
  return map;
}
