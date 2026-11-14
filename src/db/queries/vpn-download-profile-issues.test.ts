import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import type {
  VpnDownloadProfileIssue,
  VpnDownloadProfileIssueInput,
} from "../../lib/tasks/vpn-download-types";
import { createTauriInvokeRouter } from "../../test/mock-tauri-invoke";
import {
  listVpnDownloadProfileIssues,
  reallowVpnDownloadProfile,
  recordVpnDownloadProfileIssue,
} from "./vpn-download-profile-issues";

const invokeMock = vi.mocked(invoke);
const router = createTauriInvokeRouter();

const sampleInput: VpnDownloadProfileIssueInput = {
  batchId: "batch-1",
  ip: "192.0.2.1",
  profileId: "profile-a",
  profileHash: "a".repeat(64),
  planId: "plan-1",
  rangeId: "lane-a",
  generation: 2,
  cause: "captcha",
};

const sampleIssue: VpnDownloadProfileIssue = {
  ...sampleInput,
  recordedAt: 1700000000000,
  excluded: true,
  revision: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  router.reset();
  router.installOn(invokeMock);
});

describe("listVpnDownloadProfileIssues", () => {
  it("queries all profile issues when batchId is omitted", async () => {
    router.mockQuery("db_vpn_profile_issue_list", [sampleIssue]);

    await expect(listVpnDownloadProfileIssues()).resolves.toEqual([
      sampleIssue,
    ]);
    expect(router.calls).toEqual([
      {
        command: "db_vpn_profile_issue_list",
        args: undefined,
        options: undefined,
      },
    ]);
  });

  it("filters profile issues by batchId when provided", async () => {
    router.mockQuery("db_vpn_profile_issue_list", [sampleIssue]);

    await expect(listVpnDownloadProfileIssues("batch-1")).resolves.toEqual([
      sampleIssue,
    ]);
    expect(router.calls).toEqual([
      {
        command: "db_vpn_profile_issue_list",
        args: { batchId: "batch-1" },
        options: undefined,
      },
    ]);
  });
});

describe("recordVpnDownloadProfileIssue and reallowVpnDownloadProfile", () => {
  it("clones input and delegates issue recording to db_vpn_profile_issue_record", async () => {
    router.mockMutation("db_vpn_profile_issue_record", sampleIssue);

    const mutableInput = { ...sampleInput };
    await expect(
      recordVpnDownloadProfileIssue(mutableInput),
    ).resolves.toEqual(sampleIssue);
    mutableInput.cause = "cloudflare";

    expect(router.calls).toEqual([
      {
        command: "db_vpn_profile_issue_record",
        args: { input: sampleInput },
        options: undefined,
      },
    ]);
  });

  it("delegates CAS reallow to db_vpn_profile_issue_reallow", async () => {
    const reallowed: VpnDownloadProfileIssue = {
      ...sampleIssue,
      excluded: false,
      revision: 2,
    };
    router.mockMutation("db_vpn_profile_issue_reallow", reallowed);

    await expect(
      reallowVpnDownloadProfile("batch-1", "192.0.2.1", 1),
    ).resolves.toEqual(reallowed);
    expect(router.calls).toEqual([
      {
        command: "db_vpn_profile_issue_reallow",
        args: { batchId: "batch-1", ip: "192.0.2.1", expectedRevision: 1 },
        options: undefined,
      },
    ]);
  });
});
