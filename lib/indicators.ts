/**
 * 지표 저장·중복 병합·만료 처리 [고정] - design.md 4.2, 4.3
 *
 * - 같은 지표(종류+값)는 한 건으로 합치고 출처 기관 목록을 모두 보관한다.
 * - 출처(기관명) 없이는 저장하지 않는다.
 * - 90일 동안 다시 확인되지 않으면 비활성, 다시 수집되면 활성으로 복귀한다.
 */
import { and, eq, lt, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { indicatorSources, indicators } from "../db/schema";
import type * as schemaModule from "../db/schema";
import { normalize } from "./normalize";

export type Db = PgDatabase<PgQueryResultHKT, typeof schemaModule>;

export const EXPIRE_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

export type SourceRef = { id: string; name: string };

export type SaveInput = {
  raw: string;
  source: SourceRef;
  /** 원문 링크 (게시글 주소 등) */
  refUrl?: string | null;
  note?: string | null;
  /** 확인 시각. 기본값은 현재 시각 (시험에서 시간을 지정할 때 사용) */
  now?: Date;
};

export type SaveResult =
  | { status: "created" | "updated" | "reactivated"; indicatorId: string }
  | { status: "invalid" };

export async function saveIndicator(
  db: Db,
  input: SaveInput,
): Promise<SaveResult> {
  const sourceName = input.source.name?.trim();
  if (!input.source.id || !sourceName) {
    // 출처 필수 규칙 [고정]
    throw new Error("출처(기관명) 없이는 위협정보를 저장할 수 없습니다.");
  }

  const norm = normalize(input.raw);
  if (!norm) return { status: "invalid" };

  const now = input.now ?? new Date();

  return db.transaction(async (tx) => {
    const find = () =>
      tx
        .select()
        .from(indicators)
        .where(
          and(eq(indicators.type, norm.type), eq(indicators.value, norm.value)),
        )
        .limit(1);

    let status: "created" | "updated" | "reactivated";
    let indicatorId: string;

    const [existing] = await find();
    if (existing) {
      indicatorId = existing.id;
      status = existing.status === "inactive" ? "reactivated" : "updated";
      await tx
        .update(indicators)
        .set({
          status: "active",
          // 시각이 거꾸로 가지 않도록 더 늦은 값만 반영
          lastSeenAt:
            existing.lastSeenAt > now ? existing.lastSeenAt : now,
        })
        .where(eq(indicators.id, existing.id));
    } else {
      const inserted = await tx
        .insert(indicators)
        .values({
          type: norm.type,
          value: norm.value,
          hashKind: norm.hashKind,
          status: "active",
          // 사설·예약 대역 IP는 처음부터 제외 표시
          excluded: norm.reserved,
          firstSeenAt: now,
          lastSeenAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: indicators.id });

      if (inserted.length > 0) {
        indicatorId = inserted[0].id;
        status = "created";
      } else {
        // 동시에 다른 작업이 먼저 넣은 경우: 기존 건으로 처리
        const [raced] = await find();
        indicatorId = raced.id;
        status = "updated";
        await tx
          .update(indicators)
          .set({ status: "active" })
          .where(eq(indicators.id, raced.id));
      }
    }

    await tx
      .insert(indicatorSources)
      .values({
        indicatorId,
        sourceId: input.source.id,
        sourceName,
        firstSeenAt: now,
        lastSeenAt: now,
        refUrl: input.refUrl ?? null,
        note: input.note ?? null,
      })
      .onConflictDoUpdate({
        target: [indicatorSources.indicatorId, indicatorSources.sourceId],
        set: {
          sourceName,
          lastSeenAt: now,
          ...(input.refUrl ? { refUrl: input.refUrl } : {}),
          ...(input.note ? { note: input.note } : {}),
        },
      });

    return { status, indicatorId };
  });
}

export type BulkItem = { raw: string; refUrl?: string | null; note?: string | null };
export type BulkResult = { created: number; updated: number; invalid: number };

/**
 * 같은 출처의 많은 항목을 한꺼번에 저장한다 (수만 건짜리 목록용).
 * 규칙은 saveIndicator 와 같다: (종류, 값) 한 건으로 병합, 출처 기관명 필수, 비활성이면 다시 활성, 시각은 거꾸로 가지 않음.
 * 항목마다 서버에 왕복하면 먼 DB에서는 몇 시간이 걸리므로, 묶음(기본 1,000건)마다 문장 2개만 보낸다.
 */
export async function saveIndicatorsBulk(
  db: Db,
  input: { items: BulkItem[]; source: SourceRef; now?: Date; chunkSize?: number },
): Promise<BulkResult> {
  const sourceName = input.source.name?.trim();
  if (!input.source.id || !sourceName) throw new Error("출처(기관명) 없이는 위협정보를 저장할 수 없습니다.");
  const now = input.now ?? new Date();
  const chunkSize = Math.max(1, input.chunkSize ?? 1000);

  // 정규화하고 같은 (종류, 값)은 하나로 합친다
  const unique = new Map<string, { norm: NonNullable<ReturnType<typeof normalize>>; refUrl: string | null; note: string | null }>();
  let invalid = 0;
  for (const it of input.items) {
    const norm = normalize(it.raw);
    if (!norm) {
      invalid++;
      continue;
    }
    const key = `${norm.type}\u0000${norm.value}`;
    if (!unique.has(key)) unique.set(key, { norm, refUrl: it.refUrl ?? null, note: it.note ?? null });
  }
  const list = [...unique.values()];

  let created = 0;
  let updated = 0;
  for (let i = 0; i < list.length; i += chunkSize) {
    const chunk = list.slice(i, i + chunkSize);
    const rows = await db
      .insert(indicators)
      .values(
        chunk.map((c) => ({
          type: c.norm.type,
          value: c.norm.value,
          hashKind: c.norm.hashKind,
          status: "active" as const,
          excluded: c.norm.reserved,
          firstSeenAt: now,
          lastSeenAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [indicators.type, indicators.value],
        set: { status: "active", lastSeenAt: sql`greatest(${indicators.lastSeenAt}, excluded.last_seen_at)` },
      })
      // xmax = 0 이면 이번에 새로 들어간 줄
      .returning({ id: indicators.id, type: indicators.type, value: indicators.value, inserted: sql<boolean>`(xmax = 0)` });

    const meta = new Map(chunk.map((c) => [`${c.norm.type}\u0000${c.norm.value}`, c]));
    await db
      .insert(indicatorSources)
      .values(
        rows.map((r) => {
          const m = meta.get(`${r.type}\u0000${r.value}`);
          return { indicatorId: r.id, sourceId: input.source.id, sourceName, firstSeenAt: now, lastSeenAt: now, refUrl: m?.refUrl ?? null, note: m?.note ?? null };
        }),
      )
      .onConflictDoUpdate({
        target: [indicatorSources.indicatorId, indicatorSources.sourceId],
        set: { sourceName, lastSeenAt: now },
      });
    for (const r of rows) r.inserted ? created++ : updated++;
  }
  return { created, updated, invalid };
}

/**
 * 마지막 확인일로부터 90일이 지난 활성 지표를 비활성으로 바꾼다.
 * 정확히 90일째까지는 활성이고, 90일을 넘기면 비활성이다.
 * 반환값: 비활성으로 바뀐 건수
 */
export async function expireIndicators(
  db: Db,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - EXPIRE_DAYS * DAY_MS);
  const rows = await db
    .update(indicators)
    .set({ status: "inactive" })
    .where(and(eq(indicators.status, "active"), lt(indicators.lastSeenAt, cutoff)))
    .returning({ id: indicators.id });
  return rows.length;
}
