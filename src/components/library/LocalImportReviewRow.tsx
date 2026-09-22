import { useTranslation } from "../../i18n";
import { type TranslateFn } from "./LibraryFilters";
import {
  formatLocalImportFileSize,
  getLocalImportStatusDetail,
  getLocalImportStatusLabel,
  type LocalImportReviewItem,
} from "./local-import-review";
interface LocalImportReviewRowProps {
  item: LocalImportReviewItem;
  locale: ReturnType<typeof useTranslation>["locale"];
  t: TranslateFn;
}

export function LocalImportReviewRow({
  item,
  locale,
  t,
}: LocalImportReviewRowProps) {
  const title = item.analysis?.title ?? item.file.name;
  const detail = getLocalImportStatusDetail(item, t);
  const meta = [
    item.file.name,
    item.format
      ? item.format.toUpperCase()
      : t("library.localImport.formatUnknown"),
    formatLocalImportFileSize(item.file.size, locale),
  ].join(" - ");

  return (
    <div className="norea-library-local-import-row" data-status={item.status}>
      <div className="norea-library-local-import-file">
        <span className="norea-library-local-import-title">{title}</span>
        <span className="norea-library-local-import-meta">{meta}</span>
        {detail ? (
          <span className="norea-library-local-import-detail">{detail}</span>
        ) : null}
      </div>
      <span className="norea-library-local-import-status">
        {getLocalImportStatusLabel(item.status, t)}
      </span>
    </div>
  );
}

export function ImportFileIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M14 3v5h5" />
      <path d="M6 3h8l5 5v13H6z" />
      <path d="M12 11v6" />
      <path d="M9 14l3 3 3-3" />
    </svg>
  );
}
