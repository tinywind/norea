import { Button, Checkbox, Group, Stack, Text, TextInput, Title } from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { ChipButton } from "../components/ChipButton";
import { IconButton } from "../components/IconButton";
import { PageFrame, PageHeader, StateView } from "../components/AppFrame";
import { addPluginRepository } from "../components/browse/use-plugin-catalog";
import { DeselectIcon, SelectAllIcon } from "../components/ui/icons";
import { formatPluginLanguageForLocale, useTranslation } from "../i18n";
import { usePageBackNavigation } from "../lib/android-back-navigation";
import { describeError } from "../lib/errors";
import {
  initialSetupLanguages,
  setupLanguages,
  suggestedSetupSources,
} from "../lib/first-run-setup";
import { pluginManager } from "../lib/plugins/manager";
import type { PluginItem } from "../lib/plugins/types";
import { enqueueMainTask } from "../lib/tasks/main-tasks";
import { useBrowseStore } from "../store/browse";
import { useSetupStore } from "../store/setup";
import "../styles/setup.css";

type SetupStep = "repository" | "languages" | "sources" | "done";

const STEP_NUMBERS: Record<Exclude<SetupStep, "done">, number> = {
  repository: 1,
  languages: 2,
  sources: 3,
};

interface InstallOutcome {
  failed: string[];
  installed: number;
}

/**
 * RD9 first-run setup: add a repository, pick reading languages, install the
 * suggested sources, done. Skip on any step records "skipped" so it never
 * returns; Extensions keeps a "Set up sources" entry for later.
 */
export function SetupPage() {
  const { locale, t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const setSetupState = useSetupStore((state) => state.setSetupState);
  const pendingRepoUrl = useBrowseStore((state) => state.pendingRepoUrl);
  const clearPendingRepoUrl = useBrowseStore((state) => state.clearPendingRepoUrl);
  const [step, setStep] = useState<SetupStep>("repository");
  const [url, setUrl] = useState("");
  const [items, setItems] = useState<PluginItem[]>([]);
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [languages, setLanguages] = useState<string[]>([]);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [outcome, setOutcome] = useState<InstallOutcome | null>(null);

  useEffect(() => {
    if (pendingRepoUrl === null) return;
    setUrl(pendingRepoUrl);
    clearPendingRepoUrl();
  }, [clearPendingRepoUrl, pendingRepoUrl]);

  const availableLanguages = useMemo(() => setupLanguages(items, locale), [items, locale]);
  const suggestions = useMemo(() => suggestedSetupSources(items, languages), [items, languages]);
  const selected = suggestions.filter((item) => selectedIds.has(item.id));

  const addRepository = useMutation({
    meta: { errorPresentation: "inline" },
    mutationFn: (repositoryUrl: string) =>
      enqueueMainTask({
        kind: "repository.add",
        run: async () => (await addPluginRepository(repositoryUrl)).items,
        subject: { url: repositoryUrl },
        title: t("extensions.repositories.add"),
      }).promise,
    onSuccess: (fetched, added) => {
      void queryClient.invalidateQueries({ queryKey: ["repository"] });
      void queryClient.invalidateQueries({ queryKey: ["plugin", "available"] });
      setRepositoryUrl(added);
      setItems(fetched);
      setLanguages(initialSetupLanguages(fetched, locale));
      setStep("languages");
    },
  });

  const installSelected = useMutation({
    mutationFn: async (targets: readonly PluginItem[]): Promise<InstallOutcome> => {
      const failed: string[] = [];
      let installed = 0;
      for (const [index, item] of targets.entries()) {
        setProgress({ current: index + 1, total: targets.length });
        try {
          await enqueueMainTask({
            kind: "plugin.install",
            run: () => pluginManager.installPlugin(item, repositoryUrl),
            subject: { pluginId: item.id, url: item.url },
            title: t("tasks.task.installPlugin", { name: item.name }),
          }).promise;
          installed += 1;
        } catch {
          failed.push(item.name);
        }
      }
      return { failed, installed };
    },
    onSettled: () => {
      setProgress(null);
      void queryClient.invalidateQueries({ queryKey: ["plugin"] });
    },
    onSuccess: (result) => {
      setOutcome(result);
      setStep("done");
    },
  });

  const skip = () => {
    setSetupState("skipped");
    void navigate({ to: "/", replace: true });
  };
  const finish = () => {
    setSetupState("done");
    void navigate({ to: "/browse", search: { q: "", tab: "search" }, replace: true });
  };
  const goToSources = () => {
    setSelectedIds(new Set(suggestedSetupSources(items, languages).map((item) => item.id)));
    setStep("sources");
  };

  const previousStep: SetupStep | null =
    step === "languages" ? "repository" : step === "sources" ? "languages" : null;

  usePageBackNavigation(() => {
    if (installSelected.isPending) return true;
    if (previousStep === null) return false;
    setStep(previousStep);
    return true;
  });

  const stepNumber = step === "done" ? null : STEP_NUMBERS[step];

  return (
    <>
      <PageHeader
        actions={
          step === "done" ? null : (
            <>
              {stepNumber === null ? null : (
                <span className="norea-app-bar-meta">
                  {t("setup.step", { current: stepNumber, total: 3 })}
                </span>
              )}
              <Button disabled={installSelected.isPending} onClick={skip} variant="subtle">
                {t("setup.skip")}
              </Button>
            </>
          )
        }
        backDisabled={installSelected.isPending}
        onBack={previousStep === null ? undefined : () => setStep(previousStep)}
        title={t("setup.entry")}
        titleElement="span"
      />
      <PageFrame className="norea-setup-page" size="narrow">

        {step === "repository" ? (
          <form
            className="norea-setup-body"
            onSubmit={(event) => {
              event.preventDefault();
              const trimmed = url.trim();
              if (trimmed) addRepository.mutate(trimmed);
            }}
          >
            <Title className="norea-setup-title" order={1}>{t("setup.repository.title")}</Title>
            <Text className="norea-setup-copy">{t("setup.repository.description")}</Text>
            <TextInput
              autoFocus
              label={t("browse.repositoryUrl")}
              onChange={(event) => setUrl(event.currentTarget.value)}
              placeholder={t("browse.repositoryUrlPlaceholder")}
              type="url"
              value={url}
            />
            {addRepository.error ? (
              <StateView
                color="danger"
                details={{ content: describeError(addRepository.error), label: t("common.details") }}
                title={t("setup.repository.failed")}
              />
            ) : null}
            <Group justify="flex-end">
              <Button disabled={url.trim() === ""} loading={addRepository.isPending} type="submit">
                {t("setup.repository.add")}
              </Button>
            </Group>
          </form>
        ) : null}

        {step === "languages" ? (
          <div className="norea-setup-body">
            <Title className="norea-setup-title" order={1}>{t("setup.languages.title")}</Title>
            <Text className="norea-setup-copy">{t("setup.languages.description")}</Text>
            {availableLanguages.length === 0 ? (
              <StateView title={t("setup.sources.empty")} />
            ) : (
              <div aria-label={t("setup.languages.title")} className="norea-browse-chips" role="group">
                {availableLanguages.map((lang) => {
                  const active = languages.includes(lang);
                  return (
                    <ChipButton
                      key={lang}
                      onClick={() =>
                        setLanguages((current) =>
                          active ? current.filter((entry) => entry !== lang) : [...current, lang],
                        )
                      }
                      selected={active}
                    >
                      {formatPluginLanguageForLocale(locale, lang)}
                    </ChipButton>
                  );
                })}
              </div>
            )}
            <Group justify="space-between">
              <Button onClick={() => setStep("repository")} variant="default">
                {t("common.back")}
              </Button>
              <Button disabled={languages.length === 0} onClick={goToSources}>
                {t("setup.continue")}
              </Button>
            </Group>
          </div>
        ) : null}

        {step === "sources" ? (
          <div className="norea-setup-body">
            <Title className="norea-setup-title" order={1}>{t("setup.sources.title")}</Title>
            {suggestions.length === 0 ? (
              <StateView title={t("setup.sources.empty")} />
            ) : (
              <>
                <Text className="norea-setup-copy">
                  {t("setup.sources.description", { count: suggestions.length })}
                </Text>
                <Group gap="xs">
                  <IconButton
                    disabled={installSelected.isPending}
                    label={t("setup.sources.selectAll")}
                    onClick={() => setSelectedIds(new Set(suggestions.map((item) => item.id)))}
                    size="lg"
                  >
                    <SelectAllIcon />
                  </IconButton>
                  <IconButton
                    disabled={installSelected.isPending}
                    label={t("setup.sources.clear")}
                    onClick={() => setSelectedIds(new Set())}
                    size="lg"
                  >
                    <DeselectIcon />
                  </IconButton>
                </Group>
                <Stack className="norea-setup-sources" gap="xs">
                  {suggestions.map((item) => (
                    <Checkbox
                      checked={selectedIds.has(item.id)}
                      description={formatPluginLanguageForLocale(locale, item.lang)}
                      disabled={installSelected.isPending}
                      key={item.id}
                      label={item.name}
                      onChange={(event) => {
                        const checked = event.currentTarget.checked;
                        setSelectedIds((current) => {
                          const next = new Set(current);
                          if (checked) next.add(item.id);
                          else next.delete(item.id);
                          return next;
                        });
                      }}
                    />
                  ))}
                </Stack>
              </>
            )}
            <Group className="norea-setup-footer" justify="space-between">
              <Button disabled={installSelected.isPending} onClick={() => setStep("languages")} variant="default">
                {t("common.back")}
              </Button>
              <Button
                disabled={selected.length === 0}
                loading={installSelected.isPending}
                onClick={() => installSelected.mutate(selected)}
              >
                {progress
                  ? t("setup.sources.installing", progress)
                  : t("setup.sources.install", { count: selected.length })}
              </Button>
            </Group>
          </div>
        ) : null}

        {step === "done" && outcome ? (
          <div className="norea-setup-body">
            <Title className="norea-setup-title" order={1}>{t("setup.done.title")}</Title>
            <Text className="norea-setup-copy">{t("setup.done.message", { count: outcome.installed })}</Text>
            {outcome.failed.length > 0 ? (
              <Text className="norea-setup-error" role="alert">
                {t("setup.done.failed", { names: outcome.failed.join(", ") })}
              </Text>
            ) : null}
            <Group justify="flex-end">
              <Button onClick={finish}>{t("setup.done.action")}</Button>
            </Group>
          </div>
        ) : null}
      </PageFrame>
    </>
  );
}
