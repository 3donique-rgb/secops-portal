/** 환경점검 중 DB가 필요한 부분: 사용 횟수 제한, Reverse IP, 내 공인 IP */
import { and, asc, eq, gte, sql } from "drizzle-orm";
import dns from "node:dns";
import { auditLogs, domainIps, indicators, netRanges } from "../db/schema";
import { countryName, ipv4ToNum } from "./geo";
import type { Db } from "./indicators";
import { fetchReverseIpExternal, resolveToIp, type ToolResult, type ToolSection } from "./tools";

export const TOOL_LIMIT_PER_MIN = 20;

/** 최근 1분 안에 이 사용자가 환경점검을 몇 번 썼는지 */
export async function recentToolUses(db: Db, userId: string, now = new Date()): Promise<number> {
  const since = new Date(now.getTime() - 60_000);
  const r = await db.select({ n: sql<number>`count(*)::int` }).from(auditLogs).where(and(eq(auditLogs.userId, userId), eq(auditLogs.action, "tool_use"), gte(auditLogs.occurredAt, since)));
  return r[0]?.n ?? 0;
}

export async function countryOfIp(db: Db, ip: string): Promise<{ countryCode: string | null; netName: string | null } | null> {
  const n = ipv4ToNum(ip);
  if (n === null) return null;
  const r = await db
    .select({ countryCode: netRanges.countryCode, netName: netRanges.netName })
    .from(netRanges)
    .where(and(sql`${netRanges.startNum} <= ${n}`, sql`${netRanges.endNum} >= ${n}`))
    .orderBy(asc(sql`${netRanges.endNum} - ${netRanges.startNum}`))
    .limit(1);
  return r[0] ?? null;
}

async function ptr(ip: string): Promise<string[]> {
  try {
    return await dns.promises.reverse(ip);
  } catch {
    return [];
  }
}

export async function reverseIp(db: Db, input: string, deps: { lookup?: (h: string) => Promise<string>; external?: typeof fetchReverseIpExternal } = {}): Promise<ToolResult> {
  const r = await resolveToIp(input, deps.lookup);
  if ("error" in r) return { ok: false, message: r.error };
  const ptrNames = await ptr(r.ip);
  const sections: ToolSection[] = [
    { title: "조회 대상", rows: [["입력", r.host], ["IP 주소", r.ip]] },
    { title: "PTR(역방향 DNS) 이름", items: ptrNames.length ? ptrNames : ["PTR 기록 없음"] },
  ];
  const mine = await db
    .select({ value: indicators.value })
    .from(domainIps)
    .innerJoin(indicators, eq(indicators.id, domainIps.indicatorId))
    .where(and(eq(domainIps.ip, r.ip), eq(domainIps.status, "ok")))
    .limit(200);
  sections.push({ title: "이 포털이 수집한 위협정보 도메인", note: "같은 IP를 쓰는 수집 도메인입니다.", items: mine.length ? mine.map((m) => m.value) : ["없음"] });
  const ext = await (deps.external ?? fetchReverseIpExternal)(r.ip);
  if ("error" in ext) sections.push({ title: "같은 IP의 다른 도메인 (외부 서비스)", items: [ext.error] });
  else sections.push({ title: `같은 IP의 다른 도메인 (외부 서비스, ${ext.domains.length}개)`, note: "외부 서비스(HackerTarget) 공개 DB 기준이며 모든 도메인을 포함하지는 않습니다.", items: ext.domains.length ? ext.domains.slice(0, 500) : ["없음"] });
  return { ok: true, sections };
}

export async function myIpInfo(db: Db, ip: string | null): Promise<ToolSection[]> {
  if (!ip) return [{ title: "내 공인 IP", items: ["접속 IP를 확인하지 못했습니다."] }];
  const rows: [string, string][] = [["공인 IP", ip]];
  const names = await ptr(ip);
  rows.push(["역방향 DNS(PTR)", names[0] ?? "없음"]);
  const c = await countryOfIp(db, ip);
  rows.push(["국가", c?.countryCode ? `${c.countryCode} ${countryName(c.countryCode)}`.trim() : "정보 없음 (수집 후 반영)"]);
  if (c?.netName) rows.push(["대역 출처", c.netName]);
  return [{ title: "내 공인 IP 주소", note: "VPN·프록시를 쓰면 그 서버의 주소가 표시됩니다.", rows }];
}
