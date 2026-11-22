/** 인증서 만료일 확인 (7.3): TLS 핸드셰이크만 하고 인증서의 만료일을 읽는다. 데이터는 보내지 않는다. */
import tls from "node:tls";

/** 인증서를 확인할 만한 포트 */
export const TLS_PORTS = [443, 8443, 465, 993, 995, 636, 4443, 9443];

export type CertInfo = { port: number; expiresAt: Date; subject?: string };

export function readCert(host: string, port: number, timeoutMs = 4000): Promise<CertInfo | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: CertInfo | null) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(v);
    };
    // 인증서가 자체 서명이거나 만료돼도 만료일은 읽어야 하므로 검증은 끈다 (이 연결로는 아무 데이터도 보내지 않는다).
    const sock = tls.connect({ host, port, servername: /^[\d.]+$/.test(host) ? undefined : host, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const c = sock.getPeerCertificate();
      const t = c?.valid_to ? new Date(c.valid_to) : null;
      finish(t && !Number.isNaN(t.getTime()) ? { port, expiresAt: t, subject: typeof c.subject?.CN === "string" ? c.subject.CN : undefined } : null);
    });
    sock.on("timeout", () => finish(null));
    sock.on("error", () => finish(null));
  });
}

/** 열린 포트 중 TLS 후보를 확인해 가장 빨리 만료되는 인증서를 돌려준다. */
export async function earliestCert(host: string, openPorts: number[]): Promise<CertInfo | null> {
  const found: CertInfo[] = [];
  for (const p of openPorts.filter((x) => TLS_PORTS.includes(x))) {
    const c = await readCert(host, p);
    if (c) found.push(c);
  }
  return found.sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime())[0] ?? null;
}
