/**
 * 자산 보안위험등급: 가장 최근 점검 결과로 안전 / 주의 / 위험을 정한다.
 * 위험 = 외부에 열려 있으면 곧바로 사고로 이어지기 쉬운 것, 주의 = 확인·조치가 필요한 것.
 * 점검 결과가 아직 없으면 "미점검"(등급 없음)으로 둔다.
 */
import type { ExposedPage, OpenPort } from "../db/schema";

export type RiskLevel = "danger" | "caution" | "safe" | "none";
export const RISK_LABEL: Record<RiskLevel, string> = { danger: "위험", caution: "주의", safe: "안전", none: "미점검" };
export const RISK_COLOR: Record<RiskLevel, string> = { danger: "var(--bad)", caution: "#e6a800", safe: "var(--ok)", none: "#9aa7b0" };

/** 인터넷에 열려 있으면 위험한 포트 */
export const DANGEROUS_PORTS: Record<number, string> = {
  21: "FTP", 23: "Telnet", 69: "TFTP", 135: "MS RPC", 139: "NetBIOS", 445: "SMB", 512: "rexec", 513: "rlogin", 514: "rsh", 1433: "MS SQL", 1521: "Oracle DB",
  2049: "NFS", 3306: "MySQL", 3389: "원격 데스크톱(RDP)", 5432: "PostgreSQL", 5900: "VNC", 6379: "Redis", 9200: "Elasticsearch", 11211: "Memcached", 27017: "MongoDB",
};
/** 열려 있으면 확인이 필요한 포트 */
export const CAUTION_PORTS: Record<number, string> = { 22: "SSH", 25: "SMTP", 110: "POP3", 143: "IMAP", 161: "SNMP", 389: "LDAP", 8080: "HTTP 대체", 8443: "HTTPS 대체" };
/** 열려 있다고 응답하면(200) 곧바로 위험한 노출 페이지 종류 */
const SENSITIVE_KIND = /(소스 저장소|설정 파일|백업|서버 정보|운영 정보|서버 상태)/;
export const CERT_WARN_DAYS = 30;
const DAY = 86_400_000;

export type RiskInput = { status: "success" | "fail" | "partial"; openPorts: OpenPort[]; exposedPages: ExposedPage[]; certExpiresAt: Date | null };
export type Risk = { level: RiskLevel; reasons: string[] };

export function assessRisk(scan: RiskInput | null, now: Date): Risk {
  if (!scan) return { level: "none", reasons: ["점검 결과가 아직 없습니다."] };
  const danger: string[] = [];
  const caution: string[] = [];
  for (const p of scan.openPorts) {
    if (DANGEROUS_PORTS[p.port]) danger.push(`${p.port}/tcp ${DANGEROUS_PORTS[p.port]} 외부 노출`);
    else if (CAUTION_PORTS[p.port]) caution.push(`${p.port}/tcp ${CAUTION_PORTS[p.port]} 열림`);
  }
  for (const pg of scan.exposedPages) {
    if (pg.statusCode === 200 && SENSITIVE_KIND.test(pg.kind)) danger.push(`${pg.path} 노출 (${pg.kind})`);
    else caution.push(`${pg.path} 접근 가능 (${pg.kind}, 응답 ${pg.statusCode})`);
  }
  if (scan.certExpiresAt) {
    const left = Math.floor((scan.certExpiresAt.getTime() - now.getTime()) / DAY);
    if (left < 0) danger.push(`인증서 ${-left}일 전 만료`);
    else if (left <= CERT_WARN_DAYS) caution.push(`인증서 만료 ${left}일 전`);
  }
  if (scan.status === "fail") caution.push("최근 점검에서 응답이 없었습니다.");
  if (danger.length) return { level: "danger", reasons: [...danger, ...caution] };
  if (caution.length) return { level: "caution", reasons: caution };
  return { level: "safe", reasons: ["위험 징후가 발견되지 않았습니다."] };
}
