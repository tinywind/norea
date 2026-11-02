import { useRef, useState } from "react";
import { Alert, Group, NumberInput, Progress, Select, Stack, Text } from "@mantine/core";
import { useTranslation, type TranslationKey } from "../i18n";
import { describeError } from "../lib/errors";
import type { SavedVpnProfile } from "../lib/plugin-vpn-profiles";
import type { VpnDownloadDraftWork, VpnDownloadRuntimeSnapshot } from "../lib/tasks/vpn-download-drafts";
import { planVpnDownloadRanges, type VpnDownloadRangeAssignment } from "../lib/tasks/vpn-download-ranges";
import type { VpnDownloadRangeState } from "../lib/tasks/vpn-download-types";
import { useVpnDownloadStore } from "../store/vpn-download";
import { SettingsInlineControls, SettingsSection } from "./SettingsPrimitives";
import { TextButton } from "./TextButton";

export interface VpnDownloadProfileOption {
  profile: SavedVpnProfile;
  unavailableReason: string | null;
}

export interface VpnDownloadRangeActions {
  startDraft: (draftId: string, assignments: readonly VpnDownloadRangeAssignment[]) => Promise<void>;
  cancelDraft: (draftId: string) => void;
  resumeRange: (planId: string, rangeId: string, restartPass?: boolean) => Promise<void>;
  pauseRange: (planId: string, rangeId: string) => Promise<void>;
  cancelRange: (planId: string, rangeId: string) => Promise<void>;
  openVerification: (planId: string, rangeId: string) => Promise<void>;
}

interface DraftInterval {
  profileId: string;
  start: number | string;
  end: number | string;
}

const PHASE_KEYS: Record<VpnDownloadRangeState["phase"], TranslationKey> = {
  paused: "vpnDownload.phase.paused", connecting: "vpnDownload.phase.connecting", running: "vpnDownload.phase.running",
  completed: "vpnDownload.phase.completed", cancelled: "vpnDownload.phase.cancelled",
};

const PAUSE_KEYS: Record<string, TranslationKey> = {
  "profiles-exhausted": "vpnDownload.reason.exhausted", "profile-unavailable": "vpnDownload.reason.unavailable",
  "profile-in-use": "vpnDownload.reason.inUse", interrupted: "vpnDownload.reason.interrupted", offline: "network.waiting",
  "challenge-captcha": "vpnDownload.reason.captcha", "challenge-cloudflare": "vpnDownload.reason.cloudflare",
  "manual-verification": "vpnDownload.reason.verification", "verification-unavailable": "vpnDownload.reason.verificationUnavailable",
  "authentication-required": "vpnDownload.reason.authentication", "download-failed": "vpnDownload.reason.downloadFailed",
  "runtime-error": "vpnDownload.reason.runtimeError", "user-paused": "vpnDownload.userPaused",
  "automatic-off": "vpnDownload.reason.off", cancelled: "vpnDownload.phase.cancelled",
};

function draftErrorKey(error: unknown): TranslationKey {
  const message = describeError(error).toLowerCase();
  if (message.includes("overlap")) return "vpnDownload.invalidOverlap";
  if (message.includes("unassigned")) return "vpnDownload.invalidUnassigned";
  if (message.includes("reversed")) return "vpnDownload.invalidReversed";
  if (message.includes("profile")) return "vpnDownload.invalidProfiles";
  return "vpnDownload.invalidDraft";
}

export function VpnDownloadRanges({ snapshot, profiles, profilesReady, actions }: {
  snapshot: VpnDownloadRuntimeSnapshot;
  profiles: readonly VpnDownloadProfileOption[];
  profilesReady: boolean;
  actions: VpnDownloadRangeActions;
}) {
  const { t } = useTranslation();
  const mode = useVpnDownloadStore(state => state.mode);
  const workerCount = useVpnDownloadStore(state => state.workerCount);
  const [edits, setEdits] = useState<Record<string, DraftInterval[]>>({});
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const pending = useRef(new Set<string>());
  const { capabilities } = snapshot;
  const modeSupported = capabilities.supported && capabilities.maxWorkers >= 1 && mode !== "off" &&
    (mode !== "parallel" || (capabilities.parallelSupported && workerCount <= capabilities.maxWorkers));
  const availableIds = profiles.filter(option => !option.unavailableReason).map(option => option.profile.id);
  const profileData = profiles.map(({ profile, unavailableReason }) => ({
    value: profile.id,
    label: `${profile.ip} · ${profile.protocol.toUpperCase()}${unavailableReason ? ` (${unavailableReason})` : ""}`,
    disabled: Boolean(unavailableReason),
  }));

  async function run(key: string, action: () => unknown | Promise<unknown>): Promise<void> {
    if (pending.current.has(key)) return;
    pending.current.add(key);
    setPendingKeys(new Set(pending.current));
    setErrors(current => ({ ...current, [key]: null }));
    try {
      await action();
    } catch (error) {
      setErrors(current => ({ ...current, [key]: describeError(error) }));
    } finally {
      pending.current.delete(key);
      setPendingKeys(new Set(pending.current));
    }
  }

  function renderDraft(draft: VpnDownloadDraftWork) {
    const key = JSON.stringify(["draft", draft.id]);
    const errorId = `vpn-draft-${encodeURIComponent(draft.id)}-error`;
    const editKey = JSON.stringify([draft.id, mode, workerCount]);
    const busy = pendingKeys.has(key);
    const positions = new Map(draft.chapters.map((chapter, index) => [chapter.id, index + 1]));
    let first = draft.chapters.length;
    let last = 0;
    for (const id of draft.selectedChapterIds) {
      const position = positions.get(id);
      if (position !== undefined) { first = Math.min(first, position); last = Math.max(last, position); }
    }
    const required = Math.min(Math.max(1, last - first + 1), mode === "parallel" ? workerCount : 1);
    let validationError: string | null = draft.error;
    let defaults: DraftInterval[] = [];
    let assignments: VpnDownloadRangeAssignment[] | null = null;
    try {
      defaults = planVpnDownloadRanges(draft.chapters, draft.selectedChapterIds, availableIds.slice(0, required))
        .map(range => ({ profileId: range.profileId, start: positions.get(range.startChapterId)!, end: positions.get(range.endChapterId)! }));
    } catch (error) { validationError ??= t(draftErrorKey(error)); }
    const intervals = edits[editKey] ?? defaults;
    if (availableIds.length < required) validationError ??= t("vpnDownload.insufficientProfiles", { count: required });
    try {
      const requested = intervals.map(interval => {
        if (typeof interval.start !== "number" || typeof interval.end !== "number" ||
          !Number.isInteger(interval.start) || !Number.isInteger(interval.end) ||
          interval.start < 1 || interval.end < 1 || interval.start > draft.chapters.length || interval.end > draft.chapters.length) {
          throw new Error("invalid-position");
        }
        return { profileId: interval.profileId, startChapterId: draft.chapters[interval.start - 1]!.id, endChapterId: draft.chapters[interval.end - 1]!.id };
      });
      assignments = planVpnDownloadRanges(draft.chapters, draft.selectedChapterIds, availableIds, requested)
        .map(({ profileId, startChapterId, endChapterId }) => ({ profileId, startChapterId, endChapterId }));
    } catch (error) {
      validationError ??= t(describeError(error) === "invalid-position" ? "vpnDownload.invalidPosition" : draftErrorKey(error));
    }
    const canStart = !snapshot.loading && profilesReady && modeSupported && !busy && !validationError && assignments !== null;
    function edit(index: number, patch: Partial<DraftInterval>) {
      if (busy) return;
      setEdits(current => ({ ...current, [editKey]: intervals.map((interval, row) => row === index ? { ...interval, ...patch } : interval) }));
      setErrors(current => ({ ...current, [key]: null }));
    }
    function chapterLabel(position: number | string): string {
      const chapter = typeof position === "number" && Number.isInteger(position) ? draft.chapters[position - 1] : undefined;
      return chapter ? [chapter.chapterNumber ? `#${chapter.chapterNumber}` : null, chapter.name].filter(Boolean).join(" · ") : t("vpnDownload.invalidPosition");
    }
    return (
      <Stack key={draft.id} gap="sm" component="section" aria-label={draft.title}>
        <Text component="h3" size="sm" fw={600} style={{ overflowWrap: "anywhere" }}>{draft.title}</Text>
        <Text size="sm" c="dimmed">{t("vpnDownload.previewHint")}</Text>
        {intervals.map((interval, index) => (
          <Stack key={index} gap="xs">
            <Text size="sm" fw={500}>{t("vpnDownload.interval", { number: index + 1 })}</Text>
            <Group align="flex-start" grow gap="sm">
              <NumberInput label={t("vpnDownload.startPosition")} aria-label={t("vpnDownload.positionLabel", { boundary: t("vpnDownload.startPosition"), number: index + 1, title: draft.title })}
                aria-describedby={validationError ? errorId : undefined} style={{ minWidth: 0, overflowWrap: "anywhere" }}
                description={chapterLabel(interval.start)} min={1} max={draft.chapters.length} value={interval.start} allowDecimal={false} allowNegative={false}
                disabled={busy} onChange={value => edit(index, { start: value })} />
              <NumberInput label={t("vpnDownload.endPosition")} aria-label={t("vpnDownload.positionLabel", { boundary: t("vpnDownload.endPosition"), number: index + 1, title: draft.title })}
                aria-describedby={validationError ? errorId : undefined} style={{ minWidth: 0, overflowWrap: "anywhere" }}
                description={chapterLabel(interval.end)} min={1} max={draft.chapters.length} value={interval.end} allowDecimal={false} allowNegative={false}
                disabled={busy} onChange={value => edit(index, { end: value })} />
            </Group>
            <Text size="sm">{chapterLabel(interval.start)} / {chapterLabel(interval.end)}</Text>
            <Select label={t("vpnDownload.profile")} aria-label={t("vpnDownload.profileLabel", { number: index + 1, title: draft.title })}
              aria-describedby={validationError ? errorId : undefined}
              data={profileData} value={interval.profileId} allowDeselect={false} disabled={busy || !profilesReady}
              onChange={value => { if (value !== null) edit(index, { profileId: value }); }} />
          </Stack>
        ))}
        {validationError ? <Alert id={errorId} color="red" role="alert">{validationError}</Alert> : null}
        {errors[key] ? <Alert color="red" role="alert">{errors[key]}</Alert> : null}
        <SettingsInlineControls>
          <TextButton tone="accent" disabled={!canStart} loading={busy} onClick={() => {
            if (!canStart || !assignments) return;
            const accepted = assignments;
            return run(key, () => actions.startDraft(draft.id, accepted));
          }}>{t("vpnDownload.start")}</TextButton>
          <TextButton disabled={busy} onClick={() => run(key, () => actions.cancelDraft(draft.id))}>{t("vpnDownload.cancelDraft")}</TextButton>
        </SettingsInlineControls>
      </Stack>
    );
  }

  return (
    <>
      {snapshot.drafts.length ? <SettingsSection title={t("vpnDownload.drafts")}>{snapshot.drafts.map(renderDraft)}</SettingsSection> : null}
      {snapshot.plans.length ? (
        <SettingsSection title={t("vpnDownload.plans")}>
          <Stack gap="md">
            {snapshot.plans.map(plan => (
              <Stack key={plan.id} gap="sm">
                <Text component="h3" size="sm" fw={600} style={{ overflowWrap: "anywhere" }}>{plan.title}</Text>
                {plan.ranges.map(range => {
                  const key = JSON.stringify(["range", plan.id, range.id]);
                  const busy = pendingKeys.has(key);
                  const terminal = range.phase === "completed" || range.phase === "cancelled";
                  const exhausted = range.pauseReason === "profiles-exhausted";
                  const profile = profiles.find(option => option.profile.id === range.profileId)?.profile;
                  const label = (id: number) => snapshot.chapterLabels[plan.id]?.[id] ?? t("vpnDownload.chapterId", { id });
                  const interval = `${label(range.startChapterId)} / ${label(range.endChapterId)}`;
                  const currentId = range.selectedChapterIds[range.checkpoint];
                  const canResume = !busy && !snapshot.loading && mode !== "off" && capabilities.supported && capabilities.maxWorkers >= 1 &&
                    (plan.mode !== "parallel" || capabilities.parallelSupported);
                  const reasonKey = range.pauseReason ? PAUSE_KEYS[range.pauseReason] : undefined;
                  const actionLabel = (action: string) => t("vpnDownload.rangeAction", { action, title: plan.title, interval });
                  return (
                    <Stack key={range.id} gap="xs" data-vpn-range={range.id} component="section" aria-label={`${plan.title}: ${interval}`}>
                      <Group justify="space-between" gap="sm">
                        <Text size="sm" fw={500} style={{ overflowWrap: "anywhere", minWidth: 0 }}>{interval}</Text>
                        <Text size="sm">{t(PHASE_KEYS[range.phase])}</Text>
                      </Group>
                      <Text size="sm" style={{ overflowWrap: "anywhere" }}>{profile ? `${profile.ip} · ${profile.protocol.toUpperCase()}` : t("vpnDownload.profileMissing", { id: range.profileId })}</Text>
                      <Text size="sm" style={{ fontVariantNumeric: "tabular-nums" }}>{t("vpnDownload.progress", { completed: range.checkpoint, total: range.selectedChapterIds.length })}</Text>
                      <Progress aria-label={t("vpnDownload.progressLabel")} value={range.selectedChapterIds.length ? range.checkpoint / range.selectedChapterIds.length * 100 : 100} size="xs" />
                      {!terminal && currentId !== undefined ? <Text size="sm">{t("vpnDownload.currentChapter", { chapter: label(currentId) })}</Text> : null}
                      {range.pauseReason ? <Text size="sm" c="dimmed">{reasonKey ? t(reasonKey) : range.pauseReason}</Text> : null}
                      {range.userPaused ? <Text size="sm" c="dimmed">{t("vpnDownload.userPaused")}</Text> : null}
                      {!terminal ? (
                        <SettingsInlineControls>
                          {range.phase === "paused" ? (
                            <TextButton aria-label={actionLabel(t("vpnDownload.resume"))} disabled={!canResume || exhausted}
                              onClick={() => { if (canResume && !exhausted) return run(key, () => actions.resumeRange(plan.id, range.id)); }}>{t("vpnDownload.resume")}</TextButton>
                          ) : (
                            <TextButton aria-label={actionLabel(t("vpnDownload.pause"))} disabled={busy}
                              onClick={() => run(key, () => actions.pauseRange(plan.id, range.id))}>{t("vpnDownload.pause")}</TextButton>
                          )}
                          {exhausted && range.phase === "paused" ? (
                            <TextButton aria-label={actionLabel(t("vpnDownload.restartPass"))} disabled={!canResume}
                              onClick={() => { if (canResume) return run(key, () => actions.resumeRange(plan.id, range.id, true)); }}>{t("vpnDownload.restartPass")}</TextButton>
                          ) : null}
                          {range.challenge ? (
                            <TextButton aria-label={actionLabel(t("vpnDownload.openVerification"))} disabled={busy || !capabilities.supported}
                              onClick={() => { if (capabilities.supported) return run(key, () => actions.openVerification(plan.id, range.id)); }}>{t("vpnDownload.openVerification")}</TextButton>
                          ) : null}
                          <TextButton tone="danger" aria-label={actionLabel(t("vpnDownload.cancelRange"))} disabled={busy}
                            onClick={() => run(key, () => actions.cancelRange(plan.id, range.id))}>{t("vpnDownload.cancelRange")}</TextButton>
                        </SettingsInlineControls>
                      ) : null}
                      {errors[key] ? <Alert color="red" role="alert">{errors[key]}</Alert> : null}
                    </Stack>
                  );
                })}
              </Stack>
            ))}
          </Stack>
        </SettingsSection>
      ) : null}
    </>
  );
}
