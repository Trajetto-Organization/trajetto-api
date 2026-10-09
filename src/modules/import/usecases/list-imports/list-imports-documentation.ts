import { searchMetaDoc } from "@/shared/pagination/list-meta";

/**
 * The listing's `meta.searchMeta`, as summarizeImportList builds it: the
 * Status and Origem options, each counted with the other filter applied.
 * No cards: the tab has none.
 */
const importListSearchMetaDoc = searchMetaDoc({}, ["status", "source"]);

export { importListSearchMetaDoc };
