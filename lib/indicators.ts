/**
 * 지표 저장·중복 병합·만료 처리 [고정] - design.md 4.2, 4.3
 *
 * - 같은 지표(종류+값)는 한 건으로 합치고 출처 기관 목록을 모두 보관한다.
 * - 출처(기관명) 없이는 저장하지 않는다.
 * - 90일 동안 다시 확인되지 않으면 비활성, 다시 수집되면 활성으로 복귀한다.
 */
import { and, eq, lt } from "drizzle-orm";
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
