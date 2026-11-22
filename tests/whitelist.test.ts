import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assets, indicators, whitelist } from "../db/schema";
import { canonicalCidr, ipInCidr, isValidCidr } from "../lib/cidr";
import { saveIndicator, type SourceRef } from "../lib/indicators";
import {
  addWhitelist,
  buildRules,
  isExcluded,
  listWhitelist,
  normalizeWhitelistValue,
  recomputeExcluded,
  removeWhitelist,
} from "../lib/whitelist";
import { sources } from "../db/schema";
import { createTestDb, resetData } from "./helpers/test-db";

/**
 * 시험 사례 표 (지표 → 제외 여부)
 *  규칙: 화이트리스트 IP 1.2.3.4, 대역 10.20.0.0/16 · 203.0.113.0/24 · 2001:db8::/32, 도메인 corp.com,
 *        우리 자산 portal.example.org / 198.51.100.7
 *  1.  1.2.3.4                      → 제외 (IP 일치)
 *  2.  1.2.3.5                      → 제외 아님
 *  3.  203.0.113.99                 → 제외 (대역 포함),  203.0.114.1 → 제외 아님
 *  4.  2001:db8::1                  → 제외 (IPv6 대역)
 *  5.  corp.com / a.b.corp.com      → 제외 (일치·하위 도메인),  notcorp.com → 제외 아님
 *  6.  http://www.corp.com/x        → 제외 (URL의 주소가 화이트리스트),  http://evil.com/corp.com → 제외 아님
 *  7.  admin@corp.com               → 제외 (이메일의 도메인)
 *  8.  portal.example.org / 198.51.100.7 → 제외 (우리 자산)
 *  9.  해시                         → 제외 아님
 * 10.  192.168.0.1 (사설 IP)        → 규칙이 비어 있어도 제외
 */
const rules = buildRules(
  [
    { type: "ip", value: "1.2.3.4" },
    { type: "cidr", value: "10.20.0.0/16" },
    { type: "cidr", value: "203.0.113.0/24" },
    { type: "cidr", value: "2001:db8::/32" },
    { type: "domain", value: "corp.com" },
  ],
  ["portal.example.org", "198.51.100.7"],
);

const ex = (type: string, value: string) => isExcluded({ type, value }, rules);

describe("isExcluded (순수 판정)", () => {
  it("IP 일치만 제외한다", () => {
    expect(ex("ip", "1.2.3.4")).toBe(true);
    expect(ex("ip", "1.2.3.5")).toBe(false);
  });

  it("CIDR 대역에 포함된 IP를 제외한다", () => {
    expect(ex("ip", "203.0.113.99")).toBe(true);
    expect(ex("ip", "203.0.114.1")).toBe(false);
    // 대역 경계: 마지막 주소는 포함, 바로 아래 대역은 제외 아님
    expect(ex("ip", "203.0.113.255")).toBe(true);
    expect(ex("ip", "203.0.113.0")).toBe(true);
    expect(ex("ip", "203.0.112.255")).toBe(false);
    // 사설 대역(10.20.0.0/16)에 속한 주소는 화이트리스트와 사설 규칙 양쪽에서 제외
    expect(ex("ip", "10.20.255.255")).toBe(true);
  });

  it("IPv6 대역도 지원한다", () => {
    expect(ex("ip", "2001:db8::1")).toBe(true);
    expect(ex("ip", "2001:db9::1")).toBe(false);
  });

  it("도메인은 일치·하위 도메인만 제외하고, 이름이 비슷한 도메인은 제외하지 않는다", () => {
    expect(ex("domain", "corp.com")).toBe(true);
    expect(ex("domain", "a.b.corp.com")).toBe(true);
    expect(ex("domain", "notcorp.com")).toBe(false);
    expect(ex("domain", "corp.com.evil.net")).toBe(false);
  });

  it("URL은 주소 부분, 이메일은 도메인 부분으로 판정한다", () => {
    expect(ex("url", "http://www.corp.com/x")).toBe(true);
    expect(ex("url", "http://evil.com/corp.com")).toBe(false);
    expect(ex("url", "http://1.2.3.4:8080/a")).toBe(true);
    expect(ex("email", "admin@corp.com")).toBe(true);
    expect(ex("email", "admin@evil.com")).toBe(false);
  });

  it("등록된 우리 자산(도메인·IP)과 일치하면 제외한다", () => {
    expect(ex("domain", "portal.example.org")).toBe(true);
    expect(ex("domain", "x.portal.example.org")).toBe(true);
    expect(ex("domain", "example.org")).toBe(false);
    expect(ex("ip", "198.51.100.7")).toBe(true);
  });

  it("해시는 제외하지 않는다", () => {
    expect(ex("hash", "a".repeat(64))).toBe(false);
  });

  it("사설·예약 대역 IP는 규칙이 비어 있어도 제외한다", () => {
    const empty = buildRules([], []);
    expect(isExcluded({ type: "ip", value: "192.168.0.1" }, empty)).toBe(true);
    expect(isExcluded({ type: "url", value: "http://127.0.0.1/x" }, empty)).toBe(true);
    expect(isExcluded({ type: "ip", value: "8.8.8.8" }, empty)).toBe(false);
  });
});

describe("cidr", () => {
  it("대역 포함 여부를 판단한다", () => {
    expect(ipInCidr("192.168.1.77", "192.168.1.0/24")).toBe(true);
    expect(ipInCidr("192.168.2.1", "192.168.1.0/24")).toBe(false);
    expect(ipInCidr("1.2.3.4", "1.2.3.4")).toBe(true); // 단일 IP는 /32
    expect(ipInCidr("1.2.3.4", "0.0.0.0/0")).toBe(true);
    expect(ipInCidr("1.2.3.4", "2001:db8::/32")).toBe(false); // IPv4와 IPv6는 섞이지 않음
    expect(ipInCidr("::ffff:1.2.3.4", "::ffff:0:0/96")).toBe(true);
  });

  it("잘못된 대역은 거부한다", () => {
    for (const bad of ["1.2.3.4/33", "1.2.3/24", "abc", "1.2.3.4/", "1.2.3.4/24/1", "::1/129", ""]) {
      expect(isValidCidr(bad), bad).toBe(false);
    }
  });

  it("표준 표기로 바꾼다", () => {
    expect(canonicalCidr("1.2.3.4")).toBe("1.2.3.4/32");
    expect(canonicalCidr("1.2.3.4/24")).toBe("1.2.3.0/24");
    expect(canonicalCidr("2001:0db8:0:0:0:0:0:0/32")).toBe("2001:db8::/32");
    expect(canonicalCidr("::/0")).toBe("::/0");
  });
});

describe("normalizeWhitelistValue", () => {
  it("저장 형식으로 정리하고 잘못된 값은 null이다", () => {
    expect(normalizeWhitelistValue("cidr", "10.0.0.7/8")).toBe("10.0.0.0/8");
    expect(normalizeWhitelistValue("domain", "Corp[.]COM.")).toBe("corp.com");
    expect(normalizeWhitelistValue("ip", " 1.2.3[.]4 ")).toBe("1.2.3.4");
    expect(normalizeWhitelistValue("ip", "corp.com")).toBeNull();
    expect(normalizeWhitelistValue("domain", "1.2.3.4")).toBeNull();
    expect(normalizeWhitelistValue("cidr", "hello")).toBeNull();
    expect(normalizeWhitelistValue("domain", "")).toBeNull();
  });
});

describe("recomputeExcluded (DB 전체 재계산)", () => {
  let ctx: Awaited<ReturnType<typeof createTestDb>>;
  let src: SourceRef;

  beforeAll(async () => {
    ctx = await createTestDb();
  });
  afterAll(async () => {
    await ctx.client.close();
  });
  beforeEach(async () => {
    await resetData(ctx.client);
    const [s] = await ctx.db
      .insert(sources)
      .values({ name: "KISA", kind: "api", url: "https://example.test" })
      .returning();
    src = { id: s.id, name: s.name };
    for (const raw of ["1.2.3.4", "8.8.8.8", "a.corp.com", "evil.com", "192.168.0.9"]) {
      await saveIndicator(ctx.db, { raw, source: src });
    }
  });

  const excludedValues = async () =>
    (await ctx.db.select().from(indicators))
      .filter((r) => r.excluded)
      .map((r) => r.value)
      .sort();

  it("처음에는 사설 IP만 제외되어 있다", async () => {
    expect(await excludedValues()).toEqual(["192.168.0.9"]);
  });

  it("화이트리스트를 추가하면 새로 제외하고, 삭제하면 제외를 푼다 (사설 IP는 유지)", async () => {
    await ctx.db.insert(whitelist).values([
      { type: "ip", value: "1.2.3.4" },
      { type: "domain", value: "corp.com" },
    ]);
    expect(await recomputeExcluded(ctx.db)).toEqual({ excluded: 2, included: 0 });
    expect(await excludedValues()).toEqual(["1.2.3.4", "192.168.0.9", "a.corp.com"]);

    await ctx.db.delete(whitelist);
    expect(await recomputeExcluded(ctx.db)).toEqual({ excluded: 0, included: 2 });
    expect(await excludedValues()).toEqual(["192.168.0.9"]);
  });

  it("우리 자산을 등록하면 같은 도메인·IP의 지표가 제외된다", async () => {
    await ctx.db.insert(assets).values({
      name: "홈페이지",
      target: "evil.com",
      scanPermitted: true,
    });
    await recomputeExcluded(ctx.db);
    expect(await excludedValues()).toEqual(["192.168.0.9", "evil.com"]);
  });

  it("바뀐 것이 없으면 0건이다", async () => {
    expect(await recomputeExcluded(ctx.db)).toEqual({ excluded: 0, included: 0 });
  });
});

describe("화이트리스트 추가·삭제 (관리자 화면)", () => {
  let ctx: Awaited<ReturnType<typeof createTestDb>>;
  beforeAll(async () => {
    ctx = await createTestDb();
  });
  afterAll(async () => {
    await ctx.client.close();
  });
  beforeEach(async () => {
    await resetData(ctx.client);
  });

  it("추가하면 일치하는 지표가 바로 제외되고, 삭제하면 다시 제공 대상이 된다 (지표는 지워지지 않음)", async () => {
    const [src] = await ctx.db.insert(sources).values({ name: "T기관", kind: "api", url: "https://t.test" }).returning();
    for (const raw of ["198.51.100.7", "a.corp.example", "evil.test"]) {
      await saveIndicator(ctx.db, { raw, source: { id: src.id, name: src.name } });
    }
    const r = await addWhitelist(ctx.db, { type: "domain", value: " CORP.Example ", reason: "자사" });
    expect(r).toMatchObject({ ok: true, value: "corp.example", excluded: 1 });
    const c = await addWhitelist(ctx.db, { type: "cidr", value: "198.51.100.0/24" });
    expect(c).toMatchObject({ ok: true, excluded: 1 });
    const rows = await ctx.db.select({ value: indicators.value, excluded: indicators.excluded }).from(indicators);
    expect(Object.fromEntries(rows.map((x) => [x.value, x.excluded]))).toEqual({
      "198.51.100.7": true, "a.corp.example": true, "evil.test": false,
    });

    const list = await listWhitelist(ctx.db);
    const del = await removeWhitelist(ctx.db, list.find((w) => w.type === "domain")!.id);
    expect(del).toMatchObject({ ok: true, included: 1 });
    expect(await ctx.db.select().from(indicators)).toHaveLength(3);
    expect((await removeWhitelist(ctx.db, "00000000-0000-0000-0000-000000000000")).ok).toBe(false);
  });

  it("잘못된 값·중복·모르는 종류는 거부한다", async () => {
    expect((await addWhitelist(ctx.db, { type: "ip", value: "not-an-ip" })).ok).toBe(false);
    expect((await addWhitelist(ctx.db, { type: "cidr", value: "1.2.3.4/40" })).ok).toBe(false);
    expect((await addWhitelist(ctx.db, { type: "domain", value: "http://x" })).ok).toBe(false);
    expect((await addWhitelist(ctx.db, { type: "email", value: "a@b.c" })).ok).toBe(false);
    expect((await addWhitelist(ctx.db, { type: "ip", value: "203.0.113.9" })).ok).toBe(true);
    expect((await addWhitelist(ctx.db, { type: "ip", value: "203.0.113.9" })).ok).toBe(false);
    expect(await listWhitelist(ctx.db)).toHaveLength(1);
  });
});
