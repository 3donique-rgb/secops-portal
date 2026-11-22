import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

let cached: ReturnType<typeof create> | undefined;

function create(url: string) {
  // prepare: false → Supabase 연결 풀러(트랜잭션 모드)와 호환
  const client = postgres(url, { prepare: false, max: 3 });
  return drizzle(client, { schema, casing: "snake_case" });
}

/** DB 연결을 돌려준다. 환경변수 DATABASE_URL이 없으면 오류를 낸다. */
export function getDb() {
  if (cached) return cached;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL 환경변수가 설정되지 않았습니다.");
  }
  cached = create(url);
  return cached;
}

export { schema };
