import net from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auditLogs, domainIps, indicators, netRanges, sources, users } from "../db/schema";
import { saveIndicator } from "../lib/indicators";
import { writeAudit } from "../lib/audit";
import { checkPorts, cleanHost, dnsLookup, nextWhoisServer, parseHackerTarget, parsePorts, whoisLookup, type DnsQuery } from "../lib/tools";
import { countryOfIp, recentToolUses, reverseIp } from "../lib/tools-db";
import { createTestDb, resetData } from "./helpers/test-db";

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

describe("입력 확인", () => {
  it("호스트 정리", () => {
    expect(cleanHost("https://Example.com/path?x=1")?.host).toBe("example.com");
    expect(cleanHost("1.2.3.4")?.kind).toBe("ipv4");
    expect(cleanHost("[2001:db8::1]")?.kind).toBe("ipv6");
    expect(cleanHost("bad host")).toBeNull();
    expect(cleanHost("nodot")).toBeNull();
    expect(cleanHost("")).toBeNull();
  });
  it("포트 해석", () => {
    expect(parsePorts("80, 443 8000-8002")).toEqual({ ports: [80, 443, 8000, 8001, 8002] });
    expect("error" in parsePorts("0")).toBe(true);
    expect("error" in parsePorts("70000")).toBe(true);
    expect("error" in parsePorts("1-100")).toBe(true);
    expect("error" in parsePorts("abc")).toBe(true);
    expect("error" in parsePorts("")).toBe(true);
  });
});

describe("포트 체커", () => {
  it("사설·예약 주소는 거부", async () => {
    expect((await checkPorts("127.0.0.1", [80])).ok).toBe(false);
    expect((await checkPorts("10.0.0.5", [80])).ok).toBe(false);
    expect((await checkPorts("internal.example.com", [80], { lookup: async () => "192.168.1.1" })).ok).toBe(false);
  });
  it("열림/닫힘 구분 (시험용 허용)", async () => {
    const srv = net.createServer((s) => s.end());
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const open = (srv.address() as net.AddressInfo).port;
    const tmp = net.createServer();
    await new Promise<void>((r) => tmp.listen(0, "127.0.0.1", r));
    const closed = (tmp.address() as net.AddressInfo).port;
    await new Promise((r) => tmp.close(r));
    const r = await checkPorts("127.0.0.1", [open, closed].sort((a, b) => a - b), { allowPrivate: true, timeoutMs: 1000 });
    srv.close();
    const rows = Object.fromEntries(r.sections![0].rows!.map(([k, v]) => [Number(k.split(" ")[0]), v]));
    expect(rows[open]).toBe("열림");
    expect(rows[closed]).toContain("닫힘");
  });
});

describe("DNS 조회", () => {
  const q: DnsQuery = async (t) => {
    if (t === "A") return [{ address: "93.184.216.34", ttl: 300 }];
    if (t === "MX") return [{ exchange: "mx2.example.com", priority: 20 }, { exchange: "mx1.example.com", priority: 10 }];
    if (t === "TXT") return [["v=spf1 ", "-all"]];
    if (t === "PTR") return ["host.example.com"];
    const e = new Error("x") as Error & { code: string };
    e.code = "ENODATA";
    throw e;
  };
  it("기록별 결과", async () => {
    const r = await dnsLookup("example.com", "google", q);
    const by = Object.fromEntries(r.sections!.map((s) => [s.title, s]));
    expect(by["A 기록"].rows![0]).toEqual(["93.184.216.34", "TTL 300초"]);
    expect(by["MX 기록"].rows![0][0]).toBe("mx1.example.com");
    expect(by["TXT 기록"].items![0]).toBe("v=spf1 -all");
    expect(by["AAAA 기록"].items).toEqual(["기록 없음"]);
  });
  it("없는 도메인·IP(PTR)", async () => {
    const nx: DnsQuery = async () => {
      const e = new Error("x") as Error & { code: string };
      e.code = "ENOTFOUND";
      throw e;
    };
    expect((await dnsLookup("nope.example.com", "kt", nx)).ok).toBe(false);
    expect((await dnsLookup("8.8.8.8", "google", q)).sections![0].items).toEqual(["host.example.com"]);
    expect((await dnsLookup("bad host", "google", q)).ok).toBe(false);
  });
});

describe("WHOIS", () => {
  it("다음 서버 찾기", () => {
    expect(nextWhoisServer("refer:        whois.verisign-grs.com\n", "whois.iana.org")).toBe("whois.verisign-grs.com");
    expect(nextWhoisServer("Registrar WHOIS Server: whois.markmonitor.com", "whois.verisign-grs.com")).toBe("whois.markmonitor.com");
    expect(nextWhoisServer("refer: whois.iana.org", "whois.iana.org")).toBeNull();
    expect(nextWhoisServer("refer: 10.0.0.1; rm", "x.y")).toBeNull();
  });
  it("안내를 따라가 마지막 응답을 보여 줌", async () => {
    const io = async (server: string) => (server === "whois.iana.org" ? "refer: whois.a.com\n" : server === "whois.a.com" ? "Domain Name: EXAMPLE.COM\nRegistrar WHOIS Server: whois.b.com" : "Registrant: Foo");
    const r = await whoisLookup("example.com", io);
    expect(r.sections!.map((s) => s.title)).toEqual(["WHOIS 서버: whois.a.com", "WHOIS 서버: whois.b.com"]);
    expect(r.sections![1].text).toBe("Registrant: Foo");
  });
  it("접속 실패", async () => {
    expect((await whoisLookup("example.com", async () => { throw new Error("시간 초과"); })).ok).toBe(false);
  });
});

describe("Reverse IP", () => {
  it("외부 응답 해석", () => {
    expect(parseHackerTarget("a.example.com\nb.example.com\na.example.com")).toEqual({ domains: ["a.example.com", "b.example.com"] });
    expect("error" in parseHackerTarget("API count exceeded - Increase Quota")).toBe(true);
    expect(parseHackerTarget("No DNS A records found for 1.2.3.4")).toEqual({ domains: [] });
  });
  it("수집 도메인과 외부 결과를 함께", async () => {
    const [src] = await ctx.db.insert(sources).values({ name: "t", kind: "api", url: "https://x.example" }).returning();
    await saveIndicator(ctx.db, { raw: "evil.example.net", source: { id: src.id, name: src.name } });
    const [ind] = await ctx.db.select().from(indicators);
    await ctx.db.insert(domainIps).values({ indicatorId: ind.id, status: "ok", ip: "93.184.216.34", ipNum: 1572395042 });
    const r = await reverseIp(ctx.db, "example.com", { lookup: async () => "93.184.216.34", external: async () => ({ domains: ["x.example.org"] }) });
    expect(r.ok).toBe(true);
    const titles = r.sections!.map((s) => s.title).join("|");
    expect(titles).toContain("외부 서비스");
    expect(r.sections!.find((s) => s.title.startsWith("이 포털"))!.items).toContain("evil.example.net");
  });
  it("외부 실패해도 나머지는 보여 줌", async () => {
    const r = await reverseIp(ctx.db, "93.184.216.34", { external: async () => ({ error: "연결 실패" }) });
    expect(r.ok).toBe(true);
    expect(r.sections!.at(-1)!.items).toEqual(["연결 실패"]);
  });
});

describe("국가·사용 제한", () => {
  it("좁은 대역 우선", async () => {
    await ctx.db.insert(netRanges).values([
      { startNum: 0, endNum: 4294967295, countryCode: "US", netName: "넓음" },
      { startNum: 16909056, endNum: 16909311, countryCode: "KR", netName: "좁음" },
    ]);
    expect((await countryOfIp(ctx.db, "1.2.3.4"))?.countryCode).toBe("KR");
    expect(await countryOfIp(ctx.db, "x")).toBeNull();
  });
  it("최근 1분 사용 횟수", async () => {
    const [u] = await ctx.db.insert(users).values({ username: "t1", name: "t", passwordHash: "x", role: "viewer" } as never).returning();
    const now = new Date();
    await writeAudit(ctx.db, { userId: u.id, action: "tool_use", now });
    await writeAudit(ctx.db, { userId: u.id, action: "tool_use", now: new Date(now.getTime() - 120_000) });
    await writeAudit(ctx.db, { userId: u.id, action: "login_success", now });
    expect(await recentToolUses(ctx.db, u.id, now)).toBe(1);
    void auditLogs;
  });
});
