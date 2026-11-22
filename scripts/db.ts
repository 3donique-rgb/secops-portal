/** 스크립트 공통: 환경변수 DATABASE_URL로 DB에 연결한다. 접속 주소는 출력하지 않는다. */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../db/schema";

export function connect() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL 환경변수가 설정되지 않았습니다.");
    process.exit(1);
  }
  const client = postgres(url, { prepare: false, max: 1 });
  const db = drizzle(client, { schema, casing: "snake_case" });
  return { db, close: () => client.end() };
}
