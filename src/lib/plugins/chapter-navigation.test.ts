import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { chapterNavigationScript } from "./chapter-navigation";

function navigate(
  target: string,
  links: Array<{ href: string; hidden?: boolean; disabled?: boolean }> = [],
) {
  const clicked: string[] = [];
  const elements = links.map((link) => ({
    tagName: "A",
    hidden: link.hidden,
    getAttribute: (name: string) =>
      name === "href"
        ? link.href
        : name === "aria-disabled" && link.disabled
          ? "true"
          : null,
    hasAttribute: () => false,
    getClientRects: () => (link.hidden ? [] : [{ width: 100, height: 30 }]),
    click: () => clicked.push(link.href),
  }));
  const pending: Array<() => void> = [];
  const followed = runInNewContext(
    `(${chapterNavigationScript(target, ".chapter-nav a")})(function () {})`,
    {
      URL,
      location: { href: "https://source.test/chapter/14" },
      document: { readyState: "complete", querySelectorAll: () => elements },
      window: {
        getComputedStyle: () => ({
          display: "block",
          visibility: "visible",
          opacity: "1",
        }),
      },
      setTimeout: (callback: () => void) => pending.push(callback),
    },
  );
  pending.forEach((callback) => callback());
  return { followed, clicked };
}

describe("chapter link navigation", () => {
  it.each([13, 15])(
    "clicks only the requested adjacent chapter %s",
    (chapter) => {
      const result = navigate(
        `https://source.test/chapter/${chapter}?_norea_capture=test`,
        [{ href: "/chapter/13" }, { href: "/chapter/15" }],
      );
      expect(result).toEqual({
        followed: true,
        clicked: [`/chapter/${chapter}`],
      });
    },
  );
  it("falls back for non-adjacent, cross-origin, disabled or hidden links", () => {
    for (const target of [
      "https://source.test/chapter/20",
      "https://other.test/chapter/15",
    ]) {
      expect(navigate(target, [{ href: "/chapter/15" }]).followed).toBe(false);
    }
    expect(
      navigate("https://source.test/chapter/15", [
        { href: "/chapter/15", hidden: true },
        { href: "/chapter/15", disabled: true },
      ]).clicked,
    ).toEqual([]);
  });
  it("preserves meaningful query parameters when selecting a link", () => {
    expect(
      navigate("https://source.test/chapter/15?edition=2", [
        { href: "/chapter/15?edition=1" },
      ]).followed,
    ).toBe(false);
  });
});
