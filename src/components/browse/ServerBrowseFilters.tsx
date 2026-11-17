import { useState } from "react";
import { Radio, Stack, Text } from "@mantine/core";
import { useTranslation, type TranslationKey } from "../../i18n";
import type { ServerSourceSummary, ServerWorkCompletion, ServerWorkFilter } from "../../lib/content-sync/browse";
import { ChipButton } from "../ChipButton";
import { FilterIcon } from "../ui/icons";
import { ResponsiveSheet } from "../ui/ResponsiveSheet";
import "../../styles/library.css";

const COMPLETION_LABELS: Record<Exclude<ServerWorkCompletion, "">, TranslationKey> = {
  completed: "contentSync.filters.completed",
  ongoing: "contentSync.filters.ongoing",
};

interface ServerBrowseFiltersProps {
  filter: Pick<ServerWorkFilter, "completion" | "source">;
  onChange: (filter: Partial<Pick<ServerWorkFilter, "completion" | "source">>) => void;
  sourceName: (id: string) => string;
  sources: readonly ServerSourceSummary[];
  sourcesLoading: boolean;
}

/**
 * The server browse filters laid out like the library's: one-tap Completed and Ongoing chips,
 * the entry to the filter sheet with the active count, and Clear.
 */
export function ServerBrowseFilters({ filter, onChange, sourceName, sources, sourcesLoading }: ServerBrowseFiltersProps) {
  const { t } = useTranslation();
  const [opened, setOpened] = useState(false);
  const { completion, source } = filter;
  const activeCount = (completion ? 1 : 0) + (source ? 1 : 0);

  return (
    <div className="norea-library-filter-row norea-server-filter-row">
      <div aria-label={t("contentSync.filters.label")} className="norea-library-chips" role="group">
        {(["completed", "ongoing"] as const).map(value => (
          <ChipButton
            className="norea-library-chip"
            key={value}
            onClick={() => onChange({ completion: completion === value ? "" : value })}
            selected={completion === value}
          >
            {t(COMPLETION_LABELS[value])}
          </ChipButton>
        ))}
        <ChipButton className="norea-library-chip" icon={<FilterIcon />} onClick={() => setOpened(true)} tone={activeCount > 0 ? "accent" : undefined}>
          {activeCount > 0 ? t("contentSync.filters.moreActive", { count: activeCount }) : t("contentSync.filters.more")}
        </ChipButton>
        {activeCount > 0 ? (
          <ChipButton className="norea-library-chip" onClick={() => onChange({ completion: "", source: "" })}>
            {t("common.clear")}
          </ChipButton>
        ) : null}
      </div>
      <ResponsiveSheet className="norea-library-view-options" onClose={() => setOpened(false)} opened={opened} title={t("contentSync.filters.title")}>
        <Stack gap="lg">
          <Radio.Group label={t("contentSync.filters.completion")} onChange={value => onChange({ completion: value as ServerWorkCompletion })} value={completion}>
            <Stack className="norea-library-option-list" gap={0}>
              <Radio label={t("contentSync.filters.anyCompletion")} value="" />
              <Radio label={t(COMPLETION_LABELS.completed)} value="completed" />
              <Radio label={t(COMPLETION_LABELS.ongoing)} value="ongoing" />
            </Stack>
          </Radio.Group>
          <Radio.Group label={t("contentSync.sourceFilter")} onChange={value => onChange({ source: value })} value={source}>
            <Stack className="norea-library-option-list" gap={0}>
              <Radio label={t("contentSync.allSources")} value="" />
              {sourcesLoading && sources.length === 0 ? <Text c="dimmed" size="sm">{t("library.sources.loading")}</Text> : null}
              {sources.map(item => (
                <Radio
                  key={item.id}
                  label={
                    <span className="norea-library-option-label">
                      <span>{sourceName(item.id)}</span>
                      <span className="norea-library-option-count">{item.workCount.toLocaleString()}</span>
                    </span>
                  }
                  value={item.id}
                />
              ))}
            </Stack>
          </Radio.Group>
        </Stack>
      </ResponsiveSheet>
    </div>
  );
}
