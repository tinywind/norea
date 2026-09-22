import { useMemo, type CSSProperties } from "react";
import { type ReaderAppearanceSettings } from "../../store/reader";
const READER_PAGE_MEDIA_ELEMENTS = [
  "img",
  "svg",
  "video",
  "canvas",
  "iframe",
] as const;
const READER_PAGE_SINGLE_MEDIA_ELEMENTS = [
  "img",
  "picture",
  "svg",
  "video",
  "canvas",
  "iframe",
] as const;
const READER_PAGE_SINGLE_FLOW_ELEMENTS = ["p", "div", "figure", "a"] as const;

function cssSelectorList(
  prefix: string,
  elements: readonly string[],
  suffix = "",
): string {
  return elements.map((element) => `${prefix}${element}${suffix}`).join(",\n");
}

interface ReaderContentStyleOptions {
  appearance: Pick<
    ReaderAppearanceSettings,
    | "textColor"
    | "textSize"
    | "lineHeight"
    | "textAlign"
    | "fontFamily"
    | "padding"
  >;
  viewportWidth: number;
  viewportHeightPx: number;
  pageColumnsPerSpread: number;
  isPagedReader: boolean;
  removeExtraParagraphSpacing: boolean;
}
export function useReaderContentStyle({
  appearance,
  viewportWidth,
  viewportHeightPx,
  pageColumnsPerSpread,
  isPagedReader,
  removeExtraParagraphSpacing,
}: ReaderContentStyleOptions) {
  const contentStyle = useMemo<CSSProperties>(
    () =>
      ({
        "--norea-reader-page-media-max-height": `${Math.max(
          1,
          viewportHeightPx - appearance.padding * 2,
        )}px`,
        boxSizing: "border-box",
        color: appearance.textColor,
        fontSize: `${appearance.textSize}px`,
        lineHeight: appearance.lineHeight,
        textAlign: appearance.textAlign,
        fontFamily: appearance.fontFamily || undefined,
        padding: `${appearance.padding}px`,
      }) as CSSProperties,
    [
      appearance.fontFamily,
      appearance.lineHeight,
      appearance.padding,
      appearance.textAlign,
      appearance.textColor,
      appearance.textSize,
      viewportHeightPx,
    ],
  );
  const pagedViewportWidth =
    viewportWidth > 0
      ? viewportWidth
      : typeof window !== "undefined"
        ? window.innerWidth
        : 0;
  const pageColumnGap = appearance.padding * 2;
  const pageContentWidth = Math.max(
    1,
    pagedViewportWidth - appearance.padding * 2,
  );
  const pageColumnWidth = Math.max(
    1,
    Math.floor(
      pageColumnsPerSpread > 1
        ? (pageContentWidth - pageColumnGap) / pageColumnsPerSpread
        : pageContentWidth,
    ),
  );
  const pageStyle = useMemo<CSSProperties>(
    () =>
      isPagedReader
        ? ({
            "--norea-reader-page-column-width": `${pageColumnWidth}px`,
            columnFill: "auto",
            columnWidth: `${pageColumnWidth}px`,
            columnGap: `${pageColumnGap}px`,
            height: "100%",
            maxWidth: "none",
            overflowX: "auto",
            overflowY: "hidden",
          } as CSSProperties)
        : {
            maxWidth: "none",
            minHeight: "100%",
            margin: "0",
            width: "100%",
          },
    [isPagedReader, pageColumnGap, pageColumnWidth],
  );
  const contentBoxStyle = useMemo<CSSProperties>(
    () => ({
      ...contentStyle,
      ...pageStyle,
    }),
    [contentStyle, pageStyle],
  );
  const readerContentRuntimeCss = useMemo(() => {
    const pageDividerGradients =
      pageColumnsPerSpread > 1
        ? Array.from({ length: pageColumnsPerSpread - 1 }, (_, index) => {
            const dividerLeft =
              appearance.padding +
              (index + 1) * pageColumnWidth +
              index * pageColumnGap +
              pageColumnGap / 2;
            const start = Math.max(0, dividerLeft - 0.5);
            const end = dividerLeft + 0.5;
            return `linear-gradient(to right, transparent ${start}px, color-mix(in srgb, currentColor 28%, transparent) ${start}px, color-mix(in srgb, currentColor 28%, transparent) ${end}px, transparent ${end}px)`;
          }).join(",\n")
        : "";
    const readerMediaSelector = cssSelectorList(
      ".reader-content ",
      READER_PAGE_MEDIA_ELEMENTS,
    );
    const pagedMediaSelector = cssSelectorList(
      ".reader-viewport-paged .reader-content ",
      READER_PAGE_MEDIA_ELEMENTS,
    );
    const pagedAtomicMediaSelector = cssSelectorList(
      ".reader-viewport-paged .reader-content ",
      ["figure", "picture", ...READER_PAGE_MEDIA_ELEMENTS],
    );
    const autoMediaSelector = cssSelectorList(
      '.reader-viewport-paged .reader-content[data-image-paging="auto"] ',
      READER_PAGE_MEDIA_ELEMENTS,
    );
    const nextPageMediaSelector = cssSelectorList(
      '.reader-viewport-paged .reader-content[data-image-paging="next-page"] ',
      READER_PAGE_MEDIA_ELEMENTS,
    );
    const nextPageFirstMediaSelector = [
      cssSelectorList(
        '.reader-viewport-paged .reader-content[data-image-paging="next-page"] > ',
        READER_PAGE_MEDIA_ELEMENTS,
        ":first-child",
      ),
      cssSelectorList(
        '.reader-viewport-paged .reader-content[data-image-paging="next-page"] > :first-child ',
        READER_PAGE_MEDIA_ELEMENTS,
      ),
    ].join(",\n");
    const singleImageFlowSelector = cssSelectorList(
      '.reader-viewport-paged .reader-content[data-image-paging="single-image"] > ',
      READER_PAGE_SINGLE_FLOW_ELEMENTS,
    );
    const singleImageMediaSelector = cssSelectorList(
      '.reader-viewport-paged .reader-content[data-image-paging="single-image"] ',
      READER_PAGE_SINGLE_MEDIA_ELEMENTS,
    );
    const singleImageFirstMediaSelector = [
      cssSelectorList(
        '.reader-viewport-paged .reader-content[data-image-paging="single-image"] > ',
        READER_PAGE_SINGLE_MEDIA_ELEMENTS,
        ":first-child",
      ),
      cssSelectorList(
        '.reader-viewport-paged .reader-content[data-image-paging="single-image"] > :first-child ',
        READER_PAGE_SINGLE_MEDIA_ELEMENTS,
        ":first-child",
      ),
    ].join(",\n");
    const singleImageLastMediaSelector = [
      cssSelectorList(
        '.reader-viewport-paged .reader-content[data-image-paging="single-image"] > ',
        READER_PAGE_SINGLE_MEDIA_ELEMENTS,
        ":last-child",
      ),
      cssSelectorList(
        '.reader-viewport-paged .reader-content[data-image-paging="single-image"] > :last-child ',
        READER_PAGE_SINGLE_MEDIA_ELEMENTS,
        ":last-child",
      ),
    ].join(",\n");
    const fragmentMediaSelector = cssSelectorList(
      '.reader-viewport-paged .reader-content[data-image-paging="fragment"] ',
      READER_PAGE_MEDIA_ELEMENTS,
    );

    return `
          ${readerMediaSelector} {
            max-width: 100%;
            height: auto;
          }
          ${pagedMediaSelector} {
            max-height: var(--norea-reader-page-media-max-height);
            object-fit: contain;
          }
          ${pagedAtomicMediaSelector} {
            break-inside: avoid;
            page-break-inside: avoid;
          }
          .reader-content,
          .reader-viewport-scroll,
          .reader-content [data-norea-reader-virtual-canvas],
          .reader-content [data-norea-reader-virtual-window] {
            overflow-anchor: none;
          }
          ${autoMediaSelector} {
            break-inside: avoid;
            page-break-inside: avoid;
          }
          ${nextPageMediaSelector} {
            break-before: column;
            break-inside: avoid;
            page-break-inside: avoid;
          }
          ${nextPageFirstMediaSelector} {
            break-before: auto;
          }
          ${singleImageFlowSelector} {
            break-inside: auto !important;
            page-break-inside: auto !important;
          }
          ${singleImageMediaSelector} {
            break-before: column !important;
            break-after: column !important;
            break-inside: avoid !important;
            page-break-before: always !important;
            page-break-after: always !important;
            page-break-inside: avoid !important;
          }
          ${singleImageFirstMediaSelector} {
            break-before: auto !important;
            page-break-before: auto !important;
          }
          ${singleImageLastMediaSelector} {
            break-after: auto !important;
            page-break-after: auto !important;
          }
          ${fragmentMediaSelector} {
            break-inside: auto;
            page-break-inside: auto;
          }
          .reader-content p {
            margin-block: ${removeExtraParagraphSpacing ? "0.65em" : "1em"};
          }
          .reader-viewport-paged .reader-content p {
            -webkit-column-break-inside: avoid;
            break-inside: avoid;
            page-break-inside: avoid;
          }
          .reader-content strong {
            font-weight: 800;
          }
          .reader-viewport-paged.reader-viewport-multi-page .reader-content .reader-epub-content,
          .reader-viewport-paged.reader-viewport-multi-page .reader-content .reader-epub-section,
          .reader-viewport-paged.reader-viewport-multi-page .reader-content .reader-epub-body,
          .reader-viewport-paged.reader-viewport-multi-page .reader-content .reader-epub-body > .body {
            box-sizing: border-box;
            max-width: var(--norea-reader-page-column-width) !important;
            width: var(--norea-reader-page-column-width) !important;
          }
          .reader-viewport-paged.reader-viewport-multi-page::after {
            content: none;
          }
          .reader-viewport-paged.reader-viewport-multi-page .reader-content {
            background-attachment: local;
            background-image: ${pageDividerGradients};
            background-repeat: repeat-x;
            background-size: ${pagedViewportWidth}px 100%;
          }
          .reader-viewport-paged {
            overscroll-behavior-x: contain;
          }
          .reader-viewport-paged .reader-content {
            scrollbar-width: none;
          }
          .reader-viewport-paged[data-paged-renderer="columns"] .reader-content {
            scroll-snap-type: x mandatory;
          }
          .reader-viewport-paged .reader-content::-webkit-scrollbar {
            display: none;
          }
        `;
  }, [
    appearance.padding,
    removeExtraParagraphSpacing,
    pageColumnGap,
    pageColumnWidth,
    pageColumnsPerSpread,
    pagedViewportWidth,
  ]);

  return { contentBoxStyle, readerContentRuntimeCss };
}
