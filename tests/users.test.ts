import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { users } from "../db/schema";
import { MAX_FAILED_ATTEMPTS, createSessionToken, getSessionUser, recordFailedAttempt, verifyCredentials } from "../lib/auth";
import { listAudit, writeAudit } from "../lib/audit";
import {
  addAllowedIp,
  createUser,
  deleteUsers,
  listAllowedIps,
  listUsers,
  removeAllowedIp,
  resetOtp,
  setUserRole,
  unlockAccount,
  updateUser,
} from "../lib/users";
import { createTestDb, resetData } from "./helpers/test-db";

/**
 * 시험 사례 표
 *  1. 사용자 생성          → viewer 기본, 해시 저장, 로그인 가능 / 중복 아이디·짧은 비밀번호·잘못된 아이디 거부
 *  2. 권한 변경            → viewer→admin 가능, 마지막 관리자를 viewer로 낮추면 거부, 관리자가 둘이면 가능
 *  3. 잠금 해제            → 잠긴 계정이 풀리고 실패 횟수 0, 올바른 비밀번호로 로그인 가능
 *  4. OTP 초기화           → otp_enabled=false, 비밀키 삭제
 *  5. 허용 IP 등록         → 표준 표기로 저장(1.2.3.4 → 1.2.3.4/32), 중복·형식 오류 거부, 삭제는 해당 사용자 것만
 *  6. 감사 로그            → 기록·필터(종류, 키워드, 기간)·페이지, 사용자 삭제 후에도 기록 유지
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

const PW = "correct-horse-1";
async function mk(username: string, role: "admin" | "viewer" = "viewer") {
  const r = await createUser(ctx.db, { username, name: username, password: PW, role });
  if (!r.ok) throw new Error(r.message);
  return r.id;
}

describe("사용자 관리", () => {
  it("사용자를 만들면 로그인할 수 있고 비밀번호는 해시로 저장된다", async () => {
    const id = await mk("alice");
    const [row] = await ctx.db.select().from(users).where(eq(users.id, id));
    expect(row.role).toBe("viewer");
    expect(row.passwordHash).not.toContain(PW);
    expect((await verifyCredentials(ctx.db, "alice", PW)).ok).toBe(true);
  });

  it("중복 아이디·잘못된 아이디·짧은 비밀번호는 거부한다", async () => {
    await mk("alice");
    expect((await createUser(ctx.db, { username: "alice", name: "x", password: PW, role: "viewer" })).ok).toBe(false);
    expect((await createUser(ctx.db, { username: "a b", name: "x", password: PW, role: "viewer" })).ok).toBe(false);
    expect((await createUser(ctx.db, { username: "bob", name: "x", password: "short", role: "viewer" })).ok).toBe(false);
    expect(await listUsers(ctx.db)).toHaveLength(1);
  });

  it("마지막 관리자는 조회 전용으로 낮출 수 없다", async () => {
    const a = await mk("admin1", "admin");
    const v = await mk("viewer1");
    expect((await setUserRole(ctx.db, a, "viewer")).ok).toBe(false);
    expect((await setUserRole(ctx.db, v, "admin")).ok).toBe(true);
    expect((await setUserRole(ctx.db, a, "viewer")).ok).toBe(true);
    const roles = Object.fromEntries((await listUsers(ctx.db)).map((u) => [u.username, u.role]));
    expect(roles).toEqual({ admin1: "viewer", viewer1: "admin" });
  });

  it("잠금 해제하면 다시 로그인할 수 있다", async () => {
    const id = await mk("alice");
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) await recordFailedAttempt(ctx.db, id);
    expect(await verifyCredentials(ctx.db, "alice", PW)).toEqual({ ok: false, reason: "locked" });
    expect((await unlockAccount(ctx.db, id)).ok).toBe(true);
    expect((await verifyCredentials(ctx.db, "alice", PW)).ok).toBe(true);
    expect((await unlockAccount(ctx.db, "00000000-0000-0000-0000-000000000000")).ok).toBe(false);
  });

  it("OTP를 초기화하면 등록 상태와 비밀키가 지워진다", async () => {
    const id = await mk("alice");
    await ctx.db.update(users).set({ otpEnabled: true, otpSecretEnc: "v1:x" }).where(eq(users.id, id));
    expect((await resetOtp(ctx.db, id)).ok).toBe(true);
    const [row] = await ctx.db.select().from(users).where(eq(users.id, id));
    expect(row.otpEnabled).toBe(false);
    expect(row.otpSecretEnc).toBeNull();
  });
});

describe("허용 IP", () => {
  it("표준 표기로 저장하고 중복·형식 오류를 거부한다", async () => {
    const id = await mk("alice");
    const r = await addAllowedIp(ctx.db, id, " 203.0.113.5 ", "사무실", null);
    expect(r).toEqual({ ok: true, cidr: "203.0.113.5/32" });
    expect((await addAllowedIp(ctx.db, id, "203.0.113.5/32", null, null)).ok).toBe(false);
    expect((await addAllowedIp(ctx.db, id, "203.0.113.77/24", null, null))).toEqual({ ok: true, cidr: "203.0.113.0/24" });
    for (const bad of ["", "abc", "1.2.3.4/33", "1.2.3.4/8/9", "999.1.1.1"]) {
      expect((await addAllowedIp(ctx.db, id, bad, null, null)).ok).toBe(false);
    }
    expect((await listAllowedIps(ctx.db, id)).map((x) => x.cidr)).toEqual(["203.0.113.5/32", "203.0.113.0/24"]);
  });

  it("삭제는 해당 사용자의 항목만 지운다", async () => {
    const a = await mk("alice");
    const b = await mk("bob");
    await addAllowedIp(ctx.db, a, "203.0.113.5", null, null);
    const [item] = await listAllowedIps(ctx.db, a);
    expect((await removeAllowedIp(ctx.db, b, item.id)).ok).toBe(false);
    expect((await listAllowedIps(ctx.db, a))).toHaveLength(1);
    expect((await removeAllowedIp(ctx.db, a, item.id)).ok).toBe(true);
    expect(await listAllowedIps(ctx.db, a)).toHaveLength(0);
  });
});

describe("감사 로그", () => {
  it("기록하고 종류·키워드·기간·페이지로 조회한다", async () => {
    const id = await mk("alice");
    const t = (d: number) => new Date(Date.UTC(2026, 10, d));
    await writeAudit(ctx.db, { userId: id, action: "login_success", ip: "203.0.113.5", now: t(1) });
    await writeAudit(ctx.db, { userId: null, action: "login_fail", target: "ghost", ip: "198.51.100.9", now: t(2) });
    await writeAudit(ctx.db, { userId: id, action: "ip_add", target: "alice", detail: { cidr: "1.2.3.4/32" }, now: t(3) });

    const all = await listAudit(ctx.db);
    expect(all.total).toBe(3);
    expect(all.rows.map((r) => r.action)).toEqual(["ip_add", "login_fail", "login_success"]); // 최신순
    expect((await listAudit(ctx.db, { action: "login_fail" })).rows).toHaveLength(1);
    expect((await listAudit(ctx.db, { keyword: "ghost" })).rows).toHaveLength(1);
    expect((await listAudit(ctx.db, { keyword: "alice" })).total).toBe(2); // 사용자명 일치(2건), 대상 alice 포함
    expect((await listAudit(ctx.db, { from: t(2), to: t(3) })).rows.map((r) => r.action)).toEqual(["login_fail"]);
    expect((await listAudit(ctx.db, { pageSize: 2, page: 2 })).rows).toHaveLength(1);
    expect((await listAudit(ctx.db, { keyword: "%" })).total).toBe(0); // 와일드카드 문자는 글자 그대로 찾는다
  });

  it("사용자를 지워도 기록은 남는다", async () => {
    const id = await mk("alice");
    await writeAudit(ctx.db, { userId: id, action: "login_success" });
    await ctx.db.delete(users).where(eq(users.id, id));
    const r = await listAudit(ctx.db);
    expect(r.total).toBe(1);
    expect(r.rows[0].username).toBeNull();
  });
});

describe("계정 수정·OTP 사용 여부", () => {
  const SECRET = "x".repeat(40);
  it("OTP 없이 만든 계정은 OTP 등록 없이도 세션이 유효", async () => {
    const r = await createUser(ctx.db, { username: "noop", name: "n", password: PW, role: "viewer", otpRequired: false });
    if (!r.ok) throw new Error(r.message);
    const tok = await createSessionToken(r.id, new Date(), SECRET);
    expect((await getSessionUser(ctx.db, tok, new Date(), SECRET))?.username).toBe("noop");
    const r2 = await createUser(ctx.db, { username: "withop", name: "w", password: PW, role: "viewer" });
    if (!r2.ok) throw new Error(r2.message);
    const tok2 = await createSessionToken(r2.id, new Date(), SECRET);
    expect(await getSessionUser(ctx.db, tok2, new Date(), SECRET)).toBeNull();
    expect((await listUsers(ctx.db)).find((u) => u.username === "noop")?.otpRequired).toBe(false);
  });
  it("수정: 이름·OTP·비밀번호·권한", async () => {
    const a = await mk("adm", "admin");
    const b = await mk("usr");
    await recordFailedAttempt(ctx.db, b);
    const r = await updateUser(ctx.db, b, { name: "새이름", role: "admin", otpRequired: false, password: "another-pass-99" });
    expect(r.ok).toBe(true);
    const [u] = await ctx.db.select().from(users).where(eq(users.id, b));
    expect(u).toMatchObject({ name: "새이름", role: "admin", otpRequired: false, failedCount: 0 });
    expect((await verifyCredentials(ctx.db, "usr", "another-pass-99")).ok).toBe(true);
    // 비밀번호 비워 두면 유지, 짧으면 거부, 이름 비면 거부
    expect((await updateUser(ctx.db, b, { name: "x", role: "admin", otpRequired: true })).ok).toBe(true);
    expect((await verifyCredentials(ctx.db, "usr", "another-pass-99")).ok).toBe(true);
    expect((await updateUser(ctx.db, b, { name: "x", role: "admin", otpRequired: true, password: "short" })).ok).toBe(false);
    expect((await updateUser(ctx.db, b, { name: " ", role: "admin", otpRequired: true })).ok).toBe(false);
    // 관리자가 둘일 때만 낮출 수 있고, 마지막 관리자는 거부
    expect((await updateUser(ctx.db, b, { name: "x", role: "viewer", otpRequired: true })).ok).toBe(true);
    expect((await updateUser(ctx.db, a, { name: "adm", role: "viewer", otpRequired: true })).ok).toBe(false);
  });
});

describe("계정 삭제", () => {
  it("여러 명 삭제, 본인 제외, 마지막 관리자 보호, 감사 로그 유지", async () => {
    const a1 = await mk("adm1", "admin");
    const a2 = await mk("adm2", "admin");
    const u1 = await mk("user1");
    const u2 = await mk("user2");
    await writeAudit(ctx.db, { userId: u1, action: "login_success" });
    expect((await deleteUsers(ctx.db, [], a1)).ok).toBe(false);
    expect((await deleteUsers(ctx.db, [a1], a1)).ok).toBe(false);
    expect((await deleteUsers(ctx.db, [a1, a2], u1)).ok).toBe(false); // 관리자가 0명이 됨
    const r = await deleteUsers(ctx.db, [u1, u2, a1], a1);
    expect(r.ok && r.deleted.sort()).toEqual(["user1", "user2"]);
    expect(r.ok && r.skippedSelf).toBe(true);
    expect((await listUsers(ctx.db)).map((u) => u.username)).toEqual(["adm1", "adm2"]);
    expect((await deleteUsers(ctx.db, [a2], a1)).ok).toBe(true); // 본인(a1)이 남으니 가능
    const left = await ctx.db.select().from((await import("../db/schema")).auditLogs);
    expect(left.length).toBe(1);
    expect(left[0].userId).toBeNull();
  });
});
