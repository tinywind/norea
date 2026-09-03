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

The host does not override the browser's HTTP cache mode. Source responses
follow the cache and revalidation directives sent by the site. When
`cacheBust` is `true`, the host adds a unique `_norea_capture` query value for
each acquisition while preserving every source query parameter. Use it only
when a source embeds short-lived data in otherwise cacheable chapter HTML.
Required source query parameters still belong in `url`.

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

### Access challenges

Use the exact marker `data-norea-manual-action="captcha"` for a CAPTCHA and
`data-norea-manual-action="cloudflare"` for a Cloudflare browser challenge.
The page capture failure may then include this additive envelope data:

```ts
type SourceAccessChallenge = {
  kind: "captcha" | "cloudflare";
  url: string;
};

type ChapterCaptureFailureEnvelope =
  | {
      ok: false;
      code: "manual-action-required";
      error: string;
      challenge?: SourceAccessChallenge;
    }
  | {
      ok: false;
      code: Exclude<ChapterCaptureErrorCode, "manual-action-required">;
      error: string;
      challenge?: never;
    };
```

`challenge.url` must be an absolute HTTP(S) URL for the page where the
challenge was observed. The host accepts it only when its hostname matches the
trusted acquisition URL; otherwise the host uses the trusted URL. Credentials
embedded in a URL are rejected.

A typed CAPTCHA or Cloudflare challenge blocks source access for the source's
full task queue, including individual and batch chapter downloads, and keeps
source-dependent promises pending. A chapter task may still reconcile
authoritative final content locally while blocked; doing so does not verify or
clear source access. The block survives an application restart. Norea opens the
source in its session-owning browser so the user can complete the challenge,
then offers **Keep paused** and **Verify**. Verify runs one queued task as a
canary and unblocks the source only after that task explicitly confirms
successful source access and completes. Chapter canaries bypass final-content
and partial-resume fast paths so verification performs a real source
acquisition. A repeated challenge or an unconfirmed canary leaves the queue
blocked.

Restart recovery persists only the challenge URL origin, because paths, query
strings, and fragments may contain credentials or short-lived proof tokens. When
a queued chapter download can safely rebuild its current trusted acquisition
URL, Norea validates that the rebuilt URL still belongs to the blocked hostname
before opening the browser. Generic source tasks whose exact request URL cannot
be reconstructed safely open the persisted origin instead. Their canary remains
subject to the block: if the challenge persists at a more specific URL, the
fresh challenge replaces the in-memory URL and a later manual attempt opens that
exact page. A hostname change does not migrate or clear a source-wide block
automatically; the source remains blocked and the verification action stays
disabled until a same-host canary is available. Only explicit confirmation
followed by full canary success clears either flow.

An untyped `data-norea-manual-action` marker remains a generic acquisition
failure and does not create a source-wide access block. Plugins identify the
challenge; they must not solve, bypass, or relay it. These optional failure
fields are additive, so the contract version remains 0.2.

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

The returned content type must match the chapter row. When re-downloading a
text or Markdown chapter that the host previously normalized to stored HTML,
the host may request `html`; the resource may retain its original `text` or
`markdown` type so the host can convert it again. `baseUrl`, when present,
must be an absolute HTTP(S) URL and is used only to resolve relative media and
prepare media transport. It does not change the source-access scope or the
trusted challenge URL. API 0.2 has no plugin-declared access-origin allowlist,
so a CDN that requires independent top-level manual verification is not
supported as a separate authentication scope. Binary resources must be
non-empty and their media type must match their chapter type.

## Host-owned page and media pipeline

For a page plan, the chapter task and its page capture use the task's assigned
scraper executor. The capture therefore shares the browser cookie jar,
challenge state, cache, cancellation signal, and foreground/background
scheduling rules with plugin browsing for that source id. Different source ids
use isolated browser profiles, even when they point to the same site origin.

Before asking a plugin for an acquisition plan or starting network traffic, the
host checks the resolved chapter directory for a final `content.*` file. An
existing final content file is authoritative: the host trusts it as downloaded,
reconciles the database metadata, and completes the task without validating the
file, comparing plugin versions, or requiring a manifest or media archive.
Missing or damaged media does not invalidate final chapter content. An
inaccessible storage location is an error, not evidence that the file is
missing.

The host then:

1. converts text or Markdown to reader HTML and sanitizes captured content;
2. persists partial HTML as non-authoritative resume state before downloading
   remote media, without publishing it as final `content.*`;
3. records normalized asset URLs and local filenames in the chapter manifest;
4. materializes lazy image URLs in the page WebView so browser-owned responses
   exist for the captured content;
5. on Windows, consumes matching media response bodies captured by WebView2
   during the chapter navigation after the response stream settles;
6. when no captured body is available, performs a normal fetch in the
   page-owning source-profile WebView without falling back to app or host HTTP;
7. downloads missing assets through the assigned scraper WebView executor
   without an app-configurable resource slot limit;
8. updates the manifest after each completed asset and creates `media.zip`;
9. publishes final `content.*` only after the acquisition pipeline completes;
10. resumes incomplete work from stored partial HTML and the manifest without
    navigating the chapter page again.

Once final `content.*` exists, the incomplete-work resume path does not run.
Users can force a fresh download with the in-app chapter deletion action, or by
closing Norea and deleting the chapter's entire directory under `contents/`.
Deleting only `media.zip` or `manifest.json` does not request a fresh download
while final content remains.

An explicit media repair is not a download resume. For non-binary page and
resource plans, the host evaluates the plan again and reacquires the chapter
body before extracting media. Stored HTML and the manifest are used only to
reuse validated complete files; missing or incomplete files are downloaded.
Rendered binary PDF and EPUB content is repaired in place from its stored HTML.

If a background task is paused during one asset, the active request is allowed
to settle or is cancelled through the executor signal. A resumed foreground
task reuses the completed files recorded in the manifest.

## Plugin-owned traffic

Source browsing, search, novel parsing, update checks, and explicit resource
acquisition must use the sanctioned plugin fetch shims. Browser session state
belongs to the source-owned scraper WebView profile. A source id shares that
profile across foreground and worker executors, while different source ids do
not share cookies, DOM storage, or browser cache. Plugins must not copy cookies
into a separate client or replace protected source traffic with bare
application HTTP.

Closing the foreground site browser hides its WebView instead of resetting its
source profile. Reopening the same source and worker requests for that source
reuse the same browser-owned user data. Android WebViews that must be destroyed
flush their profile cookies first. A later WebView for the same source reopens
the same persistent profile.

Browser sessions created by versions that used one shared scraper profile are
not copied into source-owned profiles because the host cannot infer which
source owns shared cookies or DOM storage. Users may need to sign in once per
source after upgrading.

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
