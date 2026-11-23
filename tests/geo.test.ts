import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { domainIps, indicators, netRanges, sources } from "../db/schema";
import { cleanCountry, geoForIndicators, ipv4ToNum, lookupRdap, numToIpv4, parseRdap } from "../lib/geo";
import { saveIndicator } from "../lib/indicators";
import { parseDelegated } from "../lib/delegated";
import { runEnrich } from "../worker/enrich/run";
import { createTestDb, resetData } from "./helpers/test-db";

let ctx: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.client.close();
});

describe("IP 숫자 변환·응답 해석", () => {
  it("IPv4 ↔ 숫자", () => {
    expect(ipv4ToNum("0.0.0.1")).toBe(1);
    expect(ipv4ToNum("1.2.3.4")).toBe(16909060);
    expect(numToIpv4(16909060)).toBe("1.2.3.4");
    expect(ipv4ToNum("256.1.1.1")).toBeNull();
    expect(ipv4ToNum("2001:db8::1")).toBeNull();
    expect(ipv4ToNum("a.b.c.d")).toBeNull();
  });
  it("국가 코드는 두 글자 영문만", () => {
    expect(cleanCountry("kr")).toBe("KR");
    expect(cleanCountry("ZZ")).toBeNull();
    expect(cleanCountry("KOR")).toBeNull();
    expect(cleanCountry(5)).toBeNull();
  });
  it("RIPE·APNIC 형식: network.country 사용", () => {
    expect(parseRdap({ startAddress: "58.0.0.0", endAddress: "58.255.255.255", name: "KRNIC-NET", country: "KR" })).toEqual({ startNum: 58 * 16777216, endNum: 58 * 16777216 + 16777215, countryCode: "KR", netName: "KRNIC-NET" });
  });
  it("ARIN 형식: 등록 기관 주소의 마지막 줄에서 국가를 찾는다", () => {
    const body = {
      startAddress: "8.8.8.0",
      endAddress: "8.8.8.255",
      name: "LVLT-GOGL-8-8-8",
      entities: [{ vcardArray: ["vcard", [["adr", { label: "1600 Amphitheatre Parkway\nMountain View\nCA\n94043\nUnited States" }, "text", []]]] }],
    };
    expect(parseRdap(body)?.countryCode).toBe("US");
  });
  it("망가진 응답은 null", () => {
    expect(parseRdap(null)).toBeNull();
    expect(parseRdap({ startAddress: "2001:db8::", endAddress: "2001:db8::ff" })).toBeNull();
    expect(parseRdap({ startAddress: "1.1.1.9", endAddress: "1.1.1.1" })).toBeNull();
  });
});

const rdapFetch = (handler: (u: string) => { status: number; body?: unknown }) =>
  (async (u: string) => {
    const r = handler(u);
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
  }) as unknown as typeof fetch;

describe("lookupRdap", () => {
  it("정상·없음·한도·오류", async () => {
    const good = { startAddress: "58.0.0.0", endAddress: "58.255.255.255", country: "KR" };
    expect((await lookupRdap("58.1.2.3", rdapFetch(() => ({ status: 200, body: good })))).ok).toBe(true);
    expect(await lookupRdap("58.1.2.3", rdapFetch(() => ({ status: 404 })))).toEqual({ ok: false, code: "not_found" });
    expect(await lookupRdap("58.1.2.3", rdapFetch(() => ({ status: 429 })))).toEqual({ ok: false, code: "rate_limit" });
    expect(await lookupRdap("58.1.2.3", rdapFetch(() => ({ status: 500 })))).toEqual({ ok: false, code: "error" });
    expect(await lookupRdap("not-ip")).toEqual({ ok: false, code: "bad_ip" });
  });
});

describe("RIR 국가 목록 해석", () => {
  const sample = [
    "2|apnic|20261122|3|19830613|20261121|+1000",
    "apnic|*|ipv4|*|2|summary",
    "apnic|KR|ipv4|58.120.0.0|131072|20080101|allocated",
    "apnic|JP|ipv4|133.0.0.0|65536|20100101|assigned",
    "apnic|AU|ipv4|1.0.0.0|256|20100101|reserved",
    "apnic|KR|ipv6|2001:db8::|32|20100101|allocated",
    "apnic|KR|asn|4766|1|20100101|allocated",
    "# 주석",
    "apnic|ZZ|ipv4|9.0.0.0|256|20100101|allocated",
    "apnic|KR|ipv4|300.0.0.0|256|20100101|allocated",
  ].join("\n");
  it("IPv4 할당 줄만 대역으로 바꾼다", () => {
    const r = parseDelegated(sample);
    expect(r).toEqual([
      { startNum: ipv4ToNum("58.120.0.0"), endNum: ipv4ToNum("58.120.0.0")! + 131071, countryCode: "KR" },
      { startNum: ipv4ToNum("133.0.0.0"), endNum: ipv4ToNum("133.0.0.0")! + 65535, countryCode: "JP" },
    ]);
  });
});

describe("도메인 IP·국가 채우기", () => {
  beforeEach(async () => {
    await resetData(ctx.client);
    const [s] = await ctx.db.insert(sources).values({ name: "기관A", kind: "api", url: "https://a.test" }).returning();
    const src = { id: s.id, name: s.name };
    for (const raw of ["a.example", "b.example", "gone.example", "58.9.9.9", "http://x.example/p"]) await saveIndicator(ctx.db, { raw, source: src });
  });
  const dnsMap: Record<string, string[]> = { "a.example": ["58.1.1.1"], "b.example": ["58.200.1.1"], "gone.example": [] };
  const resolve4 = async (d: string) => {
    if (!dnsMap[d]?.length) throw new Error("ENOTFOUND");
    return dnsMap[d];
  };
  const good = { startAddress: "58.0.0.0", endAddress: "58.255.255.255", name: "KRNIC-NET", country: "KR" };

  it("도메인 IP를 찾고, 같은 대역은 RDAP 한 번만 조회한다", async () => {
    let calls = 0;
    const r = await runEnrich(ctx.db, { rdapDelayMs: 0, delegated: false, resolve4, rdapConcurrency: 1, fetchImpl: rdapFetch(() => (calls++, { status: 200, body: good })) });
    expect(r).toMatchObject({ resolved: 2, unresolved: 1 });
    expect(calls).toBe(1); // a.example, b.example, 58.9.9.9 모두 58.0.0.0/8
    const rows = await ctx.db.select().from(indicators);
    const id = (v: string) => rows.find((x) => x.value === v)!.id;
    const m = await geoForIndicators(ctx.db, rows);
    expect(m.get(id("a.example"))).toMatchObject({ ip: "58.1.1.1", state: "ok", countryCode: "KR", netName: "KRNIC-NET" });
    expect(m.get(id("b.example"))).toMatchObject({ ip: "58.200.1.1", countryCode: "KR" });
    expect(m.get(id("58.9.9.9"))).toMatchObject({ ip: "58.9.9.9", countryCode: "KR" });
    expect(m.get(id("gone.example"))).toMatchObject({ state: "unresolved", ip: null });
    expect(m.get(id("http://x.example/p"))).toMatchObject({ state: "none" });
  });

  it("아직 확인하지 않은 도메인은 '대기'로 나온다", async () => {
    const rows = await ctx.db.select().from(indicators);
    const m = await geoForIndicators(ctx.db, rows);
    expect(m.get(rows.find((x) => x.value === "a.example")!.id)?.state).toBe("pending");
  });

  it("두 번째 실행은 다시 조회하지 않는다 (DNS 7일·30일 재확인 전)", async () => {
    await runEnrich(ctx.db, { rdapDelayMs: 0, delegated: false, resolve4, fetchImpl: rdapFetch(() => ({ status: 200, body: good })) });
    let dnsCalls = 0;
    let rdapCalls = 0;
    const r = await runEnrich(ctx.db, { rdapDelayMs: 0, delegated: false, resolve4: async (d) => (dnsCalls++, resolve4(d)), fetchImpl: rdapFetch(() => (rdapCalls++, { status: 200, body: good })) });
    expect(r.resolved + r.unresolved).toBe(0);
    expect(dnsCalls + rdapCalls).toBe(0);
  });

  it("못 찾은 도메인은 7일 뒤 다시 확인한다", async () => {
    await runEnrich(ctx.db, { rdapDelayMs: 0, delegated: false, resolve4, fetchImpl: rdapFetch(() => ({ status: 200, body: good })) });
    dnsMap["gone.example"] = ["58.5.5.5"];
    try {
      const r = await runEnrich(ctx.db, { rdapDelayMs: 0, delegated: false, resolve4, now: new Date(Date.now() + 8 * 86400_000), fetchImpl: rdapFetch(() => ({ status: 200, body: good })) });
      expect(r.resolved).toBe(1);
    } finally {
      dnsMap["gone.example"] = [];
    }
  });

  it("RDAP 한도(429)면 멈추고, 다음 실행에서 이어간다", async () => {
    const r = await runEnrich(ctx.db, { rdapDelayMs: 0, delegated: false, resolve4, rdapConcurrency: 1, fetchImpl: rdapFetch(() => ({ status: 429 })) });
    expect(r.stopped).toContain("한도");
    expect(await ctx.db.select().from(netRanges)).toHaveLength(0);
    const r2 = await runEnrich(ctx.db, { rdapDelayMs: 0, delegated: false, resolve4, fetchImpl: rdapFetch(() => ({ status: 200, body: good })) });
    expect(r2.ranges).toBeGreaterThan(0);
  });

  it("사설·예약 IP는 조회하지 않는다", async () => {
    let calls = 0;
    await runEnrich(ctx.db, { rdapDelayMs: 0, delegated: false, resolve4: async () => ["10.0.0.5"], rdapConcurrency: 1, fetchImpl: rdapFetch(() => (calls++, { status: 200, body: good })) });
    expect(calls).toBe(1); // 58.9.9.9(IP 위협정보)만 조회
    const rows = await ctx.db.select().from(domainIps);
    expect(rows.every((x) => x.ip === "10.0.0.5" || x.ip === null)).toBe(true);
  });

  it("더 좁은 대역이 있으면 그것을 우선한다", async () => {
    await ctx.db.insert(netRanges).values([
      { startNum: 58 * 16777216, endNum: 58 * 16777216 + 16777215, countryCode: "KR", netName: "큰 대역" },
      { startNum: 58 * 16777216 + 65536, endNum: 58 * 16777216 + 65536 + 255, countryCode: "JP", netName: "작은 대역" },
    ]);
    const [s] = await ctx.db.select().from(sources).limit(1);
    await saveIndicator(ctx.db, { raw: "58.1.0.7", source: { id: s.id, name: s.name } });
    const row = (await ctx.db.select().from(indicators)).find((x) => x.value === "58.1.0.7")!;
    const m = await geoForIndicators(ctx.db, [row]);
    expect(m.get(row.id)).toMatchObject({ countryCode: "JP", netName: "작은 대역" });
  });

  it("RIR 국가 목록으로 RDAP 없이 국가를 채운다", async () => {
    const lines = ["apnic|KR|ipv4|58.0.0.0|16777216|20080101|allocated"];
    for (let i = 0; i < 120; i++) lines.push(`apnic|JP|ipv4|133.${i}.0.0|65536|20100101|allocated`);
    let rdap = 0;
    const f = (async (u: string) => {
      if (u.includes("rdap.org")) {
        rdap++;
        return new Response("{}", { status: 404 });
      }
      return new Response(u.includes("apnic") ? lines.join("\n") : "", { status: 200 });
    }) as unknown as typeof fetch;
    const r = await runEnrich(ctx.db, { resolve4, fetchImpl: f, rdapDelayMs: 0 });
    expect(r.delegatedRanges).toBe(121);
    expect(rdap).toBe(0);
    const rows = await ctx.db.select().from(indicators);
    const m = await geoForIndicators(ctx.db, rows);
    expect(m.get(rows.find((x) => x.value === "a.example")!.id)).toMatchObject({ countryCode: "KR", netName: "APNIC 할당 대역" });
    // 14일 안에는 다시 받지 않는다
    let downloads = 0;
    const g = (async (u: string) => (u.includes("rdap.org") ? new Response("{}", { status: 404 }) : (downloads++, new Response(""))) ) as unknown as typeof fetch;
    await runEnrich(ctx.db, { resolve4, fetchImpl: g, rdapDelayMs: 0, delegatedMaxAgeDays: 14 });
    expect(downloads).toBe(4); // 목록이 비어 있던 나머지 4곳만 시도 (APNIC은 최신이라 건너뜀)
  });

  it("너무 짧거나 이상한 목록은 받아도 기존 데이터를 지우지 않는다", async () => {
    await ctx.db.insert(netRanges).values({ startNum: 1, endNum: 2, countryCode: "KR", netName: "APNIC 할당 대역" });
    const f = (async () => new Response("apnic|KR|ipv4|58.0.0.0|256|20080101|allocated", { status: 200 })) as unknown as typeof fetch;
    await runEnrich(ctx.db, { resolve4, fetchImpl: f, rdapDelayMs: 0, delegatedMaxAgeDays: 0 });
    expect((await ctx.db.select().from(netRanges)).some((x) => x.startNum === 1)).toBe(true);
  });
});
