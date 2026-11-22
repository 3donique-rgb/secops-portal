import { LoginForm } from "./login-form";

export const metadata = { title: "로그인 - 보안관제 포털" };

export default function LoginPage() {
  return (
    <main className="mx-auto mt-24 w-full max-w-sm rounded-lg border border-gray-200 p-6">
      <h1 className="mb-1 text-xl font-bold">보안관제 포털</h1>
      <p className="mb-6 text-sm text-gray-500">아이디와 비밀번호를 입력한 뒤 OTP 인증을 진행합니다.</p>
      <LoginForm />
    </main>
  );
}
