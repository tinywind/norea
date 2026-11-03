import { isValidElement, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

let desktop = false;
vi.mock("@mantine/hooks", async (importOriginal) => ({
  ...await importOriginal<typeof import("@mantine/hooks")>(),
  useMediaQuery: (query: string) => {
    expect(query).toBe("(min-width: 768px)");
    return desktop;
  },
}));

import { AppToasts } from "./AppToasts";

function toastProps(isDesktop: boolean) {
  desktop = isDesktop;
  const element = AppToasts();
  expect(isValidElement(element)).toBe(true);
  return (element as ReactElement<Record<string, unknown>>).props;
}

describe("app toasts", () => {
  it("stack bottom-center on phones and bottom-right on desktop", () => {
    expect(toastProps(false)).toMatchObject({ className: "norea-toasts", position: "bottom-center" });
    expect(toastProps(true)).toMatchObject({ className: "norea-toasts", position: "bottom-right" });
  });
});
