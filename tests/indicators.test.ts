import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { indicatorSources, indicators, sources } from "../db/schema";
import { expireIndicators, saveIndicator, type SourceRef } from "../lib/indicators";
import { createTestDb, resetData } from "./helpers/test-db";

/**
 * 시험 사례 표 (결과 → 기대)
 *  1. 새 지표 + 출처 1곳          → created, 지표 1건·출처 1건, 기관명 기록
 *  2. 같은 값을 다른 기관이 (표기만 다르게) → 한 건으로 합침, 출처 2건
 *  3. 같은 기관이 같은 값을 다시 → 출처 건수 그대로, 최종 확인 시각만 갱신
 *  4. 마지막 확인 89일 / 90일 / 91일 → 활성 / 활성 / 비활성
 *  5. 비활성 지표가 다시 수집됨   → 활성 복귀, 새 지표를 만들지 않음, 새 출처 추가
 *  6. 판별 불가 값                → invalid, 저장 안 됨
 *  7. 출처 이름이 비어 있음       → 오류, 저장 안 됨
 *  8. 사설 IP                     → excluded = true
 *  9. 해시                        → 해시 종류 기록
 * 10. 이미 확인된 시각보다 이전 시각으로 다시 수집 → 최종 확인 시각이 뒤로 가지 않음
 */
const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date("2026-06-01T00:00:00Z");

let ctx: Awaited<ReturnType<typeof createTestDb>>;
let kisa: SourceRef;
let abuse: SourceRef;

beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.client.close();
});
beforeEach(async () => {
  await resetData(ctx.client);
  const rows = await ctx.db
    .insert(sources)
    .values([
      { name: "KISA", kind: "api", url: "https://example.test/kisa" },
      { name: "AbuseIPDB", kind: "api", url: "https://example.test/abuse" },
    ])
    .returning();
  kisa = { id: rows[0].id, name: rows[0].name };
  abuse = { id: rows[1].id, name: rows[1].name };
});

const allIndicators = () => ctx.db.select().from(indicators);
const allSources = () => ctx.db.select().from(indicatorSources);

describe("saveIndicator", () => {
  it("새 지표를 저장하고 제공 기관명을 기록한다", async () => {
    const r = await saveIndicator(ctx.db, {
      raw: "Evil[.]com",
      source: kisa,
      refUrl: "https://example.test/post/1",
      now: T0,
    });
    expect(r.status).toBe("created");
    const [ind] = await allIndicators();
    expect(ind).toMatchObject({ type: "domain", value: "evil.com", status: "active" });
    const srcs = await allSources();
    expect(srcs).toHaveLength(1);
    expect(srcs[0]).toMatchObject({
      sourceName: "KISA",
      refUrl: "https://example.test/post/1",
    });
  });

  it("다른 기관이 같은 값을 보내면 한 건으로 합치고 출처를 추가한다", async () => {
    await saveIndicator(ctx.db, { raw: "evil.com", source: kisa, now: T0 });
    const r = await saveIndicator(ctx.db, {
      raw: "EVIL[.]COM.",
      source: abuse,
      now: new Date(T0.getTime() + DAY),
    });
    expect(r.status).toBe("updated");
    expect(await allIndicators()).toHaveLength(1);
    const names = (await allSources()).map((s) => s.sourceName).sort();
    expect(names).toEqual(["AbuseIPDB", "KISA"]);
  });

  it("같은 기관이 다시 보내면 출처를 늘리지 않고 최종 확인 시각만 갱신한다", async () => {
    await saveIndicator(ctx.db, { raw: "1.2.3.4", source: kisa, now: T0 });
    const later = new Date(T0.getTime() + 5 * DAY);
    await saveIndicator(ctx.db, { raw: "1.2.3.4", source: kisa, now: later });
    const srcs = await allSources();
    expect(srcs).toHaveLength(1);
    expect(srcs[0].firstSeenAt).toEqual(T0);
    expect(srcs[0].lastSeenAt).toEqual(later);
    const [ind] = await allIndicators();
    expect(ind.firstSeenAt).toEqual(T0);
    expect(ind.lastSeenAt).toEqual(later);
  });

  it("종류가 다르면 같은 문자열이어도 다른 지표다", async () => {
    await saveIndicator(ctx.db, { raw: "http://evil.com/", source: kisa, now: T0 });
    await saveIndicator(ctx.db, { raw: "evil.com", source: kisa, now: T0 });
    expect(await allIndicators()).toHaveLength(2);
  });

  it("판별할 수 없는 값은 저장하지 않는다", async () => {
    const r = await saveIndicator(ctx.db, { raw: "hello world", source: kisa, now: T0 });
    expect(r.status).toBe("invalid");
    expect(await allIndicators()).toHaveLength(0);
    expect(await allSources()).toHaveLength(0);
  });

  it("출처 이름이 없으면 오류를 내고 저장하지 않는다 [고정]", async () => {
    await expect(
      saveIndicator(ctx.db, { raw: "evil.com", source: { id: kisa.id, name: "  " }, now: T0 }),
    ).rejects.toThrow("출처");
    expect(await allIndicators()).toHaveLength(0);
  });

  it("사설 IP는 처음부터 제외 표시한다", async () => {
    await saveIndicator(ctx.db, { raw: "192.168.1.5", source: kisa, now: T0 });
    await saveIndicator(ctx.db, { raw: "8.8.8.8", source: kisa, now: T0 });
    const rows = await allIndicators();
    expect(rows.find((r) => r.value === "192.168.1.5")?.excluded).toBe(true);
    expect(rows.find((r) => r.value === "8.8.8.8")?.excluded).toBe(false);
  });

  it("해시는 해시 종류와 함께 저장한다", async () => {
    await saveIndicator(ctx.db, { raw: "A".repeat(64), source: kisa, now: T0 });
    const [ind] = await allIndicators();
    expect(ind).toMatchObject({ type: "hash", hashKind: "sha256", value: "a".repeat(64) });
  });

  it("더 이전 시각으로 다시 수집해도 최종 확인 시각이 뒤로 가지 않는다", async () => {
    const later = new Date(T0.getTime() + 10 * DAY);
    await saveIndicator(ctx.db, { raw: "evil.com", source: kisa, now: later });
    await saveIndicator(ctx.db, { raw: "evil.com", source: abuse, now: T0 });
    const [ind] = await allIndicators();
    expect(ind.lastSeenAt).toEqual(later);
  });
});

describe("expireIndicators", () => {
  it("90일을 넘긴 활성 지표만 비활성으로 바꾼다 (89일·90일은 활성, 91일은 비활성)", async () => {
    const now = new Date("2026-09-01T00:00:00Z");
    for (const [raw, days] of [
      ["a89.com", 89],
      ["a90.com", 90],
      ["a91.com", 91],
    ] as const) {
      await saveIndicator(ctx.db, {
        raw,
        source: kisa,
        now: new Date(now.getTime() - days * DAY),
      });
    }
    const changed = await expireIndicators(ctx.db, now);
    expect(changed).toBe(1);
    const byValue = Object.fromEntries(
      (await allIndicators()).map((r) => [r.value, r.status]),
    );
    expect(byValue).toEqual({
      "a89.com": "active",
      "a90.com": "active",
      "a91.com": "inactive",
    });
  });

  it("이미 비활성인 지표는 다시 세지 않는다", async () => {
    const now = new Date("2026-09-01T00:00:00Z");
    await saveIndicator(ctx.db, { raw: "old.com", source: kisa, now: new Date(now.getTime() - 200 * DAY) });
    expect(await expireIndicators(ctx.db, now)).toBe(1);
    expect(await expireIndicators(ctx.db, now)).toBe(0);
  });

  it("비활성 지표가 다시 수집되면 활성으로 돌아오고 새 지표를 만들지 않는다", async () => {
    const now = new Date("2026-09-01T00:00:00Z");
    await saveIndicator(ctx.db, { raw: "old.com", source: kisa, now: new Date(now.getTime() - 200 * DAY) });
    await expireIndicators(ctx.db, now);
    expect((await allIndicators())[0].status).toBe("inactive");

    const r = await saveIndicator(ctx.db, { raw: "old.com", source: abuse, now });
    expect(r.status).toBe("reactivated");
    const rows = await allIndicators();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("active");
    expect(rows[0].lastSeenAt).toEqual(now);
    expect((await allSources()).map((s) => s.sourceName).sort()).toEqual(["AbuseIPDB", "KISA"]);
  });

  it("출처가 삭제되어도 지표와 기관명 기록은 남는다", async () => {
    await saveIndicator(ctx.db, { raw: "evil.com", source: kisa, now: T0 });
    await ctx.db.delete(sources).where(eq(sources.id, kisa.id));
    const srcs = await allSources();
    expect(srcs).toHaveLength(1);
    expect(srcs[0]).toMatchObject({ sourceId: null, sourceName: "KISA" });
  });
});
