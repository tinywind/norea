import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./settings/DownloadsSection", () => ({ chooseStorageFolder: vi.fn() }));
vi.mock("../lib/backup/auto-backup", () => ({ runAutomaticBackupIfDue: vi.fn() }));

import { useAutoBackupStore } from "../store/auto-backup";
import { BackupFolderAttention } from "./BackupFolderAttention";

function render(): string {
  return renderToStaticMarkup(
    <MantineProvider>
      <QueryClientProvider client={new QueryClient()}>
        <BackupFolderAttention />
      </QueryClientProvider>
    </MantineProvider>,
  );
}

describe("BackupFolderAttention", () => {
  beforeEach(() => {
    useAutoBackupStore.setState({ schedule: "weekly", lastFailureFolderUnavailable: false });
  });

  it("shows one line with Choose folder while backups cannot reach the folder", () => {
    useAutoBackupStore.setState({ lastFailureFolderUnavailable: true });
    const html = render();
    expect(html).toContain("Backup folder unavailable");
    expect(html).toContain("Choose folder");
  });

  it("stays hidden for other failures and when automatic backup is off", () => {
    expect(render()).not.toContain("Backup folder unavailable");
    useAutoBackupStore.setState({ schedule: "off", lastFailureFolderUnavailable: true });
    expect(render()).not.toContain("Backup folder unavailable");
  });
});
