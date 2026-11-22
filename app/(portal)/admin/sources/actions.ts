"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { getClientIp } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";
import { requireAdmin } from "@/lib/session";
import { SOURCE_PRESETS, createSource, setSourceEnabled, updateSource, type SourceInput } from "@/lib/sources";
import type { ActionState } from "@/components/action-form";

function readForm(fd: FormData): SourceInput {
  return {
    name: String(fd.get("name") ?? ""),
    kind: String(fd.get("kind") ?? ""),
    url: String(fd.get("url") ?? ""),
    configText: String(fd.get("config") ?? ""),
    apiKey: String(fd.get("apiKey") ?? "") || undefined,
    clearApiKey: fd.get("clearApiKey") === "on",
    enabled: fd.get("enabled") === "on",
  };
}

export async function createSourceAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const db = getDb();
  const input = readForm(fd);
  const r = await createSource(db, input);
  if (!r.ok) return { ok: false, message: r.message };
  await writeAudit(db, { userId: admin.id, action: "source_create", target: input.name.trim(), detail: { kind: input.kind }, ip: getClientIp(await headers()) });
  revalidatePath("/admin/sources");
  redirect(`/admin/sources/${r.id}`);
}

export async function addPresetAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const preset = SOURCE_PRESETS.find((p) => p.name === String(fd.get("preset")));
  if (!preset) return { ok: false, message: "예시를 찾을 수 없습니다." };
  const db = getDb();
  const r = await createSource(db, {
    name: preset.name, kind: preset.kind, url: preset.url, configText: JSON.stringify(preset.config), enabled: false,
  });
  if (!r.ok) return { ok: false, message: r.message };
  await writeAudit(db, { userId: admin.id, action: "source_create", target: preset.name, detail: { preset: true }, ip: getClientIp(await headers()) });
  revalidatePath("/admin/sources");
  return { ok: true, message: "추가했습니다(사용 안 함 상태). 주소·이용 조건을 확인한 뒤 '사용'으로 바꾸세요." };
}

export async function updateSourceAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const db = getDb();
  const id = String(fd.get("id") ?? "");
  const input = readForm(fd);
  const r = await updateSource(db, id, input);
  if (!r.ok) return { ok: false, message: r.message };
  await writeAudit(db, {
    userId: admin.id, action: "source_update", target: input.name.trim(),
    detail: { enabled: input.enabled, keyChanged: Boolean(input.apiKey) || input.clearApiKey }, ip: getClientIp(await headers()),
  });
  revalidatePath("/admin/sources");
  revalidatePath(`/admin/sources/${id}`);
  return { ok: true, message: "저장했습니다. 다음 수집(매시간)부터 적용됩니다." };
}

export async function toggleSourceAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const db = getDb();
  const enabled = fd.get("enabled") === "true";
  const r = await setSourceEnabled(db, String(fd.get("id") ?? ""), enabled);
  if (!r.ok) return { ok: false, message: r.message };
  await writeAudit(db, { userId: admin.id, action: "source_update", target: String(fd.get("name") ?? ""), detail: { enabled }, ip: getClientIp(await headers()) });
  revalidatePath("/admin/sources");
  return { ok: true, message: enabled ? "사용으로 바꿨습니다." : "사용 안 함으로 바꿨습니다." };
}
