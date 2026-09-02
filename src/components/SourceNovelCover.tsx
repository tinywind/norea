import type { NovelItem, Plugin } from "../lib/plugins/types";
import { useNovelCoverSource } from "../lib/use-novel-cover-source";
import { useTranslation } from "../i18n";
import { LibraryAddedGlyph } from "./ActionGlyphs";
import { ConsoleCover } from "./ConsolePrimitives";

interface SourceNovelCoverProps {
  className?: string;
  height?: number | string;
  inLibrary?: boolean;
  item: Pick<NovelItem, "cover" | "name" | "path">;
  plugin: Plugin | null | undefined;
  width?: number | string;
}

export function SourceNovelCover({
  className,
  height,
  inLibrary = false,
  item,
  plugin,
  width,
}: SourceNovelCoverProps) {
  const { t } = useTranslation();
  const source = useNovelCoverSource(
    {
      cover: item.cover ?? null,
      id: 0,
      isLocal: false,
      name: item.name,
      path: item.path,
      pluginId: plugin?.id ?? "",
    },
    {
      allowSourceFallback: Boolean(plugin),
      plugin,
    },
  );

  const cover = (
    <ConsoleCover
      alt={item.name}
      className={className}
      height={height}
      src={source}
      width={width}
    />
  );

  if (!inLibrary) return cover;

  return (
    <span className="lnr-source-cover-frame">
      {cover}
      <span
        aria-label={t("novel.inLibrary")}
        className="lnr-source-library-mark"
        role="img"
        title={t("novel.inLibrary")}
      >
        <LibraryAddedGlyph />
      </span>
    </span>
  );
}
