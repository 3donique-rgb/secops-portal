"use client";

/** 같은 폼 안의 체크박스(name)를 한 번에 선택·해제한다. */
export function SelectAll({ name, label = "전체 선택" }: { name: string; label?: string }) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      className="h-4 w-4"
      onChange={(e) => {
        const form = e.currentTarget.form;
        form?.querySelectorAll<HTMLInputElement>(`input[type="checkbox"][name="${name}"]`).forEach((c) => {
          c.checked = e.currentTarget.checked;
        });
      }}
    />
  );
}
