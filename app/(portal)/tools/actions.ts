"use server";

import { headers } from "next/headers";
import { getDb } from "@/db";
import { writeAudit } from "@/lib/audit";
import { getClientIp } from "@/lib/auth";
import { requireUser } from "@/lib/session";
import { checkPorts, cleanHost, dnsLookup, parsePorts, whoisLookup, type ToolResult } from "@/lib/tools";
import { TOOL_LIMIT_PER_MIN, recentToolUses, reverseIp } from "@/lib/tools-db";



export async function runToolAction(_p: ToolResult | null, fd: FormData): Promise<ToolResult | null> {
  const user = await requireUser();
  const db = getDb();
  const tool = String(fd.get("tool") ?? "");
  const target = String(fd.get("target") ?? "").trim().slice(0, 300);
  if (!["port", "dns", "whois", "reverse"].includes(tool)) return { ok: false, message: "알 수 없는 도구입니다." };
  if (!cleanHost(target)) return { ok: false, message: "올바른 도메인 또는 IP 주소를 입력하세요." };
  if ((await recentToolUses(db, user.id)) >= TOOL_LIMIT_PER_MIN) return { ok: false, message: `1분에 ${TOOL_LIMIT_PER_MIN}회까지 사용할 수 있습니다. 잠시 후 다시 시도하세요.` };

  let ports: number[] = [];
  if (tool === "port") {
    if (fd.get("confirm") !== "on") return { ok: false, message: "점검 권한이 있는 대상임을 확인(체크)해야 합니다." };
    const p = parsePorts(String(fd.get("ports") ?? ""));
    if ("error" in p) return { ok: false, message: p.error };
    ports = p.ports;
  }
  await writeAudit(db, { userId: user.id, action: "tool_use", target, detail: { tool, ...(tool === "port" ? { ports: ports.join(",") } : {}) }, ip: getClientIp(await headers()) });
  try {
    if (tool === "port") return await checkPorts(target, ports);
    if (tool === "dns") return await dnsLookup(target, String(fd.get("server") ?? "google"));
    if (tool === "whois") return await whoisLookup(target);
    return await reverseIp(db, target);
  } catch (e) {
    console.error("[tools]", tool, e instanceof Error ? e.message : e);
    return { ok: false, message: "조회 중 오류가 발생했습니다. 잠시 후 다시 시도하세요." };
  }
}
