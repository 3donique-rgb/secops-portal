import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { indicators, sources } from "../db/schema";
import { saveIndicator } from "../lib/indicators";
import { isVtSupported, latestVerdicts, listReputations, lookupVirusTotal, saveReputation, verdictFromStats, vtGuiUrl } from "../lib/reputation";
import { createTestDb, resetData } from "./helpers/test-db";

let ctx: Awaited<ReturnType<typeof createTestDb>>;
let ipId: string;
let ip2Id: string;

beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.client.close();
});
beforeEach(async () => {
  await resetData(ctx.client);
  const [s] = await ctx.db.insert(sources).values({ name: "기관A", kind: "api", url: "https://a.test" }).returning();
  await saveIndicator(ctx.db, { raw: "198.51.100.9", source: { id: s.id, name: s.name } });
  await saveIndicator(ctx.db, { raw: "evil.example", source: { id: s.id, name: s.name } });
  const rows = await ctx.db.select().from(indicators);
  ipId = rows.find((r) => r.type === "ip")!.id;
  ip2Id = rows.find((r) => r.type === "domain")!.id;
});

const fakeFetch = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("VirusTotal 주소", () => {
  it("IP·도메인·해시는 종류별 화면 주소를 만든다", () => {
    expect(vtGuiUrl({ type: "ip", value: "1.2.3.4" })).toBe("https://www.virustotal.com/gui/ip-address/1.2.3.4");
    expect(vtGuiUrl({ type: "domain", value: "Evil.Example" })).toBe("https://www.virustotal.com/gui/domain/evil.example");
    const h = "a".repeat(64);
    expect(vtGuiUrl({ type: "hash", value: h })).toBe(`https://www.virustotal.com/gui/file/${h}`);
  });
  it("URL·메일·이상한 값은 만들지 않는다", () => {
    expect(vtGuiUrl({ type: "url", value: "http://x.test/a" })).toBeNull();
    expect(vtGuiUrl({ type: "email", value: "a@b.test" })).toBeNull();
    expect(vtGuiUrl({ type: "domain", value: "a.test/../../evil?x=1" })).toBeNull();
    expect(vtGuiUrl({ type: "hash", value: "xyz" })).toBeNull();
    expect(isVtSupported("url")).toBe(false);
    expect(isVtSupported("ip")).toBe(true);
  });
});

describe("판정 규칙", () => {
  const s = (m: number, su: number, h = 0, u = 0) => ({ malicious: m, suspicious: su, harmless: h, undetected: u, reputation: null });
  it("악성 3곳 이상은 악성, 1~2곳이나 의심은 의심, 나머지는 정상/미확인", () => {
    expect(verdictFromStats(s(3, 0))).toBe("malicious");
    expect(verdictFromStats(s(1, 0))).toBe("suspicious");
    expect(verdictFromStats(s(0, 2))).toBe("suspicious");
    expect(verdictFromStats(s(0, 0, 60, 10))).toBe("harmless");
    expect(verdictFromStats(s(0, 0))).toBe("unknown");
  });
});

describe("lookupVirusTotal", () => {
  it("키가 없으면 안내 메시지", async () => {
    const r = await lookupVirusTotal({ type: "ip", value: "1.2.3.4" }, undefined, fakeFetch(200, {}));
    expect(r.ok).toBe(false);
  });
  it("성공 응답을 집계와 판정으로 바꾼다", async () => {
    const body = { data: { attributes: { last_analysis_stats: { malicious: 5, suspicious: 1, harmless: 60, undetected: 20 }, reputation: -12 } } };
    const r = await lookupVirusTotal({ type: "ip", value: "1.2.3.4" }, "k", fakeFetch(200, body));
    expect(r).toEqual({ ok: true, verdict: "malicious", stats: { malicious: 5, suspicious: 1, harmless: 60, undetected: 20, reputation: -12 } });
  });
  it("키는 헤더로만 보내고 주소에 넣지 않는다", async () => {
    let seen: { url: string; key: string | undefined } = { url: "", key: undefined };
    const f = (async (u: string, init: RequestInit) => {
      seen = { url: u, key: (init.headers as Record<string, string>)["x-apikey"] };
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await lookupVirusTotal({ type: "domain", value: "evil.example" }, "SECRET", f);
    expect(seen.url).toBe("https://www.virustotal.com/api/v3/domains/evil.example");
    expect(seen.key).toBe("SECRET");
    expect(seen.url).not.toContain("SECRET");
  });
  it.each([
    [404, "등록되지"],
    [429, "한도"],
    [401, "거절"],
    [500, "HTTP 500"],
  ])("HTTP %i 는 알아보기 쉬운 메시지", async (status, word) => {
    const r = await lookupVirusTotal({ type: "ip", value: "1.2.3.4" }, "k", fakeFetch(status, {}));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain(word);
  });
  it("네트워크 오류도 메시지로", async () => {
    const f = (async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    const r = await lookupVirusTotal({ type: "ip", value: "1.2.3.4" }, "k", f);
    expect(r.ok).toBe(false);
  });
});

describe("평판 기록", () => {
  it("기록하고 최근 것이 위로 온다", async () => {
    await saveReputation(ctx.db, { indicatorId: ipId, verdict: "suspicious", note: "처음 확인" });
    await new Promise((r) => setTimeout(r, 5));
    await saveReputation(ctx.db, { indicatorId: ipId, verdict: "malicious", origin: "virustotal", stats: { malicious: 9, suspicious: 0, harmless: 50, undetected: 10, reputation: -3 } });
    const list = await listReputations(ctx.db, ipId);
    expect(list.map((x) => x.verdict)).toEqual(["malicious", "suspicious"]);
    expect(list[0].vtMalicious).toBe(9);
    expect(list[1].note).toBe("처음 확인");
  });
  it("잘못된 판정·너무 긴 메모·없는 지표는 거절", async () => {
    expect((await saveReputation(ctx.db, { indicatorId: ipId, verdict: "bad" })).ok).toBe(false);
    expect((await saveReputation(ctx.db, { indicatorId: ipId, verdict: "unknown", note: "x".repeat(1001) })).ok).toBe(false);
    expect((await saveReputation(ctx.db, { indicatorId: "00000000-0000-0000-0000-000000000000", verdict: "unknown" })).ok).toBe(false);
    expect(await listReputations(ctx.db, ipId)).toHaveLength(0);
  });
  it("목록용 최근 판정은 지표마다 가장 최근 것", async () => {
    await saveReputation(ctx.db, { indicatorId: ipId, verdict: "harmless" });
    await new Promise((r) => setTimeout(r, 5));
    await saveReputation(ctx.db, { indicatorId: ipId, verdict: "malicious" });
    await saveReputation(ctx.db, { indicatorId: ip2Id, verdict: "suspicious" });
    const m = await latestVerdicts(ctx.db, [ipId, ip2Id]);
    expect(m.get(ipId)).toBe("malicious");
    expect(m.get(ip2Id)).toBe("suspicious");
    expect((await latestVerdicts(ctx.db, [])).size).toBe(0);
  });
  it("지표를 지우면 기록도 함께 지워진다", async () => {
    await saveReputation(ctx.db, { indicatorId: ipId, verdict: "harmless" });
    await ctx.db.delete(indicators);
    expect(await ctx.client.query("select count(*)::int as n from indicator_reputations")).toMatchObject({ rows: [{ n: 0 }] });
  });
});
