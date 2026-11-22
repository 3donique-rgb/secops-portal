import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assets, collectRuns, indicators, notifications, scanResults, sources } from "../db/schema";
import { saveIndicator } from "../lib/indicators";
import { runCleanup } from "../worker/cleanup";
import { createTestDb, resetData } from "./helpers/test-db";

/**
 * 시험 사례 표 (기준일 2026-11-22)
 *  1. 만료      → 마지막 확인이 90일 넘은 지표만 비활성 (정확히 90일은 유지), 지표는 지워지지 않음
 *  2. 1년 보관  → 점검 결과(점검일 기준)·알림·수집 이력은 365일 지난 것만 삭제, 최근 것은 유지
 *  3. 반복 실행 → 두 번째 실행은 아무것도 바꾸지 않음
 */
let ctx: Awaited<ReturnType<typeof createTestDb>>;
const NOW = new Date("2026-11-22T00:00:00Z");
const DAY = 86400000;
const ago = (d: number) => new Date(NOW.getTime() - d * DAY);
beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.client.close();
});
beforeEach(async () => {
  await resetData(ctx.client);
});

describe("정리 작업", () => {
  it("90일 만료와 1년 보관 삭제", async () => {
    const [src] = await ctx.db.insert(sources).values({ name: "S", kind: "api", url: "https://s.test" }).returning();
    for (const [raw, d] of [["198.51.100.1", 91], ["198.51.100.2", 90], ["198.51.100.3", 1]] as const) {
      await saveIndicator(ctx.db, { raw, source: { id: src.id, name: "S" }, now: ago(d) });
    }
    const [asset] = await ctx.db.insert(assets).values({ name: "A", target: "a.asset.test", importance: 3, scanLevel: 3, scanPermitted: true }).returning();
    const d = (n: number) => ago(n).toISOString().slice(0, 10);
    await ctx.db.insert(scanResults).values([
      { assetId: asset.id, scanDate: d(400), scanLevel: 3, status: "success" },
      { assetId: asset.id, scanDate: d(366), scanLevel: 3, status: "success" },
      { assetId: asset.id, scanDate: d(365), scanLevel: 3, status: "success" },
      { assetId: asset.id, scanDate: d(1), scanLevel: 3, status: "success" },
    ]);
    await ctx.db.insert(notifications).values([
      { kind: "port_opened", assetId: asset.id, message: "old", occurredAt: ago(366) },
      { kind: "port_opened", assetId: asset.id, message: "new", occurredAt: ago(2) },
    ]);
    await ctx.db.insert(collectRuns).values([
      { sourceId: src.id, startedAt: ago(500), status: "success", createdAt: ago(500) },
      { sourceId: src.id, startedAt: ago(1), status: "success", createdAt: ago(1) },
    ]);

    const r = await runCleanup(ctx.db, NOW);
    expect(r).toEqual({ expired: 1, scanResults: 2, notifications: 1, collectRuns: 1 });
    const inds = await ctx.db.select({ v: indicators.value, s: indicators.status }).from(indicators);
    expect(Object.fromEntries(inds.map((i) => [i.v, i.s]))).toEqual({ "198.51.100.1": "inactive", "198.51.100.2": "active", "198.51.100.3": "active" });
    expect(await ctx.db.select().from(scanResults)).toHaveLength(2);
    expect((await ctx.db.select().from(notifications)).map((n) => n.message)).toEqual(["new"]);

    expect(await runCleanup(ctx.db, NOW)).toEqual({ expired: 0, scanResults: 0, notifications: 0, collectRuns: 0 });
  });
});
