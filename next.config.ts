import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  experimental: { authInterrupts: true },
  // pdfkit은 번들에 넣지 않고 그대로 쓰고, 한글 글꼴 파일은 보고서 경로에 함께 배포한다
  serverExternalPackages: ["pdfkit"],
  outputFileTracingIncludes: { "/reports/pdf": ["./assets/fonts/**"] },
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
