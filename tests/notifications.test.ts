import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assets, notifications } from "../db/schema";
import { listNotifications, markAllRead, markRead, unreadCount } from "../lib/notifications";
import { createTestDb, resetData } from "./helpers/test-db";

/**
 * 시험 사례 표
 *  1. 미확인 개수      → 읽지 않은 것만 센다
 *  2. 목록             → 최신순, 자산명 포함, 전체/읽지 않음 필터, 쪽 나누기
 *  3. 읽음 처리        → 한 건, 이미 읽은 건은 false, 모두 읽음 후 개수 0
 */
let ctx: Awaited<ReturnType<typeof createTestDb>>;
let assetId: string;
beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.client.close();
});
beforeEach(async () => {
  await resetData(ctx.client);
  const [a] = await ctx.db.insert(assets).values({ name: "홈페이지", target: "www.corp.example", importance: 3, scanLevel: 3, scanPermitted: true }).returning();
  assetId = a.id;
  const t = (h: number) => new Date(Date.UTC(2026, 10, 22, h));
  await ctx.db.insert(notifications).values([
    { kind: "port_opened", assetId, message: "22/tcp 열림", occurredAt: t(1) },
    { kind: "cert_expiring", assetId, message: "인증서 12일 남음", occurredAt: t(2) },
    { kind: "asset_down", assetId, message: "접속 불가", occurredAt: t(3), read: true },
  ]);
});

describe("알림", () => {
  it("읽지 않은 개수와 목록(최신순, 필터, 쪽 나누기)", async () => {
    expect(await unreadCount(ctx.db)).toBe(2);
    const all = await listNotifications(ctx.db);
    expect(all.rows.map((r) => r.message)).toEqual(["접속 불가", "인증서 12일 남음", "22/tcp 열림"]);
    expect(all.rows[0].assetName).toBe("홈페이지");
    expect((await listNotifications(ctx.db, { unreadOnly: true })).total).toBe(2);
    const p2 = await listNotifications(ctx.db, { pageSize: 2, page: 2 });
    expect(p2.rows).toHaveLength(1);
    expect(p2.total).toBe(3);
  });

  it("읽음 처리", async () => {
    const unread = (await listNotifications(ctx.db, { unreadOnly: true })).rows;
    expect(await markRead(ctx.db, unread[0].id)).toBe(true);
    expect(await markRead(ctx.db, unread[0].id)).toBe(false); // 이미 읽음
    expect(await unreadCount(ctx.db)).toBe(1);
    expect(await markAllRead(ctx.db)).toBe(1);
    expect(await unreadCount(ctx.db)).toBe(0);
    expect(await markAllRead(ctx.db)).toBe(0);
  });
});
