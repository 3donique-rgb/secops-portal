import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { assets, collectRuns, indicators, notifications, sources } from "../db/schema";
import { getDashboard } from "../lib/dashboard";
import { saveIndicator } from "../lib/indicators";
import { createTestDb, resetData } from "./helpers/test-db";

/**
 * 시험 사례 표 (기준 시각 2026-11-22 12:00 UTC)
 *  1. 신규 지표   → 최초 확인이 24시간/7일 이내인 건수 (재확인으로 최종 확인일이 바뀌어도 신규가 아님)
 *  2. 합계        → 전체/활성/제외, 종류별은 활성만
 *  3. 출처 상태   → 마지막 결과·오류, 사용 중이면서 3시간 넘게 성공 없으면 지연, 꺼진 출처는 지연 아님
 *  4. 자산·알림   → 자산 수(사용 중), 읽지 않은 알림 수, 최근 알림 5건(7일 이내)
 *  5. 빈 DB       → 모두 0
 */
let ctx: Awaited<ReturnType<typeof createTestDb>>;
const NOW = new Date("2026-11-22T12:00:00Z");
const H = 3600_000;
beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.client.close();
});
beforeEach(async () => {
  await resetData(ctx.client);
});

describe("대시보드", () => {
  it("빈 DB는 모두 0", async () => {
    const d = await getDashboard(ctx.db, NOW);
    expect(d.indicators).toMatchObject({ total: 0, active: 0, excluded: 0, new24h: 0, new7d: 0, byType: {} });
    expect(d.assets).toEqual({ total: 0, enabled: 0 });
    expect(d.notifications).toEqual({ unread: 0, recent: [] });
    expect(d.sources).toEqual([]);
  });

  it("지표·출처·자산·알림 집계", async () => {
    const [ok] = await ctx.db.insert(sources).values({ name: "정상", kind: "api", url: "https://a.test", lastSuccessAt: new Date(NOW.getTime() - 1 * H) }).returning();
    const [late] = await ctx.db.insert(sources).values({ name: "지연", kind: "api", url: "https://b.test", lastSuccessAt: new Date(NOW.getTime() - 5 * H) }).returning();
    const [off] = await ctx.db.insert(sources).values({ name: "꺼짐", kind: "api", url: "https://c.test", enabled: false }).returning();
    await ctx.db.insert(collectRuns).values([
      { sourceId: ok.id, startedAt: new Date(NOW.getTime() - 1 * H), status: "success" },
      { sourceId: late.id, startedAt: new Date(NOW.getTime() - 2 * H), status: "fail", errorMessage: "HTTP 503" },
    ]);
    const S = { id: ok.id, name: "정상" };
    await saveIndicator(ctx.db, { raw: "198.51.100.1", source: S, now: new Date(NOW.getTime() - 2 * H) }); // 신규 24h
    await saveIndicator(ctx.db, { raw: "198.51.100.2", source: S, now: new Date(NOW.getTime() - 3 * 24 * H) }); // 신규 7d
    await saveIndicator(ctx.db, { raw: "bad.example", source: S, now: new Date(NOW.getTime() - 10 * 24 * H) }); // 오래됨
    await saveIndicator(ctx.db, { raw: "bad.example", source: S, now: new Date(NOW.getTime() - 1 * H) }); // 재확인 → 신규 아님
    await ctx.db.update(indicators).set({ status: "inactive" }).where(eq(indicators.value, "198.51.100.2"));
    await ctx.db.update(indicators).set({ excluded: true }).where(eq(indicators.value, "198.51.100.1"));

    const [a] = await ctx.db.insert(assets).values({ name: "자산A", target: "a.corp.example", importance: 3, scanLevel: 3, scanPermitted: true }).returning();
    await ctx.db.insert(assets).values({ name: "자산B", target: "b.corp.example", importance: 3, scanLevel: 3, scanPermitted: true, enabled: false });
    for (let i = 0; i < 7; i++) {
      await ctx.db.insert(notifications).values({ kind: "port_opened", assetId: a.id, message: `m${i}`, occurredAt: new Date(NOW.getTime() - i * H), read: i === 0 });
    }
    await ctx.db.insert(notifications).values({ kind: "asset_down", assetId: a.id, message: "old", occurredAt: new Date(NOW.getTime() - 30 * 24 * H) });

    const d = await getDashboard(ctx.db, NOW);
    expect(d.indicators).toMatchObject({ total: 3, active: 2, excluded: 1, new24h: 1, new7d: 2, byType: { ip: 1, domain: 1 } });
    const byName = Object.fromEntries(d.sources.map((s) => [s.name, s]));
    expect(byName["정상"]).toMatchObject({ lastStatus: "success", stale: false });
    expect(byName["지연"]).toMatchObject({ lastStatus: "fail", lastError: "HTTP 503", stale: true });
    expect(byName["꺼짐"]).toMatchObject({ lastStatus: null, stale: false });
    expect(off.enabled).toBe(false);
    expect(d.assets).toEqual({ total: 2, enabled: 1 });
    expect(d.notifications.unread).toBe(7); // m1..m6 + old
    expect(d.notifications.recent.map((n) => n.message)).toEqual(["m0", "m1", "m2", "m3", "m4"]);
  });
});
