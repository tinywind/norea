import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import type Database from "@tauri-apps/plugin-sql";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { ChapterPayloadSnapshot } from "../chapter-content/inventory";
import type { NovelMetadataV1, StoredNovelMetadata } from "../work-metadata";

vi.mock("../../db/client", () => ({ getDb: vi.fn(), runDatabaseTransaction: vi.fn() }));
vi.mock("../../db/work-metadata", async original => ({ ...await original<typeof import("../../db/work-metadata")>(), readWorkMetadataSyncFile: vi.fn() }));
vi.mock("../work-metadata", async original => ({ ...await original<typeof import("../work-metadata")>(), installStoredNovelMetadata: vi.fn(), readStoredNovelMetadata: vi.fn(), readStoredNovelCover: vi.fn() }));
vi.mock("../chapter-content/storage-platform", () => ({ inspectChapterPayloadInventory: vi.fn() }));
vi.mock("../chapter-content-storage", () => ({ reconcileStoredChapterContent: vi.fn() }));
vi.mock("../chapter-storage-transfer", () => ({ prepareChapterStorageTransfer: vi.fn(), rollbackChapterStorageTransfer: vi.fn(), finalizeChapterStorageTransfer: vi.fn(), removeChapterStorageDirectory: vi.fn() }));
vi.mock("../tasks/chapter-storage-operation", () => ({ runExclusiveChapterStorageOperation: vi.fn(async (_scope, _signal, run) => run()) }));
vi.mock("../tasks/download-cache-delete", () => ({ cancelNovelChapterDownloadWork: vi.fn() }));
vi.mock("../plugins/manager", () => ({ pluginManager: { loadInstalledFromDb: vi.fn(), getPlugin: vi.fn() } }));
vi.mock("../plugins/sync-novel", () => ({ syncNovelFromSource: vi.fn() }));
vi.mock("../tasks/source-tasks", () => ({ enqueueSourceTask: vi.fn() }));
vi.mock("../updates/update-index-events", () => ({ markUpdatesIndexDirty: vi.fn() }));
vi.mock("./sync", () => ({ downloadServerChapterFromServer: vi.fn(), runContentSyncOperation: vi.fn(), syncContentServer: vi.fn() }));
vi.mock("./works", async original => ({ ...await original<typeof import("./works")>(), recordInstalledWorkMetadata: vi.fn() }));
vi.mock("./novel-source", () => ({ rememberServerNovelSource: vi.fn() }));
vi.mock("./client", async original => ({ ...await original<typeof import("./client")>(), contentServerRequest: vi.fn() }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

import { getDb, runDatabaseTransaction } from "../../db/client";
import { applyNovelMetadataToCache, readWorkMetadataSyncFile } from "../../db/work-metadata";
import { findNovelBySource, getNovelById } from "../../db/queries/novel";
import { getChapterById } from "../../db/queries/chapter";
import { installStoredNovelMetadata, readStoredNovelMetadata, readStoredNovelCover } from "../work-metadata";
import { inspectChapterPayloadInventory } from "../chapter-content/storage-platform";
import { reconcileStoredChapterContent } from "../chapter-content-storage";
import { prepareChapterStorageTransfer, rollbackChapterStorageTransfer, finalizeChapterStorageTransfer, removeChapterStorageDirectory } from "../chapter-storage-transfer";
import { chapterStorageRelativeDir } from "../chapter-storage-path";
import { pluginManager } from "../plugins/manager";
import { syncNovelFromSource } from "../plugins/sync-novel";
import { enqueueSourceTask } from "../tasks/source-tasks";
import { ContentServerError, contentServerRequest } from "./client";
import { downloadServerChapterFromServer } from "./sync";
import { recordInstalledWorkMetadata } from "./works";
import { fetch as nativeFetch } from "@tauri-apps/plugin-http";
import { applyIncomingNovelMigration, IncomingNovelMigrationRetryableError, type ResolvedIncomingNovelMigration } from "./incoming-novel-migration";
import type { CatalogEntry } from "./native";
import type { WorkMigrationLineage } from "./migration-feed-state";

let sqlite: DatabaseSync;
let db: Database;
const files = new Map<string, ChapterPayloadSnapshot>();
const metadataFiles = new Map<string, StoredNovelMetadata>();
let live: { work: WorkMigrationLineage["targetWork"]; chapters: WorkMigrationLineage["mappings"][number]["source"][] };
let resolved: ResolvedIncomingNovelMigration;
let serverEntry: CatalogEntry | null;
let afterPrepare: (() => void) | undefined;
const revision = "2".repeat(64);
const firstInventory = { body: { sha256: "a".repeat(64), bytes: 10 }, expectedAssetKeys: [], storedAssets: [] };
function payload(hash = "a"): ChapterPayloadSnapshot { return { ...firstInventory, body: { sha256: hash.repeat(64), bytes: 10 }, fingerprint: hash, mediaComplete: true, payloadBytes: 10, contentBytes: 10, mediaBytes: 0 }; }
function metadata(pluginId: string, novelId: string, novelPath: string, name: string, chapters: Record<string,string>): NovelMetadataV1 {
  return { schemaVersion: 1, identity: { pluginId, novelId, novelPath }, novel: { name, author: null, artist: null, summary: null, status: null, genres: null, rating: 0, isLocal: false }, cover: null, chapters };
}
function fixture(): ResolvedIncomingNovelMigration {
  const sourceMetadata = metadata("alpha", "a-work", "/old", "Original", { "1": "Old first", "2": "Old second", "3": "Note" });
  const targetMetadata = metadata("beta", "b-work", "/new", "Fresh target", { "11": "Fresh first", "12": "Fresh second" });
  const sourceWork = { id: createHash("sha256").update(JSON.stringify(["alpha", "/old"])).digest("hex"), revision: "1".repeat(64), identity: sourceMetadata.identity, metadata: sourceMetadata, coverSha256: null };
  const targetWork = { id: createHash("sha256").update(JSON.stringify(["beta", "/new"])).digest("hex"), revision, identity: targetMetadata.identity, metadata: targetMetadata, coverSha256: null };
  const chapterDecisions = [
    { sourceChapterPath: "/a/1", sourceChapterNumber: "1", targetChapterPath: "/b/11", targetChapterNumber: "11", sourceMetadataVerified: true, targetMetadataVerified: true },
    { sourceChapterPath: "/a/2", sourceChapterNumber: "2", targetChapterPath: "/b/12", targetChapterNumber: "12", sourceMetadataVerified: true, targetMetadataVerified: true },
    { sourceChapterPath: "/a/note", sourceChapterNumber: "3", targetChapterPath: null, targetChapterNumber: null, sourceMetadataVerified: true, targetMetadataVerified: false },
  ];
  const targetMappings: WorkMigrationLineage["mappings"] = [{ decision: "copy-source",
    source: { id: "3".repeat(64), revision: "4".repeat(64), chapterPath: "/a/1", chapterNumber: "1", position: 1, name: "Old first", complete: true, available: true },
    target: { id: "5".repeat(64), revision: "6".repeat(64), chapterPath: "/b/11", chapterNumber: "11", position: 1, name: "Fresh first", complete: true, available: true }, targetInventory: firstInventory,
  }];
  const lineage: WorkMigrationLineage = { sequence: 1, operationId: "11111111-1111-4111-8111-111111111111", sourceWork, targetWork,
    deletedSource: { revision: sourceWork.revision, sequence: 3 }, mappings: targetMappings, chapterDecisions, fullDecisionCoverage: true, active: true };
  return { sourceWork, targetWork, chapterDecisions, targetMappings, chain: [lineage] };
}
function initializeDevice(idOffset = 0) {
  sqlite = new DatabaseSync(":memory:");
  const registration = readFileSync("src-tauri/src/database.rs", "utf8");
  for (const match of registration.matchAll(/include_str!\("([^"]+)"\)/g)) sqlite.exec(readFileSync("src-tauri/src/" + match[1], "utf8"));
  sqlite.exec(`INSERT INTO novel(id,plugin_id,source_novel_id,path,name,author,in_library,library_added_at) VALUES(${1+idOffset},'alpha','a-work','/old','Original','Old author',1,10);
    INSERT INTO chapter(id,novel_id,path,name,chapter_number,position,is_downloaded,progress,unread,bookmark,read_at) VALUES
    (${11+idOffset},${1+idOffset},'/a/1','Old first','1',1,1,100,0,1,40),
    (${12+idOffset},${1+idOffset},'/a/2','Old second','2',2,0,42,1,0,50),
    (${13+idOffset},${1+idOffset},'/a/note','Note','3',3,0,0,1,0,NULL)`);
  const bindings = (values: unknown[]) => Object.fromEntries(values.map((value,index) => ["$"+(index+1),value])) as never;
  db = { select: async (sql:string, values:unknown[]=[]) => sqlite.prepare(sql).all(bindings(values)), execute: async (sql:string, values:unknown[]=[]) => {
    const result = sqlite.prepare(sql).run(bindings(values)); return { rowsAffected:Number(result.changes), lastInsertId:Number(result.lastInsertRowid) };
  } } as Database;
  vi.mocked(getDb).mockResolvedValue(db);
  vi.mocked(runDatabaseTransaction).mockImplementation(async (run, remote) => {
    sqlite.exec("BEGIN IMMEDIATE");
    try { if(remote)sqlite.exec("UPDATE content_sync_origin SET remote=1"); const result=await run(db); if(remote)sqlite.exec("UPDATE content_sync_origin SET remote=0"); sqlite.exec("COMMIT"); return result; }
    catch(error){ sqlite.exec("ROLLBACK"); throw error; }
  });
  files.clear(); metadataFiles.clear(); files.set("contents/alpha/a-work/1",payload());
}
beforeEach(() => {
  vi.clearAllMocks(); initializeDevice(); resolved=fixture(); afterPrepare=undefined;
  live={work:structuredClone(resolved.targetWork),chapters:resolved.targetMappings.flatMap(mapping=>mapping.target?[mapping.target]:[])};
  serverEntry={id:"5".repeat(64),revision:"6".repeat(64),fileBytes:10,complete:true,deleted:false,sequence:1,
    manifest:{packageVersion:1,layout:"chapter-files",identity:{...resolved.targetWork.identity,chapterPath:"/b/11"},novel:{name:"Fresh target",isLocal:false},chapter:{name:"Fresh first",chapterNumber:"11",position:1,page:"1",contentType:"html"},bodyPath:"content.html",files:[]}};
  vi.mocked(contentServerRequest).mockImplementation(async (_server,path) => {
    if(path.endsWith("/migration-snapshot"))return structuredClone(live) as never;
    if(path.startsWith("/catalog/chapter?")){if(!serverEntry)throw new ContentServerError(404);return structuredClone(serverEntry) as never;}
    if(path.includes("/storage-inventory?"))return {revision:serverEntry!.revision,identity:serverEntry!.manifest.identity,inventory:firstInventory} as never;
    throw Error("Unexpected endpoint "+path);
  });
  vi.mocked(installStoredNovelMetadata).mockImplementation(async (input,cover,before,options) => {
    expect(options?.authoritative).toBe(true);
    await runDatabaseTransaction(async db=>{await before?.(null,db);const id=await applyNovelMetadataToCache(db,input,undefined,{preserveMissingMetadata:false});await db.execute("UPDATE novel SET cover=NULL WHERE id=$1",[id]);},true);
    const directory=`contents/${input.identity.pluginId}/${input.identity.novelId}`;
    const stored={directory,metadata:structuredClone(input)};metadataFiles.set(directory,stored);
    return {...stored,coverBytes:cover??null,syncFile:{directory,fingerprint:"latest",revision:7,pluginId:input.identity.pluginId,path:input.identity.novelPath}};
  });
  vi.mocked(readWorkMetadataSyncFile).mockImplementation(async identity=>{const stored=[...metadataFiles.values()].find(value=>value.metadata.identity.pluginId===identity.pluginId&&value.metadata.identity.novelPath===identity.novelPath);return stored?{directory:stored.directory,fingerprint:"latest",revision:7,pluginId:identity.pluginId,path:identity.novelPath}:null;});
  vi.mocked(readStoredNovelMetadata).mockImplementation(async directory=>metadataFiles.get(directory)??null);
  vi.mocked(readStoredNovelCover).mockResolvedValue(null);
  vi.mocked(inspectChapterPayloadInventory).mockImplementation(async identity=>structuredClone(files.get(chapterStorageRelativeDir(identity.novel,identity.chapter))??{...payload(),body:null,mediaComplete:false,contentBytes:0,payloadBytes:0}));
  vi.mocked(reconcileStoredChapterContent).mockImplementation(async id=>{const chapter=await getChapterById(id);const novel=await getNovelById(chapter!.novelId);const directory=chapterStorageRelativeDir(novel!,chapter!);return files.has(directory)?{status:"present",mediaComplete:true,contentFile:directory+"/content.html",contentBytes:10,mediaBytes:0}:{status:"missing",contentFile:null,contentBytes:0,mediaBytes:0};});
  vi.mocked(prepareChapterStorageTransfer).mockImplementation(async entries=>{
    const result={token:"incoming-prepare",entries:entries.map(entry=>{const existing=files.has(entry.targetRelativeDir);const source=files.get(entry.sourceRelativeDir);if(!existing&&source)files.set(entry.targetRelativeDir,structuredClone(source));return {...entry,outcome:existing?"keptTarget" as const:source?"copiedSource" as const:"sourceNotDownloaded" as const,contentFile:existing||source?entry.targetRelativeDir+"/content.html":null,contentBytes:10,mediaBytes:0,replacedTarget:false};})};afterPrepare?.();return result;
  });
  vi.mocked(rollbackChapterStorageTransfer).mockImplementation(async preparation=>{for(const entry of preparation.entries)if(entry.outcome==="copiedSource")files.delete(entry.targetRelativeDir);});
  vi.mocked(finalizeChapterStorageTransfer).mockResolvedValue(undefined);
  vi.mocked(removeChapterStorageDirectory).mockImplementation(async directory=>{for(const key of files.keys())if(key===directory||key.startsWith(directory+"/"))files.delete(key);});
  vi.mocked(downloadServerChapterFromServer).mockImplementation(async (_entry,_server,options)=>{await options?.beforeInstall?.();const novel=await findNovelBySource(options!.target.pluginId,options!.target.novelPath);const [chapter]=await db.select<{id:number}[]>("SELECT id FROM chapter WHERE novel_id=$1 AND path=$2",[novel!.id,options!.target.chapterPath]);files.set("contents/beta/b-work/11",payload());await db.execute("UPDATE chapter SET is_downloaded=1,stored_content_type='html',content_bytes=10 WHERE id=$1",[chapter!.id]);return {novelId:novel!.id,chapterId:chapter!.id};});
  vi.mocked(nativeFetch).mockResolvedValue(new Response(new Uint8Array([42]),{headers:{"content-type":"image/png"}}));
});
afterEach(()=>sqlite.close());
async function apply(assertCurrent:()=>void|Promise<void>=()=>undefined){return applyIncomingNovelMigration("http://server","device",resolved,{assertCurrent,recordIncomingMigration:async db=>{await db.execute("INSERT INTO content_sync_cache(cache_key,payload) VALUES($1,$2) ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload",["incoming-receipt",JSON.stringify({status:"completed"})]);}});}

it("replays the same migration on two devices with distinct local IDs and preserves their reading state",async()=>{
  for(const offset of [0,100]){
    if(offset){sqlite.close();initializeDevice(offset);}
    const result=await apply();
    expect(result!.sourceNovelId).toBe(1+offset);
    expect(sqlite.prepare("SELECT plugin_id,author,in_library FROM novel").all()).toEqual([{plugin_id:"beta",author:null,in_library:1}]);
    expect(sqlite.prepare("SELECT path,progress,unread,bookmark,is_downloaded FROM chapter ORDER BY position").all()).toEqual([
      {path:"/b/11",progress:100,unread:0,bookmark:1,is_downloaded:1},{path:"/b/12",progress:42,unread:1,bookmark:0,is_downloaded:0},
    ]);
    expect(files.has("contents/beta/b-work/11")).toBe(true);expect(files.has("contents/alpha/a-work/1")).toBe(false);
    expect(sqlite.prepare("SELECT payload FROM content_sync_cache WHERE cache_key='incoming-receipt'").get()).toEqual({payload:'{"status":"completed"}'});
    expect(result!.installedTargetMetadata!.metadata.novel.name).toBe("Fresh target");
  }
  expect(pluginManager.loadInstalledFromDb).not.toHaveBeenCalled();expect(syncNovelFromSource).not.toHaveBeenCalled();expect(enqueueSourceTask).not.toHaveBeenCalled();expect(downloadServerChapterFromServer).not.toHaveBeenCalled();
});
it("uses newer verified target metadata instead of restoring the old lineage author",async()=>{
  live.work.metadata.novel.author="Latest source author";live.work.metadata.chapters["13"]="New chapter";live.work.revision="9".repeat(64);
  await apply();expect(sqlite.prepare("SELECT author FROM novel").get()).toEqual({author:"Latest source author"});
});
it("keeps every source record when a recipient-only chapter lacks an approved decision",async()=>{
  sqlite.exec("INSERT INTO chapter(novel_id,path,name,chapter_number,position) VALUES(1,'/a/extra','Extra','4',4)");
  await expect(apply()).rejects.toThrow("no unambiguous approved");expect(await findNovelBySource("alpha","/old")).not.toBeNull();expect(installStoredNovelMetadata).not.toHaveBeenCalled();
});
it("refuses a recipient target download that conflicts with the approved server bytes",async()=>{
  await applyNovelMetadataToCache(db,resolved.targetWork.metadata);const target=await findNovelBySource("beta","/new");
  await db.execute("UPDATE chapter SET is_downloaded=1 WHERE novel_id=$1 AND chapter_number='11'",[target!.id]);files.set("contents/beta/b-work/11",payload("d"));
  await expect(apply()).rejects.toThrow("conflicts with the approved server");expect(await findNovelBySource("alpha","/old")).not.toBeNull();expect(files.get("contents/beta/b-work/11")!.body!.sha256).toBe("d".repeat(64));expect(downloadServerChapterFromServer).not.toHaveBeenCalled();
});
it("downloads the approved server target before migrating a different local source body",async()=>{
  files.set("contents/alpha/a-work/1",payload("c"));await apply();expect(downloadServerChapterFromServer).toHaveBeenCalledOnce();expect(files.get("contents/beta/b-work/11")!.body!.sha256).toBe("a".repeat(64));
});
it("moves a recipient-only body only after the target server lookup confirms absence",async()=>{
  resolved.targetMappings=[];live.chapters=[];serverEntry=null;await apply();expect(files.has("contents/beta/b-work/11")).toBe(true);expect(downloadServerChapterFromServer).not.toHaveBeenCalled();expect(contentServerRequest).toHaveBeenCalledWith("http://server",expect.stringContaining("/catalog/chapter?"),"device","GET",undefined,expect.any(AbortSignal));
});
it("rolls back copied files, reading state and receipt if the server target changes before commit",async()=>{
  afterPrepare=()=>{live.work.revision="8".repeat(64);};
  await expect(apply()).rejects.toBeInstanceOf(IncomingNovelMigrationRetryableError);
  expect(await findNovelBySource("alpha","/old")).not.toBeNull();expect(files.has("contents/alpha/a-work/1")).toBe(true);expect(files.has("contents/beta/b-work/11")).toBe(false);expect(sqlite.prepare("SELECT * FROM content_sync_cache WHERE cache_key='incoming-receipt'").all()).toEqual([]);
});
it("records an idempotent no-op when this recipient already has no original work",async()=>{
  sqlite.exec("DELETE FROM novel WHERE id=1");expect(await apply()).toBeNull();expect(installStoredNovelMetadata).not.toHaveBeenCalled();expect(prepareChapterStorageTransfer).not.toHaveBeenCalled();expect(sqlite.prepare("SELECT payload FROM content_sync_cache WHERE cache_key='incoming-receipt'").get()).toEqual({payload:'{"status":"completed"}'});
});
it("does not install a changed target cover or remove the original",async()=>{
  live.work.metadata.cover={fileName:"cover.png",contentType:"image/png"};live.work.coverSha256=createHash("sha256").update(new Uint8Array([99])).digest("hex");
  await expect(apply()).rejects.toThrow("target cover changed");expect(installStoredNovelMetadata).not.toHaveBeenCalled();expect(await findNovelBySource("alpha","/old")).not.toBeNull();
});
it("returns the committed mapping even if the subsequent metadata cache notification fails",async()=>{
  vi.mocked(recordInstalledWorkMetadata).mockRejectedValueOnce(new Error("cache unavailable"));const result=await apply();
  expect(result!.sourceNovelId).toBe(1);expect(result!.cleanupWarnings[0]).toContain("migration committed");expect(result!.installedTargetMetadata!.metadata.novel.name).toBe("Fresh target");expect(await findNovelBySource("alpha","/old")).toBeNull();
});

it.each(["source", "target"] as const)("preserves a partial %s body and missing-asset state without downloading its body again", async partial => {
  const full = { body: { sha256: "a".repeat(64), bytes: 10 }, expectedAssetKeys: ["media/page.png"], storedAssets: [{ key: "media/page.png", sha256: "c".repeat(64), bytes: 20 }] };
  const incomplete = { ...payload(), ...full, storedAssets: [], mediaComplete: false };
  if (resolved.targetMappings[0]!.target) resolved.targetMappings[0]!.targetInventory = full;
  if (partial === "source") {
    sqlite.exec("UPDATE chapter SET is_downloaded=0,media_repair_needed=1,content_bytes=10 WHERE id=11");
    files.set("contents/alpha/a-work/1", incomplete);
  } else {
    await applyNovelMetadataToCache(db, resolved.targetWork.metadata);
    const target = await findNovelBySource("beta", "/new");
    await db.execute("UPDATE chapter SET is_downloaded=0,media_repair_needed=1,content_bytes=10 WHERE novel_id=$1 AND chapter_number='11'", [target!.id]);
    files.set("contents/beta/b-work/11", incomplete);
  }
  await apply();
  expect(sqlite.prepare("SELECT is_downloaded,media_repair_needed,content_bytes,progress,bookmark FROM chapter WHERE chapter_number='11'").get()).toEqual({ is_downloaded: 0, media_repair_needed: 1, content_bytes: 10, progress: 100, bookmark: 1 });
  expect(files.get("contents/beta/b-work/11")!.body!.sha256).toBe("a".repeat(64));
  expect(files.get("contents/beta/b-work/11")!.storedAssets).toEqual([]);
  expect(downloadServerChapterFromServer).not.toHaveBeenCalled();
});
it("checks remote lineage once immediately before the SQL transaction, including a source-absent replay", async () => {
  const beforeCommit = vi.fn(async () => { expect(sqlite.isTransaction).toBe(false); await db.select("SELECT id FROM novel"); });
  const run = () => applyIncomingNovelMigration("http://server", "device", resolved, {
    assertCurrent: () => undefined, beforeCommit, recordIncomingMigration: async db => { await db.select("SELECT id FROM novel"); },
  });
  await run(); expect(beforeCommit).toHaveBeenCalledOnce();
  await run(); expect(beforeCommit).toHaveBeenCalledTimes(2);
});

it("resolves a unique recovered source number only when the server verified that catalog entry", async () => {
  sqlite.exec("UPDATE chapter SET path='norea-folder:1' WHERE id=11");
  await apply(); expect(await findNovelBySource("alpha", "/old")).toBeNull();
});
it("does not reuse a local-only decision for a different recipient path with the same number", async () => {
  sqlite.exec("UPDATE chapter SET path='/a/recipient-extra' WHERE id=11");
  resolved.chapterDecisions[0]!.sourceMetadataVerified = false;
  await expect(apply()).rejects.toThrow("no unambiguous approved");
  expect(await findNovelBySource("alpha", "/old")).not.toBeNull();
  expect(installStoredNovelMetadata).not.toHaveBeenCalled();
});

it("distinguishes a prepared target from a source-absent receipt in its raw commit callback", async () => {
  const recordIncomingMigration = vi.fn(async (_db: Database, _targetPrepared?: boolean) => undefined);
  const options = { assertCurrent: () => undefined, recordIncomingMigration };
  await applyIncomingNovelMigration("http://server", "device", resolved, options);
  expect(recordIncomingMigration.mock.calls[0]![1]).toBe(true);
  await applyIncomingNovelMigration("http://server", "device", resolved, options);
  expect(recordIncomingMigration.mock.calls[1]![1]).toBe(false);
});

it("keeps target-primary body choice on a recipient with only an A download while migrating its reading state", async () => {
  resolved.chapterDecisions[0]!.discardSourceContent = true;
  resolved.targetMappings = [{ source: resolved.targetMappings[0]!.source, decision: "delete-source", target: null, targetInventory: null }];
  live.chapters = []; serverEntry = null;
  await apply();
  expect(files.has("contents/beta/b-work/11")).toBe(false);
  expect(files.has("contents/alpha/a-work/1")).toBe(false);
  expect(downloadServerChapterFromServer).not.toHaveBeenCalled();
  expect(sqlite.prepare("SELECT progress,bookmark,unread,is_downloaded FROM chapter WHERE path='/b/11'").get())
    .toEqual({ progress: 100, bookmark: 1, unread: 0, is_downloaded: 0 });
});

it("preserves the composed target order during incoming replay without source-number upserts", async () => {
  resolved.chapterDecisions[0]!.discardSourceContent = true;
  resolved.chapterDecisions[1]!.discardSourceContent = true;
  resolved.targetMappings = [{ source: resolved.targetMappings[0]!.source, decision: "delete-source", target: null, targetInventory: null }];
  live.chapters = []; serverEntry = null;
  live.work.metadata.chapterComposition = {
    version: 1, updatedAt: 20, entries: [11, 12].map(number => ({
      id: "entry-" + number, path: "/b/" + number, storageChapterNumber: String(number),
      sources: [{ pluginId: "beta", novelId: "b-work", novelPath: "/new", chapterPath: "/b/" + number,
        chapterNumber: String(number), name: number === 11 ? "Fresh first" : "Fresh second", position: number - 10,
        page: "1", contentType: "html", releaseTime: null }],
      primarySource: 0, user: { included: true, order: 13 - number, name: null, chapterNumber: String(13 - number) },
    })),
  };
  await apply();
  expect(sqlite.prepare("SELECT path,chapter_number,position,progress FROM chapter ORDER BY position").all()).toEqual([
    { path: "/b/12", chapter_number: "12", position: 1, progress: 42 },
    { path: "/b/11", chapter_number: "11", position: 2, progress: 100 },
  ]);
  expect(files.has("contents/beta/b-work/11")).toBe(false);
});

async function prepareCompositionReplacement() {
  sqlite.exec("PRAGMA foreign_keys=ON");
  await applyNovelMetadataToCache(db, resolved.targetWork.metadata);
  const target = await findNovelBySource("beta", "/new");
  await db.execute("UPDATE chapter SET path='/b/11',progress=72,unread=0,bookmark=1,read_at=80,is_downloaded=1,stored_content_type='html',content_bytes=10 WHERE novel_id=$1 AND chapter_number='11'", [target!.id]);
  await db.execute("UPDATE chapter SET path='/b/12',is_downloaded=1,stored_content_type='html',content_bytes=10 WHERE novel_id=$1 AND chapter_number='12'", [target!.id]);
  await db.execute("INSERT INTO chapter_download_goal_exclusion(chapter_id,created_at) SELECT id,123 FROM chapter WHERE novel_id=$1 AND path='/b/11'", [target!.id]);
  sqlite.exec("UPDATE chapter SET progress=20,unread=1,bookmark=0,read_at=30 WHERE id=11");
  files.set("contents/beta/b-work/11", payload("d"));
  files.set("contents/beta/b-work/12", payload("e"));
  const a = { pluginId:"alpha",novelId:"a-work",novelPath:"/old",chapterPath:"/a/1",chapterNumber:"1",name:"Old first",position:1,page:"1",contentType:"html" as const,releaseTime:null };
  const b = { pluginId:"beta",novelId:"b-work",novelPath:"/new",chapterPath:"/b/11",chapterNumber:"11",name:"Fresh first",position:1,page:"1",contentType:"html" as const,releaseTime:null };
  live.work.metadata.chapters = { "13":"Old first","12":"Fresh second" };
  live.work.metadata.chapterComposition = { version:1,updatedAt:20,entries:[
    { id:"replacement",path:"norea-composed:replacement",storageChapterNumber:"13",sources:[a,b],primarySource:0,user:{included:true,order:1,name:null,chapterNumber:"1"} },
    { id:"retained",path:"/b/12",storageChapterNumber:"12",sources:[{...b,chapterPath:"/b/12",chapterNumber:"12",name:"Fresh second",position:2}],primarySource:0,user:{included:true,order:2,name:null,chapterNumber:"2"} },
    { id:"old-b",path:"/b/11",storageChapterNumber:"11",sources:[b],primarySource:0,user:{included:false,order:0,name:null,chapterNumber:null} },
  ]};
  resolved.chapterDecisions[0]!.targetChapterPath = "norea-composed:replacement";
  resolved.chapterDecisions[0]!.targetChapterNumber = "13";
  resolved.chapterDecisions[1]!.discardSourceContent = true;
  const mapping=resolved.targetMappings[0]!;
  if(mapping.target) { mapping.target.chapterPath="norea-composed:replacement";mapping.target.chapterNumber="13";mapping.target.name="Old first"; }
  live.chapters=resolved.targetMappings.flatMap(value=>value.target?[value.target]:[]);
  return target!;
}

it("metadata import retains paired B reading state and automatic exclusion on new A-primary row",async()=>{
  const target=await prepareCompositionReplacement();
  await applyNovelMetadataToCache(db,live.work.metadata);
  const rows=sqlite.prepare("SELECT c.path,c.progress,c.unread,c.bookmark,c.read_at,c.is_downloaded,c.content_bytes,e.created_at AS excludedAt FROM chapter c LEFT JOIN chapter_download_goal_exclusion e ON e.chapter_id=c.id WHERE c.novel_id=? ORDER BY c.position").all(target.id);
  expect.soft(rows[0]).toMatchObject({path:"norea-composed:replacement",progress:72,unread:0,bookmark:1,read_at:80,excludedAt:123,is_downloaded:0,content_bytes:0});
  expect.soft(rows[1]).toMatchObject({path:"/b/12",is_downloaded:1,content_bytes:10});
  expect.soft(sqlite.prepare("SELECT id FROM chapter WHERE novel_id=? AND path='/b/11'").get(target.id)).toBeUndefined();
});

it("incoming replay merges A20 with B72 and keeps selected edition bytes separate",async()=>{
  await prepareCompositionReplacement();
  await apply();
  const rows=sqlite.prepare("SELECT c.path,c.progress,c.unread,c.bookmark,c.read_at,c.is_downloaded,c.content_bytes,e.created_at AS excludedAt FROM chapter c LEFT JOIN chapter_download_goal_exclusion e ON e.chapter_id=c.id ORDER BY c.position").all();
  expect.soft(rows[0]).toMatchObject({path:"norea-composed:replacement",progress:72,unread:0,bookmark:1,read_at:80,excludedAt:123,is_downloaded:1,content_bytes:10});
  expect.soft(rows[1]).toMatchObject({path:"/b/12",is_downloaded:1,content_bytes:10});
  expect.soft(files.get("contents/beta/b-work/11")?.body?.sha256).toBe("d".repeat(64));
  expect.soft(files.get("contents/beta/b-work/13")?.body?.sha256).toBe("a".repeat(64));
});
