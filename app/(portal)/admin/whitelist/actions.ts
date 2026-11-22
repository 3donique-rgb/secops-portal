"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { getDb } from "@/db";
import { getClientIp } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";
import { requireAdmin } from "@/lib/session";
import { addWhitelist, removeWhitelist } from "@/lib/whitelist";
import type { ActionState } from "@/components/action-form";

export async function addWhitelistAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const db = getDb();
  const r = await addWhitelist(db, {
    type: String(fd.get("type") ?? ""),
    value: String(fd.get("value") ?? ""),
    reason: String(fd.get("reason") ?? ""),
    createdBy: admin.id,
  });
  if (!r.ok) return { ok: false, message: r.message };
  await writeAudit(db, {
    userId: admin.id,
    action: "whitelist_add",
    target: r.value,
    detail: { type: String(fd.get("type")), newlyExcluded: r.excluded },
    ip: getClientIp(await headers()),
  });
  revalidatePath("/admin/whitelist");
  return { ok: true, message: `추가했습니다. SIEM 제공에서 새로 제외된 지표: ${r.excluded}건` };
}

export async function removeWhitelistAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const db = getDb();
  const r = await removeWhitelist(db, String(fd.get("id") ?? ""));
  if (!r.ok) return { ok: false, message: r.message };
  await writeAudit(db, {
    userId: admin.id,
    action: "whitelist_remove",
    target: r.value,
    detail: { restored: r.included },
    ip: getClientIp(await headers()),
  });
  revalidatePath("/admin/whitelist");
  return { ok: true, message: `삭제했습니다. 다시 제공 대상이 된 지표: ${r.included}건` };
}
