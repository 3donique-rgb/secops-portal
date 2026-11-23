/**
 * 지표 조회: 화면(목록), PDF 보고서, SIEM API가 같은 조건 규칙을 쓰도록 한곳에 둔다.
 * 기간은 "최종 확인일(last_seen_at)" 기준이다.
 */
import { and, asc, desc, eq, exists, gte, ilike, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import { indicatorSources, indicators } from "../db/schema";
import type { Db } from "./indicators";

export const INDICATOR_TYPES = ["ip", "domain", "url", "hash", "email"] as const;
export type IndicatorType = (typeof INDICATOR_TYPES)[number];
export const INDICATOR_STATUSES = ["active", "inactive"] as const;
export type IndicatorStatus = (typeof INDICATOR_STATUSES)[number];

export type IndicatorFilter = {
  types?: IndicatorType[];
  status?: IndicatorStatus;
  /** 기관명 정확히 일치 */
  sourceName?: string;
  /** 값·메모·기관명 부분 일치 */
  keyword?: string;
  /** 최종 확인일 시작(포함) */
  from?: Date;
  /** 최종 확인일 끝(미포함) */
  to?: Date;
  /** all(기본) | only(제외된 것만) | none(제외된 것 빼고 = SIEM에 나가는 것) */
  excluded?: "all" | "only" | "none";
  /** 두 글자 국가 코드(예: KR). IP는 자기 자신, 도메인은 DNS로 찾은 IP의 국가 기준 */
  country?: string;
};

/** 위협정보의 IPv4를 숫자로: 도메인은 DNS로 찾은 IP, IP 종류는 값 자체. 해당 없으면 null */
const IND_ID = sql.raw('"indicators"."id"');
const IND_TYPE = sql.raw('"indicators"."type"');
const IND_VALUE = sql.raw('"indicators"."value"');
const ipNumSql = sql`coalesce(
  (select d.ip_num from domain_ips d where d.indicator_id = ${IND_ID} and d.status = 'ok'),
  case when ${IND_TYPE} = 'ip' and ${IND_VALUE} ~ '^[0-9]{1,3}(\\.[0-9]{1,3}){3}$'
    then split_part(${IND_VALUE}, '.', 1)::bigint * 16777216 + split_part(${IND_VALUE}, '.', 2)::bigint * 65536
       + split_part(${IND_VALUE}, '.', 3)::bigint * 256 + split_part(${IND_VALUE}, '.', 4)::bigint end)`;

/** 가장 좁은 대역의 국가가 같을 때만 일치 (GiST 인덱스로 빠르게 찾는다) */
function countryCond(code: string): SQL {
  return sql`(select r.country_code from net_ranges r where int8range(r.start_num, r.end_num, '[]') @> (${ipNumSql}) order by r.end_num - r.start_num limit 1) = ${code}`;
}

/** LIKE 특수문자(%, _, \)를 글자 그대로 찾도록 막는다. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, "\\$&");
}

export function buildWhere(f: IndicatorFilter): SQL | undefined {
  const kw = f.keyword?.trim();
  const conds: (SQL | undefined)[] = [
    f.types && f.types.length > 0 ? inArray(indicators.type, f.types) : undefined,
    f.status ? eq(indicators.status, f.status) : undefined,
    f.from ? gte(indicators.lastSeenAt, f.from) : undefined,
    f.to ? lt(indicators.lastSeenAt, f.to) : undefined,
    f.country ? countryCond(f.country.toUpperCase()) : undefined,
    f.excluded === "only" ? eq(indicators.excluded, true) : undefined,
    f.excluded === "none" ? eq(indicators.excluded, false) : undefined,
    f.sourceName
      ? exists(
          sql`(select 1 from ${indicatorSources} s where s.indicator_id = ${indicators.id} and s.source_name = ${f.sourceName})`,
        )
      : undefined,
    kw
      ? or(
          ilike(indicators.value, `%${escapeLike(kw.toLowerCase())}%`),
          ilike(indicators.memo, `%${escapeLike(kw)}%`),
          exists(
            sql`(select 1 from ${indicatorSources} s where s.indicator_id = ${indicators.id} and s.source_name ilike ${`%${escapeLike(kw)}%`})`,
          ),
        )
      : undefined,
  ];
  return and(...conds);
}

// select 목록에서는 열 이름의 표 구분이 빠지므로(s.id와 헷갈림) 표 이름을 직접 적는다.
const sourceNamesSql = sql<string[]>`coalesce((select array_agg(s.source_name order by s.source_name) from ${indicatorSources} s where s.indicator_id = ${sql.raw('"indicators"."id"')}), '{}')`;

export type IndicatorRow = {
  id: string;
  type: IndicatorType;
  value: string;
  hashKind: "md5" | "sha1" | "sha256" | null;
  status: IndicatorStatus;
  excluded: boolean;
  firstSeenAt: Date;
  lastSeenAt: Date;
  memo: string | null;
  sourceNames: string[];
};

const columns = {
  id: indicators.id,
  type: indicators.type,
  value: indicators.value,
  hashKind: indicators.hashKind,
  status: indicators.status,
  excluded: indicators.excluded,
  firstSeenAt: indicators.firstSeenAt,
  lastSeenAt: indicators.lastSeenAt,
  memo: indicators.memo,
  sourceNames: sourceNamesSql,
};

export async function countIndicators(db: Db, f: IndicatorFilter): Promise<number> {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(indicators)
    .where(buildWhere(f));
  return n;
}

export async function searchIndicators(
  db: Db,
  f: IndicatorFilter,
  opts: { page?: number; pageSize?: number } = {},
): Promise<{ rows: IndicatorRow[]; total: number; page: number; pageSize: number }> {
  const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 1), 200);
  const page = Math.max(opts.page ?? 1, 1);
  const rows = await db
    .select(columns)
    .from(indicators)
    .where(buildWhere(f))
    // 같은 시각이면 순서가 흔들리지 않도록 id로 한 번 더 정렬
    .orderBy(desc(indicators.lastSeenAt), asc(indicators.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return { rows, total: await countIndicators(db, f), page, pageSize };
}

/** 보고서·내보내기용: 쪽 나누기 없이 최대 limit건. */
export async function listIndicators(db: Db, f: IndicatorFilter, limit: number): Promise<IndicatorRow[]> {
  return db
    .select(columns)
    .from(indicators)
    .where(buildWhere(f))
    .orderBy(desc(indicators.lastSeenAt), asc(indicators.id))
    .limit(limit);
}

export async function getIndicatorDetail(db: Db, id: string) {
  const [row] = await db.select(columns).from(indicators).where(eq(indicators.id, id)).limit(1);
  if (!row) return null;
  const sourcesList = await db
    .select({
      sourceName: indicatorSources.sourceName,
      firstSeenAt: indicatorSources.firstSeenAt,
      lastSeenAt: indicatorSources.lastSeenAt,
      refUrl: indicatorSources.refUrl,
      note: indicatorSources.note,
    })
    .from(indicatorSources)
    .where(eq(indicatorSources.indicatorId, id))
    .orderBy(asc(indicatorSources.sourceName));
  return { indicator: row, sources: sourcesList };
}

/** 필터 선택 목록용: 지금까지 기록된 기관명 */
export async function listSourceNames(db: Db): Promise<string[]> {
  const rows = await db
    .selectDistinct({ name: indicatorSources.sourceName })
    .from(indicatorSources)
    .orderBy(asc(indicatorSources.sourceName));
  return rows.map((r) => r.name);
}

/** 조건에 맞는 지표의 종류별 건수 (보고서 요약용) */
export async function countByType(db: Db, f: IndicatorFilter): Promise<Record<string, number>> {
  const rows = await db
    .select({ type: indicators.type, n: sql<number>`count(*)::int` })
    .from(indicators)
    .where(buildWhere(f))
    .groupBy(indicators.type);
  return Object.fromEntries(rows.map((r) => [r.type, r.n]));
}

/** 조건에 맞는 지표의 기관별 건수 (한 지표를 여러 기관이 보냈으면 기관마다 1건씩 센다) */
export async function countBySource(db: Db, f: IndicatorFilter): Promise<{ name: string; n: number }[]> {
  const rows = await db
    .select({ name: indicatorSources.sourceName, n: sql<number>`count(distinct ${indicatorSources.indicatorId})::int` })
    .from(indicatorSources)
    .innerJoin(indicators, eq(indicators.id, indicatorSources.indicatorId))
    .where(buildWhere(f))
    .groupBy(indicatorSources.sourceName)
    .orderBy(desc(sql`count(distinct ${indicatorSources.indicatorId})`), asc(indicatorSources.sourceName));
  return rows;
}
