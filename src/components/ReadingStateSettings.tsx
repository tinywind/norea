import { useEffect, useRef, useState } from "react";
import { Button, Group, Paper, ScrollArea, SimpleGrid, Stack, Switch, Text, TextInput } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { formatDateTimeForLocale, useTranslation, type AppLocale, type TranslationKey } from "../i18n";
import { describeError } from "../lib/errors";
import { ContentServerError } from "../lib/content-sync/client";
import { getUserStateStatus, resolveUserStateConflict, resumeUserStateAfterRestore, synchronizeUserState } from "../lib/user-state/sync";
import { subscribeUserStateLedgerChanges } from "../db/user-state";
import type { ResolveUserStateConflictInput, UserStateConflict, UserStateEntity, UserStateKind, UserStateValue, UserStateValueMap } from "../lib/user-state/types";
import { useContentSyncStore } from "../store/content-sync";
import { USER_STATE_IDLE_RUNTIME, useUserStateStore } from "../store/user-state";
import { SettingsFieldRow, SettingsInlineControls, SettingsSection } from "./SettingsPrimitives";
import { IconButton } from "./IconButton";
import { ConnectIcon, SyncIcon } from "./ui/icons";

type Translate = ReturnType<typeof useTranslation>["t"];

const multilineButtonStyles = {
  root: { height: "auto", minHeight: 36, maxWidth: "100%", paddingBlock: 8 },
  label: { whiteSpace: "normal", overflow: "visible", textAlign: "center" },
} as const;

const KIND_LABELS: Record<UserStateKind, TranslationKey> = {
  library: "userState.kind.library",
  category: "userState.kind.category",
  membership: "userState.kind.membership",
  reading: "userState.kind.reading",
  bookmark: "userState.kind.bookmark",
  resume: "userState.kind.resume",
  composition: "userState.kind.composition",
};

export function userStateEntityLabel(entity: UserStateEntity, t: Translate): string {
  const work = "work" in entity ? entity.work.name : "";
  const chapter = "chapter" in entity ? entity.chapter.name || entity.chapter.chapterPath : "";
  return [t(KIND_LABELS[entity.kind]), work, chapter].filter(Boolean).join(" · ");
}

export function userStateValueSummary(kind: UserStateKind, value: UserStateValue | null, t: Translate, locale: AppLocale): string {
  if (value === null) return t("userState.value.absent");
  switch (kind) {
    case "library":
      return t((value as UserStateValueMap["library"]).inLibrary ? "userState.value.inLibrary" : "userState.value.outOfLibrary");
    case "category": {
      const category = value as UserStateValueMap["category"];
      return t(category.deleted ? "userState.value.categoryDeleted" : "userState.value.category", { name: category.name, order: category.sort });
    }
    case "membership":
      return t((value as UserStateValueMap["membership"]).included ? "userState.value.inCategory" : "userState.value.outOfCategory");
    case "reading": {
      const reading = value as UserStateValueMap["reading"];
      return t("userState.value.reading", {
        progress: reading.progress,
        state: t(reading.unread ? "userState.value.unread" : "userState.value.read"),
        time: reading.readAt === null ? t("userState.value.noHistory") : formatDateTimeForLocale(locale, reading.readAt * 1000),
      });
    }
    case "bookmark":
      return t((value as UserStateValueMap["bookmark"]).bookmarked ? "userState.value.bookmarked" : "userState.value.unbookmarked");
    case "resume": {
      const resume = value as UserStateValueMap["resume"];
      if (resume.chapter === null) return t("userState.value.resumeCleared");
      return t("userState.value.resume", {
        chapter: resume.chapter.name || resume.chapter.chapterPath,
        position: resume.anchor === null ? t("userState.value.chapterPosition") : t("userState.value.progress", { progress: resume.anchor.progress }),
      });
    }
    case "composition": {
      const composition = (value as UserStateValueMap["composition"]).composition;
      if (!composition) return t("userState.value.noComposition");
      const included = composition.entries.filter(entry => entry.user.included).length;
      return t("userState.value.composition", { included, excluded: composition.entries.length - included });
    }
  }
}

function reasonLabel(reason: string, deferred: boolean, t: Translate): string {
  if (/category.*(?:name|collision)|name.*(?:conflict|collision)/i.test(reason)) return t("userState.reason.categoryName");
  if (/category.*(?:deleted|missing)/i.test(reason)) return t("userState.reason.categoryDeleted");
  if (/ownership/i.test(reason) || (/storage|body|composition/i.test(reason) && deferred)) return t("userState.reason.storage");
  if (/chapter|catalog|metadata|work.*(?:missing|unknown)|unresolved/i.test(reason) && deferred) return t("userState.reason.metadata");
  return t(deferred ? "userState.reason.deferred" : "userState.reason.conflict");
}

function CompositionDetails({ value }: { value: UserStateValueMap["composition"] }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(0);
  const composition = value.composition;
  if (!composition) return null;
  const entries = [...composition.entries].sort((a, b) =>
    Number(b.user.included) - Number(a.user.included) || a.user.order - b.user.order || a.id.localeCompare(b.id));
  const pageSize = 100;
  const pages = Math.max(1, Math.ceil(entries.length / pageSize));
  const current = Math.min(page, pages - 1);
  return (
    <details>
      <summary>{t("userState.composition.details")}</summary>
      <ScrollArea h={240} mt="xs" type="auto">
        <Stack gap="xs">
          {entries.slice(current * pageSize, (current + 1) * pageSize).map(entry => {
            const source = entry.sources[entry.primarySource]!;
            return (
              <Text key={entry.id} size="sm" style={{ overflowWrap: "anywhere" }}>
                {t(entry.user.included ? "userState.composition.included" : "userState.composition.excluded", {
                  order: entry.user.order, number: entry.user.chapterNumber || source.chapterNumber || "—",
                  name: entry.user.name || source.name,
                  source: [source.pluginId, source.novelId, source.sourceChapterId || source.chapterPath].join(" / "),
                })}
              </Text>
            );
          })}
        </Stack>
      </ScrollArea>
      {pages > 1 ? (
        <Group gap="xs" mt="xs">
          <Button variant="subtle" size="xs" disabled={current === 0} onClick={() => setPage(current - 1)}>{t("userState.previous")}</Button>
          <Text size="xs">{t("userState.page", { page: current + 1, total: pages })}</Text>
          <Button variant="subtle" size="xs" disabled={current + 1 === pages} onClick={() => setPage(current + 1)}>{t("userState.next")}</Button>
        </Group>
      ) : null}
    </details>
  );
}

function ConflictValue({ label, entity, value, deviceName }: {
  label: string; entity: UserStateEntity; value: UserStateValue | null; deviceName?: string;
}) {
  const { t, locale } = useTranslation();
  return (
    <Paper withBorder p="sm">
      <Stack gap="xs">
        <Text fw="var(--norea-weight-bold)" size="sm">{label}</Text>
        {deviceName ? <Text size="xs" c="dimmed">{deviceName}</Text> : null}
        <Text size="sm">{userStateValueSummary(entity.kind, value, t, locale)}</Text>
        {entity.kind === "composition" && value ? <CompositionDetails value={value as UserStateValueMap["composition"]} /> : null}
      </Stack>
    </Paper>
  );
}

function UserStateConflictCard({ conflict, busy, onResolve }: {
  conflict: UserStateConflict; busy: boolean; onResolve: (input: ResolveUserStateConflictInput) => void;
}) {
  const { t } = useTranslation();
  const category = conflict.entity.kind === "category" ? conflict.local as UserStateValueMap["category"] : null;
  const sharedCategory = conflict.shared?.entity.kind === "category"
    ? conflict.shared.value as UserStateValueMap["category"] : null;
  const needsCategory = category !== null || (conflict.entity.kind === "membership" && /category.*(?:deleted|missing)/i.test(conflict.reason));
  const [categoryName, setCategoryName] = useState(category?.name || sharedCategory?.name || conflict.categoryName || "");
  const nameCollision = /category.*(?:name|collision)|name.*(?:conflict|collision)/i.test(conflict.reason);
  const restoringCategory = (sharedCategory?.deleted === true || /category.*(?:deleted|missing)/i.test(conflict.reason)) && category?.deleted !== true;
  const nameRequired = needsCategory && category?.deleted !== true;
  const collidingCategoryName = conflict.shared?.entity.kind === "category"
    && conflict.entity.kind === "category"
    && conflict.shared.entity.categoryId !== conflict.entity.categoryId
    ? sharedCategory?.name
    : category?.name;
  const validName = !nameRequired || (categoryName.trim().length > 0 &&
    (!nameCollision || categoryName.trim() !== collidingCategoryName));
  const choose = (choice: "local" | "shared") => onResolve({
    conflictId: conflict.id, version: conflict.version, choice,
    ...(choice === "local" && nameRequired ? { categoryName: categoryName.trim() } : {}),
  });
  return (
    <Paper withBorder p="md">
      <Stack gap="sm">
        <Text fw="var(--norea-weight-bold)">{[userStateEntityLabel(conflict.entity, t), conflict.categoryName].filter(Boolean).join(" · ")}</Text>
        <Text size="sm">{reasonLabel(conflict.reason, false, t)}</Text>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <ConflictValue label={t("userState.local")} entity={conflict.entity} value={conflict.local} />
          <ConflictValue label={t("userState.shared")} entity={conflict.shared?.entity ?? conflict.entity}
            value={conflict.shared?.value ?? null} deviceName={conflict.shared?.deviceName} />
        </SimpleGrid>
        {nameRequired ? <TextInput label={t("userState.categoryName")} value={categoryName} disabled={busy}
          description={nameCollision ? t("userState.categoryNameHint") : undefined} maxLength={200}
          onChange={event => setCategoryName(event.currentTarget.value)} /> : null}
        {restoringCategory && conflict.entity.kind === "membership" ? (
          <Text size="sm">{t("userState.restoreCategoryMembershipDescription")}</Text>
        ) : null}
        <Group gap="sm">
          <Button styles={multilineButtonStyles} disabled={busy || !validName} onClick={() => choose("local")}>
            {t(restoringCategory ? conflict.entity.kind === "membership" ? "userState.restoreCategoryMembership" : "userState.restoreCategory" : "userState.keepLocal")}
          </Button>
          <Button styles={multilineButtonStyles} variant="default" disabled={busy} onClick={() => choose("shared")}>
            {t(restoringCategory ? "userState.acceptDeletion" : "userState.useShared")}
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}

export function ReadingStateSettings({ serverUrl }: { serverUrl: string }) {
  const { locale, t } = useTranslation();
  const deviceName = useContentSyncStore(state => state.deviceName);
  const enabled = useUserStateStore(state => state.enabledByServer[serverUrl] === true);
  const runtime = useUserStateStore(state => state.runtimeByServer[serverUrl] ?? USER_STATE_IDLE_RUNTIME);
  const setEnabled = useUserStateStore(state => state.setEnabled);
  const defaultName = useQuery({
    queryKey: ["device", "default-name"], queryFn: () => invoke<string>("get_default_device_name"),
    staleTime: Infinity, meta: { errorPresentation: "inline" },
  });
  const status = useQuery({
    queryKey: ["user-state", "status", serverUrl], queryFn: getUserStateStatus,
    retry: false,
    meta: { errorPresentation: "inline" },
  });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const action = useRef(false);
  const working = busy || runtime.phase === "syncing";
  useEffect(() => { if (serverUrl) void status.refetch(); }, [serverUrl, runtime.revision, status.refetch]);
  useEffect(() => {
    if (!serverUrl) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { timer = undefined; void status.refetch(); }, 150);
    };
    const focus = () => { void status.refetch(); };
    const visible = () => { if (document.visibilityState === "visible") focus(); };
    const unsubscribe = subscribeUserStateLedgerChanges(schedule);
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearTimeout(timer);
      unsubscribe();
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [serverUrl, status.refetch]);

  async function run(operation: () => Promise<void>) {
    if (action.current) return;
    action.current = true;
    setBusy(true); setActionError(null);
    try {
      await operation();
    } catch (cause) {
      setActionError(cause instanceof ContentServerError && cause.status === 403 ? t("contentSync.blocked") : describeError(cause));
    } finally {
      action.current = false; setBusy(false);
      await status.refetch();
    }
  }

  const data = status.data;
  const pausedAfterRestore = data?.pausedAfterRestore === true;
  const error = actionError || runtime.error || (status.error ? describeError(status.error) : null);
  return (
    <SettingsSection title={t("userState.title")} description={t("userState.description")}>
      <SettingsFieldRow label={t("userState.workspace")} description={t("userState.workspaceScope")}
        status={!serverUrl ? t("userState.serverRequired") : data?.workspaceId ? t("userState.connected") : t("userState.notConnected")}>
        <Text size="sm" style={{ overflowWrap: "anywhere" }}>{serverUrl}</Text>
      </SettingsFieldRow>
      <SettingsFieldRow label={t("userState.thisDevice")}>
        <Text size="sm">{deviceName || defaultName.data || t("common.loading")}</Text>
      </SettingsFieldRow>
      {pausedAfterRestore ? (
        <Paper withBorder p="md" role="status">
          <Stack gap="sm">
            <Text fw="var(--norea-weight-bold)">{t("userState.restorePaused")}</Text>
            <Text size="sm">{t("userState.restorePausedDescription")}</Text>
            <Text size="sm">{t("userState.restoreMergeDescription")}</Text>
            <Text size="sm">{t("userState.restoreOverwriteDescription")}</Text>
            <Text size="sm">{t("userState.restoreSnapshotDescription")}</Text>
            <Button styles={multilineButtonStyles} leftSection={<ConnectIcon />} variant="default" loading={working} disabled={!serverUrl || working}
              onClick={() => { void run(resumeUserStateAfterRestore); }}>
              {t("userState.reconnectAfterRestore")}
            </Button>
          </Stack>
        </Paper>
      ) : null}
      <SettingsFieldRow label={t("userState.automatic")} description={t("userState.automaticDescription")}>
        <Switch checked={enabled} disabled={!serverUrl || pausedAfterRestore} aria-label={t("userState.automatic")}
          onChange={event => setEnabled(serverUrl, event.currentTarget.checked)} />
      </SettingsFieldRow>
      <SettingsFieldRow label={t("userState.syncNow")} description={t(pausedAfterRestore ? "userState.restorePaused" : "userState.offDescription")} error={error}
        status={pausedAfterRestore ? t("userState.restorePaused") : working ? t("userState.syncing") : data?.lastSuccessAt ? t("userState.lastSuccess", {
          time: formatDateTimeForLocale(locale, data.lastSuccessAt),
        }) : t("userState.never")}>
        <SettingsInlineControls>
          <IconButton label={t("userState.syncNow")} size="lg" loading={working} disabled={!serverUrl || working || pausedAfterRestore}
            onClick={() => { void run(synchronizeUserState); }}><SyncIcon /></IconButton>
        </SettingsInlineControls>
      </SettingsFieldRow>
      {data ? (
        <SettingsFieldRow label={t("userState.status")} layout="stacked">
          <Stack gap="sm">
            <Text size="sm" role="status">{t("userState.counts", {
              pending: data.pending, conflicts: data.conflicts.length,
            })}</Text>
            <Text size="sm" c={data.projectionFailed ? "danger" : "dimmed"}>
              {t("userState.projectionCounts", {
                pending: data.projectionPending ?? 0, parked: data.projectionParked ?? 0, failed: data.projectionFailed ?? 0,
              })}
            </Text>
            {data.conflicts.length ? <Text size="sm">{t("userState.conflictsDescription")}</Text> : null}
            {data.conflicts.map(conflict => (
              <UserStateConflictCard key={conflict.id + ":" + conflict.version} conflict={conflict} busy={working || pausedAfterRestore}
                onResolve={input => { void run(() => resolveUserStateConflict(input)); }} />
            ))}
          </Stack>
        </SettingsFieldRow>
      ) : null}
    </SettingsSection>
  );
}
