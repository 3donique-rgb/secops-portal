import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, isNotNull, sql } from "drizzle-orm";
import { assets, indicatorSources, indicators, sources, users } from "../db/schema";
import { verifyCredentials } from "../lib/auth";
import { expireIndicators, saveIndicator } from "../lib/indicators";
import { DEMO_MARK, clearDemo, seedAdmin, seedDemo } from "../lib/seed";
import { createTestDb, resetData } from "./helpers/test-db";

/**
 * 시험 사례 표
 *  1. 가짜 데이터 넣기           → 출처 3, 지표 50, 자산 10, 모든 지표에 출처 기관명·DEMO 표시
 *  2. 두 번 실행                 → 중복 없음 (지표 50, 자산 10 그대로)
 *  3. 만료 시험용 데이터         → 90일이 지난 지표가 일부 있고, 만료 처리하면 비활성이 됨
 *  4. 여러 기관이 보낸 지표      → 일부는 출처가 2개
 *  5. 가짜 데이터 지우기         → 데모만 삭제, 실제 데이터는 유지
 *  6. 관리자 생성                → 관리자 권한, 비밀번호는 해시, OTP 미등록, 로그인 가능
 *  7. 같은 아이디로 다시 실행    → 변경 없음 (비밀번호 해시 그대로)
 *  8. 잘못된 아이디·짧은 비밀번호 → invalid, 생성 안 됨
 */
let ctx: Awaited<ReturnType<typeof createTestDb>>;
const NOW = new Date("2026-11-22T00:00:00Z");

beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.client.close();
});
beforeEach(async () => {
  await resetData(ctx.client);
});

describe("seedDemo", () => {
  it("출처 3개, 지표 50건, 자산 10개를 넣고 모든 지표에 기관명이 기록된다", async () => {
    const r = await seedDemo(ctx.db, NOW);
    expect(r).toEqual({ sources: 3, indicators: 50, assets: 10, excluded: 0 });

    const inds = await ctx.db.select().from(indicators);
    expect(inds).toHaveLength(50);
    expect(inds.every((i) => i.memo === DEMO_MARK)).toBe(true);
    const types = inds.reduce<Record<string, number>>((acc, i) => ((acc[i.type] = (acc[i.type] ?? 0) + 1), acc), {});
    expect(types).toEqual({ ip: 20, domain: 12, url: 8, hash: 6, email: 4 });

    const withSource = await ctx.db.select({ id: indicatorSources.indicatorId }).from(indicatorSources);
    expect(new Set(withSource.map((s) => s.id)).size).toBe(50);
    const names = await ctx.db.select({ n: indicatorSources.sourceName }).from(indicatorSources);
    expect(names.every((x) => x.n.startsWith("데모기관"))).toBe(true);

    expect(await ctx.db.select().from(assets)).toHaveLength(10);
  });

  it("실제 값처럼 보이는 것이 없다 (문서용 예약 주소·example/test 도메인만 사용)", async () => {
    await seedDemo(ctx.db, NOW);
    const inds = await ctx.db.select().from(indicators);
    for (const i of inds.filter((x) => x.type === "ip")) {
      expect(/^(198\.51\.100|203\.0\.113|192\.0\.2)\./.test(i.value), i.value).toBe(true);
    }
    for (const i of inds.filter((x) => ["domain", "url", "email"].includes(x.type))) {
      expect(/\.(example|test)(\/|$)/.test(i.value) || /\.example\//.test(i.value), i.value).toBe(true);
    }
  });

  it("두 번 실행해도 중복되지 않는다", async () => {
    await seedDemo(ctx.db, NOW);
    const second = await seedDemo(ctx.db, NOW);
    expect(second.assets).toBe(0);
    expect(await ctx.db.select().from(indicators)).toHaveLength(50);
    expect(await ctx.db.select().from(assets)).toHaveLength(10);
    expect(await ctx.db.select().from(sources)).toHaveLength(3);
  });

  it("90일이 지난 지표가 섞여 있어 만료 처리를 시험할 수 있다", async () => {
    await seedDemo(ctx.db, NOW);
    const changed = await expireIndicators(ctx.db, NOW);
    expect(changed).toBeGreaterThan(0);
    expect(changed).toBeLessThan(50);
    const inactive = await ctx.db.select().from(indicators).where(eq(indicators.status, "inactive"));
    expect(inactive).toHaveLength(changed);
  });

  it("일부 지표는 두 기관에서 동시에 들어온 것으로 만들어져 있다", async () => {
    await seedDemo(ctx.db, NOW);
    const multi = await ctx.db
      .select({ id: indicatorSources.indicatorId })
      .from(indicatorSources)
      .groupBy(indicatorSources.indicatorId)
      .having(sql`count(*) > 1`);
    expect(multi.length).toBeGreaterThan(0);
  });
});

describe("clearDemo", () => {
  it("가짜 데이터만 지우고 실제 데이터는 유지한다", async () => {
    const [real] = await ctx.db.insert(sources).values({ name: "실제기관", kind: "api", url: "https://real.test" }).returning();
    await saveIndicator(ctx.db, { raw: "real-threat.com", source: { id: real.id, name: real.name }, now: NOW });
    await ctx.db.insert(assets).values({ name: "실제 자산", target: "www.real-corp.com", scanPermitted: true });
    await seedDemo(ctx.db, NOW);

    const r = await clearDemo(ctx.db);
    expect(r).toEqual({ indicators: 50, assets: 10, sources: 3 });

    expect((await ctx.db.select().from(indicators)).map((i) => i.value)).toEqual(["real-threat.com"]);
    expect((await ctx.db.select().from(assets)).map((a) => a.name)).toEqual(["실제 자산"]);
    expect((await ctx.db.select().from(sources)).map((s) => s.name)).toEqual(["실제기관"]);
    expect(await ctx.db.select().from(indicators).where(isNotNull(indicators.memo))).toHaveLength(0);
  });
});

describe("seedAdmin", () => {
  it("관리자 계정을 만든다 (비밀번호는 해시로만 저장, OTP는 미등록)", async () => {
    const r = await seedAdmin(ctx.db, { username: "boss", password: "initial-password-1" });
    expect(r).toEqual({ status: "created", username: "boss" });
    const [u] = await ctx.db.select().from(users).where(eq(users.username, "boss"));
    expect(u).toMatchObject({ role: "admin", otpEnabled: false, otpSecretEnc: null, locked: false, failedCount: 0 });
    expect(u.passwordHash).not.toContain("initial-password-1");
    expect(u.passwordHash.startsWith("$argon2id$")).toBe(true);
    expect((await verifyCredentials(ctx.db, "boss", "initial-password-1")).ok).toBe(true);
  });

  it("같은 아이디로 다시 실행해도 아무것도 바꾸지 않는다", async () => {
    await seedAdmin(ctx.db, { username: "boss", password: "initial-password-1" });
    const [before] = await ctx.db.select().from(users);
    const r = await seedAdmin(ctx.db, { username: "boss", password: "another-password-2" });
    expect(r).toEqual({ status: "exists", username: "boss" });
    const [after] = await ctx.db.select().from(users);
    expect(after.passwordHash).toBe(before.passwordHash);
    expect((await verifyCredentials(ctx.db, "boss", "another-password-2")).ok).toBe(false);
  });

  it("잘못된 아이디나 짧은 비밀번호는 만들지 않는다", async () => {
    for (const input of [
      { username: "a", password: "initial-password-1" },
      { username: "bad name!", password: "initial-password-1" },
      { username: "boss", password: "short" },
      { username: "boss", password: "" },
    ]) {
      expect((await seedAdmin(ctx.db, input)).status, JSON.stringify(input.username)).toBe("invalid");
    }
    expect(await ctx.db.select().from(users)).toHaveLength(0);
  });
});
