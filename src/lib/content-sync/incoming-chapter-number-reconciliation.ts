import { canonicalMetadataValue } from "../work-metadata/schema";
import type Database from "@tauri-apps/plugin-sql";
import { getDb } from "../../db/client";
import {
  assertChapterNumberMappings,
  canonicalChapterNumber,
  planServerChapterNumberChanges,
  readRenumberChapters,
  type ChapterNumberMapping,
  type RenumberWork,
} from "../source-chapter-renumber";
import {
  installReconciledStoredNovelMetadata,
  parseNovelMetadata,
  type InstalledNovelMetadata,
  type NovelMetadataV1,
  type StoredNovelMetadata,
} from "../work-metadata";
import { withServerChapterNumberReconciliation } from "../plugins/source-chapter-renumber";
import { ContentServerError, contentServerRequest } from "./client";
import type { WorkCatalogEntry } from "./works";

interface MappingSnapshot {
  work: WorkCatalogEntry & { revision: string };
  mappings: ChapterNumberMapping[];
}

export interface IncomingChapterNumberReconciliation {
  previousMetadata: NovelMetadataV1;
  renumberedLocalMetadata: NovelMetadataV1;
  install: (
    metadata: NovelMetadataV1,
    cover: Uint8Array | undefined,
    beforeInstall: (current: StoredNovelMetadata | null, db?: Database) => Promise<void | false>,
  ) => Promise<InstalledNovelMetadata | null>;
}

const canonical = (value: unknown) => JSON.stringify(canonicalMetadataValue(value));

/** Only a removed catalog key needs a proof lookup; ordinary additions need no extra request. */
export function mayHaveIncomingChapterNumberChanges(current: NovelMetadataV1, incoming: NovelMetadataV1): boolean {
  return Object.keys(current.chapters).some(number => !Object.hasOwn(incoming.chapters, number));
}

function validateSnapshot(value: MappingSnapshot, expected: WorkCatalogEntry): MappingSnapshot {
  if (!value?.work || value.work.id !== expected.id || value.work.deleted ||
      value.work.sequence !== expected.sequence || value.work.hasCover !== expected.hasCover ||
      typeof value.work.revision !== "string" || !/^[a-f0-9]{64}$/.test(value.work.revision) ||
      canonical(parseNovelMetadata(value.work.metadata)) !== canonical(parseNovelMetadata(expected.metadata)) ||
      !Array.isArray(value.mappings)) {
    throw new Error("Incoming chapter number proof does not match the current server work.");
  }
  assertChapterNumberMappings(value.mappings);
  const chapters = value.work.metadata.chapters;
  for (const mapping of value.mappings) {
    if (Object.hasOwn(chapters, mapping.from) || !Object.hasOwn(chapters, mapping.to)) {
      throw new Error("Incoming chapter number proof does not match the server catalog.");
    }
  }
  return value;
}

/** Prove all replaced local identities before copying files or unioning incoming catalog keys. */
export async function prepareIncomingChapterNumberReconciliation(
  server: string,
  token: string,
  entry: WorkCatalogEntry,
  current: NovelMetadataV1,
  assertCurrent: () => void,
): Promise<IncomingChapterNumberReconciliation | undefined> {
  if (!mayHaveIncomingChapterNumberChanges(current, entry.metadata)) return;
  let capabilities: { chapterNumberReconciliationVersion?: number; chapterNumberMappingsVersion?: number };
  try {
    capabilities = await contentServerRequest(server, "/capabilities", token);
  } catch (error) {
    // A legacy server without this capability endpoint cannot have committed the
    // new renumber protocol; retain its ordinary partial-catalog merge behavior.
    if (error instanceof ContentServerError && error.status === 404) return;
    throw error;
  }
  assertCurrent();
  if (capabilities.chapterNumberMappingsVersion !== 1) {
    if (capabilities.chapterNumberReconciliationVersion === 1 ||
        capabilities.chapterNumberMappingsVersion !== undefined) {
      throw new Error("Update the content server before importing corrected chapter numbers.");
    }
    return;
  }

  const path = "/works/" + entry.id + "/chapter-number-mappings";
  const proof = validateSnapshot(await contentServerRequest<MappingSnapshot>(server, path, token), entry);
  assertCurrent();
  if (!proof.mappings.length) return; // Partial catalogs are legitimate without a recorded renumber.

  const db = await getDb();
  const [work] = await db.select<RenumberWork[]>(
    "SELECT id,plugin_id AS pluginId,source_novel_id AS sourceNovelId,path FROM novel WHERE plugin_id=$1 AND path=$2",
    [current.identity.pluginId, current.identity.novelPath],
  );
  if (!work || work.sourceNovelId !== current.identity.novelId ||
      canonical(current.identity) !== canonical(entry.metadata.identity)) {
    throw new Error("Incoming chapter number proof does not match the local work.");
  }
  const stored = await readRenumberChapters(db, work.id);
  const oldNumbers = new Set(proof.mappings.map(mapping => mapping.from));
  const applicable = proof.mappings.some(mapping =>
    Object.hasOwn(current.chapters, mapping.from) ||
    stored.some(chapter => canonicalChapterNumber(chapter.chapterNumber) === mapping.from));
  if (!applicable) return; // Historical aliases do not turn an already-correct partial catalog into a rename.

  const removed = Object.keys(current.chapters).filter(number => !Object.hasOwn(entry.metadata.chapters, number));
  for (const number of removed) {
    if (!oldNumbers.has(number) ||
        stored.filter(chapter => canonicalChapterNumber(chapter.chapterNumber) === number).length !== 1) {
      throw new Error("Incoming chapter number proof is incomplete for the local catalog. Existing files were retained.");
    }
  }
  planServerChapterNumberChanges(work, stored, proof.mappings);
  const chapters = { ...current.chapters };
  for (const mapping of proof.mappings) delete chapters[mapping.from];
  const previousMetadata = { ...current, chapters };
  const renumberedChapters = { ...chapters };
  for (const mapping of proof.mappings) {
    if (Object.hasOwn(current.chapters, mapping.from)) renumberedChapters[mapping.to] = current.chapters[mapping.from]!;
  }
  const isCurrent = () => {
    try { assertCurrent(); return true; }
    catch { return false; }
  };

  return {
    previousMetadata,
    renumberedLocalMetadata: { ...current, chapters: renumberedChapters },
    install: async (metadata, cover, beforeInstall) => {
      const coverWrite = cover && metadata.cover ? {
        fileName: metadata.cover.fileName,
        sha256: Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(cover).buffer)), byte => byte.toString(16).padStart(2, "0")).join(""),
      } : undefined;
      return withServerChapterNumberReconciliation({
      pluginId: work.pluginId, path: work.path, sourceNovelId: work.sourceNovelId,
      mappings: proof.mappings, isCurrent, coverWrite,
    }, async journal => {
      assertCurrent();
      // SAF preparation can take time. Recheck the opaque server revision and
      // exact proof before committing the local catalog, without a second POST.
      const latest = validateSnapshot(await contentServerRequest<MappingSnapshot>(server, path, token), entry);
      assertCurrent();
      if (latest.work.revision !== proof.work.revision || canonical(latest.mappings) !== canonical(proof.mappings)) {
        throw new Error("The server chapter number proof changed while local storage was prepared.");
      }
      return installReconciledStoredNovelMetadata(metadata, cover, beforeInstall, {
        journal, mappings: proof.mappings,
      });
    });
    },
  };
}
