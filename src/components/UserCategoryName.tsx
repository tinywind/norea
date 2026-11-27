import type { ReactNode } from "react";
import { CheckIcon } from "./ui/icons";

export function formatUserCategoryName(name: string): string {
  return /^(?:\u2b50[\ufe0e\ufe0f]?)+$/u.test(name)
    ? name.replace(/\u2b50[\ufe0e\ufe0f]?/gu, "\u2605")
    : name;
}

export function UserCategoryName({ name }: { name: string }) {
  return <span className="norea-user-category-name">{formatUserCategoryName(name)}</span>;
}

export function CategorySelectOption({ label, checked, userDefined }: {
  label: string;
  checked?: boolean;
  userDefined: boolean;
}) {
  return <>
    {checked ? <CheckIcon size="1rem" /> : null}
    {userDefined ? <UserCategoryName name={label} /> : <span>{label}</span>}
  </>;
}

export function withCategoryNames(message: string, names: ReactNode) {
  const [before, after] = message.split("{categories}");
  return after === undefined ? message : <>{before}{names}{after}</>;
}
