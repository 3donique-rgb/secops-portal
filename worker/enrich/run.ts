/**
 * 도메인 → IP, IP → 국가 정보 채우기 (GitHub Actions 에서 정기 실행).
 * 1) 도메인의 IP 를 DNS 로 찾는다 (대상 사이트에 접속하지 않음).
 * 2) 아직 국가를 모르는 IP 를 RDAP(whois 후속 표준)으로 조회해 "IP 대역 → 국가"로 저장한다.
 *    같은 대역의 다른 IP 는 저장된 대역을 재사용하므로 조회 수가 크게 줄어든다.
 */
import dns from "node:dns/promises";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { domainIps, indicators, netRanges } from "../../db/schema";
import { ipv4ToNum, lookupRdap, numToIpv4 } from "../../lib/geo";
import type { Db } from "../../lib/indicators";
import { isReservedIp } from "../../lib/normalize";

export type EnrichOptions = {
  maxDomains?: number;
  maxRdap?: number;
  dnsConcurrency?: number;
  rdapConcurrency?: number;
  resolve4?: (domain: string) => Promise<string[]>;
  fetchImpl?: typeof fetch;
  now?: Date;
};
export type EnrichSummary = { resolved: number; unresolved: number; rdapLookups: number; ranges: number; stopped: string | null };

const defaultResolve4 = async (d: string) => {
  const r = new dns.Resolver({ timeout: 3000, tries: 2 });
  return r.resolve4(d);
};

async function pool<T>(items: T[], size: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(size, items.length || 1)) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

export async function runEnrich(db: Db, opts: EnrichOptions = {}): Promise<EnrichSummary> {
  const now = opts.now ?? new Date();
  const out: EnrichSummary = { resolved: 0, unresolved: 0, rdapLookups: 0, ranges: 0, stopped: null };
  const resolve4 = opts.resolve4 ?? defaultResolve4;

  // 1) 도메인 → IP (처음, 또는 IP는 30일·못 찾은 것은 7일이 지나 다시 확인)
  const day = 24 * 3600 * 1000;
  const doms = await db
    .select({ id: indicators.id, value: indicators.value })
    .from(indicators)
    .leftJoin(domainIps, eq(domainIps.indicatorId, indicators.id))
    .where(
      and(
        eq(indicators.type, "domain"),
        eq(indicators.status, "active"),
        or(
          isNull(domainIps.indicatorId),
          and(eq(domainIps.status, "ok"), lt(domainIps.resolvedAt, new Date(now.getTime() - 30 * day))),
          and(eq(domainIps.status, "unresolved"), lt(domainIps.resolvedAt, new Date(now.getTime() - 7 * day))),
        ),
      ),
    )
    .orderBy(sql`${domainIps.resolvedAt} asc nulls first`, sql`${indicators.lastSeenAt} desc`)
    .limit(opts.maxDomains ?? 5000);
  await pool(doms, opts.dnsConcurrency ?? 50, async (d) => {
    let ips: string[] = [];
    try {
      ips = await resolve4(d.value);
    } catch {
      ips = [];
    }
    const ip = ips.find((x) => ipv4ToNum(x) !== null) ?? null;
    const row = ip ? { status: "ok" as const, ip, ipNum: ipv4ToNum(ip), resolvedAt: now } : { status: "unresolved" as const, ip: null, ipNum: null, resolvedAt: now };
    await db
      .insert(domainIps)
      .values({ indicatorId: d.id, ...row })
      .onConflictDoUpdate({ target: domainIps.indicatorId, set: row });
    if (ip) out.resolved++;
    else out.unresolved++;
  });

  // 2) 국가를 모르는 IP → RDAP (도메인이 가리키는 IP + IP 위협정보)
  const unknownRes: unknown = await db.execute(sql`
    select distinct x.n::text as n from (
      select ${domainIps.ipNum} as n from ${domainIps} where ${domainIps.status} = 'ok'
      union
      select case when ${indicators.value} ~ '^[0-9]{1,3}(\\.[0-9]{1,3}){3}$' then (${indicators.value}::inet - '0.0.0.0'::inet) end
        from ${indicators} where ${indicators.type} = 'ip' and ${indicators.status} = 'active'
    ) x
    where x.n is not null
      and not exists (select 1 from ${netRanges} r where r.start_num <= x.n and r.end_num >= x.n)
    limit ${opts.maxRdap ?? 600}`);
  // 실행 환경에 따라 결과가 배열(postgres-js) 또는 {rows}(PGlite)로 온다
  const unknownRows = (Array.isArray(unknownRes) ? unknownRes : ((unknownRes as { rows?: unknown[] }).rows ?? [])) as { n: string }[];
  const nums = unknownRows.map((r) => Number(r.n));
  const covered: [number, number][] = [];
  let stop = false;
  await pool(nums, opts.rdapConcurrency ?? 4, async (n) => {
    if (stop || covered.some(([a, b]) => a <= n && n <= b)) return;
    const ip = numToIpv4(n);
    if (isReservedIp(ip)) {
      // 사설·예약 주소는 조회하지 않고 "알 수 없음"으로 저장
      await db.insert(netRanges).values({ startNum: n, endNum: n, countryCode: null, netName: "예약·사설 주소" }).onConflictDoNothing();
      return;
    }
    out.rdapLookups++;
    const r = await lookupRdap(ip, opts.fetchImpl);
    if (r.ok) {
      covered.push([r.info.startNum, r.info.endNum]);
      await db
        .insert(netRanges)
        .values({ startNum: r.info.startNum, endNum: r.info.endNum, countryCode: r.info.countryCode, netName: r.info.netName })
        .onConflictDoNothing();
      out.ranges++;
    } else if (r.code === "rate_limit") {
      stop = true;
      out.stopped = "RDAP 조회 한도에 걸려 이번 실행은 여기서 멈춥니다 (다음 실행에서 이어서 조회).";
    } else if (r.code === "not_found" || r.code === "bad_ip") {
      // 이력이 없는 주소는 한 칸짜리로 기록해 같은 주소를 계속 다시 조회하지 않게 한다
      await db.insert(netRanges).values({ startNum: n, endNum: n, countryCode: null, netName: null }).onConflictDoNothing();
    }
    // network/error: 다음 실행에서 다시 시도
  });
  return out;
}

