import { Alert, Button, Loader, Text } from "@mantine/core";
import { useTranslation } from "../../i18n";
import type { GlobalSearchResult } from "../../lib/plugins/global-search";
import { pluginManager } from "../../lib/plugins/manager";
import type { NovelItem } from "../../lib/plugins/types";
import { SearchBar } from "../SearchBar";
import { SourceNovelCover } from "../SourceNovelCover";
import { CheckIcon } from "../ui/icons";
import { ListRow } from "../ui/ListRow";

export interface MergeTargetCandidate {
  item: NovelItem;
  pluginId: string;
  pluginName: string;
}

export function mergeTargetKey(candidate: Pick<MergeTargetCandidate, "item" | "pluginId">): string {
  return `${candidate.pluginId}:${candidate.item.path}`;
}

interface MergeChooseStepProps {
  noTargetPlugins: boolean;
  onCancelSearch: () => void;
  onContinue: () => void;
  onPick: (candidate: MergeTargetCandidate) => void;
  onSearch: () => void;
  onSearchTextChange: (value: string) => void;
  pluginsError: string | null;
  previewError: string | null;
  previewingKey: string | null;
  results: readonly GlobalSearchResult[];
  searchError: string | null;
  searchSettled: boolean;
  searchText: string;
  searching: boolean;
  selectedKey: string | null;
  sourceName: string;
}

export function MergeChooseStep({
  noTargetPlugins,
  onCancelSearch,
  onContinue,
  onPick,
  onSearch,
  onSearchTextChange,
  pluginsError,
  previewError,
  previewingKey,
  results,
  searchError,
  searchSettled,
  searchText,
  searching,
  selectedKey,
  sourceName,
}: MergeChooseStepProps) {
  const { t } = useTranslation();
  const withNovels = results.filter((result) => !result.error && result.novels.length > 0);
  const failed = results.filter((result) => result.error);

  return (
    <div className="norea-merge-choose">
      <div className="norea-merge-step-body">
        <Text c="dimmed" size="sm">
          {t("novelMerge.choose.description", { source: sourceName })}
        </Text>
        {pluginsError ? (
          <Alert color="danger" title={t("common.loadFailed")}>
            {pluginsError}
          </Alert>
        ) : noTargetPlugins ? (
          <Alert color="warn">{t("novelMerge.findTarget.noPlugins")}</Alert>
        ) : (
          <SearchBar
            onChange={onSearchTextChange}
            onSubmit={onSearch}
            placeholder={t("novelMerge.findTarget.placeholder")}
            value={searchText}
          />
        )}

        {searching ? (
          <div className="norea-merge-search-state" role="status">
            <Loader size="sm" />
            <Text size="sm">{t("novelMerge.findTarget.searching")}</Text>
            <Button onClick={onCancelSearch} size="xs" variant="default">
              {t("common.cancel")}
            </Button>
          </div>
        ) : null}
        {searchError ? (
          <Alert color="danger" title={t("novelMerge.findTarget.searchFailed")}>
            {searchError}
          </Alert>
        ) : null}
        {previewError ? (
          <Alert color="danger" title={t("novelMerge.findTarget.previewFailed")}>
            {previewError}
          </Alert>
        ) : null}

        {withNovels.map((result) => (
          <section
            aria-label={result.pluginName}
            className="norea-merge-result-group"
            key={result.pluginId}
          >
            <h2 className="norea-merge-result-group-title">
              <span>{result.pluginName}</span>
              <Text c="dimmed" component="span" size="xs">
                {t("novelMerge.findTarget.resultCount", { count: result.novels.length })}
              </Text>
            </h2>
            {result.novels.map((item, index) => {
              const candidate = {
                item,
                pluginId: result.pluginId,
                pluginName: result.pluginName,
              };
              const key = mergeTargetKey(candidate);
              const selected = key === selectedKey;
              return (
                <ListRow
                  aria-current={selected ? "true" : undefined}
                  className="norea-merge-result-row"
                  disabled={previewingKey !== null}
                  key={`${key}:${index}`}
                  leading={
                    <SourceNovelCover
                      height="3.5rem"
                      item={item}
                      plugin={pluginManager.getPlugin(result.pluginId)}
                      width="2.5rem"
                    />
                  }
                  onClick={() => onPick(candidate)}
                  selected={selected}
                  subtitle={
                    selected
                      ? t("novelMerge.choose.selected")
                      : previewingKey === key
                        ? t("novelMerge.choose.loadingChapters")
                        : undefined
                  }
                  title={item.name}
                  trailing={
                    previewingKey === key ? (
                      <Loader size="xs" />
                    ) : selected ? (
                      <CheckIcon />
                    ) : undefined
                  }
                />
              );
            })}
          </section>
        ))}

        {searchSettled && withNovels.length === 0 ? (
          <Text c="dimmed" size="sm">
            {t("novelMerge.findTarget.noResults")}
          </Text>
        ) : null}
        {failed.length > 0 ? (
          <details className="norea-merge-failed-sources">
            <summary>
              {t("novelMerge.choose.failedSources", { count: failed.length })}
            </summary>
            <ul>
              {failed.map((result) => (
                <li key={result.pluginId}>
                  <strong>{result.pluginName}</strong>: {result.error}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>

      {selectedKey ? (
        <footer className="norea-merge-footer">
          <Button disabled={previewingKey !== null} onClick={onContinue}>
            {t("novelMerge.continue")}
          </Button>
        </footer>
      ) : null}
    </div>
  );
}
