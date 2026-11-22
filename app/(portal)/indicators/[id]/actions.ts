"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { getDb } from "@/db";
import { getClientIp } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";
import { indicators } from "@/db/schema";
import { eq } from "drizzle-orm";
import { lookupVirusTotal, saveReputation } from "@/lib/reputation";
import { requireAdmin, requireUser } from "@/lib/session";
import type { ActionState } from "@/components/action-form";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 평판 직접 기록: 로그인한 모든 사용자 */
export async function addReputationAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  const id = String(fd.get("id") ?? "");
  if (!UUID.test(id)) return { ok: false, message: "잘못된 요청입니다." };
  const db = getDb();
  const r = await saveReputation(db, {
    indicatorId: id,
    verdict: String(fd.get("verdict") ?? ""),
    note: String(fd.get("note") ?? ""),
    createdBy: user.id,
  });
  if (!r.ok) return r;
  await writeAudit(db, { userId: user.id, action: "reputation_add", target: id, ip: getClientIp(await headers()) });
  revalidatePath(`/indicators/${id}`);
  return { ok: true, message: "평판을 기록했습니다." };
}

/** VirusTotal API 조회: 관리자만 (키 사용량 보호). SIEM 제외 대상(우리 자산 등)은 외부로 보내지 않는다. */
export async function lookupVtAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireAdmin();
  const id = String(fd.get("id") ?? "");
  if (!UUID.test(id)) return { ok: false, message: "잘못된 요청입니다." };
  const db = getDb();
  const [ind] = await db.select().from(indicators).where(eq(indicators.id, id)).limit(1);
  if (!ind) return { ok: false, message: "위협정보를 찾을 수 없습니다." };
  if (ind.excluded) return { ok: false, message: "화이트리스트·자산과 일치하는 값은 외부(VirusTotal)로 보내지 않습니다." };
  const res = await lookupVirusTotal({ type: ind.type, value: ind.value }, process.env.VT_API_KEY);
  if (!res.ok) return { ok: false, message: res.message };
  await saveReputation(db, {
    indicatorId: id,
    verdict: res.verdict,
    origin: "virustotal",
    stats: res.stats,
    createdBy: user.id,
  });
  await writeAudit(db, { userId: user.id, action: "reputation_vt_lookup", target: id, ip: getClientIp(await headers()) });
  revalidatePath(`/indicators/${id}`);
  return { ok: true, message: `VirusTotal 결과를 기록했습니다 (악성 ${res.stats.malicious}, 의심 ${res.stats.suspicious}).` };
}
