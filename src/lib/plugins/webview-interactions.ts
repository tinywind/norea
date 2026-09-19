import type { WebViewInteraction } from "./types";

export const MAX_WEBVIEW_INTERACTIONS = 32;
const MAX_INTERACTION_TEXT_LENGTH = 2_048;
const MIN_INTERACTION_TIMEOUT_MS = 100;
const MAX_INTERACTION_TIMEOUT_MS = 120_000;
const DEFAULT_INTERACTION_TIMEOUT_MS = 10_000;
const INTERACTION_POLL_INTERVAL_MS = 100;
const INTERACTION_STEP_DELAY_MS = 120;
const INTERACTION_KEYSTROKE_DELAY_MS = 40;
let interactionRunSequence = 0;

const INTERACTION_TYPES = new Set(["click", "type", "select", "waitFor"]);

/** Validates a plugin-supplied CSS selector for WebView capture options. */
export function validateWebViewSelector(
  value: unknown,
  field: string,
  context: string,
): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${context} ${field} must be a non-empty selector.`);
  }
  const normalized = value.trim();
  if (typeof document !== "undefined") {
    try {
      document.createDocumentFragment().querySelector(normalized);
    } catch {
      throw new Error(`${context} ${field} is not a valid selector.`);
    }
  }
  return normalized;
}

function interactionTimeoutMs(
  value: unknown,
  field: string,
  context: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${context} ${field} must be a finite number.`);
  }
  return Math.min(
    MAX_INTERACTION_TIMEOUT_MS,
    Math.max(MIN_INTERACTION_TIMEOUT_MS, Math.round(value)),
  );
}

function interactionFlag(
  value: unknown,
  field: string,
  context: string,
): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`${context} ${field} must be a boolean.`);
  }
  return value;
}

function interactionText(
  value: unknown,
  field: string,
  context: string,
): string {
  if (typeof value !== "string") {
    throw new Error(`${context} ${field} must be a string.`);
  }
  if (value.length > MAX_INTERACTION_TEXT_LENGTH) {
    throw new Error(`${context} ${field} is too long.`);
  }
  return value;
}

function validateInteraction(
  value: unknown,
  index: number,
  context: string,
): WebViewInteraction {
  const field = `interactions[${index}]`;
  if (value === null || typeof value !== "object") {
    throw new Error(`${context} ${field} must be an object.`);
  }
  const step = value as Record<string, unknown>;
  if (typeof step.type !== "string" || !INTERACTION_TYPES.has(step.type)) {
    throw new Error(
      `${context} ${field}.type must be click, type, select, or waitFor.`,
    );
  }
  const selector = validateWebViewSelector(
    step.selector,
    `${field}.selector`,
    context,
  );
  const timeoutMs = interactionTimeoutMs(
    step.timeoutMs,
    `${field}.timeoutMs`,
    context,
  );
  const optional = interactionFlag(
    step.optional,
    `${field}.optional`,
    context,
  );
  const common = {
    selector,
    ...(optional !== undefined ? { optional } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
  switch (step.type) {
    case "click":
      return { type: "click", ...common };
    case "waitFor":
      return { type: "waitFor", ...common };
    case "select":
      return {
        type: "select",
        ...common,
        value: interactionText(step.value, `${field}.value`, context),
      };
    default: {
      const clear = interactionFlag(step.clear, `${field}.clear`, context);
      const submit = interactionFlag(step.submit, `${field}.submit`, context);
      return {
        type: "type",
        ...common,
        text: interactionText(step.text, `${field}.text`, context),
        ...(clear !== undefined ? { clear } : {}),
        ...(submit !== undefined ? { submit } : {}),
      };
    }
  }
}

/**
 * Validates plugin-declared DOM interaction steps before they are serialized
 * into a WebView script. `context` prefixes error messages, for example
 * "Chapter acquisition" or "webViewLoad".
 */
export function validateWebViewInteractions(
  value: unknown,
  context: string,
): WebViewInteraction[] {
  if (!Array.isArray(value)) {
    throw new Error(`${context} interactions must be an array.`);
  }
  if (value.length > MAX_WEBVIEW_INTERACTIONS) {
    throw new Error(`${context} has too many interactions.`);
  }
  return value.map((step, index) => validateInteraction(step, index, context));
}

/**
 * Unique id for one interaction sequence. The in-page runtime keys its resume
 * cursor on it so a step that navigates within the same site continues from
 * the next step on the new document instead of replaying earlier steps.
 */
export function nextWebViewInteractionRunId(): string {
  interactionRunSequence += 1;
  if (!Number.isSafeInteger(interactionRunSequence)) interactionRunSequence = 1;
  return `${Date.now().toString(36)}-${interactionRunSequence.toString(36)}`;
}

/**
 * Page-side runtime shared by chapter capture and `webViewLoad`. It defines
 * `runWebViewInteractions(steps, options, done)` where `done(error, aborted)`
 * is called once: `error` is set when a required target never appeared or an
 * action threw, and `aborted` is true when `options.shouldAbort()` reported
 * that the caller must take over (for example a manual-action marker).
 */
export function webViewInteractionRuntimeScript(): string {
  return `function runWebViewInteractions(steps, options, done) {
  var STEP_TIMEOUT_MS = ${DEFAULT_INTERACTION_TIMEOUT_MS};
  var POLL_INTERVAL_MS = ${INTERACTION_POLL_INTERVAL_MS};
  var STEP_DELAY_MS = ${INTERACTION_STEP_DELAY_MS};
  var KEYSTROKE_DELAY_MS = ${INTERACTION_KEYSTROKE_DELAY_MS};
  var cursorKey = "norea-interactions:" + options.runId;
  var finished = false;
  var index = 0;
  function message(error) {
    return (error && (error.message || error.toString())) || String(error);
  }
  function describe(step, stepIndex) {
    return "Interaction step " + (stepIndex + 1) + " (" + step.type + " " +
      JSON.stringify(step.selector) + ")";
  }
  function readCursor() {
    try { return Number(sessionStorage.getItem(cursorKey)) || 0; } catch (_) { return 0; }
  }
  function writeCursor(value) {
    try { sessionStorage.setItem(cursorKey, String(value)); } catch (_) {}
  }
  function clearCursor() {
    try { sessionStorage.removeItem(cursorKey); } catch (_) {}
  }
  function finish(error, aborted) {
    if (finished) return;
    finished = true;
    if (!aborted) clearCursor();
    done(error || null, aborted === true);
  }
  function eventInit(extra) {
    var init = { bubbles: true, cancelable: true, composed: true, view: window };
    for (var key in extra) init[key] = extra[key];
    return init;
  }
  function pointerInit(element, buttons) {
    var rect = element.getBoundingClientRect ? element.getBoundingClientRect() : null;
    var x = rect ? rect.left + rect.width / 2 : 0;
    var y = rect ? rect.top + rect.height / 2 : 0;
    return eventInit({
      clientX: x, clientY: y, screenX: x, screenY: y,
      button: 0, buttons: buttons, detail: 1,
      pointerId: 1, pointerType: "mouse", isPrimary: true
    });
  }
  function dispatch(element, type, init, Ctor) {
    var event = typeof Ctor === "function" ? new Ctor(type, init) : new Event(type, init);
    element.dispatchEvent(event);
  }
  function dispatchPointer(element, type, buttons) {
    var Ctor = type.indexOf("pointer") === 0 && typeof PointerEvent === "function"
      ? PointerEvent
      : (typeof MouseEvent === "function" ? MouseEvent : null);
    dispatch(element, type, pointerInit(element, buttons), Ctor);
  }
  function keyCodeFor(key) {
    if (key === "Enter") return 13;
    return key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0;
  }
  function codeFor(key) {
    if (key.length !== 1) return key;
    if (/^[0-9]$/.test(key)) return "Digit" + key;
    if (/^[a-z]$/i.test(key)) return "Key" + key.toUpperCase();
    return "";
  }
  function dispatchKey(element, type, key) {
    dispatch(element, type, eventInit({
      key: key,
      code: codeFor(key),
      charCode: key.length === 1 ? key.charCodeAt(0) : 0,
      keyCode: keyCodeFor(key),
      which: keyCodeFor(key)
    }), typeof KeyboardEvent === "function" ? KeyboardEvent : null);
  }
  function dispatchInput(element, type, inputType, data) {
    dispatch(element, type,
      eventInit({ cancelable: type === "beforeinput", inputType: inputType, data: data }),
      typeof InputEvent === "function" ? InputEvent : null);
  }
  function focus(element) {
    try { if (typeof element.focus === "function") element.focus(); } catch (_) {}
  }
  function click(element) {
    try { element.scrollIntoView({ block: "center", inline: "nearest" }); } catch (_) {}
    dispatchPointer(element, "pointerover", 0);
    dispatchPointer(element, "mouseover", 0);
    dispatchPointer(element, "pointermove", 0);
    dispatchPointer(element, "mousemove", 0);
    dispatchPointer(element, "pointerdown", 1);
    dispatchPointer(element, "mousedown", 1);
    focus(element);
    dispatchPointer(element, "pointerup", 0);
    dispatchPointer(element, "mouseup", 0);
    if (typeof element.click === "function") element.click();
    else dispatchPointer(element, "click", 0);
  }
  function tagName(element) {
    return element.tagName ? String(element.tagName).toLowerCase() : "";
  }
  function setNativeValue(element, value) {
    var tag = tagName(element);
    var proto = tag === "textarea" ? window.HTMLTextAreaElement
      : tag === "input" ? window.HTMLInputElement : null;
    var descriptor = proto && proto.prototype
      ? Object.getOwnPropertyDescriptor(proto.prototype, "value") : null;
    if (descriptor && descriptor.set) descriptor.set.call(element, value);
    else element.value = value;
  }
  function isTextField(element) {
    var tag = tagName(element);
    return tag === "input" || tag === "textarea";
  }
  function insertText(element, text) {
    if (isTextField(element)) {
      setNativeValue(element, (element.value || "") + text);
      return;
    }
    if (!element.isContentEditable) {
      throw new Error("target is not an input, textarea, or contenteditable element");
    }
    try {
      if (document.execCommand && document.execCommand("insertText", false, text)) return;
    } catch (_) {}
    element.appendChild(document.createTextNode(text));
  }
  function clearText(element) {
    if (isTextField(element)) setNativeValue(element, "");
    else element.textContent = "";
    dispatchInput(element, "input", "deleteContentBackward", null);
  }
  function submit(element) {
    dispatchKey(element, "keydown", "Enter");
    dispatchKey(element, "keypress", "Enter");
    dispatchKey(element, "keyup", "Enter");
    var form = element.form || (typeof element.closest === "function" ? element.closest("form") : null);
    if (!form) return;
    if (typeof form.requestSubmit === "function") form.requestSubmit();
    else form.submit();
  }
  function typeText(element, step, callback) {
    focus(element);
    if (step.clear) clearText(element);
    var characters = typeof Array.from === "function" ? Array.from(step.text) : step.text.split("");
    var position = 0;
    function next() {
      if (position >= characters.length) {
        dispatch(element, "change", { bubbles: true });
        if (step.submit) submit(element);
        callback(null);
        return;
      }
      var character = characters[position];
      position += 1;
      try {
        dispatchKey(element, "keydown", character);
        dispatchKey(element, "keypress", character);
        dispatchInput(element, "beforeinput", "insertText", character);
        insertText(element, character);
        dispatchInput(element, "input", "insertText", character);
        dispatchKey(element, "keyup", character);
      } catch (error) {
        callback(error);
        return;
      }
      setTimeout(next, KEYSTROKE_DELAY_MS);
    }
    next();
  }
  function selectOption(element, value) {
    if (tagName(element) !== "select" || !element.options) {
      throw new Error("target is not a <select> element");
    }
    var options = Array.prototype.slice.call(element.options);
    var match = null;
    for (var optionIndex = 0; optionIndex < options.length && !match; optionIndex += 1) {
      if (options[optionIndex].value === value) match = options[optionIndex];
    }
    for (optionIndex = 0; optionIndex < options.length && !match; optionIndex += 1) {
      if (String(options[optionIndex].textContent || "").trim() === value) match = options[optionIndex];
    }
    if (!match) throw new Error("no option matches " + JSON.stringify(value));
    focus(element);
    element.value = match.value;
    dispatchInput(element, "input", null, null);
    dispatch(element, "change", { bubbles: true });
  }
  function perform(step, element, callback) {
    try {
      if (step.type === "click") click(element);
      else if (step.type === "select") selectOption(element, step.value);
      else if (step.type === "type") { typeText(element, step, callback); return; }
    } catch (error) {
      callback(error);
      return;
    }
    callback(null);
  }
  function waitForTarget(step, deadline, callback) {
    function tick() {
      if (finished) return;
      if (options.shouldAbort && options.shouldAbort()) { callback(null, null, true); return; }
      var element = null;
      try { element = document.querySelector(step.selector); } catch (error) { callback(error); return; }
      if (element) { callback(null, element); return; }
      if (Date.now() >= deadline) { callback(null, null); return; }
      setTimeout(tick, POLL_INTERVAL_MS);
    }
    tick();
  }
  function next() {
    if (finished) return;
    if (index >= steps.length) { finish(null); return; }
    var step = steps[index];
    var stepIndex = index;
    var timeoutMs = step.timeoutMs || STEP_TIMEOUT_MS;
    waitForTarget(step, Date.now() + timeoutMs, function (error, element, aborted) {
      if (aborted) { finish(null, true); return; }
      if (error) {
        finish(new Error(describe(step, stepIndex) + " has an invalid selector: " + message(error)));
        return;
      }
      index += 1;
      writeCursor(index);
      if (!element) {
        if (step.optional) { setTimeout(next, STEP_DELAY_MS); return; }
        finish(new Error(describe(step, stepIndex) + " timed out after " + timeoutMs + "ms."));
        return;
      }
      perform(step, element, function (performError) {
        if (performError) {
          finish(new Error(describe(step, stepIndex) + " failed: " + message(performError)));
          return;
        }
        setTimeout(next, STEP_DELAY_MS);
      });
    });
  }
  if (!steps || steps.length === 0) { done(null, false); return; }
  index = Math.min(readCursor(), steps.length);
  next();
}`;
}
