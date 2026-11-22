import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import PDFDocument from "pdfkit";
import { collectRuns, indicatorSources, indicators, sources, whitelist } from "../db/schema";
import { encryptSecret, generateEncryptionKey } from "../lib/crypto";
import { splitCsvLine } from "../worker/collect/api";
import { makeFetcher, type FetchResult, type Fetcher } from "../worker/collect/fetcher";
import { runCollect } from "../worker/collect/run";
import { createTestDb, resetData } from "./helpers/test-db";

/**
 * 시험 사례 표 (인터넷 없이 가짜 응답으로 실행)
 *  1. API 텍스트          → 줄마다 값, 주석·빈 줄 무시, 줄 뒤 설명 칸 버림, 사설 IP는 저장되지만 제외 표시
 *  2. API JSON            → itemsPath/valueFields 로 값 추출, POST 본문, 키가 헤더로 전달, 잘못된 구조는 실패
 *  3. API CSV             → 열 번호로 추출, 머리글 건너뜀, 따옴표 안 쉼표
 *  4. HTML 게시판         → 새 글만 열고 본문에서 5종류 추출, 원문 링크 기록, 두 번째 실행에서는 이미 처리한 글 건너뜀
 *  5. PDF                 → 링크 목록에서 PDF만 내려받아 본문 추출 (실제로 만든 PDF 사용)
 *  6. 실패 격리           → 한 출처가 실패해도 나머지 성공, 실패 이력에 사유, API 키 값은 이력에서 지워짐
 *  7. 사용 안 함/설정 오류 → 꺼진 출처는 건너뜀, 설정이 틀리면 실패로 기록
 *  8. 이력·중복           → 성공 이력에 새 지표 수, 같은 값 재수집은 새 지표 0건, 출처 기관명 기록, 화이트리스트 반영
 *  9. 외부 요청 틀        → 5xx는 재시도 후 성공, 4xx는 재시도 없이 반환, 계속 실패하면 오류, 제한 시간
 */
let ctx: Awaited<ReturnType<typeof createTestDb>>;
const enc = generateEncryptionKey();
const NOW = new Date("2026-11-22T03:00:00Z");

beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.client.close();
});
beforeEach(async () => {
  await resetData(ctx.client);
});

const text = (s: string, contentType = "text/plain"): FetchResult => ({ status: 200, contentType, body: new TextEncoder().encode(s) });
type Call = { url: string; method?: string; headers?: Record<string, string>; body?: string };
function fake(routes: Record<string, FetchResult | (() => FetchResult)>) {
  const calls: Call[] = [];
  const fetcher: Fetcher = async (url, init) => {
    calls.push({ url, method: init?.method, headers: init?.headers, body: init?.body });
    const r = routes[url];
    if (!r) return { status: 404, contentType: "text/plain", body: new Uint8Array() };
    return typeof r === "function" ? r() : r;
  };
  return { fetcher, calls };
}
async function addSource(v: Partial<typeof sources.$inferInsert> & { name: string; kind: "api" | "html" | "pdf"; url: string }) {
  const [row] = await ctx.db.insert(sources).values({ config: {}, ...v }).returning();
  return row;
}
const run = (fetcher: Fetcher) => runCollect(ctx.db, { fetcher, now: () => NOW, encKey: enc });
const valuesOf = async () => (await ctx.db.select({ v: indicators.value }).from(indicators)).map((r) => r.v).sort();

async function makePdf(lines: string[]): Promise<Uint8Array> {
  const doc = new PDFDocument();
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((r) => doc.on("end", () => r()));
  for (const l of lines) doc.text(l);
  doc.end();
  await done;
  return new Uint8Array(Buffer.concat(chunks));
}

describe("API 수집기", () => {
  it("텍스트: 주석·빈 줄은 무시하고 줄 맨 앞 값만 쓴다", async () => {
    await addSource({ name: "텍스트기관", kind: "api", url: "https://t.test/list.txt", config: { format: "text" } });
    const { fetcher } = fake({ "https://t.test/list.txt": text("# 주석\n\n198.51.100.1 ; 설명\n203.0.113.5,메모\nevil.example\n10.1.2.3\nnot a value\n") });
    const [r] = await run(fetcher);
    expect(r).toMatchObject({ status: "success", found: 5, newCount: 4 }); // 'not' 은 정규화 실패
    expect(await valuesOf()).toEqual(["10.1.2.3", "198.51.100.1", "203.0.113.5", "evil.example"]);
    const [priv] = await ctx.db.select().from(indicators).where(eq(indicators.value, "10.1.2.3"));
    expect(priv.excluded).toBe(true); // 사설 IP는 저장은 되지만 SIEM에서는 제외
  });

  it("JSON: 경로·필드 추출, POST 본문, API 키는 헤더로", async () => {
    const key = "SECRET-KEY-123";
    await addSource({
      name: "JSON기관", kind: "api", url: "https://j.test/api", apiKeyEnc: encryptSecret(key, enc),
      config: { format: "json", method: "POST", body: { days: 1 }, itemsPath: "data.items", valueFields: ["ioc", "meta.url"], authHeader: "Auth-Key", authPrefix: "" },
    });
    const { fetcher, calls } = fake({
      "https://j.test/api": text(JSON.stringify({ data: { items: [{ ioc: "198.51.100.9", meta: { url: "hxxp://bad[.]example/x" } }, { ioc: ["a.threat.example", "198.51.100.10"] }, "plain.example"] } }), "application/json"),
    });
    const [r] = await run(fetcher);
    expect(r).toMatchObject({ status: "success", found: 5 });
    expect(await valuesOf()).toEqual(["198.51.100.10", "198.51.100.9", "a.threat.example", "http://bad.example/x", "plain.example"]);
    expect(calls[0]).toMatchObject({ method: "POST", body: '{"days":1}', headers: { "Auth-Key": key, "Content-Type": "application/json" } });
  });

  it("JSON: 구조가 다르면 실패로 기록하고 사유에 키 값이 없다", async () => {
    const key = "SECRET-KEY-123";
    await addSource({ name: "깨진기관", kind: "api", url: "https://j.test/api?token=SECRET-KEY-123", apiKeyEnc: encryptSecret(key, enc), config: { format: "json", itemsPath: "nope", valueFields: ["x"] } });
    const [r] = await run(fake({ "https://j.test/api?token=SECRET-KEY-123": text('{"a":1}') }).fetcher);
    expect(r.status).toBe("fail");
    expect(r.error).toContain("itemsPath");
    expect(JSON.stringify(await ctx.db.select().from(collectRuns))).not.toContain(key);
  });

  it("CSV: 열 번호로 추출하고 머리글을 건너뛴다", async () => {
    expect(splitCsvLine('a,"b,c","say ""hi"""')).toEqual(["a", "b,c", 'say "hi"']); // 따옴표 안 쉼표와 "" 이스케이프
    await addSource({ name: "CSV기관", kind: "api", url: "https://c.test/f.csv", config: { format: "csv", columns: [1], skipLines: 1 } });
    const csv = 'id,ioc,desc\n1,198.51.100.20,"설명, 쉼표"\n# x\n2,"bad.example",x\n';
    const [r] = await run(fake({ "https://c.test/f.csv": text(csv) }).fetcher);
    expect(r).toMatchObject({ status: "success", found: 2 });
    expect(await valuesOf()).toEqual(["198.51.100.20", "bad.example"]);
  });
});

describe("HTML·PDF 수집기", () => {
  const board = (links: string[]) => text(`<html><body>${links.map((l) => `<a class="p" href="${l}">글</a>`).join("")}<a href="/other">기타</a></body></html>`, "text/html");
  const post = (body: string) => text(`<html><head><title>게시글 제목</title></head><body><script>var x="9.9.9.9"</script><div class="c">${body}</div><div class="side">1.1.1.1</div></body></html>`, "text/html");

  it("게시판: 새 글만 열고, 본문 영역에서만 5종류를 찾고, 다음 실행에서는 건너뛴다", async () => {
    const src = await addSource({ name: "게시판기관", kind: "html", url: "https://b.test/list", config: { linkSelector: "a.p", contentSelector: ".c", maxPosts: 10 } });
    let listing = board(["/post/1", "/post/2"]);
    const { fetcher, calls } = fake({
      "https://b.test/list": () => listing,
      "https://b.test/post/1": post("공격 IP 198.51.100.30, 도메인 phish[.]example, 해시 d41d8cd98f00b204e9800998ecf8427e, 메일 a[@]x[.]example, hxxp://m[.]example/p"),
      "https://b.test/post/2": post("IP 203.0.113.40"),
    });
    const [r1] = await run(fetcher);
    expect(r1).toMatchObject({ status: "success", newCount: 6 });
    expect(await valuesOf()).toEqual(["198.51.100.30", "203.0.113.40", "a@x.example", "d41d8cd98f00b204e9800998ecf8427e", "http://m.example/p", "phish.example"]); // 사이드바 1.1.1.1·스크립트 9.9.9.9 제외
    const [ref] = await ctx.db.select().from(indicatorSources).innerJoin(indicators, eq(indicators.id, indicatorSources.indicatorId)).where(eq(indicators.value, "203.0.113.40"));
    expect(ref.indicator_sources).toMatchObject({ sourceName: "게시판기관", refUrl: "https://b.test/post/2", note: "게시글 제목" });

    // 두 번째 실행: 새 글(3번)만 연다
    calls.length = 0;
    listing = board(["/post/1", "/post/2", "/post/3"]);
    const f2 = fake({ "https://b.test/list": () => listing, "https://b.test/post/3": post("IP 198.51.100.50") });
    const [r2] = await run(f2.fetcher);
    expect(r2).toMatchObject({ status: "success", newCount: 1 });
    expect(f2.calls.map((c) => c.url)).toEqual(["https://b.test/list", "https://b.test/post/3"]);
    const [saved] = await ctx.db.select().from(sources).where(eq(sources.id, src.id));
    expect((saved.config._seen as string[]).length).toBe(3);
    expect(saved.config.linkSelector).toBe("a.p"); // 관리자가 넣은 설정은 보존
  });

  it("게시판: 선택자가 틀려 링크가 없으면 실패, 글 하나만 실패하면 나머지는 성공하고 그 글은 다음에 재시도", async () => {
    await addSource({ name: "잘못된선택자", kind: "html", url: "https://b.test/list", config: { linkSelector: "a.zzz" } });
    const [bad] = await run(fake({ "https://b.test/list": board(["/p/1"]) }).fetcher);
    expect(bad.status).toBe("fail");
    expect(bad.error).toContain("linkSelector");

    await ctx.db.delete(sources);
    await addSource({ name: "일부실패", kind: "html", url: "https://b.test/list", config: { linkSelector: "a.p", contentSelector: ".c" } });
    const f = fake({ "https://b.test/list": board(["/p/1", "/p/2"]), "https://b.test/p/1": post("IP 198.51.100.60") }); // /p/2 는 404
    const [r] = await run(f.fetcher);
    expect(r).toMatchObject({ status: "success", newCount: 1 });
    const f2 = fake({ "https://b.test/list": board(["/p/1", "/p/2"]), "https://b.test/p/2": post("IP 198.51.100.61") });
    await run(f2.fetcher);
    expect(f2.calls.map((c) => c.url)).toEqual(["https://b.test/list", "https://b.test/p/2"]); // 1번 글은 건너뛰고 2번만 재시도
  });

  it("PDF: 목록에서 PDF 링크만 따라가 본문에서 추출한다 (실제 PDF 파일 사용)", async () => {
    await addSource({ name: "PDF기관", kind: "pdf", url: "https://p.test/reports", config: { maxPdfs: 5 } });
    const pdf = await makePdf(["Threat report", "C2 server 198.51.100.77 and domain c2[.]threat[.]example", "hash d41d8cd98f00b204e9800998ecf8427e", "file report.pdf"]);
    const { fetcher, calls } = fake({
      "https://p.test/reports": text('<a href="/r/2026-11.pdf">PDF</a><a href="/about.html">소개</a><a href="/r/x.PDF?dl=1">두번째</a>', "text/html"),
      "https://p.test/r/2026-11.pdf": { status: 200, contentType: "application/pdf", body: pdf },
      "https://p.test/r/x.PDF?dl=1": { status: 200, contentType: "application/pdf", body: pdf },
    });
    const [r] = await run(fetcher);
    expect(r).toMatchObject({ status: "success", newCount: 3 });
    expect(await valuesOf()).toEqual(["198.51.100.77", "c2.threat.example", "d41d8cd98f00b204e9800998ecf8427e"]); // report.pdf 는 도메인으로 보지 않음
    expect(calls.map((c) => c.url)).toEqual(["https://p.test/reports", "https://p.test/r/2026-11.pdf", "https://p.test/r/x.PDF?dl=1"]);
    const again = fake({ "https://p.test/reports": text('<a href="/r/2026-11.pdf">PDF</a>', "text/html") });
    await run(again.fetcher);
    expect(again.calls).toHaveLength(1); // 이미 처리한 PDF는 다시 받지 않음
  });
});

describe("실행 틀", () => {
  it("한 출처가 실패해도 나머지는 계속하고, 이력·마지막 성공 시각·출처 기관명이 남는다", async () => {
    const ok = await addSource({ name: "정상기관", kind: "api", url: "https://ok.test/l", config: { format: "text" } });
    await addSource({ name: "고장기관", kind: "api", url: "https://down.test/l", config: { format: "text" } });
    await addSource({ name: "꺼진기관", kind: "api", url: "https://off.test/l", config: { format: "text" }, enabled: false });
    await addSource({ name: "설정오류기관", kind: "html", url: "https://cfg.test/l", config: {} });
    const { fetcher, calls } = fake({ "https://ok.test/l": text("198.51.100.1\n"), "https://down.test/l": { status: 503, contentType: "", body: new Uint8Array() } });
    const results = await run(fetcher);
    expect(Object.fromEntries(results.map((r) => [r.name, r.status]))).toEqual({ 정상기관: "success", 고장기관: "fail", 설정오류기관: "fail" });
    expect(calls.some((c) => c.url.includes("off.test"))).toBe(false);
    const runs = await ctx.db.select().from(collectRuns);
    expect(runs).toHaveLength(3);
    expect(runs.find((x) => x.status === "fail" && x.errorMessage?.includes("503"))).toBeTruthy();
    expect(runs.find((x) => x.errorMessage?.includes("설정 오류"))).toBeTruthy();
    const [s] = await ctx.db.select().from(sources).where(eq(sources.id, ok.id));
    expect(s.lastSuccessAt?.getTime()).toBe(NOW.getTime());
    const [link] = await ctx.db.select().from(indicatorSources);
    expect(link.sourceName).toBe("정상기관");
  });

  it("같은 값을 다시 수집하면 새 지표는 0건이고, 다른 기관이 보낸 같은 값은 출처만 늘어난다", async () => {
    await addSource({ name: "기관1", kind: "api", url: "https://a.test/l", config: { format: "text" } });
    await addSource({ name: "기관2", kind: "api", url: "https://b.test/l", config: { format: "text" } });
    const routes = { "https://a.test/l": text("198.51.100.1\n"), "https://b.test/l": text("198.51.100.1\n") };
    const first = await run(fake(routes).fetcher);
    expect(first.map((r) => r.newCount)).toEqual([1, 0]);
    expect((await run(fake(routes).fetcher)).map((r) => r.newCount)).toEqual([0, 0]);
    expect(await ctx.db.select().from(indicators)).toHaveLength(1);
    expect(await ctx.db.select().from(indicatorSources)).toHaveLength(2);
  });

  it("수집 후 화이트리스트가 바로 반영된다", async () => {
    await ctx.db.insert(whitelist).values({ type: "domain", value: "corp.example" });
    await addSource({ name: "기관", kind: "api", url: "https://a.test/l", config: { format: "text" } });
    await run(fake({ "https://a.test/l": text("x.corp.example\nevil.example\n") }).fetcher);
    const rows = await ctx.db.select({ v: indicators.value, e: indicators.excluded }).from(indicators);
    expect(Object.fromEntries(rows.map((r) => [r.v, r.e]))).toEqual({ "x.corp.example": true, "evil.example": false });
  });
});

describe("외부 요청 틀", () => {
  const resp = (status: number, body = "ok") => new Response(body, { status });
  it("5xx는 재시도해서 성공하면 결과를 돌려준다", async () => {
    let n = 0;
    const f = makeFetcher({ retries: 2, fetchImpl: (async () => (++n < 3 ? resp(503) : resp(200, "fine"))) as typeof fetch });
    const r = await f("https://x.test");
    expect(r.status).toBe(200);
    expect(n).toBe(3);
  });
  it("4xx는 재시도 없이 그대로 돌려주고, 계속 실패하면 오류를 낸다", async () => {
    let n = 0;
    const f404 = makeFetcher({ fetchImpl: (async () => (n++, resp(404))) as typeof fetch });
    expect((await f404("https://x.test")).status).toBe(404);
    expect(n).toBe(1);
    const fFail = makeFetcher({ retries: 1, fetchImpl: (async () => { throw new Error("연결 끊김"); }) as typeof fetch });
    await expect(fFail("https://x.test")).rejects.toThrow(/2회 시도.*연결 끊김/);
  }, 20000);
  it("제한 시간을 넘기면 중단한다", async () => {
    const slow = (async (_u: string, init?: RequestInit) =>
      new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("timeout"))))) as unknown as typeof fetch;
    const f = makeFetcher({ timeoutMs: 50, retries: 0, fetchImpl: slow });
    await expect(f("https://x.test")).rejects.toThrow(/요청 실패/);
  });
});
