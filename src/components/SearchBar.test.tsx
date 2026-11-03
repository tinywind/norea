import type { ReactElement } from "react";
import { expect, it, vi } from "vitest";

vi.mock("../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { SearchBar } from "./SearchBar";

type ClearButton = ReactElement<{ onClick: () => void }>;
type SearchInput = ReactElement<{ rightSection: ClearButton | null }>;

function clearButton(element: ReturnType<typeof SearchBar>): ClearButton {
  const group = element as ReactElement<{ children: [SearchInput, ReactElement] }>;
  return group.props.children[0].props.rightSection!;
}

it("empties the input and notifies the clear handler when the clear button is pressed", () => {
  const onChange = vi.fn();
  const onClear = vi.fn();
  clearButton(SearchBar({ value: "query", onChange, onClear, onSubmit: vi.fn() })).props.onClick();
  expect(onChange).toHaveBeenCalledExactlyOnceWith("");
  expect(onClear).toHaveBeenCalledOnce();
});

it("keeps clearing the input when no clear handler is provided", () => {
  const onChange = vi.fn();
  clearButton(SearchBar({ value: "query", onChange, onSubmit: vi.fn() })).props.onClick();
  expect(onChange).toHaveBeenCalledExactlyOnceWith("");
});
