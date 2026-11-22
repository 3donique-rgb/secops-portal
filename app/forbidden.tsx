import Link from "next/link";

export default function Forbidden() {
  return (
    <main className="mx-auto mt-24 max-w-sm text-center">
      <h1 className="mb-2 text-xl font-bold">403 접근 권한이 없습니다</h1>
      <p className="mb-4 text-sm text-gray-600">이 화면은 관리자만 볼 수 있습니다.</p>
      <Link href="/" className="text-sm underline">
        처음으로
      </Link>
    </main>
  );
}
