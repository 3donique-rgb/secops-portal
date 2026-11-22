import { cache } from "react";
import { cookies } from "next/headers";
import { forbidden, redirect } from "next/navigation";
import { connection } from "next/server";
import { getDb } from "@/db";
import { SESSION_COOKIE, getSessionUser, type SessionUser } from "@/lib/auth";

/** 현재 로그인한 사용자(없으면 null). 요청마다 DB에서 다시 확인한다 (잠금·삭제·권한 변경이 바로 반영). */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  await connection();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return getSessionUser(getDb(), token);
});

/** 로그인하지 않았으면 /login 으로 보낸다. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

/** 관리자가 아니면 403 화면. */
export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== "admin") forbidden();
  return user;
}
