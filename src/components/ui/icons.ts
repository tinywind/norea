import { createElement, type ReactElement } from "react";
import {
  IconAdjustmentsHorizontal,
  IconAlertTriangle,
  IconArrowLeft,
  IconArrowRight,
  IconArrowsExchange,
  IconArrowsSort,
  IconBan,
  IconBell,
  IconBook,
  IconBookmark,
  IconBookmarkFilled,
  IconBrandGithub,
  IconBooks,
  IconCategory,
  IconCheck,
  IconCheckbox,
  IconChecks,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconChevronUp,
  IconCloudCheck,
  IconCloudDownload,
  IconCloudUpload,
  IconCompass,
  IconCookie,
  IconCookieOff,
  IconDeselect,
  IconDeviceFloppy,
  IconDots,
  IconDotsVertical,
  IconDownload,
  IconDownloadOff,
  IconExternalLink,
  IconEyeOff,
  IconFileExport,
  IconFileImport,
  IconFileSearch,
  IconFilter,
  IconFolder,
  IconGripVertical,
  IconHeartFilled,
  IconHeartPlus,
  IconHistory,
  IconInfoCircle,
  IconInfoSquareRounded,
  IconListNumbers,
  IconMinus,
  IconPackages,
  IconPencil,
  IconPhoto,
  IconPin,
  IconPinnedOff,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlayerSkipBack,
  IconPlugConnected,
  IconPlugConnectedX,
  IconPlus,
  IconPointFilled,
  IconPuzzle,
  IconRefresh,
  IconRefreshDot,
  IconReload,
  IconRotate,
  IconRotateClockwise,
  IconSearch,
  IconSelectAll,
  IconServer,
  IconSettings,
  IconShieldCheck,
  IconShieldLock,
  IconTool,
  IconTrash,
  IconTypography,
  IconUnlink,
  IconWorldWww,
  IconX,
  type IconProps,
  type TablerIcon,
} from "@tabler/icons-react";

const ICON_SIZE = "1.5rem";
const ICON_STROKE = 1.75;

export type AppIcon = (props: IconProps) => ReactElement;

// Lets the bundler drop every alias that no module imports.
/* @__NO_SIDE_EFFECTS__ */
function withAppDefaults(Icon: TablerIcon): AppIcon {
  return (props) =>
    createElement(Icon, {
      "aria-hidden": true,
      size: ICON_SIZE,
      stroke: ICON_STROKE,
      ...props,
    });
}

export const LibraryIcon = withAppDefaults(IconBooks);
export const AddToLibraryIcon = withAppDefaults(IconHeartPlus);
export const InLibraryIcon = withAppDefaults(IconHeartFilled);
export const OpenWorkIcon = withAppDefaults(IconBook);
export const UpdatesIcon = withAppDefaults(IconBell);
export const HistoryIcon = withAppDefaults(IconHistory);
export const BrowseIcon = withAppDefaults(IconCompass);
export const MoreIcon = withAppDefaults(IconDots);
export const DownloadsIcon = withAppDefaults(IconCloudDownload);
export const SettingsIcon = withAppDefaults(IconSettings);
export const AboutIcon = withAppDefaults(IconInfoSquareRounded);

export const SearchIcon = withAppDefaults(IconSearch);
export const FilterIcon = withAppDefaults(IconFilter);
export const SortIcon = withAppDefaults(IconArrowsSort);
export const ViewOptionsIcon = withAppDefaults(IconAdjustmentsHorizontal);
export const SelectIcon = withAppDefaults(IconCheckbox);
export const RefreshIcon = withAppDefaults(IconRefresh);
export const RefreshAllIcon = withAppDefaults(IconRefreshDot);
export const SyncIcon = withAppDefaults(IconRefreshDot);
export const RescanIcon = withAppDefaults(IconFileSearch);
export const UploadIcon = withAppDefaults(IconCloudUpload);
export const RestoreIcon = withAppDefaults(IconCloudDownload);
export const CloseIcon = withAppDefaults(IconX);
export const BackIcon = withAppDefaults(IconArrowLeft);
export const GoIcon = withAppDefaults(IconArrowRight);
export const CheckIcon = withAppDefaults(IconCheck);
export const SelectAllIcon = withAppDefaults(IconSelectAll);
export const DeselectIcon = withAppDefaults(IconDeselect);
export const MarkReadIcon = withAppDefaults(IconChecks);
export const MarkUnreadIcon = withAppDefaults(IconEyeOff);
export const UnreadIcon = withAppDefaults(IconPointFilled);
export const DownloadIcon = withAppDefaults(IconDownload);
export const DownloadedIcon = withAppDefaults(IconCloudCheck);
export const DeleteDownloadIcon = withAppDefaults(IconDownloadOff);
export const TrashIcon = withAppDefaults(IconTrash);
export const BookmarkIcon = withAppDefaults(IconBookmark);
export const BookmarkedIcon = withAppDefaults(IconBookmarkFilled);
export const ExternalLinkIcon = withAppDefaults(IconExternalLink);
export const ImageIcon = withAppDefaults(IconPhoto);
export const OverflowIcon = withAppDefaults(IconDotsVertical);
export const PlusIcon = withAppDefaults(IconPlus);
export const MinusIcon = withAppDefaults(IconMinus);
export const PlayIcon = withAppDefaults(IconPlayerPlay);
export const FromStartIcon = withAppDefaults(IconPlayerSkipBack);
export const PauseIcon = withAppDefaults(IconPlayerPause);
export const RestartIcon = withAppDefaults(IconRotateClockwise);
export const ResetIcon = withAppDefaults(IconRotate);
export const SaveIcon = withAppDefaults(IconDeviceFloppy);
export const RetryIcon = withAppDefaults(IconReload);
export const RepairIcon = withAppDefaults(IconTool);
export const ReaderSettingsIcon = withAppDefaults(IconTypography);
export const PinIcon = withAppDefaults(IconPin);
export const UnpinIcon = withAppDefaults(IconPinnedOff);
export const SourceIcon = withAppDefaults(IconWorldWww);
export const MigrateIcon = withAppDefaults(IconArrowsExchange);
export const ExcludeIcon = withAppDefaults(IconBan);
export const UnlinkIcon = withAppDefaults(IconUnlink);
export const EditIcon = withAppDefaults(IconPencil);
export const InfoIcon = withAppDefaults(IconInfoCircle);
export const WarningIcon = withAppDefaults(IconAlertTriangle);
export const CookieIcon = withAppDefaults(IconCookie);
export const ClearCookiesIcon = withAppDefaults(IconCookieOff);
export const ChevronDownIcon = withAppDefaults(IconChevronDown);
export const ChevronUpIcon = withAppDefaults(IconChevronUp);
export const ChevronRightIcon = withAppDefaults(IconChevronRight);
export const ChevronLeftIcon = withAppDefaults(IconChevronLeft);
export const ChapterListIcon = withAppDefaults(IconListNumbers);
export const DragIcon = withAppDefaults(IconGripVertical);
export const ImportIcon = withAppDefaults(IconFileImport);
export const ExportIcon = withAppDefaults(IconFileExport);
export const FolderIcon = withAppDefaults(IconFolder);
export const CategoryIcon = withAppDefaults(IconCategory);
export const VpnIcon = withAppDefaults(IconShieldLock);
export const VerifyIcon = withAppDefaults(IconShieldCheck);
export const ConnectIcon = withAppDefaults(IconPlugConnected);
export const DisconnectIcon = withAppDefaults(IconPlugConnectedX);
export const ServerIcon = withAppDefaults(IconServer);
export const ExtensionsIcon = withAppDefaults(IconPuzzle);
export const RepositoryIcon = withAppDefaults(IconPackages);
export const GithubIcon = withAppDefaults(IconBrandGithub);
