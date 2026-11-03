import { useTranslation } from "../../i18n";
import { type TranslateFn } from "./LibraryViewOptions";
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
