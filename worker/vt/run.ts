/**
 * VirusTotal 자동 평판 조회 (GitHub Actions 에서 정기 실행).
 * 무료 키 한도(분당 4건, 하루 500건)를 지키기 위해 한 번에 소량만, 하루 상한을 두고 조회한다.
 * 대상: 활성 · SIEM 제외 아님(우리 자산·화이트리스트는 외부로 보내지 않음) · IP/해시/도메인 · 아직 평판 기록이 없는 값.
 * 우선순위: IP → 해시 → 도메인, 같은 종류 안에서는 최근에 확인된 것부터.
 */
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { indicatorReputations, indicators } from "../../db/schema";
import type { Db } from "../../lib/indicators";
import { lookupVirusTotal } from "../../lib/reputation";
import { saveReputation } from "../../lib/reputation";

export type VtAutoOptions = {
  apiKey: string | undefined;
  /** 이번 실행에서 조회할 최대 건수 */
  maxItems?: number;
  /** 최근 24시간 동안 API로 조회한 건수의 상한 (무료 키 하루 500건 중 여유를 둠) */
  dailyCap?: number;
  /** 조회 사이 대기(ms). 무료 키는 분당 4건이므로 15.5초 이상 */
  delayMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: Date;
};

export type VtAutoSummary = { checked: number; recorded: number; notFound: number; stopped: string | null; remainingToday: number };

export async function runVtAuto(db: Db, opts: VtAutoOptions): Promise<VtAutoSummary> {
  const maxItems = opts.maxItems ?? 50;
  const dailyCap = opts.dailyCap ?? 400;
  const delayMs = opts.delayMs ?? 16_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? new Date();
  const out: VtAutoSummary = { checked: 0, recorded: 0, notFound: 0, stopped: null, remainingToday: 0 };
  if (!opts.apiKey) {
    out.stopped = "VT_API_KEY가 설정되지 않아 건너뜁니다.";
    return out;
  }
  const since = new Date(now.getTime() - 24 * 3600 * 1000);
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(indicatorReputations)
    .where(and(eq(indicatorReputations.origin, "virustotal"), gte(indicatorReputations.createdAt, since)));
  out.remainingToday = Math.max(0, dailyCap - n);
  const limit = Math.min(maxItems, out.remainingToday);
  if (limit <= 0) {
    out.stopped = "오늘 조회 상한에 도달했습니다.";
    return out;
  }
  const list = await db
    .select({ id: indicators.id, type: indicators.type, value: indicators.value })
    .from(indicators)
    .where(
      and(
        eq(indicators.status, "active"),
        eq(indicators.excluded, false),
        inArray(indicators.type, ["ip", "hash", "domain"]),
        sql`not exists (select 1 from indicator_reputations r where r.indicator_id = ${indicators.id})`,
      ),
    )
    .orderBy(sql`case ${indicators.type} when 'ip' then 0 when 'hash' then 1 else 2 end`, sql`${indicators.lastSeenAt} desc`)
    .limit(limit);

  for (let i = 0; i < list.length; i++) {
    if (i > 0) await sleep(delayMs);
    const it = list[i];
    const res = await lookupVirusTotal({ type: it.type, value: it.value }, opts.apiKey, opts.fetchImpl);
    out.checked++;
    if (res.ok) {
      await saveReputation(db, { indicatorId: it.id, verdict: res.verdict, origin: "virustotal", stats: res.stats, note: "자동 조회", createdBy: null });
      out.recorded++;
      out.remainingToday--;
    } else if (res.code === "not_found") {
      // 이력이 없는 값도 기록을 남겨 같은 값을 계속 다시 조회하지 않게 한다
      await saveReputation(db, { indicatorId: it.id, verdict: "unknown", origin: "virustotal", note: "자동 조회: VirusTotal에 분석 이력 없음", createdBy: null });
      out.notFound++;
      out.remainingToday--;
    } else if (res.code === "rate_limit" || res.code === "auth" || res.code === "no_key") {
      out.stopped = res.message;
      break;
    }
    // network/error: 이번 값은 건너뛰고 다음 실행에서 다시 시도한다
  }
  return out;
}
