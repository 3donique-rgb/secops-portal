/**
 * 정리 작업 (5.9): 하루 한 번.
 * - 90일 넘게 재확인되지 않은 지표를 비활성으로 [고정]
 * - 점검 결과·알림은 1년(365일) 지난 것 삭제 [고정]
 * - 수집 이력도 1년 지난 것 삭제
 * 지표 자체는 지우지 않는다(비활성으로만 바뀜).
 */
import { lt } from "drizzle-orm";
import { collectRuns, notifications, scanResults } from "../db/schema";
import { expireIndicators, type Db } from "../lib/indicators";

export const RETENTION_DAYS = 365;
const DAY = 24 * 60 * 60 * 1000;

export type CleanupResult = { expired: number; scanResults: number; notifications: number; collectRuns: number };

export async function runCleanup(db: Db, now: Date = new Date()): Promise<CleanupResult> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * DAY);
  const expired = await expireIndicators(db, now);
  const cutoffDate = cutoff.toISOString().slice(0, 10); // 점검일 기준
  const scans = await db.delete(scanResults).where(lt(scanResults.scanDate, cutoffDate)).returning({ id: scanResults.id });
  const notes = await db.delete(notifications).where(lt(notifications.occurredAt, cutoff)).returning({ id: notifications.id });
  const runs = await db.delete(collectRuns).where(lt(collectRuns.createdAt, cutoff)).returning({ id: collectRuns.id });
  return { expired, scanResults: scans.length, notifications: notes.length, collectRuns: runs.length };
}
