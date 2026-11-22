import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { indicatorSources, indicators, sources } from "../db/schema";
import { saveIndicator, saveIndicatorsBulk } from "../lib/indicators";
import { createTestDb, resetData } from "./helpers/test-db";

/**
 * 시험 사례 표 (많은 항목을 한꺼번에 저장)
 *  1. 새 항목        → 모두 생성, 출처 기관명 기록, 잘못된 값은 invalid로 세고 저장 안 함
 *  2. 묶음 나누기    → 묶음 크기보다 많아도 전부 저장
 *  3. 같은 값 중복   → 한 건으로 합침 (한 목록 안에서도, 이미 있는 값과도)
 *  4. 재수집         → updated로 세고 최초 확인일은 유지, 마지막 확인일은 뒤로 가지 않음
 *  5. 비활성 복귀    → 90일 지나 비활성이던 지표가 다시 수집되면 활성
 *  6. 여러 기관      → 다른 출처가 같은 값을 보내면 출처 목록이 늘어남
 *  7. 사설 IP        → 처음부터 SIEM 제외 표시
 *  8. 출처 필수      → 기관명이 없으면 오류
 */
let ctx: Awaited<ReturnType<typeof createTestDb>>;
const T1 = new Date("2026-11-20T00:00:00Z");
const T2 = new Date("2026-11-22T00:00:00Z");
let src: { id: string; name: string };
let src2: { id: string; name: string };
beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.client.close();
});
beforeEach(async () => {
  await resetData(ctx.client);
  const [a] = await ctx.db.insert(sources).values({ name: "기관A", kind: "api", url: "https://a.test" }).returning();
  const [b] = await ctx.db.insert(sources).values({ name: "기관B", kind: "api", url: "https://b.test" }).returning();
  src = { id: a.id, name: a.name };
  src2 = { id: b.id, name: b.name };
});

describe("saveIndicatorsBulk", () => {
  it("새 항목을 만들고 잘못된 값은 세기만 한다", async () => {
    const r = await saveIndicatorsBulk(ctx.db, { source: src, now: T1, items: [{ raw: "198.51.100.1" }, { raw: "bad.example" }, { raw: "!!not-an-indicator!!" }] });
    expect(r).toEqual({ created: 2, updated: 0, invalid: 1 });
    expect(await ctx.db.select().from(indicators)).toHaveLength(2);
    const links = await ctx.db.select().from(indicatorSources);
    expect(links.every((l) => l.sourceName === "기관A")).toBe(true);
    expect(links).toHaveLength(2);
  });

  it("묶음 크기보다 많아도 전부 저장한다", async () => {
    const items = Array.from({ length: 25 }, (_, i) => ({ raw: `d${i}.threat.example` }));
    const r = await saveIndicatorsBulk(ctx.db, { source: src, now: T1, items, chunkSize: 4 });
    expect(r.created).toBe(25);
    expect(await ctx.db.select().from(indicators)).toHaveLength(25);
  });

  it("같은 값은 목록 안에서도, 이미 있는 값과도 한 건으로 합친다", async () => {
    await saveIndicator(ctx.db, { raw: "dup.example", source: src, now: T1 });
    const r = await saveIndicatorsBulk(ctx.db, { source: src, now: T2, items: [{ raw: "dup.example" }, { raw: "DUP.example" }, { raw: "new.example" }, { raw: "new.example" }] });
    expect(r).toEqual({ created: 1, updated: 1, invalid: 0 });
    expect(await ctx.db.select().from(indicators)).toHaveLength(2);
  });

  it("재수집하면 최초 확인일은 유지하고 마지막 확인일은 뒤로 가지 않는다", async () => {
    await saveIndicatorsBulk(ctx.db, { source: src, now: T2, items: [{ raw: "a.example" }] });
    await saveIndicatorsBulk(ctx.db, { source: src, now: T1, items: [{ raw: "a.example" }] }); // 더 옛날 시각으로 다시
    const [i] = await ctx.db.select().from(indicators);
    expect(i.firstSeenAt.toISOString()).toBe(T2.toISOString());
    expect(i.lastSeenAt.toISOString()).toBe(T2.toISOString());
    await saveIndicatorsBulk(ctx.db, { source: src, now: new Date("2026-11-25T00:00:00Z"), items: [{ raw: "a.example" }] });
    expect((await ctx.db.select().from(indicators))[0].lastSeenAt.toISOString()).toBe("2026-11-25T00:00:00.000Z");
    expect(await ctx.db.select().from(indicatorSources)).toHaveLength(1);
  });

  it("비활성이던 지표가 다시 수집되면 활성이 된다", async () => {
    await saveIndicatorsBulk(ctx.db, { source: src, now: T1, items: [{ raw: "old.example" }] });
    await ctx.db.update(indicators).set({ status: "inactive" }).where(eq(indicators.value, "old.example"));
    await saveIndicatorsBulk(ctx.db, { source: src, now: T2, items: [{ raw: "old.example" }] });
    expect((await ctx.db.select().from(indicators))[0].status).toBe("active");
  });

  it("다른 기관이 같은 값을 보내면 출처 목록이 늘어난다", async () => {
    await saveIndicatorsBulk(ctx.db, { source: src, now: T1, items: [{ raw: "198.51.100.9", refUrl: "https://a.test/1" }] });
    await saveIndicatorsBulk(ctx.db, { source: src2, now: T2, items: [{ raw: "198.51.100.9", note: "봇넷" }] });
    expect(await ctx.db.select().from(indicators)).toHaveLength(1);
    const links = await ctx.db.select().from(indicatorSources);
    expect(links.map((l) => l.sourceName).sort()).toEqual(["기관A", "기관B"]);
    expect(links.find((l) => l.sourceName === "기관A")?.refUrl).toBe("https://a.test/1");
    expect(links.find((l) => l.sourceName === "기관B")?.note).toBe("봇넷");
  });

  it("사설 IP는 처음부터 SIEM 제외 표시", async () => {
    await saveIndicatorsBulk(ctx.db, { source: src, now: T1, items: [{ raw: "10.1.2.3" }, { raw: "198.51.100.2" }] });
    const rows = await ctx.db.select().from(indicators);
    expect(Object.fromEntries(rows.map((r) => [r.value, r.excluded]))).toEqual({ "10.1.2.3": true, "198.51.100.2": false });
  });

  it("기관명이 없으면 저장하지 않는다", async () => {
    await expect(saveIndicatorsBulk(ctx.db, { source: { id: src.id, name: " " }, items: [{ raw: "a.example" }] })).rejects.toThrow("출처");
  });

  it("빈 목록도 오류 없이 끝난다", async () => {
    expect(await saveIndicatorsBulk(ctx.db, { source: src, items: [] })).toEqual({ created: 0, updated: 0, invalid: 0 });
  });
});
