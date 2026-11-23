"use client";

/** 같은 폼 안의 체크박스(name)를 한 번에 선택·해제한다. */
export function SelectAll({ name, label = "전체 선택", formId }: { name: string; label?: string; formId?: string }) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      className="h-4 w-4"
      onChange={(e) => {
        const root: ParentNode | null = formId ? document : e.currentTarget.form;
        const sel = formId ? `input[type="checkbox"][name="${name}"][form="${formId}"]` : `input[type="checkbox"][name="${name}"]`;
        root?.querySelectorAll<HTMLInputElement>(sel).forEach((c) => {
          c.checked = e.currentTarget.checked;
        });
      }}
    />
  );
}
