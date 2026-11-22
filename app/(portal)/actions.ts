"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { SESSION_COOKIE, getClientIp } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";
import { getCurrentUser } from "@/lib/session";

export async function logoutAction() {
  const user = await getCurrentUser();
  if (user) {
    await writeAudit(getDb(), { userId: user.id, action: "logout", target: user.username, ip: getClientIp(await headers()) });
  }
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}
