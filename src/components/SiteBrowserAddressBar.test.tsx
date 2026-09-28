import type { FormEvent, ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { SiteBrowserAddressBar } from "./SiteBrowserAddressBar";

vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useState: (initial: unknown) => [initial, vi.fn()],
}));
vi.mock("../i18n", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function submit(url: string, loading = false) {
  const onNavigate = vi.fn();
  const blur = vi.fn();
  const bar = SiteBrowserAddressBar({ url, loading, onNavigate }) as ReactElement<{
    onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  }>;
  bar.props.onSubmit({
    preventDefault: vi.fn(),
    currentTarget: { querySelector: () => ({ blur }) },
  } as unknown as FormEvent<HTMLFormElement>);
  return { blur, onNavigate };
}

describe("site browser address entry", () => {
  it("navigates to an HTTP(S) address and dismisses the keyboard", () => {
    const { blur, onNavigate } = submit("  https://Example.com/chapter/2?q=book#part  ");
    expect(onNavigate).toHaveBeenCalledWith("https://example.com/chapter/2?q=book#part");
    expect(blur).toHaveBeenCalledOnce();
  });

  it.each([
    "", "not a URL", "javascript:alert(1)", "data:text/html,example",
    "file:///sdcard/book.html", "https://user:password@example.com/",
  ])("rejects an unsafe or invalid address: %s", (url) => {
    const { blur, onNavigate } = submit(url);
    expect(onNavigate).not.toHaveBeenCalled();
    expect(blur).not.toHaveBeenCalled();
  });

  it("waits for the current navigation before accepting another address", () => {
    expect(submit("https://example.com/", true).onNavigate).not.toHaveBeenCalled();
  });
});
