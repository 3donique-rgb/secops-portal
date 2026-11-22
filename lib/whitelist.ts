/**
 * 제외 판정 [고정] - design.md 4.4
 *
 * 화이트리스트(IP 일치, CIDR 포함, 도메인 일치·하위 도메인)이거나 등록된 우리 자산(도메인·IP)과
 * 일치하는 지표는 `excluded = true`로 표시한다. 사설·예약 대역 IP도 제외 상태를 유지한다.
 * 제외된 지표는 DB에 남고 SIEM 제공 목록에서만 빠진다.
 */
import { inArray } from "drizzle-orm";
import { assets, indicators, whitelist } from "../db/schema";
import {
  canonicalCidr,
  ipInParsedCidr,
  parseCidr,
  parseIp,
  type ParsedCidr,
} from "./cidr";
import type { Db } from "./indicators";
import { isReservedIp, normalize } from "./normalize";

export type WhitelistType = "ip" | "cidr" | "domain";

export type ExclusionRules = {
  ips: Set<string>;
  cidrs: ParsedCidr[];
  domains: Set<string>;
};

export type IndicatorLike = { type: string; value: string };

/** 관리자가 입력한 화이트리스트 값을 저장 형식으로 정리한다. 잘못된 값이면 null. */
export function normalizeWhitelistValue(
  type: WhitelistType,
  raw: string,
): string | null {
  const text = raw.trim();
  if (!text) return null;
  if (type === "cidr") return canonicalCidr(text);
  const n = normalize(text);
  if (type === "ip") return n?.type === "ip" ? n.value : null;
  return n?.type === "domain" ? n.value : null;
}

/** 화이트리스트 행과 자산 대상(도메인 또는 IP)으로 규칙 묶음을 만든다. */
export function buildRules(
  whitelistRows: { type: string; value: string }[],
  assetTargets: string[],
): ExclusionRules {
  const rules: ExclusionRules = {
    ips: new Set(),
    cidrs: [],
    domains: new Set(),
  };
  const addIp = (value: string) => {
    const n = normalize(value);
    if (n?.type === "ip") rules.ips.add(n.value);
  };
  const addDomain = (value: string) => {
    const n = normalize(value);
    if (n?.type === "domain") rules.domains.add(n.value);
  };

  for (const row of whitelistRows) {
    if (row.type === "ip") addIp(row.value);
    else if (row.type === "domain") addDomain(row.value);
    else if (row.type === "cidr") {
      const c = parseCidr(row.value);
      if (c) rules.cidrs.push(c);
    }
  }
  // 우리 자산: 대상이 IP면 IP 일치, 도메인이면 도메인 일치·하위 도메인
  for (const target of assetTargets) {
    const n = normalize(target);
    if (n?.type === "ip") rules.ips.add(n.value);
    else if (n?.type === "domain") rules.domains.add(n.value);
    else if (n?.type === "url") {
      const host = hostOf({ type: n.type, value: n.value });
      if (host) (isIpText(host) ? rules.ips : rules.domains).add(host);
    }
  }
  return rules;
}

function isIpText(text: string): boolean {
  return parseIp(text) !== null;
}

/** 지표에서 비교 대상 주소(IP 또는 도메인)를 뽑는다. 해시는 해당 없음. */
export function hostOf(ind: IndicatorLike): string | null {
  switch (ind.type) {
    case "ip":
    case "domain":
      return ind.value;
    case "email": {
      const at = ind.value.lastIndexOf("@");
      return at >= 0 ? ind.value.slice(at + 1) : null;
    }
    case "url": {
      try {
        const host = new URL(ind.value).hostname.replace(/^\[(.*)\]$/, "$1");
        return host || null;
      } catch {
        return null;
      }
    }
    default:
      return null;
  }
}

function domainMatches(host: string, domains: Set<string>): boolean {
  // host 자신과 상위 도메인을 차례로 확인: a.b.corp.com → b.corp.com → corp.com
  const labels = host.split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    if (domains.has(labels.slice(i).join("."))) return true;
  }
  return false;
}

/** 사설·예약 대역 IP를 가리키는 지표인지 (처음부터 제외 대상). */
export function isReservedIndicator(ind: IndicatorLike): boolean {
  const host = hostOf(ind);
  return host !== null && isIpText(host) && isReservedIp(host);
}

export function isExcluded(ind: IndicatorLike, rules: ExclusionRules): boolean {
  const host = hostOf(ind);
  if (host === null) return false; // 해시 등
  if (isIpText(host)) {
    if (isReservedIp(host)) return true;
    if (rules.ips.has(host)) return true;
    const ip = parseIp(host);
    return ip !== null && rules.cidrs.some((c) => ipInParsedCidr(ip, c));
  }
  return domainMatches(host.toLowerCase(), rules.domains);
}

export type RecomputeResult = { excluded: number; included: number };

const PAGE = 2000;
const UPDATE_CHUNK = 500;

/**
 * 화이트리스트나 자산이 추가·수정·삭제됐을 때 모든 지표의 제외 여부를 다시 계산한다.
 * 반환값: 새로 제외된 건수, 제외가 풀린 건수
 */
export async function recomputeExcluded(db: Db): Promise<RecomputeResult> {
  const [wl, assetRows] = await Promise.all([
    db.select({ type: whitelist.type, value: whitelist.value }).from(whitelist),
    db.select({ target: assets.target }).from(assets),
  ]);
  const rules = buildRules(wl, assetRows.map((a) => a.target));

  const toExclude: string[] = [];
  const toInclude: string[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await db
      .select({
        id: indicators.id,
        type: indicators.type,
        value: indicators.value,
        excluded: indicators.excluded,
      })
      .from(indicators)
      .orderBy(indicators.id)
      .limit(PAGE)
      .offset(offset);
    if (page.length === 0) break;
    for (const row of page) {
      const want = isExcluded(row, rules);
      if (want && !row.excluded) toExclude.push(row.id);
      if (!want && row.excluded) toInclude.push(row.id);
    }
    if (page.length < PAGE) break;
  }

  for (const [ids, value] of [
    [toExclude, true],
    [toInclude, false],
  ] as const) {
    for (let i = 0; i < ids.length; i += UPDATE_CHUNK) {
      await db
        .update(indicators)
        .set({ excluded: value })
        .where(inArray(indicators.id, ids.slice(i, i + UPDATE_CHUNK)));
    }
  }
  return { excluded: toExclude.length, included: toInclude.length };
}
