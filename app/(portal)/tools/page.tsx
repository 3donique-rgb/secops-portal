import { headers } from "next/headers";
import Link from "next/link";
import { Suspense } from "react";
import { Result, ToolForm } from "@/components/tool-form";
import { getDb } from "@/db";
import { getClientIp } from "@/lib/auth";
import { requireUser } from "@/lib/session";
import { DNS_SERVERS, PORT_PRESET } from "@/lib/tools";
import { myIpInfo } from "@/lib/tools-db";
import { runToolAction } from "./actions";

export const maxDuration = 60;
export const metadata = { title: "환경점검 - 보안관제 포털" };

const TABS = [
  { id: "myip", label: "내 공인 IP" },
  { id: "port", label: "포트 체커" },
  { id: "dns", label: "DNS 조회" },
  { id: "whois", label: "WHOIS 조회" },
  { id: "reverse", label: "Reverse IP" },
] as const;

const DESC: Record<string, string> = {
  myip: "지금 접속한 곳의 공인 IP 주소와 국가를 보여 줍니다.",
  port: "대상 서버의 TCP 포트가 열려 있는지 확인합니다. 한 번에 20개까지.",
  dns: "A·AAAA·CNAME·MX·NS·TXT·SOA 기록을 선택한 DNS 서버로 조회합니다. IP를 넣으면 역방향(PTR) 조회를 합니다.",
  whois: "도메인 또는 IP의 등록 정보를 WHOIS 서버에서 가져옵니다.",
  reverse: "같은 IP 주소에서 운영되는 다른 도메인을 찾습니다.",
};

async function MyIp() {
  const ip = getClientIp(await headers());
  const sections = await myIpInfo(getDb(), ip);
  return <Result result={{ ok: true, sections }} />;
}

export default async function ToolsPage({ searchParams }: { searchParams: Promise<{ t?: string }> }) {
  await requireUser();
  const sp = await searchParams;
  const tab = TABS.find((t) => t.id === sp.t)?.id ?? "myip";
  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold">환경점검</h1>
      <nav aria-label="환경점검 도구" className="flex flex-wrap gap-1.5">
        {TABS.map((t) => (
          <Link key={t.id} href={`/tools?t=${t.id}`} aria-current={t.id === tab ? "page" : undefined} className={`rounded-lg border px-3 py-1.5 text-sm ${t.id === tab ? "border-[var(--signal)] bg-[var(--signal-soft)] font-medium text-[var(--signal)]" : "border-[var(--line)]"}`}>
            {t.label}
          </Link>
        ))}
      </nav>
      <p className="text-sm text-[var(--ink-soft)]">{DESC[tab]}</p>
      {tab === "myip" && (
        <Suspense fallback={<p className="text-sm">확인 중…</p>}>
          <MyIp />
        </Suspense>
      )}
      {tab === "port" && <ToolForm key={tab} action={runToolAction} tool="port" targetLabel="도메인 또는 IP" placeholder="example.com 또는 203.0.113.10" ports={{ preset: PORT_PRESET.slice(0, 9).join(", ") }} />}
      {tab === "dns" && <ToolForm key={tab} action={runToolAction} tool="dns" targetLabel="도메인 또는 IP" placeholder="example.com" servers={DNS_SERVERS.map((s) => ({ id: s.id, label: s.label }))} />}
      {tab === "whois" && <ToolForm key={tab} action={runToolAction} tool="whois" targetLabel="도메인 또는 IP" placeholder="example.com" />}
      {tab === "reverse" && <ToolForm key={tab} action={runToolAction} tool="reverse" targetLabel="도메인 또는 IP" placeholder="example.com 또는 8.8.8.8" />}
      <p className="text-xs text-[var(--ink-soft)]">모든 조회는 기록(감사 로그)되며 1분에 20회까지 사용할 수 있습니다. 내부망·예약 주소는 점검할 수 없습니다.</p>
    </div>
  );
}
