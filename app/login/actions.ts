"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import {
  LOGIN_ERROR_MESSAGE,
  PRE_AUTH_COOKIE,
  PRE_AUTH_TTL_SECONDS,
  checkAllowedIp,
  cookieOptions,
  createPreAuthToken,
  getClientIp,
  verifyCredentials,
} from "@/lib/auth";

export type LoginState = { error: string | null };

/**
 * 1차 인증: 아이디·비밀번호 확인 → 허용 IP 확인 → 임시 토큰(5분) 발급 → OTP 화면.
 * 틀린 이유(아이디/비밀번호)는 알려 주지 않는다.
 */
export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const username = String(formData.get("username") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!username || !password || username.length > 64 || password.length > 256) {
    return { error: LOGIN_ERROR_MESSAGE };
  }

  const db = getDb();
  const result = await verifyCredentials(db, username, password);
  if (!result.ok) {
    return {
      error:
        result.reason === "locked"
          ? "계정이 잠겼습니다. 관리자에게 잠금 해제를 요청하세요."
          : LOGIN_ERROR_MESSAGE,
    };
  }

  const ip = getClientIp(await headers());
  const ipCheck = await checkAllowedIp(db, result.user, ip);
  if (!ipCheck.allowed) {
    return {
      error:
        ipCheck.reason === "not_registered"
          ? "이 계정에는 로그인이 허용된 IP가 등록되어 있지 않습니다. 관리자에게 문의하세요."
          : "허용되지 않은 IP에서의 접속입니다. 관리자에게 문의하세요.",
    };
  }

  const token = await createPreAuthToken(result.user.id);
  (await cookies()).set(PRE_AUTH_COOKIE, token, cookieOptions(PRE_AUTH_TTL_SECONDS));
  redirect("/login/otp");
}
