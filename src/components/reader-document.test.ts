import { load } from "cheerio";
import { describe, expect, it } from "vitest";
import {
  prepareReaderDocument,
  READER_INERT_LOCAL_MEDIA_SRC_PREFIX,
  READER_PENDING_PLACEHOLDER_SRC,
} from "./reader-document";

describe("prepareReaderDocument", () => {
  it("preserves HTML wrappers, style blocks, text nodes, and reading direction", () => {
    const html = [
      '<article class="reader-content reader-epub-content" dir="rtl" lang="en">',
      "<style>p { text-indent: 1em; }</style>",
      "First &amp; second",
      "<p>A <em>formatted</em> paragraph.</p>",
      "<!-- ignored -->",
      '<figure><img src="https://example.test/page.png"></figure>',
      "</article>",
    ].join("");

    const prepared = prepareReaderDocument(html, false);
    expect(prepared.virtualDocument).toMatchObject({
      contentClassName: "reader-content reader-epub-content",
      contentDirection: "rtl",
      contentLanguage: "en",
      staticHtml: "<style>p { text-indent: 1em; }</style>",
    });
    expect(prepared.virtualDocument.segments).toHaveLength(3);
    const [text, paragraph, image] = prepared.virtualDocument.segments;
    expect(text).toEqual({
      estimatedHeight: 96,
      html: '<p data-norea-reader-segment-index="0">First &amp; second</p>',
      index: 0,
    });
    expect(paragraph?.html).toBe(
      '<p data-norea-reader-segment-index="1">A <em>formatted</em> paragraph.</p>',
    );
    expect(image).toMatchObject({ index: 2, estimatedHeight: 520 });
    const $ = load(image!.html, {}, false);
    expect($("img").attr("src")).toBe("https://example.test/page.png");
    expect($("img").attr("data-norea-reader-media-index")).toBe("0");
    expect(
      prepared.virtualDocument.segments.some(
        (segment) => segment.html.includes("<style>"),
      ),
    ).toBe(false);
  });

  it("creates pending image shells without replacing existing image styles", () => {
    const prepared = prepareReaderDocument(
      [
        "<article>",
        '<img src="" data-norea-media-source-url="https://example.test/first.png">',
        '<img src=" " data-norea-media-source-url="https://example.test/second.png"',
        ' style="display: inline; min-height: 4rem; background-color: red;">',
        '<img src="https://example.test/ready.png"',
        ' data-norea-media-source-url="https://example.test/ready.png">',
        "</article>",
      ].join(""),
      false,
    );
    const $ = load(prepared.html, {}, false);
    const first = $("img").eq(0);
    expect(first.attr("src")).toBe(READER_PENDING_PLACEHOLDER_SRC);
    expect(first.attr("data-norea-reader-media-pending")).toBe("true");
    expect(first.attr("data-norea-reader-media-display")).toBe("true");
    expect(first.attr("data-norea-reader-media-height")).toBe("true");
    expect(first.attr("data-norea-reader-media-bg")).toBe("true");
    expect(first.css("display")).toBe("block");
    expect(first.css("min-height")).toBe("min(72vh, 56rem)");
    const second = $("img").eq(1);
    expect(second.attr("src")).toBe(READER_PENDING_PLACEHOLDER_SRC);
    expect(second.css("display")).toBe("inline");
    expect(second.css("min-height")).toBe("4rem");
    expect(second.css("background-color")).toBe("red");
    expect(second.attr("data-norea-reader-media-display")).toBeUndefined();
    expect(second.attr("data-norea-reader-media-height")).toBeUndefined();
    expect(second.attr("data-norea-reader-media-bg")).toBeUndefined();
    const ready = $("img").eq(2);
    expect(ready.attr("src")).toBe("https://example.test/ready.png");
    expect(ready.attr("data-norea-reader-media-pending")).toBeUndefined();
  });

  it("preserves media attributes and stable patch indexes without browser globals", () => {
    const prepared = prepareReaderDocument(
      [
        "<article>",
        '<div style="background-image: url(norea-media://reader-asset/bg.png)">',
        '<img src="norea-media://reader-asset/page.png"',
        ' srcset="norea-media://reader-asset/page.png 1x, https://example.test/2.png 2x">',
        '<video poster="norea-media://reader-asset/poster.png">',
        '<source src="norea-media://reader-asset/~cache/7/video.webm"></video>',
        '<svg><image href="norea-media://reader-asset/vector.png"></image></svg>',
        "</div></article>",
      ].join(""),
      false,
    );
    const $ = load(prepared.html, {}, false);
    expect(
      $("[data-norea-reader-media-index]")
        .map((_, node) => $(node).attr("data-norea-reader-media-index"))
        .get(),
    ).toEqual(["0", "1", "2", "3", "4"]);
    expect($("img").attr("src")).toBe(
      READER_INERT_LOCAL_MEDIA_SRC_PREFIX + "page.png",
    );
    expect($("img").attr("srcset")).toContain("https://example.test/2.png 2x");
    expect($("video").attr("poster")).toBe(
      READER_INERT_LOCAL_MEDIA_SRC_PREFIX + "poster.png",
    );
    expect($("source").attr("src")).toBe(
      "norea-media://reader-asset/~cache/7/video.webm",
    );
    expect($("image").attr("href")).toBe(
      READER_INERT_LOCAL_MEDIA_SRC_PREFIX + "vector.png",
    );
    expect(prepared.virtualDocument.segments[0]?.estimatedHeight).toBe(520);
  });

  it("emphasizes word prefixes while preserving escaped text and inline markup", () => {
    const html =
      "<article><p>Alpha <em>reading</em> &lt;tag&gt; &amp; &quot;literal&quot;.</p></article>";
    const prepared = prepareReaderDocument(html, true);
    const $ = load(prepared.html, {}, false);
    expect($("p").text()).toBe('Alpha reading <tag> & "literal".');
    expect($("strong").map((_, node) => $(node).text()).get()).toEqual([
      "Alp",
      "rea",
      "lit",
    ]);
    expect($("em strong").text()).toBe("rea");
    expect($("tag")).toHaveLength(0);
    expect(prepareReaderDocument(html, false).html).toBe(html);
  });

  it("splits text chapters without losing line breaks, entities, or blank sections", () => {
    const longText = "Long text ".repeat(600);
    const prepared = prepareReaderDocument(
      [
        '<article class="reader-text-content">',
        '<p><span class="reader-text-line">First &amp; &lt;line&gt;</span>',
        '<span class="reader-text-line">Second line</span></p>',
        '<div class="reader-text-break" data-blank-lines="3"></div>',
        "<p>" + longText + "</p>",
        "</article>",
      ].join(""),
      false,
    );
    expect(prepared.virtualDocument.contentClassName).toBe(
      "reader-content reader-text-content",
    );
    expect(prepared.virtualDocument.segments.length).toBeGreaterThan(2);
    const $ = load(
      prepared.virtualDocument.segments.map((segment) => segment.html).join(""),
      {},
      false,
    );
    expect($("p").first().text()).toBe("First & <line>\nSecond line");
    expect($("p").slice(1).map((_, node) => $(node).text()).get().join("")).toBe(
      longText,
    );
    expect($(".reader-text-break").attr("data-blank-lines")).toBe("3");
    expect($(".reader-text-break").attr("aria-hidden")).toBe("true");
    expect(
      prepared.virtualDocument.segments.every(
        (segment, index) => segment.index === index && segment.estimatedHeight > 0,
      ),
    ).toBe(true);
  });

  it("keeps the bounded large-document path and static styles intact", () => {
    const paragraphs = Array.from(
      { length: 500 },
      (_, index) => "<p>" + index + ": " + "Large content ".repeat(60) + "</p>",
    );
    const html = [
      '<article class="reader-content imported" dir="ltr" lang="en">',
      "<style>p { margin: 0; }</style>",
      ...paragraphs,
      "</article>",
    ].join("");
    const prepared = prepareReaderDocument(html, true);
    expect(prepared.html).toBe(html);
    expect(prepared.virtualDocument).toMatchObject({
      contentClassName: "reader-content imported",
      contentDirection: "ltr",
      contentLanguage: "en",
      staticHtml: "<style>p { margin: 0; }</style>",
    });
    expect(prepared.virtualDocument.segments.length).toBeGreaterThan(10);
    const $ = load(
      prepared.virtualDocument.segments.map((segment) => segment.html).join(""),
      {},
      false,
    );
    expect($("p")).toHaveLength(500);
    expect($("p").first().text()).toBe("0: " + "Large content ".repeat(60));
    expect($("p").last().text()).toBe("499: " + "Large content ".repeat(60));
    expect($("style")).toHaveLength(0);
    expect($("strong")).toHaveLength(0);
  });
});
