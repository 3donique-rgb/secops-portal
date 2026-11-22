/**
 * 평판 기록: VirusTotal 분석 결과와 분석가 판정을 지표별 이력으로 남긴다.
 * - VirusTotal 화면 링크는 키 없이 항상 쓸 수 있다 (IP·도메인·파일 해시).
 * - API 조회는 VT_API_KEY 환경변수가 있을 때만 켜진다. 키는 서버에서만 쓰고 화면·로그에 내지 않는다.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { indicatorReputations, indicators, users } from "../db/schema";
import type { Db } from "./indicators";

export const VERDICTS = ["malicious", "suspicious", "harmless", "unknown"] as const;
export type Verdict = (typeof VERDICTS)[number];
export const VERDICT_LABEL: Record<Verdict, string> = {
  malicious: "악성",
  suspicious: "의심",
  harmless: "정상",
  unknown: "미확인",
};

export type VtTarget = { type: string; value: string };

/** VirusTotal에서 분석할 수 있는 종류: IP, 도메인, 파일 해시 */
export function isVtSupported(type: string): boolean {
  return type === "ip" || type === "domain" || type === "hash";
}

/** 값 모양을 다시 확인한다 (주소 조립에 쓰므로 방어적으로). */
function safeValue(t: VtTarget): string | null {
  const v = t.value.trim();
  if (!v || v.length > 255) return null;
  if (t.type === "hash") return /^[0-9a-f]{32}$|^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(v) ? v.toLowerCase() : null;
  if (t.type === "ip") return /^[0-9a-f:.]+$/i.test(v) ? v : null;
  if (t.type === "domain") return /^[a-z0-9._-]+$/i.test(v) ? v.toLowerCase() : null;
  return null;
}

/** 사람이 열어 보는 VirusTotal 화면 주소 */
export function vtGuiUrl(t: VtTarget): string | null {
  const v = safeValue(t);
  if (!v) return null;
  const seg = t.type === "ip" ? "ip-address" : t.type === "domain" ? "domain" : "file";
  return `https://www.virustotal.com/gui/${seg}/${encodeURIComponent(v)}`;
}

function vtApiUrl(t: VtTarget): string | null {
  const v = safeValue(t);
  if (!v) return null;
  const seg = t.type === "ip" ? "ip_addresses" : t.type === "domain" ? "domains" : "files";
  return `https://www.virustotal.com/api/v3/${seg}/${encodeURIComponent(v)}`;
}

export type VtStats = {
  malicious: number;
  suspicious: number;
  harmless: number;
  undetected: number;
  reputation: number | null;
};

/** 분석 엔진 집계로 판정을 정한다: 악성 3곳 이상=악성, 1곳 이상 또는 의심 1곳 이상=의심 */
export function verdictFromStats(s: VtStats): Verdict {
  if (s.malicious >= 3) return "malicious";
  if (s.malicious >= 1 || s.suspicious >= 1) return "suspicious";
  if (s.harmless + s.undetected > 0) return "harmless";
  return "unknown";
}

export type VtResult =
  | { ok: true; stats: VtStats; verdict: Verdict }
  | { ok: false; message: string };

/** VirusTotal API v3 조회. fetchImpl은 시험용. */
export async function lookupVirusTotal(
  t: VtTarget,
  apiKey: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<VtResult> {
  if (!apiKey) return { ok: false, message: "VirusTotal API 키가 설정되지 않았습니다. 아래 안내를 따라 키를 등록하세요." };
  const url = vtApiUrl(t);
  if (!url) return { ok: false, message: "이 종류의 값은 VirusTotal로 조회할 수 없습니다." };
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { "x-apikey": apiKey, accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
  } catch {
    return { ok: false, message: "VirusTotal에 연결하지 못했습니다. 잠시 뒤 다시 시도하세요." };
  }
  if (res.status === 404) return { ok: false, message: "VirusTotal에 아직 등록되지 않은 값입니다. (분석 이력 없음)" };
  if (res.status === 429) return { ok: false, message: "VirusTotal 조회 한도(무료: 분당 4건, 하루 500건)를 넘었습니다. 잠시 뒤 다시 시도하세요." };
  if (res.status === 401 || res.status === 403) return { ok: false, message: "VirusTotal API 키가 거절되었습니다. 키를 확인하세요." };
  if (!res.ok) return { ok: false, message: `VirusTotal이 오류를 돌려줬습니다 (HTTP ${res.status}).` };
  try {
    const body = (await res.json()) as { data?: { attributes?: Record<string, unknown> } };
    const a = body.data?.attributes ?? {};
    const st = (a.last_analysis_stats ?? {}) as Record<string, unknown>;
    const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? Math.trunc(x) : 0);
    const stats: VtStats = {
      malicious: n(st.malicious),
      suspicious: n(st.suspicious),
      harmless: n(st.harmless),
      undetected: n(st.undetected),
      reputation: typeof a.reputation === "number" ? Math.trunc(a.reputation) : null,
    };
    return { ok: true, stats, verdict: verdictFromStats(stats) };
  } catch {
    return { ok: false, message: "VirusTotal 응답을 읽지 못했습니다." };
  }
}

export type ReputationInput = {
  indicatorId: string;
  verdict: string;
  note?: string | null;
  origin?: "manual" | "virustotal";
  stats?: VtStats;
  createdBy?: string | null;
};

export async function saveReputation(db: Db, input: ReputationInput): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!(VERDICTS as readonly string[]).includes(input.verdict)) return { ok: false, message: "판정을 선택하세요." };
  const note = input.note?.trim() || null;
  if (note && note.length > 1000) return { ok: false, message: "메모는 1,000자 이하로 입력하세요." };
  const [ind] = await db.select({ id: indicators.id }).from(indicators).where(eq(indicators.id, input.indicatorId)).limit(1);
  if (!ind) return { ok: false, message: "위협정보를 찾을 수 없습니다." };
  await db.insert(indicatorReputations).values({
    indicatorId: input.indicatorId,
    origin: input.origin ?? "manual",
    verdict: input.verdict as Verdict,
    vtMalicious: input.stats?.malicious ?? null,
    vtSuspicious: input.stats?.suspicious ?? null,
    vtHarmless: input.stats?.harmless ?? null,
    vtUndetected: input.stats?.undetected ?? null,
    vtReputation: input.stats?.reputation ?? null,
    note,
    createdBy: input.createdBy ?? null,
  });
  return { ok: true };
}

export type ReputationRow = {
  id: string;
  createdAt: Date;
  origin: string;
  verdict: Verdict;
  vtMalicious: number | null;
  vtSuspicious: number | null;
  vtHarmless: number | null;
  vtUndetected: number | null;
  vtReputation: number | null;
  note: string | null;
  by: string | null;
};

/** 한 지표의 평판 이력 (최근 것이 위) */
export async function listReputations(db: Db, indicatorId: string, limit = 50): Promise<ReputationRow[]> {
  return db
    .select({
      id: indicatorReputations.id,
      createdAt: indicatorReputations.createdAt,
      origin: indicatorReputations.origin,
      verdict: indicatorReputations.verdict,
      vtMalicious: indicatorReputations.vtMalicious,
      vtSuspicious: indicatorReputations.vtSuspicious,
      vtHarmless: indicatorReputations.vtHarmless,
      vtUndetected: indicatorReputations.vtUndetected,
      vtReputation: indicatorReputations.vtReputation,
      note: indicatorReputations.note,
      by: users.name,
    })
    .from(indicatorReputations)
    .leftJoin(users, eq(users.id, indicatorReputations.createdBy))
    .where(eq(indicatorReputations.indicatorId, indicatorId))
    .orderBy(desc(indicatorReputations.createdAt), desc(indicatorReputations.id))
    .limit(limit);
}

/** 목록 화면용: 지표 여러 개의 가장 최근 판정 */
export async function latestVerdicts(db: Db, ids: string[]): Promise<Map<string, Verdict>> {
  const out = new Map<string, Verdict>();
  if (ids.length === 0) return out;
  const rows = await db
    .selectDistinctOn([indicatorReputations.indicatorId], {
      id: indicatorReputations.indicatorId,
      verdict: indicatorReputations.verdict,
    })
    .from(indicatorReputations)
    .where(and(inArray(indicatorReputations.indicatorId, ids)))
    .orderBy(indicatorReputations.indicatorId, desc(indicatorReputations.createdAt), desc(indicatorReputations.id));
  for (const r of rows) out.set(r.id, r.verdict);
  return out;
}

