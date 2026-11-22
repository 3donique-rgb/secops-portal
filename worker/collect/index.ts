/** 명령줄 진입점: GitHub Actions 에서 1시간마다 실행한다. (npm run collect) */
import { connect } from "../../scripts/db";
import { makeFetcher } from "./fetcher";
import { runCollect } from "./run";

async function main() {
  const { db, close } = connect();
  try {
    const results = await runCollect(db, { fetcher: makeFetcher() });
    if (results.length === 0) console.log("사용 중인 수집 출처가 없습니다.");
    for (const r of results) {
      if (r.status === "success") console.log(`✔ ${r.name}: 찾은 값 ${r.found}건, 새 지표 ${r.newCount}건`);
      else console.log(`::warning::✘ ${r.name}: ${r.error}`);
    }
    // 모든 출처가 실패했을 때만 작업 전체를 실패로 표시한다 (한두 곳의 일시 오류로 매시간 빨간불이 켜지지 않도록)
    if (results.length > 0 && results.every((r) => r.status === "fail")) process.exitCode = 1;
  } finally {
    await close();
  }
}

main().catch((e) => {
  console.error("수집 실행 실패:", e instanceof Error ? e.message : e);
  process.exit(1);
});
