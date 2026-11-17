import { useTranslation } from "../../i18n";
import { useServerWorkCategories } from "../../lib/content-sync/use-server-work-categories";

interface ServerWorkCategoriesProps {
  active: boolean;
  novel: { pluginId: string; sourceNovelId: string | null; path: string };
  serverUrl: string;
}

/** The categories shared state holds for a content-server work that is not a library work on this device. */
export function ServerWorkCategories({ active, novel, serverUrl }: ServerWorkCategoriesProps) {
  const { t } = useTranslation();
  const categoriesOf = useServerWorkCategories(
    serverUrl,
    [{ pluginId: novel.pluginId, novelId: novel.sourceNovelId ?? "", novelPath: novel.path }],
    active,
  );
  const categories = categoriesOf(novel.pluginId, novel.path);
  if (categories.length === 0) return null;
  return (
    <ul aria-label={t("categories.title")} className="norea-novel-categories">
      {categories.map(name => (
        <li className="norea-novel-category-label" key={name}>{name}</li>
      ))}
    </ul>
  );
}
