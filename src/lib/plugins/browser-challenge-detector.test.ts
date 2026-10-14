import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import detector from "./browser-challenge-detector.js?raw";

describe("browser challenge detection", () => {
  it.each([true, false])(
    "detects the observed puzzle control only when visible: %s",
    (visible) => {
      const label = "\uD37C\uC990 \uC2AC\uB77C\uC774\uB354";
      const button = {
        getAttribute: (name: string) => (name === "aria-label" ? label : null),
        getClientRects: () => (visible ? [{ width: 44, height: 44 }] : []),
      };
      const kind = runInNewContext(
        `(function () { var detect = ${detector}; return detect(); })()`,
        {
          document: {
            title: "Chapter",
            body: { innerText: "Chapter" },
            querySelector: () => null,
            querySelectorAll: (selector: string) =>
              selector === "button[aria-label], [role='slider'][aria-label]"
                ? [button]
                : [],
          },
          window: {
            getComputedStyle: () => ({
              display: "block",
              visibility: "visible",
              opacity: "1",
            }),
          },
        },
      );
      expect(kind).toBe(visible ? "captcha" : null);
    },
  );
});
