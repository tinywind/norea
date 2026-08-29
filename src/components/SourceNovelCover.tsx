import { useEffect, useState } from "react";
import { resolveOrCacheSourceNovelCover } from "../lib/novel-cover-storage";
import type { NovelItem, Plugin } from "../lib/plugins/types";
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
  const [source, setSource] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSource(null);
    if (!plugin) return;

    void resolveOrCacheSourceNovelCover(plugin, item)
      .then((resolved) => {
        if (!cancelled) setSource(resolved);
      })
      .catch(() => {
        if (!cancelled) setSource(null);
      });

    return () => {
      cancelled = true;
    };
  }, [item.cover, item.name, item.path, plugin]);

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
