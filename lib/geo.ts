/**
 * IP 주소의 국가 확인: whois 의 후속 표준인 RDAP 으로 IP 대역 등록 정보를 조회한다.
 * - 도메인 → IP 는 DNS 조회만 하고, 대상 사이트에 접속하지는 않는다.
 * - IPv4 만 다룬다 (IPv6 는 표시하지 않음).
 */
import { and, asc, sql } from "drizzle-orm";
import { domainIps, netRanges } from "../db/schema";
import { inArray } from "drizzle-orm";
import type { Db } from "./indicators";

/** "1.2.3.4" → 숫자. IPv4 가 아니면 null */
export function ipv4ToNum(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((x) => x > 255)) return null;
  return ((p[0] * 256 + p[1]) * 256 + p[2]) * 256 + p[3];
}

export function numToIpv4(n: number): string {
  return [Math.floor(n / 16777216) % 256, Math.floor(n / 65536) % 256, Math.floor(n / 256) % 256, n % 256].join(".");
}

const CC = /^[A-Z]{2}$/;

/** 국가 코드 모양 확인 (그 밖의 값은 버린다) */
export function cleanCountry(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const u = v.trim().toUpperCase();
  return CC.test(u) && u !== "ZZ" && u !== "EU" && u !== "AP" ? u : null;
}

const NAME_TO_CC: Record<string, string> = { "UNITED STATES": "US", USA: "US", "UNITED STATES OF AMERICA": "US", CANADA: "CA" };

type Json = Record<string, unknown>;
const isObj = (x: unknown): x is Json => typeof x === "object" && x !== null && !Array.isArray(x);

/** ARIN 처럼 network 에 country 가 없을 때, 등록 기관(entity) 연락처 주소의 마지막 줄에서 국가를 찾는다 */
function countryFromEntities(entities: unknown): string | null {
  if (!Array.isArray(entities)) return null;
  for (const e of entities) {
    if (!isObj(e)) continue;
    const vc = e.vcardArray;
    if (Array.isArray(vc) && Array.isArray(vc[1])) {
      for (const prop of vc[1] as unknown[]) {
        if (!Array.isArray(prop) || prop[0] !== "adr") continue;
        const label = isObj(prop[1]) && typeof prop[1].label === "string" ? prop[1].label : "";
        const lastLine = label.split("\n").pop()?.trim().toUpperCase() ?? "";
        const fromLabel = cleanCountry(lastLine) ?? NAME_TO_CC[lastLine] ?? null;
        if (fromLabel) return fromLabel;
        const val = Array.isArray(prop[3]) ? prop[3] : [];
        const last = String(val[val.length - 1] ?? "").trim().toUpperCase();
        const fromVal = cleanCountry(last) ?? NAME_TO_CC[last] ?? null;
        if (fromVal) return fromVal;
      }
    }
    const nested = countryFromEntities(e.entities);
    if (nested) return nested;
  }
  return null;
}

export type RdapInfo = { startNum: number; endNum: number; countryCode: string | null; netName: string | null };

/** RDAP 응답(JSON)에서 필요한 값만 꺼낸다 */
export function parseRdap(body: unknown): RdapInfo | null {
  if (!isObj(body)) return null;
  const start = typeof body.startAddress === "string" ? ipv4ToNum(body.startAddress) : null;
  const end = typeof body.endAddress === "string" ? ipv4ToNum(body.endAddress) : null;
  if (start === null || end === null || end < start) return null;
  const country = cleanCountry(body.country) ?? countryFromEntities(body.entities);
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 100) || null : null;
  return { startNum: start, endNum: end, countryCode: country, netName: name };
}

export type RdapResult =
  | { ok: true; info: RdapInfo }
  | { ok: false; code: "not_found" | "rate_limit" | "network" | "error" | "bad_ip" };

/** RDAP 조회. rdap.org 가 알맞은 지역 인터넷 등록기관(RIR)으로 안내해 준다. */
export async function lookupRdap(ip: string, fetchImpl: typeof fetch = fetch): Promise<RdapResult> {
  if (ipv4ToNum(ip) === null) return { ok: false, code: "bad_ip" };
  let res: Response;
  try {
    res = await fetchImpl(`https://rdap.org/ip/${ip}`, {
      headers: { accept: "application/rdap+json, application/json", "user-agent": "secops-portal" },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
  } catch {
    return { ok: false, code: "network" };
  }
  if (res.status === 404) return { ok: false, code: "not_found" };
  if (res.status === 429) return { ok: false, code: "rate_limit" };
  if (!res.ok) return { ok: false, code: "error" };
  try {
    const info = parseRdap(await res.json());
    return info ? { ok: true, info } : { ok: false, code: "error" };
  } catch {
    return { ok: false, code: "error" };
  }
}

/** 국가 코드 → 한국어 이름 (예: KR → 대한민국) */
export function countryName(code: string | null): string {
  if (!code) return "";
  try {
    return new Intl.DisplayNames(["ko"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

export type GeoRow = { ip: string | null; state: "ok" | "unresolved" | "pending" | "none"; countryCode: string | null; netName: string | null };

/**
 * 목록 화면용: 위협정보 여러 개의 IP·국가를 한 번에 구한다.
 * - 도메인: DNS로 찾은 IP / IP: 자기 자신 / 그 밖의 종류: 해당 없음(none)
 */
export async function geoForIndicators(db: Db, rows: { id: string; type: string; value: string }[]): Promise<Map<string, GeoRow>> {
  const out = new Map<string, GeoRow>();
  const domainIds = rows.filter((r) => r.type === "domain").map((r) => r.id);
  const resolved = new Map<string, { status: string; ip: string | null }>();
  if (domainIds.length) {
    const d = await db.select({ id: domainIps.indicatorId, status: domainIps.status, ip: domainIps.ip }).from(domainIps).where(inArray(domainIps.indicatorId, domainIds));
    for (const x of d) resolved.set(x.id, x);
  }
  const ipOf = new Map<string, string | null>();
  for (const r of rows) {
    if (r.type === "domain") ipOf.set(r.id, resolved.get(r.id)?.ip ?? null);
    else if (r.type === "ip") ipOf.set(r.id, ipv4ToNum(r.value) !== null ? r.value : null);
  }
  const nums = [...new Set([...ipOf.values()].map((ip) => (ip ? ipv4ToNum(ip) : null)).filter((n): n is number => n !== null))];
  const byNum = new Map<number, { countryCode: string | null; netName: string | null }>();
  if (nums.length) {
    const found = await db
      .selectDistinctOn([sql`n`], { n: sql<number>`n`, countryCode: netRanges.countryCode, netName: netRanges.netName })
      .from(sql`unnest(${sql.raw("array[" + nums.join(",") + "]::bigint[]")}) as n`)
      .innerJoin(netRanges, and(sql`${netRanges.startNum} <= n`, sql`${netRanges.endNum} >= n`))
      .orderBy(sql`n`, asc(sql`${netRanges.endNum} - ${netRanges.startNum}`));
    for (const f of found) byNum.set(Number(f.n), { countryCode: f.countryCode, netName: f.netName });
  }
  for (const r of rows) {
    if (r.type !== "domain" && r.type !== "ip") {
      out.set(r.id, { ip: null, state: "none", countryCode: null, netName: null });
      continue;
    }
    const ip = ipOf.get(r.id) ?? null;
    if (r.type === "domain") {
      const s = resolved.get(r.id);
      if (!s) {
        out.set(r.id, { ip: null, state: "pending", countryCode: null, netName: null });
        continue;
      }
      if (s.status === "unresolved" || !ip) {
        out.set(r.id, { ip: null, state: "unresolved", countryCode: null, netName: null });
        continue;
      }
    }
    if (!ip) {
      out.set(r.id, { ip: null, state: "none", countryCode: null, netName: null });
      continue;
    }
    const n = ipv4ToNum(ip);
    const g = n === null ? undefined : byNum.get(n);
    out.set(r.id, { ip, state: g ? "ok" : "pending", countryCode: g?.countryCode ?? null, netName: g?.netName ?? null });
  }
  return out;
}

