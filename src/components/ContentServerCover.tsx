import { useQuery } from "@tanstack/react-query";
import { findNovelBySource } from "../db/queries/novel";
import { useNovelCoverSource } from "../lib/use-novel-cover-source";
import { ConsoleCover } from "./ConsolePrimitives";
import type { ServerCatalogWork } from "./content-server-catalog";

export function ContentServerCover({ work }: { work: ServerCatalogWork }) {
  const { pluginId, novelPath } = work.identity;
  const { data: novel } = useQuery({
    queryKey: ["content-server-novel", pluginId, novelPath, work.sequence],
    queryFn: () => findNovelBySource(pluginId, novelPath),
  });
  const source = useNovelCoverSource(novel ?? {
    id: 0, pluginId, path: novelPath, name: work.name, cover: null,
  });
  return <ConsoleCover alt={work.name} src={source} />;
}
