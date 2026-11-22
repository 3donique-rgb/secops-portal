/** 명령줄 진입점 (npm run scan). GitHub Actions 에서 매일 실행하며 자산을 묶음으로 나눠 병렬 실행한다. */
import { connect } from "../../scripts/db";
import { describeError } from "../../lib/error-info";
import { runScan } from "./index";

async function main() {
  const idx = Number(process.env.SCAN_SHARD_INDEX ?? "0");
  const total = Number(process.env.SCAN_SHARD_TOTAL ?? "1");
  const max = process.env.SCAN_MAX_ASSETS ? Number(process.env.SCAN_MAX_ASSETS) : undefined;
  if (!Number.isInteger(idx) || !Number.isInteger(total) || total < 1 || idx < 0 || idx >= total) throw new Error("묶음 번호 설정이 올바르지 않습니다.");
  const { db, close } = connect();
  try {
    const r = await runScan(db, { shard: { index: idx, total }, maxAssets: max && max > 0 ? max : undefined });
    console.log(`묶음 ${idx + 1}/${total}: 점검 ${r.scanned}건 (성공 ${r.success}, 일부만 ${r.partial}, 실패 ${r.fail}), 새 알림 ${r.notifications}건`);
  } finally {
    await close();
  }
}
main().catch((e) => {
  console.error("점검 실패:", describeError(e));
  process.exit(1);
});
