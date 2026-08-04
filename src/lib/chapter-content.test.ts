import { describe, expect, it } from "vitest";
import {
  chapterContentToHtml,
  isBinaryChapterContentType,
  isHtmlLikeChapterContentType,
  isKnownChapterContentType,
  normalizeChapterContentType,
  sanitizeReaderHtml,
  storedChapterContentType,
} from "./chapter-content";

describe("chapterContentToHtml", () => {
  it("escapes text chapter content into reader HTML paragraphs", () => {
    expect(
      chapterContentToHtml(
        `Line <one> & "two" 'three'\ncontinued\n\nNext`,
        "text",
      ),
    ).toBe(
      `<article class="reader-text-content" data-source-format="text"><section class="reader-text-section" data-section-index="0"><p class="reader-text-paragraph" data-paragraph-index="0"><span class="reader-text-line" data-line-index="0">Line &lt;one&gt; &amp; &quot;two&quot; &#39;three&#39;</span><span class="reader-text-line" data-line-index="1">continued</span></p><p class="reader-text-paragraph" data-paragraph-index="1"><span class="reader-text-line" data-line-index="0">Next</span></p></section></article>`,
    );
  });

  it("converts repeated blank text lines into section breaks", () => {
    expect(chapterContentToHtml("Part one\n\n\nPart two", "text")).toBe(
      `<article class="reader-text-content" data-source-format="text"><section class="reader-text-section" data-section-index="0"><p class="reader-text-paragraph" data-paragraph-index="0"><span class="reader-text-line" data-line-index="0">Part one</span></p></section><div class="reader-text-break" data-blank-lines="2" aria-hidden="true"></div><section class="reader-text-section" data-section-index="1"><p class="reader-text-paragraph" data-paragraph-index="0"><span class="reader-text-line" data-line-index="0">Part two</span></p></section></article>`,
    );
  });

  it("passes html chapter content through unchanged", () => {
    const html = `<section><h1>Title</h1><p>Line & entity</p></section>`;

    expect(chapterContentToHtml(html, "html")).toBe(html);
  });

  it("treats epub as stored reader html content", () => {
    const html = `<article class="reader-epub-content" data-epub-rendered="true"><section>Body</section></article>`;

    expect(chapterContentToHtml(html, "epub")).toBe(html);
  });

  it("renders markdown as sanitized reader HTML", () => {
    const html = chapterContentToHtml(
      [
        "# Title",
        "",
        "- One",
        "- Two",
        "",
        "[link](https://example.test)",
        "![Alt](https://cdn.test/page.png)",
        "![Relative](/relative/page.jpg)",
        "",
        "<script>alert(1)</script>",
        "<img src=\"javascript:alert(1)\" onerror=\"run()\">",
      ].join("\n"),
      "markdown",
    );

    expect(html).toContain('<section class="reader-markdown-content">');
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<li>One</li>");
    expect(html).toContain('<a href="https://example.test">link</a>');
    expect(html).toContain('<img src="https://cdn.test/page.png" alt="Alt">');
    expect(html).toContain('<img src="/relative/page.jpg" alt="Relative">');
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("onerror");
  });

  it("still sanitizes raw markdown even when it starts with the stored wrapper", () => {
    const html = chapterContentToHtml(
      `<section class="reader-markdown-content"><script>alert(1)</script><h1 onclick="run()">Line</h1></section>`,
      "markdown",
    );

    expect(html).toContain('<section class="reader-markdown-content">');
    expect(html).toContain("<h1>Line</h1>");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("onclick");
  });

  it("preserves safe lazy image URLs and removes unsafe ones", () => {
    const html = sanitizeReaderHtml(
      [
        '<img data-src="https://cdn.test/page-1.jpg?accessKey=signed"',
        ' data-original="http://cdn.test/page-2.jpg"',
        ' data-lazy-src="https://cdn.test/page-3.jpg"',
        ' data-orig-src="https://cdn.test/page-4.jpg">',
        '<img data-src="javascript:alert(1)"',
        ' data-original="data:text/html;base64,PHNjcmlwdD4="',
        ' data-lazy-src="javascript:run()"',
        ' data-orig-src="data:application/octet-stream;base64,AA==">',
      ].join(""),
    );

    expect(html).toContain(
      'data-src="https://cdn.test/page-1.jpg?accessKey=signed"',
    );
    expect(html).toContain('data-original="http://cdn.test/page-2.jpg"');
    expect(html).toContain('data-lazy-src="https://cdn.test/page-3.jpg"');
    expect(html).toContain('data-orig-src="https://cdn.test/page-4.jpg"');
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:text/html");
    expect(html).not.toContain("data:application/octet-stream");
  });
});

describe("chapter content type helpers", () => {
  it("recognizes epub as known, html-like, and resource-downloadable", () => {
    expect(normalizeChapterContentType("epub")).toBe("epub");
    expect(isKnownChapterContentType("epub")).toBe(true);
    expect(isHtmlLikeChapterContentType("epub")).toBe(true);
    expect(isBinaryChapterContentType("epub")).toBe(true);
  });

  it("keeps explicit unknown content types detectable before fallback", () => {
    expect(isKnownChapterContentType("mobi")).toBe(false);
    expect(normalizeChapterContentType("mobi")).toBe("html");
  });

  it("stores rendered text and markdown chapters as html", () => {
    expect(storedChapterContentType("text")).toBe("html");
    expect(storedChapterContentType("markdown")).toBe("html");
    expect(storedChapterContentType("html")).toBe("html");
    expect(storedChapterContentType("pdf")).toBe("pdf");
    expect(storedChapterContentType("epub")).toBe("epub");
  });
});
