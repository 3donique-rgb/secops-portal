import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { indicators, notifications, scanResults, sources } from "../db/schema";
import { countAssets, createAsset, deleteAsset, getAsset, listAssets, updateAsset, type AssetInput } from "../lib/assets";
import { saveIndicator } from "../lib/indicators";
import { createTestDb, resetData } from "./helpers/test-db";

/**
 * 시험 사례 표
 *  1. 등록 검사     → 점검 허가 미체크 거부, URL/메일/잘못된 값 거부, 사설 IP 거부, 중요도·강도 범위, 같은 대상 중복 거부
 *  2. 정규화        → 대소문자·방어 표기 정리(Portal.Example.COM → portal.example.com)
 *  3. 제외 연동     → 자산과 같은 도메인(하위 포함)·IP의 위협정보가 SIEM 제외로 바뀌고, 자산 삭제·대상 변경 시 다시 풀림
 *  4. 검색·집계     → 이름·대상·담당자·부서 검색, 와일드카드 글자 그대로, 사용 중 개수
 *  5. 삭제          → 점검 결과·알림 함께 삭제
 */
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
const base: AssetInput = { name: "대표 홈페이지", target: "www.corp.example", importance: 4, scanLevel: 3, scanPermitted: true, enabled: true };

describe("자산 관리", () => {
  it("등록 검사", async () => {
    for (const bad of [
      { scanPermitted: false }, { name: "" }, { target: "http://www.corp.example/a" }, { target: "a@b.example" },
      { target: "not valid" }, { target: "10.1.2.3" }, { target: "192.168.0.1" }, { importance: 0 }, { importance: 6 }, { scanLevel: 0 }, { scanLevel: 3.5 },
    ]) {
      expect((await createAsset(ctx.db, { ...base, ...bad })).ok, JSON.stringify(bad)).toBe(false);
    }
    expect((await createAsset(ctx.db, base)).ok).toBe(true);
    expect((await createAsset(ctx.db, { ...base, name: "다른 이름", target: "WWW.Corp.Example" })).ok).toBe(false); // 같은 대상
    expect(await countAssets(ctx.db)).toEqual({ total: 1, enabled: 1 });
  });

  it("점검 대상은 정규화되어 저장된다", async () => {
    const r = await createAsset(ctx.db, { ...base, target: "Portal[.]Example.COM", owner: "  홍길동 ", memo: "" });
    if (!r.ok) throw new Error(r.message);
    const a = await getAsset(ctx.db, r.id);
    expect(a).toMatchObject({ target: "portal.example.com", owner: "홍길동", memo: null, scanPermitted: true });
    expect((await createAsset(ctx.db, { ...base, name: "IP", target: "203.0.113.9" })).ok).toBe(true);
  });

  it("자산과 일치하는 위협정보는 SIEM 제외로 바뀌고, 삭제·변경하면 다시 풀린다", async () => {
    const [src] = await ctx.db.insert(sources).values({ name: "S", kind: "api", url: "https://s.test" }).returning();
    for (const raw of ["www.corp.example", "x.www.corp.example", "other.example", "203.0.113.9"]) {
      await saveIndicator(ctx.db, { raw, source: { id: src.id, name: "S" } });
    }
    const excluded = async () => Object.fromEntries((await ctx.db.select({ v: indicators.value, e: indicators.excluded }).from(indicators)).map((r) => [r.v, r.e]));
    const a = await createAsset(ctx.db, base);
    const b = await createAsset(ctx.db, { ...base, name: "IP", target: "203.0.113.9" });
    if (!a.ok || !b.ok) throw new Error("create failed");
    expect(await excluded()).toEqual({ "www.corp.example": true, "x.www.corp.example": true, "other.example": false, "203.0.113.9": true });

    await updateAsset(ctx.db, a.id, { ...base, target: "www.moved.example" });
    expect((await excluded())["www.corp.example"]).toBe(false);
    await deleteAsset(ctx.db, b.id);
    expect((await excluded())["203.0.113.9"]).toBe(false);
    expect(await ctx.db.select().from(indicators)).toHaveLength(4); // 지표는 지워지지 않음
  });

  it("검색과 사용 중 개수", async () => {
    await createAsset(ctx.db, { ...base, owner: "김보안", department: "보안관제팀" });
    await createAsset(ctx.db, { ...base, name: "메일서버", target: "mail.corp.example", department: "정보시스템팀", enabled: false });
    const names = async (keyword: string) => (await listAssets(ctx.db, { keyword })).map((a) => a.name);
    expect(await names("홈페이지")).toEqual(["대표 홈페이지"]);
    expect(await names("MAIL.corp")).toEqual(["메일서버"]);
    expect(await names("김보안")).toEqual(["대표 홈페이지"]);
    expect(await names("정보시스템")).toEqual(["메일서버"]);
    expect(await names("%")).toEqual([]);
    expect((await listAssets(ctx.db, { enabled: true })).map((a) => a.name)).toEqual(["대표 홈페이지"]);
    expect(await countAssets(ctx.db)).toEqual({ total: 2, enabled: 1 });
  });

  it("삭제하면 점검 결과와 알림도 함께 지워진다", async () => {
    const r = await createAsset(ctx.db, base);
    if (!r.ok) throw new Error(r.message);
    await ctx.db.insert(scanResults).values({ assetId: r.id, scanDate: "2026-11-21", scanLevel: 3, status: "success" });
    await ctx.db.insert(notifications).values({ kind: "port_opened", assetId: r.id, message: "x" });
    expect(await deleteAsset(ctx.db, r.id)).toEqual({ ok: true, name: "대표 홈페이지" });
    expect(await ctx.db.select().from(scanResults)).toHaveLength(0);
    expect(await ctx.db.select().from(notifications)).toHaveLength(0);
    expect((await deleteAsset(ctx.db, r.id)).ok).toBe(false);
    expect(await ctx.db.select().from(indicators).where(eq(indicators.value, "x"))).toHaveLength(0);
  });
});
