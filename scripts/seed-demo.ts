/**
 * 개발용 가짜 데이터를 넣는다 (출처 3개, 지표 50건, 자산 10개).
 *   npm run seed:demo          → 넣기 (여러 번 실행해도 중복되지 않음)
 *   npm run seed:demo -- --clear → 가짜 데이터만 지우기
 */
import { clearDemo, seedDemo } from "../lib/seed";
import { connect } from "./db";
import { describeError } from "../lib/error-info";

async function main() {
  const { db, close } = connect();
  try {
    if (process.argv.includes("--clear")) {
      const r = await clearDemo(db);
      console.log(`가짜 데이터를 지웠습니다: 지표 ${r.indicators}건, 자산 ${r.assets}개, 출처 ${r.sources}개`);
    } else {
      const r = await seedDemo(db);
      console.log(
        `가짜 데이터: 출처 ${r.sources}개, 지표 ${r.indicators}건, 새로 넣은 자산 ${r.assets}개 (제외 처리 ${r.excluded}건)`,
      );
    }
  } finally {
    await close();
  }
}

main().catch((e) => {
  console.error("실패:", describeError(e));
  process.exit(1);
});
