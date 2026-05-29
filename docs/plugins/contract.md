# Plugin Scraper Contract

This is the living compatibility reference for Norea source plugins.
It is based on the upstream lnreader plugin shape at commit `639a2538`, but the
local implementation is the source of truth for host behavior:

- `src/lib/plugins/types.ts` - TypeScript contract used by app code.
- `src/lib/plugins/manager.ts` - repository fetch, install, rehydrate, uninstall.
- `src/lib/plugins/sandbox.ts` - plugin module evaluation.
- `src/lib/plugins/shims.ts` - supported `require()` modules.
- `src/lib/plugins/inputs.ts` - app-managed plugin input storage helpers.
- `src/lib/http.ts` and `src-tauri/src/scraper.rs` - plugin fetch path.

The goal is compatibility with common `lnreader-plugins` sources without
binding the whole app to upstream React Native internals.

## Module Shape

A source plugin is a CommonJS module evaluated in a sandbox. It must assign the
plugin object to `module.exports.default`.

```ts
export interface PluginItem {
  id: string;
  name: string;
  lang: string;
  version: string;
  url: string;
  iconUrl: string;
  customJS?: string;
  customCSS?: string;
  hasUpdate?: boolean;
  hasSettings?: boolean;
  installMode?: "single" | "multiSource";
}

export interface Plugin extends PluginItem {
  imageRequestInit?: {
    method?: string;
    headers: Record<string, string>;
    body?: string;
  };
  filters?: Filters;
  pluginInputs?: PluginInputSchema;
  pluginSettings?: PluginInputSchema | Record<string, unknown>;
  getBaseUrl: () => string;
  popularNovels: (
    pageNo: number,
    options?: { showLatestNovels?: boolean; filters?: FilterToValues<Filters> },
  ) => Promise<NovelItem[]>;
  parseNovel: (novelPath: string) => Promise<SourceNovel>;
  parseNovelSince: (
    novelPath: string,
    sinceChapterNumber: number,
  ) => Promise<SourceNovel>;
  parsePage?: (novelPath: string, page: string) => Promise<SourcePage>;
  parseChapter: (chapterPath: string) => Promise<string>;
  parseChapterResource?: (
    chapterPath: string,
  ) => Promise<ChapterBinaryResource>;
  searchNovels: (searchTerm: string, pageNo: number) => Promise<NovelItem[]>;
  resolveUrl?: (path: string, isNovel?: boolean) => string;
  /** Run source tasks on the foreground scraper when per-page Web Storage is needed. */
  webStorageUtilized?: boolean;
}
```

The repository index supplies `PluginItem` metadata. The installed plugin source
may omit some metadata; `PluginManager` falls back to the repository item before
persisting the installed plugin. Local file installs do not have a repository
index fallback, so uploaded `.js` plugin files that omit repository-only
metadata are registered with `lang: "local"` and an empty `iconUrl`. They still
must export the required runtime functions before they can be registered.
Plugins are installed as one source by default. A repository index item may set
`installMode: "multiSource"` when the same JavaScript source acts as a provider
for multiple installed source instances. In that mode, the provider id remains
the catalog id, while each installed source instance receives its own installed
plugin id and app-managed input namespace.
Plugins must provide `getBaseUrl()` and return a non-empty absolute `http` or
`https` URL. The host uses it for source navigation, URL fallback, fetch
context, and cooldown grouping.

## Domain Types

```ts
export interface NovelItem {
  id?: undefined;
  name: string;
  path: string;
  cover?: string;
}

export type ChapterContentType = "html" | "text" | "markdown" | "pdf" | "epub";

export type ChapterBinaryMediaType = "application/pdf" | "application/epub+zip";

export interface ChapterBinaryResource {
  type: "binary";
  contentType: "pdf" | "epub";
  mediaType: ChapterBinaryMediaType;
  bytes: ArrayBuffer | Uint8Array;
  byteLength?: number;
}

export interface ChapterItem {
  name: string;
  path: string;
  contentType?: ChapterContentType;
  chapterNumber: number;
  releaseTime?: string;
  page?: string;
}

export enum NovelStatus {
  Unknown = "Unknown",
  Ongoing = "Ongoing",
  Completed = "Completed",
  Licensed = "Licensed",
  PublishingFinished = "Publishing Finished",
  Cancelled = "Cancelled",
  OnHiatus = "On Hiatus",
}

export interface SourceNovel extends NovelItem {
  genres?: string;
  summary?: string;
  author?: string;
  artist?: string;
  status?: NovelStatus;
  chapters: ChapterItem[];
  totalPages?: number;
}

export interface SourcePage {
  chapters: ChapterItem[];
}
```

The host assigns local database ids. Plugin `path` values are opaque and must be
passed back to the same plugin. `chapterNumber` is a required, stable,
source-owned numeric order key. It must be unique within one novel and every
chapter list must be returned in reading order by ascending `chapterNumber`.
When a source does not expose a number, the plugin must assign a deterministic
one-based reading-order number. The host rejects missing or non-finite
`chapterNumber` values from source plugins. When a plugin returns duplicate
`chapterNumber` values, the host keeps the first chapter for that number and
skips the later duplicates for that sync result.

`parseNovel()` returns full metadata and a full chapter list. `parseNovelSince()`
returns the same metadata fields and may limit `chapters` to
`sinceChapterNumber` and newer chapters. The limit is inclusive: if the source
still has that chapter, the returned list must contain it. Plugins that cannot
fetch a partial list may return the same full result as `parseNovel()`.

`contentType` is stored per chapter and defaults to `"html"` for older plugins.
Use `"html"` when `parseChapter` returns a reader-ready HTML fragment, `"text"`
when it returns plain text that the host must escape and wrap into HTML,
`"markdown"` when it returns Markdown that the host must render and sanitize into
HTML, and `"pdf"` or `"epub"` when the chapter represents a first-class binary
document. Text and Markdown source bodies are converted to HTML at download time;
downloaded chapter bodies are rendered by the HTML reader.
`parseChapter()` remains required for legacy plugin shape compatibility, but the
host does not call it when downloading `"pdf"` or `"epub"` chapters. Binary
chapters must implement `parseChapterResource()` and return a
`ChapterBinaryResource` with `bytes` as an `ArrayBuffer` or `Uint8Array`.
PDF bytes are stored as a PDF data URL. EPUB bytes are unpacked by the host,
converted to sanitized reader HTML, and rendered through the normal HTML reader.
The host preserves EPUB author styles and internal resources inside the
converted HTML, then applies reader settings and custom CSS/JS outside that
converted layer.
For HTML and Markdown chapters, the host resolves rendered media values against
`resolveUrl(chapter.path, false)` or the chapter path and stores downloaded
media in the local chapter cache before saving the rewritten HTML. Normal links
are not rewritten.

Binary chapter resources must contain bytes and metadata only. Do not return
base64 strings, token-bearing URLs, authorization headers, cookies, or request
init objects from `parseChapterResource()`. Private raw/download URLs must not
appear in `NovelItem.path`, `ChapterItem.path`, `parseChapter()` output, or
`parseChapterResource()` output. If the source requires credentials, the plugin
must fetch the resource itself through host-supported fetch helpers and return
only the resulting `ArrayBuffer` or `Uint8Array`.

## Filters

`Filters` is a record keyed by filter id. The host renders each filter as a
form control and passes resolved values to `popularNovels`.

| Type | Value | UI |
| --- | --- | --- |
| `Text` | `string` | text input |
| `Picker` | `string` | single-select control |
| `Checkbox` | `string[]` | multi-select control |
| `Switch` | `boolean` | toggle |
| `XCheckbox` | `{ include?: string[]; exclude?: string[] }` | include/exclude control |

The local enum values live in `src/lib/plugins/filterTypes.ts` and are exported
to plugins through `@libs/filterInputs`.

## App-Managed Plugin Inputs

Use `pluginInputs` when a source needs user-provided values such as a
self-hosted server URL, username, password, token, or feature toggle. The host
renders the schema, stores values under the installed plugin id, and exposes
the saved values through `@libs/pluginInputs`.

`pluginSettings` remains supported as a compatibility alias for upstream plugin
setting declarations. New Norea-specific plugins should prefer
`pluginInputs`.

```ts
type PluginInputValue = string | boolean;

interface PluginInputDefinition {
  value?: PluginInputValue;
  label?: string;
  type?: "Text" | "Password" | "Switch" | "Select" | "Url" | string;
  placeholder?: string;
  required?: boolean;
  private?: boolean;
  options?: { label: string; value: string }[];
}

type PluginInputSchema = Record<string, PluginInputDefinition>;
```

Example:

```ts
pluginInputs = {
  url: {
    value: "",
    label: "Server URL",
    type: "Url",
    required: true,
  },
  password: {
    value: "",
    label: "Password",
    type: "Password",
    private: true,
  },
};
```

Saved values are strings. `Switch` values are stored as `"true"` or `"false"`.
Empty string values are deleted and fall back to the schema default.

## Sandbox Whitelist

Plugins may only import modules exposed by `createShimResolver`:

| Import | Provides |
| --- | --- |
| `htmlparser2` | `{ Parser }` |
| `cheerio` | `{ load }` |
| `dayjs` | `dayjs` |
| `urlencode` | `{ encode, decode }` |
| `@libs/fetch` | `{ appFetch, fetchApi, fetchFile, fetchText, fetchProto }` |
| `@libs/novelStatus` | `{ NovelStatus }` |
| `@libs/filterInputs` | `{ FilterTypes }` |
| `@libs/defaultCover` | `{ defaultCover }` |
| `@libs/isAbsoluteUrl` | `{ isUrlAbsolute }` |
| `@libs/utils` | `{ utf8ToBytes, bytesToUtf8 }` |
| `@libs/archive` | `{ listZipEntries, readZipFile, readZipText }` |
| `@libs/csv` | `{ parseCsv }` |
| `@libs/storage` | `{ storage, localStorage, sessionStorage }` |
| `@libs/pluginInputs` | `{ inputs, pluginInputs }` |
| `@libs/webView` | `{ webViewFetch, webViewLoad, webViewNavigate }` |

Unsupported imports throw during plugin evaluation or method execution. Raw
`window` and `document` access is not guaranteed.

Current compatibility gaps:

- `fetchProto` is present but rejects because protobuf/gRPC-web support is not
  implemented.
- `@libs/cookies` and `@libs/aes` are not exposed yet.
- `customJS` and `customCSS` metadata is accepted but not downloaded into a
  plugin-specific reader injection path.

## Host Capabilities

Plugins should prefer host capabilities over bundling general-purpose
dependencies. The sandbox still rejects unlisted imports such as `jszip`; use
the explicit host contracts below instead.

### `@libs/archive`

`@libs/archive` exposes ZIP helpers backed by the native host. Plugins pass ZIP
bytes that they already fetched through `fetchApi`, and the host returns entries
without exposing filesystem access.

```ts
type PluginByteInput = ArrayBuffer | Uint8Array | number[];

interface PluginZipEntryInfo {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  isFile: boolean;
}

interface PluginZipReadOptions {
  path?: string;
  extension?: string;
  encoding?: string;
  maxBytes?: number;
}

listZipEntries(input: PluginByteInput): Promise<PluginZipEntryInfo[]>;
readZipFile(
  input: PluginByteInput,
  options?: PluginZipReadOptions,
): Promise<Uint8Array>;
readZipText(
  input: PluginByteInput,
  options?: PluginZipReadOptions,
): Promise<string>;
```

Limits:

- Archives larger than 25 MiB are rejected.
- Entries larger than 8 MiB are rejected by default.
- `maxBytes` can raise the per-entry limit up to 32 MiB.
- Absolute paths, parent traversal, and null-byte entry names are not considered
  readable files.
- The host does not write extracted files to disk.

### `@libs/csv`

`@libs/csv` provides a small RFC-4180-style parser for source catalogs.

```ts
interface CsvParseOptions {
  header?: boolean;
  delimiter?: string;
}

parseCsv(text: string, options?: CsvParseOptions):
  | string[][]
  | Record<string, string>[];
```

Use `header: true` when the first row contains field names. Missing cells become
empty strings.

## Fetch Behavior

`@libs/fetch.fetchApi` and `fetchText` route through the plugin fetch path.
Plugin-owned site traffic should use this path instead of bare browser `fetch`.

`@libs/fetch.appFetch` routes through the app-native HTTP path. Use it for
official APIs and repository-owned endpoints that do not need the scraper
WebView cookie jar, such as a GitHub REST API connector. Do not use `appFetch`
for ordinary source browsing, search, novel parsing, update checks, or chapter
downloads from plugin-owned sites.

`@libs/fetch.fetchFile` and the host HTML chapter-media cache use
`pluginMediaFetch` for static chapter-local media bytes. This path preserves
plugin-provided `imageRequestInit` headers. It normally attempts the scraper
WebView fetch first and falls back to `scraper_media_fetch` when browser JS
cannot read media bytes. On Android, cross-host media requests may use
`scraper_media_fetch` first because WebView `fetch()` can be blocked by CORS
even when the same image renders through an `<img>` tag. This native media path
is only for static media bytes; it is not a replacement for plugin-owned page
fetches that need the scraper WebView cookie jar.

The current flow:

1. The frontend calls `pluginFetch` or `pluginFetchText` in `src/lib/http.ts`.
2. The request is sent to the Rust `webview_fetch` command with the saved
   scraper User-Agent, or a plugin-provided `User-Agent` value when present.
3. `src-tauri/src/scraper.rs` executes browser fetch inside the persistent
   scraper WebView with credentials included, so the WebView cookie jar and
   configured browser user agent are used.
4. The frontend rebuilds a `Response` object for plugin code.

If a protected site needs a browser challenge or login, the user opens that site
in the in-app site browser overlay. The scraper WebView keeps the resulting
session cookies for later plugin fetches.

`@libs/webView` is reserved for pages that must be rendered by a real WebView
before content can be extracted. On desktop these helpers invoke
`webview_extract`; on Android they use the Android scraper bridge. They run on
the scraper WebView assigned to the current source task, not the foreground
site browser navigation command.

```ts
type WebViewFetchOptions = {
  beforeContentScript?: string;
  userAgent?: string;
  timeoutMs?: number;
};

type WebViewLoadResult = {
  html: string;
  text: string;
  url: string;
  title: string;
};

type WebViewNavigateResult = {
  url: string;
  title?: string;
};

webViewFetch(url, options): Promise<string>;
webViewLoad(url, options): Promise<WebViewLoadResult>;
webViewNavigate(url, options): Promise<WebViewNavigateResult>;
```

`webViewFetch()` is the low-level extractor. The plugin script must call
`window.ReactNativeWebView.postMessage(payload)` to resolve it. Use
`webViewLoad()` when the host should wait for the document to be ready and
return the current HTML, visible text, final URL, and title. Use
`webViewNavigate()` when the plugin only needs to move the task-owned scraper
WebView and observe the final URL/title. For `webViewLoad()` and
`webViewNavigate()`, `beforeContentScript` must not call
`ReactNativeWebView.postMessage`; the host owns the result message. None of
these helpers claims to bypass manual browser challenges; protected sites still
need the user to prepare the session through the site browser overlay.

## Storage

`@libs/pluginInputs` is the preferred read path for user-provided values declared
by `pluginInputs`:

```ts
import { inputs } from "@libs/pluginInputs";

inputs.get("url");      // string | null
inputs.require("url");  // string, throws if missing or blank
inputs.has("url");      // boolean
inputs.getAll();        // Record<string, string>
```

The host persists values under `plugin:<pluginId>:<key>` in app-origin local
storage. These values are local app data, not plugin source code. They are not
logged by the host and are cleared by the app's plugin storage cleanup action.
`private: true` and `type: "Password"` mask the UI control, but this is not an
OS keychain or encryption boundary. Do not place real tokens or passwords in
plugin source, docs, repository indexes, screenshots, or sample output.

`@libs/storage` remains available for upstream compatibility and plugin-owned
state. It uses the same plugin namespace:

```ts
storage.set("key", "value");
storage.get("key");
storage.delete("key");
storage.getAllKeys();
storage.clearAll();
```

`storage` and `localStorage` persist through browser local storage.
`sessionStorage` clears with the app session.

## Lifecycle

`PluginManager` owns runtime lifecycle:

1. `fetchRepository(url)` downloads a repository JSON index and keeps only valid
   `PluginItem` entries.
2. `installPlugin(item)` downloads `item.url`, evaluates the plugin, verifies
   the loaded id, registers it in memory, and stores source code plus metadata in
   SQLite.
3. `installPluginInstance(item, input)` is used for `multiSource` providers. It
   verifies the provider source, assigns a unique installed source id, stores the
   instance inputs under that id, and persists the same provider source code for
   the instance.
4. `loadInstalledFromDb()` rehydrates installed plugins from SQLite on startup.
5. `uninstallPlugin(id)` removes the in-memory plugin and deletes the persisted
   SQLite row.

`pluginId === "local"` is reserved for local-file novels, including novels
imported directly from files and user-created local novel homes that receive
chapter files later. It is not backed by a JavaScript plugin.

## Compatibility Checklist

The host should tolerate plugins that:

- Omit optional methods such as `parsePage` and `resolveUrl`.
- Return relative cover URLs.
- Return duplicate chapter paths.
- Return `releaseTime` in inconsistent string formats.
- Return long summaries.
- Throw from one source operation without breaking unrelated installed plugins.

The host does not tolerate missing `parseNovelSince()` or missing/non-finite
`chapterNumber` values. Those are breaking contract errors.

## Smoke Test Recipe

1. Add a repository URL that returns `PluginItem[]`.
2. Install one simple plugin.
3. Call `popularNovels(1)` and expect at least one `NovelItem`.
4. Call `parseNovel(item.path)` and expect at least one chapter.
5. Call `parseNovelSince(item.path, chapter.chapterNumber)` and expect the
   returned chapter list to include `chapter.chapterNumber` unless the plugin
   returns the same full chapter list as `parseNovel()`.
6. Call `parseChapter(chapter.path)` and expect content that matches the
   chapter's `contentType`: reader-ready HTML for `"html"`, plain text for
   `"text"`, or Markdown source for `"markdown"`. Downloading `"text"` or
   `"markdown"` chapters must store reader-ready HTML.
7. If `contentType` is `"pdf"` or `"epub"`, call `parseChapterResource()` and
   expect `{ type: "binary", bytes, mediaType }` without URLs, headers, or
   request init values.
8. For protected sites, open the site browser overlay first, then repeat the
   fetch path.

## References

- Upstream plugin types: <https://github.com/lnreader/lnreader/blob/639a2538/src/plugins/types/index.ts>
- Upstream filter types: <https://github.com/lnreader/lnreader/blob/639a2538/src/plugins/types/filterTypes.ts>
- Upstream plugin manager: <https://github.com/lnreader/lnreader/blob/639a2538/src/plugins/pluginManager.ts>
- Upstream fetch helpers: <https://github.com/lnreader/lnreader/blob/639a2538/src/plugins/helpers/fetch.ts>
- Upstream WebView fetch: <https://github.com/lnreader/lnreader/blob/639a2538/src/plugins/helpers/webViewFetch.ts>
- Plugin catalog: <https://github.com/lnreader/lnreader-plugins>
