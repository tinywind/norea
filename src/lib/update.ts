import { invoke } from "@tauri-apps/api/core";
import { appFetch } from "./http";
import {
  cancelNativeStream,
  createNativeStream,
  finishNativeStream,
  writeNativeStream,
} from "./native-stream";
import {
  MAX_INLINE_IPC_BYTES,
  MAX_UPDATE_BYTES,
  assertByteBudget,
  parseContentLength,
} from "./performance-budgets";
import { recordPerformanceObservation } from "./observability";

const GITHUB_API_BASE = "https://api.github.com/repos/tinywind/norea";
const UPDATE_MANIFEST_SCHEMA_VERSION = 1;
const ANDROID_UPDATE_STREAM_TTL_MS = 30 * 60 * 1000;
const ANDROID_UPDATE_OPEN_APK_CAPABILITY = "update.openApk";
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/i;

export type UpdateChannel = "official" | "dev";
type UpdateManifestChannel = "stable" | "dev";
export type UpdateStatus = "newer" | "current" | "unknown";

export interface BuildInfo {
  buildChannel: string | null;
  buildTime: string | null;
  buildVersion: string | null;
  gitSha: string | null;
  githubRunAttempt: string | null;
  githubRunId: string | null;
  platform: string;
  targetArch: string;
  targetFamily: string;
  targetOs: string;
}

export interface UpdateAssetIntegrity {
  sha256: string;
  signature: string | null;
  signingKeyId: string | null;
  size: number;
}

export interface UpdateDevRunMetadata {
  artifactName: string | null;
  headSha: string;
  runAttempt: string;
  runId: string;
  workflow: string;
}

export interface UpdateCandidate {
  assetName: string;
  channel: UpdateChannel;
  devRun?: UpdateDevRunMetadata;
  displayName: string;
  downloadSize: number | null;
  downloadFileName: string;
  downloadUrl: string;
  integrity: UpdateAssetIntegrity;
  remoteTime: string | null;
  remoteVersion: string | null;
  sourceUrl: string;
  status: UpdateStatus;
}

export interface UpdateManifestAsset extends UpdateAssetIntegrity {
  artifactName: string | null;
  name: string;
  platform: string | null;
}

export interface UpdateManifest {
  assets: UpdateManifestAsset[];
  channel: UpdateManifestChannel;
  dev: UpdateDevRunMetadata | null;
  generatedAt: string | null;
  platform: string;
  schemaVersion: number;
  signature: string | null;
  signingKeyId: string | null;
  version: string | null;
}

interface GitHubRelease {
  assets: GitHubReleaseAsset[];
  html_url: string;
  name: string | null;
  published_at: string | null;
  tag_name: string;
}

interface GitHubReleaseAsset {
  browser_download_url: string;
  name: string;
  size?: number;
}

interface GitHubWorkflowRunsResponse {
  workflow_runs: GitHubWorkflowRun[];
}

interface GitHubWorkflowRun {
  conclusion: string | null;
  created_at: string;
  head_sha?: string | null;
  html_url: string;
  id: number;
  run_attempt?: number | string | null;
  status: string | null;
  updated_at: string;
}

interface GitHubArtifactsResponse {
  artifacts: GitHubArtifact[];
}

interface GitHubArtifact {
  expired: boolean;
  name: string;
  size_in_bytes?: number;
}

interface WorkflowArtifactSelection {
  artifact: GitHubArtifact;
}

interface AssetPreference {
  exactName?: string;
  extensions?: string[];
  token: string;
}

interface AndroidUpdateInstallBridge {
  openApk: (payload: string) => string;
}

interface AndroidBridgeInfoBridge {
  nonce: () => string;
  session: () => string;
}

interface AndroidUpdateInstallResult {
  error?: string;
  ok?: boolean;
}

interface Semver {
  major: number;
  minor: number;
  patch: number;
}

declare global {
  interface Window {
    __NoreaAndroidBridge?: AndroidBridgeInfoBridge;
    __NoreaAndroidUpdater?: AndroidUpdateInstallBridge;
  }
}

export function getBuildInfo(): Promise<BuildInfo> {
  return invoke<BuildInfo>("get_build_info");
}

export async function checkOfficialUpdate(
  buildInfo: BuildInfo,
): Promise<UpdateCandidate> {
  const release = await fetchGithubJson<GitHubRelease>(
    `${GITHUB_API_BASE}/releases/latest`,
  );
  const manifest = await requireReleaseUpdateManifest(
    release.assets,
    buildInfo.platform,
  );
  validateUpdateManifest(manifest, buildInfo.platform, "stable");
  const manifestAsset = selectUpdateManifestAsset(
    manifest.assets,
    buildInfo.platform,
  );
  const asset = selectManifestReleaseAsset(release.assets, manifestAsset);
  const remoteVersion = normalizeReleaseVersion(
    manifest.version ?? release.tag_name,
  );
  return {
    assetName: asset.name,
    channel: "official",
    displayName: release.name?.trim() || release.tag_name,
    downloadSize: manifestAsset.size,
    downloadFileName: asset.name,
    downloadUrl: asset.browser_download_url,
    integrity: integrityFromManifestAsset(manifestAsset),
    remoteTime: release.published_at,
    remoteVersion,
    sourceUrl: release.html_url,
    status: compareReleaseBuild(buildInfo, remoteVersion, release.published_at),
  };
}

export async function checkDevUpdate(
  buildInfo: BuildInfo,
): Promise<UpdateCandidate> {
  const workflow = workflowForPlatform(buildInfo.platform);
  if (!workflow) {
    throw new Error(`No workflow matches ${buildInfo.platform}.`);
  }

  const runs = await fetchGithubJson<GitHubWorkflowRunsResponse>(
    `${GITHUB_API_BASE}/actions/workflows/${workflow}/runs?status=success&per_page=10`,
  );

  for (const run of runs.workflow_runs) {
    if (run.status !== "completed" || run.conclusion !== "success") {
      continue;
    }

    const artifacts = await fetchGithubJson<GitHubArtifactsResponse>(
      `${GITHUB_API_BASE}/actions/runs/${run.id}/artifacts?per_page=100`,
    );
    const selection = selectWorkflowArtifact(
      artifacts.artifacts,
      buildInfo.platform,
    );
    if (!selection) {
      continue;
    }
    const { artifact } = selection;
    const devRelease = await fetchGithubJson<GitHubRelease>(
      `${GITHUB_API_BASE}/releases/tags/dev`,
    );
    const manifest = await requireReleaseUpdateManifest(
      devRelease.assets,
      buildInfo.platform,
    );
    validateUpdateManifest(manifest, buildInfo.platform, "dev");
    const runBinding = workflowRunBinding(workflow, run);
    validateDevUpdateManifestBinding(manifest, runBinding);

    const manifestAsset = selectUpdateManifestAsset(
      manifest.assets,
      buildInfo.platform,
    );
    const expectedArtifactName = manifestAsset.artifactName ?? manifestAsset.name;
    if (!sameName(expectedArtifactName, artifact.name)) {
      throw new Error(
        `Dev update metadata names ${expectedArtifactName}, but workflow artifact is ${artifact.name}.`,
      );
    }
    const artifactSize = safeByteLength(artifact.size_in_bytes);
    if (artifactSize !== null && artifactSize !== manifestAsset.size) {
      throw new Error(
        `Dev update metadata size for ${manifestAsset.name} does not match workflow artifact.`,
      );
    }
    const asset = selectManifestReleaseAsset(devRelease.assets, manifestAsset);

    return {
      assetName: asset.name,
      channel: "dev",
      devRun: runBinding,
      displayName: `#${run.id}`,
      downloadSize: manifestAsset.size,
      downloadFileName: asset.name,
      downloadUrl: asset.browser_download_url,
      integrity: integrityFromManifestAsset(manifestAsset),
      remoteTime: run.updated_at || run.created_at,
      remoteVersion: null,
      sourceUrl: run.html_url,
      status: compareWorkflowBuild(buildInfo, run),
    };
  }

  throw new Error(`No successful workflow artifact matches ${buildInfo.platform}.`);
}

export async function installUpdate(
  candidate: UpdateCandidate,
  buildInfo?: BuildInfo | null,
): Promise<string> {
  const integrity = candidateIntegrityForInstall(candidate);

  if (buildInfo?.targetOs === "android") {
    return installAndroidUpdate(candidate, integrity);
  }

  return invoke<string>("download_and_open_update", {
    fileName: candidate.downloadFileName,
    metadata: integrity,
    url: candidate.downloadUrl,
  });
}

async function installAndroidUpdate(
  candidate: UpdateCandidate,
  integrity: UpdateAssetIntegrity,
): Promise<string> {
  if (!isAllowedUpdateUrl(candidate.downloadUrl)) {
    throw new Error("Unsupported update host.");
  }

  try {
    const installerPath = await invoke<string>("download_and_open_update", {
      fileName: candidate.downloadFileName,
      metadata: integrity,
      url: candidate.downloadUrl,
    });
    openAndroidInstaller(installerPath, integrity);
    return installerPath;
  } catch (error) {
    if (!shouldUseAndroidRendererDownloadFallback(error)) {
      throw error;
    }
  }

  return installAndroidUpdateViaRendererStream(candidate, integrity);
}

async function installAndroidUpdateViaRendererStream(
  candidate: UpdateCandidate,
  integrity: UpdateAssetIntegrity,
): Promise<string> {
  const response = await appFetch(candidate.downloadUrl, {
    headers: {
      Accept: "application/octet-stream",
      "User-Agent": "Norea",
    },
  });
  if (!response.ok) {
    throw new Error(`Download failed with HTTP ${response.status}.`);
  }

  const contentLength = parseContentLength(response.headers.get("content-length"));
  if (contentLength !== null) {
    validateUpdateDownloadByteLength(contentLength);
    validateInlineUpdateIpcByteLength(contentLength);
    validateExpectedDownloadSize(contentLength, integrity.size);
  }

  const body = await response.arrayBuffer();
  const bodyBytes = new Uint8Array(body);
  validateUpdateDownloadByteLength(bodyBytes.byteLength);
  validateInlineUpdateIpcByteLength(bodyBytes.byteLength);
  await verifyDownloadedUpdateBytes(bodyBytes, integrity);
  recordPerformanceObservation("update.download", {
    byteLength: bodyBytes.byteLength,
    channel: candidate.channel,
    inlineIpcLimit: MAX_INLINE_IPC_BYTES,
    updateLimit: MAX_UPDATE_BYTES,
  });

  let streamHandle: string | null = null;
  try {
    const stream = await createNativeStream({
      domain: "update",
      maxBytes: MAX_UPDATE_BYTES,
      ttlMs: ANDROID_UPDATE_STREAM_TTL_MS,
    });
    streamHandle = stream.handle;
    await writeNativeStream(streamHandle, bodyBytes);
    await finishNativeStream(streamHandle);
    const installerPath = await invoke<string>("open_downloaded_update_handle", {
      fileName: candidate.downloadFileName,
      handle: streamHandle,
      metadata: integrity,
    });
    streamHandle = null;
    openAndroidInstaller(installerPath, integrity);
    return installerPath;
  } catch (error) {
    if (streamHandle) {
      try {
        await cancelNativeStream(streamHandle);
      } catch {
        // The install path already failed; native stream cleanup is best-effort.
      }
    }
    throw error;
  }
}

function shouldUseAndroidRendererDownloadFallback(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unknown command|command .*not found|not registered|disabled on Android/i
    .test(message);
}

async function fetchGithubJson<T>(url: string): Promise<T> {
  const response = await appFetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API returned HTTP ${response.status}.`);
  }

  return response.json() as Promise<T>;
}

export function validateUpdateDownloadByteLength(byteLength: number): void {
  assertByteBudget(byteLength, MAX_UPDATE_BYTES, "Update download");
}

export function validateInlineUpdateIpcByteLength(byteLength: number): void {
  assertByteBudget(byteLength, MAX_INLINE_IPC_BYTES, "Update IPC payload");
}

export async function verifyDownloadedUpdateBytes(
  bytes: ArrayBuffer | ArrayBufferView,
  integrity: UpdateAssetIntegrity,
): Promise<void> {
  validateUpdateIntegrity(integrity);
  const body = bytes instanceof ArrayBuffer
    ? new Uint8Array(bytes)
    : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  validateExpectedDownloadSize(body.byteLength, integrity.size);
  const actualSha256 = await sha256Hex(body);
  if (actualSha256 !== integrity.sha256.toLowerCase()) {
    throw new Error("Update download SHA-256 does not match metadata.");
  }
}

export function validateDevUpdateManifestBinding(
  manifest: UpdateManifest,
  expected: UpdateDevRunMetadata,
): void {
  if (manifest.channel !== "dev") {
    throw new Error("Dev update metadata has the wrong channel.");
  }
  if (!manifest.dev) {
    throw new Error("Dev update metadata is missing workflow provenance.");
  }
  const fields: Array<keyof UpdateDevRunMetadata> = [
    "workflow",
    "runId",
    "runAttempt",
    "headSha",
  ];
  for (const field of fields) {
    if (manifest.dev[field] !== expected[field]) {
      throw new Error(`Dev update metadata ${field} does not match workflow run.`);
    }
  }
}

function isAllowedUpdateUrl(url: string): boolean {
  return (
    url.startsWith("https://github.com/tinywind/norea/") ||
    url.startsWith("https://api.github.com/repos/tinywind/norea/")
  );
}

async function fetchReleaseUpdateManifest(
  assets: readonly GitHubReleaseAsset[],
  platform: string,
): Promise<UpdateManifest | null> {
  const manifestName = updateManifestFileName(platform);
  const manifestAsset = selectReleaseAssetByName(assets, manifestName);
  if (!manifestAsset) {
    return null;
  }
  if (!isAllowedUpdateUrl(manifestAsset.browser_download_url)) {
    throw new Error("Unsupported update metadata host.");
  }

  const response = await appFetch(manifestAsset.browser_download_url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Norea",
    },
  });
  if (!response.ok) {
    throw new Error(`Update metadata returned HTTP ${response.status}.`);
  }

  return normalizeUpdateManifest(await response.json());
}

async function requireReleaseUpdateManifest(
  assets: readonly GitHubReleaseAsset[],
  platform: string,
): Promise<UpdateManifest> {
  const manifest = await fetchReleaseUpdateManifest(assets, platform);
  if (!manifest) {
    throw new Error(
      `No update metadata asset named ${updateManifestFileName(platform)}.`,
    );
  }
  return manifest;
}

function updateManifestFileName(platform: string): string {
  return `norea-updates-${platform}.json`;
}

function normalizeUpdateManifest(value: unknown): UpdateManifest {
  const source = objectRecord(value, "Update metadata");
  const schemaVersion = readInteger(
    source.schemaVersion ?? source.schema_version ?? source.schema,
    "schemaVersion",
  );
  if (schemaVersion !== UPDATE_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`Unsupported update metadata schema: ${schemaVersion}.`);
  }
  const channel = readUpdateChannel(source.channel);
  const assetsSource = source.assets;
  if (!Array.isArray(assetsSource) || assetsSource.length === 0) {
    throw new Error("Update metadata has no assets.");
  }

  return {
    assets: assetsSource.map(normalizeUpdateManifestAsset),
    channel,
    dev: normalizeUpdateManifestDev(source.dev),
    generatedAt: readOptionalString(
      source.generatedAt ?? source.generated_at,
      "generatedAt",
    ),
    platform: readRequiredString(source.platform, "platform"),
    schemaVersion,
    signature: readOptionalString(source.signature, "signature"),
    signingKeyId: readOptionalString(
      source.signingKeyId ?? source.signing_key_id,
      "signingKeyId",
    ),
    version: readOptionalString(source.version, "version"),
  };
}

function normalizeUpdateManifestAsset(value: unknown): UpdateManifestAsset {
  const source = objectRecord(value, "Update metadata asset");
  return {
    artifactName: readOptionalString(
      source.artifactName ?? source.artifact_name,
      "artifactName",
    ),
    name: readRequiredString(source.name, "asset.name"),
    platform: readOptionalString(source.platform, "asset.platform"),
    sha256: readSha256(source.sha256),
    signature: readOptionalString(source.signature, "asset.signature"),
    signingKeyId: readOptionalString(
      source.signingKeyId ?? source.signing_key_id,
      "asset.signingKeyId",
    ),
    size: readInteger(source.size, "asset.size"),
  };
}

function normalizeUpdateManifestDev(value: unknown): UpdateDevRunMetadata | null {
  if (value === null || value === undefined) return null;
  const source = objectRecord(value, "Update metadata dev provenance");
  return {
    artifactName: readOptionalString(
      source.artifactName ?? source.artifact_name,
      "dev.artifactName",
    ),
    headSha: readRequiredString(source.headSha ?? source.head_sha, "dev.headSha"),
    runAttempt: readRequiredString(
      source.runAttempt ?? source.run_attempt,
      "dev.runAttempt",
    ),
    runId: readRequiredString(source.runId ?? source.run_id, "dev.runId"),
    workflow: readRequiredString(source.workflow, "dev.workflow"),
  };
}

function validateUpdateManifest(
  manifest: UpdateManifest,
  platform: string,
  channel: UpdateManifestChannel,
): void {
  if (manifest.platform !== platform) {
    throw new Error(
      `Update metadata platform ${manifest.platform} does not match ${platform}.`,
    );
  }
  if (manifest.channel !== channel) {
    throw new Error(
      `Update metadata channel ${manifest.channel} does not match ${channel}.`,
    );
  }
  validateUpdateManifestSignature(manifest);
  for (const asset of manifest.assets) {
    if (asset.platform !== null && asset.platform !== platform) {
      throw new Error(
        `Update metadata asset platform ${asset.platform} does not match ${platform}.`,
      );
    }
    validateUpdateIntegrity(asset);
  }
}

function validateUpdateManifestSignature(_manifest: UpdateManifest): void {
  // TODO(update-signing): verify detached metadata signatures against a bundled public key.
}

function selectUpdateManifestAsset(
  assets: readonly UpdateManifestAsset[],
  platform: string,
): UpdateManifestAsset {
  for (const preference of assetPreferences(platform)) {
    const asset = assets.find((item) => matchesPreference(item.name, preference));
    if (asset) return asset;
  }
  throw new Error(`No update metadata asset matches ${platform}.`);
}

function selectManifestReleaseAsset(
  assets: readonly GitHubReleaseAsset[],
  manifestAsset: UpdateManifestAsset,
): GitHubReleaseAsset {
  const asset = selectReleaseAssetByName(assets, manifestAsset.name);
  if (!asset) {
    throw new Error(`No release asset named ${manifestAsset.name}.`);
  }
  const releaseSize = safeByteLength(asset.size);
  if (releaseSize !== null && releaseSize !== manifestAsset.size) {
    throw new Error(
      `Release asset size for ${manifestAsset.name} does not match metadata.`,
    );
  }
  return asset;
}

function integrityFromManifestAsset(
  asset: UpdateManifestAsset,
): UpdateAssetIntegrity {
  return {
    sha256: asset.sha256.toLowerCase(),
    signature: asset.signature,
    signingKeyId: asset.signingKeyId,
    size: asset.size,
  };
}

function candidateIntegrityForInstall(
  candidate: UpdateCandidate,
): UpdateAssetIntegrity {
  const integrity = candidate.integrity;
  if (!integrity) {
    throw new Error("Update metadata is required before opening an installer.");
  }
  validateUpdateIntegrity(integrity);
  validateUpdateDownloadByteLength(integrity.size);
  if (candidate.downloadSize !== null) {
    validateExpectedDownloadSize(candidate.downloadSize, integrity.size);
  }
  return integrity;
}

function validateUpdateIntegrity(integrity: UpdateAssetIntegrity): void {
  validateUpdateDownloadByteLength(integrity.size);
  if (!SHA256_HEX_PATTERN.test(integrity.sha256)) {
    throw new Error("Update metadata SHA-256 is invalid.");
  }
}

function validateExpectedDownloadSize(actual: number, expected: number): void {
  if (actual !== expected) {
    throw new Error("Update download size does not match metadata.");
  }
}

function workflowRunBinding(
  workflow: string,
  run: GitHubWorkflowRun,
): UpdateDevRunMetadata {
  return {
    artifactName: null,
    headSha: readRequiredString(run.head_sha, "workflow head_sha"),
    runAttempt: readRequiredString(run.run_attempt, "workflow run_attempt"),
    runId: String(run.id),
    workflow,
  };
}

function sameName(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function safeByteLength(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function readUpdateChannel(value: unknown): UpdateManifestChannel {
  if (value === "stable" || value === "dev") return value;
  if (value === "official") return "stable";
  throw new Error("Update metadata channel is invalid.");
}

function readInteger(value: unknown, field: string): number {
  if (typeof value !== "number") {
    throw new Error(`Update metadata ${field} is invalid.`);
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Update metadata ${field} is invalid.`);
  }
  return value;
}

function readRequiredString(value: unknown, field: string): string {
  const normalized = typeof value === "number"
    ? String(value)
    : typeof value === "string"
      ? value.trim()
      : "";
  if (!normalized) {
    throw new Error(`Update metadata ${field} is missing.`);
  }
  return normalized;
}

function readOptionalString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new Error(`Update metadata ${field} is invalid.`);
  }
  return value.trim() || null;
}

function readSha256(value: unknown): string {
  const sha256 = readRequiredString(value, "sha256").toLowerCase();
  if (!SHA256_HEX_PATTERN.test(sha256)) {
    throw new Error("Update metadata SHA-256 is invalid.");
  }
  return sha256;
}

function hexFromBytes(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("SHA-256 hashing is not available.");
  }
  const source = Uint8Array.from(bytes);
  return hexFromBytes(await subtle.digest("SHA-256", source));
}

function openAndroidInstaller(
  path: string,
  metadata: UpdateAssetIntegrity,
): void {
  const bridge = window.__NoreaAndroidUpdater;
  if (!bridge) {
    throw new Error("Android update installer bridge is unavailable.");
  }

  let result: AndroidUpdateInstallResult;
  try {
    result = JSON.parse(
      bridge.openApk(
        JSON.stringify({
          _bridge: androidBridgeAuthority(ANDROID_UPDATE_OPEN_APK_CAPABILITY),
          metadata,
          path,
        }),
      ),
    ) as AndroidUpdateInstallResult;
  } catch {
    throw new Error("Android update installer bridge returned an invalid response.");
  }

  if (!result.ok) {
    throw new Error(result.error || "Android update installer failed to open.");
  }
}

function androidBridgeAuthority(
  capability: string,
): { capability: string; nonce: string; sessionToken: string } {
  const bridge = window.__NoreaAndroidBridge;
  if (!bridge) {
    throw new Error("Android bridge session is unavailable.");
  }

  const session = objectRecord(JSON.parse(bridge.session()), "Android bridge session");
  const sessionToken = readRequiredString(session.sessionToken, "sessionToken");
  const capabilities = session.capabilities;
  if (
    Array.isArray(capabilities) &&
    !capabilities.some((item) => item === capability)
  ) {
    throw new Error("Android bridge capability is unavailable.");
  }
  const nonce = readRequiredString(bridge.nonce(), "nonce");
  return {
    capability,
    nonce,
    sessionToken,
  };
}

function selectReleaseAssetByName(
  assets: readonly GitHubReleaseAsset[],
  name: string,
): GitHubReleaseAsset | null {
  const lowerName = name.toLowerCase();
  return (
    assets.find((item) => item.name.toLowerCase() === lowerName) ?? null
  );
}

function selectWorkflowArtifact(
  artifacts: readonly GitHubArtifact[],
  platform: string,
): WorkflowArtifactSelection | null {
  for (const preference of assetPreferences(platform)) {
    const artifact = artifacts.find(
      (item) => !item.expired && matchesPreference(item.name, preference),
    );
    if (artifact) {
      return {
        artifact,
      };
    }
  }
  return null;
}

function assetPreferences(platform: string): AssetPreference[] {
  switch (platform) {
    case "windows-x64":
      return [
        { token: "norea-x64", extensions: [".exe"] },
        { token: "norea-x64", extensions: [".msi"] },
      ];
    case "windows-arm64":
      return [
        { token: "norea-arm64", extensions: [".exe"] },
        { token: "norea-arm64", extensions: [".msi"] },
      ];
    case "linux-x64":
      return [
        { token: "norea-linux-x64", extensions: [".appimage"] },
        { token: "norea-linux-x64", extensions: [".deb"] },
        { token: "norea-linux-x64", extensions: [".rpm"] },
      ];
    case "linux-arm64":
      return [
        { token: "norea-linux-arm64", extensions: [".appimage"] },
        { token: "norea-linux-arm64", extensions: [".deb"] },
        { token: "norea-linux-arm64", extensions: [".rpm"] },
      ];
    case "android-arm64":
      return [
        {
          exactName: "norea-arm64.apk",
          token: "norea-arm64",
          extensions: [".apk"],
        },
      ];
    case "android-x86_64":
      return [
        {
          exactName: "norea-x86_64.apk",
          token: "norea-x86_64",
          extensions: [".apk"],
        },
      ];
    default:
      return [{ token: platform }];
  }
}

function matchesPreference(name: string, preference: AssetPreference): boolean {
  const lowerName = name.toLowerCase();
  if (preference.exactName) {
    return lowerName === preference.exactName.toLowerCase();
  }
  if (!lowerName.includes(preference.token.toLowerCase())) {
    return false;
  }
  if (!preference.extensions) {
    return true;
  }
  return preference.extensions.some((extension) =>
    lowerName.endsWith(extension.toLowerCase()),
  );
}

function workflowForPlatform(platform: string): string | null {
  if (platform.startsWith("windows-")) return "windows.yml";
  if (platform.startsWith("linux-")) return "linux.yml";
  if (platform.startsWith("android-")) return "android.yml";
  return null;
}

function normalizeReleaseVersion(tagName: string): string | null {
  const match = tagName.trim().match(/^v?(\d+\.\d+(?:\.\d+)?)(?:[-+].*)?$/i);
  return match ? match[1] : null;
}

function compareReleaseBuild(
  buildInfo: BuildInfo,
  remoteVersion: string | null,
  remoteTime: string | null,
): UpdateStatus {
  const localVersion = parseSemver(buildInfo.buildVersion);
  const releaseVersion = parseSemver(remoteVersion);
  if (localVersion && releaseVersion) {
    return compareSemver(releaseVersion, localVersion) > 0 ? "newer" : "current";
  }

  return compareBuildTime(buildInfo.buildTime, remoteTime);
}

function compareWorkflowBuild(
  buildInfo: BuildInfo,
  run: GitHubWorkflowRun,
): UpdateStatus {
  if (buildInfo.githubRunId && buildInfo.githubRunId === String(run.id)) {
    return "current";
  }

  return compareBuildTime(buildInfo.buildTime, run.updated_at || run.created_at);
}

function compareBuildTime(
  localBuildTime: string | null,
  remoteBuildTime: string | null,
): UpdateStatus {
  if (!localBuildTime || !remoteBuildTime) {
    return "unknown";
  }

  const localTime = Date.parse(localBuildTime);
  const remoteTime = Date.parse(remoteBuildTime);
  if (!Number.isFinite(localTime) || !Number.isFinite(remoteTime)) {
    return "unknown";
  }

  return remoteTime > localTime ? "newer" : "current";
}

function parseSemver(version: string | null): Semver | null {
  if (!version) return null;
  const match = version.trim().match(/^v?(\d+)\.(\d+)(?:\.(\d+))?$/i);
  if (!match) return null;

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: match[3] ? Number(match[3]) : 0,
  };
}

function compareSemver(left: Semver, right: Semver): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}
