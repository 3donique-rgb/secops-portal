import Link from "next/link";
import { AutoRefresh } from "@/components/auto-refresh";
import { Icon, type IconName } from "@/components/icons";
import { getDb } from "@/db";
import { getDashboard } from "@/lib/dashboard";
import { TYPE_LABEL } from "@/lib/labels";
import { NOTIFICATION_LABEL } from "@/lib/notifications";
import { latestNews } from "@/lib/news-query";
import { requireUser } from "@/lib/session";

export const metadata = { title: "대시보드 - 보안관제 포털" };

const KST = "Asia/Seoul";
const fmt = (d: Date | null) => (d ? d.toLocaleString("ko-KR", { timeZone: KST, hour12: false }) : "-");
const n = (v: number) => v.toLocaleString("ko-KR");

/** 몇 분·몇 시간 전인지 (1일 넘으면 날짜) */
function ago(d: Date | null, now: Date): string {
  if (!d) return "기록 없음";
  const min = Math.max(0, Math.round((now.getTime() - d.getTime()) / 60000));
  if (min < 1) return "방금";
  if (min < 60) return `${min}분 전`;
  if (min < 24 * 60) return `${Math.floor(min / 60)}시간 전`;
  return `${Math.floor(min / 1440)}일 전`;
}

// 종류별 막대 색: 같은 청록 계열의 농도 차이로 구분 (색만으로 구분하지 않도록 이름과 건수를 함께 표시)
const TYPE_TONE = ["#0e7c7b", "#2f9a97", "#5fb5b1", "#93cfca", "#c3e3df"];

function Panel({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="min-w-0 rounded-xl border border-[var(--line)] bg-[var(--surface)]">
      <div className="flex items-center justify-between border-b border-[var(--line)] px-5 py-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Dot({ tone }: { tone: "ok" | "warn" | "bad" | "off" }) {
  const c = { ok: "var(--ok)", warn: "var(--warn)", bad: "var(--bad)", off: "#9aa7b0" }[tone];
  return <span aria-hidden="true" className="mr-2 inline-block h-2 w-2 rounded-full" style={{ background: c }} />;
}

export default async function DashboardPage() {
  const user = await requireUser();
  const d = await getDashboard(getDb());
  const news = await latestNews(getDb(), 5);
  const now = new Date();
  const active = d.sources.filter((s) => s.enabled);
  const problems = active.filter((s) => s.stale || s.lastStatus === "fail");
  const lastOk = active.map((s) => s.lastSuccessAt).filter((x): x is Date => !!x).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

  const state: "ok" | "bad" | "idle" = active.length === 0 ? "idle" : problems.length > 0 ? "bad" : "ok";
  const banner = {
    ok: { bg: "var(--ok-soft)", fg: "var(--ok)", title: "수집이 정상입니다", detail: `사용 중인 출처 ${active.length}곳 · 마지막 수집 성공 ${ago(lastOk, now)}` },
    bad: { bg: "var(--bad-soft)", fg: "var(--bad)", title: `확인이 필요한 출처가 ${problems.length}곳 있습니다`, detail: problems.map((s) => s.name).join(", ") },
    idle: {
      bg: "var(--warn-soft)", fg: "var(--warn)", title: "수집 중인 출처가 없습니다",
      detail: user.role === "admin" ? "수집 출처 메뉴에서 출처를 추가하고 사용으로 바꾸세요." : "관리자에게 수집 출처 등록을 요청하세요.",
    },
  }[state];

  const peak = Math.max(1, ...d.indicators.hourly);
  const typeTotal = Object.keys(TYPE_LABEL).reduce((a, t) => a + (d.indicators.byType[t] ?? 0), 0);
  const hourLabel = (i: number) => `${new Date(now.getTime() - (23 - i) * 3600_000).toLocaleString("ko-KR", { timeZone: KST, hour: "numeric", hour12: false })}시`;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-1">
        <h1 className="text-xl font-bold tracking-tight">대시보드</h1>
        <p className="text-xs text-[var(--ink-soft)]">{fmt(now)} 기준 · 10분마다 자동 갱신</p>
        <AutoRefresh minutes={10} />
      </div>

      <Panel title="최신 보안뉴스" action={<Link href="/news" className="text-xs text-[var(--signal)] hover:underline">모두 보기</Link>}>
        {news.length === 0 ? (
          <p className="px-5 py-4 text-sm text-[var(--ink-soft)]">아직 수집된 기사가 없습니다.</p>
        ) : (
          <ul>
            {news.map((a) => (
              <li key={a.id} className="flex items-baseline gap-3 border-b border-[var(--line)] px-5 py-2.5 text-sm last:border-b-0">
                <Link href={`/news/${a.id}`} className="min-w-0 flex-1 truncate font-medium hover:underline">{a.title}</Link>
                <span className="hidden shrink-0 text-xs text-[var(--ink-soft)] sm:inline">{a.publisher || "-"}</span>
                <time dateTime={a.publishedAt.toISOString()} className="shrink-0 text-xs text-[var(--ink-soft)]">
                  {a.publishedAt.toLocaleString("ko-KR", { timeZone: KST, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })}
                </time>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <div role="status" className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl px-5 py-3.5" style={{ background: banner.bg, color: banner.fg }}>
        <Icon name={state === "ok" ? "check" : "alert"} size={18} />
        <span className="font-semibold">{banner.title}</span>
        <span className="text-sm opacity-90">{banner.detail}</span>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {(
          [
            { icon: "trend", label: "최근 24시간 신규", value: n(d.indicators.new24h), unit: "건", note: `최근 7일 ${n(d.indicators.new7d)}건`, href: "/indicators" },
            { icon: "shield", label: "활성 위협정보", value: n(d.indicators.active), unit: "건", note: `전체 ${n(d.indicators.total)}건`, href: "/indicators?status=active" },
            { icon: "server", label: "등록 자산", value: n(d.assets.total), unit: "개", note: `점검 사용 ${n(d.assets.enabled)}개`, href: "/assets" },
            { icon: "bell", label: "읽지 않은 알림", value: n(d.notifications.unread), unit: "건", note: d.notifications.unread > 0 ? "확인이 필요합니다" : "새 알림 없음", href: "/notifications?filter=unread", hot: d.notifications.unread > 0 },
          ] as { icon: IconName; label: string; value: string; unit: string; note: string; href: string; hot?: boolean }[]
        ).map((k) => (
          <Link key={k.label} href={k.href} className="group flex items-center gap-4 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4 transition-colors hover:border-[var(--signal)]">
            <span
              aria-hidden="true"
              className="grid h-12 w-12 shrink-0 place-items-center rounded-xl"
              style={k.hot ? { background: "var(--bad-soft)", color: "var(--bad)" } : { background: "var(--signal-soft)", color: "var(--signal)" }}
            >
              <Icon name={k.icon} size={22} />
            </span>
            <span className="min-w-0">
              <span className="block text-sm text-[var(--ink-soft)]">{k.label}</span>
              <span className="block text-2xl leading-tight font-bold tracking-tight" style={k.hot ? { color: "var(--bad)" } : undefined}>
                {k.value}
                <span className="ml-1 text-sm font-medium text-[var(--ink-soft)]">{k.unit}</span>
              </span>
              <span className="block truncate text-xs text-[var(--ink-soft)]">{k.note}</span>
            </span>
          </Link>
        ))}
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.6fr_1fr]">
        <Panel title="시간대별 신규 유입 (최근 24시간)" action={<span className="text-xs text-[var(--ink-soft)]">최대 {n(peak)}건/시간</span>}>
          <div className="px-5 py-4">
            <div className="flex h-40 items-end gap-[3px]" role="img" aria-label={`시간대별 신규 건수, 최대 ${peak}건`}>
              {d.indicators.hourly.map((v, i) => (
                <div key={i} title={`${hourLabel(i)} ${n(v)}건`} className="flex-1 rounded-t-sm" style={{ height: `${Math.max(v === 0 ? 3 : 8, (v / peak) * 100)}%`, background: v === 0 ? "var(--line)" : "var(--signal)" }} />
              ))}
            </div>
            <div className="mt-1.5 flex justify-between text-xs text-[var(--ink-soft)]">
              <span>24시간 전</span>
              <span>지금</span>
            </div>
          </div>
        </Panel>

        <Panel title="활성 위협정보 종류별" action={<span className="text-xs text-[var(--ink-soft)]">합계 {n(typeTotal)}건</span>}>
          <div className="px-5 py-4">
            <div className="flex h-3 overflow-hidden rounded-full bg-[var(--line)]">
              {Object.keys(TYPE_LABEL).map((t, i) => {
                const v = d.indicators.byType[t] ?? 0;
                return v > 0 ? <div key={t} style={{ width: `${(v / typeTotal) * 100}%`, background: TYPE_TONE[i % TYPE_TONE.length] }} title={`${TYPE_LABEL[t]} ${n(v)}건`} /> : null;
              })}
            </div>
            <ul className="mt-3 flex flex-col">
              {Object.entries(TYPE_LABEL).map(([t, label], i) => (
                <li key={t}>
                  <Link href={`/indicators?type=${t}&status=active`} className="flex items-center justify-between rounded-md px-2 py-2 text-sm hover:bg-black/[0.04]">
                    <span className="flex items-center">
                      <span aria-hidden="true" className="mr-2.5 inline-block h-2.5 w-2.5 rounded-sm" style={{ background: TYPE_TONE[i % TYPE_TONE.length] }} />
                      {label}
                    </span>
                    <b>{n(d.indicators.byType[t] ?? 0)}</b>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </Panel>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
        <Panel title="수집 상태" action={user.role === "admin" ? <Link href="/admin/sources" className="text-xs text-[var(--signal)] hover:underline">출처 관리</Link> : undefined}>
          <div className="overflow-x-auto">
            <table className="min-w-[480px]">
              <thead>
                <tr className="text-left text-xs text-[var(--ink-soft)]">
                  <th className="px-5 py-2 font-medium">제공 기관</th>
                  <th className="px-2 py-2 font-medium">마지막 성공</th>
                  <th className="px-5 py-2 font-medium">상태</th>
                </tr>
              </thead>
              <tbody>
                {d.sources.map((s) => {
                  const bad = s.enabled && (s.stale || s.lastStatus === "fail");
                  return (
                    <tr key={s.id} className="border-t border-[var(--line)] align-top">
                      <td className="px-5 py-2.5">{s.name}</td>
                      <td className="px-2 py-2.5 whitespace-nowrap text-[var(--ink-soft)]" title={fmt(s.lastSuccessAt)}>
                        {s.lastSuccessAt ? ago(s.lastSuccessAt, now) : "-"}
                      </td>
                      <td className="px-5 py-2.5">
                        {!s.enabled ? (
                          <span className="text-[var(--ink-soft)]"><Dot tone="off" />사용 안 함</span>
                        ) : bad ? (
                          <span style={{ color: "var(--bad)" }}>
                            <Dot tone="bad" />
                            {s.lastStatus === "fail" ? "실패" : "지연"}
                            {s.lastError && <span className="mt-0.5 block text-xs break-words opacity-80">{s.lastError}</span>}
                          </span>
                        ) : (
                          <span><Dot tone="ok" />정상</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {d.sources.length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-5 py-8 text-center text-[var(--ink-soft)]">
                      등록된 수집 출처가 없습니다. 관리자 메뉴의 “수집 출처”에서 추가하세요.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel title="최근 알림" action={<Link href="/notifications" className="text-xs text-[var(--signal)] hover:underline">모두 보기</Link>}>
          <ul className="divide-y divide-[var(--line)] text-sm">
            {d.notifications.recent.map((x) => (
              <li key={x.id} className={`px-5 py-3 ${x.read ? "text-[var(--ink-soft)]" : ""}`}>
                <div className="flex items-center gap-2">
                  {!x.read && <span aria-label="읽지 않음" className="h-2 w-2 shrink-0 rounded-full bg-[var(--bad)]" />}
                  <span className="rounded bg-[var(--signal-soft)] px-1.5 py-0.5 text-xs font-medium text-[var(--signal)]">{NOTIFICATION_LABEL[x.kind] ?? x.kind}</span>
                  <Link href={`/assets/${x.assetId}`} className="truncate font-medium hover:underline">{x.assetName}</Link>
                </div>
                <p className="mt-1">{x.message}</p>
                <p className="mt-0.5 text-xs text-[var(--ink-soft)]">{ago(x.occurredAt, now)}</p>
              </li>
            ))}
            {d.notifications.recent.length === 0 && <li className="px-5 py-8 text-center text-[var(--ink-soft)]">최근 7일간 알림이 없습니다.</li>}
          </ul>
        </Panel>
      </div>
    </div>
  );
}
