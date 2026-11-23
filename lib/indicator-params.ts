/** 주소창/폼의 검색 조건(문자열)을 안전하게 IndicatorFilter로 바꾼다. 잘못된 값은 무시한다. */
import {
  INDICATOR_STATUSES,
  INDICATOR_TYPES,
  type IndicatorFilter,
  type IndicatorStatus,
  type IndicatorType,
} from "./indicator-query";

export type RawParams = Record<string, string | string[] | undefined>;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** "YYYY-MM-DD"를 한국 시간 0시로. 형식이 틀리거나 없는 날짜(2월 30일 등)면 undefined. */
export function kstDate(v: string | undefined, plusDays = 0): Date | undefined {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
  const d = new Date(`${v}T00:00:00+09:00`);
  if (Number.isNaN(d.getTime())) return undefined;
  if (d.toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" }) !== v) return undefined;
  return new Date(d.getTime() + plusDays * 86400000);
}

export function parseIndicatorParams(sp: RawParams): { filter: IndicatorFilter; page: number } {
  const typeValues = ([] as string[]).concat(sp.type ?? []);
  const types = typeValues.filter((t): t is IndicatorType => (INDICATOR_TYPES as readonly string[]).includes(t));
  const status = first(sp.status);
  const excluded = first(sp.excluded);
  const filter: IndicatorFilter = {
    types: types.length > 0 ? [...new Set(types)] : undefined,
    status: (INDICATOR_STATUSES as readonly string[]).includes(status ?? "") ? (status as IndicatorStatus) : undefined,
    sourceName: first(sp.source)?.slice(0, 200) || undefined,
    keyword: first(sp.q)?.slice(0, 200) || undefined,
    from: kstDate(first(sp.from)),
    to: kstDate(first(sp.to), 1), // 종료일 당일 포함
    country: /^[A-Za-z]{2}$/.test(first(sp.country)?.trim() ?? "") ? first(sp.country)!.trim().toUpperCase() : undefined,
    excluded: excluded === "only" || excluded === "none" ? excluded : undefined,
  };
  const page = Math.min(Math.max(Number.parseInt(first(sp.page) ?? "1", 10) || 1, 1), 100000);
  return { filter, page };
}

const STATUS_LABEL = { active: "활성", inactive: "비활성(만료)" } as const;
const TYPE_NAMES: Record<string, string> = { ip: "IP", domain: "도메인", url: "URL", hash: "파일 해시", email: "메일 발신자" };

/** 보고서·화면에 적는 조건 요약 (사람이 읽는 문장 목록). */
export function describeFilter(sp: RawParams, f: IndicatorFilter): string[] {
  const out: string[] = [];
  const from = first(sp.from);
  const to = first(sp.to);
  if (f.from || f.to) out.push(`기간(최종 확인일): ${f.from ? from : "처음"} ~ ${f.to ? to : "현재"}`);
  if (f.types?.length) out.push(`종류: ${f.types.map((t) => TYPE_NAMES[t]).join(", ")}`);
  if (f.sourceName) out.push(`제공 기관: ${f.sourceName}`);
  if (f.country) out.push(`국가: ${f.country}`);
  if (f.status) out.push(`상태: ${STATUS_LABEL[f.status]}`);
  if (f.excluded === "only") out.push("SIEM 제외된 것만");
  if (f.excluded === "none") out.push("SIEM 제외 안 된 것만");
  if (f.keyword) out.push(`키워드: ${f.keyword}`);
  return out;
}
