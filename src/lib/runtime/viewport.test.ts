import { describe, expect, it } from "vitest";
import { fieldRevealScrollTop, keyboardInsetPx } from "./viewport";

describe("keyboardInsetPx", () => {
  it("measures the layout viewport the keyboard covers below the visual viewport", () => {
    expect(keyboardInsetPx(800, { height: 480, offsetTop: 0 })).toBe(320);
    expect(keyboardInsetPx(800, { height: 480, offsetTop: 120 })).toBe(200);
  });

  it("is zero when the WebView resizes for the keyboard or has no visual viewport", () => {
    expect(keyboardInsetPx(480, { height: 480, offsetTop: 0 })).toBe(0);
    expect(keyboardInsetPx(800, { height: 820, offsetTop: 0 })).toBe(0);
    expect(keyboardInsetPx(800, undefined)).toBe(0);
  });
});

describe("fieldRevealScrollTop", () => {
  it("moves a field below the fold to just under the container's top", () => {
    expect(fieldRevealScrollTop(100, 700, 60)).toBe(724);
    expect(fieldRevealScrollTop(0, 76, 60)).toBe(0);
  });

  it("brings a field above the visible area back down without scrolling past the start", () => {
    expect(fieldRevealScrollTop(300, 20, 60)).toBe(244);
    expect(fieldRevealScrollTop(10, -50, 60)).toBe(0);
  });
});
