import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceAccessBlock, TaskEvent, TaskRecord, TaskSnapshot } from "./scheduler";

const mocks = vi.hoisted(() => ({
  getSnapshot: vi.fn(), subscribe: vi.fn(), subscribeEvents: vi.fn(),
  setBackgroundExecutionSuspended: vi.fn(),
}));
vi.mock("../tauri-runtime", () => ({ isAndroidRuntime: () => true }));
vi.mock("./scheduler", () => ({ taskScheduler: mocks }));
vi.mock("./vpn-download-runtime", () => ({
  getVpnDownloadRuntimeSnapshot: () => ({ plans: [] }), subscribeVpnDownloadRuntime: () => () => {},
}));

import { startAndroidTaskNotifications } from "./android-notifications";
import { useNetworkStore } from "../network";

const listeners = new Map<string, () => void>();
let update: ReturnType<typeof vi.fn>;
let emit: (event: TaskEvent) => void;
let publish: () => void;
let dispose: (() => void) | undefined;
const t = ((key: string) => key) as Parameters<typeof startAndroidTaskNotifications>[0];
function task(id: string, kind: TaskRecord["kind"]): TaskRecord {
  return { id,kind,lane:"source",priority:"background",title:id,status:"queued",createdAt:1,canCancel:true,canRetry:false,source:{id:"source-a",name:"Source A"} };
}
function snapshot(records: TaskRecord[], blocks: SourceAccessBlock[] = []): TaskSnapshot {
  return { records,sourceAccessBlocks:blocks,pausedSourceIds:[],sourceQueuesPaused:false,recordLimit:records.length,recordsTruncated:false,sourceQueueLimit:1,sourceQueueOrder:[],sourceQueuesTotal:1,sourceQueuesTruncated:false,total:records.length,running:0,queued:records.length,failed:0,succeeded:0,cancelled:0 };
}
function block(sourceId: string): SourceAccessBlock {
  return {sourceId,scopeKey:`plugin:${sourceId}:site:source.test`,revision:1,detectedAt:1,verificationRequested:false,challenge:{kind:"captcha",url:"https://source.test/chapter/1"}};
}
function payload() { return JSON.parse(update.mock.calls.at(-1)![0] as string); }

beforeEach(() => {
  vi.useFakeTimers();vi.clearAllMocks();listeners.clear();
  update=vi.fn();emit=()=>{};publish=()=>{};
  mocks.subscribe.mockImplementation((listener:()=>void)=>{publish=listener;return vi.fn();});
  mocks.subscribeEvents.mockImplementation((listener:(event:TaskEvent)=>void)=>{emit=listener;return vi.fn();});
  mocks.getSnapshot.mockReturnValue(snapshot([]));
  vi.stubGlobal("window",{__NoreaAndroidTasks:{update,stop:vi.fn(),drainActions:vi.fn(()=>"[]")},addEventListener:(key:string,listener:()=>void)=>listeners.set(key,listener),removeEventListener:(key:string)=>listeners.delete(key)});
  useNetworkStore.setState({connectivity:"online",revision:1});
});
afterEach(()=>{dispose?.();dispose=undefined;vi.useRealTimers();vi.unstubAllGlobals();});

describe("Android task notification groups",()=>{
  it("keeps downloads and metadata in distinct independently controllable cards",()=>{
    mocks.getSnapshot.mockReturnValue(snapshot([task("download","chapter.download"),task("metadata","source.refreshNovel")]));
    dispose=startAndroidTaskNotifications(t,"progress");
    expect(payload().groups.map((g:{key:string})=>g.key)).toEqual(["downloads","libraryMetadata"]);
    expect(payload().groups.every((g:{pauseLabel:string;resumeLabel:string})=>g.pauseLabel&&g.resumeLabel)).toBe(true);
  });
  it("retains separate plugin challenge identities and removes only the resolved one",()=>{
    const a=block("source-a"),b=block("source-b");
    mocks.getSnapshot.mockReturnValue(snapshot([], [a,b]));
    dispose=startAndroidTaskNotifications(t,"off");
    expect(payload().challenges.map((v:{sourceId:string})=>v.sourceId)).toEqual(["source-a","source-b"]);
    mocks.getSnapshot.mockReturnValue(snapshot([], [b]));publish();vi.advanceTimersByTime(250);
    expect(payload().challenges.map((v:{sourceId:string})=>v.sourceId)).toEqual(["source-b"]);
    expect(payload().groups).toEqual([]);
  });
  it("publishes completion results in completion-only mode",()=>{
    const download=task("download","chapter.download");
    mocks.getSnapshot.mockReturnValue(snapshot([download]));
    dispose=startAndroidTaskNotifications(t,"completion");
    expect(payload().groups).toEqual([]);
    mocks.getSnapshot.mockReturnValue(snapshot([]));
    emit({task:{...download,status:"succeeded"},previousStatus:"running"});
    publish();vi.advanceTimersByTime(250);
    expect(payload().completions).toEqual([expect.objectContaining({key:"downloads"})]);
  });
  it("releases the wake lock while an aggregate waits on source verification",()=>{
    const download=task("download","chapter.download");
    const aggregate={...task("check","library.checkUpdates"),lane:"main" as const,status:"running" as const};
    mocks.getSnapshot.mockReturnValue(snapshot([download,aggregate],[block("source-a")]));
    dispose=startAndroidTaskNotifications(t,"progress");
    expect(payload().executionActive).toBe(true);
    expect(payload().working).toBe(false);
    const local={...download,status:"running" as const,chapterDownloadPhase:"local" as const};
    const next={...snapshot([local,aggregate],[block("source-a")]),sourceQueuesPaused:true};
    mocks.getSnapshot.mockReturnValue(next);emit({task:local,previousStatus:"queued"});publish();vi.advanceTimersByTime(250);
    expect(payload().working).toBe(true);
  });
  it("drains a cold-start action once and ignores malformed action input",()=>{
    const onAction=vi.fn();
    window.__NoreaAndroidTasks!.drainActions=vi.fn().mockReturnValueOnce(JSON.stringify([{type:"openTasks"},{type:"verifySource",sourceId:"source-a",scopeKey:block("source-a").scopeKey,revision:1},{type:"runScript",script:"bad"}])).mockReturnValue("[]");
    dispose=startAndroidTaskNotifications(t,"off",onAction);
    expect(onAction.mock.calls.map(([action])=>action.type)).toEqual(["openTasks","verifySource"]);
    listeners.get("norea-task-notification-action")?.();
    expect(onAction).toHaveBeenCalledTimes(2);
  });
});
