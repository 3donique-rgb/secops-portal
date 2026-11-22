"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { createAsset, deleteAsset, updateAsset, type AssetInput } from "@/lib/assets";
import { getClientIp } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";
import { requireAdmin } from "@/lib/session";
import type { ActionState } from "@/components/action-form";

function readForm(fd: FormData): AssetInput {
  const s = (k: string) => String(fd.get(k) ?? "");
  return {
    name: s("name"), target: s("target"), owner: s("owner"), department: s("department"), memo: s("memo"),
    importance: Number.parseInt(s("importance"), 10), scanLevel: Number.parseInt(s("scanLevel"), 10),
    scanPermitted: fd.get("scanPermitted") === "on", enabled: fd.get("enabled") === "on",
  };
}

export async function createAssetAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const db = getDb();
  const input = readForm(fd);
  const r = await createAsset(db, input);
  if (!r.ok) return { ok: false, message: r.message };
  await writeAudit(db, { userId: admin.id, action: "asset_create", target: input.target.trim().slice(0, 200), detail: { name: input.name.trim() }, ip: getClientIp(await headers()) });
  revalidatePath("/assets");
  redirect(`/assets/${r.id}`);
}

export async function updateAssetAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const db = getDb();
  const id = String(fd.get("id") ?? "");
  const input = readForm(fd);
  const r = await updateAsset(db, id, input);
  if (!r.ok) return { ok: false, message: r.message };
  await writeAudit(db, { userId: admin.id, action: "asset_update", target: input.target.trim().slice(0, 200), detail: { name: input.name.trim(), scanLevel: input.scanLevel }, ip: getClientIp(await headers()) });
  revalidatePath("/assets");
  revalidatePath(`/assets/${id}`);
  redirect(`/assets/${id}`);
}

export async function deleteAssetAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const db = getDb();
  const r = await deleteAsset(db, String(fd.get("id") ?? ""));
  if (!r.ok) return { ok: false, message: r.message };
  await writeAudit(db, { userId: admin.id, action: "asset_delete", target: r.name, ip: getClientIp(await headers()) });
  revalidatePath("/assets");
  redirect("/assets");
}
