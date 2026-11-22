import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "보안관제 포털",
  description: "위협정보 수집·정리와 외부 자산 점검 관리",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ko" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
