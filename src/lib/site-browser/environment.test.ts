import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const script = readFileSync(new URL("../../../src-tauri/gen/android/app/src/main/res/raw/browser_environment.js", import.meta.url), "utf8");
const values = {
  seed: "0123456789abcdef0123456789abcdef",
  platform: "Linux armv8l",
  hardwareConcurrency: 4,
  deviceMemory: 8,
  maxTouchPoints: 10,
  screenWidth: 1008,
  screenHeight: 1584,
  colorDepth: 24,
  vendor: "Google Inc. (Qualcomm)",
  renderer: "ANGLE (Qualcomm, Adreno (TM) 740, OpenGL ES 3.2)",
};

function browser(seed = values.seed) {
  class Navigator {
    get language() { return "ko-KR"; }
    get languages() { return ["ko-KR", "en-US"]; }
  }
  class Screen {}
  class Canvas {
    width = 16;
    height = 16;
    tainted = false;
    pixels: Uint8ClampedArray | undefined;
    context = new Context(this);
    getContext() { return this.context; }
    data() {
      if (this.pixels?.length !== this.width * this.height * 4) {
        this.pixels = new Uint8ClampedArray(this.width * this.height * 4).fill(100);
        for (let i = 3; i < this.pixels.length; i += 4) this.pixels[i] = 255;
      }
      return this.pixels;
    }
    toDataURL() {
      if (this.tainted) throw new Error("SecurityError");
      return Array.from(this.data()).join(",");
    }
    toBlob(callback: (pixels: Uint8ClampedArray) => void) {
      if (this.tainted) throw new Error("SecurityError");
      callback(new Uint8ClampedArray(this.data()));
    }
  }
  class Context {
    constructor(private canvas: Canvas) {}
    getImageData() {
      if (this.canvas.tainted) throw new Error("SecurityError");
      return { data: new Uint8ClampedArray(this.canvas.data()), width: this.canvas.width, height: this.canvas.height };
    }
    putImageData(image: { data: Uint8ClampedArray }) { this.canvas.data().set(image.data); }
    drawImage(other: Canvas) {
      this.canvas.tainted = other.tainted;
      this.canvas.data().set(other.data());
    }
  }
  class WebGL {
    getParameter(parameter: number) {
      return parameter === 37445 ? "native vendor" : parameter === 37446 ? "native renderer" : 8192;
    }
  }
  class Buffer {
    numberOfChannels = 1;
    samples = new Float32Array(1000).fill(0.5);
    getChannelData() { return this.samples; }
  }
  class Offline extends EventTarget {
    buffer = new Buffer();
    async startRendering() { return this.buffer; }
  }
  const context = {
    Navigator, Screen,
    HTMLCanvasElement: Canvas, CanvasRenderingContext2D: Context,
    WebGLRenderingContext: WebGL, OfflineAudioContext: Offline,
    document: { createElement: () => new Canvas() },
  };
  const source = script.replace("__NOREA_BROWSER_ENVIRONMENT_JSON__", JSON.stringify({ ...values, seed }));
  runInNewContext(source, context);
  return { ...context, source, context, Canvas, Context, Navigator, Screen, WebGL, Offline };
}

describe("shared browser environment document script", () => {
  it("applies one coherent read-only environment while retaining language and timezone APIs", () => {
    const a = browser();
    const navigator = new a.Navigator() as unknown as Record<string, unknown>;
    const screen = new a.Screen() as unknown as Record<string, unknown>;
    expect(navigator.hardwareConcurrency).toBe(4);
    expect(navigator.deviceMemory).toBe(8);
    expect(navigator.platform).toBe("Linux armv8l");
    expect(navigator.language).toBe("ko-KR");
    expect(navigator.languages).toEqual(["ko-KR", "en-US"]);
    expect(screen.width).toBe(1008);
    expect(screen.availWidth).toBe(screen.width);
    expect(screen.colorDepth).toBe(screen.pixelDepth);
    expect(new a.WebGL().getParameter(37446)).toBe(values.renderer);
    expect(new a.WebGL().getParameter(3379)).toBe(8192);
  });

  it("returns repeatable small canvas readbacks without modifying the drawing", () => {
    const a = browser();
    const canvas = new a.Canvas();
    const before = new Uint8ClampedArray(canvas.data());
    const first = canvas.toDataURL();
    expect(first).toBe(canvas.toDataURL());
    expect(first).not.toBe(Array.from(before).join(","));
    expect(canvas.data()).toEqual(before);
    expect(Array.from(canvas.context.getImageData().data).join(",")).toBe(first);
    let blob: Uint8ClampedArray | undefined;
    canvas.toBlob(data => { blob = data; });
    expect(Array.from(blob!).join(",")).toBe(first);
  });

  it("shares identical readbacks between views and changes them for a new environment", () => {
    expect(new (browser().Canvas)().toDataURL()).toBe(new (browser().Canvas)().toDataURL());
    expect(new (browser().Canvas)().toDataURL()).not.toBe(new (browser("fedcba9876543210fedcba9876543210").Canvas)().toDataURL());
  });

  it("does not alter large chapter images or bypass tainted canvas protection", () => {
    const a = browser();
    const canvas = new a.Canvas();
    canvas.width = 1024; canvas.height = 1024;
    const original = canvas.data();
    expect(canvas.context.getImageData().data.every((value, index) => value === original[index])).toBe(true);
    canvas.width = 16; canvas.height = 16; canvas.tainted = true;
    expect(() => canvas.toDataURL()).toThrow("SecurityError");
    expect(() => canvas.context.getImageData()).toThrow("SecurityError");
  });

  it("keeps offline audio noise stable and leaves writable buffer semantics intact", async () => {
    const a = browser();
    const offline = new a.Offline();
    const before = new Float32Array(offline.buffer.samples);
    const buffer = await offline.startRendering();
    const first = new Float32Array(buffer.samples);
    expect(first).not.toEqual(before);
    expect((await offline.startRendering()).samples).toEqual(first);
    buffer.getChannelData()[0] = 0.25;
    expect(buffer.getChannelData()[0]).toBe(0.25);
  });

  it("does not stack wrappers if the script is registered more than once", () => {
    const a = browser();
    const read = a.Context.prototype.getImageData;
    runInNewContext(a.source, a.context);
    expect(a.Context.prototype.getImageData).toBe(read);
  });

  it("tolerates contexts without optional graphics and audio APIs", () => {
    expect(() => runInNewContext(script.replace("__NOREA_BROWSER_ENVIRONMENT_JSON__", JSON.stringify(values)), {})).not.toThrow();
  });
});
