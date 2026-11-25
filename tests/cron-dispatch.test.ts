import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cronConfig } from "../db/schema";
import { CRON_SCHEDULES, CRON_WORKFLOWS, handleCronDispatch, secretMatches } from "../lib/cron-dispatch";
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
  await ctx.db.insert(cronConfig).values({ key: "secret", value: "s3cret-value" });
});

const ok = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;

describe("정시 실행 요청", () => {
  it("비밀 값 비교", () => {
    expect(secretMatches("a", "a")).toBe(true);
    expect(secretMatches("a", "b")).toBe(false);
    expect(secretMatches(null, "a")).toBe(false);
    expect(secretMatches("a", undefined)).toBe(false);
  });
  it("맞는 비밀 값이면 GitHub에 실행 요청", async () => {
    const calls: string[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push(`${url} ${init.body}`);
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const r = await handleCronDispatch(ctx.db, { secret: "s3cret-value", workflow: "news" }, "tok", f);
    expect(r.status).toBe(200);
    expect(calls[0]).toContain("/actions/workflows/news.yml/dispatches");
  });
  it("비밀 값이 틀리거나 없으면 401, GitHub 호출 안 함", async () => {
    let called = false;
    const f = (async () => {
      called = true;
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    expect((await handleCronDispatch(ctx.db, { secret: "wrong", workflow: "news" }, "tok", f)).status).toBe(401);
    expect((await handleCronDispatch(ctx.db, { secret: null, workflow: "news" }, "tok", f)).status).toBe(401);
    expect(called).toBe(false);
    await ctx.db.delete(cronConfig);
    expect((await handleCronDispatch(ctx.db, { secret: "s3cret-value", workflow: "news" }, "tok", f)).status).toBe(401);
  });
  it("목록에 없는 작업·토큰 없음·GitHub 오류", async () => {
    expect((await handleCronDispatch(ctx.db, { secret: "s3cret-value", workflow: "ci" }, "tok", ok)).status).toBe(400);
    expect((await handleCronDispatch(ctx.db, { secret: "s3cret-value", workflow: "__proto__" }, "tok", ok)).status).toBe(400);
    expect((await handleCronDispatch(ctx.db, { secret: "s3cret-value", workflow: "news" }, undefined, ok)).status).toBe(500);
    const f403 = (async () => new Response("x", { status: 403 })) as unknown as typeof fetch;
    const r = await handleCronDispatch(ctx.db, { secret: "s3cret-value", workflow: "news" }, "tok", f403);
    expect(r.status).toBe(502);
    expect(r.body.message).toContain("권한");
  });
  it("모든 작업에 예약 시각이 있다", () => {
    expect(Object.keys(CRON_SCHEDULES).sort()).toEqual(Object.keys(CRON_WORKFLOWS).sort());
  });
});
