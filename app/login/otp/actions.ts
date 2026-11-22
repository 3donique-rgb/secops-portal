"use server";

import { eq } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { writeAudit } from "@/lib/audit";
import { users } from "@/db/schema";
import {
  PRE_AUTH_COOKIE,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  checkAllowedIp,
  confirmOtpSetup,
  cookieOptions,
  createSessionToken,
  getClientIp,
  readPreAuthToken,
  resetFailedCount,
  verifyUserOtp,
} from "@/lib/auth";

export type OtpState = { error: string | null };

/**
 * 2차 인증. OTP가 등록된 계정은 코드를 확인하고, 처음이면 등록을 완료한다.
 * 성공하면 임시 토큰을 지우고 세션(8시간)을 발급한다.
 */
export async function otpAction(_prev: OtpState, formData: FormData): Promise<OtpState> {
  const jar = await cookies();
  const db = getDb();
  const userId = await readPreAuthToken(jar.get(PRE_AUTH_COOKIE)?.value);
  if (!userId) redirect("/login");

  const code = String(formData.get("code") ?? "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(code)) return { error: "6자리 숫자를 입력하세요." };

  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user || user.locked) {
    jar.delete(PRE_AUTH_COOKIE);
    redirect("/login");
  }

  // 임시 토큰을 받은 뒤 IP 설정이 바뀌었을 수 있으므로 다시 확인한다.
  const ip = getClientIp(await headers());
  const ipCheck = await checkAllowedIp(db, user, ip);
  if (!ipCheck.allowed) {
    await writeAudit(db, { userId: user.id, action: "login_ip_denied", target: user.username, detail: { step: "otp" }, ip });
    jar.delete(PRE_AUTH_COOKIE);
    redirect("/login");
  }

  if (user.otpEnabled) {
    const r = await verifyUserOtp(db, user.id, code);
    if (!r.ok) {
      await writeAudit(db, {
        userId: user.id,
        action: r.reason === "locked" ? "login_locked" : "login_fail",
        target: user.username,
        detail: { step: "otp" },
        ip,
      });
      if (r.reason === "locked") {
        jar.delete(PRE_AUTH_COOKIE);
        return { error: "실패가 누적되어 계정이 잠겼습니다. 관리자에게 잠금 해제를 요청하세요." };
      }
      return { error: "OTP 코드가 올바르지 않습니다." };
    }
  } else {
    const ok = await confirmOtpSetup(db, user.id, code);
    if (!ok) {
      await writeAudit(db, { userId: user.id, action: "login_fail", target: user.username, detail: { step: "otp_setup" }, ip });
      return { error: "코드가 올바르지 않습니다. 앱에 표시된 최신 코드를 입력하세요." };
    }
  }

  await resetFailedCount(db, user.id);
  await writeAudit(db, { userId: user.id, action: "login_success", target: user.username, ip });
  jar.delete(PRE_AUTH_COOKIE);
  jar.set(SESSION_COOKIE, await createSessionToken(user.id), cookieOptions(SESSION_TTL_SECONDS));
  redirect("/");
}
