/** 명령줄 진입점 (npm run enrich). GitHub Actions 에서 정기 실행한다. */
import { connect } from "../../scripts/db";
import { describeError } from "../../lib/error-info";
import { runEnrich } from "./run";

async function main() {
  const { db, close } = connect();
  try {
    const r = await runEnrich(db, { deadlineMs: Date.now() + 12 * 60 * 1000 });
    console.log(`도메인 IP 확인: 찾음 ${r.resolved}건, DNS에 없음 ${r.unresolved}건 / 등록기관 국가 목록 ${r.delegatedRanges}개 대역 갱신 / 추가 조회(RDAP) ${r.rdapLookups}회, 새 대역 ${r.ranges}개`);
    const via = Object.entries(r.byResolver).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ");
    if (via) console.log(`IP를 알려준 DNS 서버: ${via}`);
    if (r.stopped) console.log(`::notice::${r.stopped}`);
  } finally {
    await close();
  }
}
main().catch((e) => {
  console.error("IP·국가 확인 실패:", describeError(e));
  process.exit(1);
});
