(() => {
  "use strict";
  const environment = __NOREA_BROWSER_ENVIRONMENT_JSON__;
  const installed = Symbol.for("norea.shared.browser.environment");
  if (globalThis[installed]) return;
  Object.defineProperty(globalThis, installed, { value: true });

  // Native UA metadata covers HTTP Client Hints and navigator.userAgentData.
  // Language, timezone, locale formatting and browser feature availability stay
  // real so JavaScript, request headers and the installed engine agree.
  const getter = (prototype, name, value) => {
    if (!prototype) return;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (descriptor && !descriptor.configurable) return;
    Object.defineProperty(prototype, name, {
      configurable: true,
      enumerable: descriptor ? descriptor.enumerable : true,
      get() { return value; },
    });
  };
  for (const name of ["platform", "hardwareConcurrency", "deviceMemory", "maxTouchPoints"]) {
    getter(globalThis.Navigator?.prototype, name, environment[name]);
  }
  for (const [name, value] of Object.entries({
    width: environment.screenWidth,
    height: environment.screenHeight,
    availWidth: environment.screenWidth,
    availHeight: environment.screenHeight,
    colorDepth: environment.colorDepth,
    pixelDepth: environment.colorDepth,
  })) getter(globalThis.Screen?.prototype, name, value);

  let seed = 2166136261;
  for (let i = 0; i < environment.seed.length; i += 1) {
    seed = Math.imul(seed ^ environment.seed.charCodeAt(i), 16777619) >>> 0;
  }
  const mix = (value) => {
    value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
    value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
    return (value ^ (value >>> 16)) >>> 0;
  };

  // Perturb only small, nontransparent readbacks. Drawing state, image
  // downloads and large chapter/reader images keep their original pixels.
  const maxPixels = 65536;
  const noisePixels = (data, width, height) => {
    const pixels = width * height;
    if (!pixels || pixels > maxPixels || data.length !== pixels * 4) return data;
    const changed = new Set();
    for (let i = 0; i < 16; i += 1) {
      const value = mix(seed ^ width ^ (height << 12) ^ i);
      const pixel = value % pixels;
      const index = pixel * 4 + ((value >>> 8) % 3);
      if (changed.has(index) || data[pixel * 4 + 3] === 0) continue;
      changed.add(index);
      // Deterministic parity gives equal pixels the same result on each read.
      data[index] = (data[index] & 254) | ((value >>> 16) & 1);
    }
    return data;
  };
  const canvasPrototype = globalThis.HTMLCanvasElement?.prototype;
  const contextPrototype = globalThis.CanvasRenderingContext2D?.prototype;
  if (canvasPrototype && contextPrototype) {
    const getImageData = contextPrototype.getImageData;
    const putImageData = contextPrototype.putImageData;
    const drawImage = contextPrototype.drawImage;
    const getContext = canvasPrototype.getContext;
    const toDataURL = canvasPrototype.toDataURL;
    const toBlob = canvasPrototype.toBlob;
    if (typeof getImageData === "function") {
      contextPrototype.getImageData = function (...args) {
        const result = Reflect.apply(getImageData, this, args);
        noisePixels(result.data, result.width, result.height);
        return result;
      };
    }
    const copyForRead = (canvas) => {
      if (!canvas.width || !canvas.height || canvas.width * canvas.height > maxPixels) return canvas;
      const copy = document.createElement("canvas");
      copy.width = canvas.width;
      copy.height = canvas.height;
      const context = Reflect.apply(getContext, copy, ["2d"]);
      if (!context) return canvas;
      Reflect.apply(drawImage, context, [canvas, 0, 0]);
      const pixels = Reflect.apply(getImageData, context, [0, 0, copy.width, copy.height]);
      noisePixels(pixels.data, pixels.width, pixels.height);
      Reflect.apply(putImageData, context, [pixels, 0, 0]);
      return copy;
    };
    if (typeof toDataURL === "function") {
      canvasPrototype.toDataURL = function (...args) {
        let copy;
        try { copy = copyForRead(this); } catch { copy = this; }
        return Reflect.apply(toDataURL, copy, args);
      };
    }
    if (typeof toBlob === "function") {
      canvasPrototype.toBlob = function (...args) {
        let copy;
        try { copy = copyForRead(this); } catch { copy = this; }
        return Reflect.apply(toBlob, copy, args);
      };
    }
  }

  for (const type of ["WebGLRenderingContext", "WebGL2RenderingContext"]) {
    const prototype = globalThis[type]?.prototype;
    if (!prototype || typeof prototype.getParameter !== "function") continue;
    const getParameter = prototype.getParameter;
    prototype.getParameter = function (parameter) {
      const original = Reflect.apply(getParameter, this, [parameter]);
      // Respect unavailable debug-renderer extensions and native validation.
      if (original !== null && parameter === 37445) return environment.vendor;
      if (original !== null && parameter === 37446) return environment.renderer;
      return original;
    };
  }

  // Offline analysis receives repeatable, sub-audible noise; live playback and
  // normal AudioBuffer write/read semantics are unchanged.
  const offlinePrototype = globalThis.OfflineAudioContext?.prototype;
  if (offlinePrototype && typeof offlinePrototype.startRendering === "function") {
    const rendered = new WeakSet();
    const perturb = (buffer) => {
      if (!buffer || rendered.has(buffer)) return;
      rendered.add(buffer);
      for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
        const samples = buffer.getChannelData(channel);
        if (!samples.length) continue;
        for (let i = 0; i < 16; i += 1) {
          const value = mix(seed ^ channel ^ i);
          const index = value % samples.length;
          if (Number.isFinite(samples[index]) && samples[index] !== 0) {
            samples[index] += (value & 1 ? 1 : -1) * 1e-7;
          }
        }
      }
    };
    const startRendering = offlinePrototype.startRendering;
    offlinePrototype.startRendering = function (...args) {
      this.addEventListener("complete", (event) => perturb(event.renderedBuffer), { once: true });
      const result = Reflect.apply(startRendering, this, args);
      return result.then((buffer) => { perturb(buffer); return buffer; });
    };
  }
})();
