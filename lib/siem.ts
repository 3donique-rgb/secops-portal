/** SIEM 제공 API의 처리: 인증 → 조건 해석 → 제외 항목 빼고 조회 → json/csv/txt 변환. 항상 excluded = false 만 내보낸다 [고정]. */
import { authenticateApiKey } from "./api-keys";
import type { Db } from "./indicators";
import {
  INDICATOR_STATUSES,
  INDICATOR_TYPES,
  listIndicators,
  type IndicatorFilter,
  type IndicatorRow,
  type IndicatorStatus,
  type IndicatorType,
} from "./indicator-query";

export const SIEM_DEFAULT_LIMIT = 10_000;
export const SIEM_MAX_LIMIT = 100_000;
export type SiemFormat = "json" | "csv" | "txt";

export type SiemParams = { filter: IndicatorFilter; format: SiemFormat; limit: number };

/** 잘못된 값이 있으면 오류 문구를 돌려준다 (조용히 무시하지 않는다: 연동 설정 실수를 바로 알 수 있게). */
export function parseSiemParams(sp: URLSearchParams): SiemParams | { error: string } {
  const typeRaw = sp.getAll("type").flatMap((t) => t.split(",")).map((t) => t.trim()).filter(Boolean);
  for (const t of typeRaw) {
    if (!(INDICATOR_TYPES as readonly string[]).includes(t)) {
      return { error: `type 값이 올바르지 않습니다: ${t.slice(0, 20)} (가능: ${INDICATOR_TYPES.join(", ")})` };
    }
  }
  const status = sp.get("status") ?? "active";
  if (status !== "all" && !(INDICATOR_STATUSES as readonly string[]).includes(status)) {
    return { error: "status 는 active, inactive, all 중 하나여야 합니다." };
  }
  const format = sp.get("format") ?? "json";
  if (format !== "json" && format !== "csv" && format !== "txt") {
    return { error: "format 은 json, csv, txt 중 하나여야 합니다." };
  }
  let since: Date | undefined;
  const sinceRaw = sp.get("since");
  if (sinceRaw) {
    since = new Date(sinceRaw);
    if (Number.isNaN(since.getTime())) return { error: "since 는 ISO 8601 시각이어야 합니다. 예: 2026-11-22T00:00:00Z" };
  }
  let limit = SIEM_DEFAULT_LIMIT;
  const limitRaw = sp.get("limit");
  if (limitRaw !== null) {
    if (!/^\d{1,12}$/.test(limitRaw) || Number(limitRaw) < 1) return { error: "limit 는 1 이상의 정수여야 합니다." };
    limit = Math.min(Number(limitRaw), SIEM_MAX_LIMIT);
  }
  return {
    filter: {
      types: typeRaw.length > 0 ? ([...new Set(typeRaw)] as IndicatorType[]) : undefined,
      status: status === "all" ? undefined : (status as IndicatorStatus),
      from: since,
      excluded: "none", // 고정: 제외된 지표는 절대 내보내지 않는다
    },
    format,
    limit,
  };
}

const iso = (d: Date) => d.toISOString();

export function toJson(rows: IndicatorRow[], generatedAt: Date): string {
  return JSON.stringify({
    generated_at: iso(generatedAt),
    count: rows.length,
    items: rows.map((r) => ({
      type: r.type,
      value: r.value,
      hash_kind: r.hashKind,
      status: r.status,
      sources: r.sourceNames,
      first_seen: iso(r.firstSeenAt),
      last_seen: iso(r.lastSeenAt),
    })),
  });
}

function csvCell(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function toCsv(rows: IndicatorRow[]): string {
  const lines = ["type,value,hash_kind,status,sources,first_seen,last_seen"];
  for (const r of rows) {
    lines.push(
      [r.type, r.value, r.hashKind ?? "", r.status, r.sourceNames.join(";"), iso(r.firstSeenAt), iso(r.lastSeenAt)]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

/** 값만 한 줄에 하나씩 (차단 목록처럼 값만 필요한 장비용) */
export function toTxt(rows: IndicatorRow[]): string {
  return rows.map((r) => r.value).join("\n") + (rows.length > 0 ? "\n" : "");
}

const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra },
  });

/** 요청 한 건을 처리한다. 라우트는 이 함수를 부르기만 한다 (시험하기 쉽도록 분리). */
export async function handleSiemRequest(db: Db, request: Request, now: Date = new Date()): Promise<Response> {
  const key = await authenticateApiKey(db, request.headers.get("authorization"), now);
  if (!key) return json(401, { error: "인증에 실패했습니다. Authorization: Bearer <API 키> 헤더가 필요합니다." }, { "WWW-Authenticate": "Bearer" });

  const parsed = parseSiemParams(new URL(request.url).searchParams);
  if ("error" in parsed) return json(400, { error: parsed.error });

  const rows = await listIndicators(db, parsed.filter, parsed.limit);
  const headers = { "Cache-Control": "no-store" };
  if (parsed.format === "csv") {
    return new Response(toCsv(rows), { headers: { ...headers, "Content-Type": "text/csv; charset=utf-8" } });
  }
  if (parsed.format === "txt") {
    return new Response(toTxt(rows), { headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" } });
  }
  return new Response(toJson(rows, now), { headers: { ...headers, "Content-Type": "application/json; charset=utf-8" } });
}
