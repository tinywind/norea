import { expect, it } from "vitest";
import type { SourceAccessBlock, TaskRecord } from "./scheduler";
import { SourceAccessNotificationTracker } from "./source-access-notifications";

const block: SourceAccessBlock = { sourceId: "source-a", scopeKey: "plugin:source-a:site:source.test", revision: 1, detectedAt: 1, verificationRequested: false, challenge: { kind: "captcha", url: "https://source.test/chapter" } };
const task: TaskRecord = { id: "restored", kind: "chapter.download", lane: "source", priority: "background", title: "Chapter", status: "queued", createdAt: 1, canCancel: true, canRetry: false, source: { id: "source-a", name: "Source A" } };

it("refreshes a persisted challenge label when restored jobs supply its source name", () => {
  const tracker = new SourceAccessNotificationTracker({records:[]});
  const previous = tracker.revision([block]);
  tracker.update({task});
  expect(tracker.revision([block])).not.toBe(previous);
  const t = ((key: string, params?: Record<string, string | number>) => `${key}:${params?.source ?? ""}`) as Parameters<SourceAccessNotificationTracker["notifications"]>[1];
  expect(tracker.notifications([block], t)[0]?.title).toContain("Source A");
});

it("keeps challenge presentation stable for progress-only changes", () => {
  const tracker = new SourceAccessNotificationTracker({records:[task]});
  const previous = tracker.revision([block]);
  expect(tracker.update({task:{...task,progress:{current:8,total:10}}})).toBe(false);
  expect(tracker.revision([block])).toBe(previous);
});
