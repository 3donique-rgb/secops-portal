import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { indicators, sources } from "../db/schema";
import { saveIndicator } from "../lib/indicators";
import { listReputations, saveReputation } from "../lib/reputation";
import { runVtAuto } from "../worker/vt/run";
import { createTestDb, resetData } from "./helpers/test-db";

let ctx: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.client.close();
});

const calls: string[] = [];
const sleep = async () => {};
const ok = (m: number) => ({ data: { attributes: { last_analysis_stats: { malicious: m, suspicious: 0, harmless: 50, undetected: 10 }, reputation: 0 } } });
const mkFetch = (handler: (url: string) => { status: number; body?: unknown }) =>
  (async (u: string) => {
    calls.push(u);
    const r = handler(u);
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
  }) as unknown as typeof fetch;

async function seed() {
  const [s] = await ctx.db.insert(sources).values({ name: "기관A", kind: "api", url: "https://a.test" }).returning();
  const src = { id: s.id, name: s.name };
  for (const raw of ["198.51.100.1", "198.51.100.2", "evil1.example", "a".repeat(64), "http://x.example/p", "u@mail.example"]) {
    await saveIndicator(ctx.db, { raw, source: src });
  }
}
beforeEach(async () => {
  calls.length = 0;
  await resetData(ctx.client);
  await seed();
});

describe("VirusTotal 자동 조회", () => {
  it("키가 없으면 아무것도 하지 않는다", async () => {
    const r = await runVtAuto(ctx.db, { apiKey: undefined, sleep });
    expect(r.checked).toBe(0);
    expect(r.stopped).toBeTruthy();
  });

  it("IP·해시·도메인만, IP → 해시 → 도메인 순으로 조회하고 URL·메일은 보내지 않는다", async () => {
    const r = await runVtAuto(ctx.db, { apiKey: "k", sleep, fetchImpl: mkFetch(() => ({ status: 200, body: ok(0) })) });
    expect(r).toMatchObject({ checked: 4, recorded: 4 });
    expect(calls.map((u) => u.split("/v3/")[1].split("/")[0])).toEqual(["ip_addresses", "ip_addresses", "files", "domains"]);
    expect(calls.join(" ")).not.toContain("mail.example");
  });

  it("이미 평판 기록이 있는 값은 다시 조회하지 않는다", async () => {
    const [ip] = (await ctx.db.select().from(indicators)).filter((i) => i.value === "198.51.100.1");
    await saveReputation(ctx.db, { indicatorId: ip.id, verdict: "harmless" });
    await runVtAuto(ctx.db, { apiKey: "k", sleep, fetchImpl: mkFetch(() => ({ status: 200, body: ok(0) })) });
    expect(calls.some((u) => u.endsWith("/198.51.100.1"))).toBe(false);
    expect(calls).toHaveLength(3);
  });

  it("SIEM 제외(화이트리스트) 값은 외부로 보내지 않는다", async () => {
    await ctx.db.update(indicators).set({ excluded: true });
    const r = await runVtAuto(ctx.db, { apiKey: "k", sleep, fetchImpl: mkFetch(() => ({ status: 200, body: ok(0) })) });
    expect(r.checked).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("이력 없음(404)은 '미확인'으로 기록해 다시 조회하지 않는다", async () => {
    const f = mkFetch(() => ({ status: 404 }));
    const r = await runVtAuto(ctx.db, { apiKey: "k", sleep, fetchImpl: f });
    expect(r).toMatchObject({ checked: 4, notFound: 4, recorded: 0 });
    const again = await runVtAuto(ctx.db, { apiKey: "k", sleep, fetchImpl: f });
    expect(again.checked).toBe(0);
    const [i] = await ctx.db.select().from(indicators).limit(1);
    const reps = await listReputations(ctx.db, i.id);
    expect(reps[0].verdict).toBe("unknown");
  });

  it("한도(429)·키 오류(401)면 즉시 멈춘다", async () => {
    const r = await runVtAuto(ctx.db, { apiKey: "k", sleep, fetchImpl: mkFetch(() => ({ status: 429 })) });
    expect(r.checked).toBe(1);
    expect(r.stopped).toContain("한도");
    expect(calls).toHaveLength(1);
  });

  it("일시 오류(500)는 건너뛰고 기록하지 않는다 (다음 실행에서 재시도)", async () => {
    const r = await runVtAuto(ctx.db, { apiKey: "k", sleep, fetchImpl: mkFetch(() => ({ status: 500 })) });
    expect(r).toMatchObject({ checked: 4, recorded: 0, notFound: 0 });
    expect((await runVtAuto(ctx.db, { apiKey: "k", sleep, fetchImpl: mkFetch(() => ({ status: 500 })) })).checked).toBe(4);
  });

  it("실행당 건수와 하루 상한을 지킨다", async () => {
    const f = mkFetch(() => ({ status: 200, body: ok(0) }));
    expect((await runVtAuto(ctx.db, { apiKey: "k", sleep, fetchImpl: f, maxItems: 2 })).checked).toBe(2);
    const r = await runVtAuto(ctx.db, { apiKey: "k", sleep, fetchImpl: f, dailyCap: 2 });
    expect(r.checked).toBe(0);
    expect(r.stopped).toContain("상한");
  });

  it("조회 사이에 대기한다", async () => {
    const waits: number[] = [];
    await runVtAuto(ctx.db, { apiKey: "k", sleep: async (ms) => void waits.push(ms), delayMs: 16000, fetchImpl: mkFetch(() => ({ status: 200, body: ok(0) })) });
    expect(waits).toEqual([16000, 16000, 16000]);
  });
});
