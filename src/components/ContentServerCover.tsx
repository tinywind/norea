import { useQuery } from "@tanstack/react-query";
import { serverCoverSource, type ServerWorkSummary } from "../lib/content-sync/browse";
import { ConsoleCover } from "./ConsolePrimitives";

export function ContentServerCover({ server, token, work }: { server: string; token: string; work: ServerWorkSummary }) {
  const cover = useQuery({
    queryKey: ["content-server", server, "cover", work.id, work.sequence],
    queryFn: ({ signal }) => serverCoverSource(server, token, work.id, signal),
    enabled: work.hasCover,
    staleTime: Infinity,
    retry: false,
  });
  return <ConsoleCover alt={work.novel.name} src={cover.data ?? null} height={152} width={104} />;
}
