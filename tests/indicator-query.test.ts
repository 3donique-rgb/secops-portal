import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { indicators, sources } from "../db/schema";
import { saveIndicator } from "../lib/indicators";
import {
  countIndicators,
  getIndicatorDetail,
  listIndicators,
  listSourceNames,
  searchIndicators,
} from "../lib/indicator-query";
import { createTestDb, resetData } from "./helpers/test-db";

/**
 * 시험 사례 표 (지표 6건: A기관 ip 2·domain 1, B기관 hash 1·email 1, 두 기관 공통 url 1)
 *  1. 조건 없음            → 전체, 최신 확인일 순, 기관명 목록 포함
 *  2. 종류 여러 개         → ip+domain만
 *  3. 상태·제외 필터       → inactive만 / excluded=none 이면 제외된 것 빠짐
 *  4. 기관 필터            → 그 기관이 보낸 것만 (공통 건 포함)
 *  5. 키워드               → 값·메모·기관명 부분 일치, % _ 는 글자 그대로
 *  6. 기간                 → 최종 확인일 시작 포함·끝 미포함
 *  7. 쪽 나누기            → 총건수는 전체, 행은 쪽 크기만큼, 쪽 사이에 겹침 없음
 *  8. 상세                 → 출처 목록(기관명, 최초·최종 확인일, 링크) / 없는 id는 null
 */
let ctx: Awaited<ReturnType<typeof createTestDb>>;
let A: { id: string; name: string };
let Bsrc: { id: string; name: string };
const day = (d: number) => new Date(Date.UTC(2026, 10, d));

beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.client.close();
});
beforeEach(async () => {
  await resetData(ctx.client);
  const [a] = await ctx.db.insert(sources).values({ name: "A기관", kind: "api", url: "https://a.test" }).returning();
  const [b] = await ctx.db.insert(sources).values({ name: "B기관", kind: "html", url: "https://b.test" }).returning();
  A = { id: a.id, name: a.name };
  Bsrc = { id: b.id, name: b.name };
  const put = (raw: string, source: typeof A, now: Date, refUrl?: string) =>
    saveIndicator(ctx.db, { raw, source, now, refUrl });
  await put("198.51.100.1", A, day(1));
  await put("198.51.100.2", A, day(5));
  await put("evil.example", A, day(10));
  await put("d41d8cd98f00b204e9800998ecf8427e", Bsrc, day(12));
  await put("mal@bad.example", Bsrc, day(15));
  await put("hxxp://x.example/a_b", A, day(18), "https://a.test/post/1");
  await put("hxxp://x.example/a_b", Bsrc, day(20), "https://b.test/post/9");
});

describe("지표 조회", () => {
  it("조건이 없으면 전체를 최신 확인일 순으로, 기관명 목록과 함께 돌려준다", async () => {
    const { rows, total } = await searchIndicators(ctx.db, {});
    expect(total).toBe(6);
    expect(rows[0].value).toBe("http://x.example/a_b");
    expect(rows[0].sourceNames).toEqual(["A기관", "B기관"]);
    expect(rows.map((r) => r.lastSeenAt.getTime())).toEqual([...rows.map((r) => r.lastSeenAt.getTime())].sort((x, y) => y - x));
  });

  it("종류를 여러 개 고를 수 있다", async () => {
    const { rows } = await searchIndicators(ctx.db, { types: ["ip", "domain"] });
    expect(rows.map((r) => r.type).sort()).toEqual(["domain", "ip", "ip"]);
  });

  it("상태와 제외 여부로 거른다", async () => {
    await ctx.db.update(indicators).set({ status: "inactive" }).where(eq(indicators.value, "198.51.100.1"));
    await ctx.db.update(indicators).set({ excluded: true }).where(eq(indicators.value, "evil.example"));
    expect((await searchIndicators(ctx.db, { status: "inactive" })).rows.map((r) => r.value)).toEqual(["198.51.100.1"]);
    expect(await countIndicators(ctx.db, { excluded: "none" })).toBe(5);
    expect(await countIndicators(ctx.db, { excluded: "only" })).toBe(1);
    expect(await countIndicators(ctx.db, { status: "active", excluded: "none" })).toBe(4);
  });

  it("기관으로 거른다 (두 기관이 보낸 건도 포함)", async () => {
    expect(await countIndicators(ctx.db, { sourceName: "A기관" })).toBe(4);
    expect(await countIndicators(ctx.db, { sourceName: "B기관" })).toBe(3);
    expect(await countIndicators(ctx.db, { sourceName: "없는기관" })).toBe(0);
  });

  it("키워드는 값·메모·기관명에서 부분 일치로 찾고, % 와 _ 는 글자 그대로 취급한다", async () => {
    expect(await countIndicators(ctx.db, { keyword: "EVIL" })).toBe(1); // 대소문자 무시
    expect(await countIndicators(ctx.db, { keyword: "b기관" })).toBe(3); // 기관명
    await ctx.db.update(indicators).set({ memo: "캠페인 알파" }).where(eq(indicators.value, "198.51.100.2"));
    expect(await countIndicators(ctx.db, { keyword: "알파" })).toBe(1);
    expect(await countIndicators(ctx.db, { keyword: "%" })).toBe(0);
    expect(await countIndicators(ctx.db, { keyword: "a_b" })).toBe(1); // 값에 _ 가 실제로 있는 건
    expect(await countIndicators(ctx.db, { keyword: "a.b" })).toBe(0); // . 은 정규식이 아님
  });

  it("기간은 최종 확인일 기준으로 시작은 포함, 끝은 미포함이다", async () => {
    expect(await countIndicators(ctx.db, { from: day(5), to: day(15) })).toBe(3); // 5, 10, 12
    expect(await countIndicators(ctx.db, { from: day(15) })).toBe(2); // 15, 20 (url은 두 기관이 보내 최종 확인일이 20일)
    expect(await countIndicators(ctx.db, { to: day(1) })).toBe(0);
  });

  it("쪽 나누기: 총건수는 전체, 쪽 사이에 겹치지 않는다", async () => {
    const p1 = await searchIndicators(ctx.db, {}, { page: 1, pageSize: 4 });
    const p2 = await searchIndicators(ctx.db, {}, { page: 2, pageSize: 4 });
    expect(p1.total).toBe(6);
    expect(p1.rows).toHaveLength(4);
    expect(p2.rows).toHaveLength(2);
    expect(new Set([...p1.rows, ...p2.rows].map((r) => r.id)).size).toBe(6);
    expect((await listIndicators(ctx.db, {}, 3))).toHaveLength(3);
  });

  it("상세: 출처 목록을 돌려주고, 없는 id는 null", async () => {
    const { rows } = await searchIndicators(ctx.db, { keyword: "x.example" });
    const d = await getIndicatorDetail(ctx.db, rows[0].id);
    expect(d?.sources.map((s) => [s.sourceName, s.refUrl])).toEqual([
      ["A기관", "https://a.test/post/1"],
      ["B기관", "https://b.test/post/9"],
    ]);
    expect(await getIndicatorDetail(ctx.db, "00000000-0000-0000-0000-000000000000")).toBeNull();
    expect(await listSourceNames(ctx.db)).toEqual(["A기관", "B기관"]);
  });
});
