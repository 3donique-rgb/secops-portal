"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { inArray } from "drizzle-orm";
import { assets } from "@/db/schema";
import { MAX_MANUAL, dispatchScan } from "@/lib/scan-dispatch";
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

/** 선택한 자산을 지금 점검 (GitHub Actions 실행 요청). 관리자만. */
export async function requestScanAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const ids = [...new Set(fd.getAll("ids").map(String))].filter((x) => UUID.test(x));
  if (ids.length === 0) return { ok: false, message: "점검할 자산을 하나 이상 선택하세요." };
  if (ids.length > MAX_MANUAL) return { ok: false, message: `한 번에 ${MAX_MANUAL}개까지 선택할 수 있습니다.` };
  const db = getDb();
  const rows = await db.select().from(assets).where(inArray(assets.id, ids));
  const ok = rows.filter((a) => a.enabled && a.scanPermitted);
  if (ok.length === 0) return { ok: false, message: "선택한 자산은 모두 '점검 사용'이 꺼져 있어 점검할 수 없습니다." };
  const res = await dispatchScan(ok.map((a) => a.id), process.env.GITHUB_DISPATCH_TOKEN);
  if (!res.ok) return res;
  await writeAudit(db, { userId: admin.id, action: "scan_request", target: `${ok.length}개 자산`, detail: { names: ok.slice(0, 20).map((a) => a.name) }, ip: getClientIp(await headers()) });
  const skipped = ids.length - ok.length;
  return { ok: true, message: `${ok.length}개 자산의 점검을 요청했습니다.${skipped > 0 ? ` (점검 사용이 꺼진 ${skipped}개는 제외)` : ""} 보통 2~10분 뒤 각 자산 화면에 결과가 나타납니다.` };
}
