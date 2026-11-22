import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { users } from "../db/schema";
import {
  MAX_FAILED_ATTEMPTS,
  hashPassword,
  recordFailedAttempt,
  resetFailedCount,
  unlockUser,
  validatePassword,
  verifyCredentials,
  verifyPassword,
} from "../lib/auth";
import { createTestDb, resetData } from "./helpers/test-db";

/**
 * 시험 사례 표 (2.9 비밀번호·잠금 부분. OTP·허용 IP·세션은 2.13에서 이 파일에 이어서 추가)
 *  1. 비밀번호 해시 후 검증         → 맞는 비밀번호 true, 틀린 비밀번호 false, 해시는 매번 다름
 *  2. 비밀번호 규칙                 → 9자 거부, 10자 허용, 129자 거부
 *  3. 올바른 아이디·비밀번호        → ok
 *  4. 없는 아이디                   → invalid (잘못된 비밀번호와 같은 결과)
 *  5. 틀린 비밀번호 4번              → 아직 잠기지 않음, 5번째에 잠김
 *  6. 잠긴 계정 + 맞는 비밀번호     → locked
 *  7. 잠긴 계정 + 틀린 비밀번호     → invalid (잠김 여부를 알려 주지 않음)
 *  8. 비밀번호 확인 성공            → 실패 횟수는 그대로 (OTP까지 통과해야 초기화)
 *  9. resetFailedCount              → 0으로, 마지막 로그인 시각 기록
 * 10. 관리자가 잠금 해제            → 다시 로그인 가능
 * 11. 동시에 5번 실패               → 횟수가 빠지지 않고 잠김
 */
let ctx: Awaited<ReturnType<typeof createTestDb>>;
const PASSWORD = "correct-horse-battery";

beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.client.close();
});
beforeEach(async () => {
  await resetData(ctx.client);
});

async function makeUser(username = "analyst1") {
  const [u] = await ctx.db
    .insert(users)
    .values({
      username,
      name: "담당자",
      passwordHash: await hashPassword(PASSWORD),
      role: "viewer",
    })
    .returning();
  return u;
}
const getUser = async (id: string) =>
  (await ctx.db.select().from(users).where(eq(users.id, id)))[0];

describe("비밀번호 해시", () => {
  it("맞는 비밀번호만 통과하고 해시는 매번 달라진다", async () => {
    const h1 = await hashPassword(PASSWORD);
    const h2 = await hashPassword(PASSWORD);
    expect(h1).not.toBe(h2);
    expect(h1.startsWith("$argon2id$")).toBe(true);
    expect(h1).not.toContain(PASSWORD);
    expect(await verifyPassword(h1, PASSWORD)).toBe(true);
    expect(await verifyPassword(h1, PASSWORD + "x")).toBe(false);
    expect(await verifyPassword(h1, "")).toBe(false);
    expect(await verifyPassword("not-a-hash", PASSWORD)).toBe(false);
  });

  it("비밀번호 규칙: 10자 이상 128자 이하", () => {
    expect(validatePassword("a".repeat(9))).not.toBeNull();
    expect(validatePassword("a".repeat(10))).toBeNull();
    expect(validatePassword("a".repeat(128))).toBeNull();
    expect(validatePassword("a".repeat(129))).not.toBeNull();
  });
});

describe("verifyCredentials (1차 인증과 5회 잠금)", () => {
  it("올바른 아이디·비밀번호는 통과한다", async () => {
    const u = await makeUser();
    const r = await verifyCredentials(ctx.db, "analyst1", PASSWORD);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.user.id).toBe(u.id);
  });

  it("없는 아이디와 틀린 비밀번호는 같은 결과(invalid)다", async () => {
    await makeUser();
    expect(await verifyCredentials(ctx.db, "nobody", PASSWORD)).toEqual({ ok: false, reason: "invalid" });
    expect(await verifyCredentials(ctx.db, "analyst1", "wrong-password")).toEqual({ ok: false, reason: "invalid" });
  });

  it("틀린 비밀번호가 5번째에 계정을 잠근다", async () => {
    const u = await makeUser();
    for (let i = 1; i < MAX_FAILED_ATTEMPTS; i++) {
      await verifyCredentials(ctx.db, "analyst1", "wrong-password");
      const row = await getUser(u.id);
      expect(row.failedCount).toBe(i);
      expect(row.locked).toBe(false);
    }
    await verifyCredentials(ctx.db, "analyst1", "wrong-password");
    const locked = await getUser(u.id);
    expect(locked.failedCount).toBe(MAX_FAILED_ATTEMPTS);
    expect(locked.locked).toBe(true);
  });

  it("잠긴 계정은 맞는 비밀번호도 거부하지만(locked), 틀린 비밀번호에는 잠김 여부를 알리지 않는다(invalid)", async () => {
    const u = await makeUser();
    await ctx.db.update(users).set({ locked: true, failedCount: 5 }).where(eq(users.id, u.id));
    expect(await verifyCredentials(ctx.db, "analyst1", PASSWORD)).toEqual({ ok: false, reason: "locked" });
    expect(await verifyCredentials(ctx.db, "analyst1", "wrong-password")).toEqual({ ok: false, reason: "invalid" });
    // 잠긴 뒤의 실패는 횟수를 더 올리지 않는다
    expect((await getUser(u.id)).failedCount).toBe(5);
  });

  it("비밀번호 확인에 성공해도 실패 횟수는 초기화되지 않는다 (OTP 통과 후 초기화)", async () => {
    const u = await makeUser();
    await verifyCredentials(ctx.db, "analyst1", "wrong-password");
    await verifyCredentials(ctx.db, "analyst1", PASSWORD);
    expect((await getUser(u.id)).failedCount).toBe(1);

    const now = new Date("2026-11-22T00:00:00Z");
    await resetFailedCount(ctx.db, u.id, now);
    const after = await getUser(u.id);
    expect(after.failedCount).toBe(0);
    expect(after.lastLoginAt).toEqual(now);
  });

  it("관리자가 잠금을 풀면 다시 로그인할 수 있다", async () => {
    const u = await makeUser();
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      await verifyCredentials(ctx.db, "analyst1", "wrong-password");
    }
    expect((await verifyCredentials(ctx.db, "analyst1", PASSWORD)).ok).toBe(false);
    await unlockUser(ctx.db, u.id);
    const row = await getUser(u.id);
    expect(row).toMatchObject({ locked: false, failedCount: 0 });
    expect((await verifyCredentials(ctx.db, "analyst1", PASSWORD)).ok).toBe(true);
  });

  it("동시에 여러 번 실패해도 횟수가 빠지지 않고 잠긴다", async () => {
    const u = await makeUser();
    await Promise.all(
      Array.from({ length: MAX_FAILED_ATTEMPTS }, () => recordFailedAttempt(ctx.db, u.id)),
    );
    expect(await getUser(u.id)).toMatchObject({ failedCount: MAX_FAILED_ATTEMPTS, locked: true });
  });
});
