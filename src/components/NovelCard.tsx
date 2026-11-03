import { useRef } from "react";
import {
  Badge,
  Box,
  Card,
  Group,
  Stack,
  Text,
  useMantineTheme,
} from "@mantine/core";
import { ConsoleCover } from "./ConsolePrimitives";
import { useTranslation } from "../i18n";
import type { LibraryDisplayMode } from "../store/library";

const LONG_PRESS_MS = 500;

interface NovelCardProps {
  name: string;
  cover: string | null;
  /** Library display mode. Browse/source views can omit and get the default cover+title layout. */
  displayMode?: LibraryDisplayMode;
  itemNumber?: number;
  /** Library row metadata. Browse/source views default these to 0/false. */
  chaptersDownloaded?: number;
  chaptersUnread?: number;
  totalChapters?: number;
  showDownloadBadge?: boolean;
  showUnreadBadge?: boolean;
  showNumberBadge?: boolean;
  selected?: boolean;
  /** Click/tap (without holding). Suppressed if a long press fired. */
  onActivate?: () => void;
  /** Pointer held for {@link LONG_PRESS_MS} ms. */
  onLongPress?: () => void;
}

export function NovelCard({
  name,
  cover,
  displayMode = "comfortable",
  itemNumber,
  chaptersDownloaded = 0,
  chaptersUnread = 0,
  totalChapters = 0,
  showDownloadBadge = false,
  showUnreadBadge = false,
  showNumberBadge = false,
  selected = false,
  onActivate,
  onLongPress,
}: NovelCardProps) {
  const { t } = useTranslation();
  const theme = useMantineTheme();
  const longPressTimer = useRef<number | null>(null);
  const longPressed = useRef(false);

  const cancelTimer = () => {
    if (longPressTimer.current !== null) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  const handlePointerDown = () => {
    longPressed.current = false;
    if (!onLongPress) return;
    longPressTimer.current = window.setTimeout(() => {
      longPressed.current = true;
      onLongPress();
      longPressTimer.current = null;
    }, LONG_PRESS_MS);
  };

  const handlePointerUp = () => {
    cancelTimer();
    if (!longPressed.current && onActivate) {
      onActivate();
    }
  };

  const handlePointerLeave = () => {
    cancelTimer();
  };

  const interactive = Boolean(onActivate || onLongPress);
  const showBadges =
    showNumberBadge ||
    (showDownloadBadge && chaptersDownloaded > 0) ||
    (showUnreadBadge && chaptersUnread > 0);

  const badges = showBadges ? (
    <Group
      gap={4}
      wrap="nowrap"
      pos="absolute"
      top={8}
      left={8}
      style={{ zIndex: 1 }}
    >
      {showNumberBadge && itemNumber != null ? (
        <Badge size="xs" variant="default">
          {itemNumber}
        </Badge>
      ) : null}
      {showDownloadBadge && chaptersDownloaded > 0 ? (
        <Badge size="xs" variant="filled" color="ok">
          {chaptersDownloaded}
        </Badge>
      ) : null}
      {showUnreadBadge && chaptersUnread > 0 ? (
        <Badge size="xs" variant="filled">
          {chaptersUnread}
        </Badge>
      ) : null}
    </Group>
  ) : null;

  const coverImage = (
    <Box pos="relative">
      {badges}
      <ConsoleCover
        alt={name}
        height={displayMode === "list" ? 92 : 210}
        src={cover}
        width={displayMode === "list" ? 62 : "100%"}
      />
      {displayMode === "compact" ? (
        <Box
          pos="absolute"
          left={0}
          right={0}
          bottom={0}
          p="xs"
          style={{
            background:
              "linear-gradient(180deg, transparent, rgba(0, 0, 0, 0.78))",
          }}
        >
          <Text size="sm" fw={600} lineClamp={2} c="white" title={name}>
            {name}
          </Text>
        </Box>
      ) : null}
    </Box>
  );

  const title =
    displayMode === "comfortable" ? (
      <Text size="sm" fw={500} lineClamp={2} mt="xs" title={name}>
        {name}
      </Text>
    ) : null;

  return (
    <Card
      padding="xs"
      radius="md"
      withBorder
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
      onPointerCancel={handlePointerLeave}
      style={{
        cursor: interactive ? "pointer" : "default",
        outline: selected
          ? `0.1875rem solid ${theme.colors[theme.primaryColor]?.[5] ?? theme.primaryColor}`
          : undefined,
        outlineOffset: "-0.1875rem",
        userSelect: "none",
      }}
    >
      {displayMode === "list" ? (
        <Group gap="sm" align="center" wrap="nowrap">
          {coverImage}
          <Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
            <Text size="sm" fw={600} lineClamp={2} title={name}>
              {name}
            </Text>
            <Text size="xs" c="dimmed">
              {t("novel.chaptersCount", { count: totalChapters })}
            </Text>
          </Stack>
        </Group>
      ) : (
        <>
          <Card.Section>{coverImage}</Card.Section>
          {title}
        </>
      )}
    </Card>
  );
}
