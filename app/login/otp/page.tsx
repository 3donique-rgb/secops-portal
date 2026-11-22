import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { PRE_AUTH_COOKIE, beginOtpSetup, readPreAuthToken } from "@/lib/auth";
import { OtpForm } from "./otp-form";

export const metadata = { title: "OTP 인증 - 보안관제 포털" };

async function OtpContent() {
  await connection(); // 요청 시점에만 실행(시각·쿠키를 쓰므로 미리 만들어 두지 않는다)
  const userId = await readPreAuthToken((await cookies()).get(PRE_AUTH_COOKIE)?.value);
  if (!userId) redirect("/login");

  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user || user.locked) redirect("/login");

  // 처음 로그인하는 계정이면 OTP 등록 QR을 보여 준다. (새로고침하면 새 QR이 만들어진다)
  const setup = user.otpEnabled ? null : await beginOtpSetup(db, user.id);

  return (
    <>
      <h1 className="mb-1 text-xl font-bold">OTP 인증</h1>
      {setup ? (
        <div className="mb-4 space-y-3 text-sm">
          <p className="text-gray-600">
            처음 로그인하셨습니다. 휴대폰의 Google Authenticator 앱에서 아래 QR을 스캔한 뒤, 앱에 표시된
            6자리 코드를 입력하세요.
          </p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={setup.qrDataUrl} alt="OTP 등록 QR 코드" width={200} height={200} className="mx-auto" />
          <p className="text-gray-500">
            QR을 스캔할 수 없으면 앱에서 직접 입력하세요: <code className="break-all">{setup.secret}</code>
          </p>
        </div>
      ) : (
        <p className="mb-4 text-sm text-gray-600">Google Authenticator 앱에 표시된 6자리 코드를 입력하세요.</p>
      )}
      <OtpForm />
    </>
  );
}

export default function OtpPage() {
  return (
    <main className="mx-auto mt-24 w-full max-w-sm rounded-lg border border-gray-200 p-6">
      <Suspense fallback={<p className="text-sm text-gray-500">불러오는 중…</p>}>
        <OtpContent />
      </Suspense>
    </main>
  );
}
