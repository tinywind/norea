import { Button, Group, NumberInput, Stack, Text } from "@mantine/core";
import { useMemo, useState } from "react";
import { type ChapterListRow } from "../../db/queries/chapter";
import { useTranslation } from "../../i18n";
import { ResponsiveSheet } from "../ui/ResponsiveSheet";
import { chapterIdsInNumberRange } from "./novel-detail-model";

interface ChapterRangeFormProps {
  chapters: readonly ChapterListRow[];
  initialFrom: number | null;
  onCancel: () => void;
  onSelect: (chapterIds: number[]) => void;
}

function ChapterRangeForm({ chapters, initialFrom, onCancel, onSelect }: ChapterRangeFormProps) {
  const { t } = useTranslation();
  const [from, setFrom] = useState<number | string>(initialFrom ?? "");
  const [to, setTo] = useState<number | string>("");
  const matchedIds = useMemo(
    () =>
      typeof from === "number" && typeof to === "number"
        ? chapterIdsInNumberRange(chapters, from, to)
        : [],
    [chapters, from, to],
  );

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (matchedIds.length > 0) onSelect(matchedIds);
      }}
    >
      <Stack gap="md">
        <Group gap="sm" grow>
          <NumberInput
            autoFocus={initialFrom === null}
            label={t("novel.range.from")}
            min={0}
            onChange={setFrom}
            value={from}
          />
          <NumberInput
            autoFocus={initialFrom !== null}
            label={t("novel.range.to")}
            min={0}
            onChange={setTo}
            value={to}
          />
        </Group>
        <Text aria-live="polite" c="dimmed" size="sm">
          {t("novel.range.matchCount", { count: matchedIds.length })}
        </Text>
        <Group gap="xs" justify="flex-end">
          <Button onClick={onCancel} variant="default">
            {t("common.cancel")}
          </Button>
          <Button disabled={matchedIds.length === 0} type="submit">
            {t("novel.select")}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

interface ChapterRangeSheetProps {
  chapters: readonly ChapterListRow[];
  /** Prefills From, such as the selection anchor's chapter number. */
  initialFrom: number | null;
  onClose: () => void;
  /** Receives the chapters numbered within the range, in list order. */
  onSelect: (chapterIds: number[]) => void;
  opened: boolean;
}

/** Selects chapters by a From and To chapter number, for distant endpoints on phones. */
export function ChapterRangeSheet({
  chapters,
  initialFrom,
  onClose,
  onSelect,
  opened,
}: ChapterRangeSheetProps) {
  const { t } = useTranslation();
  return (
    <ResponsiveSheet onClose={onClose} opened={opened} title={t("novel.range.title")}>
      {opened ? (
        <ChapterRangeForm
          chapters={chapters}
          initialFrom={initialFrom}
          onCancel={onClose}
          onSelect={onSelect}
        />
      ) : null}
    </ResponsiveSheet>
  );
}
