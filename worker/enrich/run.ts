/**
 * 도메인 → IP, IP → 국가 정보 채우기 (GitHub Actions 에서 정기 실행).
 * 1) 도메인의 IP 를 DNS 로 찾는다 (대상 사이트에 접속하지 않음).
 * 2) 아직 국가를 모르는 IP 를 RDAP(whois 후속 표준)으로 조회해 "IP 대역 → 국가"로 저장한다.
 *    같은 대역의 다른 IP 는 저장된 대역을 재사용하므로 조회 수가 크게 줄어든다.
 */
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { domainIps, indicators, netRanges } from "../../db/schema";

/** 여러 DNS 서버 조회 방식을 도입한 시각(UTC). 이보다 전에 "DNS에 없음"으로 기록된 도메인은 다시 확인한다 */
const RECHECK_UNRESOLVED_BEFORE = new Date("2026-11-23T13:30:00Z");

const DELEGATED_LABEL = (label: string) => `${label} 할당 대역`;
import { resolveDomainMulti } from "../../lib/dns-multi";
import { DELEGATED_FILES, parseDelegated } from "../../lib/delegated";
import { ipv4ToNum, lookupRdap, numToIpv4 } from "../../lib/geo";
import type { Db } from "../../lib/indicators";
import { isReservedIp } from "../../lib/normalize";

export type EnrichOptions = {
  maxDomains?: number;
  maxRdap?: number;
  /** RDAP 조회 사이 대기(ms). 서버 부담을 줄이기 위해 기본 1초 */
  rdapDelayMs?: number;
  /** 이 시각이 지나면 새 도메인 확인을 시작하지 않는다 (작업 시간 제한 보호) */
  deadlineMs?: number;
  /** false 면 RIR 국가 목록을 받지 않는다 (시험용) */
  delegated?: boolean;
  /** RIR 국가 목록을 다시 받을 주기 (일). 0이면 항상 */
  delegatedMaxAgeDays?: number;
  dnsConcurrency?: number;
  rdapConcurrency?: number;
  /** 시험용: 지정하면 여러 DNS 서버 조회 대신 이 함수로 IP 를 구한다 */
  resolve4?: (domain: string) => Promise<string[]>;
  /** 시험용: 서버별 조회 함수 (server 가 null 이면 시스템 기본 DNS) */
  resolveVia?: (server: string | null, domain: string) => Promise<string[]>;
  /** 이 시각보다 전에 "DNS에 없음"으로 기록된 도메인은 (조회 방식이 개선되었으므로) 7일을 기다리지 않고 다시 확인 */
  recheckUnresolvedBefore?: Date;
  fetchImpl?: typeof fetch;
  now?: Date;
};
export type EnrichSummary = { resolved: number; unresolved: number; rdapLookups: number; ranges: number; delegatedRanges: number; byResolver: Record<string, number>; stopped: string | null };

async function pool<T>(items: T[], size: number, fn: (x: T) => Promise<void>, deadline = Infinity) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(size, items.length || 1)) }, async () => {
      while (i < items.length && Date.now() < deadline) await fn(items[i++]);
    }),
  );
}

export async function runEnrich(db: Db, opts: EnrichOptions = {}): Promise<EnrichSummary> {
  const now = opts.now ?? new Date();
  const out: EnrichSummary = { resolved: 0, unresolved: 0, rdapLookups: 0, ranges: 0, delegatedRanges: 0, byResolver: {}, stopped: null };
  const recheckBefore = opts.recheckUnresolvedBefore ?? RECHECK_UNRESOLVED_BEFORE;

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
          and(eq(domainIps.status, "unresolved"), or(lt(domainIps.resolvedAt, new Date(now.getTime() - 7 * day)), lt(domainIps.resolvedAt, recheckBefore))),
        ),
      ),
    )
    .orderBy(sql`${domainIps.resolvedAt} asc nulls first`, sql`${indicators.lastSeenAt} desc`)
    .limit(opts.maxDomains ?? 5000);
  await pool(doms, opts.dnsConcurrency ?? 100, async (d) => {
    let ip: string | null = null;
    if (opts.resolve4) {
      try {
        ip = (await opts.resolve4(d.value)).find((x) => ipv4ToNum(x) !== null) ?? null;
      } catch {
        ip = null;
      }
    } else {
      const a = await resolveDomainMulti(d.value, opts.resolveVia);
      ip = a.ip;
      if (a.via) out.byResolver[a.via] = (out.byResolver[a.via] ?? 0) + 1;
    }
    const row = ip ? { status: "ok" as const, ip, ipNum: ipv4ToNum(ip), resolvedAt: now } : { status: "unresolved" as const, ip: null, ipNum: null, resolvedAt: now };
    await db
      .insert(domainIps)
      .values({ indicatorId: d.id, ...row })
      .onConflictDoUpdate({ target: domainIps.indicatorId, set: row });
    if (ip) out.resolved++;
    else out.unresolved++;
  }, opts.deadlineMs ?? Infinity);

  // 2) RIR 국가 목록: 비어 있거나 오래되면 새로 받는다 (하루 몇 번 와도 받지 않고, 기본 14일 주기)
  if (opts.delegated !== false) await refreshDelegated(db, now, opts, out);

  // 3) 그래도 국가를 모르는 IP → RDAP (도메인이 가리키는 IP + IP 위협정보)
  const unknownRes: unknown = await db.execute(sql`
    select distinct x.n::text as n from (
      select ${domainIps.ipNum} as n from ${domainIps} where ${domainIps.status} = 'ok'
      union
      select case when ${indicators.value} ~ '^[0-9]{1,3}(\\.[0-9]{1,3}){3}$' then (${indicators.value}::inet - '0.0.0.0'::inet) end
        from ${indicators} where ${indicators.type} = 'ip' and ${indicators.status} = 'active'
    ) x
    where x.n is not null
      and not exists (select 1 from ${netRanges} r where r.start_num <= x.n and r.end_num >= x.n)
    limit ${opts.maxRdap ?? 200}`);
  // 실행 환경에 따라 결과가 배열(postgres-js) 또는 {rows}(PGlite)로 온다
  const unknownRows = (Array.isArray(unknownRes) ? unknownRes : ((unknownRes as { rows?: unknown[] }).rows ?? [])) as { n: string }[];
  const nums = unknownRows.map((r) => Number(r.n));
  const covered: [number, number][] = [];
  let stop = false;
  await pool(nums, opts.rdapConcurrency ?? 1, async (n) => {
    if (stop || covered.some(([a, b]) => a <= n && n <= b)) return;
    const ip = numToIpv4(n);
    if (isReservedIp(ip)) {
      // 사설·예약 주소는 조회하지 않고 "알 수 없음"으로 저장
      await db.insert(netRanges).values({ startNum: n, endNum: n, countryCode: null, netName: "예약·사설 주소" }).onConflictDoNothing();
      return;
    }
    out.rdapLookups++;
    if (opts.rdapDelayMs !== 0) await new Promise((res) => setTimeout(res, opts.rdapDelayMs ?? 1000));
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


async function refreshDelegated(db: Db, now: Date, opts: EnrichOptions, out: EnrichSummary) {
  const maxAge = (opts.delegatedMaxAgeDays ?? 14) * 24 * 3600 * 1000;
  const f = opts.fetchImpl ?? fetch;
  for (const file of DELEGATED_FILES) {
    const label = DELEGATED_LABEL(file.label);
    const [cur] = await db
      .select({ n: sql<number>`count(*)::int`, newest: sql<Date | null>`max(${netRanges.fetchedAt})` })
      .from(netRanges)
      .where(eq(netRanges.netName, label));
    if (cur.n > 0 && cur.newest && now.getTime() - new Date(cur.newest).getTime() < maxAge) continue;
    let text: string;
    try {
      const res = await f(file.url, { signal: AbortSignal.timeout(120_000), cache: "no-store" });
      if (!res.ok) continue;
      text = await res.text();
    } catch {
      continue; // 다음 실행에서 다시 시도
    }
    const ranges = parseDelegated(text);
    if (ranges.length < 100) continue; // 이상한 파일이면 기존 데이터를 지우지 않는다
    await db.delete(netRanges).where(eq(netRanges.netName, label));
    for (let i = 0; i < ranges.length; i += 3000) {
      await db
        .insert(netRanges)
        .values(ranges.slice(i, i + 3000).map((r) => ({ startNum: r.startNum, endNum: r.endNum, countryCode: r.countryCode, netName: label, fetchedAt: now })))
        .onConflictDoNothing();
    }
    out.delegatedRanges += ranges.length;
  }
}
