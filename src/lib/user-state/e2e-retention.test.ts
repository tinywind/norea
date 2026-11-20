import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { ReactElement, ReactNode } from "react";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { is } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestSqliteDatabase as Database } from "../../test/sql/types";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  fetch: vi.fn(),
  getDb: vi.fn(),
  getReadOnlyDb: vi.fn(),
  runDatabaseTransaction: vi.fn(),
  runExclusiveDatabaseOperation: vi.fn(),
  suspendVpn: vi.fn(),
  queryStatus: null as unknown,
  queryRefetch: vi.fn(async () => ({})),
  deviceNameQuery: "Client A",
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: mocks.fetch }));
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
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const hooks = {
    useRef: <T,>(value: T) => ({ current: value }),
    useState: <T,>(initial: T | (() => T)) => [
      typeof initial === "function" ? (initial as () => T)() : initial,
      vi.fn(),
    ],
    useEffect: vi.fn(),
    useCallback: <T extends (...args: never[]) => unknown>(fn: T) => fn,
    useMemo: <T,>(factory: () => T) => factory(),
    useDebugValue: vi.fn(),
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
  };
  const defaultActual = (actual as { default?: object }).default ?? actual;
  return {
    ...actual,
    ...hooks,
    default: {
      ...defaultActual,
      ...hooks,
    },
  };
});
vi.mock("../../i18n", async (original) => {
  const actual = await original<typeof import("../../i18n")>();
  const { useAppearanceStore: appearanceStore } = await import("../../store/appearance");
  return {
    ...actual,
    useTranslation: () => {
      const locale = actual.normalizeAppLocale(appearanceStore.getState().appLocale);
      return {
        locale,
        t: (key: Parameters<typeof actual.translate>[1], values?: Parameters<typeof actual.translate>[2]) =>
          actual.translate(locale, key, values),
      };
    },
  };
});
vi.mock("../../store/content-sync", async (original) => {
  const actual = await original<typeof import("../../store/content-sync")>();
  const store = actual.useContentSyncStore;
  const wrapped = ((selector?: (state: ReturnType<typeof store.getState>) => unknown) =>
    selector ? selector(store.getState()) : store.getState()) as typeof store;
  Object.assign(wrapped, store);
  return { ...actual, useContentSyncStore: wrapped };
});
vi.mock("../../store/user-state", async (original) => {
  const actual = await original<typeof import("../../store/user-state")>();
  const store = actual.useUserStateStore;
  const wrapped = ((selector?: (state: ReturnType<typeof store.getState>) => unknown) =>
    selector ? selector(store.getState()) : store.getState()) as typeof store;
  Object.assign(wrapped, store);
  return { ...actual, useUserStateStore: wrapped };
});
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) =>
    queryKey[0] === "device"
      ? { data: mocks.deviceNameQuery }
      : { data: mocks.queryStatus, refetch: mocks.queryRefetch, isFetching: false, error: null },
}));

import * as schema from "../../db/schema";
import { createUserStateIpcHandler } from "../../test/mock-user-state-ipc";
import {
  discardUserStateNotifications,
  notifyUserStateCommitted,
  recordUserStateChangesInDb,
  waitForUserStateDeferredApply,
  isCurrentWorkHeld,
  loadCurrentHeldSourcesInDb,
} from "../../test/sql/user-state-core";
import {
  acknowledgeUserStateOperationsInDb,
  applyUserStateReadPageInDb,
  bindUserStateWorkspaceInDb,
  prepareUserStateOperationsInDb,
  storeUserStateRecordInDb,
} from "../../test/sql/user-state-ledger";
import { refreshUnattemptedUserStateIdentitiesInDb } from "../../test/sql/user-state-materialize";
import {
  getUserStateBinding,
  getUserStateLedgerStatus,
  setUserStateActiveServer,
} from "../../db/user-state";
import { setChapterBookmark, setChaptersReadState, updateChapterProgress } from "../../db/queries/chapter";
import { deleteCategory, insertCategory, setNovelCategories } from "../../db/queries/category";
import { clearReadingProgress } from "../../db/queries/maintenance";
import { useAppearanceStore } from "../../store/appearance";
import { useContentSyncStore } from "../../store/content-sync";
import { useUserStateStore } from "../../store/user-state";
import { forgetContentDeviceRegistration } from "../content-sync/device";
import { DeviceBackupError, uploadDeviceBackup } from "../content-sync/device-backup";
import {
  getUserStateStatus,
  readUserStateResponse,
  rebindUserStateWorkspace,
  resumeUserStateAfterRestore,
  synchronizeUserState,
  validateUserStateAcknowledgements,
  validateUserStatePage,
} from "./sync";
import {
  canonicalUserStateJson,
  parseUserStateMergeResponse,
  parseUserStateMergeResult,
  parseUserStateReadResponse,
  parseUserStateRecord,
  parseUserStateRetentionResponse,
  parseUserStateSnapshotResponse,
  parseUserStateWorkspace,
  userStateEntityKey,
  USER_STATE_MAX_BYTES,
  UserStateProtocolError,
  type UserStateBinding,
  type UserStateEntity,
  type UserStateMergeResult,
  type UserStateOperation,
  type UserStateRecord,
  type UserStateStatus,
  type UserStateValue,
  type UserStateValueMap,
  type UserStateWorkReference,
} from "./types";
import { ReadingStateSettings, userStateValueSummary } from "../../components/ReadingStateSettings";
import { useTranslation } from "../../i18n";
import enMessages from "../../../strings/languages/en/app.json";
import koMessages from "../../../strings/languages/ko/app.json";

const SERVER_URL = "https://retention-test.example";
const DEFAULT_WORK: UserStateWorkReference = {
  pluginId: "test-source",
  sourceNovelId: "novel-42",
  novelPath: "/novel/42",
  name: "Test Novel",
};

interface ChangeEntry {
  revision: number;
  entityKey: string;
  record: UserStateRecord;
  supersededAt: number | null;
}

interface StoredOperation {
  payloadHash: string;
  result: UserStateMergeResult | null;
  stage1Cleaned: boolean;
}

interface SimulatedCapabilities {
  apiVersion: number;
  packageVersion: number;
  authentication: string;
  personalStateSync: boolean;
  readingStateVersion?: number;
  deviceBackupVersion?: number;
  userStateVersion?: number;
  userStateBulkVersion?: number;
  userStateOpaqueIdentityVersion?: number;
  userStateRetentionVersion?: number;
}

interface RequestLogEntry {
  method: string;
  path: string;
  body: unknown;
  deviceKey: string | null;
}

type FaultHandler = (ctx: {
  method: string;
  path: string;
  body: unknown;
  server: SimulatedContentServer;
}) => Response | Promise<Response> | null;

class SimulatedContentServer {
  workspaceId = "ws-e2e-1";
  epoch = "epoch-1";
  headRevision = 0;
  compactedThrough = 0;
  seedAllowed = true;
  seedCutoffAt: number | null = null;
  snapshotPageLimit: number | null = null;
  capabilities: SimulatedCapabilities = {
    apiVersion: 1,
    packageVersion: 1,
    authentication: "device-key",
    personalStateSync: true,
    readingStateVersion: 1,
    deviceBackupVersion: 1,
    userStateVersion: 1,
    userStateBulkVersion: 1,
    userStateOpaqueIdentityVersion: 1,
    userStateRetentionVersion: 1,
  };
  devices = new Map<string, { id: string; deviceName: string; blocked: boolean }>();
  records = new Map<string, UserStateRecord>();
  tombstoneKeys = new Set<string>();
  changeLog: ChangeEntry[] = [];
  operations = new Map<string, StoredOperation>();
  categoryAliases = new Map<string, string>();
  backups = new Map<string, { deviceName: string; updatedAt: number; size: number; sha256: string }>();
  requestLog: RequestLogEntry[] = [];
  private nextFaults = new Map<string, FaultHandler[]>();
  private deviceCounter = 0;

  injectNext(pathSuffix: string, handler: FaultHandler): void {
    const queue = this.nextFaults.get(pathSuffix) ?? [];
    queue.push(handler);
    this.nextFaults.set(pathSuffix, queue);
  }

  clearFaults(): void {
    this.nextFaults.clear();
  }

  private resolveCategory(categoryId: string): string {
    let current = categoryId;
    const seen = new Set<string>();
    while (this.categoryAliases.has(current) && !seen.has(current)) {
      seen.add(current);
      current = this.categoryAliases.get(current)!;
    }
    return current;
  }

  private isTombstoneValue(entity: UserStateEntity, value: UserStateValue): boolean {
    switch (entity.kind) {
      case "bookmark":
        return !(value as UserStateValueMap["bookmark"]).bookmarked;
      case "library":
        return !(value as UserStateValueMap["library"]).inLibrary;
      case "category":
        return (value as UserStateValueMap["category"]).deleted;
      case "membership":
        return !(value as UserStateValueMap["membership"]).included;
      case "reading": {
        const r = value as UserStateValueMap["reading"];
        return r.progress === 0 && r.readAt === null;
      }
      case "resume": {
        const r = value as UserStateValueMap["resume"];
        return r.chapter === null && r.anchor === null && r.openedAt === null;
      }
      case "composition":
        return false;
    }
  }

  private valueTimestampMs(entity: UserStateEntity, value: UserStateValue): number | null {
    const normalize = (ts: number | null | undefined): number | null =>
      ts === null || ts === undefined ? null : ts < 1e11 ? ts * 1000 : ts;
    if (entity.kind === "reading") {
      return normalize((value as UserStateValueMap["reading"]).readAt);
    }
    if (entity.kind === "resume") {
      const resumeValue = value as UserStateValueMap["resume"];
      const openedAt = normalize(resumeValue.openedAt);
      const savedAt = normalize(resumeValue.anchor?.savedAt);
      if (openedAt !== null && savedAt !== null) return Math.max(openedAt, savedAt);
      return openedAt ?? savedAt;
    }
    return null;
  }

  private publishRecord(
    entity: UserStateEntity,
    value: UserStateValue,
    operationId: string,
    deviceId: string,
    deviceName: string,
    updatedAt = Date.now(),
  ): UserStateRecord {
    const key = userStateEntityKey(entity);
    const prior = this.changeLog.filter((entry) => entry.entityKey === key && entry.supersededAt === null);
    for (const entry of prior) {
      entry.supersededAt = updatedAt;
    }
    this.headRevision += 1;
    const record: UserStateRecord = {
      entity,
      value,
      revision: this.headRevision,
      operationId,
      updatedAt,
      deviceId,
      deviceName,
    };
    this.records.set(key, record);
    if (this.isTombstoneValue(entity, value)) {
      this.tombstoneKeys.add(key);
    } else {
      this.tombstoneKeys.delete(key);
    }
    this.changeLog.push({
      revision: this.headRevision,
      entityKey: key,
      record,
      supersededAt: null,
    });
    return record;
  }

  seedRemoteRecord(
    entity: UserStateEntity,
    value: UserStateValue,
    options: { operationId?: string; deviceId?: string; deviceName?: string; updatedAt?: number } = {},
  ): UserStateRecord {
    return this.publishRecord(
      entity,
      value,
      options.operationId ?? `remote-${crypto.randomUUID()}`,
      options.deviceId ?? "remote-device",
      options.deviceName ?? "Remote Tablet",
      options.updatedAt ?? Date.now(),
    );
  }

  compactSuperseded(): number {
    const before = this.changeLog.length;
    this.changeLog = this.changeLog.filter((entry) => entry.supersededAt === null);
    return before - this.changeLog.length;
  }

  stage1CleanOperations(): number {
    let cleaned = 0;
    for (const entry of this.operations.values()) {
      if (!entry.stage1Cleaned) {
        entry.result = null;
        entry.stage1Cleaned = true;
        cleaned += 1;
      }
    }
    return cleaned;
  }

  physicalGcTombstones(targetThrough?: number): number {
    let removed = 0;
    let highestGcRevision = this.compactedThrough;
    for (const [key, record] of [...this.records.entries()]) {
      if (!this.tombstoneKeys.has(key)) continue;
      highestGcRevision = Math.max(highestGcRevision, record.revision);
      this.records.delete(key);
      this.tombstoneKeys.delete(key);
      this.changeLog = this.changeLog.filter((entry) => entry.entityKey !== key);
      if (record.entity.kind === "category") {
        for (const [aliasId, canonicalId] of [...this.categoryAliases.entries()]) {
          if (canonicalId === record.entity.categoryId) {
            this.categoryAliases.delete(aliasId);
          }
        }
      }
      removed += 1;
    }
    this.compactedThrough = Math.max(
      this.compactedThrough,
      targetThrough ?? highestGcRevision,
    );
    this.seedAllowed = this.compactedThrough === 0;
    return removed;
  }

  applyPolicy2B(entity: UserStateEntity, nowMs = Date.now()): UserStateRecord | null {
    const key = userStateEntityKey(entity);
    const current = this.records.get(key);
    if (!current) return null;
    if (current.entity.kind === "reading") {
      const value = current.value as UserStateValueMap["reading"];
      return this.publishRecord(
        current.entity,
        { progress: value.progress, readAt: null },
        `policy2b-${crypto.randomUUID()}`,
        "server-retention",
        "Retention Policy",
        nowMs,
      );
    }
    if (current.entity.kind === "resume") {
      return this.publishRecord(
        current.entity,
        { chapter: null, anchor: null, openedAt: null },
        `policy2b-${crypto.randomUUID()}`,
        "server-retention",
        "Retention Policy",
        nowMs,
      );
    }
    return null;
  }

  resetWorkspace(newEpoch = `epoch-${crypto.randomUUID().slice(0, 8)}`): void {
    this.epoch = newEpoch;
    this.headRevision = 0;
    this.compactedThrough = 0;
    this.seedAllowed = true;
    this.seedCutoffAt = null;
    this.records.clear();
    this.tombstoneKeys.clear();
    this.changeLog = [];
    this.operations.clear();
    this.categoryAliases.clear();
  }

  async handle(url: string, init?: RequestInit): Promise<Response> {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\/api\/v1/, "");
    const method = (init?.method ?? "GET").toUpperCase();
    const rawBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const authHeader = new Headers(init?.headers).get("Authorization");
    const deviceKey = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    this.requestLog.push({ method, path, body: rawBody, deviceKey });

    const queue = this.nextFaults.get(path);
    if (queue?.length) {
      const handler = queue.shift()!;
      const injected = await handler({ method, path, body: rawBody, server: this });
      if (injected) return injected;
    }

    if (method === "GET" && path === "/capabilities") {
      return Response.json(this.capabilities);
    }

    if (method === "POST" && path === "/devices/register") {
      const payload = rawBody as { deviceKey: string; deviceName: string };
      const existing = this.devices.get(payload.deviceKey);
      if (existing) {
        existing.deviceName = payload.deviceName;
        if (existing.blocked) return Response.json({ message: "Device is blocked" }, { status: 403 });
        return Response.json({ id: existing.id, deviceName: existing.deviceName });
      }
      const id = `dev-${++this.deviceCounter}`;
      this.devices.set(payload.deviceKey, { id, deviceName: payload.deviceName, blocked: false });
      return Response.json({ id, deviceName: payload.deviceName });
    }

    const device = deviceKey ? this.devices.get(deviceKey) : undefined;
    if (!device) {
      return Response.json({ message: "Unauthorized" }, { status: 401 });
    }
    if (device.blocked) {
      return Response.json({ message: "Device is blocked" }, { status: 403 });
    }

    if (method === "GET" && path === "/user-state") {
      return Response.json({
        version: 1,
        workspaceId: this.workspaceId,
        epoch: this.epoch,
        headRevision: this.headRevision,
      });
    }

    if (method === "GET" && path === "/user-state/retention") {
      return Response.json({
        version: 1,
        workspaceId: this.workspaceId,
        epoch: this.epoch,
        headRevision: this.headRevision,
        compactedThrough: this.compactedThrough,
        seedAllowed: this.seedAllowed,
        seedCutoffAt: this.seedCutoffAt,
      });
    }

    if (method === "POST" && path === "/user-state/read") {
      const body = rawBody as { workspaceId: string; epoch: string; after: number; through: number; limit?: number };
      if (body.workspaceId !== this.workspaceId || body.epoch !== this.epoch) {
        return Response.json(
          { message: "User state: workspace or epoch changed; reconnect without discarding pending edits" },
          { status: 409 },
        );
      }
      if (body.after < this.compactedThrough) {
        return Response.json(
          { message: "User state: cursor has been compacted", code: "cursor-compacted" },
          { status: 410 },
        );
      }
      if (body.after > body.through || body.through > this.headRevision) {
        return Response.json({ message: "User state: cursor is ahead of the requested history" }, { status: 409 });
      }
      const matching = this.changeLog
        .filter((entry) => entry.revision > body.after && entry.revision <= body.through)
        .sort((a, b) => a.revision - b.revision)
        .map((entry) => entry.record);
      const limit = body.limit ?? matching.length;
      const sliced = matching.slice(0, limit);
      const hasMore = sliced.length < matching.length;
      const nextCursor = hasMore ? sliced[sliced.length - 1]!.revision : body.through;
      return Response.json({
        version: 1,
        workspaceId: this.workspaceId,
        epoch: this.epoch,
        headRevision: this.headRevision,
        through: body.through,
        nextCursor,
        hasMore,
        records: sliced,
      });
    }

    if (method === "POST" && path === "/user-state/snapshot") {
      const body = rawBody as { workspaceId: string; epoch: string; afterEntityKey?: string | null; limit?: number };
      if (body.workspaceId !== this.workspaceId || body.epoch !== this.epoch) {
        return Response.json(
          { message: "User state: workspace or epoch changed; reconnect without discarding pending edits" },
          { status: 409 },
        );
      }
      const ordered = [...this.records.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .filter(([key]) => (body.afterEntityKey ? key > body.afterEntityKey : true));
      const limit = body.limit ?? this.snapshotPageLimit ?? Math.max(1, ordered.length);
      const pageEntries = ordered.slice(0, limit);
      const hasMore = pageEntries.length < ordered.length;
      const nextEntityKey = hasMore ? pageEntries[pageEntries.length - 1]![0] : null;
      return Response.json({
        version: 1,
        workspaceId: this.workspaceId,
        epoch: this.epoch,
        headRevision: this.headRevision,
        snapshotRevision: this.headRevision,
        nextEntityKey,
        hasMore,
        seedAllowed: this.seedAllowed,
        seedCutoffAt: this.seedCutoffAt,
        records: pageEntries.map(([, record]) => record),
      });
    }

    if (method === "POST" && path === "/user-state/merge") {
      const body = rawBody as { workspaceId: string; epoch: string; operations: UserStateOperation[] };
      if (body.workspaceId !== this.workspaceId || body.epoch !== this.epoch) {
        return Response.json(
          { message: "User state: workspace or epoch changed; reconnect without discarding pending edits" },
          { status: 409 },
        );
      }
      const results: UserStateMergeResult[] = [];
      for (const op of body.operations) {
        const hash = canonicalUserStateJson({ entity: op.entity, value: op.value, baseRevision: op.baseRevision, seed: op.seed ?? null });
        const existingOp = this.operations.get(op.operationId);
        if (existingOp) {
          if (existingOp.stage1Cleaned || existingOp.result === null) {
            return Response.json({ message: "User state: operation receipt expired or payload mismatch" }, { status: 409 });
          }
          if (existingOp.payloadHash !== hash) {
            return Response.json({ message: "User state: an operation ID was reused with a different payload" }, { status: 409 });
          }
          results.push(existingOp.result);
          continue;
        }

        let effectiveEntity = op.entity;
        let aliasUsed: { from: string; to: string } | undefined;
        if ("categoryId" in op.entity) {
          const resolvedId = this.resolveCategory(op.entity.categoryId);
          if (resolvedId !== op.entity.categoryId) {
            effectiveEntity = { ...op.entity, categoryId: resolvedId };
            aliasUsed = { from: op.entity.categoryId, to: resolvedId };
          } else if (op.entity.kind === "category" && op.baseRevision === 0) {
            const opCategoryId = op.entity.categoryId;
            const name = (op.value as UserStateValueMap["category"]).name;
            const duplicate = [...this.records.values()].find(
              (r) =>
                r.entity.kind === "category" &&
                !(r.value as UserStateValueMap["category"]).deleted &&
                (r.value as UserStateValueMap["category"]).name === name &&
                r.entity.categoryId !== opCategoryId,
            );
            if (duplicate && duplicate.entity.kind === "category") {
              this.categoryAliases.set(opCategoryId, duplicate.entity.categoryId);
              const aliasResult: UserStateMergeResult = {
                operationId: op.operationId,
                status: "aliased",
                current: duplicate,
                categoryAlias: { from: opCategoryId, to: duplicate.entity.categoryId },
              };
              this.operations.set(op.operationId, { payloadHash: hash, result: aliasResult, stage1Cleaned: false });
              results.push(aliasResult);
              continue;
            }
          }
        }

        const key = userStateEntityKey(effectiveEntity);
        const existingRecord = this.records.get(key);
        const tsMs = this.valueTimestampMs(effectiveEntity, op.value);
        const blockedByGc = op.seed === true && !existingRecord && !this.seedAllowed;
        const blockedByCutoff =
          op.seed === true && !existingRecord && this.seedCutoffAt !== null && tsMs !== null && tsMs < this.seedCutoffAt;

        let result: UserStateMergeResult;
        if (op.seed === true && existingRecord) {
          result = {
            operationId: op.operationId,
            status: "seed-skipped",
            current: existingRecord,
          };
        } else if (blockedByGc || blockedByCutoff) {
          result = {
            operationId: op.operationId,
            status: "seed-skipped",
            current: null,
          };
        } else if (
          existingRecord &&
          canonicalUserStateJson(existingRecord.value) === canonicalUserStateJson(op.value)
        ) {
          result = {
            operationId: op.operationId,
            status: "unchanged",
            current: existingRecord,
            ...(aliasUsed ? { categoryAlias: aliasUsed } : {}),
          };
        } else {
          const next = this.publishRecord(effectiveEntity, op.value, op.operationId, device.id, device.deviceName);
          result = {
            operationId: op.operationId,
            status: "applied",
            current: next,
            ...(aliasUsed ? { categoryAlias: aliasUsed } : {}),
          };
        }
        this.operations.set(op.operationId, { payloadHash: hash, result, stage1Cleaned: false });
        results.push(result);
      }
      return Response.json({
        version: 1,
        workspaceId: this.workspaceId,
        epoch: this.epoch,
        headRevision: this.headRevision,
        results,
      });
    }

    if (path.startsWith("/device-backups/")) {
      const name = decodeURIComponent(path.slice("/device-backups/".length));
      if (method === "DELETE") {
        const deleted = this.backups.delete(name);
        if (!deleted) return Response.json({ message: "No backup exists for this device" }, { status: 404 });
        return Response.json({ deleted: true, deviceName: name });
      }
    }

    return Response.json({ message: `Unhandled simulated endpoint: ${method} ${path}` }, { status: 404 });
  }
}

interface ClientFixture {
  name: string;
  sql: DatabaseSync;
  db: Database;
  queue: Promise<unknown>;
  storage: Map<string, string>;
  ipcCallLog: { command: string; args: Record<string, unknown> }[];
  ipc: ReturnType<typeof createUserStateIpcHandler>;
}

const clients: ClientFixture[] = [];
let activeClient!: ClientFixture;
let activeServer!: SimulatedContentServer;

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
    ipcCallLog: [],
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
  options: { inLibrary?: boolean; lastReadAt?: number | null; chapters?: { id: number; path: string; name: string; progress?: number; unread?: number; readAt?: number | null; bookmark?: number }[] } = {},
): void {
  client.sql
    .prepare(
      "INSERT INTO novel(id,plugin_id,source_novel_id,path,name,in_library,last_read_at) VALUES(?,?,?,?,?,?,?)",
    )
    .run(
      novelId,
      work.pluginId,
      work.sourceNovelId,
      work.novelPath,
      work.name,
      options.inLibrary ? 1 : 0,
      options.lastReadAt ?? null,
    );
  const chapters = options.chapters ?? [{ id: novelId * 10 + 1, path: "/chapter/1", name: "Chapter 1" }];
  for (let i = 0; i < chapters.length; i += 1) {
    const ch = chapters[i]!;
    client.sql
      .prepare(
        "INSERT INTO chapter(id,novel_id,path,name,chapter_number,position,progress,read_at,bookmark) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        ch.id,
        novelId,
        ch.path,
        ch.name,
        String(i + 1),
        i + 1,
        ch.progress ?? 0,
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

function activateClient(client: ClientFixture, serverUrl = SERVER_URL): void {
  const prevServer = useContentSyncStore.getState().serverUrl;
  if (prevServer) {
    const prevKey = activeClient?.storage.get(`norea-content-device:${prevServer}`);
    if (prevKey) forgetContentDeviceRegistration(prevServer, prevKey);
  }
  activeClient = client;
  stubStorageForClient(client);
  mocks.deviceNameQuery = client.name;
  useContentSyncStore.setState({ serverUrl, deviceName: client.name, deviceKey: null });
  setUserStateActiveServer(serverUrl || null);
}

interface ElementProps {
  children?: ReactNode;
  label?: string;
  "aria-label"?: string;
  onClick?: () => void;
  disabled?: boolean;
  checked?: boolean;
  onChange?: (event: { currentTarget: { checked: boolean } }) => void;
}

function collectElements(node: ReactNode): ReactElement<ElementProps>[] {
  if (Array.isArray(node)) return node.flatMap(collectElements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const el = node as ReactElement<ElementProps>;
  return [el, ...collectElements(el.props.children)];
}

async function renderSettingsControls(
  serverUrl = SERVER_URL,
  overrideStatus?: Partial<UserStateStatus>,
): Promise<ReactElement<ElementProps>[]> {
  const status = await getUserStateStatus();
  mocks.queryStatus = overrideStatus ? { ...status, ...overrideStatus } : status;
  return collectElements(ReadingStateSettings({ serverUrl }));
}

function makeRemoteRecord(
  entity: UserStateEntity,
  value: UserStateValue,
  revision: number,
  operationId = `op-${revision}`,
): UserStateRecord {
  return {
    entity,
    value,
    revision,
    operationId,
    updatedAt: revision * 1000,
    deviceId: "other-device",
    deviceName: "Other Device",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  activeServer = new SimulatedContentServer();

  const clientA = createSqliteFixture("Client A");
  stubStorageForClient(clientA);
  useContentSyncStore.setState({ serverUrl: "", deviceName: "", deviceKey: null, status: "idle", error: null });
  useUserStateStore.setState({ enabledByServer: {}, runtimeByServer: {}, retentionByServer: {}, retentionStatusByServer: {} });
  useAppearanceStore.setState({ appLocale: "en" });

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
  mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => activeServer.handle(url, init));

  mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    activeClient.ipcCallLog.push({ command, args });
    const handled = await activeClient.ipc.handle(command, args);
    if (handled.handled) return handled.result;
    if (command === "get_default_device_name") return activeClient.name;
    if (command === "device_backup_create") {
      return {
        path: `/tmp/${activeClient.name}-backup.zip`,
        size: 4096,
        sha256: "b".repeat(64),
      };
    }
    if (command === "device_backup_upload") {
      const entry = {
        deviceName: String(args.deviceName),
        updatedAt: Math.floor(Date.now() / 1000),
        size: 4096,
        sha256: "b".repeat(64),
      };
      activeServer.backups.set(entry.deviceName, entry);
      return entry;
    }
    if (command === "device_backup_cleanup") return undefined;
    throw new Error(`Unhandled IPC command in e2e-retention.test.ts: ${command}`);
  });

  activateClient(clientA, SERVER_URL);
});

afterEach(async () => {
  setUserStateActiveServer(null);
  await waitForUserStateDeferredApply();
  while (clients.length) {
    const client = clients.pop()!;
    client.sql.close();
  }
  useContentSyncStore.setState({ serverUrl: "", deviceName: "", deviceKey: null });
  useUserStateStore.setState({ enabledByServer: {}, runtimeByServer: {}, retentionByServer: {}, retentionStatusByServer: {} });
  useAppearanceStore.setState({ appLocale: "en" });
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Client E2E — Tier 1: Feature Coverage", () => {
  it("T1-A3: enforces strict protocol schemas and accepts seed-skipped with null record", () => {
    const workspace = parseUserStateWorkspace({
      version: 1,
      workspaceId: "ws-1",
      epoch: "epoch-1",
      headRevision: 5,
    });
    expect(workspace.headRevision).toBe(5);

    const readRes = parseUserStateReadResponse({
      version: 1,
      workspaceId: "ws-1",
      epoch: "epoch-1",
      headRevision: 5,
      through: 5,
      nextCursor: 5,
      hasMore: false,
      records: [
        makeRemoteRecord(
          { kind: "bookmark", work: DEFAULT_WORK, chapter: { chapterPath: "/chapter/1", name: "Ch 1" } },
          { bookmarked: true },
          5,
        ),
      ],
    });
    expect(readRes.records).toHaveLength(1);

    const seedSkippedNull = parseUserStateMergeResult({
      operationId: "op-seed-skip",
      status: "seed-skipped",
      current: null,
    });
    expect(seedSkippedNull).toEqual({
      operationId: "op-seed-skip",
      status: "seed-skipped",
      current: null,
    });

    const mergeRes = parseUserStateMergeResponse({
      version: 1,
      workspaceId: "ws-1",
      epoch: "epoch-1",
      headRevision: 5,
      results: [seedSkippedNull],
    });
    expect(mergeRes.results[0]?.status).toBe("seed-skipped");

    const retentionRes = parseUserStateRetentionResponse({
      version: 1,
      workspaceId: "ws-1",
      epoch: "epoch-1",
      headRevision: 5,
      compactedThrough: 2,
      seedAllowed: false,
      seedCutoffAt: 1_700_000_000_000,
    });
    expect(retentionRes).toEqual({
      version: 1,
      workspaceId: "ws-1",
      epoch: "epoch-1",
      headRevision: 5,
      compactedThrough: 2,
      seedAllowed: false,
      seedCutoffAt: 1_700_000_000_000,
    });

    const snapRecord = makeRemoteRecord(
      { kind: "bookmark", work: DEFAULT_WORK, chapter: { chapterPath: "/chapter/1", name: "Ch 1" } },
      { bookmarked: true },
      5,
    );
    const snapPage1 = parseUserStateSnapshotResponse({
      version: 1,
      workspaceId: "ws-1",
      epoch: "epoch-1",
      headRevision: 5,
      snapshotRevision: 5,
      nextEntityKey: userStateEntityKey(snapRecord.entity),
      hasMore: true,
      seedAllowed: true,
      seedCutoffAt: null,
      records: [snapRecord],
    });
    expect(snapPage1.hasMore).toBe(true);
    expect(snapPage1.records).toHaveLength(1);

    const snapFinal = parseUserStateSnapshotResponse({
      version: 1,
      workspaceId: "ws-1",
      epoch: "epoch-1",
      headRevision: 5,
      snapshotRevision: 5,
      nextEntityKey: null,
      hasMore: false,
      seedAllowed: false,
      seedCutoffAt: 1_700_000_000_000,
      records: [],
    });
    expect(snapFinal.hasMore).toBe(false);
    expect(snapFinal.nextEntityKey).toBeNull();
    expect(snapFinal.seedCutoffAt).toBe(1_700_000_000_000);
  });

  it("T1-A5: runs multi-cycle synchronizeUserState with monotonic observedHead and updates lastSuccessAt", async () => {
    addWorkToClient(activeClient, 1, DEFAULT_WORK);
    await setChapterBookmark(11, true);
    await synchronizeUserState();
    await waitForUserStateDeferredApply();

    const afterFirst = await getUserStateStatus();
    expect(afterFirst.workspaceId).toBe(activeServer.workspaceId);
    expect(afterFirst.epoch).toBe(activeServer.epoch);
    expect(afterFirst.pending).toBe(0);
    expect(afterFirst.lastSuccessAt).not.toBeNull();
    const head1 = activeServer.headRevision;
    expect(head1).toBeGreaterThanOrEqual(1);

    await updateChapterProgress(11, 75);
    await synchronizeUserState();
    await waitForUserStateDeferredApply();

    const afterSecond = await getUserStateStatus();
    expect(afterSecond.pending).toBe(0);
    expect(activeServer.headRevision).toBeGreaterThan(head1);
    const binding = (await getUserStateBinding(SERVER_URL))!;
    const ledger = await getUserStateLedgerStatus(binding);
    expect(ledger.cursor).toBe(activeServer.headRevision);
  });

  it("T1-D5: enforces server seedCutoffAt on seed sync while preserving older local history", async () => {
    const cutoffMs = 1_700_000_000_000;
    activeServer.seedCutoffAt = cutoffMs;
    activeServer.seedAllowed = true;
    addWorkToClient(activeClient, 1, DEFAULT_WORK, {
      chapters: [
        { id: 11, path: "/chapter/1", name: "Old Ch", progress: 100, unread: 0, readAt: 1_650_000_000 },
        { id: 12, path: "/chapter/2", name: "New Ch", progress: 100, unread: 0, readAt: 1_750_000_000 },
      ],
    });

    await synchronizeUserState();
    await waitForUserStateDeferredApply();

    const mergeBodies = activeServer.requestLog
      .filter((entry) => entry.path === "/user-state/merge")
      .flatMap((entry) => (entry.body as { operations: UserStateOperation[] }).operations);
    const oldSeedSent = mergeBodies.find(
      (op) => op.entity.kind === "reading" && op.entity.chapter.chapterPath === "/chapter/1",
    );
    const newSeedSent = mergeBodies.find(
      (op) => op.entity.kind === "reading" && op.entity.chapter.chapterPath === "/chapter/2",
    );
    expect(newSeedSent).toBeDefined();
    expect(oldSeedSent).toBeUndefined();
    expect(activeClient.sql.prepare("SELECT read_at FROM chapter WHERE id=11").get()).toEqual({
      read_at: 1_650_000_000,
    });
  });

  it("T1-D6: keeps automatic sharing and retention disabled by default with en/ko i18n parity", async () => {
    const elements = await renderSettingsControls(SERVER_URL);
    const autoSwitch = elements.find((item) => item.props["aria-label"] === enMessages["userState.automatic"]);
    expect(autoSwitch?.props.checked).toBe(false);
    expect(useUserStateStore.getState().enabledByServer).toEqual({});

    const settingsSource = readFileSync("src/components/ReadingStateSettings.tsx", "utf8");
    const keys = [
      ...new Set(
        [
          ...settingsSource.matchAll(/description=\{\s*t\(\s*"([^"]+)"/g),
          ...settingsSource.matchAll(/t\(\s*"([^"]*[dD]escription[^"]*)"/g),
        ].map((match) => match[1]!),
      ),
    ];
    for (const key of keys) {
      const enVal = (enMessages as Record<string, string>)[key];
      const koVal = (koMessages as Record<string, string>)[key];
      expect(enVal, `missing en key ${key}`).toBeTypeOf("string");
      expect(koVal, `missing ko key ${key}`).toBeTypeOf("string");
      expect(enVal.length, key).toBeLessThanOrEqual(120);
      expect(koVal.length, key).toBeLessThanOrEqual(120);
    }
  });

  it("T1-E6: handles 410 Gone via paginated /snapshot and reconciles absent records without seed resurrection", async () => {
    const ch1 = { chapterPath: "/chapter/1", name: "Ch 1" };
    const ch2 = { chapterPath: "/chapter/2", name: "Ch 2" };
    const ch3 = { chapterPath: "/chapter/3", name: "Ch 3" };
    addWorkToClient(activeClient, 1, DEFAULT_WORK, {
      chapters: [
        { id: 11, path: ch1.chapterPath, name: ch1.name, bookmark: 0 },
        { id: 12, path: ch2.chapterPath, name: ch2.name, bookmark: 0 },
        { id: 13, path: ch3.chapterPath, name: ch3.name, bookmark: 0 },
      ],
    });

    const bmA: UserStateEntity = { kind: "bookmark", work: DEFAULT_WORK, chapter: ch1 };
    const bmB: UserStateEntity = { kind: "bookmark", work: DEFAULT_WORK, chapter: ch2 };
    const bmC: UserStateEntity = { kind: "bookmark", work: DEFAULT_WORK, chapter: ch3 };
    activeServer.seedRemoteRecord(bmA, { bookmarked: true });
    activeServer.seedRemoteRecord(bmB, { bookmarked: true });
    activeServer.seedRemoteRecord(bmC, { bookmarked: true });

    await synchronizeUserState();
    await waitForUserStateDeferredApply();
    expect(activeClient.sql.prepare("SELECT id,bookmark FROM chapter ORDER BY id").all()).toEqual([
      { id: 11, bookmark: 1 },
      { id: 12, bookmark: 1 },
      { id: 13, bookmark: 1 },
    ]);

    // Remote deletes bmB and server physically GCs the tombstone; force multi-page /snapshot.
    activeServer.seedRemoteRecord(bmB, { bookmarked: false });
    activeServer.physicalGcTombstones();
    expect(activeServer.compactedThrough).toBeGreaterThanOrEqual(4);
    activeServer.snapshotPageLimit = 1;
    activeServer.requestLog = [];

    await synchronizeUserState();
    await waitForUserStateDeferredApply();

    const snapshotRequests = activeServer.requestLog.filter((req) => req.path === "/user-state/snapshot");
    expect(snapshotRequests).toHaveLength(2);
    expect((snapshotRequests[1]!.body as { afterEntityKey?: string | null }).afterEntityKey).toBe(
      userStateEntityKey(bmA),
    );
    const binding = (await getUserStateBinding(SERVER_URL))!;
    const ledger = await getUserStateLedgerStatus(binding);
    expect(ledger.cursor).toBe(activeServer.headRevision);
    expect(
      activeClient.sql
        .prepare("SELECT COUNT(*) AS c FROM user_state_record WHERE entity_key=?")
        .get(userStateEntityKey(bmB)),
    ).toEqual({ c: 0 });
    expect(activeClient.sql.prepare("SELECT id,bookmark FROM chapter ORDER BY id").all()).toEqual([
      { id: 11, bookmark: 1 },
      { id: 12, bookmark: 0 },
      { id: 13, bookmark: 1 },
    ]);
    // Absent entity must never be converted into a seed: true resurrection upload.
    const mergeOps = activeServer.requestLog
      .filter((req) => req.path === "/user-state/merge")
      .flatMap((req) => (req.body as { operations: UserStateOperation[] }).operations);
    expect(mergeOps.some((op) => userStateEntityKey(op.entity) === userStateEntityKey(bmB) && op.seed === true)).toBe(
      false,
    );
  });

  it("T1-F1: verifies 0015 migration registration, schema parity, and incremental auto_vacuum contract", () => {
    const databaseRs = readFileSync("src-tauri/src/database.rs", "utf8");
    const migrationMatches = [
      ...databaseRs.matchAll(/version:\s*(\d+),\s*description:[\s\S]*?sql:\s*include_str!\("([^"]+)"\)/g),
    ];
    const versions = migrationMatches.map((m) => Number(m[1]));
    expect(versions).toContain(15);
    expect(versions).toContain(16);
    expect(databaseRs).toMatch(/auto_vacuum\s*=\s*INCREMENTAL/i);

    const db = new DatabaseSync(":memory:");
    try {
      db.exec("PRAGMA auto_vacuum = INCREMENTAL");
      for (const match of migrationMatches) {
        db.exec(readFileSync(`src-tauri/src/${match[2]}`, "utf8"));
      }
      expect(db.prepare("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: 2 });
      for (const table of Object.values(schema).filter((value) => is(value, SQLiteTable))) {
        const config = getTableConfig(table);
        const columns = db.prepare(`PRAGMA table_info('${config.name}')`).all() as { name: string }[];
        expect(columns.map((c) => c.name).sort(), config.name).toEqual(
          config.columns.map((c) => c.name).sort(),
        );
      }
    } finally {
      db.close();
    }
  });

  it("T1-F2: clearReadingProgress records only changed, shared-record, or private chapters and cleared resumes", async () => {
    const chapters = [
      { id: 11, path: "/ch/1", name: "Read 1", progress: 100, unread: 0, readAt: 1000 },
      { id: 12, path: "/ch/2", name: "Read 2", progress: 50, unread: 0, readAt: 1100 },
      { id: 13, path: "/ch/3", name: "Shared Record", progress: 0, unread: 1, readAt: null },
      { id: 14, path: "/ch/4", name: "Private Record", progress: 0, unread: 1, readAt: null },
      ...Array.from({ length: 6 }, (_, i) => ({
        id: 15 + i,
        path: `/ch/${5 + i}`,
        name: `Untouched ${5 + i}`,
        progress: 0,
        unread: 1,
        readAt: null,
      })),
    ];
    addWorkToClient(activeClient, 1, DEFAULT_WORK, { inLibrary: true, lastReadAt: 1100, chapters });

    const binding: UserStateBinding = {
      serverUrl: SERVER_URL,
      workspaceId: activeServer.workspaceId,
      epoch: activeServer.epoch,
    };
    await runTx(activeClient, (db) => bindUserStateWorkspaceInDb(db, binding));

    // Seed shared user_state_record on chapter 13 and user_state_private on chapter 14.
    const ch3Entity: UserStateEntity = { kind: "reading", work: DEFAULT_WORK, chapter: { chapterPath: "/ch/3", name: "Shared Record" } };
    await applyUserStateReadPageInDb(activeClient.db, binding, {
      version: 1,
      workspaceId: binding.workspaceId,
      epoch: binding.epoch,
      headRevision: 1,
      through: 1,
      nextCursor: 1,
      hasMore: false,
      records: [makeRemoteRecord(ch3Entity, { progress: 0, readAt: null }, 1)],
    });
    const ch4Key = userStateEntityKey({ kind: "reading", work: DEFAULT_WORK, chapter: { chapterPath: "/ch/4", name: "Private Record" } });
    activeClient.sql
      .prepare("INSERT INTO user_state_private(entity_key,public_value_json) VALUES(?,?)")
      .run(ch4Key, JSON.stringify({ progress: 0, readAt: null }));

    await clearReadingProgress();

    const intents = activeClient.sql
      .prepare(
        `SELECT entity_key AS entityKey, json_extract(entity_json,'$.kind') AS kind
         FROM user_state_intent
         WHERE json_extract(entity_json,'$.kind') IN ('reading','resume')
         ORDER BY sequence`,
      )
      .all() as { entityKey: string; kind: string }[];
    // 4 eligible reading chapters + 1 cleared resume = 5 intents; 6 untouched chapters produce 0 intents.
    expect(intents).toHaveLength(5);
    for (let i = 5; i <= 10; i += 1) {
      const untouchedKey = userStateEntityKey({
        kind: "reading",
        work: DEFAULT_WORK,
        chapter: { chapterPath: `/ch/${i}`, name: `Untouched ${i}` },
      });
      expect(intents.some((row) => row.entityKey === untouchedKey)).toBe(false);
    }
  });

  it("T1-F3: db_user_state_prune_operations deletes old acknowledged rows and preserves recent, pending, and conflict rows", async () => {
    const binding: UserStateBinding = {
      serverUrl: SERVER_URL,
      workspaceId: activeServer.workspaceId,
      epoch: activeServer.epoch,
    };
    await runTx(activeClient, (db) => bindUserStateWorkspaceInDb(db, binding));
    const ns = JSON.stringify([binding.serverUrl, binding.workspaceId, binding.epoch]);
    const nowSecs = Math.floor(Date.now() / 1000);
    const oldSecs = nowSecs - 60 * 60 * 24 * 60;

    activeClient.sql
      .prepare(
        `INSERT INTO user_state_operation(operation_id,namespace,entity_key,intent_sequence,payload,status,receipt,acknowledged_at)
         VALUES
         ('op-old-ack', ?, 'k1', 1, '{}', 'acknowledged', '{}', ?),
         ('op-recent-ack', ?, 'k2', 2, '{}', 'acknowledged', '{}', ?),
         ('op-pending', ?, 'k3', 3, '{}', 'pending', NULL, NULL),
         ('op-conflict', ?, 'k4', 4, '{}', 'conflict', '{}', NULL)`,
      )
      .run(ns, oldSecs, ns, nowSecs - 60, ns, ns);

    await mocks.invoke("db_user_state_prune_operations", {
      binding,
      olderThanSecs: 60 * 60 * 24 * 30,
    });

    const remaining = activeClient.sql
      .prepare("SELECT operation_id AS id FROM user_state_operation ORDER BY operation_id")
      .all() as { id: string }[];
    expect(remaining.map((r) => r.id)).toEqual(["op-conflict", "op-pending", "op-recent-ack"]);
  });

  it("T1-F4: has_attempt detects user_state_progress.acknowledged_sequence > 0 after acknowledged operations are pruned", async () => {
    const opaqueWork: UserStateWorkReference = { ...DEFAULT_WORK, sourceNovelId: null };
    addWorkToClient(activeClient, 1, opaqueWork);

    const binding: UserStateBinding = {
      serverUrl: SERVER_URL,
      workspaceId: activeServer.workspaceId,
      epoch: activeServer.epoch,
    };
    await runTx(activeClient, (db) => bindUserStateWorkspaceInDb(db, binding));
    const ns = JSON.stringify([binding.serverUrl, binding.workspaceId, binding.epoch]);
    const entity: UserStateEntity = { kind: "bookmark", work: opaqueWork, chapter: { chapterPath: "/chapter/1", name: "Chapter 1" } };
    const oldKey = userStateEntityKey(entity);

    await runTx(activeClient, (db) =>
      recordUserStateChangesInDb(db, [{ entity, value: { bookmarked: true } }]),
    );
    const [op] = await runTx(activeClient, (db) =>
      prepareUserStateOperationsInDb(db, binding, { allowOpaqueIdentity: true }),
    );
    expect(op).toBeDefined();
    await runTx(activeClient, (db) =>
      acknowledgeUserStateOperationsInDb(db, binding, [
        { operationId: op!.operationId, status: "applied", current: makeRemoteRecord(entity, { bookmarked: true }, 1, op!.operationId) },
      ]),
    );

    // Simulate operation row pruned while acknowledged_sequence remains > 0.
    activeClient.sql.exec("DELETE FROM user_state_operation");
    const progress = activeClient.sql
      .prepare("SELECT acknowledged_sequence AS ack FROM user_state_progress WHERE namespace=? AND entity_key=?")
      .get(ns, oldKey) as { ack: number };
    expect(progress.ack).toBeGreaterThan(0);

    // Now the work gains a sourceNovelId; refresh must recognize prior attempt and keep entity_key untouched.
    activeClient.sql.exec("UPDATE novel SET source_novel_id='novel-42'");
    await runTx(activeClient, (db) => refreshUnattemptedUserStateIdentitiesInDb(db));

    const intentRow = activeClient.sql.prepare("SELECT entity_key AS entityKey FROM user_state_intent").get() as {
      entityKey: string;
    };
    expect(intentRow.entityKey).toBe(oldKey);
    expect(await runTx(activeClient, (db) => prepareUserStateOperationsInDb(db, binding, { allowOpaqueIdentity: true }))).toEqual(
      [],
    );
  });

  it("T1-F5: uploadDeviceBackup awaits synchronizeUserState before device_backup_create snapshots norea.db", async () => {
    addWorkToClient(activeClient, 1, DEFAULT_WORK);
    useUserStateStore.getState().setEnabled(SERVER_URL, true);
    await setChapterBookmark(11, true);

    await uploadDeviceBackup(SERVER_URL);

    const mergeIndex = activeServer.requestLog.findIndex((entry) => entry.path === "/user-state/merge");
    const createIndex = activeClient.ipcCallLog.findIndex((entry) => entry.command === "device_backup_create");
    expect(mergeIndex).toBeGreaterThanOrEqual(0);
    expect(createIndex).toBeGreaterThanOrEqual(0);

    // Outbox must be drained by synchronizeUserState before device_backup_create runs.
    const binding = (await getUserStateBinding(SERVER_URL))!;
    const status = await getUserStateLedgerStatus(binding);
    expect(status.pending).toBe(0);

    // Verify merge occurred strictly before device_backup_create in chronological event flow.
    const ackIndex = activeClient.ipcCallLog.findIndex(
      (entry) => entry.command === "db_user_state_acknowledge_operations",
    );
    expect(ackIndex).toBeGreaterThanOrEqual(0);
    expect(ackIndex).toBeLessThan(createIndex);
  });

  it("T1-G1: detects epoch change from GET /user-state and retains pending edits without auto-overwriting workspace", async () => {
    addWorkToClient(activeClient, 1, DEFAULT_WORK);
    await setChapterBookmark(11, true);
    await synchronizeUserState();
    await waitForUserStateDeferredApply();

    // Local pending edit after initial sync.
    await updateChapterProgress(11, 60);
    activeServer.resetWorkspace("epoch-2");

    await expect(synchronizeUserState()).rejects.toThrow(/workspace|epoch/i);

    const binding = (await getUserStateBinding(SERVER_URL))!;
    expect(binding.epoch).toBe("epoch-1");
    const status = await getUserStateStatus();
    expect(status.pending).toBe(1);
    expect(status.epochMismatch?.serverEpoch).toBe("epoch-2");
  });

  it("T1-G2: ReadingStateSettings renders explicit Mode A (Re-seed) and Mode B (Start fresh) actions when epoch mismatch is active", async () => {
    addWorkToClient(activeClient, 1, DEFAULT_WORK);
    await synchronizeUserState();
    activeServer.resetWorkspace("epoch-2");
    await expect(synchronizeUserState()).rejects.toThrow();

    const enElements = await renderSettingsControls(SERVER_URL);
    const buttonTexts = enElements
      .map((el) => (typeof el.props.children === "string" ? el.props.children : el.props.label ?? ""))
      .filter(Boolean);

    expect(buttonTexts.some((text) => /re-?seed|reupload/i.test(text))).toBe(true);
    expect(buttonTexts.some((text) => /start fresh|fresh/i.test(text))).toBe(true);

    const syncNowButton = enElements.find(
      (el) => el.props.label === enMessages["userState.syncNow"] && el.props.onClick,
    );
    expect(syncNowButton?.props.disabled).toBe(true);

    const cutoffElements = await renderSettingsControls(SERVER_URL, { seedCutoffAt: 1_700_000_000_000 });
    const cutoffTexts = cutoffElements
      .map((el) => (typeof el.props.children === "string" ? el.props.children : ""))
      .filter(Boolean);
    expect(cutoffTexts.some((text) => /retains reading history since/i.test(text))).toBe(true);

    useAppearanceStore.setState({ appLocale: "ko" });
    const koElements = await renderSettingsControls(SERVER_URL);
    const koTexts = koElements
      .map((el) => (typeof el.props.children === "string" ? el.props.children : el.props.label ?? ""))
      .filter(Boolean);
    expect(koTexts.length).toBeGreaterThan(0);
    expect(koTexts).not.toEqual(buttonTexts);

    useAppearanceStore.setState({ appLocale: "en" });
    const modeAButton = enElements.find(
      (el) => el.props.children === enMessages["userState.epochMismatchReseed"] && el.props.onClick,
    );
    expect(modeAButton?.props.disabled).toBe(false);
    modeAButton!.props.onClick!();
    await vi.waitFor(async () => {
      const binding = await getUserStateBinding(SERVER_URL);
      expect(binding?.epoch).toBe("epoch-2");
      expect(useUserStateStore.getState().runtimeByServer[SERVER_URL]?.epochMismatch).toBeUndefined();
    });
    expect(
      activeClient.ipcCallLog.some(
        (call) => call.command === "db_user_state_rebind_workspace" && call.args.mode === "reseed",
      ),
    ).toBe(true);

    activeServer.resetWorkspace("epoch-3");
    await expect(synchronizeUserState()).rejects.toThrow();
    const enElements2 = await renderSettingsControls(SERVER_URL);
    const modeBButton = enElements2.find(
      (el) => el.props.children === enMessages["userState.epochMismatchFresh"] && el.props.onClick,
    );
    expect(modeBButton?.props.disabled).toBe(false);
    modeBButton!.props.onClick!();
    await vi.waitFor(async () => {
      const binding = await getUserStateBinding(SERVER_URL);
      expect(binding?.epoch).toBe("epoch-3");
      expect(useUserStateStore.getState().runtimeByServer[SERVER_URL]?.epochMismatch).toBeUndefined();
    });
    expect(
      activeClient.ipcCallLog.some(
        (call) => call.command === "db_user_state_rebind_workspace" && call.args.mode === "start_fresh",
      ),
    ).toBe(true);
  });

  it("T1-G3: Mode A (reseed) rebinds workspace to new epoch at cursor 0 and re-seeds local state", async () => {
    addWorkToClient(activeClient, 1, DEFAULT_WORK, {
      inLibrary: true,
      chapters: [{ id: 11, path: "/chapter/1", name: "Ch 1", progress: 85, unread: 0, readAt: 1_700_000_050 }],
    });
    await synchronizeUserState();
    activeServer.resetWorkspace("epoch-2");
    await expect(synchronizeUserState()).rejects.toThrow();

    activeClient.ipcCallLog = [];
    await rebindUserStateWorkspace("reseed");
    await waitForUserStateDeferredApply();

    const rebindCall = activeClient.ipcCallLog.find((c) => c.command === "db_user_state_rebind_workspace");
    expect(rebindCall?.args).toEqual({
      binding: { serverUrl: SERVER_URL, workspaceId: activeServer.workspaceId, epoch: "epoch-2" },
      mode: "reseed",
      seedCutoffMs: null,
      seedAllowed: true,
    });
    expect(useUserStateStore.getState().runtimeByServer[SERVER_URL]?.epochMismatch).toBeUndefined();

    const binding = (await getUserStateBinding(SERVER_URL))!;
    expect(binding.epoch).toBe("epoch-2");
    expect(activeServer.records.size).toBeGreaterThanOrEqual(2);
    expect(activeServer.headRevision).toBeGreaterThanOrEqual(2);
  });

  it("T1-G4: Mode B (start_fresh) binds new epoch at headRevision without re-uploading pre-epoch local history", async () => {
    const chapters = Array.from({ length: 20 }, (_, i) => ({
      id: 11 + i,
      path: `/chapter/${i + 1}`,
      name: `Ch ${i + 1}`,
      progress: 100,
      unread: 0,
      readAt: 1_700_000_000 + i,
    }));
    addWorkToClient(activeClient, 1, DEFAULT_WORK, { inLibrary: true, chapters });
    await synchronizeUserState();
    expect(activeServer.headRevision).toBeGreaterThanOrEqual(20);

    activeServer.resetWorkspace("epoch-2");
    for (let i = 1; i <= 5; i += 1) {
      activeServer.seedRemoteRecord(
        { kind: "bookmark", work: DEFAULT_WORK, chapter: { chapterPath: `/remote/${i}`, name: `R${i}` } },
        { bookmarked: true },
      );
    }
    expect(activeServer.headRevision).toBe(5);
    activeServer.requestLog = [];
    activeClient.ipcCallLog = [];

    await rebindUserStateWorkspace("start_fresh");
    await waitForUserStateDeferredApply();

    const rebindCall = activeClient.ipcCallLog.find((c) => c.command === "db_user_state_rebind_workspace");
    expect(rebindCall?.args).toEqual({
      binding: { serverUrl: SERVER_URL, workspaceId: activeServer.workspaceId, epoch: "epoch-2" },
      mode: "start_fresh",
      headRevision: 5,
      seedCutoffMs: null,
    });
    const binding = (await getUserStateBinding(SERVER_URL))!;
    expect(binding.epoch).toBe("epoch-2");
    const ledger = await getUserStateLedgerStatus(binding);
    expect(ledger.cursor).toBe(5);
    expect(activeServer.requestLog.some((req) => req.path === "/user-state/merge")).toBe(false);
    expect(activeServer.headRevision).toBe(5);
  });

  it("T1-G5: after Mode B rebind, only post-rebind chapter edits upload while pre-epoch chapters stay local-only", async () => {
    const chapters = Array.from({ length: 21 }, (_, i) => ({
      id: 11 + i,
      path: `/chapter/${i + 1}`,
      name: `Ch ${i + 1}`,
      progress: i < 20 ? 100 : 0,
      unread: i < 20 ? 0 : 1,
      readAt: i < 20 ? 1_700_000_000 + i : null,
    }));
    addWorkToClient(activeClient, 1, DEFAULT_WORK, { inLibrary: true, chapters });
    await synchronizeUserState();
    activeServer.resetWorkspace("epoch-2");

    await rebindUserStateWorkspace("start_fresh");
    activeServer.requestLog = [];

    // Post-rebind edit on chapter 21 only.
    await updateChapterProgress(31, 100);
    await synchronizeUserState();

    const uploadedOps = activeServer.requestLog
      .filter((req) => req.path === "/user-state/merge")
      .flatMap((req) => (req.body as { operations: UserStateOperation[] }).operations);
    expect(uploadedOps).toHaveLength(1);
    expect(uploadedOps[0]?.entity).toMatchObject({
      kind: "reading",
      chapter: { chapterPath: "/chapter/21" },
    });
    expect(activeServer.records.size).toBe(1);
  });
});

describe("Client E2E — Tier 2: Boundary & Corner Cases", () => {
  it("T2-A2: rejects unexpected fields and boundary violations on /user-state, /retention, /read, /snapshot, and /merge", async () => {
    addWorkToClient(activeClient, 1, DEFAULT_WORK);
    await setChapterBookmark(11, true);

    activeServer.injectNext("/user-state", () =>
      Response.json({ version: 1, workspaceId: activeServer.workspaceId, epoch: activeServer.epoch, headRevision: 0, extra: 1 }),
    );
    await expect(synchronizeUserState()).rejects.toThrow(/unexpected field/i);
    expect((await getUserStateStatus()).pending).toBe(1);

    activeServer.injectNext("/user-state/retention", () =>
      Response.json({
        version: 1,
        workspaceId: activeServer.workspaceId,
        epoch: activeServer.epoch,
        headRevision: 0,
        compactedThrough: 0,
        seedAllowed: true,
        seedCutoffAt: null,
        extraRetention: true,
      }),
    );
    await expect(synchronizeUserState()).rejects.toThrow(/unexpected field/i);

    activeServer.seedRemoteRecord(
      { kind: "bookmark", work: DEFAULT_WORK, chapter: { chapterPath: "/chapter/1", name: "Ch 1" } },
      { bookmarked: true },
    );
    activeServer.injectNext("/user-state/read", () =>
      Response.json({
        version: 1,
        workspaceId: activeServer.workspaceId,
        epoch: activeServer.epoch,
        headRevision: 1,
        through: 1,
        nextCursor: 1,
        hasMore: false,
        records: [],
        extra: true,
      }),
    );
    await expect(synchronizeUserState()).rejects.toThrow(/unexpected field/i);

    activeServer.injectNext("/user-state/read", () =>
      Response.json({ message: "User state: cursor has been compacted", code: "cursor-compacted" }, { status: 410 }),
    );
    activeServer.injectNext("/user-state/snapshot", () =>
      Response.json({
        version: 1,
        workspaceId: activeServer.workspaceId,
        epoch: activeServer.epoch,
        headRevision: 1,
        snapshotRevision: 1,
        nextEntityKey: null,
        hasMore: false,
        seedAllowed: true,
        seedCutoffAt: null,
        records: [],
        extraSnapshot: 1,
      }),
    );
    await expect(synchronizeUserState()).rejects.toThrow(/unexpected field/i);

    activeServer.injectNext("/user-state/merge", ({ body }) => {
      const ops = (body as { operations: UserStateOperation[] }).operations;
      return Response.json({
        version: 1,
        workspaceId: activeServer.workspaceId,
        epoch: activeServer.epoch,
        headRevision: 1,
        results: [{ operationId: ops[0]!.operationId, status: "applied", current: makeRemoteRecord(ops[0]!.entity, ops[0]!.value, 1), extra: "bad" }],
      });
    });
    await expect(synchronizeUserState()).rejects.toThrow(/unexpected field/i);
    expect(() =>
      parseUserStateRecord({
        ...makeRemoteRecord({ kind: "category", categoryId: "c1" }, { name: "C1", sort: 0, deleted: false }, 1),
        unexpected: 123,
      }),
    ).toThrow(UserStateProtocolError);

    expect(() =>
      parseUserStateRetentionResponse({
        version: 1,
        workspaceId: "ws-1",
        epoch: "epoch-1",
        headRevision: 4,
        compactedThrough: 5,
        seedAllowed: false,
        seedCutoffAt: null,
      }),
    ).toThrow(UserStateProtocolError);

    const rec = makeRemoteRecord({ kind: "category", categoryId: "c1" }, { name: "C1", sort: 0, deleted: false }, 1);
    expect(() =>
      parseUserStateSnapshotResponse({
        version: 1,
        workspaceId: "ws-1",
        epoch: "epoch-1",
        headRevision: 1,
        snapshotRevision: 1,
        nextEntityKey: null,
        hasMore: true,
        seedAllowed: true,
        seedCutoffAt: null,
        records: [rec],
      }),
    ).toThrow(UserStateProtocolError);
    expect(() =>
      parseUserStateSnapshotResponse({
        version: 1,
        workspaceId: "ws-1",
        epoch: "epoch-1",
        headRevision: 1,
        snapshotRevision: 1,
        nextEntityKey: "k-1",
        hasMore: false,
        seedAllowed: true,
        seedCutoffAt: null,
        records: [],
      }),
    ).toThrow(UserStateProtocolError);
    expect(() =>
      parseUserStateSnapshotResponse({
        version: 1,
        workspaceId: "ws-1",
        epoch: "epoch-1",
        headRevision: 1,
        snapshotRevision: 1,
        nextEntityKey: "k-1",
        hasMore: true,
        seedAllowed: true,
        seedCutoffAt: null,
        records: [],
      }),
    ).toThrow(UserStateProtocolError);

    const maxKey = "k".repeat(131_072);
    expect(
      parseUserStateSnapshotResponse({
        version: 1,
        workspaceId: "ws-1",
        epoch: "epoch-1",
        headRevision: 1,
        snapshotRevision: 1,
        nextEntityKey: maxKey,
        hasMore: true,
        seedAllowed: true,
        seedCutoffAt: null,
        records: [rec],
      }).nextEntityKey,
    ).toBe(maxKey);
    expect(() =>
      parseUserStateSnapshotResponse({
        version: 1,
        workspaceId: "ws-1",
        epoch: "epoch-1",
        headRevision: 1,
        snapshotRevision: 1,
        nextEntityKey: "k".repeat(131_073),
        hasMore: true,
        seedAllowed: true,
        seedCutoffAt: null,
        records: [rec],
      }),
    ).toThrow(UserStateProtocolError);
  });

  it("T2-A3: rejects regressed headRevision on /merge and retained cursor ahead of server", async () => {
    addWorkToClient(activeClient, 1, DEFAULT_WORK);
    activeServer.seedRemoteRecord(
      { kind: "library", work: DEFAULT_WORK },
      { inLibrary: true, addedAt: 100 },
    );
    await synchronizeUserState();
    await setChapterBookmark(11, true);

    activeServer.injectNext("/user-state/merge", ({ body }) => {
      const ops = (body as { operations: UserStateOperation[] }).operations;
      return Response.json({
        version: 1,
        workspaceId: activeServer.workspaceId,
        epoch: activeServer.epoch,
        headRevision: 0,
        results: [
          {
            operationId: ops[0]!.operationId,
            status: "applied",
            current: makeRemoteRecord(ops[0]!.entity, ops[0]!.value, 0, ops[0]!.operationId),
          },
        ],
      });
    });
    await expect(synchronizeUserState()).rejects.toThrow(/invalid record revision|moved backwards/i);

    activeServer.injectNext("/user-state/merge", ({ body }) => {
      const ops = (body as { operations: UserStateOperation[] }).operations;
      return Response.json({
        version: 1,
        workspaceId: activeServer.workspaceId,
        epoch: activeServer.epoch,
        headRevision: 1,
        results: [
          {
            operationId: ops[0]!.operationId,
            status: "applied",
            current: makeRemoteRecord(ops[0]!.entity, ops[0]!.value, 1, ops[0]!.operationId),
          },
        ],
      });
    });
    // Force observedHead = 5 first via /user-state before merge returns headRevision = 1.
    activeServer.injectNext("/user-state", () =>
      Response.json({ version: 1, workspaceId: activeServer.workspaceId, epoch: activeServer.epoch, headRevision: 5 }),
    );
    activeServer.injectNext("/user-state/read", () =>
      Response.json({
        version: 1,
        workspaceId: activeServer.workspaceId,
        epoch: activeServer.epoch,
        headRevision: 5,
        through: 5,
        nextCursor: 5,
        hasMore: false,
        records: [],
      }),
    );
    await expect(synchronizeUserState()).rejects.toThrow(/moved backwards/i);
    expect((await getUserStateStatus()).pending).toBe(1);
  });

  it("T2-A4: enforces revision payload immutability when cached (entity_key, revision) payload differs", async () => {
    const entity: UserStateEntity = { kind: "reading", work: DEFAULT_WORK, chapter: { chapterPath: "/chapter/1", name: "Ch 1" } };
    const binding: UserStateBinding = { serverUrl: SERVER_URL, workspaceId: activeServer.workspaceId, epoch: activeServer.epoch };
    await runTx(activeClient, (db) => bindUserStateWorkspaceInDb(db, binding));
    const ns = JSON.stringify([binding.serverUrl, binding.workspaceId, binding.epoch]);

    await runTx(activeClient, (db) =>
      storeUserStateRecordInDb(db, ns, makeRemoteRecord(entity, { progress: 40, readAt: 100 }, 5)),
    );

    await expect(
      applyUserStateReadPageInDb(activeClient.db, binding, {
        version: 1,
        workspaceId: binding.workspaceId,
        epoch: binding.epoch,
        headRevision: 5,
        through: 5,
        nextCursor: 5,
        hasMore: false,
        records: [makeRemoteRecord(entity, { progress: 90, readAt: 100 }, 5)],
      }),
    ).rejects.toThrow(/changed its contents/i);
  });

  it("T2-D5: handles seedCutoffAt boundaries (null, 0, MAX_SAFE_INTEGER, and future clock skew)", async () => {
    addWorkToClient(activeClient, 1, DEFAULT_WORK, {
      chapters: [
        { id: 11, path: "/chapter/1", name: "Skewed Future", progress: 50, unread: 0, readAt: 4_000_000_000 },
      ],
    });
    activeServer.seedCutoffAt = Number.MAX_SAFE_INTEGER;
    await synchronizeUserState();

    const mergeOpsWithMax = activeServer.requestLog
      .filter((req) => req.path === "/user-state/merge")
      .flatMap((req) => (req.body as { operations: UserStateOperation[] }).operations);
    expect(mergeOpsWithMax.filter((op) => op.entity.kind === "reading")).toHaveLength(0);

    // Zero cutoff allows non-negative timestamps (>= 0) on a fresh client without falsy confusion.
    const clientZero = createSqliteFixture("Client Zero");
    activateClient(clientZero, SERVER_URL);
    addWorkToClient(clientZero, 1, DEFAULT_WORK, {
      chapters: [{ id: 11, path: "/chapter/zero", name: "Epoch Zero", progress: 50, unread: 0, readAt: 1 }],
    });
    activeServer.seedCutoffAt = 0;
    activeServer.requestLog = [];
    await synchronizeUserState();
    const mergeOpsWithZero = activeServer.requestLog
      .filter((req) => req.path === "/user-state/merge")
      .flatMap((req) => (req.body as { operations: UserStateOperation[] }).operations);
    expect(
      mergeOpsWithZero.some(
        (op) => op.entity.kind === "reading" && op.entity.chapter.chapterPath === "/chapter/zero",
      ),
    ).toBe(true);

    // Null cutoff allows all seeds cleanly on a fresh client.
    const clientB = createSqliteFixture("Client B");
    activateClient(clientB, SERVER_URL);
    addWorkToClient(clientB, 1, DEFAULT_WORK, {
      chapters: [{ id: 11, path: "/chapter/null", name: "Future", progress: 50, unread: 0, readAt: 4_000_000_000 }],
    });
    activeServer.seedCutoffAt = null;
    activeServer.requestLog = [];
    await synchronizeUserState();
    const mergeOpsWithNull = activeServer.requestLog
      .filter((req) => req.path === "/user-state/merge")
      .flatMap((req) => (req.body as { operations: UserStateOperation[] }).operations);
    expect(
      mergeOpsWithNull.some(
        (op) => op.entity.kind === "reading" && op.entity.chapter.chapterPath === "/chapter/null",
      ),
    ).toBe(true);
  });

  it("T2-E4: refuses /snapshot fallback when legacy server lacks userStateRetentionVersion and returns 410", async () => {
    activeServer.capabilities = {
      ...activeServer.capabilities,
      userStateRetentionVersion: undefined,
    };
    addWorkToClient(activeClient, 1, DEFAULT_WORK);
    await synchronizeUserState();
    await setChapterBookmark(11, true);

    activeServer.compactedThrough = 5;
    activeServer.headRevision = 5;
    activeServer.requestLog = [];

    await expect(synchronizeUserState()).rejects.toThrow();
    expect(activeServer.requestLog.some((req) => req.path === "/user-state/snapshot")).toBe(false);
    expect((await getUserStateStatus()).pending).toBe(1);
  });

  it("T2-E5: aborts /snapshot cleanly if server resets epoch mid-pagination (409 on page 2)", async () => {
    addWorkToClient(activeClient, 1, DEFAULT_WORK, {
      chapters: [
        { id: 11, path: "/ch/1", name: "Ch 1" },
        { id: 12, path: "/ch/2", name: "Ch 2" },
      ],
    });
    activeServer.seedRemoteRecord({ kind: "bookmark", work: DEFAULT_WORK, chapter: { chapterPath: "/ch/1", name: "Ch 1" } }, { bookmarked: true });
    activeServer.seedRemoteRecord({ kind: "bookmark", work: DEFAULT_WORK, chapter: { chapterPath: "/ch/2", name: "Ch 2" } }, { bookmarked: true });
    await synchronizeUserState();

    // Advance & compact on server.
    const removed: UserStateEntity = { kind: "bookmark", work: DEFAULT_WORK, chapter: { chapterPath: "/ch/3", name: "Ch 3" } };
    activeServer.seedRemoteRecord(removed, { bookmarked: true });
    activeServer.seedRemoteRecord(removed, { bookmarked: false });
    activeServer.physicalGcTombstones();
    const preResetCompactedThrough = activeServer.compactedThrough;
    expect(preResetCompactedThrough).toBeGreaterThan(2);

    const firstRecord = [...activeServer.records.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))[0]![1];

    let snapshotCalls = 0;
    activeServer.injectNext("/user-state/snapshot", () => {
      snapshotCalls += 1;
      return Response.json({
        version: 1,
        workspaceId: activeServer.workspaceId,
        epoch: activeServer.epoch,
        headRevision: activeServer.headRevision,
        snapshotRevision: activeServer.headRevision,
        nextEntityKey: userStateEntityKey(firstRecord.entity),
        hasMore: true,
        seedAllowed: false,
        seedCutoffAt: null,
        records: [firstRecord],
      });
    });
    activeServer.injectNext("/user-state/snapshot", () => {
      snapshotCalls += 1;
      activeServer.resetWorkspace("epoch-mid-snapshot");
      return Response.json({ message: "User state: workspace or epoch changed" }, { status: 409 });
    });

    await expect(synchronizeUserState()).rejects.toThrow();
    expect(snapshotCalls).toBe(2);
    const binding = (await getUserStateBinding(SERVER_URL))!;
    expect(binding.epoch).toBe("epoch-1");
    const ledger = await getUserStateLedgerStatus(binding);
    expect(ledger.cursor).toBe(2);
    expect(ledger.cursor).toBeLessThan(preResetCompactedThrough);
  });

  it("T2-F1: clearReadingProgress on empty DB, 0-chapter novel, and local-plugin novel creates 0 intents", async () => {
    await clearReadingProgress();
    expect(activeClient.sql.prepare("SELECT COUNT(*) AS c FROM user_state_intent").get()).toEqual({ c: 0 });

    addWorkToClient(activeClient, 1, DEFAULT_WORK, { chapters: [] });
    addWorkToClient(
      activeClient,
      2,
      { pluginId: "local", sourceNovelId: null, novelPath: "/local/1", name: "Local" },
      { chapters: [{ id: 21, path: "/l/1", name: "L1", progress: 100, unread: 0, readAt: 1000 }] },
    );
    const result = await clearReadingProgress();
    expect(result.rowsAffected).toBe(1);
    expect(activeClient.sql.prepare("SELECT COUNT(*) AS c FROM user_state_intent").get()).toEqual({ c: 0 });
  });

  it("T2-F2: clearReadingProgress records only the 1 unread chapter with existing user_state_record and skips 9 untouched chapters", async () => {
    const chapters = Array.from({ length: 10 }, (_, i) => ({
      id: 11 + i,
      path: `/ch/${i + 1}`,
      name: `Ch ${i + 1}`,
      progress: 0,
      unread: 1,
      readAt: null,
    }));
    addWorkToClient(activeClient, 1, DEFAULT_WORK, { chapters });
    const binding: UserStateBinding = { serverUrl: SERVER_URL, workspaceId: activeServer.workspaceId, epoch: activeServer.epoch };
    await runTx(activeClient, (db) => bindUserStateWorkspaceInDb(db, binding));

    const targetEntity: UserStateEntity = { kind: "reading", work: DEFAULT_WORK, chapter: { chapterPath: "/ch/4", name: "Ch 4" } };
    await applyUserStateReadPageInDb(activeClient.db, binding, {
      version: 1,
      workspaceId: binding.workspaceId,
      epoch: binding.epoch,
      headRevision: 1,
      through: 1,
      nextCursor: 1,
      hasMore: false,
      records: [makeRemoteRecord(targetEntity, { progress: 0, readAt: null }, 1)],
    });

    await clearReadingProgress();
    const intents = activeClient.sql.prepare("SELECT entity_key AS entityKey FROM user_state_intent").all() as {
      entityKey: string;
    }[];
    expect(intents.map((i) => i.entityKey)).toEqual([userStateEntityKey(targetEntity)]);
  });

  it("T2-F3: prune_operations with olderThanSecs = 0 preserves pending/conflict rows and blocks identity rewrite via acknowledged_sequence", async () => {
    const binding: UserStateBinding = { serverUrl: SERVER_URL, workspaceId: activeServer.workspaceId, epoch: activeServer.epoch };
    await runTx(activeClient, (db) => bindUserStateWorkspaceInDb(db, binding));
    const ns = JSON.stringify([binding.serverUrl, binding.workspaceId, binding.epoch]);
    activeClient.sql
      .prepare(
        `INSERT INTO user_state_operation(operation_id,namespace,entity_key,intent_sequence,payload,status,receipt,acknowledged_at)
         VALUES
         ('op-ack-0', ?, 'k-ack', 0, '{}', 'acknowledged', '{}', 100),
         ('op-pend', ?, 'k-pend', 1, '{}', 'pending', NULL, NULL),
         ('op-conf', ?, 'k-conf', 2, '{}', 'conflict', '{}', NULL)`,
      )
      .run(ns, ns, ns);

    await mocks.invoke("db_user_state_prune_operations", { binding, olderThanSecs: 0 });
    const rows = activeClient.sql
      .prepare("SELECT operation_id AS id FROM user_state_operation ORDER BY operation_id")
      .all() as { id: string }[];
    expect(rows.map((r) => r.id)).toEqual(["op-conf", "op-pend"]);
  });

  it("T2-F4: uploadDeviceBackup propagates sync failure before device_backup_create and rejects concurrent calls with busy", async () => {
    addWorkToClient(activeClient, 1, DEFAULT_WORK);
    useUserStateStore.getState().setEnabled(SERVER_URL, true);
    await synchronizeUserState();
    await setChapterBookmark(11, true);
    activeServer.resetWorkspace("epoch-mismatch");

    await expect(uploadDeviceBackup(SERVER_URL)).rejects.toThrow();
    expect(activeClient.ipcCallLog.some((call) => call.command === "device_backup_create")).toBe(false);

    // Restore matching epoch and verify concurrent uploadDeviceBackup throws DeviceBackupError("busy").
    activeServer.resetWorkspace("epoch-1");
    let markCreateEntered!: () => void;
    const createEntered = new Promise<void>((resolve) => {
      markCreateEntered = resolve;
    });
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const baseInvoke = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
      if (command === "device_backup_create") {
        markCreateEntered();
        await createGate;
      }
      return baseInvoke(command, args);
    });

    const first = uploadDeviceBackup(SERVER_URL);
    try {
      await createEntered;
      await expect(uploadDeviceBackup(SERVER_URL)).rejects.toMatchObject({
        name: expect.any(String),
        code: "busy",
      } satisfies Partial<DeviceBackupError>);
    } finally {
      releaseCreate();
    }
    await expect(first).resolves.toMatchObject({ deviceName: "Client A" });
  });

  it("T2-F5: reopening an already-migrated 0015 DB skips redundant VACUUM and preserves user_state_* rows", () => {
    const databaseRs = readFileSync("src-tauri/src/database.rs", "utf8");
    expect(databaseRs).toMatch(/0015|version:\s*15/);
    expect(databaseRs).toMatch(/auto_vacuum/i);

    // Verify PRAGMA auto_vacuum stays 2 when checked on a second connection / pass.
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("PRAGMA auto_vacuum = INCREMENTAL");
      const matches = [
        ...databaseRs.matchAll(/version:\s*(\d+),\s*description:[\s\S]*?sql:\s*include_str!\("([^"]+)"\)/g),
      ];
      for (const m of matches) db.exec(readFileSync(`src-tauri/src/${m[2]}`, "utf8"));
      db.exec("INSERT INTO user_state_workspace(server_url,namespace,workspace_id,epoch) VALUES('https://s','ns','ws','ep')");
      expect(db.prepare("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: 2 });
      expect(db.prepare("SELECT epoch FROM user_state_workspace").get()).toEqual({ epoch: "ep" });
    } finally {
      db.close();
    }
  });

  it("T2-G1: differentiates 409 epoch mismatch from 409 cursor-ahead and 409 payload mismatch", async () => {
    addWorkToClient(activeClient, 1, DEFAULT_WORK);
    await synchronizeUserState();
    await setChapterBookmark(11, true);

    activeServer.injectNext("/user-state/merge", () =>
      Response.json({ message: "User state: cursor is ahead of the requested history" }, { status: 409 }),
    );
    await expect(synchronizeUserState()).rejects.toThrow(/cursor is ahead/i);
    expect((await getUserStateStatus()).epochMismatch).toBeUndefined();

    activeServer.injectNext("/user-state/merge", () =>
      Response.json({ message: "User state: operation receipt expired or payload mismatch" }, { status: 409 }),
    );
    await expect(synchronizeUserState()).rejects.toThrow(/payload mismatch/i);
    expect((await getUserStateStatus()).epochMismatch).toBeUndefined();

    activeServer.resetWorkspace("epoch-2");
    await expect(synchronizeUserState()).rejects.toThrow();
    expect((await getUserStateStatus()).epochMismatch?.serverEpoch).toBe("epoch-2");
  });

  it("T2-G2: Mode B clears pre-epoch conflicts and pending intents so nothing from epoch1 uploads to epoch2", async () => {
    addWorkToClient(activeClient, 1, DEFAULT_WORK);
    await synchronizeUserState();
    const binding1 = (await getUserStateBinding(SERVER_URL))!;
    const ns1 = JSON.stringify([binding1.serverUrl, binding1.workspaceId, binding1.epoch]);
    await setChapterBookmark(11, true);
    activeClient.sql
      .prepare("INSERT INTO user_state_conflict(id,namespace,entity_key,reason) VALUES('c1',?,?,?)")
      .run(ns1, userStateEntityKey({ kind: "bookmark", work: DEFAULT_WORK, chapter: { chapterPath: "/chapter/1", name: "Chapter 1" } }), "category-deleted");

    activeServer.resetWorkspace("epoch-2");
    activeServer.requestLog = [];
    await rebindUserStateWorkspace("start_fresh");

    expect(activeServer.requestLog.some((req) => req.path === "/user-state/merge")).toBe(false);
    expect((await getUserStateStatus()).conflicts).toEqual([]);
    expect((await getUserStateStatus()).pending).toBe(0);
  });

  it("T2-G3: workspaceId change triggers the same explicit Mode A / Mode B requirement", async () => {
    addWorkToClient(activeClient, 1, DEFAULT_WORK);
    await synchronizeUserState();
    activeServer.workspaceId = "ws-e2e-2";
    activeServer.resetWorkspace("epoch-ws2");

    await expect(synchronizeUserState()).rejects.toThrow(/workspace|epoch/i);
    const status = await getUserStateStatus();
    expect(status.epochMismatch?.serverWorkspaceId).toBe("ws-e2e-2");
  });

  it("T2-G4: interrupted Mode A rebind resumes idempotently on the next sync without duplicating intents", async () => {
    addWorkToClient(activeClient, 1, DEFAULT_WORK, {
      inLibrary: true,
      chapters: [{ id: 11, path: "/chapter/1", name: "Ch 1", progress: 50, unread: 0, readAt: 1_750_000_000 }],
    });
    await synchronizeUserState();
    activeServer.resetWorkspace("epoch-2");

    activeServer.injectNext("/user-state/merge", () => {
      throw new Error("network drop during Mode A");
    });
    await expect(rebindUserStateWorkspace("reseed")).rejects.toThrow(/connection failed/i);

    await synchronizeUserState();
    expect(activeServer.headRevision).toBeGreaterThanOrEqual(1);
    expect((await getUserStateStatus()).pending).toBe(0);
  });

  it("T2-G5: ReadingStateSettings disables controls while pausedAfterRestore or working is true", async () => {
    const elements = await renderSettingsControls(SERVER_URL, { pausedAfterRestore: true });
    const syncButton = elements.find((el) => el.props.label === enMessages["userState.syncNow"] && el.props.onClick);
    expect(syncButton?.props.disabled).toBe(true);

    useUserStateStore.getState().setRuntime(SERVER_URL, "syncing");
    const workingElements = await renderSettingsControls(SERVER_URL);
    const syncWhileBusy = workingElements.find(
      (el) => el.props.label === enMessages["userState.syncNow"] && el.props.onClick,
    );
    expect(syncWhileBusy?.props.disabled).toBe(true);
  });
});

describe("Client E2E — Tier 3: Cross-Feature Pairwise Combinations", () => {
  it("T3-11: Epoch Reset + Mode B + uploadDeviceBackup serialization", async () => {
    addWorkToClient(activeClient, 1, DEFAULT_WORK, {
      chapters: [{ id: 11, path: "/chapter/1", name: "Ch 1", progress: 100, unread: 0, readAt: 1_700_000_000 }],
    });
    useUserStateStore.getState().setEnabled(SERVER_URL, true);
    await synchronizeUserState();
    activeServer.resetWorkspace("epoch-2");
    await rebindUserStateWorkspace("start_fresh");
    await updateChapterProgress(11, 50);

    activeServer.requestLog = [];
    activeClient.ipcCallLog = [];
    await uploadDeviceBackup(SERVER_URL);

    expect(activeServer.headRevision).toBe(1);
    const mergeIdx = activeClient.ipcCallLog.findIndex(
      (c) => c.command === "db_user_state_acknowledge_operations",
    );
    const backupCreateIdx = activeClient.ipcCallLog.findIndex((c) => c.command === "device_backup_create");
    expect(mergeIdx).toBeGreaterThanOrEqual(0);
    expect(mergeIdx).toBeLessThan(backupCreateIdx);
  });

  it("T3-12: Epoch Reset + Mode A + Policy 2-C seedCutoffAt", async () => {
    addWorkToClient(activeClient, 1, DEFAULT_WORK, {
      chapters: [
        { id: 11, path: "/ch/old", name: "Old", progress: 100, unread: 0, readAt: 1_650_000_000 },
        { id: 12, path: "/ch/new", name: "New", progress: 100, unread: 0, readAt: 1_750_000_000 },
      ],
    });
    await synchronizeUserState();
    activeServer.resetWorkspace("epoch-2");
    activeServer.seedCutoffAt = 1_700_000_000_000;

    activeClient.ipcCallLog = [];
    await rebindUserStateWorkspace("reseed");

    const rebindCall = activeClient.ipcCallLog.find((c) => c.command === "db_user_state_rebind_workspace");
    expect(rebindCall?.args).toEqual({
      binding: { serverUrl: SERVER_URL, workspaceId: activeServer.workspaceId, epoch: "epoch-2" },
      mode: "reseed",
      seedCutoffMs: 1_700_000_000_000,
      seedAllowed: true,
    });
    expect((await getUserStateStatus()).pending).toBe(0);
    const syncedPaths = [...activeServer.records.values()]
      .filter((r) => r.entity.kind === "reading")
      .map((r) => (r.entity.kind === "reading" ? r.entity.chapter.chapterPath : ""));
    expect(syncedPaths).toContain("/ch/new");
    expect(syncedPaths).not.toContain("/ch/old");
  });

  it("T3-13: 410 Gone + /snapshot + Held Migration Sources safety", async () => {
    const sourceWork: UserStateWorkReference = {
      pluginId: "test-source",
      sourceNovelId: "old-id",
      novelPath: "/old",
      name: "Old Work",
    };
    const targetWork: UserStateWorkReference = {
      pluginId: "test-source",
      sourceNovelId: "new-id",
      novelPath: "/new",
      name: "New Work",
    };
    addWorkToClient(activeClient, 1, targetWork, {
      chapters: [{ id: 11, path: "/ch/1", name: "Ch 1", progress: 0, unread: 1 }],
    });
    // Mark sourceWork as held migration source in content_sync_cache with canonical migration payload.
    activeClient.sql
      .prepare("INSERT INTO content_sync_cache(cache_key,payload) VALUES(?,?)")
      .run(
        "norea-content-novel-migration:mig-op-1",
        JSON.stringify({
          operationId: "mig-op-1",
          serverUrl: SERVER_URL,
          status: "completed",
          source: {
            pluginId: sourceWork.pluginId,
            novelId: sourceWork.sourceNovelId,
            novelPath: sourceWork.novelPath,
          },
        }),
      );
    const heldBefore = await loadCurrentHeldSourcesInDb(activeClient.db, SERVER_URL);
    expect(isCurrentWorkHeld(heldBefore, sourceWork)).toBe(true);

    // Pre-populate retiredEntity in activeClient's user_state_record via initial sync before server GC.
    const retiredEntity: UserStateEntity = { kind: "bookmark", work: sourceWork, chapter: { chapterPath: "/ch/1", name: "Ch 1" } };
    activeServer.seedRemoteRecord(retiredEntity, { bookmarked: true });
    await synchronizeUserState();
    await waitForUserStateDeferredApply();
    expect(
      activeClient.sql
        .prepare("SELECT COUNT(*) AS c FROM user_state_record WHERE entity_key=?")
        .get(userStateEntityKey(retiredEntity)),
    ).toEqual({ c: 1 });

    activeServer.seedRemoteRecord({ kind: "reading", work: targetWork, chapter: { chapterPath: "/ch/1", name: "Ch 1" } }, { progress: 80, readAt: 1_700_000_000 });
    activeServer.seedRemoteRecord(retiredEntity, { bookmarked: false });
    activeServer.physicalGcTombstones();

    await synchronizeUserState();
    await waitForUserStateDeferredApply();

    expect(activeClient.sql.prepare("SELECT progress FROM chapter WHERE id=11").get()).toEqual({ progress: 80 });
    expect(
      activeClient.sql
        .prepare("SELECT COUNT(*) AS c FROM user_state_record WHERE entity_key=?")
        .get(userStateEntityKey(retiredEntity)),
    ).toEqual({ c: 0 });
    expect(
      activeClient.sql
        .prepare("SELECT COUNT(*) AS c FROM user_state_intent WHERE entity_key=?")
        .get(userStateEntityKey(retiredEntity)),
    ).toEqual({ c: 0 });
    const heldAfter = await loadCurrentHeldSourcesInDb(activeClient.db, SERVER_URL);
    expect(isCurrentWorkHeld(heldAfter, sourceWork)).toBe(true);
    expect((await getUserStateStatus()).projectionFailed).toBe(0);
  });

  it("T3-14: 410 Gone + /snapshot + dangling user_state_alias cleanup", async () => {
    await insertCategory({ name: "Sci-Fi", sort: 1 });
    await synchronizeUserState();
    const binding = (await getUserStateBinding(SERVER_URL))!;
    const ns = JSON.stringify([binding.serverUrl, binding.workspaceId, binding.epoch]);

    // Simulate alias entry pointing to a canonical category that is subsequently deleted and physically GC'd.
    activeClient.sql
      .prepare("INSERT INTO user_state_alias(namespace,alias_id,canonical_id) VALUES(?,?,?)")
      .run(ns, "cat-alias-old", "cat-canonical-gc");
    const cat = activeClient.sql.prepare("SELECT id FROM category WHERE name='Sci-Fi'").get() as { id: number };
    await deleteCategory(cat.id);
    await synchronizeUserState();
    activeServer.physicalGcTombstones();

    // Force client cursor behind compactedThrough so snapshot reconciliation runs.
    activeClient.sql.exec("UPDATE user_state_workspace SET cursor=0");
    await synchronizeUserState();

    expect(
      activeClient.sql.prepare("SELECT COUNT(*) AS c FROM user_state_alias WHERE alias_id='cat-alias-old'").get(),
    ).toEqual({ c: 0 });
  });

  it("T3-15: clearReadingProgress + user_state_operation pruning + has_attempt", async () => {
    const chapters = Array.from({ length: 12 }, (_, i) => ({
      id: 11 + i,
      path: `/ch/${i + 1}`,
      name: `Ch ${i + 1}`,
      progress: i < 2 ? 100 : 0,
      unread: i < 2 ? 0 : 1,
      readAt: i < 2 ? 1_700_000_000 : null,
    }));
    addWorkToClient(activeClient, 1, DEFAULT_WORK, { chapters });
    const opaqueWork: UserStateWorkReference = {
      ...DEFAULT_WORK,
      sourceNovelId: null,
      novelPath: "/opaque/2",
      name: "Opaque Work",
    };
    addWorkToClient(activeClient, 2, opaqueWork, {
      chapters: [{ id: 31, path: "/opaque/ch/1", name: "Op Ch 1" }],
    });
    await setChapterBookmark(31, true);
    await synchronizeUserState();

    const binding = (await getUserStateBinding(SERVER_URL))!;
    const ns = JSON.stringify([binding.serverUrl, binding.workspaceId, binding.epoch]);
    const oldOpaqueEntity: UserStateEntity = {
      kind: "bookmark",
      work: opaqueWork,
      chapter: { chapterPath: "/opaque/ch/1", name: "Op Ch 1" },
    };
    const oldOpaqueKey = userStateEntityKey(oldOpaqueEntity);

    await mocks.invoke("db_user_state_prune_operations", { binding, olderThanSecs: 0 });
    expect(activeClient.sql.prepare("SELECT COUNT(*) AS c FROM user_state_operation").get()).toEqual({ c: 0 });
    const progress = activeClient.sql
      .prepare("SELECT acknowledged_sequence AS ack FROM user_state_progress WHERE namespace=? AND entity_key=?")
      .get(ns, oldOpaqueKey) as { ack: number };
    expect(progress.ack).toBeGreaterThan(0);

    // Resolve opaque novel identity after operation pruning: has_attempt via acknowledged_sequence > 0 preserves oldOpaqueKey.
    activeClient.sql.exec("UPDATE novel SET source_novel_id='opaque-resolved-2' WHERE id=2");
    await runTx(activeClient, (db) => refreshUnattemptedUserStateIdentitiesInDb(db));
    expect(
      activeClient.sql.prepare("SELECT entity_key AS entityKey FROM user_state_intent WHERE entity_key=?").get(oldOpaqueKey),
    ).toEqual({ entityKey: oldOpaqueKey });

    await clearReadingProgress();
    const intents = activeClient.sql
      .prepare("SELECT entity_key FROM user_state_intent WHERE json_extract(entity_json,'$.kind')='reading'")
      .all();
    expect(intents).toHaveLength(2);
  });

  it("T3-16: 410 Gone + /snapshot + concurrent server merges followed by /read(after: snapshotRevision)", async () => {
    addWorkToClient(activeClient, 1, DEFAULT_WORK, {
      chapters: [
        { id: 11, path: "/ch/1", name: "Ch 1" },
        { id: 12, path: "/ch/2", name: "Ch 2" },
      ],
    });
    const bm1: UserStateEntity = { kind: "bookmark", work: DEFAULT_WORK, chapter: { chapterPath: "/ch/1", name: "Ch 1" } };
    const bm2: UserStateEntity = { kind: "bookmark", work: DEFAULT_WORK, chapter: { chapterPath: "/ch/2", name: "Ch 2" } };
    const temp: UserStateEntity = { kind: "bookmark", work: DEFAULT_WORK, chapter: { chapterPath: "/ch/temp", name: "Temp" } };
    activeServer.seedRemoteRecord(temp, { bookmarked: true });
    activeServer.seedRemoteRecord(temp, { bookmarked: false });
    activeServer.physicalGcTombstones();
    activeServer.seedRemoteRecord(bm1, { bookmarked: true });

    // Inject concurrent merge during snapshot download so headRevision advances past snapshotRevision.
    let injectedConcurrent = false;
    const origHandle = activeServer.handle.bind(activeServer);
    mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const res = await origHandle(url, init);
      if (url.endsWith("/user-state/snapshot") && !injectedConcurrent) {
        injectedConcurrent = true;
        activeServer.seedRemoteRecord(bm2, { bookmarked: true });
      }
      return res;
    });

    await synchronizeUserState();
    await waitForUserStateDeferredApply();

    expect(activeClient.sql.prepare("SELECT id,bookmark FROM chapter ORDER BY id").all()).toEqual([
      { id: 11, bookmark: 1 },
      { id: 12, bookmark: 1 },
    ]);
  });

  it("T3-17: 410 Gone + /snapshot reconciles absent server entity while preserving pending local edit", async () => {
    addWorkToClient(activeClient, 1, DEFAULT_WORK, {
      chapters: [
        { id: 11, path: "/ch/1", name: "Ch 1" },
        { id: 12, path: "/ch/2", name: "Ch 2" },
      ],
    });
    const bm1: UserStateEntity = { kind: "bookmark", work: DEFAULT_WORK, chapter: { chapterPath: "/ch/1", name: "Ch 1" } };
    activeServer.seedRemoteRecord(bm1, { bookmarked: true });
    await synchronizeUserState();

    // Server removes & GCs bm1; locally user edits ch2 offline.
    activeServer.seedRemoteRecord(bm1, { bookmarked: false });
    activeServer.physicalGcTombstones();
    await updateChapterProgress(12, 80);

    await synchronizeUserState();
    await waitForUserStateDeferredApply();

    expect(activeClient.sql.prepare("SELECT bookmark FROM chapter WHERE id=11").get()).toEqual({ bookmark: 0 });
    expect(activeClient.sql.prepare("SELECT progress FROM chapter WHERE id=12").get()).toEqual({ progress: 80 });
    expect(activeServer.records.has(userStateEntityKey(bm1))).toBe(false);
    const localCh2 = activeClient.sql.prepare("SELECT read_at AS readAt FROM chapter WHERE id=12").get() as {
      readAt: number;
    };
    const savedValue = activeServer.records.get(
      userStateEntityKey({ kind: "reading", work: DEFAULT_WORK, chapter: { chapterPath: "/ch/2", name: "Ch 2" } }),
    )?.value;
    expect(savedValue).toEqual({ progress: 80, readAt: expect.any(Number) });
    expect((savedValue as { readAt: number }).readAt).toBeGreaterThan(1_700_000_000);
    expect((savedValue as { readAt: number }).readAt).toBe(localCh2.readAt);
  });

  it("T3-18: Policy 2-B new revision clears readAt while preserving progress=90 and ReadingStateSettings summary", async () => {
    addWorkToClient(activeClient, 1, DEFAULT_WORK, {
      chapters: [{ id: 11, path: "/ch/1", name: "Ch 1" }],
    });
    const entity: UserStateEntity = { kind: "reading", work: DEFAULT_WORK, chapter: { chapterPath: "/ch/1", name: "Ch 1" } };
    activeServer.seedRemoteRecord(entity, { progress: 90, readAt: 1_700_000_000 });
    await synchronizeUserState();
    await waitForUserStateDeferredApply();

    activeServer.applyPolicy2B(entity);
    await synchronizeUserState();
    await waitForUserStateDeferredApply();

    expect(activeClient.sql.prepare("SELECT progress,read_at FROM chapter WHERE id=11").get()).toEqual({
      progress: 90,
      read_at: null,
    });
    const summary = userStateValueSummary(
      "reading",
      { progress: 90, readAt: null },
      ((key: keyof typeof enMessages, vals?: Record<string, string | number>) => {
        let out = enMessages[key];
        for (const [k, v] of Object.entries(vals ?? {})) out = out.replaceAll(`{${k}}`, String(v));
        return out;
      }) as ReturnType<typeof useTranslation>["t"],
      "en",
    );
    expect(summary).toBe("90% · Unread · No reading history");
  });

  it("T3-19: uploadDeviceBackup serializes synchronizeUserState + post-sync operation pruning before device_backup_create", async () => {
    addWorkToClient(activeClient, 1, DEFAULT_WORK);
    useUserStateStore.getState().setEnabled(SERVER_URL, true);
    await setChapterBookmark(11, true);

    await uploadDeviceBackup(SERVER_URL);

    const pruneIdx = activeClient.ipcCallLog.findIndex((c) => c.command === "db_user_state_prune_operations");
    const createIdx = activeClient.ipcCallLog.findIndex((c) => c.command === "device_backup_create");
    expect(pruneIdx).toBeGreaterThanOrEqual(0);
    expect(pruneIdx).toBeLessThan(createIdx);
  });

  it("T3-20: server without userStateRetentionVersion performs normal delta sync without calling /retention or /snapshot", async () => {
    activeServer.capabilities = {
      ...activeServer.capabilities,
      userStateRetentionVersion: undefined,
    };
    addWorkToClient(activeClient, 1, DEFAULT_WORK);
    await setChapterBookmark(11, true);
    await synchronizeUserState();

    const paths = new Set(activeServer.requestLog.map((r) => r.path));
    expect(paths.has("/user-state/retention")).toBe(false);
    expect(paths.has("/user-state/snapshot")).toBe(false);
    expect(paths.has("/user-state/merge")).toBe(true);
  });

  it("T3-21: client splits 413 response-budget rejections in half while preserving exact operationIds", async () => {
    addWorkToClient(activeClient, 1, DEFAULT_WORK, {
      chapters: [
        { id: 11, path: "/ch/1", name: "Ch 1" },
        { id: 12, path: "/ch/2", name: "Ch 2" },
        { id: 13, path: "/ch/3", name: "Ch 3" },
        { id: 14, path: "/ch/4", name: "Ch 4" },
      ],
    });
    await setChaptersReadState([11, 12, 13, 14], false);
    const origHandle = activeServer.handle.bind(activeServer);
    const mergeBatchSizes: number[] = [];
    const seenIdsBySize: string[][] = [];
    mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/user-state/merge")) {
        const body = JSON.parse(init!.body as string) as { operations: UserStateOperation[] };
        mergeBatchSizes.push(body.operations.length);
        seenIdsBySize.push(body.operations.map((o) => o.operationId));
        if (body.operations.length > 2) return new Response(null, { status: 413 });
      }
      return origHandle(url, init);
    });

    await synchronizeUserState();
    expect(mergeBatchSizes).toEqual([4, 2, 2]);
    expect(new Set(seenIdsBySize[0])).toEqual(new Set([...seenIdsBySize[1]!, ...seenIdsBySize[2]!]));
    expect((await getUserStateStatus()).pending).toBe(0);
  });

  it("T3-22: 0015 migration + incremental auto_vacuum pairs cleanly with db_user_state_prune_operations", async () => {
    addWorkToClient(activeClient, 1, DEFAULT_WORK);
    await setChapterBookmark(11, true);
    await synchronizeUserState();
    const binding = (await getUserStateBinding(SERVER_URL))!;

    await mocks.invoke("db_user_state_prune_operations", { binding, olderThanSecs: 0 });
    expect(
      activeClient.sql.prepare("SELECT COUNT(*) AS c FROM user_state_operation WHERE status='acknowledged'").get(),
    ).toEqual({ c: 0 });
  });
});

describe("Client E2E — Tier 4: Multi-Client & Multi-Step Workflows", () => {
  it("T4-01: 2-device active reading + compaction + new device join + 409 stale operation replay", async () => {
    addWorkToClient(activeClient, 1, DEFAULT_WORK, {
      chapters: Array.from({ length: 5 }, (_, i) => ({ id: 11 + i, path: `/ch/${i + 1}`, name: `Ch ${i + 1}` })),
    });
    await synchronizeUserState();
    for (let step = 1; step <= 4; step += 1) {
      for (let ch = 0; ch < 5; ch += 1) {
        await updateChapterProgress(11 + ch, step * 25);
        await synchronizeUserState();
      }
    }
    expect(activeServer.headRevision).toBe(20);

    const firstMergedOp = activeServer.requestLog.find((r) => r.path === "/user-state/merge")?.body as {
      operations: UserStateOperation[];
    };
    activeServer.compactSuperseded();
    activeServer.stage1CleanOperations();

    // Device B joins fresh and receives only the 5 latest compacted revisions.
    const clientB = createSqliteFixture("Client B");
    activateClient(clientB, SERVER_URL);
    addWorkToClient(clientB, 1, DEFAULT_WORK, {
      chapters: Array.from({ length: 5 }, (_, i) => ({ id: 11 + i, path: `/ch/${i + 1}`, name: `Ch ${i + 1}` })),
    });
    await synchronizeUserState();
    await waitForUserStateDeferredApply();

    const readRes = activeClient.sql.prepare("SELECT id,progress FROM chapter ORDER BY id").all();
    expect(readRes).toEqual([
      { id: 11, progress: 100 },
      { id: 12, progress: 100 },
      { id: 13, progress: 100 },
      { id: 14, progress: 100 },
      { id: 15, progress: 100 },
    ]);

    // Stale replay of first operation from Device A returns 409 without overwriting revision 20.
    const replayRes = await activeServer.handle(`${SERVER_URL}/api/v1/user-state/merge`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${[...activeServer.devices.keys()][0]}`,
      },
      body: JSON.stringify({
        workspaceId: activeServer.workspaceId,
        epoch: activeServer.epoch,
        operations: [firstMergedOp.operations[0]!],
      }),
    });
    expect(replayRes.status).toBe(409);
  });

  it("T4-02: offline client reconnecting after physical tombstone GC (410 -> /snapshot -> new edit)", async () => {
    const clientA = activeClient;
    const chapters = Array.from({ length: 4 }, (_, i) => ({ id: 11 + i, path: `/ch/${i + 1}`, name: `Ch ${i + 1}` }));
    addWorkToClient(clientA, 1, DEFAULT_WORK, { chapters });
    for (let i = 0; i < 4; i += 1) await setChapterBookmark(11 + i, true);
    await synchronizeUserState();

    const clientB = createSqliteFixture("Client B");
    activateClient(clientB, SERVER_URL);
    addWorkToClient(clientB, 1, DEFAULT_WORK, { chapters });
    await synchronizeUserState();
    await waitForUserStateDeferredApply();

    // Device A deletes 2 bookmarks and server physically GCs their tombstones.
    activateClient(clientA, SERVER_URL);
    await setChapterBookmark(11, false);
    await setChapterBookmark(12, false);
    await synchronizeUserState();
    activeServer.physicalGcTombstones();

    // Device B comes back online with a new local edit on ch4.
    activateClient(clientB, SERVER_URL);
    await updateChapterProgress(14, 95);
    await synchronizeUserState();
    await waitForUserStateDeferredApply();

    expect(clientB.sql.prepare("SELECT id,bookmark,progress FROM chapter ORDER BY id").all()).toEqual([
      { id: 11, bookmark: 0, progress: 0 },
      { id: 12, bookmark: 0, progress: 0 },
      { id: 13, bookmark: 1, progress: 0 },
      { id: 14, bookmark: 1, progress: 95 },
    ]);
  });

  it("T4-03: workspace epoch reset + dual-device Mode A vs Mode B divergence", async () => {
    const clientA = activeClient;
    addWorkToClient(clientA, 1, DEFAULT_WORK, {
      inLibrary: true,
      chapters: [{ id: 11, path: "/ch/1", name: "Ch 1", progress: 100, unread: 0, readAt: 1_700_000_010 }],
    });
    await synchronizeUserState();

    const clientB = createSqliteFixture("Client B");
    activateClient(clientB, SERVER_URL);
    addWorkToClient(clientB, 1, DEFAULT_WORK, {
      inLibrary: true,
      chapters: [
        { id: 11, path: "/ch/1", name: "Ch 1" },
        { id: 12, path: "/ch/2", name: "Ch 2", progress: 50, unread: 0, readAt: 1_700_000_020 },
      ],
    });
    await synchronizeUserState();

    // Admin resets workspace to epoch-2.
    activeServer.resetWorkspace("epoch-2");

    // Device A selects Mode A (re-seed).
    activateClient(clientA, SERVER_URL);
    await expect(synchronizeUserState()).rejects.toThrow();
    clientA.ipcCallLog = [];
    await rebindUserStateWorkspace("reseed");
    expect(
      clientA.ipcCallLog.find((c) => c.command === "db_user_state_rebind_workspace")?.args,
    ).toEqual({
      binding: { serverUrl: SERVER_URL, workspaceId: activeServer.workspaceId, epoch: "epoch-2" },
      mode: "reseed",
      seedCutoffMs: null,
      seedAllowed: true,
    });
    const headAfterA = activeServer.headRevision;
    expect(headAfterA).toBeGreaterThanOrEqual(2);

    // Device B selects Mode B (start fresh): does NOT upload old Ch 2 progress, receives Device A state, then edits Ch 2.
    activateClient(clientB, SERVER_URL);
    await expect(synchronizeUserState()).rejects.toThrow();
    clientB.ipcCallLog = [];
    await rebindUserStateWorkspace("start_fresh");
    expect(
      clientB.ipcCallLog.find((c) => c.command === "db_user_state_rebind_workspace")?.args,
    ).toEqual({
      binding: { serverUrl: SERVER_URL, workspaceId: activeServer.workspaceId, epoch: "epoch-2" },
      mode: "start_fresh",
      headRevision: headAfterA,
      seedCutoffMs: null,
    });
    expect(activeServer.headRevision).toBe(headAfterA);

    await updateChapterProgress(12, 100);
    await synchronizeUserState();
    expect(activeServer.headRevision).toBe(headAfterA + 1);
  });

  it("T4-04: server sliding window 2-C preserves local history while blocking old seeds from new device", async () => {
    const cutoffMs = 1_700_000_000_000;
    addWorkToClient(activeClient, 1, DEFAULT_WORK, {
      chapters: [
        { id: 11, path: "/ch/old", name: "Old", progress: 100, unread: 0, readAt: 1_650_000_000 },
        { id: 12, path: "/ch/recent", name: "Recent", progress: 100, unread: 0, readAt: 1_750_000_000 },
      ],
    });
    await synchronizeUserState();

    // Simulate server 2-C pruning old record and advancing seedCutoffAt while advancing compactedThrough > 0 with seedAllowed = true.
    const oldEntity: UserStateEntity = { kind: "reading", work: DEFAULT_WORK, chapter: { chapterPath: "/ch/old", name: "Old" } };
    const oldKey = userStateEntityKey(oldEntity);
    const oldRecord = activeServer.records.get(oldKey);
    activeServer.seedCutoffAt = cutoffMs;
    activeServer.compactedThrough = Math.max(activeServer.compactedThrough, oldRecord?.revision ?? 1);
    activeServer.seedAllowed = true;
    activeServer.records.delete(oldKey);
    activeServer.changeLog = activeServer.changeLog.filter((entry) => entry.entityKey !== oldKey);

    // Device A retains local history for /ch/old.
    expect(activeClient.sql.prepare("SELECT progress,read_at FROM chapter WHERE id=11").get()).toEqual({
      progress: 100,
      read_at: 1_650_000_000,
    });

    // New Device C joins with /ch/old (< cutoff), /ch/recent (on server), and /ch/new-local (>= cutoff, not on server).
    const clientC = createSqliteFixture("Client C");
    activateClient(clientC, SERVER_URL);
    addWorkToClient(clientC, 1, DEFAULT_WORK, {
      chapters: [
        { id: 11, path: "/ch/old", name: "Old", progress: 100, unread: 0, readAt: 1_650_000_000 },
        { id: 12, path: "/ch/recent", name: "Recent", progress: 100, unread: 0, readAt: 1_750_000_000 },
        { id: 13, path: "/ch/new-local", name: "New Local", progress: 100, unread: 0, readAt: 1_760_000_000 },
      ],
    });
    activeServer.requestLog = [];
    await synchronizeUserState();

    const clientCMergeOps = activeServer.requestLog
      .filter((req) => req.path === "/user-state/merge")
      .flatMap((req) => (req.body as { operations: UserStateOperation[] }).operations);
    expect(
      clientCMergeOps.some(
        (op) => op.entity.kind === "reading" && op.entity.chapter.chapterPath === "/ch/old",
      ),
    ).toBe(false);
    expect(
      clientCMergeOps.some(
        (op) => op.entity.kind === "reading" && op.entity.chapter.chapterPath === "/ch/new-local" && op.seed === true,
      ),
    ).toBe(true);
    expect(activeServer.records.has(oldKey)).toBe(false);
    expect(
      activeServer.records.has(
        userStateEntityKey({ kind: "reading", work: DEFAULT_WORK, chapter: { chapterPath: "/ch/new-local", name: "New Local" } }),
      ),
    ).toBe(true);
    expect(
      activeServer.records.has(
        userStateEntityKey({ kind: "reading", work: DEFAULT_WORK, chapter: { chapterPath: "/ch/recent", name: "Recent" } }),
      ),
    ).toBe(true);
    expect(clientC.sql.prepare("SELECT progress,read_at FROM chapter WHERE id=11").get()).toEqual({
      progress: 100,
      read_at: 1_650_000_000,
    });
  });

  it("T4-06: work migration + source tombstone GC + new client reconnection", async () => {
    const clientA = activeClient;
    const targetWork: UserStateWorkReference = {
      pluginId: "test-source",
      sourceNovelId: "w2",
      novelPath: "/w2",
      name: "Migrated Target",
    };
    const sourceWork: UserStateWorkReference = {
      pluginId: "test-source",
      sourceNovelId: "w1",
      novelPath: "/w1",
      name: "Retired Source",
    };
    const migrationPayload = JSON.stringify({
      operationId: "mig-op-w1",
      serverUrl: SERVER_URL,
      status: "completed",
      source: { pluginId: sourceWork.pluginId, novelId: sourceWork.sourceNovelId, novelPath: sourceWork.novelPath },
      target: { pluginId: targetWork.pluginId, novelId: targetWork.sourceNovelId, novelPath: targetWork.novelPath },
    });
    clientA.sql
      .prepare("INSERT INTO content_sync_cache(cache_key,payload) VALUES(?,?)")
      .run("norea-content-novel-migration:mig-op-w1", migrationPayload);

    addWorkToClient(clientA, 1, targetWork, {
      chapters: [{ id: 11, path: "/ch/1", name: "Ch 1", progress: 65, unread: 0, readAt: 1_700_000_000 }],
    });
    const retiredEntity: UserStateEntity = { kind: "library", work: sourceWork };
    activeServer.seedRemoteRecord(retiredEntity, { inLibrary: true, addedAt: 100 });
    await synchronizeUserState();
    await waitForUserStateDeferredApply();

    // Tombstone and physically GC the retired source record on server, then reconnect Client A via 410 -> /snapshot.
    activeServer.seedRemoteRecord(retiredEntity, { inLibrary: false, addedAt: null });
    activeServer.physicalGcTombstones();

    await synchronizeUserState();
    await waitForUserStateDeferredApply();

    const targetReadingKey = userStateEntityKey({
      kind: "reading",
      work: targetWork,
      chapter: { chapterPath: "/ch/1", name: "Ch 1" },
    });
    expect(
      clientA.sql.prepare("SELECT payload FROM content_sync_cache WHERE cache_key=?").get("norea-content-novel-migration:mig-op-w1"),
    ).toEqual({ payload: migrationPayload });
    expect(isCurrentWorkHeld(await loadCurrentHeldSourcesInDb(clientA.db, SERVER_URL), sourceWork)).toBe(true);
    expect(
      clientA.sql.prepare("SELECT COUNT(*) AS c FROM user_state_record WHERE entity_key=?").get(targetReadingKey),
    ).toEqual({ c: 1 });
    expect(
      clientA.sql.prepare("SELECT COUNT(*) AS c FROM user_state_record WHERE entity_key=?").get(userStateEntityKey(retiredEntity)),
    ).toEqual({ c: 0 });
    expect(
      clientA.sql.prepare("SELECT COUNT(*) AS c FROM user_state_intent WHERE entity_key=?").get(userStateEntityKey(retiredEntity)),
    ).toEqual({ c: 0 });

    const clientB = createSqliteFixture("Client B");
    activateClient(clientB, SERVER_URL);
    addWorkToClient(clientB, 1, targetWork, {
      chapters: [{ id: 11, path: "/ch/1", name: "Ch 1" }],
    });
    await synchronizeUserState();
    await waitForUserStateDeferredApply();

    expect(clientB.sql.prepare("SELECT progress FROM chapter WHERE id=11").get()).toEqual({ progress: 65 });
    expect(
      clientB.sql.prepare("SELECT COUNT(*) AS c FROM user_state_record WHERE entity_key=?").get(targetReadingKey),
    ).toEqual({ c: 1 });
    expect(
      clientB.sql.prepare("SELECT COUNT(*) AS c FROM user_state_record WHERE entity_key=?").get(userStateEntityKey(retiredEntity)),
    ).toEqual({ c: 0 });
  });

  it("T4-07: backup export serialization + pausedAfterRestore fence + resumeUserStateAfterRestore", async () => {
    addWorkToClient(activeClient, 1, DEFAULT_WORK, { inLibrary: true });
    useUserStateStore.getState().setEnabled(SERVER_URL, true);
    await setChapterBookmark(11, true);

    await uploadDeviceBackup(SERVER_URL);
    expect((await getUserStateStatus()).pending).toBe(0);

    // Simulate restored device backup behind pausedAfterRestore fence.
    activeClient.sql.exec("UPDATE user_state_restore_state SET paused=1,restored=1 WHERE id=1");
    expect((await getUserStateStatus()).pausedAfterRestore).toBe(true);
    await expect(synchronizeUserState()).rejects.toThrow(/paused/i);

    activeServer.requestLog = [];
    await resumeUserStateAfterRestore();
    await waitForUserStateDeferredApply();
    expect((await getUserStateStatus()).pausedAfterRestore).toBe(false);
    // Restored rows must not be converted into seed: true uploads.
    const ops = activeServer.requestLog
      .filter((r) => r.path === "/user-state/merge")
      .flatMap((r) => (r.body as { operations: UserStateOperation[] }).operations);
    expect(ops.some((o) => o.seed === true)).toBe(false);
  });

  it("T4-08: bulk progress clear + operation pruning + identity upgrade safety", async () => {
    const unresolvedWork: UserStateWorkReference = { ...DEFAULT_WORK, sourceNovelId: null };
    const chapters = Array.from({ length: 20 }, (_, i) => ({
      id: 11 + i,
      path: `/ch/${i + 1}`,
      name: `Ch ${i + 1}`,
      progress: i < 2 ? 100 : 0,
      unread: i < 2 ? 0 : 1,
      readAt: i < 2 ? 1_700_000_000 : null,
    }));
    addWorkToClient(activeClient, 1, unresolvedWork, { chapters });
    await synchronizeUserState();
    const binding = (await getUserStateBinding(SERVER_URL))!;

    await clearReadingProgress();
    const readingIntentsAfterClear = activeClient.sql
      .prepare("SELECT entity_key FROM user_state_intent WHERE json_extract(entity_json,'$.kind')='reading'")
      .all();
    expect(readingIntentsAfterClear).toHaveLength(2);

    await mocks.invoke("db_user_state_prune_operations", { binding, olderThanSecs: 0 });
    activeClient.sql.exec("UPDATE novel SET source_novel_id='novel-42'");
    await runTx(activeClient, (db) => refreshUnattemptedUserStateIdentitiesInDb(db));
    await synchronizeUserState();

    expect((await getUserStateStatus()).pending).toBe(0);
  });

  it("T4-09: category alias + deletion + physical GC + cross-device category recreation", async () => {
    const clientA = activeClient;
    addWorkToClient(clientA, 1, DEFAULT_WORK, { inLibrary: true });
    await insertCategory({ name: "Sci-Fi", sort: 1 });
    await synchronizeUserState();

    const clientB = createSqliteFixture("Client B");
    activateClient(clientB, SERVER_URL);
    await insertCategory({ name: "Sci-Fi", sort: 1 });
    await synchronizeUserState();
    expect(clientB.sql.prepare("SELECT COUNT(*) AS c FROM user_state_alias").get()).toEqual({ c: 1 });

    // Device A assigns novel 1 to Sci-Fi, then deletes Sci-Fi and server GCs tombstone + alias.
    activateClient(clientA, SERVER_URL);
    const catA = clientA.sql.prepare("SELECT id FROM category WHERE name='Sci-Fi'").get() as { id: number };
    await setNovelCategories(1, [catA.id]);
    expect(clientA.sql.prepare("SELECT COUNT(*) AS c FROM novel_category").get()).toEqual({ c: 1 });
    await deleteCategory(catA.id);
    await synchronizeUserState();
    activeServer.physicalGcTombstones();

    // Device B reconnects via 410 -> /snapshot, cleans dangling alias, and recreates Sci-Fi cleanly.
    activateClient(clientB, SERVER_URL);
    await synchronizeUserState();
    await waitForUserStateDeferredApply();
    expect(clientB.sql.prepare("SELECT COUNT(*) AS c FROM user_state_alias").get()).toEqual({ c: 0 });

    await insertCategory({ name: "Sci-Fi", sort: 2 });
    await synchronizeUserState();
    expect((await getUserStateStatus()).conflicts).toEqual([]);
  });

  it("T4-11: 2-A + 2-B combined hygiene cycle reflected cleanly on client sync", async () => {
    const libWork: UserStateWorkReference = { ...DEFAULT_WORK, sourceNovelId: "lib-1", novelPath: "/lib/1", name: "Lib" };
    const nonLibWork: UserStateWorkReference = {
      ...DEFAULT_WORK,
      sourceNovelId: "nonlib-1",
      novelPath: "/nonlib/1",
      name: "NonLib",
    };
    addWorkToClient(activeClient, 1, libWork, { inLibrary: true, chapters: [{ id: 11, path: "/ch/1", name: "L1" }] });
    addWorkToClient(activeClient, 2, nonLibWork, { inLibrary: false, chapters: [{ id: 21, path: "/ch/1", name: "N1" }] });

    const libRead: UserStateEntity = { kind: "reading", work: libWork, chapter: { chapterPath: "/ch/1", name: "L1" } };
    const nonLibRead: UserStateEntity = { kind: "reading", work: nonLibWork, chapter: { chapterPath: "/ch/1", name: "N1" } };
    activeServer.seedRemoteRecord({ kind: "library", work: libWork }, { inLibrary: true, addedAt: 100 });
    activeServer.seedRemoteRecord(libRead, { progress: 80, readAt: 1_650_000_000 });
    activeServer.seedRemoteRecord(nonLibRead, { progress: 40, readAt: 1_650_000_000 });
    await synchronizeUserState();
    await waitForUserStateDeferredApply();

    // Server applies 2-A (prunes nonLibRead) + 2-B (clears readAt on libRead preserving progress=80) + GC.
    activeServer.records.delete(userStateEntityKey(nonLibRead));
    activeServer.applyPolicy2B(libRead);
    activeServer.physicalGcTombstones(activeServer.headRevision);

    await synchronizeUserState();
    await waitForUserStateDeferredApply();

    expect(activeClient.sql.prepare("SELECT progress,read_at FROM chapter WHERE id=11").get()).toEqual({
      progress: 80,
      read_at: null,
    });
    expect(
      activeClient.sql
        .prepare("SELECT COUNT(*) AS c FROM user_state_record WHERE entity_key=?")
        .get(userStateEntityKey(nonLibRead)),
    ).toEqual({ c: 0 });
  });

  it("T4-12: retries /snapshot cleanly when concurrent compaction triggers a second 410 on follow-up /read", async () => {
    const ch1 = { chapterPath: "/ch/1", name: "Ch 1" };
    const ch2 = { chapterPath: "/ch/2", name: "Ch 2" };
    addWorkToClient(activeClient, 1, DEFAULT_WORK, {
      chapters: [
        { id: 11, path: ch1.chapterPath, name: ch1.name },
        { id: 12, path: ch2.chapterPath, name: ch2.name },
      ],
    });
    const bm1: UserStateEntity = { kind: "bookmark", work: DEFAULT_WORK, chapter: ch1 };
    const bm2: UserStateEntity = { kind: "bookmark", work: DEFAULT_WORK, chapter: ch2 };
    const temp: UserStateEntity = { kind: "bookmark", work: DEFAULT_WORK, chapter: { chapterPath: "/ch/tmp", name: "Tmp" } };
    activeServer.seedRemoteRecord(temp, { bookmarked: true });
    activeServer.seedRemoteRecord(temp, { bookmarked: false });
    activeServer.physicalGcTombstones();
    activeServer.seedRemoteRecord(bm1, { bookmarked: true });

    let snapshotCount = 0;
    const origHandle = activeServer.handle.bind(activeServer);
    mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const res = await origHandle(url, init);
      if (url.endsWith("/user-state/snapshot")) {
        snapshotCount += 1;
        if (snapshotCount === 1) {
          // Before follow-up /read runs, another tombstone is GC'd so compactedThrough advances past snapshotRevision.
          const temp2: UserStateEntity = { kind: "bookmark", work: DEFAULT_WORK, chapter: { chapterPath: "/ch/tmp2", name: "Tmp2" } };
          activeServer.seedRemoteRecord(bm2, { bookmarked: true });
          activeServer.seedRemoteRecord(temp2, { bookmarked: true });
          activeServer.seedRemoteRecord(temp2, { bookmarked: false });
          activeServer.physicalGcTombstones();
        }
      }
      return res;
    });

    await synchronizeUserState();
    await waitForUserStateDeferredApply();

    expect(snapshotCount).toBe(2);
    expect(activeClient.sql.prepare("SELECT id,bookmark FROM chapter ORDER BY id").all()).toEqual([
      { id: 11, bookmark: 1 },
      { id: 12, bookmark: 1 },
    ]);
  });

  it("T4-13: library add and remove stay device-local across devices while reading progress still syncs", async () => {
    const workA: UserStateWorkReference = { ...DEFAULT_WORK, sourceNovelId: "work-a", novelPath: "/work/a", name: "Work A" };
    const workB: UserStateWorkReference = { ...DEFAULT_WORK, sourceNovelId: "work-b", novelPath: "/work/b", name: "Work B" };

    const clientA = activeClient;
    addWorkToClient(clientA, 1, workA, {
      inLibrary: true,
      chapters: [{ id: 11, path: "/ch/1", name: "A1", progress: 40, unread: 0, readAt: 1_750_000_000 }],
    });
    addWorkToClient(clientA, 2, workB, {
      inLibrary: false,
      chapters: [{ id: 21, path: "/ch/1", name: "B1" }],
    });

    const clientB = createSqliteFixture("Client B");
    addWorkToClient(clientB, 1, workA, {
      inLibrary: true,
      chapters: [{ id: 11, path: "/ch/1", name: "A1" }],
    });
    addWorkToClient(clientB, 2, workB, {
      inLibrary: false,
      chapters: [{ id: 21, path: "/ch/1", name: "B1" }],
    });
    clientB.sql.exec("INSERT INTO novel_download_goal(novel_id,kind,count,updated_at) VALUES(1,'keep_ahead',3,100)");

    // Sync initial state from A, then A removes Work A from library and adds Work B to library.
    activateClient(clientA, SERVER_URL);
    await synchronizeUserState();
    await mocks.invoke("db_novel_set_in_library", { id: 1, inLibrary: false });
    await mocks.invoke("db_novel_set_in_library", { id: 2, inLibrary: true });
    await synchronizeUserState();

    // Even if a legacy older client wrote library records directly on the server, Device B ignores them.
    activeServer.seedRemoteRecord({ kind: "library", work: workA }, { inLibrary: false, addedAt: null });
    activeServer.seedRemoteRecord({ kind: "library", work: workB }, { inLibrary: true, addedAt: 1_750_000_100 });

    activateClient(clientB, SERVER_URL);
    await synchronizeUserState();
    await waitForUserStateDeferredApply();

    // Device B keeps Work A in library with its download goal, and keeps Work B out of library.
    expect(clientB.sql.prepare("SELECT id,in_library FROM novel ORDER BY id").all()).toEqual([
      { id: 1, in_library: 1 },
      { id: 2, in_library: 0 },
    ]);
    expect(clientB.sql.prepare("SELECT kind,count FROM novel_download_goal WHERE novel_id=1").get()).toEqual({
      kind: "keep_ahead",
      count: 3,
    });
    // Reading progress from Device A still synced to Device B.
    expect(clientB.sql.prepare("SELECT progress FROM chapter WHERE id=11").get()).toEqual({
      progress: 40,
    });
  });
});

// Keep validateUserStatePage / validateUserStateAcknowledgements / readUserStateResponse / USER_STATE_MAX_BYTES referenced in invariant checks.
describe("Client E2E — Protocol Helper Invariants", () => {
  it("verifies readUserStateResponse 32 MiB cap, validateUserStatePage, and validateUserStateAcknowledgements", async () => {
    await expect(
      readUserStateResponse(
        new Response("{}", { headers: { "content-length": String(USER_STATE_MAX_BYTES + 1) } }),
      ),
    ).rejects.toThrow(/size limit/i);

    const binding: UserStateBinding = { serverUrl: SERVER_URL, workspaceId: "ws", epoch: "ep" };
    expect(() =>
      validateUserStatePage(
        {
          version: 1,
          workspaceId: "ws",
          epoch: "ep-other",
          headRevision: 1,
          through: 1,
          nextCursor: 1,
          hasMore: false,
          records: [],
        },
        binding,
        0,
        1,
      ),
    ).toThrow(/workspace changed/i);

    const op: UserStateOperation = {
      operationId: "op-1",
      entity: { kind: "bookmark", work: DEFAULT_WORK, chapter: { chapterPath: "/ch/1" } },
      baseRevision: 0,
      value: { bookmarked: true },
    };
    expect(() =>
      validateUserStateAcknowledgements(
        {
          version: 1,
          workspaceId: "ws",
          epoch: "ep",
          headRevision: 1,
          results: [{ operationId: "op-1", status: "seed-skipped", current: null }],
        },
        binding,
        [op],
      ),
    ).toThrow(/explicit edit cannot be acknowledged as a seed/i);
  });
});
