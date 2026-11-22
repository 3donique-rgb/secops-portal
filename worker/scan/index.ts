/** 점검 실행 (7.5): 자산 하나를 단계에 맞게 점검하고, 결과를 하루 한 건으로 저장(재실행하면 덮어씀)한 뒤 변화를 감지한다. */
import dns from "node:dns/promises";
import net from "node:net";
import { and, asc, eq, sql } from "drizzle-orm";
import { assets, scanResults, type ExposedPage, type OpenPort } from "../../db/schema";
import type { Db } from "../../lib/indicators";
import { isReservedIp } from "../../lib/normalize";
import { detectChanges } from "./diff";
import { checkPaths } from "./paths";
import { portsForLevel, scanPorts } from "./ports";
import { earliestCert, TLS_PORTS } from "./tls";

/** 자산당 시간 제한(초): 넘으면 점검된 범위까지만 기록하고 "일부만 점검됨(partial)"으로 표시 */
export const LEVEL_LIMIT_SEC: Record<number, number> = { 1: 60, 2: 120, 3: 200, 4: 360, 5: 900 };

export type ScanOutcome = {
  status: "success" | "fail" | "partial";
  openPorts: OpenPort[];
  exposedPages: ExposedPage[];
  certExpiresAt: Date | null;
  errorMessage: string | null;
  durationSec: number;
};

export type ScanOptions = {
  /** 시험용: 사설·루프백 주소도 점검한다. 명령줄(운영)에서는 절대 켜지 않는다. */
  allowPrivate?: boolean;
  /** 시험용: 포트 목록을 바꾼다 */
  portsOverride?: number[];
  connectTimeoutMs?: number;
  ratePerSec?: number;
  limitSecOverride?: number;
};

async function resolveHost(target: string): Promise<string> {
  if (net.isIP(target)) return target;
  const r = await dns.lookup(target, { family: 4 });
  return r.address;
}

export async function scanAsset(target: string, level: number, opts: ScanOptions = {}): Promise<ScanOutcome> {
  const started = Date.now();
  const fail = (msg: string): ScanOutcome => ({
    status: "fail", openPorts: [], exposedPages: [], certExpiresAt: null, errorMessage: msg, durationSec: Math.round((Date.now() - started) / 1000),
  });

  let ip: string;
  try {
    ip = await resolveHost(target);
  } catch {
    return fail("도메인 주소를 찾을 수 없습니다(DNS 조회 실패).");
  }
  if (!opts.allowPrivate && isReservedIp(ip)) return fail("사설·예약 주소로 연결되는 대상은 점검하지 않습니다.");

  const deadline = started + (opts.limitSecOverride ?? LEVEL_LIMIT_SEC[level] ?? 200) * 1000;
  const ports = opts.portsOverride ?? portsForLevel(level);
  const scan = await scanPorts(ip, ports, {
    concurrency: level >= 5 ? 200 : 100,
    ratePerSec: opts.ratePerSec ?? (level >= 5 ? 500 : 300),
    connectTimeoutMs: opts.connectTimeoutMs ?? 1500,
    identify: level >= 3,
    deadline,
  });
  if (!scan.alive) {
    return fail("응답이 없습니다(모든 포트가 시간 초과이거나 접속 불가).");
  }

  let cert: Date | null = null;
  let pages: ExposedPage[] = [];
  let incomplete = scan.incomplete;
  if (level >= 3) {
    cert = (await earliestCert(target, scan.open.map((p) => p.port)))?.expiresAt ?? null;
  }
  if (level >= 4) {
    const web = scan.open
      .filter((p) => p.service === "http" || p.service === "https" || [80, 443, 8080, 8443].includes(p.port))
      .map((p) => ({ port: p.port, tls: p.service === "https" || TLS_PORTS.includes(p.port) }));
    const r = await checkPaths(target, web.slice(0, 4), { deadline, gapMs: 100 });
    pages = r.pages;
    incomplete = incomplete || r.incomplete;
  }
  return {
    status: incomplete ? "partial" : "success",
    openPorts: scan.open,
    exposedPages: pages,
    certExpiresAt: cert,
    errorMessage: incomplete ? "자산당 시간 제한으로 일부만 점검되었습니다." : null,
    durationSec: Math.round((Date.now() - started) / 1000),
  };
}

export const kstDate = (d: Date) => new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 10);

export type RunOptions = ScanOptions & {
  now?: Date;
  /** 병렬 실행 묶음: index번째 묶음(0부터) / 전체 묶음 수 */
  shard?: { index: number; total: number };
  /** 시험 운영용: 이 수만큼의 자산만 점검 (소수 자산으로 먼저 시험) */
  maxAssets?: number;
  /** 한 묶음 안에서 동시에 점검하는 자산 수 */
  parallel?: number;
};

export type RunSummary = { scanned: number; success: number; partial: number; fail: number; notifications: number };

/** 점검 허가가 확인된(scan_permitted) 사용 중 자산만 점검한다. */
export async function runScan(db: Db, opts: RunOptions = {}): Promise<RunSummary> {
  const now = opts.now ?? new Date();
  const scanDate = kstDate(now);
  let list = await db
    .select()
    .from(assets)
    .where(and(eq(assets.enabled, true), eq(assets.scanPermitted, true)))
    .orderBy(asc(assets.createdAt), asc(assets.id));
  if (opts.shard) list = list.filter((_, i) => i % opts.shard!.total === opts.shard!.index);
  if (opts.maxAssets) list = list.slice(0, opts.maxAssets);

  const summary: RunSummary = { scanned: 0, success: 0, partial: 0, fail: 0, notifications: 0 };
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const a = list[next++];
      let r: ScanOutcome;
      try {
        r = await scanAsset(a.target, a.scanLevel, opts);
      } catch (e) {
        r = { status: "fail", openPorts: [], exposedPages: [], certExpiresAt: null, errorMessage: `점검 중 오류: ${e instanceof Error ? e.message.slice(0, 120) : "알 수 없음"}`, durationSec: 0 };
      }
      const values = { assetId: a.id, scanDate, scanLevel: a.scanLevel, ...r };
      await db
        .insert(scanResults)
        .values(values)
        .onConflictDoUpdate({
          target: [scanResults.assetId, scanResults.scanDate],
          set: { scanLevel: values.scanLevel, status: r.status, openPorts: r.openPorts, exposedPages: r.exposedPages, certExpiresAt: r.certExpiresAt, errorMessage: r.errorMessage, durationSec: r.durationSec, createdAt: sql`now()` },
        });
      summary.scanned++;
      summary[r.status]++;
      summary.notifications += await detectChanges(db, a.id, scanDate, now);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.parallel ?? 5, list.length || 1)) }, worker));
  return summary;
}
