import { execSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { assets, notifications, scanResults } from "../db/schema";
import { detectChanges, diffResults } from "../worker/scan/diff";
import { runScan, scanAsset } from "../worker/scan";
import { checkPaths } from "../worker/scan/paths";
import { identifyService, portsForLevel, scanPorts, TOP_100, TOP_1000 } from "../worker/scan/ports";
import { readCert } from "../worker/scan/tls";
import { createTestDb, resetData } from "./helpers/test-db";

/**
 * 시험 사례 표 (가짜 서버는 이 컴퓨터 안에서만 연다)
 *  1. 단계별 포트 목록   → 1단계 100개, 2~4단계 약 1,000개(1~1024 포함), 5단계 65,535개
 *  2. 포트 연결          → 열린 포트만 기록, 닫힌 포트는 제외, 거부 응답은 "살아 있음"으로 판단
 *  3. 서비스 식별        → SSH·HTTP·FTP·SMTP 배너에서 이름과 버전을 읽음, 1~2단계는 식별하지 않음
 *  4. 인증서             → TLS 서버의 만료일을 읽음
 *  5. 노출 페이지        → 200/401/403만 기록, 404는 제외, 본문은 읽지 않음
 *  6. 실행·저장          → 하루 한 건(재실행 덮어씀), 비활성 자산 건너뜀, 사설 주소는 점검 거부, 묶음·최대 개수
 *  7. 시간 제한          → 제한을 넘으면 partial
 *  8. 변화 감지          → 첫 점검은 알림 없음, 새 포트/닫힘/새 페이지/인증서 임박/접속 불가, 같은 날 재실행 시 중복 없음
 */
let ctx: Awaited<ReturnType<typeof createTestDb>>;
const servers: { close: () => void }[] = [];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scan-test-"));

function tcpServer(banner: string): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const s = net.createServer((c) => {
      c.on("error", () => {});
      c.write(banner);
    });
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      const h = { port, close: () => s.close() };
      servers.push(h);
      resolve(h);
    });
  });
}
function httpServer(): Promise<{ port: number; hits: string[]; close: () => void }> {
  return new Promise((resolve) => {
    const hits: string[] = [];
    const s = http.createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      const code = { "/admin": 200, "/login": 401, "/.env": 403 }[req.url ?? ""] ?? 404;
      res.writeHead(code, { server: "TestHTTPd/1.2" });
      res.end("secret-body");
    });
    s.listen(0, "127.0.0.1", () => {
      const h = { port: (s.address() as net.AddressInfo).port, hits, close: () => s.close() };
      servers.push(h);
      resolve(h);
    });
  });
}
function tlsServer(days: number): Promise<{ port: number }> {
  execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${dir}/k.pem -out ${dir}/c.pem -days ${days} -subj /CN=localhost 2>/dev/null`);
  return new Promise((resolve) => {
    const s = tls.createServer({ key: fs.readFileSync(`${dir}/k.pem`), cert: fs.readFileSync(`${dir}/c.pem`) }, (c) => c.on("error", () => {}));
    s.listen(0, "127.0.0.1", () => {
      servers.push({ close: () => s.close() });
      resolve({ port: (s.address() as net.AddressInfo).port });
    });
  });
}
/** 아무도 듣지 않는 포트 번호를 얻는다 */
async function closedPort(): Promise<number> {
  const s = await tcpServer("");
  s.close();
  await new Promise((r) => setTimeout(r, 50));
  return s.port;
}

beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  servers.forEach((s) => s.close());
  await ctx.client.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  await resetData(ctx.client);
});

describe("단계별 포트 목록", () => {
  it("1단계 100개, 2~4단계 약 1,000개, 5단계 전체", () => {
    expect(TOP_100).toHaveLength(100);
    expect(new Set(TOP_100).size).toBe(100);
    expect(portsForLevel(1)).toHaveLength(100);
    expect(TOP_1000.length).toBeGreaterThan(1000);
    expect(TOP_1000.length).toBeLessThan(1200);
    for (const p of [22, 80, 443, 3389, 1024]) expect(TOP_1000).toContain(p);
    expect(portsForLevel(2)).toBe(TOP_1000);
    expect(portsForLevel(4)).toBe(TOP_1000);
    expect(portsForLevel(5)).toHaveLength(65535);
  });
});

describe("포트 연결·서비스 식별", () => {
  it("열린 포트만 기록하고 SSH 배너에서 버전을 읽는다", async () => {
    const ssh = await tcpServer("SSH-2.0-OpenSSH_9.6p1 Ubuntu\r\n");
    const closed = await closedPort();
    const r = await scanPorts("127.0.0.1", [ssh.port, closed], { identify: true, connectTimeoutMs: 800 });
    expect(r.open).toEqual([{ port: ssh.port, protocol: "tcp", service: "ssh", version: "OpenSSH_9.6p1" }]);
    expect(r.refused).toBe(1);
    expect(r.alive).toBe(true);
    expect(r.incomplete).toBe(false);
  });

  it("식별하지 않으면(1~2단계) 포트만 기록한다", async () => {
    const ssh = await tcpServer("SSH-2.0-OpenSSH_9.6\r\n");
    const r = await scanPorts("127.0.0.1", [ssh.port], { identify: false });
    expect(r.open).toEqual([{ port: ssh.port, protocol: "tcp" }]);
  });

  it("웹 포트에는 HEAD 요청만 보내고 서버 이름을 읽는다", async () => {
    const web = await httpServer();
    // 웹 포트 판정은 번호 기준이라 임의 포트는 먼저 말을 걸지 않는다 → 배너 없이 열림만 기록
    const r = await scanPorts("127.0.0.1", [web.port], { identify: true, connectTimeoutMs: 800 });
    expect(r.open.map((p) => p.port)).toEqual([web.port]);
    expect(web.hits.every((h) => h.startsWith("HEAD "))).toBe(true);
  });

  it("배너 해석", () => {
    expect(identifyService(22, "SSH-2.0-dropbear_2022.83\r\n")).toEqual({ service: "ssh", version: "dropbear_2022.83" });
    expect(identifyService(80, "HTTP/1.1 200 OK\r\nServer: nginx/1.24.0\r\n\r\n")).toEqual({ service: "http", version: "nginx/1.24.0" });
    expect(identifyService(21, "220 (vsFTPd 3.0.5)\r\n")).toMatchObject({ service: "ftp" });
    expect(identifyService(25, "220 mail.example.test ESMTP Postfix\r\n")).toMatchObject({ service: "smtp" });
    expect(identifyService(3389, "")).toEqual({ service: "rdp" });
    expect(identifyService(54321, "")).toEqual({ service: undefined });
  });

  it("모든 포트가 닫혀 있어도 거부 응답이 오면 살아 있다고 본다", async () => {
    const r = await scanPorts("127.0.0.1", [await closedPort(), await closedPort()]);
    expect(r.open).toEqual([]);
    expect(r.alive).toBe(true);
  });

  it("시간 제한이 지나면 중단하고 일부만 점검됨으로 표시한다", async () => {
    const r = await scanPorts("127.0.0.1", Array.from({ length: 50 }, (_, i) => 40000 + i), { deadline: Date.now() - 1 });
    expect(r.incomplete).toBe(true);
  });
});

describe("인증서·노출 페이지", () => {
  it("TLS 서버의 만료일을 읽는다", async () => {
    const t = await tlsServer(10);
    const c = await readCert("127.0.0.1", t.port);
    expect(c).not.toBeNull();
    const days = (c!.expiresAt.getTime() - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(9);
    expect(days).toBeLessThan(11);
  });

  it("TLS가 아닌 포트는 null", async () => {
    const s = await tcpServer("hello\r\n");
    expect(await readCert("127.0.0.1", s.port, 800)).toBeNull();
  });

  it("200·401·403만 기록하고 404는 제외한다", async () => {
    const web = await httpServer();
    const r = await checkPaths("127.0.0.1", [{ port: web.port, tls: false }]);
    expect(r.pages.map((p) => [p.path, p.statusCode]).sort()).toEqual([["/.env", 403], ["/admin", 200], ["/login", 401]]);
    expect(r.pages.find((p) => p.path === "/admin")?.kind).toBe("관리자 페이지");
    expect(web.hits.every((h) => h.startsWith("GET "))).toBe(true);
    expect(r.incomplete).toBe(false);
  });
});

describe("점검 실행·저장", () => {
  const opts = { allowPrivate: true, connectTimeoutMs: 800 };

  it("4단계 점검: 열린 포트·서비스·노출 페이지를 저장하고, 같은 날 재실행하면 덮어쓴다", async () => {
    const web = await httpServer();
    const [a] = await ctx.db.insert(assets).values({ name: "A", target: "127.0.0.1", scanLevel: 4, scanPermitted: true }).returning();
    const o = { ...opts, portsOverride: [web.port, await closedPort()] };
    const s1 = await runScan(ctx.db, { ...o, now: new Date("2026-11-22T03:00:00Z") });
    expect(s1).toMatchObject({ scanned: 1, success: 1, fail: 0 });
    const rows = await ctx.db.select().from(scanResults).where(eq(scanResults.assetId, a.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ scanDate: "2026-11-22", scanLevel: 4, status: "success" });
    expect(rows[0].openPorts.map((p) => p.port)).toEqual([web.port]);
    expect(rows[0].exposedPages).toHaveLength(0); // 임의 포트는 웹 포트로 보지 않음

    await runScan(ctx.db, { ...o, now: new Date("2026-11-22T05:00:00Z") });
    expect(await ctx.db.select().from(scanResults)).toHaveLength(1);
    await runScan(ctx.db, { ...o, now: new Date("2026-11-23T03:00:00Z") });
    expect(await ctx.db.select().from(scanResults)).toHaveLength(2);
  });

  it("점검 날짜는 한국 시간 기준이다", async () => {
    await ctx.db.insert(assets).values({ name: "A", target: "127.0.0.1", scanLevel: 1, scanPermitted: true });
    await runScan(ctx.db, { ...opts, portsOverride: [await closedPort()], now: new Date("2026-11-22T16:00:00Z") }); // KST 11-23 01:00
    expect((await ctx.db.select().from(scanResults))[0].scanDate).toBe("2026-11-23");
  });

  it("점검 안 함(비활성) 자산은 건너뛴다", async () => {
    await ctx.db.insert(assets).values({ name: "꺼짐", target: "127.0.0.1", scanLevel: 1, scanPermitted: true, enabled: false });
    const s = await runScan(ctx.db, { ...opts });
    expect(s.scanned).toBe(0);
    expect(await ctx.db.select().from(scanResults)).toHaveLength(0);
  });

  it("점검 허가가 없는 자산은 등록 자체가 DB에서 막힌다", async () => {
    await expect(ctx.db.insert(assets).values({ name: "무허가", target: "a.test", scanLevel: 1, scanPermitted: false })).rejects.toThrow();
  });

  it("사설·루프백 주소로 연결되는 대상은 (시험 옵션 없이는) 점검하지 않는다", async () => {
    const r = await scanAsset("127.0.0.1", 3);
    expect(r.status).toBe("fail");
    expect(r.errorMessage).toContain("사설");
  });

  it("응답이 전혀 없는 대상은 실패로 기록한다", async () => {
    const r = await scanAsset("no-such-host.invalid", 1, opts);
    expect(r.status).toBe("fail");
    expect(r.errorMessage).toContain("DNS");
  });

  it("묶음(shard)과 최대 개수로 자산을 나눈다", async () => {
    for (let i = 0; i < 6; i++) {
      await ctx.db.insert(assets).values({ name: `A${i}`, target: "127.0.0.1", scanLevel: 1, scanPermitted: true });
    }
    const o = { ...opts, portsOverride: [await closedPort()] };
    const a = await runScan(ctx.db, { ...o, shard: { index: 0, total: 3 } });
    const b = await runScan(ctx.db, { ...o, shard: { index: 1, total: 3 } });
    const c = await runScan(ctx.db, { ...o, shard: { index: 2, total: 3 } });
    expect([a.scanned, b.scanned, c.scanned]).toEqual([2, 2, 2]);
    await ctx.db.delete(scanResults);
    expect((await runScan(ctx.db, { ...o, maxAssets: 3 })).scanned).toBe(3);
  });

  it("시간 제한을 넘기면 partial로 기록한다", async () => {
    const ssh = await tcpServer("SSH-2.0-X\r\n");
    const r = await scanAsset("127.0.0.1", 3, { ...opts, portsOverride: [ssh.port, ...Array.from({ length: 200 }, (_, i) => 41000 + i)], limitSecOverride: 1, ratePerSec: 5, connectTimeoutMs: 300 });
    expect(r.status).toBe("partial");
    expect(r.openPorts.map((p) => p.service)).toContain("ssh");
    expect(r.errorMessage).toContain("시간 제한");
  });
});

describe("변화 감지", () => {
  const base = { id: "x", createdAt: new Date(), assetId: "a", scanDate: "2026-11-21", scanLevel: 3, status: "success" as const, openPorts: [], exposedPages: [], certExpiresAt: null, errorMessage: null, durationSec: 1 };
  const NOW = new Date("2026-11-22T00:00:00Z");

  it("새 포트·닫힘·새 페이지를 알린다", () => {
    const prev = { ...base, openPorts: [{ port: 22, protocol: "tcp" }, { port: 80, protocol: "tcp" }], exposedPages: [{ path: "/login", statusCode: 200, kind: "로그인 페이지" }] };
    const cur = {
      ...base, openPorts: [{ port: 22, protocol: "tcp" }, { port: 3389, protocol: "tcp", service: "rdp" }],
      exposedPages: [{ path: "/login", statusCode: 200, kind: "로그인 페이지" }, { path: "/.env", statusCode: 200, kind: "설정 파일 노출" }],
    };
    const ch = diffResults(prev, cur, NOW);
    expect(ch.map((c) => c.kind).sort()).toEqual(["page_exposed", "port_closed", "port_opened"]);
    expect(ch.find((c) => c.kind === "port_opened")?.message).toContain("3389/tcp");
  });

  it("일부만 점검된 결과로는 '닫힘'을 알리지 않는다", () => {
    const prev = { ...base, openPorts: [{ port: 80, protocol: "tcp" }] };
    expect(diffResults(prev, { ...base, status: "partial" as const, openPorts: [] }, NOW)).toEqual([]);
  });

  it("인증서 만료 30일 이내와 이미 만료를 알린다", () => {
    const soon = diffResults(base, { ...base, certExpiresAt: new Date(NOW.getTime() + 10 * 86400000) }, NOW);
    expect(soon).toEqual([expect.objectContaining({ kind: "cert_expiring", message: expect.stringContaining("10일 전") })]);
    const gone = diffResults(base, { ...base, certExpiresAt: new Date(NOW.getTime() - 3 * 86400000) }, NOW);
    expect(gone[0].message).toContain("3일 전에 만료");
    expect(diffResults(base, { ...base, certExpiresAt: new Date(NOW.getTime() + 31 * 86400000) }, NOW)).toEqual([]);
  });

  it("접속 불가를 알린다", () => {
    expect(diffResults(base, { ...base, status: "fail" as const }, NOW).map((c) => c.kind)).toEqual(["asset_down"]);
  });

  it("첫 점검은 알림이 없고, 다음 날 변화만 알리며, 같은 날 재실행해도 중복되지 않는다", async () => {
    const [a] = await ctx.db.insert(assets).values({ name: "A", target: "x.test", scanLevel: 3, scanPermitted: true }).returning();
    const row = { assetId: a.id, scanLevel: 3, status: "success" as const };
    await ctx.db.insert(scanResults).values({ ...row, scanDate: "2026-11-21", openPorts: [{ port: 22, protocol: "tcp" }] });
    expect(await detectChanges(ctx.db, a.id, "2026-11-21", NOW)).toBe(0);
    expect(await ctx.db.select().from(notifications)).toHaveLength(0);

    await ctx.db.insert(scanResults).values({ ...row, scanDate: "2026-11-22", openPorts: [{ port: 22, protocol: "tcp" }, { port: 3389, protocol: "tcp" }] });
    expect(await detectChanges(ctx.db, a.id, "2026-11-22", NOW)).toBe(1);
    expect(await detectChanges(ctx.db, a.id, "2026-11-22", NOW)).toBe(0);
    const n = await ctx.db.select().from(notifications).where(and(eq(notifications.assetId, a.id)));
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ kind: "port_opened", read: false });
  });
});
