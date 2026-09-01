import { invoke } from "@tauri-apps/api/core";
import { load } from "cheerio";
import dayjs from "dayjs";
import { Parser } from "htmlparser2";
import { androidWebviewExtract } from "../android-scraper";
import { getSourceRequestTimeoutMs } from "../../store/browse";
import {
  cancelScraperExecutor,
  type ContextUrlProvider,
  createPluginFetch,
  createPluginFetchFile,
  createPluginFetchText,
  pluginFetch,
  pluginFetchText,
  requestAbortedError,
  type HttpInit,
} from "../http";
import { isAndroidRuntime } from "../tauri-runtime";
import { getScraperUserAgent } from "../../store/user-agent";
import {
  activeScraperExecutor,
  activeScraperExecutorSignal,
  type ScraperExecutorId,
} from "../tasks/scraper-queue";
import {
  createPluginInputsApi,
  deletePluginInputValue,
  getPluginInputPrefix,
  getPluginInputValue,
  setPluginInputValue,
} from "./inputs";
import { sourceAccessErrorFromEnvelope } from "./source-access";
import { NovelStatus } from "./types";

export interface WebViewFetchOptions {
  beforeContentScript?: string;
  /** Accepted for upstream compatibility; no host hook today. */
  afterContentScript?: string;
  /** Overrides the scraper WebView User-Agent for this request. */
  userAgent?: string;
  timeoutMs?: number;
  scraperExecutor?: ScraperExecutorId;
  sourceId?: string;
  /** Aborts the in-flight WebView navigation when the owning task is paused. */
  signal?: AbortSignal;
}

interface WebViewLoadResult {
  html: string;
  text: string;
  url: string;
  title: string;
}

interface WebViewNavigateResult {
  url: string;
  title?: string;
}

function webViewSnapshotScript(
  includeContent: boolean,
  beforeContentScript?: string,
): string {
  const beforeScript = JSON.stringify(beforeContentScript ?? "");
  return `(function () {
  var beforeContentScript = ${beforeScript};
  function post(payload) {
    window.ReactNativeWebView.postMessage(JSON.stringify(payload));
  }
  function errorMessage(error) {
    return (error && (error.message || error.toString())) || String(error);
  }
  function runBeforeContentScript() {
    if (!beforeContentScript) return;
    (0, eval)(beforeContentScript);
  }
  function isVisible(element) {
    if (!element || typeof element.getBoundingClientRect !== "function") return false;
    var style = window.getComputedStyle ? window.getComputedStyle(element) : null;
    if (style && (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")) {
      return false;
    }
    var rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  function hasVisibleSelector(selectors) {
    for (var index = 0; index < selectors.length; index += 1) {
      var elements = document.querySelectorAll(selectors[index]);
      for (var elementIndex = 0; elementIndex < elements.length; elementIndex += 1) {
        if (isVisible(elements[elementIndex])) return true;
      }
    }
    return false;
  }
  function manualActionKind() {
    var title = (document.title || "").toLowerCase();
    var body = ((document.body && document.body.innerText) || "").toLowerCase();
    if (body.length > 12000) body = body.slice(0, 12000);
    var hasCloudflareEvidence = document.querySelector(
      "script[src*='/cdn-cgi/challenge-platform/'], link[href*='/cdn-cgi/challenge-platform/'], [data-ray], #cf-error-details"
    ) !== null || /cloudflare ray id|cf-ray|cf-chl/.test(body);
    var hasChallengeText =
      title.indexOf("just a moment") !== -1 ||
      title.indexOf("attention required") !== -1 ||
      body.indexOf("checking if the site connection is secure") !== -1 ||
      body.indexOf("enable javascript and cookies to continue") !== -1;
    if (hasVisibleSelector([
      "#challenge-running",
      "#cf-challenge-running",
      "#challenge-stage",
      "form#challenge-form",
      ".cf-browser-verification",
      ".cf-turnstile",
      "iframe[src*='challenges.cloudflare.com']"
    ]) || (hasCloudflareEvidence && hasChallengeText)) {
      return "cloudflare";
    }
    if (hasVisibleSelector([
      "iframe[src*='recaptcha']",
      "iframe[src*='hcaptcha']",
      "iframe[src*='captcha']",
      ".g-recaptcha",
      ".h-captcha",
      ".geetest_panel",
      ".geetest_holder",
      "[class*='captcha-slider']",
      "[class*='slider-captcha']",
      "[class*='puzzle-captcha']",
      "#tcaptcha_iframe_dy",
      ".tcaptcha-transform",
      ".secsdk-captcha-drag-icon"
    ])) {
      return "captcha";
    }
    return null;
  }
  function readPage() {
    var challengeKind = manualActionKind();
    if (challengeKind) {
      post({
        ok: false,
        code: "manual-action-required",
        error: challengeKind === "captcha"
          ? "Complete the CAPTCHA in the source browser."
          : "Complete the Cloudflare verification in the source browser.",
        challenge: { kind: challengeKind, url: location.href }
      });
      return;
    }
    var payload = {
      url: location.href,
      title: document.title || ""
    };
    if (${includeContent ? "true" : "false"}) {
      payload.html = document.documentElement ? document.documentElement.outerHTML : "";
      payload.text = document.body ? document.body.innerText || "" : "";
    }
    post({ ok: true, result: payload });
  }
  function readWhenReady() {
    setTimeout(function () {
      try {
        readPage();
      } catch (error) {
        post({ ok: false, error: "webView snapshot error: " + errorMessage(error) });
      }
    }, 0);
  }
  try {
    runBeforeContentScript();
  } catch (error) {
    post({ ok: false, error: "before-script error: " + errorMessage(error) });
    return;
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", readWhenReady, { once: true });
  } else {
    readWhenReady();
  }
})(); true;`;
}

function parseWebViewEnvelope(
  raw: string,
  operation: string,
  fallbackUrl: string,
): unknown {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${operation} returned invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const parsed = asRecord(value);
  if (parsed.ok === false) {
    if (parsed.code === "manual-action-required") {
      throw sourceAccessErrorFromEnvelope(parsed, fallbackUrl);
    }
    throw new Error(
      typeof parsed.error === "string" ? parsed.error : `${operation} failed`,
    );
  }
  if (parsed.ok !== true) {
    throw new Error(`${operation} returned an invalid result envelope`);
  }
  return parsed.result;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    throw new Error("webView result was not an object");
  }
  return value as Record<string, unknown>;
}

function parseWebViewLoadResult(raw: string, fallbackUrl: string): WebViewLoadResult {
  const value = asRecord(
    parseWebViewEnvelope(raw, "webViewLoad", fallbackUrl),
  );
  return {
    html: typeof value.html === "string" ? value.html : "",
    text: typeof value.text === "string" ? value.text : "",
    url: typeof value.url === "string" ? value.url : "",
    title: typeof value.title === "string" ? value.title : "",
  };
}

function parseWebViewNavigateResult(
  raw: string,
  fallbackUrl: string,
): WebViewNavigateResult {
  const value = asRecord(
    parseWebViewEnvelope(raw, "webViewNavigate", fallbackUrl),
  );
  const url = typeof value.url === "string" ? value.url : "";
  const title = typeof value.title === "string" ? value.title : undefined;
  return title ? { url, title } : { url };
}

/**
 * Mirror of upstream `@libs/webView.webViewFetch`. Navigates the
 * scraper WebView to `url`, runs `beforeContentScript` before any
 * page script via the SCRAPER_INIT_SCRIPT bridge, and resolves with
 * whatever the page emits via `window.ReactNativeWebView.postMessage`.
 *
 * Used by plugins (e.g. Booktoki) whose chapter content is locked
 * behind closed shadow roots that only the platform browser session can
 * read after the page's own JS finishes decrypting.
 */
export async function webViewFetch(
  url: string,
  options: WebViewFetchOptions = {},
): Promise<string> {
  return webViewFetchInternal(url, options, false);
}

export async function captureChapterWebView(
  url: string,
  options: WebViewFetchOptions = {},
): Promise<string> {
  return webViewFetchInternal(url, options, true);
}

async function webViewFetchInternal(
  url: string,
  options: WebViewFetchOptions,
  captureResources: boolean,
): Promise<string> {
  const userAgent = options.userAgent?.trim() || getScraperUserAgent();
  const scraperExecutor =
    options.scraperExecutor ?? activeScraperExecutor(options.sourceId);
  const timeoutMs = options.timeoutMs ?? getSourceRequestTimeoutMs();
  const signal = options.signal ?? activeScraperExecutorSignal(scraperExecutor);
  if (isAndroidRuntime()) {
    return androidWebviewExtract(
      url,
      options.beforeContentScript ?? null,
      timeoutMs,
      userAgent,
      options.sourceId,
      scraperExecutor,
      signal,
    );
  }

  return desktopWebViewExtract(
    url,
    options.beforeContentScript ?? null,
    timeoutMs,
    userAgent,
    options.sourceId,
    scraperExecutor,
    signal,
    captureResources,
  );
}

/**
 * Desktop WebView extract with abort support. The native `webview_extract`
 * holds its executor lock while navigating, so a paused task must cancel it to
 * release the shared foreground executor for interactive work. On abort we both
 * reject promptly and ask the native side to cancel the in-flight navigation.
 */
async function desktopWebViewExtract(
  url: string,
  beforeScript: string | null,
  timeoutMs: number,
  userAgent: string | null,
  sourceId: string | undefined,
  scraperExecutor: ScraperExecutorId,
  signal: AbortSignal | undefined,
  captureResources: boolean,
): Promise<string> {
  if (signal?.aborted) {
    void cancelScraperExecutor(scraperExecutor);
    throw requestAbortedError();
  }
  const request = invoke<string>("webview_extract", {
    url,
    beforeScript,
    timeoutMs,
    userAgent,
    queue: scraperExecutor,
    ...(sourceId ? { sourceId } : {}),
    ...(captureResources ? { captureResources: true } : {}),
  });
  if (!signal) return request;

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      void cancelScraperExecutor(scraperExecutor);
      reject(requestAbortedError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([request, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
    void request.catch(() => undefined);
  }
}

async function webViewLoad(
  url: string,
  options: WebViewFetchOptions = {},
): Promise<WebViewLoadResult> {
  const raw = await webViewFetch(url, {
    ...options,
    beforeContentScript: webViewSnapshotScript(
      true,
      options.beforeContentScript,
    ),
  });
  return parseWebViewLoadResult(raw, url);
}

async function webViewNavigate(
  url: string,
  options: WebViewFetchOptions = {},
): Promise<WebViewNavigateResult> {
  const raw = await webViewFetch(url, {
    ...options,
    beforeContentScript: webViewSnapshotScript(
      false,
      options.beforeContentScript,
    ),
  });
  return parseWebViewNavigateResult(raw, url);
}

function createWebViewFetch(
  sourceId: string,
  scraperExecutor: ScraperExecutorId,
): typeof webViewFetch {
  return (url: string, options: WebViewFetchOptions = {}) =>
    webViewFetch(url, {
      ...options,
      scraperExecutor: options.scraperExecutor ?? scraperExecutor,
      sourceId: options.sourceId ?? sourceId,
    });
}

function createWebViewLoad(
  sourceId: string,
  scraperExecutor: ScraperExecutorId,
): typeof webViewLoad {
  return (url: string, options: WebViewFetchOptions = {}) =>
    webViewLoad(url, {
      ...options,
      scraperExecutor: options.scraperExecutor ?? scraperExecutor,
      sourceId: options.sourceId ?? sourceId,
    });
}

function createWebViewNavigate(
  sourceId: string,
  scraperExecutor: ScraperExecutorId,
): typeof webViewNavigate {
  return (url: string, options: WebViewFetchOptions = {}) =>
    webViewNavigate(url, {
      ...options,
      scraperExecutor: options.scraperExecutor ?? scraperExecutor,
      sourceId: options.sourceId ?? sourceId,
    });
}

/**
 * Filter-input enum values upstream plugins expect from
 * `@libs/filterInputs`. Plugins use these as discriminators when
 * building their `filters` schema.
 */
export const FilterTypes = {
  TextInput: "Text",
  Picker: "Picker",
  CheckboxGroup: "Checkbox",
  Switch: "Switch",
  ExcludableCheckboxGroup: "XCheckbox",
} as const;

export const defaultCover =
  "https://placehold.co/200x300?text=No+Cover";

export function isUrlAbsolute(url: string): boolean {
  return /^[a-z][a-z\d+\-.]*:/i.test(url);
}

export function utf8ToBytes(input: string): Uint8Array {
  return new TextEncoder().encode(input);
}

export function bytesToUtf8(input: Uint8Array): string {
  return new TextDecoder().decode(input);
}

type PluginByteInput = ArrayBuffer | Uint8Array | number[];

export interface PluginZipEntryInfo {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  isFile: boolean;
}

interface PluginZipEntryInfoWire {
  name: string;
  compressed_size: number;
  uncompressed_size: number;
  is_file: boolean;
}

export interface PluginZipReadOptions {
  path?: string;
  extension?: string;
  encoding?: string;
  maxBytes?: number;
}

export interface CsvParseOptions {
  header?: boolean;
  delimiter?: string;
}

function byteInputToArray(input: PluginByteInput): number[] {
  if (Array.isArray(input)) return input;
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  return Array.from(bytes);
}

function toZipEntryInfo(entry: PluginZipEntryInfoWire): PluginZipEntryInfo {
  return {
    name: entry.name,
    compressedSize: entry.compressed_size,
    uncompressedSize: entry.uncompressed_size,
    isFile: entry.is_file,
  };
}

export async function listZipEntries(
  input: PluginByteInput,
): Promise<PluginZipEntryInfo[]> {
  const entries = await invoke<PluginZipEntryInfoWire[]>("plugin_zip_list", {
    bytes: byteInputToArray(input),
  });
  return entries.map(toZipEntryInfo);
}

export async function readZipFile(
  input: PluginByteInput,
  options: PluginZipReadOptions = {},
): Promise<Uint8Array> {
  const bytes = await invoke<number[]>("plugin_zip_read_file", {
    bytes: byteInputToArray(input),
    options: {
      path: options.path,
      extension: options.extension,
      max_bytes: options.maxBytes,
    },
  });
  return new Uint8Array(bytes);
}

export async function readZipText(
  input: PluginByteInput,
  options: PluginZipReadOptions = {},
): Promise<string> {
  const bytes = await readZipFile(input, options);
  return new TextDecoder(options.encoding ?? "utf-8").decode(bytes);
}

export function parseCsv(
  text: string,
  options: CsvParseOptions = {},
): string[][] | Record<string, string>[] {
  const delimiter = options.delimiter ?? ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }

  if (!options.header) return rows;

  const headers = rows.shift() ?? [];
  return rows.map((values) => {
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      record[header] = values[index] ?? "";
    });
    return record;
  });
}

interface NamespacedStorage {
  set(key: string, value: string): void;
  get(key: string): string | null;
  delete(key: string): void;
  getAllKeys(): string[];
  clearAll(): void;
}

export {
  deletePluginInputValue as deletePluginStorageValue,
  getPluginInputValue as getPluginStorageValue,
  setPluginInputValue as setPluginStorageValue,
};

function makeNamespacedStorage(
  prefix: string,
  persistent: boolean,
): NamespacedStorage {
  // Defer `localStorage` / `sessionStorage` access until method
  // invocation so node-env tests can construct a resolver without
  // a DOM as long as they don't actually use storage.
  const getBacking = (): Storage =>
    persistent ? globalThis.localStorage : globalThis.sessionStorage;
  const key = (suffix: string): string => `${prefix}${suffix}`;

  return {
    set(suffix, value) {
      getBacking().setItem(key(suffix), value);
    },
    get(suffix) {
      return getBacking().getItem(key(suffix));
    },
    delete(suffix) {
      getBacking().removeItem(key(suffix));
    },
    getAllKeys() {
      const backing = getBacking();
      const keys: string[] = [];
      for (let i = 0; i < backing.length; i += 1) {
        const fullKey = backing.key(i);
        if (fullKey !== null && fullKey.startsWith(prefix)) {
          keys.push(fullKey.slice(prefix.length));
        }
      }
      return keys;
    },
    clearAll() {
      const backing = getBacking();
      const toRemove: string[] = [];
      for (let i = 0; i < backing.length; i += 1) {
        const fullKey = backing.key(i);
        if (fullKey !== null && fullKey.startsWith(prefix)) {
          toRemove.push(fullKey);
        }
      }
      for (const fullKey of toRemove) {
        backing.removeItem(fullKey);
      }
    },
  };
}

/**
 * Build the `_require` resolver for a sandboxed plugin instance.
 *
 * Mirrors the upstream lnreader whitelist from the plugin contract
 * reference. Modules outside the whitelist throw. Plugins that touch
 * `window`/`document` directly are unsupported.
 */
export function createShimResolver(
  pluginId: string,
  baseUrl?: ContextUrlProvider,
  scraperExecutor: ScraperExecutorId = "immediate",
): (id: string) => unknown {
  const prefix = getPluginInputPrefix(pluginId);
  const storage = makeNamespacedStorage(prefix, true);
  const sessionStg = makeNamespacedStorage(prefix, false);
  const pluginInputs = createPluginInputsApi(pluginId);
  const fetchApi = baseUrl
    ? createPluginFetch(baseUrl, pluginId, scraperExecutor)
    : (url: string, init: HttpInit = {}) =>
        pluginFetch(url, {
          ...init,
          scraperExecutor: init.scraperExecutor ?? scraperExecutor,
          sourceId: init.sourceId ?? pluginId,
        });
  const fetchText = baseUrl
    ? createPluginFetchText(baseUrl, pluginId, scraperExecutor)
    : (url: string, init: HttpInit = {}) =>
        pluginFetchText(url, {
          ...init,
          scraperExecutor: init.scraperExecutor ?? scraperExecutor,
          sourceId: init.sourceId ?? pluginId,
        });
  const fetchFile = createPluginFetchFile(baseUrl, pluginId, scraperExecutor);

  return (id) => {
    switch (id) {
      case "htmlparser2":
        return { Parser };
      case "cheerio":
        return { load };
      case "dayjs":
        return dayjs;
      case "urlencode":
        return { encode: encodeURIComponent, decode: decodeURIComponent };
      case "@libs/fetch":
        return {
          appFetch: fetchApi,
          fetchApi,
          fetchFile,
          fetchText,
          fetchProto: () =>
            Promise.reject(
              new Error(
                "fetchProto is not implemented in this runtime.",
              ),
            ),
        };
      case "@libs/novelStatus":
        return { NovelStatus };
      case "@libs/filterInputs":
        return { FilterTypes };
      case "@libs/defaultCover":
        return { defaultCover };
      case "@libs/isAbsoluteUrl":
        return { isUrlAbsolute };
      case "@libs/utils":
        return { utf8ToBytes, bytesToUtf8 };
      case "@libs/archive":
        return { listZipEntries, readZipFile, readZipText };
      case "@libs/csv":
        return { parseCsv };
      case "@libs/storage":
        return {
          storage,
          localStorage: storage,
          sessionStorage: sessionStg,
        };
      case "@libs/pluginInputs":
        return {
          inputs: pluginInputs,
          pluginInputs,
        };
      case "@libs/webView":
        return {
          webViewFetch: createWebViewFetch(pluginId, scraperExecutor),
          webViewLoad: createWebViewLoad(pluginId, scraperExecutor),
          webViewNavigate: createWebViewNavigate(pluginId, scraperExecutor),
        };
      default:
        throw new Error(
          `Module '${id}' is not whitelisted in the plugin sandbox.`,
        );
    }
  };
}
