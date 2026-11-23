/** 관리자 화면의 사용자 관리: 생성, 권한 변경, 잠금 해제, OTP 초기화, 허용 IP. 호출 전에 관리자 권한을 확인해야 한다. */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { userAllowedIps, users } from "../db/schema";
import { hashPassword, resetUserOtp, unlockUser, validatePassword } from "./auth";
import { canonicalCidr } from "./cidr";
import type { Db } from "./indicators";

export type Result<T = object> = ({ ok: true } & T) | { ok: false; message: string };

const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;

export async function listUsers(db: Db) {
  const rows = await db
    .select({
      id: users.id,
      username: users.username,
      name: users.name,
      role: users.role,
      otpEnabled: users.otpEnabled,
      otpRequired: users.otpRequired,
      locked: users.locked,
      failedCount: users.failedCount,
      lastLoginAt: users.lastLoginAt,
      ipCount: sql<number>`(select count(*)::int from ${userAllowedIps} where ${userAllowedIps.userId} = ${users.id})`,
    })
    .from(users)
    .orderBy(asc(users.username));
  return rows;
}

export async function createUser(
  db: Db,
  input: { username: string; name: string; password: string; role: "admin" | "viewer"; otpRequired?: boolean },
): Promise<Result<{ id: string }>> {
  const username = input.username.trim();
  const name = input.name.trim();
  if (!USERNAME_RE.test(username)) return { ok: false, message: "아이디는 영문·숫자·._- 3~32자여야 합니다." };
  if (!name || name.length > 50) return { ok: false, message: "이름은 1~50자로 입력하세요." };
  if (input.role !== "admin" && input.role !== "viewer") return { ok: false, message: "권한이 올바르지 않습니다." };
  const problem = validatePassword(input.password);
  if (problem) return { ok: false, message: problem };
  const [dup] = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
  if (dup) return { ok: false, message: "이미 사용 중인 아이디입니다." };
  const [row] = await db
    .insert(users)
    .values({ username, name, passwordHash: await hashPassword(input.password), role: input.role, otpRequired: input.otpRequired ?? true })
    .returning({ id: users.id });
  return { ok: true, id: row.id };
}

/** 계정 수정: 이름, 권한, OTP 사용 여부, (입력했을 때만) 비밀번호 변경. 비밀번호를 바꾸면 실패 횟수를 0으로 되돌린다. */
export async function updateUser(
  db: Db,
  userId: string,
  input: { name: string; role: "admin" | "viewer"; otpRequired: boolean; password?: string },
): Promise<Result> {
  const name = input.name.trim();
  if (!name || name.length > 50) return { ok: false, message: "이름은 1~50자로 입력하세요." };
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return { ok: false, message: "사용자를 찾을 수 없습니다." };
  const set: Partial<typeof users.$inferInsert> = { name, otpRequired: input.otpRequired };
  if (input.password) {
    const problem = validatePassword(input.password);
    if (problem) return { ok: false, message: problem };
    set.passwordHash = await hashPassword(input.password);
    set.failedCount = 0;
  }
  if (input.role !== user.role) {
    const r = await setUserRole(db, userId, input.role);
    if (!r.ok) return r;
  }
  await db.update(users).set(set).where(eq(users.id, userId));
  return { ok: true };
}

/**
 * 계정 삭제(여러 명). 본인 계정은 건너뛰고, 관리자가 한 명도 남지 않게 되는 삭제는 거부한다.
 * 감사 로그는 사용자 칸만 비워지고 그대로 남는다.
 */
export async function deleteUsers(db: Db, ids: string[], actingId: string): Promise<Result<{ deleted: string[]; skippedSelf: boolean }>> {
  const targetIds = [...new Set(ids)].filter((i) => i !== actingId);
  const skippedSelf = targetIds.length !== new Set(ids).size;
  if (targetIds.length === 0) return { ok: false, message: skippedSelf ? "본인 계정은 삭제할 수 없습니다." : "삭제할 계정을 선택하세요." };
  const targets = await db.select({ id: users.id, username: users.username, role: users.role }).from(users).where(inArray(users.id, targetIds));
  if (targets.length === 0) return { ok: false, message: "선택한 계정을 찾을 수 없습니다." };
  const [{ n: admins }] = await db.select({ n: sql<number>`count(*)::int` }).from(users).where(eq(users.role, "admin"));
  if (admins - targets.filter((t) => t.role === "admin").length < 1) return { ok: false, message: "관리자가 한 명도 남지 않게 되므로 삭제할 수 없습니다." };
  await db.delete(users).where(inArray(users.id, targets.map((t) => t.id)));
  return { ok: true, deleted: targets.map((t) => t.username), skippedSelf };
}

/** 마지막 관리자를 viewer로 낮추는 것은 막는다 (아무도 관리할 수 없게 되므로). */
export async function setUserRole(db: Db, userId: string, role: "admin" | "viewer"): Promise<Result> {
  if (role !== "admin" && role !== "viewer") return { ok: false, message: "권한이 올바르지 않습니다." };
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return { ok: false, message: "사용자를 찾을 수 없습니다." };
  if (user.role === "admin" && role === "viewer") {
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(users)
      .where(eq(users.role, "admin"));
    if (n <= 1) return { ok: false, message: "마지막 관리자는 조회 전용으로 바꿀 수 없습니다." };
  }
  await db.update(users).set({ role }).where(eq(users.id, userId));
  return { ok: true };
}

export async function unlockAccount(db: Db, userId: string): Promise<Result> {
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return { ok: false, message: "사용자를 찾을 수 없습니다." };
  await unlockUser(db, userId);
  return { ok: true };
}

export async function resetOtp(db: Db, userId: string): Promise<Result> {
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return { ok: false, message: "사용자를 찾을 수 없습니다." };
  await resetUserOtp(db, userId);
  return { ok: true };
}

// ---- 허용 IP (3.6) ----

export async function listAllowedIps(db: Db, userId: string) {
  return db
    .select({ id: userAllowedIps.id, cidr: userAllowedIps.cidr, memo: userAllowedIps.memo, createdAt: userAllowedIps.createdAt })
    .from(userAllowedIps)
    .where(eq(userAllowedIps.userId, userId))
    .orderBy(asc(userAllowedIps.createdAt));
}

export async function addAllowedIp(
  db: Db,
  userId: string,
  cidrInput: string,
  memo: string | null,
  createdBy: string | null,
): Promise<Result<{ cidr: string }>> {
  const cidr = canonicalCidr(cidrInput.trim());
  if (!cidr) return { ok: false, message: "IP 또는 대역(예: 203.0.113.5, 203.0.113.0/24) 형식이 올바르지 않습니다." };
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return { ok: false, message: "사용자를 찾을 수 없습니다." };
  const [dup] = await db
    .select({ id: userAllowedIps.id })
    .from(userAllowedIps)
    .where(and(eq(userAllowedIps.userId, userId), eq(userAllowedIps.cidr, cidr)))
    .limit(1);
  if (dup) return { ok: false, message: "이미 등록된 IP입니다." };
  await db.insert(userAllowedIps).values({ userId, cidr, memo: memo?.trim().slice(0, 200) || null, createdBy });
  return { ok: true, cidr };
}

export async function removeAllowedIp(db: Db, userId: string, ipId: string): Promise<Result<{ cidr: string }>> {
  const rows = await db
    .delete(userAllowedIps)
    .where(and(eq(userAllowedIps.id, ipId), eq(userAllowedIps.userId, userId)))
    .returning({ cidr: userAllowedIps.cidr });
  if (rows.length === 0) return { ok: false, message: "등록된 IP를 찾을 수 없습니다." };
  return { ok: true, cidr: rows[0].cidr };
}
