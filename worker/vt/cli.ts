/** 명령줄 진입점 (npm run vt:auto). GitHub Actions 에서 정기 실행한다. */
import { connect } from "../../scripts/db";
import { describeError } from "../../lib/error-info";
import { runVtAuto } from "./run";

async function main() {
  const { db, close } = connect();
  try {
    const maxItems = Number(process.env.VT_MAX_ITEMS ?? "50");
    const dailyCap = Number(process.env.VT_DAILY_CAP ?? "400");
    const r = await runVtAuto(db, { apiKey: process.env.VT_API_KEY, maxItems, dailyCap });
    console.log(`VirusTotal 자동 조회: ${r.checked}건 조회 (기록 ${r.recorded}, 이력 없음 ${r.notFound}), 오늘 남은 한도 약 ${r.remainingToday}건`);
    if (r.stopped) console.log(`::notice::${r.stopped}`);
  } finally {
    await close();
  }
}
main().catch((e) => {
  console.error("자동 조회 실패:", describeError(e));
  process.exit(1);
});
