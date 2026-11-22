import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./db/schema.ts",
  out: "./db/migrations",
  casing: "snake_case",
  dbCredentials: {
    // 마이그레이션 생성(generate)에는 접속 주소가 필요 없고, 실행(migrate)할 때만 쓰인다.
    url: process.env.DATABASE_URL ?? "",
  },
});
