/** 명령줄 진입점 (npm run cleanup). GitHub Actions 에서 하루 한 번 실행한다. */
import { connect } from "../scripts/db";
import { runCleanup } from "./cleanup";

async function main() {
  const { db, close } = connect();
  try {
    const r = await runCleanup(db);
    console.log(`만료 처리된 지표 ${r.expired}건, 삭제: 점검 결과 ${r.scanResults}건, 알림 ${r.notifications}건, 수집 이력 ${r.collectRuns}건`);
  } finally {
    await close();
  }
}
main().catch((e) => {
  console.error("정리 작업 실패:", e instanceof Error ? e.message : e);
  process.exit(1);
});
