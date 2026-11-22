"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { getDb } from "@/db";
import { createApiKey, revokeApiKey } from "@/lib/api-keys";
import { getClientIp } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";
import { requireAdmin } from "@/lib/session";
import type { ActionState } from "@/components/action-form";

export async function createKeyAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const db = getDb();
  const r = await createApiKey(db, { name: String(fd.get("name") ?? ""), createdBy: admin.id });
  if (!r.ok) return { ok: false, message: r.message };
  // 키 원문은 감사 로그에도 남기지 않는다
  await writeAudit(db, { userId: admin.id, action: "apikey_create", target: String(fd.get("name")).trim().slice(0, 100), ip: getClientIp(await headers()) });
  revalidatePath("/admin/siem");
  return { ok: true, message: `발급된 키 (지금 한 번만 표시됩니다. 복사해 두세요): ${r.key}` };
}

export async function revokeKeyAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const db = getDb();
  const r = await revokeApiKey(db, String(fd.get("id") ?? ""));
  if (!r.ok) return { ok: false, message: r.message };
  await writeAudit(db, { userId: admin.id, action: "apikey_revoke", target: r.name, ip: getClientIp(await headers()) });
  revalidatePath("/admin/siem");
  return { ok: true, message: "폐기했습니다. 이 키로는 더 이상 접속할 수 없습니다." };
}
