import { describe, expect, it } from "vitest";
import { keyboardInsetPx } from "./viewport";

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
