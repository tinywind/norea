import { beforeEach, expect, it, vi } from "vitest";
import type { SourceAccessBlock, TaskRecord } from "./scheduler";
import type { VpnDownloadPlan, VpnDownloadRangeState } from "./vpn-download-types";
const mocks=vi.hoisted(()=>({pauseTaskGroup:vi.fn(),resumeTaskGroup:vi.fn(),getSnapshot:vi.fn(),open:vi.fn(),restored:vi.fn(),canBeginSourceAccessVerification:vi.fn(),waitForSourceTaskSettlement:vi.fn()}));
vi.mock("./scheduler",()=>({taskScheduler:mocks}));
vi.mock("./source-access-coordinator",()=>({openSourceAccessBrowser:mocks.open,sourceAccessBlockSourceNames:()=>["Source"]}));
vi.mock("./chapter-download",()=>({waitForChapterDownloadQueueRestoration:mocks.restored}));
const vpn = vi.hoisted(() => ({ getSnapshot: vi.fn(), initialize: vi.fn(), open: vi.fn() }));
vi.mock("./vpn-download-runtime", () => ({
  getVpnDownloadRuntimeSnapshot: vpn.getSnapshot, initializeVpnDownloadRuntime: vpn.initialize, openVpnDownloadVerification: vpn.open,
}));
import { applyTaskNotificationAction } from "./task-notification-actions";
const t=((key:string)=>key) as Parameters<typeof applyTaskNotificationAction>[2];
const block: SourceAccessBlock={sourceId:"source-a",scopeKey:"plugin:source-a:site:source.test",revision:2,detectedAt:1,verificationRequested:false,challenge:{kind:"captcha",url:"https://source.test/trusted-chapter"}};
beforeEach(()=>{vi.clearAllMocks();mocks.restored.mockResolvedValue(undefined);mocks.canBeginSourceAccessVerification.mockReturnValue(true);mocks.waitForSourceTaskSettlement.mockResolvedValue(undefined);mocks.getSnapshot.mockReturnValue({records:[],sourceAccessBlocks:[block]});mocks.open.mockResolvedValue(true);vpn.initialize.mockResolvedValue(undefined);vpn.open.mockResolvedValue(undefined);});
it("applies controls to the requested category without opening an activity page",async()=>{
 const openTasks=vi.fn();await applyTaskNotificationAction({type:"pause",groupKey:"libraryMetadata"},openTasks,t);
 await applyTaskNotificationAction({type:"resume",groupKey:"downloads"},openTasks,t);
 expect(mocks.pauseTaskGroup).toHaveBeenCalledExactlyOnceWith("libraryMetadata");
 expect(mocks.resumeTaskGroup).toHaveBeenCalledExactlyOnceWith("downloads");expect(openTasks).not.toHaveBeenCalled();
});
it("opens task details for a normal notification tap",async()=>{
 const openTasks=vi.fn();await applyTaskNotificationAction({type:"openTasks"},openTasks,t);
 expect(openTasks).toHaveBeenCalledOnce();expect(mocks.open).not.toHaveBeenCalled();
});
it("opens the current trusted source block after navigating to tasks",async()=>{
 const openTasks=vi.fn();await applyTaskNotificationAction({type:"verifySource",sourceId:block.sourceId,scopeKey:block.scopeKey,revision:2},openTasks,t);
 expect(openTasks).toHaveBeenCalledOnce();expect(mocks.open).toHaveBeenCalledWith(block,expect.objectContaining({sourceName:"Source"}));
});
it("waits for persisted downloads to restore and rechecks the challenge identity",async()=>{
 let restore!:()=>void;mocks.restored.mockReturnValue(new Promise<void>(resolve=>{restore=resolve;}));
 const action={type:"verifySource" as const,sourceId:block.sourceId,scopeKey:block.scopeKey,revision:2};
 const pending=applyTaskNotificationAction(action,vi.fn(),t);
 await Promise.resolve();expect(mocks.open).not.toHaveBeenCalled();
 mocks.getSnapshot.mockReturnValue({records:[],sourceAccessBlocks:[]});restore();await pending;
 expect(mocks.open).not.toHaveBeenCalled();
});
const localDownload: TaskRecord = {
 id:"restored-download",lane:"source",kind:"chapter.download",status:"running",priority:"background",
 title:"Chapter 33",source:{id:block.sourceId,name:"Source"},subject:{chapterId:33,pluginId:block.sourceId},
 chapterDownloadPhase:"local",createdAt:1,canCancel:true,canRetry:false,
};
it("keeps a cold source tap pending while the restored download scans local content before requeuing",async()=>{
 let settle!:()=>void;mocks.waitForSourceTaskSettlement.mockReturnValue(new Promise<void>(resolve=>{settle=resolve;}));
 mocks.canBeginSourceAccessVerification.mockReturnValue(false);
 mocks.getSnapshot.mockReturnValue({records:[localDownload],sourceAccessBlocks:[block]});
 const pending=applyTaskNotificationAction({type:"verifySource",sourceId:block.sourceId,scopeKey:block.scopeKey,revision:2},vi.fn(),t);
 await vi.waitFor(()=>expect(mocks.waitForSourceTaskSettlement).toHaveBeenCalledExactlyOnceWith(localDownload.id));
 expect(mocks.open).not.toHaveBeenCalled();
 mocks.getSnapshot.mockReturnValue({records:[{...localDownload,status:"queued"}],sourceAccessBlocks:[block]});
 mocks.canBeginSourceAccessVerification.mockReturnValue(true);settle();await pending;
 expect(mocks.open).toHaveBeenCalledExactlyOnceWith(block,expect.objectContaining({sourceName:"Source"}));
});
it("rechecks the exact source revision after a running local candidate settles",async()=>{
 let settle!:()=>void;mocks.waitForSourceTaskSettlement.mockReturnValue(new Promise<void>(resolve=>{settle=resolve;}));
 mocks.canBeginSourceAccessVerification.mockReturnValue(false);
 mocks.getSnapshot.mockReturnValue({records:[localDownload],sourceAccessBlocks:[block]});
 const pending=applyTaskNotificationAction({type:"verifySource",sourceId:block.sourceId,scopeKey:block.scopeKey,revision:2},vi.fn(),t);
 await vi.waitFor(()=>expect(mocks.waitForSourceTaskSettlement).toHaveBeenCalledOnce());
 mocks.getSnapshot.mockReturnValue({records:[{...localDownload,status:"queued"}],sourceAccessBlocks:[{...block,revision:3}]});
 mocks.canBeginSourceAccessVerification.mockReturnValue(true);settle();await pending;
 expect(mocks.open).not.toHaveBeenCalled();
});
it("does not await a different plugin or an already open source browser",async()=>{
 mocks.canBeginSourceAccessVerification.mockReturnValue(false);
 mocks.getSnapshot.mockReturnValue({records:[{...localDownload,source:{id:"other",name:"Other"}},{...localDownload,id:"browser",kind:"source.openSite"}],sourceAccessBlocks:[block]});
 await applyTaskNotificationAction({type:"verifySource",sourceId:block.sourceId,scopeKey:block.scopeKey,revision:2},vi.fn(),t);
 expect(mocks.waitForSourceTaskSettlement).not.toHaveBeenCalled();expect(mocks.open).not.toHaveBeenCalled();
});
it.each(["openTasks","verifySource"] as const)("does not let an older local-read wait override a newer %s tap",async(type)=>{
 let settle!:()=>void;mocks.waitForSourceTaskSettlement.mockReturnValue(new Promise<void>(resolve=>{settle=resolve;}));
 const nextBlock={...block,sourceId:"source-b",scopeKey:"plugin:source-b:site:source.test",revision:3};
 mocks.canBeginSourceAccessVerification.mockImplementation((scope:string)=>scope===nextBlock.scopeKey);
 mocks.getSnapshot.mockReturnValue({records:[localDownload],sourceAccessBlocks:[block,nextBlock]});
 const older=applyTaskNotificationAction({type:"verifySource",sourceId:block.sourceId,scopeKey:block.scopeKey,revision:2},vi.fn(),t);
 await vi.waitFor(()=>expect(mocks.waitForSourceTaskSettlement).toHaveBeenCalledOnce());
 await applyTaskNotificationAction(type==="openTasks"?{type}:{type,sourceId:nextBlock.sourceId,scopeKey:nextBlock.scopeKey,revision:3},vi.fn(),t);
 mocks.getSnapshot.mockReturnValue({records:[{...localDownload,status:"queued"}],sourceAccessBlocks:[block,nextBlock]});
 mocks.canBeginSourceAccessVerification.mockReturnValue(true);settle();await older;
 if(type==="openTasks")expect(mocks.open).not.toHaveBeenCalled();
 else expect(mocks.open).toHaveBeenCalledExactlyOnceWith(nextBlock,expect.objectContaining({sourceName:"Source"}));
});
it("keeps a pending verification request when a group control is tapped",async()=>{
 let settle!:()=>void;mocks.waitForSourceTaskSettlement.mockReturnValue(new Promise<void>(resolve=>{settle=resolve;}));
 mocks.canBeginSourceAccessVerification.mockReturnValue(false);
 mocks.getSnapshot.mockReturnValue({records:[localDownload],sourceAccessBlocks:[block]});
 const pending=applyTaskNotificationAction({type:"verifySource",sourceId:block.sourceId,scopeKey:block.scopeKey,revision:2},vi.fn(),t);
 await vi.waitFor(()=>expect(mocks.waitForSourceTaskSettlement).toHaveBeenCalledOnce());
 await applyTaskNotificationAction({type:"pause",groupKey:"downloads"},vi.fn(),t);
 mocks.getSnapshot.mockReturnValue({records:[{...localDownload,status:"queued"}],sourceAccessBlocks:[block]});
 mocks.canBeginSourceAccessVerification.mockReturnValue(true);settle();await pending;
 expect(mocks.open).toHaveBeenCalledExactlyOnceWith(block,expect.objectContaining({sourceName:"Source"}));
});
it("ignores stale revisions and plugin identity mismatches",async()=>{
 const openTasks=vi.fn();for(const change of [{revision:1},{sourceId:"source-b"}])await applyTaskNotificationAction({type:"verifySource",sourceId:block.sourceId,scopeKey:block.scopeKey,revision:2,...change},openTasks,t);
 expect(mocks.open).not.toHaveBeenCalled();
});

const owner: VpnDownloadRangeState = {
 id:"range-a",profileId:"profile-a",profileHash:"hash",startChapterId:1,endChapterId:2,chapterIds:[1,2],selectedChapterIds:[1,2],
 checkpoint:0,phase:"paused",userPaused:false,pauseReason:"challenge-captcha",attemptedProfileIds:["profile-a"],attemptProfileId:null,
 generation:8,challenge:{kind:"captcha",url:"https://source.test/owned"},
};
const plan: VpnDownloadPlan = {id:"plan-a",batchId:"batch-a",pluginId:"source-a",novelId:1,title:"Work",mode:"single",policies:{captcha:"pause",cloudflare:"pause"},createdAt:1,revision:1,ranges:[owner]};
const rangeAction = {type:"verifyVpnDownload" as const,planId:plan.id,sourceId:plan.pluginId,rangeId:owner.id,profileId:owner.profileId,generation:8,checkpoint:0};

it("opens only the owning range after runtime and chapter queue restoration", async () => {
 let restore!:()=>void;
 vpn.initialize.mockReturnValue(new Promise<void>(resolve=>{restore=resolve;}));
 vpn.getSnapshot.mockReturnValue({plans:[plan]});
 const openTasks=vi.fn();
 const pending=applyTaskNotificationAction(rangeAction,openTasks,t);
 await vi.waitFor(()=>expect(vpn.initialize).toHaveBeenCalledOnce());
 expect(vpn.open).not.toHaveBeenCalled();
 restore();await pending;
 expect(openTasks).toHaveBeenCalledOnce();
 expect(vpn.open).toHaveBeenCalledExactlyOnceWith("plan-a","range-a");
 expect(mocks.open).not.toHaveBeenCalled();
});

it.each([
 {generation:9},{profileId:"replacement"},{phase:"cancelled"},{phase:"completed"},{phase:"running"},
 {challenge:null},{checkpoint:1},{pauseReason:"interrupted"},{pauseReason:"profiles-exhausted"},
] as Partial<VpnDownloadRangeState>[])("ignores a stale range notification after owner state changes: %j", async patch => {
 vpn.getSnapshot.mockReturnValue({plans:[{...plan,ranges:[{...owner,...patch}]}]});
 await applyTaskNotificationAction(rangeAction,vi.fn(),t);
 expect(vpn.open).not.toHaveBeenCalled();expect(mocks.open).not.toHaveBeenCalled();
});

it.each([{planId:"wrong"},{rangeId:"wrong"},{sourceId:"wrong"},{generation:0}])("rejects the wrong range action identity %j",async patch=>{
 vpn.getSnapshot.mockReturnValue({plans:[plan]});
 await applyTaskNotificationAction({...rangeAction,...patch},vi.fn(),t);
 expect(vpn.open).not.toHaveBeenCalled();expect(mocks.open).not.toHaveBeenCalled();
});

it("does not open a default source browser for a forged source action referencing a worker block", async()=>{
 mocks.getSnapshot.mockReturnValue({records:[],sourceAccessBlocks:[{...block,rangeId:"range-a",workerGeneration:8}]});
 await applyTaskNotificationAction({type:"verifySource",sourceId:block.sourceId,scopeKey:block.scopeKey,revision:2},vi.fn(),t);
 expect(mocks.open).not.toHaveBeenCalled();expect(vpn.open).not.toHaveBeenCalled();
});

it("rechecks a rotated owner after restoration and lets a newer task tap cancel a pending range tap", async()=>{
 let restore!:()=>void;
 vpn.initialize.mockReturnValue(new Promise<void>(resolve=>{restore=resolve;}));
 vpn.getSnapshot.mockReturnValue({plans:[plan]});
 const pending=applyTaskNotificationAction(rangeAction,vi.fn(),t);
 await vi.waitFor(()=>expect(vpn.initialize).toHaveBeenCalledOnce());
 await applyTaskNotificationAction({type:"openTasks"},vi.fn(),t);
 restore();await pending;
 expect(vpn.open).not.toHaveBeenCalled();
});
