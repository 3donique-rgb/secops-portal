/** 노출 페이지 점검 (7.4): 정해진 경로 목록에 GET 요청 한 번씩만 보내 응답 코드를 기록한다. 로그인·입력값 전송은 하지 않는다. */
import http from "node:http";
import https from "node:https";
import type { ExposedPage } from "../../db/schema";

export type PathRule = { path: string; kind: string };

/** 외부에 열려 있으면 안 되는(또는 확인이 필요한) 대표 경로 */
export const EXPOSED_PATHS: PathRule[] = [
  { path: "/admin", kind: "관리자 페이지" },
  { path: "/administrator", kind: "관리자 페이지" },
  { path: "/manager/html", kind: "관리자 페이지(Tomcat)" },
  { path: "/phpmyadmin/", kind: "DB 관리 도구" },
  { path: "/wp-admin/", kind: "관리자 페이지(WordPress)" },
  { path: "/wp-login.php", kind: "로그인 페이지(WordPress)" },
  { path: "/login", kind: "로그인 페이지" },
  { path: "/console", kind: "관리 콘솔" },
  { path: "/actuator", kind: "운영 정보(Spring)" },
  { path: "/actuator/env", kind: "운영 정보(Spring)" },
  { path: "/server-status", kind: "서버 상태(Apache)" },
  { path: "/swagger-ui.html", kind: "API 문서" },
  { path: "/v2/api-docs", kind: "API 문서" },
  { path: "/.git/HEAD", kind: "소스 저장소 노출" },
  { path: "/.env", kind: "설정 파일 노출" },
  { path: "/.svn/entries", kind: "소스 저장소 노출" },
  { path: "/backup.zip", kind: "백업 파일 노출" },
  { path: "/web.config", kind: "설정 파일 노출" },
  { path: "/phpinfo.php", kind: "서버 정보 노출" },
];

/** 노출로 기록하는 응답 코드: 열람 가능(200), 로그인 요구(401), 접근 거부(403) */
const RECORD = new Set([200, 401, 403]);

function get(url: URL, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      url,
      { method: "GET", timeout: timeoutMs, rejectUnauthorized: false, headers: { "user-agent": "secops-portal-scan", accept: "*/*" } },
      (res) => {
        res.destroy(); // 본문은 읽지 않는다
        resolve(res.statusCode ?? null);
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
    req.end();
  });
}

/** 열린 웹 포트(80/443/8080/8443 등)마다 경로 목록을 한 번씩 확인한다. 같은 경로는 가장 먼저 기록된 응답만 남긴다. */
export async function checkPaths(
  host: string,
  webPorts: { port: number; tls: boolean }[],
  opts: { rules?: PathRule[]; timeoutMs?: number; gapMs?: number; deadline?: number } = {},
): Promise<{ pages: ExposedPage[]; incomplete: boolean }> {
  const rules = opts.rules ?? EXPOSED_PATHS;
  const pages: ExposedPage[] = [];
  const seen = new Set<string>();
  let incomplete = false;
  for (const wp of webPorts) {
    for (const r of rules) {
      if (Date.now() > (opts.deadline ?? Infinity)) {
        incomplete = true;
        return { pages, incomplete };
      }
      const defaultPort = wp.tls ? 443 : 80;
      const url = new URL(`${wp.tls ? "https" : "http"}://${host}${wp.port === defaultPort ? "" : `:${wp.port}`}${r.path}`);
      const code = await get(url, opts.timeoutMs ?? 5000);
      if (code !== null && RECORD.has(code) && !seen.has(r.path)) {
        seen.add(r.path);
        pages.push({ path: r.path, statusCode: code, kind: r.kind });
      }
      if (opts.gapMs) await new Promise((x) => setTimeout(x, opts.gapMs));
    }
  }
  return { pages, incomplete };
}
