/**
 * 시험용 가짜 DB: 메모리에서 도는 PostgreSQL(PGlite)에 실제 마이그레이션 파일을 적용한다.
 * 운영 DB(Supabase)와 같은 표 정의로 시험하기 위해 db/migrations를 그대로 쓴다.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import path from "node:path";
import * as schema from "../../db/schema";

export async function createTestDb() {
  const client = new PGlite();
  const db = drizzle(client, { schema, casing: "snake_case" });
  await migrate(db, {
    migrationsFolder: path.resolve(__dirname, "../../db/migrations"),
  });
  return { db, client };
}

/** 시험 사이에 데이터를 모두 비운다. */
export async function resetData(client: PGlite) {
  await client.exec(
    "truncate table indicator_sources, indicators, collect_runs, sources, whitelist, notifications, scan_results, assets, audit_logs, api_keys, user_allowed_ips, users restart identity cascade",
  );
}
