import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * 1차 문지기(빠른 확인): 세션 쿠키가 아예 없으면 /login 으로 보낸다.
 * 진짜 확인(서명·만료·DB의 잠금/권한)은 각 화면의 requireUser/requireAdmin 이 한다.
 */
export function proxy(request: NextRequest) {
  if (!request.cookies.has("secops_session")) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  return NextResponse.next();
}

export const config = {
  // 로그인 화면, 정적 파일, 수집기용 API·예약 실행 요청(자체 비밀 값 인증)는 제외
  matcher: ["/((?!login|_next/static|_next/image|favicon.ico|api/siem|api/cron).*)"],
};
