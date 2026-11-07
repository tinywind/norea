import { Loader, Switch } from "@mantine/core";
import { StateView } from "../AppFrame";
import { IconButton } from "../IconButton";
import type { PluginRepository } from "../../db/queries/repository";
import { useTranslation } from "../../i18n";
import { describeError } from "../../lib/errors";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  PlusIcon,
  RefreshIcon,
  RepositoryIcon,
  TrashIcon,
} from "../ui/icons";
import { OverflowMenu } from "../ui/OverflowMenu";
import { ResponsiveSheet } from "../ui/ResponsiveSheet";

const GITHUB_HOSTS = new Set(["github.com", "raw.githubusercontent.com"]);

/**
 * A short name for a repository: its stored name, `owner/repo` for GitHub
 * URLs, otherwise the host.
 */
export function repositoryLabel(repository: Pick<PluginRepository, "name" | "url">): string {
  if (repository.name?.trim()) return repository.name.trim();
  try {
    const url = new URL(repository.url);
    const [owner, repo] = url.pathname.split("/").filter(Boolean);
    if (GITHUB_HOSTS.has(url.hostname) && owner && repo) return `${owner}/${repo}`;
    return url.host || repository.url;
  } catch {
    return repository.url;
  }
}

export interface RepositoryListStatus {
  /** Plugins the repository's index lists. */
  pluginCounts: ReadonlyMap<string, number>;
  failures: ReadonlyMap<string, string>;
  /** A refresh or removal is running for this repository URL. */
  busyUrls: ReadonlySet<string>;
}

interface RepositoriesDialogProps {
  error: unknown;
  onAdd: () => void;
  onClose: () => void;
  onMove: (repository: PluginRepository, offset: -1 | 1) => void;
  onRefresh: (repository: PluginRepository) => void;
  onRemove: (repository: PluginRepository) => void;
  onToggle: (repository: PluginRepository, enabled: boolean) => void;
  opened: boolean;
  repositories: readonly PluginRepository[];
  status: RepositoryListStatus;
}

/**
 * The plugin repository list: enable, priority order, refresh and remove.
 * The first enabled repository listing a plugin id provides it.
 */
export function RepositoriesDialog({
  error,
  onAdd,
  onClose,
  onMove,
  onRefresh,
  onRemove,
  onToggle,
  opened,
  repositories,
  status,
}: RepositoriesDialogProps) {
  const { t } = useTranslation();

  return (
    <ResponsiveSheet
      onClose={onClose}
      opened={opened}
      size="lg"
      title={t("extensions.repositories.title")}
    >
      <div className="norea-extension-section">
        <div className="norea-extension-section-header">
          <p className="norea-extension-section-note">{t("extensions.repositories.priorityNote")}</p>
          <IconButton label={t("extensions.repositories.add")} onClick={onAdd} size="lg">
            <PlusIcon />
          </IconButton>
        </div>
        {error ? (
          <StateView
            color="danger"
            details={{ content: describeError(error), label: t("common.details") }}
            title={t("common.saveFailed")}
          />
        ) : null}
        {repositories.length === 0 ? (
          <StateView
            message={t("browse.repository.emptyMessage")}
            title={t("browse.repository.emptyTitle")}
          />
        ) : (
          <ul className="norea-extension-list">
            {repositories.map((repository, index) => {
              const label = repositoryLabel(repository);
              const failure = status.failures.get(repository.url);
              const count = status.pluginCounts.get(repository.url);
              const subtitle = !repository.enabled
                ? t("extensions.repositories.off")
                : failure !== undefined
                  ? t("browse.repositoryFetchError")
                  : count !== undefined
                    ? t("extensions.repositories.pluginCount", { count })
                    : repository.url;
              return (
                <li className="norea-extension-row" key={repository.id}>
                  <span className="norea-list-item-leading">
                    <RepositoryIcon />
                  </span>
                  <span className="norea-list-item-text">
                    <span className="norea-list-item-title">{label}</span>
                    <span className="norea-list-item-subtitle" title={repository.url}>
                      {subtitle}
                    </span>
                  </span>
                  <span className="norea-extension-row-trailing">
                    <Switch
                      aria-label={t("extensions.repositories.enable", { name: label })}
                      checked={repository.enabled}
                      onChange={(event) => onToggle(repository, event.currentTarget.checked)}
                    />
                    {status.busyUrls.has(repository.url) ? (
                      <span
                        aria-label={t("browse.fetchingRepositoryIndex")}
                        className="norea-extension-busy"
                        role="status"
                      >
                        <Loader aria-hidden="true" size="xs" />
                      </span>
                    ) : (
                      <>
                        <IconButton
                          disabled={!repository.enabled}
                          label={`${t("common.refresh")}: ${label}`}
                          onClick={() => onRefresh(repository)}
                          size="lg"
                        >
                          <RefreshIcon />
                        </IconButton>
                        <OverflowMenu
                          items={[
                            ...(index > 0
                              ? [{
                                  icon: ChevronUpIcon,
                                  label: t("extensions.repositories.moveUp"),
                                  onClick: () => onMove(repository, -1),
                                }]
                              : []),
                            ...(index < repositories.length - 1
                              ? [{
                                  icon: ChevronDownIcon,
                                  label: t("extensions.repositories.moveDown"),
                                  onClick: () => onMove(repository, 1),
                                }]
                              : []),
                            {
                              danger: true,
                              icon: TrashIcon,
                              label: t("common.remove"),
                              onClick: () => onRemove(repository),
                            },
                          ]}
                          label={t("extensions.repositoryActions")}
                        />
                      </>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </ResponsiveSheet>
  );
}
