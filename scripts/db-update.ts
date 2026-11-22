/**
 * DB 표 정의를 최신으로 맞춘다 (여러 번 실행해도 안전).
 * db/migrations 의 SQL을 순서대로 실행하되, 이미 있는 표·타입·인덱스는 건너뛴다.
 * 환경변수: DATABASE_URL (값은 출력하지 않는다)
 */
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { describeError } from "../lib/error-info";

// 42710 duplicate_object, 42P07 duplicate_table(인덱스 포함), 42701 duplicate_column
const SKIP = new Set(["42710", "42P07", "42701"]);

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL 환경변수가 설정되지 않았습니다.");
    process.exit(1);
  }
  const sql = postgres(url, { prepare: false, max: 1 });
  try {
    const dir = path.resolve(__dirname, "../db/migrations");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    let applied = 0;
    let skipped = 0;
    for (const f of files) {
      const stmts = fs.readFileSync(path.join(dir, f), "utf8").split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
      for (const st of stmts) {
        try {
          await sql.unsafe(st);
          applied++;
        } catch (e) {
          const code = (e as { code?: string }).code ?? "";
          if (SKIP.has(code)) skipped++;
          else throw e;
        }
      }
      console.log(`${f}: 확인 완료`);
    }
    console.log(`새로 적용 ${applied}건, 이미 있어서 건너뜀 ${skipped}건`);
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error("실패:", describeError(e));
  process.exit(1);
});
