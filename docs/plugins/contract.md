# Source Plugin Contract 0.2

Norea source plugins are JavaScript modules that export one object implementing
the 0.2 contract. The application owns plugin loading, browser execution,
chapter persistence, media archives, and download resumption.

## Identity and manifest

Every plugin and repository manifest entry must declare `apiVersion: "0.2"`.
The plugin's own `version` is independent from the host contract version.

```ts
interface PluginItem {
  apiVersion: "0.2";
  id: string;
  name: string;
  lang: string;
  version: string;
  url: string;
  iconUrl: string;
  installMode?: "single" | "multiSource";
}
```

The host rejects missing or different API versions before registering a
plugin. Source IDs must remain stable after release.

## Chapter acquisition

Plugins describe how to acquire a chapter. They do not fetch ordinary chapter
pages and return parsed HTML.

```ts
type ChapterContentType = "html" | "text" | "markdown" | "pdf" | "epub";

type ChapterAcquisitionPlan =
  | {
      type: "page";
      url: string;
      contentSelector: string;
      readySelector?: string;
      excludeSelectors?: string[];
      documentStartScript?: string;
      loadStrategy?: "selector" | "network-idle" | "scroll-to-end";
      cacheBust?: boolean;
      timeoutMs?: number;
    }
  | {
      type: "resource";
    };

interface Plugin {
  apiVersion: "0.2";
  getChapterAcquisitionPlan(
    chapterPath: string,
    contentType: ChapterContentType,
  ): ChapterAcquisitionPlan;
  getChapterResource?(
    chapterPath: string,
    contentType: ChapterContentType,
  ): Promise<ChapterResource>;
}
```

`getChapterAcquisitionPlan()` is synchronous and side-effect free. It may
decode an opaque chapter path and read configured plugin inputs, but it must
not perform network traffic, mutate storage, or start a purchase.

### Page plans

Use a page plan for normal HTML, text, Markdown, webtoon, and rendered novel
chapters. The URL must be absolute HTTP(S) and must preserve every
source-required query parameter, including signed URLs and access keys.

The host navigates its scraper WebView to `url`, injects
`documentStartScript` before source scripts, waits according to `loadStrategy`,
clones `contentSelector`, removes `excludeSelectors`, and normalizes lazy image
sources. `readySelector` defaults to `contentSelector`.

`cacheBust: true` asks the host to append its own `_norea_capture` query value.
It never replaces existing query parameters. Use it for short-lived page
tokens; do not add time-dependent values inside the plan method.

`documentStartScript` is intended for rendered content that is otherwise not
present in the light DOM. It may observe source API responses or open shadow
roots and place the final content under a stable synthetic selector. It must
not send a competing `ReactNativeWebView.postMessage()` result because the host
owns the capture envelope.

When login, a challenge, acknowledgement, or paid gate needs user action, add
an element with `data-norea-manual-action`. The host fails the acquisition with
`manual-action-required` instead of storing the gate page. A purchase may be
triggered only when the user has enabled an explicit plugin input for that
action.

### Resource plans

Use a resource plan only when there is no navigable content page, such as:

- a documented connector API that returns content;
- a ZIP or other archive that must be decoded by the plugin;
- a first-class PDF or EPUB file.

The plugin must implement `getChapterResource()` when it returns a resource
plan.

```ts
type ChapterResource =
  | {
      type: "content";
      contentType: "html" | "text" | "markdown";
      content: string;
      baseUrl?: string;
    }
  | {
      type: "binary";
      contentType: "pdf" | "epub";
      mediaType: "application/pdf" | "application/epub+zip";
      bytes: ArrayBuffer | Uint8Array;
      filename?: string;
      byteLength?: number;
    };
```

The returned content type must match the chapter row. `baseUrl`, when present,
must be an absolute HTTP(S) URL and is used to resolve relative media. Binary
resources must be non-empty and their media type must match their chapter type.

## Host-owned page and media pipeline

For a page plan, the chapter task and its page capture use the task's assigned
scraper executor. The capture therefore shares the browser cookie jar,
challenge state, cache, cancellation signal, and foreground/background
scheduling rules with plugin browsing.

The host then:

1. converts text or Markdown to reader HTML and sanitizes captured content;
2. persists partial HTML before downloading remote media;
3. records normalized asset URLs and local filenames in the chapter manifest;
4. tries the page-owning WebView cache before native media fallback;
5. downloads missing assets through the assigned scraper WebView executor
   without an app-configurable resource slot limit;
6. updates the manifest after each completed asset and creates `media.zip`;
7. resumes from stored partial HTML and the manifest without navigating the
   chapter page again.

An explicit media repair is not a download resume. For a page plan, the host
evaluates the plan again and captures the chapter page before extracting media.
The stored HTML and manifest are used only to reuse files that are already
available. Resource plans have no page to revisit, so their rendered stored
content is repaired in place.

If a background task is paused during one asset, the active request is allowed
to settle or is cancelled through the executor signal. A resumed foreground
task reuses the completed files recorded in the manifest.

## Plugin-owned traffic

Source browsing, search, novel parsing, update checks, and explicit resource
acquisition must use the sanctioned plugin fetch shims. Browser session state
belongs to the scraper WebView. Plugins must not copy cookies into a separate
client or replace protected source traffic with bare application HTTP.

Ordinary page chapters must use a page plan even if a static HTTP parser would
appear simpler. This keeps challenge handling, logged-in sessions, rendered
content, and browser cache behavior consistent.

## Required plugin surface

Besides chapter acquisition, a plugin implements:

```ts
interface Plugin {
  apiVersion: "0.2";
  id: string;
  name: string;
  lang: string;
  version: string;
  iconUrl: string;
  getBaseUrl(): string;
  popularNovels(pageNo: number, options?: PluginPopularOptions): Promise<NovelItem[]>;
  searchNovels(searchTerm: string, pageNo: number): Promise<NovelItem[]>;
  parseNovel(novelPath: string): Promise<SourceNovel>;
  parseNovelSince(
    novelPath: string,
    sinceChapterNumber: number,
  ): Promise<SourceNovel>;
  getChapterAcquisitionPlan(
    chapterPath: string,
    contentType: ChapterContentType,
  ): ChapterAcquisitionPlan;
}
```

`ChapterItem.chapterNumber` is a stable source-owned order key unique within a
novel. `ChapterItem.path` may be an absolute URL, relative path, or opaque
encoded payload. Secrets must remain in private plugin inputs or request init
objects and must not be written into paths or stored content.

## Example

```ts
class ExampleSource implements Plugin.PluginBase {
  apiVersion = Plugin.API_VERSION;

  getChapterAcquisitionPlan(
    chapterPath: string,
  ): Plugin.ChapterAcquisitionPlan {
    return {
      type: "page",
      url: new URL(chapterPath, this.getBaseUrl()).href,
      contentSelector: "article.chapter-content",
      excludeSelectors: [".advertisement"],
      loadStrategy: "network-idle",
    };
  }
}
```

For PDF chapters:

```ts
getChapterAcquisitionPlan(): Plugin.ChapterAcquisitionPlan {
  return { type: "resource" };
}

async getChapterResource(
  chapterPath: string,
): Promise<Plugin.ChapterResource> {
  const response = await fetchApi(chapterPath);
  const bytes = await response.arrayBuffer();
  return {
    type: "binary",
    contentType: "pdf",
    mediaType: "application/pdf",
    bytes,
    byteLength: bytes.byteLength,
  };
}
```
