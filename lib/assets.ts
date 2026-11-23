/** 자산 등록·수정·삭제 (6.1~6.2). 변경 후에는 지표의 "제외" 여부를 다시 계산한다 (자산과 일치하는 지표는 SIEM에서 제외). */
import { and, asc, eq, ilike, or, sql } from "drizzle-orm";
import { assets } from "../db/schema";
import type { Db } from "./indicators";
import { escapeLike } from "./indicator-query";
import { isReservedIp, normalize } from "./normalize";
import { recomputeExcluded } from "./whitelist";

export const SCAN_LEVELS: Record<number, string> = {
  1: "1단계 — 생존 확인 + 주요 포트 100개",
  2: "2단계 — 주요 포트 약 1,000개",
  3: "3단계 — 2단계 + 서비스·버전 식별 + SSL 인증서 만료일",
  4: "4단계 — 3단계 + 노출 페이지(관리자 페이지 등)·RDP/SSH/Telnet 점검",
  5: "5단계 — 4단계 + 전체 65,535 포트 (시간이 오래 걸리며 일부만 점검될 수 있음)",
};

export type AssetInput = {
  name: string;
  target: string;
  owner?: string;
  department?: string;
  importance: number;
  scanLevel: number;
  /** 점검 허가 확인 체크 — 반드시 true [고정] */
  scanPermitted: boolean;
  enabled: boolean;
  memo?: string;
};

export type Result<T = object> = ({ ok: true } & T) | { ok: false; message: string };

function check(input: AssetInput): Result<{ clean: Omit<typeof assets.$inferInsert, "id" | "createdAt"> }> {
  const name = input.name.trim();
  if (!name || name.length > 100) return { ok: false, message: "자산명은 1~100자로 입력하세요." };
  if (!input.scanPermitted) return { ok: false, message: "점검이 허가된 우리 조직 자산임을 확인(체크)해야 등록할 수 있습니다." };
  const n = normalize(input.target);
  if (!n || (n.type !== "domain" && n.type !== "ip")) return { ok: false, message: "점검 대상은 도메인(예: portal.example.com) 또는 IP 주소만 입력할 수 있습니다." };
  if (n.type === "ip" && isReservedIp(n.value)) {
    return { ok: false, message: "사설·예약 IP는 외부(GitHub Actions)에서 점검할 수 없어 등록할 수 없습니다. 외부에서 접근 가능한 주소를 입력하세요." };
  }
  if (!Number.isInteger(input.importance) || input.importance < 1 || input.importance > 5) return { ok: false, message: "중요도는 1~5 입니다." };
  if (!Number.isInteger(input.scanLevel) || input.scanLevel < 1 || input.scanLevel > 5) return { ok: false, message: "점검 강도는 1~5단계입니다." };
  const clip = (s: string | undefined, max: number) => (s?.trim() ? s.trim().slice(0, max) : null);
  return {
    ok: true,
    clean: {
      name, target: n.value, owner: clip(input.owner, 100), department: clip(input.department, 100),
      importance: input.importance, scanLevel: input.scanLevel, scanPermitted: true, enabled: input.enabled, memo: clip(input.memo, 1000),
    },
  };
}

function assetWhere(f: { keyword?: string; enabled?: boolean }) {
  const kw = f.keyword?.trim();
  return and(
    f.enabled === undefined ? undefined : eq(assets.enabled, f.enabled),
    kw
      ? or(
          ilike(assets.name, `%${escapeLike(kw)}%`),
          ilike(assets.target, `%${escapeLike(kw.toLowerCase())}%`),
          ilike(assets.owner, `%${escapeLike(kw)}%`),
          ilike(assets.department, `%${escapeLike(kw)}%`),
        )
      : undefined,
  );
}

/** 쪽 나누기 목록 */
export async function listAssetsPage(db: Db, f: { keyword?: string; enabled?: boolean }, opts: { page: number; pageSize: number }) {
  const rows = await db
    .select()
    .from(assets)
    .where(assetWhere(f))
    .orderBy(asc(assets.name), asc(assets.id))
    .limit(opts.pageSize)
    .offset((Math.max(opts.page, 1) - 1) * opts.pageSize);
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(assets).where(assetWhere(f));
  return { rows, total: n };
}

export async function listAssets(db: Db, f: { keyword?: string; enabled?: boolean } = {}) {
  const kw = f.keyword?.trim();
  return db
    .select()
    .from(assets)
    .where(
      and(
        f.enabled === undefined ? undefined : eq(assets.enabled, f.enabled),
        kw
          ? or(
              ilike(assets.name, `%${escapeLike(kw)}%`),
              ilike(assets.target, `%${escapeLike(kw.toLowerCase())}%`),
              ilike(assets.owner, `%${escapeLike(kw)}%`),
              ilike(assets.department, `%${escapeLike(kw)}%`),
            )
          : undefined,
      ),
    )
    .orderBy(asc(assets.name));
}

export async function getAsset(db: Db, id: string) {
  const [row] = await db.select().from(assets).where(eq(assets.id, id)).limit(1);
  return row ?? null;
}

export async function countAssets(db: Db): Promise<{ total: number; enabled: number }> {
  const [r] = await db
    .select({ total: sql<number>`count(*)::int`, enabled: sql<number>`count(*) filter (where ${assets.enabled})::int` })
    .from(assets);
  return r;
}

export async function createAsset(db: Db, input: AssetInput): Promise<Result<{ id: string; recomputed: number }>> {
  const c = check(input);
  if (!c.ok) return c;
  const [dup] = await db.select({ id: assets.id }).from(assets).where(eq(assets.target, c.clean.target)).limit(1);
  if (dup) return { ok: false, message: "이미 등록된 점검 대상입니다." };
  const [row] = await db.insert(assets).values(c.clean).returning({ id: assets.id });
  const r = await recomputeExcluded(db);
  return { ok: true, id: row.id, recomputed: r.excluded };
}

export async function updateAsset(db: Db, id: string, input: AssetInput): Promise<Result> {
  const c = check(input);
  if (!c.ok) return c;
  if (!(await getAsset(db, id))) return { ok: false, message: "자산을 찾을 수 없습니다." };
  const [dup] = await db.select({ id: assets.id }).from(assets).where(eq(assets.target, c.clean.target)).limit(1);
  if (dup && dup.id !== id) return { ok: false, message: "이미 등록된 점검 대상입니다." };
  await db.update(assets).set(c.clean).where(eq(assets.id, id));
  await recomputeExcluded(db);
  return { ok: true };
}

/** 삭제하면 그 자산의 점검 결과·알림도 함께 지워진다. */
export async function deleteAsset(db: Db, id: string): Promise<Result<{ name: string }>> {
  const rows = await db.delete(assets).where(eq(assets.id, id)).returning({ name: assets.name });
  if (rows.length === 0) return { ok: false, message: "자산을 찾을 수 없습니다." };
  await recomputeExcluded(db);
  return { ok: true, name: rows[0].name };
}
