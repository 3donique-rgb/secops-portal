/**
 * 정시 실행 예약 만들기(cron:setup) / 확인(cron:status).
 * Supabase 의 pg_cron + pg_net 으로, 정해진 시각에 포털(/api/cron/dispatch)에 요청을 보내 GitHub Actions 를 실행시킨다.
 * 비밀 값은 DB(cron_config)에서 만들어 쓰고 화면·로그에 출력하지 않는다.
 */
import { sql } from "drizzle-orm";
import { CRON_SCHEDULES, type CronWorkflow } from "../lib/cron-dispatch";
import { describeError } from "../lib/error-info";
import { connect } from "./db";

const PORTAL = (process.env.PORTAL_URL ?? "https://secops-portal.vercel.app").replace(/\/$/, "");
const rowsOf = (r: unknown): Record<string, unknown>[] => (Array.isArray(r) ? r : ((r as { rows?: Record<string, unknown>[] })?.rows ?? []));

async function setup(db: ReturnType<typeof connect>["db"]) {
  try {
    await db.execute(sql`create extension if not exists pg_cron`);
    await db.execute(sql`create extension if not exists pg_net`);
  } catch (e) {
    console.error("pg_cron/pg_net 확장을 켜지 못했습니다:", describeError(e));
    console.error("Supabase 대시보드 > Database > Extensions 에서 pg_cron 과 pg_net 을 켠 뒤 다시 실행하세요.");
    process.exit(1);
  }
  await db.execute(sql`insert into cron_config (key, value) values ('secret', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')) on conflict (key) do nothing`);
  for (const [name, schedule] of Object.entries(CRON_SCHEDULES) as [CronWorkflow, string][]) {
    const command = `select net.http_post(url := '${PORTAL}/api/cron/dispatch', headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', (select value from public.cron_config where key = 'secret')), body := '{"workflow":"${name}"}'::jsonb, timeout_milliseconds := 10000)`;
    await db.execute(sql`select cron.schedule(${`secops-${name}`}, ${schedule}, ${command})`);
    console.log(`예약 등록: secops-${name}  (UTC ${schedule})`);
  }
  // 바로 한 번 시험: 보안뉴스 수집을 요청해 연결이 되는지 확인한다
  await db.execute(sql`select net.http_post(url := ${`${PORTAL}/api/cron/dispatch`}, headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', (select value from public.cron_config where key = 'secret')), body := '{"workflow":"news"}'::jsonb, timeout_milliseconds := 10000)`);
  console.log("시험 요청(보안뉴스 수집)을 보냈습니다. 1분 뒤 'cron-status' 작업으로 결과를 확인하세요.");
}

async function status(db: ReturnType<typeof connect>["db"]) {
  const jobs = rowsOf(await db.execute(sql`select jobname, schedule, active from cron.job where jobname like 'secops-%' order by jobname`));
  console.log(`등록된 예약 ${jobs.length}개`);
  for (const j of jobs) console.log(`- ${j.jobname}  UTC ${j.schedule}  ${j.active ? "사용" : "중지"}`);
  const runs = rowsOf(await db.execute(sql`select j.jobname, d.status, to_char(d.start_time at time zone 'Asia/Seoul', 'MM-DD HH24:MI') as at from cron.job_run_details d join cron.job j using (jobid) where j.jobname like 'secops-%' order by d.start_time desc limit 8`));
  console.log("최근 예약 실행(KST):");
  for (const r of runs) console.log(`- ${r.at} ${r.jobname} ${r.status}`);
  const http = rowsOf(await db.execute(sql`select status_code, to_char(created at time zone 'Asia/Seoul', 'MM-DD HH24:MI') as at, left(coalesce(content, error_msg, ''), 120) as msg from net._http_response order by created desc limit 8`));
  console.log("최근 포털 응답(KST):");
  for (const h of http) console.log(`- ${h.at} 응답 ${h.status_code ?? "-"} ${h.msg}`);
}

async function main() {
  const { db, close } = connect();
  try {
    if (process.argv.includes("--status")) await status(db);
    else await setup(db);
  } finally {
    await close();
  }
}
main().catch((e) => {
  console.error("실패:", describeError(e));
  process.exit(1);
});
