/**
 * 최초 관리자 계정을 만든다.
 * 환경변수: DATABASE_URL, INITIAL_ADMIN_USERNAME, INITIAL_ADMIN_PASSWORD (값은 출력하지 않는다)
 * 같은 아이디가 이미 있으면 아무것도 바꾸지 않는다.
 */
import { seedAdmin } from "../lib/seed";
import { connect } from "./db";

async function main() {
  const username = process.env.INITIAL_ADMIN_USERNAME;
  const password = process.env.INITIAL_ADMIN_PASSWORD;
  if (!username || !password) {
    console.error("INITIAL_ADMIN_USERNAME, INITIAL_ADMIN_PASSWORD 환경변수가 필요합니다.");
    process.exit(1);
  }
  const { db, close } = connect();
  try {
    const r = await seedAdmin(db, { username, password });
    if (r.status === "created") console.log(`관리자 계정을 만들었습니다: ${r.username} (첫 로그인 때 OTP를 등록하세요)`);
    else if (r.status === "exists") console.log(`이미 있는 아이디입니다: ${r.username} (변경 없음)`);
    else {
      console.error(`만들지 못했습니다: ${r.message}`);
      process.exit(1);
    }
  } finally {
    await close();
  }
}

main().catch((e) => {
  console.error("실패:", e instanceof Error ? e.message : "알 수 없는 오류");
  process.exit(1);
});
