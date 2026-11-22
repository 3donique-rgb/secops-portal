import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Icon } from "@/components/icons";
import { VerdictBadge } from "@/components/verdict-badge";
import { getDb } from "@/db";
import { getIndicatorDetail } from "@/lib/indicator-query";
import { TYPE_LABEL } from "@/lib/labels";
import { VERDICTS, VERDICT_LABEL, isVtSupported, listReputations, vtGuiUrl } from "@/lib/reputation";
import { requireUser } from "@/lib/session";
import { addReputationAction, lookupVtAction } from "./actions";

export const metadata = { title: "위협정보 상세 - 보안관제 포털" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fmt = (d: Date) => d.toLocaleString("ko-KR", { timeZone: "Asia/Seoul", hour12: false });

/** 외부 링크는 http(s)만 클릭 가능하게 한다 (javascript: 등 차단). */
const safeHref = (u: string | null) => (u && /^https?:\/\//i.test(u) ? u : null);

function Card({ title, icon, children }: { title: string; icon?: "globe" | "shield" | "clock"; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-[var(--line)] bg-[var(--surface)]">
      <h2 className="flex items-center gap-2 border-b border-[var(--line)] px-5 py-3 text-sm font-semibold">
        {icon && <Icon name={icon} size={16} className="text-[var(--signal)]" />}
        {title}
      </h2>
      {children}
    </section>
  );
}

export default async function IndicatorDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const db = getDb();
  const detail = await getIndicatorDetail(db, id);
  if (!detail) notFound();
  const { indicator: i, sources } = detail;
  const reps = await listReputations(db, id);
  const latest = reps[0];
  const vtUrl = vtGuiUrl({ type: i.type, value: i.value });
  const vtReady = Boolean(process.env.VT_API_KEY);

  return (
    <div className="space-y-5">
      <Link href="/indicators" className="inline-flex items-center gap-1 text-sm">
        ← 위협정보 목록
      </Link>

      <div className="rounded-xl border border-[var(--line)] bg-[var(--surface)] p-5">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-md bg-[var(--signal-soft)] px-2 py-1 font-semibold text-[var(--signal)]">
            {TYPE_LABEL[i.type]}
            {i.hashKind && ` · ${i.hashKind}`}
          </span>
          <span className="rounded-md bg-[#eef1f3] px-2 py-1 font-medium text-[var(--ink-soft)]">{i.status === "active" ? "활성" : "비활성(만료)"}</span>
          {i.excluded && <span className="rounded-md bg-[var(--warn-soft)] px-2 py-1 font-medium text-[var(--warn)]">SIEM 제외</span>}
          {latest && <VerdictBadge verdict={latest.verdict} />}
        </div>
        <h1 className="mt-3 font-mono text-lg font-semibold break-all sm:text-xl">{i.value}</h1>
        <dl className="mt-4 grid grid-cols-1 gap-x-8 gap-y-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-[var(--ink-soft)]">최초 확인</dt>
            <dd>{fmt(i.firstSeenAt)}</dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--ink-soft)]">최종 확인</dt>
            <dd>{fmt(i.lastSeenAt)}</dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--ink-soft)]">SIEM 제공</dt>
            <dd>{i.excluded ? "제외됨 (데이터는 보관 중)" : "제공 대상"}</dd>
          </div>
          {i.memo && (
            <div className="sm:col-span-3">
              <dt className="text-xs text-[var(--ink-soft)]">메모</dt>
              <dd>{i.memo}</dd>
            </div>
          )}
        </dl>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.1fr_1fr]">
        <Card title="평판 분석 (VirusTotal)" icon="globe">
          <div className="space-y-5 p-5">
            {vtUrl ? (
              <div className="flex flex-wrap items-center gap-3">
                <a
                  href={vtUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-[var(--signal)] px-4 text-sm font-semibold !text-white hover:bg-[#0b6564]"
                >
                  VirusTotal에서 분석 보기
                  <Icon name="external" size={16} />
                </a>
                <p className="text-xs text-[var(--ink-soft)]">새 창에서 열립니다. 결과를 확인한 뒤 아래에 평판을 기록하세요.</p>
              </div>
            ) : (
              <p className="text-sm text-[var(--ink-soft)]">이 종류({TYPE_LABEL[i.type]})는 VirusTotal 분석 대상이 아닙니다. 아래에 평판을 직접 기록할 수는 있습니다.</p>
            )}

            {isVtSupported(i.type) && user.role === "admin" && (
              <div className="rounded-lg bg-[#f7f9fa] p-3 text-sm">
                {vtReady ? (
                  <ActionForm action={lookupVtAction} className="flex flex-wrap items-center gap-3">
                    <input type="hidden" name="id" value={id} />
                    <button className="bg-gray-900 text-sm">VirusTotal API로 자동 조회·기록</button>
                    <span className="text-xs text-[var(--ink-soft)]">무료 키는 분당 4건·하루 500건까지입니다.</span>
                  </ActionForm>
                ) : (
                  <p className="text-xs text-[var(--ink-soft)]">자동 조회를 쓰려면 Vercel 환경변수에 VT_API_KEY(VirusTotal 무료 API 키)를 등록하세요. 등록 전에도 위 링크와 직접 기록은 사용할 수 있습니다.</p>
                )}
              </div>
            )}

            <div>
              <h3 className="mb-2 text-sm font-semibold">평판 기록하기</h3>
              <ActionForm action={addReputationAction} className="plain-form space-y-3">
                <input type="hidden" name="id" value={id} />
                <label className="block text-sm">
                  판정
                  <select name="verdict" defaultValue="unknown" className="mt-1 block w-full sm:max-w-60">
                    {VERDICTS.map((v) => (
                      <option key={v} value={v}>
                        {VERDICT_LABEL[v]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm">
                  메모 (예: VirusTotal 악성 12/90, 확인한 근거)
                  <textarea name="note" rows={3} maxLength={1000} className="mt-1 block w-full" />
                </label>
                <button className="bg-gray-900 text-sm">평판 기록</button>
              </ActionForm>
            </div>
          </div>
        </Card>

        <Card title={`평판 기록 이력 (${reps.length})`} icon="clock">
          <ul className="divide-y divide-[var(--line)] text-sm">
            {reps.map((r) => {
              const total = (r.vtMalicious ?? 0) + (r.vtSuspicious ?? 0) + (r.vtHarmless ?? 0) + (r.vtUndetected ?? 0);
              return (
                <li key={r.id} className="space-y-1.5 px-5 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <VerdictBadge verdict={r.verdict} />
                    <span className="rounded bg-[#eef1f3] px-1.5 py-0.5 text-xs text-[var(--ink-soft)]">{r.origin === "virustotal" ? "VirusTotal API" : "직접 기록"}</span>
                    <span className="ml-auto text-xs text-[var(--ink-soft)]">
                      {fmt(r.createdAt)}
                      {r.by && ` · ${r.by}`}
                    </span>
                  </div>
                  {r.vtMalicious !== null && (
                    <p className="text-xs text-[var(--ink-soft)]">
                      분석 엔진 {total}곳 중 악성 <b className="text-[var(--bad)]">{r.vtMalicious}</b> · 의심 <b className="text-[var(--warn)]">{r.vtSuspicious ?? 0}</b> · 정상 {r.vtHarmless ?? 0} · 미탐지 {r.vtUndetected ?? 0}
                      {r.vtReputation !== null && ` · 커뮤니티 점수 ${r.vtReputation}`}
                    </p>
                  )}
                  {r.note && <p className="break-words whitespace-pre-wrap">{r.note}</p>}
                </li>
              );
            })}
            {reps.length === 0 && <li className="px-5 py-8 text-center text-[var(--ink-soft)]">아직 기록된 평판이 없습니다.</li>}
          </ul>
        </Card>
      </div>

      <Card title={`제공 기관 (${sources.length})`} icon="shield">
        <div className="overflow-x-auto">
          <table className="min-w-[560px]">
            <thead>
              <tr>
                <th>기관</th>
                <th>최초 확인</th>
                <th>최종 확인</th>
                <th>원문</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => {
                const href = safeHref(s.refUrl);
                return (
                  <tr key={s.sourceName}>
                    <td className="font-medium">{s.sourceName}</td>
                    <td className="whitespace-nowrap">{fmt(s.firstSeenAt)}</td>
                    <td className="whitespace-nowrap">{fmt(s.lastSeenAt)}</td>
                    <td className="break-all">
                      {href ? (
                        <a href={href} target="_blank" rel="noopener noreferrer">
                          {s.refUrl}
                        </a>
                      ) : (
                        (s.refUrl ?? "-")
                      )}
                      {s.note && <div className="text-[var(--ink-soft)]">{s.note}</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
