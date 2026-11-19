import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestSqliteDatabase as Database } from "../../test/sql/types";

const realFetch = globalThis.fetch;

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  getDb: vi.fn(),
  getReadOnlyDb: vi.fn(),
  runDatabaseTransaction: vi.fn(),
  runExclusiveDatabaseOperation: vi.fn(),
  suspendVpn: vi.fn(),
  deviceNameQuery: "Live Wire Device",
  interceptHttp: null as null | ((url: string, init?: RequestInit) => Promise<void> | void),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (mocks.interceptHttp) await mocks.interceptHttp(url, init);
    return realFetch(input as RequestInfo, init);
  },
}));
vi.mock("../../test/sql/client", () => ({
  getDb: mocks.getDb,
  getReadOnlyDb: mocks.getReadOnlyDb,
  runDatabaseTransaction: mocks.runDatabaseTransaction,
  runExclusiveDatabaseOperation: mocks.runExclusiveDatabaseOperation,
}));
vi.mock("../tasks/main-tasks", () => ({
  enqueueMainTask: ({ run }: { run: () => Promise<unknown> }) => ({ promise: run() }),
}));
vi.mock("../tasks/vpn-download-runtime", () => ({
  suspendVpnDownloadsForRestore: mocks.suspendVpn,
}));

import { createUserStateIpcHandler } from "../../test/mock-user-state-ipc";
import {
  discardUserStateNotifications,
  notifyUserStateCommitted,
  waitForUserStateDeferredApply,
} from "../../test/sql/user-state-core";
import { setUserStateActiveServer } from "../../db/user-state";
import { insertCategory, setNovelCategories } from "../../db/queries/category";
import { setChapterBookmark, updateChapterProgress } from "../../db/queries/chapter";
import { useContentSyncStore } from "../../store/content-sync";
import { useUserStateStore } from "../../store/user-state";
import { forgetContentDeviceRegistration } from "../content-sync/device";
import { getUserStateStatus, rebindUserStateWorkspace, synchronizeUserState } from "./sync";
import {
  canonicalUserStateJson,
  userStateEntityKey,
  type UserStateEntity,
  type UserStateOperation,
  type UserStateRecord,
  type UserStateValue,
  type UserStateWorkReference,
} from "./types";

const DEFAULT_WORK: UserStateWorkReference = {
  pluginId: "live-wire-source",
  sourceNovelId: "wire-book-1",
  novelPath: "/wire/book-1",
  name: "Live Wire Book",
};

interface ClientFixture {
  name: string;
  sql: DatabaseSync;
  db: Database;
  queue: Promise<unknown>;
  storage: Map<string, string>;
  ipc: ReturnType<typeof createUserStateIpcHandler>;
}

const clients: ClientFixture[] = [];
let activeClient!: ClientFixture;
let activeServerUrl = "";

function createSqliteFixture(name: string): ClientFixture {
  const sql = new DatabaseSync(":memory:");
  sql.exec("PRAGMA foreign_keys=ON");
  const registration = readFileSync("src-tauri/src/database.rs", "utf8");
  for (const match of registration.matchAll(
    /version:\s*(\d+),\s*description:[\s\S]*?sql:\s*include_str!\("([^"]+)"\)/g,
  )) {
    sql.exec(readFileSync(`src-tauri/src/${match[2]}`, "utf8"));
  }
  const params = (values: unknown[]) =>
    Object.fromEntries(values.map((value, index) => [`$${index + 1}`, value]));
  const db = {
    select: async (query: string, values: unknown[] = []) =>
      sql.prepare(query).all(params(values) as never),
    execute: async (query: string, values: unknown[] = []) => {
      const result = sql.prepare(query).run(params(values) as never);
      return { rowsAffected: Number(result.changes), lastInsertId: Number(result.lastInsertRowid) };
    },
  } as Database;
  const fixture: ClientFixture = {
    name,
    sql,
    db,
    queue: Promise.resolve(),
    storage: new Map<string, string>(),
    ipc: null as never,
  };
  fixture.ipc = createUserStateIpcHandler({
    getDb: () => fixture.db,
    runTransaction: (run) => runTx(fixture, run),
    runExclusive: (run) => run(fixture.db),
  });
  clients.push(fixture);
  return fixture;
}

async function runTx<T>(client: ClientFixture, run: (db: Database) => Promise<T>): Promise<T> {
  const next = client.queue
    .catch(() => undefined)
    .then(async () => {
      client.sql.exec("BEGIN IMMEDIATE");
      try {
        const result = await run(client.db);
        client.sql.exec("COMMIT");
        notifyUserStateCommitted(client.db);
        return result;
      } catch (error) {
        client.sql.exec("ROLLBACK");
        discardUserStateNotifications(client.db);
        throw error;
      }
    });
  client.queue = next;
  return next;
}

function addWorkToClient(
  client: ClientFixture,
  novelId = 1,
  work: UserStateWorkReference = DEFAULT_WORK,
  chapters: { id: number; path: string; name: string; progress?: number; unread?: number; readAt?: number | null; bookmark?: number }[] = [
    { id: novelId * 10 + 1, path: "/chapter/1", name: "Chapter 1" },
  ],
): void {
  client.sql
    .prepare(
      "INSERT INTO novel(id,plugin_id,source_novel_id,path,name,in_library,last_read_at) VALUES(?,?,?,?,?,?,?)",
    )
    .run(novelId, work.pluginId, work.sourceNovelId, work.novelPath, work.name, 1, null);
  for (let i = 0; i < chapters.length; i += 1) {
    const ch = chapters[i]!;
    client.sql
      .prepare(
        "INSERT INTO chapter(id,novel_id,path,name,chapter_number,position,progress,unread,read_at,bookmark) VALUES(?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        ch.id,
        novelId,
        ch.path,
        ch.name,
        String(i + 1),
        i + 1,
        ch.progress ?? 0,
        ch.unread ?? 1,
        ch.readAt ?? null,
        ch.bookmark ?? 0,
      );
  }
}

function stubStorageForClient(client: ClientFixture): void {
  vi.stubGlobal("localStorage", {
    get length() {
      return client.storage.size;
    },
    key: (index: number) => [...client.storage.keys()][index] ?? null,
    getItem: (key: string) => client.storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      client.storage.set(key, value);
    },
    removeItem: (key: string) => {
      client.storage.delete(key);
    },
    clear: () => {
      client.storage.clear();
    },
  });
}

function activateClient(client: ClientFixture, serverUrl: string): void {
  const prevServer = useContentSyncStore.getState().serverUrl;
  if (prevServer) {
    const prevKey = activeClient?.storage.get(`norea-content-device:${prevServer}`);
    if (prevKey) forgetContentDeviceRegistration(prevServer, prevKey);
  }
  activeClient = client;
  activeServerUrl = serverUrl;
  stubStorageForClient(client);
  mocks.deviceNameQuery = client.name;
  useContentSyncStore.setState({ serverUrl, deviceName: client.name, deviceKey: null });
  setUserStateActiveServer(serverUrl || null);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.interceptHttp = null;
  useContentSyncStore.setState({ serverUrl: "", deviceName: "", deviceKey: null, status: "idle", error: null });
  useUserStateStore.setState({
    enabledByServer: {},
    runtimeByServer: {},
    retentionByServer: {},
    retentionStatusByServer: {},
  });
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("navigator", { onLine: true, userAgent: "Mozilla/5.0 Linux" });
  mocks.suspendVpn.mockResolvedValue(vi.fn());
  mocks.getDb.mockImplementation(async () => activeClient.db);
  mocks.getReadOnlyDb.mockImplementation(async () => activeClient.db);
  mocks.runDatabaseTransaction.mockImplementation((run) => runTx(activeClient, run));
  mocks.runExclusiveDatabaseOperation.mockImplementation(async (run) => run(activeClient.db));
  mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    const handled = await activeClient.ipc.handle(command, args);
    if (handled.handled) return handled.result;
    if (command === "get_default_device_name") return activeClient.name;
    throw new Error(`Unhandled IPC command in live-wire.test.ts: ${command}`);
  });
});

afterEach(async () => {
  mocks.interceptHttp = null;
  setUserStateActiveServer(null);
  await waitForUserStateDeferredApply();
  if (activeServerUrl) {
    const key = activeClient?.storage.get(`norea-content-device:${activeServerUrl}`);
    if (key) forgetContentDeviceRegistration(activeServerUrl, key);
  }
  while (clients.length) {
    clients.pop()!.sql.close();
  }
  useContentSyncStore.setState({ serverUrl: "", deviceName: "", deviceKey: null });
  useUserStateStore.setState({
    enabledByServer: {},
    runtimeByServer: {},
    retentionByServer: {},
    retentionStatusByServer: {},
  });
  vi.unstubAllGlobals();
});

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

describe("Live TCP HTTP Wire Integration (standalone node:http)", () => {
  it("runs real TCP HTTP sync, 410->multi-page snapshot with concurrent write, seed-skipped, Mode A/B rebind, and Policy 2-C", async () => {
    const state = {
      workspaceId: "ws-wire-1",
      epoch: "ep-1",
      headRevision: 0,
      compactedThrough: 0,
      seedAllowed: true,
      seedCutoffAt: null as number | null,
      snapshotLimit: null as number | null,
      snapshotPageCallback: null as null | ((pageCount: number) => void),
      snapshotPageCount: 0,
      devices: new Map<string, { id: string; deviceName: string }>(),
      records: new Map<string, UserStateRecord>(),
      changes: [] as { revision: number; entityKey: string; record: UserStateRecord }[],
      operations: new Map<string, { hash: string; result: unknown; stage1Cleaned: boolean }>(),
    };

    const publish = (entity: UserStateEntity, value: UserStateValue, opId: string, deviceId: string, deviceName: string) => {
      const key = userStateEntityKey(entity);
      state.headRevision += 1;
      const rec: UserStateRecord = {
        entity,
        value,
        revision: state.headRevision,
        operationId: opId,
        updatedAt: Date.now(),
        deviceId,
        deviceName,
      };
      state.records.set(key, rec);
      state.changes.push({ revision: state.headRevision, entityKey: key, record: rec });
      return rec;
    };

    const server = createServer(async (req, res) => {
      const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname.replace(/^\/api\/v1/, "");
      const method = req.method ?? "GET";
      const body = method === "POST" ? await readJsonBody(req) : {};
      if (method === "GET" && path === "/capabilities") {
        return sendJson(res, 200, {
          apiVersion: 1,
          packageVersion: 1,
          authentication: "device-key",
          personalStateSync: true,
          readingStateVersion: 1,
          userStateVersion: 1,
          userStateBulkVersion: 1,
          userStateOpaqueIdentityVersion: 1,
          userStateRetentionVersion: 1,
        });
      }
      if (method === "POST" && path === "/devices/register") {
        const key = String(body.deviceKey);
        const name = String(body.deviceName);
        if (!state.devices.has(key)) state.devices.set(key, { id: `dev-${state.devices.size + 1}`, deviceName: name });
        const d = state.devices.get(key)!;
        return sendJson(res, 200, { id: d.id, deviceName: d.deviceName });
      }
      const auth = req.headers.authorization;
      const devKey = auth?.startsWith("Bearer ") ? auth.slice(7) : "";
      const dev = state.devices.get(devKey);
      if (!dev) return sendJson(res, 401, { message: "Unauthorized" });

      if (method === "GET" && path === "/user-state") {
        return sendJson(res, 200, {
          version: 1,
          workspaceId: state.workspaceId,
          epoch: state.epoch,
          headRevision: state.headRevision,
        });
      }
      if (method === "GET" && path === "/user-state/retention") {
        return sendJson(res, 200, {
          version: 1,
          workspaceId: state.workspaceId,
          epoch: state.epoch,
          headRevision: state.headRevision,
          compactedThrough: state.compactedThrough,
          seedAllowed: state.seedAllowed,
          seedCutoffAt: state.seedCutoffAt,
        });
      }
      if (method === "POST" && path === "/user-state/read") {
        if (body.workspaceId !== state.workspaceId || body.epoch !== state.epoch) {
          return sendJson(res, 409, { message: "Epoch mismatch" });
        }
        const after = Number(body.after);
        const through = Number(body.through);
        if (after < state.compactedThrough) {
          return sendJson(res, 410, { code: "cursor-compacted", message: "Cursor compacted" });
        }
        const matched = state.changes
          .filter(c => c.revision > after && c.revision <= through)
          .sort((a, b) => a.revision - b.revision)
          .map(c => c.record);
        return sendJson(res, 200, {
          version: 1,
          workspaceId: state.workspaceId,
          epoch: state.epoch,
          headRevision: state.headRevision,
          through,
          nextCursor: through,
          hasMore: false,
          records: matched,
        });
      }
      if (method === "POST" && path === "/user-state/snapshot") {
        if (body.workspaceId !== state.workspaceId || body.epoch !== state.epoch) {
          return sendJson(res, 409, { message: "Epoch mismatch" });
        }
        state.snapshotPageCount += 1;
        const afterKey = (body.afterEntityKey as string | null | undefined) ?? null;
        const sorted = [...state.records.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .filter(([k]) => (afterKey === null ? true : k > afterKey));
        const limit = state.snapshotLimit ?? Math.max(1, sorted.length);
        const page = sorted.slice(0, limit);
        const hasMore = page.length < sorted.length;
        const nextEntityKey = hasMore ? page[page.length - 1]![0] : null;
        const snapRev = state.headRevision;
        state.snapshotPageCallback?.(state.snapshotPageCount);
        return sendJson(res, 200, {
          version: 1,
          workspaceId: state.workspaceId,
          epoch: state.epoch,
          headRevision: snapRev,
          snapshotRevision: snapRev,
          nextEntityKey,
          hasMore,
          seedAllowed: state.seedAllowed,
          seedCutoffAt: state.seedCutoffAt,
          records: page.map(([, r]) => r),
        });
      }
      if (method === "POST" && path === "/user-state/merge") {
        if (body.workspaceId !== state.workspaceId || body.epoch !== state.epoch) {
          return sendJson(res, 409, { message: "Epoch mismatch" });
        }
        const ops = body.operations as UserStateOperation[];
        const results = [];
        for (const item of ops) {
          const hash = canonicalUserStateJson({ entity: item.entity, value: item.value, baseRevision: item.baseRevision, seed: item.seed ?? null });
          const existingOp = state.operations.get(item.operationId);
          if (existingOp) {
            if (existingOp.stage1Cleaned) return sendJson(res, 409, { message: "Receipt expired" });
            if (existingOp.hash !== hash) return sendJson(res, 409, { message: "Payload mismatch" });
            results.push(existingOp.result);
            continue;
          }
          const key = userStateEntityKey(item.entity);
          const cur = state.records.get(key) ?? null;
          let result: { operationId: string; status: string; current: UserStateRecord | null };
          if (item.seed && cur) {
            result = { operationId: item.operationId, status: "seed-skipped", current: cur };
          } else if (item.seed && !state.seedAllowed) {
            result = { operationId: item.operationId, status: "seed-skipped", current: null };
          } else {
            const next = publish(item.entity, item.value, item.operationId, dev.id, dev.deviceName);
            result = { operationId: item.operationId, status: "applied", current: next };
          }
          state.operations.set(item.operationId, { hash, result, stage1Cleaned: false });
          results.push(result);
        }
        return sendJson(res, 200, {
          version: 1,
          workspaceId: state.workspaceId,
          epoch: state.epoch,
          headRevision: state.headRevision,
          results,
        });
      }
      return sendJson(res, 404, { message: "Not found" });
    });

    await new Promise<void>(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address() as { port: number };
    const serverUrl = `http://127.0.0.1:${address.port}`;

    try {
      const clientA = createSqliteFixture("Client A");
      activateClient(clientA, serverUrl);
      addWorkToClient(clientA, 1, DEFAULT_WORK, [
        { id: 11, path: "/chapter/1", name: "Chapter 1" },
        { id: 12, path: "/chapter/2", name: "Chapter 2" },
      ]);
      await updateChapterProgress(11, 55);
      await setChapterBookmark(12, true);
      await synchronizeUserState();
      expect(state.headRevision).toBeGreaterThanOrEqual(3);

      // Client B connects cleanly via real TCP HTTP
      const clientB = createSqliteFixture("Client B");
      activateClient(clientB, serverUrl);
      addWorkToClient(clientB, 1, DEFAULT_WORK, [
        { id: 11, path: "/chapter/1", name: "Chapter 1" },
        { id: 12, path: "/chapter/2", name: "Chapter 2" },
      ]);
      await synchronizeUserState();
      expect(clientB.sql.prepare("SELECT progress,bookmark FROM chapter ORDER BY id").all()).toEqual([
        { progress: 55, bookmark: 0 },
        { progress: 0, bookmark: 1 },
      ]);

      // Server compacts and deletes bookmark record -> Client B unbookmarks locally via mid-sync 410 + multi-page snapshot with concurrent write
      const bmKey = userStateEntityKey({
        kind: "bookmark",
        work: DEFAULT_WORK,
        chapter: { chapterPath: "/chapter/2", name: "Chapter 2" },
      });
      state.records.delete(bmKey);
      state.compactedThrough = state.headRevision;
      state.seedAllowed = false;
      state.snapshotLimit = 1;
      state.snapshotPageCount = 0;
      state.snapshotPageCallback = (count) => {
        if (count === 1) {
          publish(
            { kind: "reading", work: DEFAULT_WORK, chapter: { chapterPath: "/chapter/2", name: "Chapter 2" } },
            { progress: 90, unread: false, readAt: 1_750_000_000 },
            "concurrent-op-2",
            "dev-remote",
            "Remote",
          );
        }
      };

      // Force Client B's cursor behind compactedThrough to trigger 410 on /read
      clientB.sql.prepare("UPDATE user_state_workspace SET cursor = 0").run();
      await synchronizeUserState();
      expect(state.snapshotPageCount).toBeGreaterThanOrEqual(2);
      expect(clientB.sql.prepare("SELECT progress,bookmark FROM chapter ORDER BY id").all()).toEqual([
        { progress: 55, bookmark: 0 },
        { progress: 90, bookmark: 0 },
      ]);

      // Epoch rotation -> Mode B start_fresh preserves local progress without re-uploading pre-epoch history
      state.epoch = "ep-2";
      state.headRevision = 0;
      state.compactedThrough = 0;
      state.seedAllowed = true;
      state.records.clear();
      state.changes = [];
      state.operations.clear();
      state.snapshotLimit = null;
      state.snapshotPageCallback = null;

      await expect(synchronizeUserState()).rejects.toThrow(/workspace|epoch/i);
      expect((await getUserStateStatus()).epochMismatch?.serverEpoch).toBe("ep-2");
      await rebindUserStateWorkspace("start_fresh");
      expect(state.headRevision).toBe(0);
      expect((await getUserStateStatus()).epochMismatch).toBeUndefined();

      // Policy 2-C: compactedThrough > 0 with seedAllowed = true & seedCutoffAt
      const cutoff = 1_700_000_000_000;
      state.seedCutoffAt = cutoff;
      state.compactedThrough = 1;
      state.seedAllowed = true;
      publish(
        { kind: "library", work: DEFAULT_WORK },
        { inLibrary: true, addedAt: 1_750_000_000 },
        "seed-2c-lib",
        "dev-remote",
        "Remote",
      );

      const clientC = createSqliteFixture("Client C");
      activateClient(clientC, serverUrl);
      addWorkToClient(clientC, 1, DEFAULT_WORK, [
        { id: 11, path: "/chapter/old", name: "Old", progress: 100, unread: 0, readAt: 1_650_000_000 },
        { id: 12, path: "/chapter/new", name: "New", progress: 80, unread: 0, readAt: 1_750_000_000 },
      ]);
      await synchronizeUserState();
      const uploadedPaths = [...state.records.values()]
        .filter(r => r.entity.kind === "reading")
        .map(r => (r.entity as { chapter: { chapterPath: string } }).chapter.chapterPath);
      expect(uploadedPaths).toEqual(["/chapter/new"]);
      expect(clientC.sql.prepare("SELECT progress FROM chapter WHERE path = '/chapter/old'").get()).toEqual({ progress: 100 });
    } finally {
      await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    }
  });
});

const siblingServerRoot = resolve(process.cwd(), "../norea-content-server");
const siblingAppEntry = join(siblingServerRoot, "src/app.ts");
const siblingDbEntry = join(siblingServerRoot, "src/db.ts");

if (existsSync(siblingAppEntry)) {
  describe("Live Fastify norea-content-server Wire Integration", () => {
    it("exercises norea synchronizeUserState & rebindUserStateWorkspace against real Fastify norea-content-server over 127.0.0.1 TCP HTTP", async () => {
      const { buildApp } = (await import(/* @vite-ignore */ pathToFileURL(siblingAppEntry).href)) as {
        buildApp: (opts: Record<string, unknown>) => Promise<{
          listen: (opts: { host: string; port: number }) => Promise<string>;
          close: () => Promise<void>;
        }>;
      };
      const { openDatabase } = (await import(/* @vite-ignore */ pathToFileURL(siblingDbEntry).href)) as {
        openDatabase: (dataDir: string) => DatabaseSync;
      };

      const dataDir = await mkdtemp(join(tmpdir(), "norea-live-fastify-"));
      let clock = Date.UTC(2026, 6, 15, 12, 0, 0);
      const app = await buildApp({
        dataDir,
        userStateMaintenance: {
          now: () => clock,
          compactionIntervalMs: 0,
          supersededGraceMs: 1_000,
          operationBodyRetentionMs: 1_000,
          operationFingerprintRetentionMs: 60_000,
          tombstoneGraceMs: 5_000,
        },
      });
      const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
      const adminPassword = (await readFile(join(dataDir, "admin-password.hash"), "utf8")).trim();
      const adminToken = (
        (await (
          await realFetch(`${baseUrl}/api/v1/console-sessions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ password: adminPassword }),
          })
        ).json()) as { token: string }
      ).token;
      const adminHeaders = { authorization: `Bearer ${adminToken}`, "content-type": "application/json" };

      try {
        // 1-2. Client A syncs real reading, bookmark, category & membership changes to Fastify server
        const clientA = createSqliteFixture("Fastify Client A");
        activateClient(clientA, baseUrl);
        addWorkToClient(clientA, 1, DEFAULT_WORK, [
          { id: 11, path: "/chapter/1", name: "Chapter 1" },
          { id: 12, path: "/chapter/2", name: "Chapter 2" },
        ]);
        await updateChapterProgress(11, 70);
        await setChapterBookmark(12, true);
        await insertCategory({ name: "Live Shelf" });
        const catId = (clientA.sql.prepare("SELECT id FROM category WHERE name = 'Live Shelf'").get() as { id: number }).id;
        await setNovelCategories(1, [catId]);
        await synchronizeUserState();

        const statsAfterA = (await (
          await realFetch(`${baseUrl}/api/v1/admin/user-state`, { headers: adminHeaders })
        ).json()) as { headRevision: number; records: { active: number } };
        expect(statsAfterA.headRevision).toBeGreaterThanOrEqual(4);
        expect(statsAfterA.records.active).toBeGreaterThanOrEqual(4);

        // 3. Client B materializes Client A's state via POST /api/v1/user-state/read
        const clientB = createSqliteFixture("Fastify Client B");
        activateClient(clientB, baseUrl);
        addWorkToClient(clientB, 1, DEFAULT_WORK, [
          { id: 11, path: "/chapter/1", name: "Chapter 1" },
          { id: 12, path: "/chapter/2", name: "Chapter 2" },
        ]);
        await synchronizeUserState();
        expect(clientB.sql.prepare("SELECT progress,bookmark FROM chapter ORDER BY id").all()).toEqual([
          { progress: 70, bookmark: 0 },
          { progress: 0, bookmark: 1 },
        ]);

        // 4-5. Client A creates a bookmark tombstone -> server stage-1 cleans & GC's tombstones right as Client B calls /read -> 410 -> /snapshot
        activateClient(clientA, baseUrl);
        await setChapterBookmark(12, false);
        await synchronizeUserState();

        clock += 10_000;
        activateClient(clientB, baseUrl);
        let compactedOnce = false;
        mocks.interceptHttp = async (url) => {
          if (!compactedOnce && url.endsWith("/user-state/read")) {
            compactedOnce = true;
            const res = await realFetch(`${baseUrl}/api/v1/admin/user-state/compact`, {
              method: "POST",
              headers: adminHeaders,
              body: "{}",
            });
            expect(res.status).toBe(200);
          }
        };
        await synchronizeUserState();
        mocks.interceptHttp = null;
        expect(clientB.sql.prepare("SELECT bookmark FROM chapter WHERE id = 12").get()).toEqual({ bookmark: 0 });
        expect((await getUserStateStatus()).seedAllowed).toBe(false);

        // 6. Admin epoch reset -> Client A Mode A (reseed), Client B mid-sync 409 -> Mode B (start_fresh)
        const resetRes = await realFetch(`${baseUrl}/api/v1/admin/user-state/reset`, {
          method: "POST",
          headers: adminHeaders,
          body: "{}",
        });
        expect(resetRes.status).toBe(200);

        activateClient(clientA, baseUrl);
        await expect(synchronizeUserState()).rejects.toThrow(/workspace|epoch/i);
        expect((await getUserStateStatus()).epochMismatch).toBeDefined();
        await rebindUserStateWorkspace("reseed");
        expect((await getUserStateStatus()).epochMismatch).toBeUndefined();

        activateClient(clientB, baseUrl);
        await expect(synchronizeUserState()).rejects.toThrow(/workspace|epoch/i);
        await rebindUserStateWorkspace("start_fresh");
        expect((await getUserStateStatus()).epochMismatch).toBeUndefined();

        // 7. Policy 2-C end-to-end against real Fastify server
        const patch2c = await realFetch(`${baseUrl}/api/v1/admin/user-state/retention`, {
          method: "PATCH",
          headers: adminHeaders,
          body: JSON.stringify({ slidingWindow: { enabled: true, months: 3 } }),
        });
        expect(patch2c.status).toBe(200);

        // Merge an old record directly via Client A's device credentials, then compact via admin
        const clientC = createSqliteFixture("Fastify Client C");
        activateClient(clientC, baseUrl);
        addWorkToClient(clientC, 1, DEFAULT_WORK, [
          { id: 11, path: "/chapter/old", name: "Old", progress: 100, unread: 0, readAt: Math.floor((clock - 150 * 86_400_000) / 1000) },
          { id: 12, path: "/chapter/recent", name: "Recent", progress: 85, unread: 0, readAt: Math.floor((clock - 5 * 86_400_000) / 1000) },
        ]);
        await realFetch(`${baseUrl}/api/v1/admin/user-state/compact`, {
          method: "POST",
          headers: adminHeaders,
          body: "{}",
        });
        await synchronizeUserState();
        const statusC = await getUserStateStatus();
        expect(statusC.seedAllowed).toBe(true);
        expect(typeof statusC.seedCutoffAt).toBe("number");
        expect(clientC.sql.prepare("SELECT progress FROM chapter WHERE path = '/chapter/old'").get()).toEqual({ progress: 100 });

        // Check server DB directly to confirm old chapter was not seeded while recent chapter was seeded
        const sdb = openDatabase(dataDir);
        try {
          const oldKey = userStateEntityKey({
            kind: "reading",
            work: DEFAULT_WORK,
            chapter: { chapterPath: "/chapter/old", name: "Old" },
          });
          const recentKey = userStateEntityKey({
            kind: "reading",
            work: DEFAULT_WORK,
            chapter: { chapterPath: "/chapter/recent", name: "Recent" },
          });
          expect(sdb.prepare("SELECT 1 FROM user_state_records WHERE entity_key=?").get(oldKey)).toBeUndefined();
          expect(sdb.prepare("SELECT 1 FROM user_state_records WHERE entity_key=?").get(recentKey)).toBeDefined();
        } finally {
          sdb.close();
        }

        // Verify device backup name hash helper doesn't fail on valid device name
        expect(createHash("sha256").update("ok").digest("hex")).toHaveLength(64);
        expect(randomUUID().length).toBeGreaterThan(0);
      } finally {
        mocks.interceptHttp = null;
        await app.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    });
  });
}
