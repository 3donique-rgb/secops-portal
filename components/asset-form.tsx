import { ActionForm, type ActionState } from "./action-form";
import { SCAN_LEVELS } from "@/lib/assets";

type Action = (prev: ActionState, formData: FormData) => Promise<ActionState>;
export type AssetFormValues = {
  id?: string; name: string; target: string; owner: string; department: string;
  importance: number; scanLevel: number; enabled: boolean; memo: string;
};

export function AssetForm({ action, initial, submitLabel }: { action: Action; initial: AssetFormValues; submitLabel: string }) {
  const input = "mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm";
  return (
    <ActionForm action={action} className="space-y-3">
      {initial.id && <input type="hidden" name="id" value={initial.id} />}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          자산명
          <input name="name" required maxLength={100} defaultValue={initial.name} className={input} />
        </label>
        <label className="text-sm">
          점검 대상 (도메인 또는 IP)
          <input name="target" required maxLength={253} defaultValue={initial.target} placeholder="portal.example.com 또는 203.0.113.5" className={input} />
        </label>
        <label className="text-sm">
          담당자
          <input name="owner" maxLength={100} defaultValue={initial.owner} className={input} />
        </label>
        <label className="text-sm">
          부서
          <input name="department" maxLength={100} defaultValue={initial.department} className={input} />
        </label>
        <label className="text-sm">
          중요도 (1 낮음 ~ 5 높음)
          <select name="importance" defaultValue={initial.importance} className={input}>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          점검 강도
          <select name="scanLevel" defaultValue={initial.scanLevel} className={input}>
            {Object.entries(SCAN_LEVELS).map(([n, label]) => (
              <option key={n} value={n}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="block text-sm">
        메모
        <textarea name="memo" rows={3} maxLength={1000} defaultValue={initial.memo} className={input} />
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="enabled" defaultChecked={initial.enabled} /> 점검 사용 (체크 해제하면 매일 점검에서 제외)
      </label>
      <label className="flex items-start gap-2 rounded border border-yellow-300 bg-yellow-50 p-3 text-sm">
        <input type="checkbox" name="scanPermitted" required className="mt-1" />
        <span>
          <b>점검 허가 확인 (필수)</b> — 이 대상은 우리 조직이 소유·관리하며 포트·서비스·인증서·노출 페이지 점검이 허가되었음을 확인합니다.
          허가받지 않은 대상은 등록하지 마세요.
        </span>
      </label>
      <button type="submit" className="rounded bg-gray-900 px-3 py-1.5 text-sm text-white">
        {submitLabel}
      </button>
    </ActionForm>
  );
}
