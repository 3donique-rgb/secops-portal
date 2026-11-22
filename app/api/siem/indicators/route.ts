import { connection } from "next/server";
import { getDb } from "@/db";
import { handleSiemRequest } from "@/lib/siem";

/** SIEM 제공 API. 세션이 아니라 API 키(Bearer)로 인증한다. */
export async function GET(request: Request) {
  await connection(); // 항상 요청 시점에 실행 (빌드 때 미리 만들어 두지 않는다)
  return handleSiemRequest(getDb(), request);
}
