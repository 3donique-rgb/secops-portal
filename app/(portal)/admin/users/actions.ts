"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { getDb } from "@/db";
import { getClientIp } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";
import { requireAdmin } from "@/lib/session";
import {
  addAllowedIp,
  createUser,
  removeAllowedIp,
  resetOtp,
  setUserRole,
  unlockAccount,
} from "@/lib/users";
import { getUsername } from "./queries";
import type { ActionState } from "@/components/action-form";

const fail = (message: string): ActionState => ({ ok: false, message });
const done = (message: string): ActionState => ({ ok: true, message });

// 모든 동작은 화면과 별개로 직접 호출될 수 있으므로, 매번 관리자 권한을 다시 확인한다.

export async function createUserAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const db = getDb();
  const role = fd.get("role") === "admin" ? "admin" : "viewer";
  const r = await createUser(db, {
    username: String(fd.get("username") ?? ""),
    name: String(fd.get("name") ?? ""),
    password: String(fd.get("password") ?? ""),
    role,
  });
  if (!r.ok) return fail(r.message);
  await writeAudit(db, {
    userId: admin.id, action: "user_create", target: String(fd.get("username")).trim(),
    detail: { role }, ip: getClientIp(await headers()),
  });
  revalidatePath("/admin/users");
  return done("사용자를 만들었습니다. 첫 로그인 때 OTP를 등록합니다.");
}

export async function setRoleAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const db = getDb();
  const userId = String(fd.get("userId"));
  const role = fd.get("role") === "admin" ? "admin" : "viewer";
  const r = await setUserRole(db, userId, role);
  if (!r.ok) return fail(r.message);
  await writeAudit(db, {
    userId: admin.id, action: "user_role_change", target: await getUsername(userId),
    detail: { role }, ip: getClientIp(await headers()),
  });
  revalidatePath("/admin/users");
  return done("권한을 바꿨습니다.");
}

export async function unlockAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const db = getDb();
  const userId = String(fd.get("userId"));
  const r = await unlockAccount(db, userId);
  if (!r.ok) return fail(r.message);
  await writeAudit(db, { userId: admin.id, action: "user_unlock", target: await getUsername(userId), ip: getClientIp(await headers()) });
  revalidatePath("/admin/users");
  return done("잠금을 풀었습니다.");
}

export async function resetOtpAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const db = getDb();
  const userId = String(fd.get("userId"));
  const r = await resetOtp(db, userId);
  if (!r.ok) return fail(r.message);
  await writeAudit(db, { userId: admin.id, action: "user_otp_reset", target: await getUsername(userId), ip: getClientIp(await headers()) });
  revalidatePath("/admin/users");
  return done("OTP를 초기화했습니다. 다음 로그인 때 다시 등록합니다.");
}

export async function addIpAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const db = getDb();
  const userId = String(fd.get("userId"));
  const r = await addAllowedIp(db, userId, String(fd.get("cidr") ?? ""), String(fd.get("memo") ?? ""), admin.id);
  if (!r.ok) return fail(r.message);
  await writeAudit(db, {
    userId: admin.id, action: "ip_add", target: await getUsername(userId),
    detail: { cidr: r.cidr }, ip: getClientIp(await headers()),
  });
  revalidatePath(`/admin/users/${userId}`);
  return done(`${r.cidr} 를 등록했습니다.`);
}

export async function removeIpAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const db = getDb();
  const userId = String(fd.get("userId"));
  const r = await removeAllowedIp(db, userId, String(fd.get("ipId")));
  if (!r.ok) return fail(r.message);
  await writeAudit(db, {
    userId: admin.id, action: "ip_remove", target: await getUsername(userId),
    detail: { cidr: r.cidr }, ip: getClientIp(await headers()),
  });
  revalidatePath(`/admin/users/${userId}`);
  return done("삭제했습니다.");
}
