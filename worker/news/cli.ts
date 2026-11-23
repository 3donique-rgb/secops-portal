/** 명령줄 진입점 (npm run news). GitHub Actions 에서 매일 실행한다. */
import { connect } from "../../scripts/db";
import { describeError } from "../../lib/error-info";
import { runNews } from "./run";

async function main() {
  const { db, close } = connect();
  try {
    const id = process.env.NAVER_CLIENT_ID;
    const secret = process.env.NAVER_CLIENT_SECRET;
    const r = await runNews(db, { days: Number(process.env.NEWS_DAYS ?? "2"), naver: id && secret ? { id, secret } : undefined });
    console.log(`보안뉴스 수집: 찾은 기사 ${r.found}건, 새로 저장 ${r.inserted}건 (본문 확보 ${r.bodies}건)`);
    console.log(`출처별 새 기사: ${JSON.stringify(r.byProvider)}`);
    if (!id || !secret) console.log("::notice::네이버 키(NAVER_CLIENT_ID/SECRET)가 없어 구글 뉴스만 수집했습니다.");
    for (const e of r.errors) console.log(`::warning::${e}`);
    if (r.errors.length >= 5 && r.inserted === 0) process.exit(1);
  } finally {
    await close();
  }
}
main().catch((e) => {
  console.error("보안뉴스 수집 실패:", describeError(e));
  process.exit(1);
});
