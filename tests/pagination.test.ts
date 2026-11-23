import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assets } from "../db/schema";
import { listAssetsPage } from "../lib/assets";
import { pageAfterSizeChange, pageWindow, parsePage, parsePageSize, rangeLabel, totalPages } from "../lib/pagination";
import { createTestDb, resetData } from "./helpers/test-db";

describe("쪽 계산", () => {
  it("쪽 크기는 10·50·100만 허용", () => {
    expect(parsePageSize("10", 50)).toBe(10);
    expect(parsePageSize("100", 50)).toBe(100);
    expect(parsePageSize("7", 50)).toBe(50);
    expect(parsePageSize(undefined, 10)).toBe(10);
    expect(parsePageSize(["50", "10"], 10)).toBe(50);
    expect(parsePageSize("1000000", 50)).toBe(50);
  });
  it("쪽 번호는 1 이상의 정수", () => {
    expect(parsePage("3")).toBe(3);
    expect(parsePage("0")).toBe(1);
    expect(parsePage("-4")).toBe(1);
    expect(parsePage("abc")).toBe(1);
    expect(parsePage("2.9")).toBe(2);
    expect(parsePage(undefined)).toBe(1);
    expect(parsePage("99999999999")).toBe(1_000_000);
  });
  it("전체 쪽 수", () => {
    expect(totalPages(0, 50)).toBe(1);
    expect(totalPages(50, 50)).toBe(1);
    expect(totalPages(51, 50)).toBe(2);
    expect(totalPages(126_394, 10)).toBe(12_640);
  });
  it("10쪽 묶음: 1~10, 11~20, 마지막은 남은 쪽까지", () => {
    expect(pageWindow(1, 30)).toEqual({ numbers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], prevGroup: null, nextGroup: 11 });
    expect(pageWindow(10, 30).numbers.at(-1)).toBe(10);
    expect(pageWindow(11, 30)).toMatchObject({ prevGroup: 10, nextGroup: 21 });
    expect(pageWindow(11, 30).numbers[0]).toBe(11);
    expect(pageWindow(25, 25)).toEqual({ numbers: [21, 22, 23, 24, 25], prevGroup: 20, nextGroup: null });
    expect(pageWindow(1, 1)).toEqual({ numbers: [1], prevGroup: null, nextGroup: null });
    expect(pageWindow(99, 5).numbers).toEqual([1, 2, 3, 4, 5]);
  });
  it("쪽 크기를 바꾸면 보던 첫 항목이 있는 쪽으로", () => {
    expect(pageAfterSizeChange(3, 10, 50)).toBe(1); // 21~30번 → 1~50번
    expect(pageAfterSizeChange(3, 50, 10)).toBe(11); // 101번 → 11쪽(101~110)
    expect(pageAfterSizeChange(1, 100, 10)).toBe(1);
  });
  it("보이는 범위 표시", () => {
    expect(rangeLabel(1, 10, 0)).toEqual({ from: 0, to: 0 });
    expect(rangeLabel(3, 10, 25)).toEqual({ from: 21, to: 25 });
    expect(rangeLabel(1, 50, 7)).toEqual({ from: 1, to: 7 });
  });
});

describe("자산 쪽 나누기", () => {
  let ctx: Awaited<ReturnType<typeof createTestDb>>;
  beforeAll(async () => {
    ctx = await createTestDb();
  });
  afterAll(async () => {
    await ctx.client.close();
  });
  beforeEach(async () => {
    await resetData(ctx.client);
    await ctx.db.insert(assets).values(Array.from({ length: 25 }, (_, i) => ({ name: `자산${String(i).padStart(2, "0")}`, target: `h${i}.example.com`, enabled: i % 5 !== 0, scanPermitted: true })));
  });
  it("쪽마다 이름순으로 겹치지 않게 나온다", async () => {
    const p1 = await listAssetsPage(ctx.db, {}, { page: 1, pageSize: 10 });
    const p3 = await listAssetsPage(ctx.db, {}, { page: 3, pageSize: 10 });
    expect(p1.total).toBe(25);
    expect(p1.rows).toHaveLength(10);
    expect(p1.rows[0].name).toBe("자산00");
    expect(p3.rows).toHaveLength(5);
    expect(p3.rows[0].name).toBe("자산20");
  });
  it("검색·상태 조건이 개수에도 반영된다", async () => {
    const r = await listAssetsPage(ctx.db, { enabled: false }, { page: 1, pageSize: 10 });
    expect(r.total).toBe(5);
    const k = await listAssetsPage(ctx.db, { keyword: "자산07" }, { page: 1, pageSize: 10 });
    expect(k.total).toBe(1);
  });
  it("범위를 벗어난 쪽은 빈 목록", async () => {
    const r = await listAssetsPage(ctx.db, {}, { page: 9, pageSize: 10 });
    expect(r.rows).toHaveLength(0);
    expect(r.total).toBe(25);
  });
});
