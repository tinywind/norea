import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChapterDownloadJob } from "../../lib/tasks/chapter-download";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import {
  adoptOrdinaryChapterDownloadJobs,
  cancelPendingVpnDownloadBatch,
  cancelPendingVpnDownloadJobs,
  enqueuePendingVpnDownloadJobs,
  listOrdinaryChapterDownloadJobs,
  listPendingVpnDownloadJobs,
  setPendingVpnDownloadJobsPaused,
} from "./chapter-download-queue";

const mockedInvoke = vi.mocked(invoke);

function job(id: number): ChapterDownloadJob {
  return {
    id,
    pluginId: "source",
    novelId: 42,
    novelPath: "/work",
    chapterPath: `/${id}`,
    title: `Chapter ${id}`,
    batchId: "ordinary-batch",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("chapter-download-queue IPC boundary", () => {
  it("lists ordinary and pending VPN download jobs via typed Rust commands", async () => {
    const ordinaryRow = {
      job: job(1),
      jobJson: JSON.stringify(job(1)),
      updatedAtMs: 20,
    };
    const pendingRow = {
      job: { ...job(2), vpnBatchId: "run-a" },
      jobJson: JSON.stringify({ ...job(2), vpnBatchId: "run-a" }),
      updatedAtMs: 30,
    };
    mockedInvoke.mockResolvedValueOnce([ordinaryRow]);
    mockedInvoke.mockResolvedValueOnce([pendingRow]);

    await expect(listOrdinaryChapterDownloadJobs()).resolves.toEqual([
      ordinaryRow,
    ]);
    await expect(listPendingVpnDownloadJobs()).resolves.toEqual([pendingRow]);

    expect(mockedInvoke).toHaveBeenNthCalledWith(
      1,
      "db_download_queue_list_ordinary",
    );
    expect(mockedInvoke).toHaveBeenNthCalledWith(
      2,
      "db_download_queue_list_pending_vpn",
    );
  });

  it("validates batch ownership locally before invoking db_download_queue_enqueue_pending_vpn", async () => {
    await expect(
      enqueuePendingVpnDownloadJobs("   ", [job(1)]),
    ).rejects.toThrow(/batch identity/i);
    await expect(
      enqueuePendingVpnDownloadJobs("run-a", [
        { ...job(1), vpnBatchId: "another-run" },
      ]),
    ).rejects.toThrow(/another VPN owner/i);
    await expect(
      enqueuePendingVpnDownloadJobs("run-a", [
        { ...job(1), vpnPlanId: "plan-a", vpnRangeId: "range-a" },
      ]),
    ).rejects.toThrow(/another VPN owner/i);
    expect(mockedInvoke).not.toHaveBeenCalled();

    mockedInvoke.mockResolvedValueOnce({ value: null, effects: {} });
    await enqueuePendingVpnDownloadJobs("run-a", [job(1), job(2)]);
    expect(mockedInvoke).toHaveBeenCalledWith(
      "db_download_queue_enqueue_pending_vpn",
      {
        batchId: "run-a",
        jobs: [
          { ...job(1), vpnBatchId: "run-a" },
          { ...job(2), vpnBatchId: "run-a" },
        ],
      },
    );
  });

  it("validates captured ordinary ownership before adopting jobs in Rust", async () => {
    const valid = {
      job: job(1),
      jobJson: JSON.stringify(job(1)),
      updatedAtMs: 20,
    };
    const invalid = {
      job: { ...job(2), vpnBatchId: "run-b" },
      jobJson: JSON.stringify({ ...job(2), vpnBatchId: "run-b" }),
      updatedAtMs: 20,
    };
    await expect(
      adoptOrdinaryChapterDownloadJobs("run-a", [invalid]),
    ).rejects.toThrow(/ordinary ownership/i);
    expect(mockedInvoke).not.toHaveBeenCalled();

    const adopted = [{ ...job(1), vpnBatchId: "run-a" }];
    mockedInvoke.mockResolvedValueOnce({ value: adopted, effects: {} });
    await expect(
      adoptOrdinaryChapterDownloadJobs("run-a", [valid]),
    ).resolves.toEqual(adopted);
    expect(mockedInvoke).toHaveBeenCalledWith(
      "db_download_queue_adopt_ordinary",
      {
        batchId: "run-a",
        expected: [
          {
            chapterId: 1,
            jobJson: valid.jobJson,
            updatedAtMs: 20,
          },
        ],
      },
    );
  });

  it("deduplicates chapter IDs and delegates pause and cancellation to Rust", async () => {
    await expect(cancelPendingVpnDownloadJobs("run-a", [])).resolves.toBe(0);
    await expect(
      setPendingVpnDownloadJobsPaused("run-a", [], true),
    ).resolves.toBe(0);
    expect(mockedInvoke).not.toHaveBeenCalled();

    mockedInvoke.mockResolvedValueOnce({ value: 2, effects: {} });
    mockedInvoke.mockResolvedValueOnce({ value: 1, effects: {} });
    mockedInvoke.mockResolvedValueOnce({ value: 3, effects: {} });

    await expect(
      setPendingVpnDownloadJobsPaused("run-a", [1, 2, 1], true),
    ).resolves.toBe(2);
    await expect(
      cancelPendingVpnDownloadJobs("run-a", [2, 2]),
    ).resolves.toBe(1);
    await expect(cancelPendingVpnDownloadBatch("run-a")).resolves.toBe(3);

    expect(mockedInvoke).toHaveBeenNthCalledWith(
      1,
      "db_download_queue_set_pending_vpn_paused",
      { batchId: "run-a", chapterIds: [1, 2], paused: true },
    );
    expect(mockedInvoke).toHaveBeenNthCalledWith(
      2,
      "db_download_queue_cancel_pending_vpn_jobs",
      { batchId: "run-a", chapterIds: [2] },
    );
    expect(mockedInvoke).toHaveBeenNthCalledWith(
      3,
      "db_download_queue_cancel_pending_vpn_batch",
      { batchId: "run-a" },
    );
  });
});
