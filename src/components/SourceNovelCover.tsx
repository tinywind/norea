import type { NovelItem, Plugin } from "../lib/plugins/types";
import { useNovelCoverSource } from "../lib/use-novel-cover-source";
import { ConsoleCover } from "./ConsolePrimitives";

interface SourceNovelCoverProps {
  className?: string;
  height?: number | string;
  item: Pick<NovelItem, "cover" | "name" | "path">;
  plugin: Plugin | null | undefined;
  width?: number | string;
}

export function SourceNovelCover({
  className,
  height,
  item,
  plugin,
  width,
}: SourceNovelCoverProps) {
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

  return (
    <ConsoleCover
      alt={item.name}
      className={className}
      height={height}
      src={source}
      width={width}
    />
  );
}
