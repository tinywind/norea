import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function apiHeaders(token, contentType = undefined) {
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "norea-ci",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (contentType) {
    headers["Content-Type"] = contentType;
  }
  return headers;
}

export function isLegacyAndroidDevAsset(name) {
  if (name === "norea-arm64.apk" || name === "norea-x86_64.apk") {
    return false;
  }
  if (name === "norea-signed-release-apk-checksums") {
    return true;
  }
  return /^norea-(?:arm64|x86_64).*apk.*$/.test(name);
}

async function fetchReleaseByTag(repository, tag, token, fetchImpl) {
  const response = await fetchImpl(
    `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
    { headers: apiHeaders(token) },
  );
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Failed to fetch release ${tag}: HTTP ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function ensureRelease({ repository, tag, createPrerelease, title, notes, targetCommitish, token, fetchImpl }) {
  const existing = await fetchReleaseByTag(repository, tag, token, fetchImpl);
  if (existing) {
    return existing;
  }
  if (!createPrerelease) {
    throw new Error(`GitHub Release not found for tag ${tag}.`);
  }
  const createResponse = await fetchImpl(
    `https://api.github.com/repos/${repository}/releases`,
    {
      method: "POST",
      headers: apiHeaders(token, "application/json"),
      body: JSON.stringify({
        tag_name: tag,
        target_commitish: targetCommitish,
        name: title,
        body: notes,
        prerelease: true,
      }),
    },
  );
  if (createResponse.ok) {
    return createResponse.json();
  }
  // Concurrent workflow jobs may race to create the shared dev prerelease.
  const raced = await fetchReleaseByTag(repository, tag, token, fetchImpl);
  if (raced) {
    return raced;
  }
  throw new Error(`Failed to create release ${tag}: HTTP ${createResponse.status} ${await createResponse.text()}`);
}

async function deleteAsset(repository, assetId, token, fetchImpl) {
  const response = await fetchImpl(
    `https://api.github.com/repos/${repository}/releases/assets/${assetId}`,
    { method: "DELETE", headers: apiHeaders(token) },
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(`Failed to delete release asset ${assetId}: HTTP ${response.status} ${await response.text()}`);
  }
}

export async function uploadReleaseAssets({
  repository,
  tag,
  assetsDir,
  token,
  createPrerelease = false,
  title = "",
  notes = "",
  targetCommitish = "",
  pruneLegacyAndroidDevAssets = false,
  fetchImpl = fetch,
}) {
  if (!repository || !tag || !assetsDir || !token) {
    throw new Error("repository, tag, assetsDir, and token are required.");
  }

  const entries = await readdir(assetsDir, { withFileTypes: true });
  const files = entries.filter(entry => entry.isFile()).map(entry => entry.name).sort();
  if (files.length === 0) {
    throw new Error(`No release asset files found in ${assetsDir}.`);
  }

  const release = await ensureRelease({
    repository,
    tag,
    createPrerelease,
    title,
    notes,
    targetCommitish,
    token,
    fetchImpl,
  });

  const existingAssets = Array.isArray(release.assets) ? release.assets : [];
  const fileSet = new Set(files);
  const deletedIds = new Set();

  for (const asset of existingAssets) {
    const shouldReplace = fileSet.has(asset.name);
    const shouldPruneLegacy = pruneLegacyAndroidDevAssets && isLegacyAndroidDevAsset(asset.name);
    if ((shouldReplace || shouldPruneLegacy) && !deletedIds.has(asset.id)) {
      deletedIds.add(asset.id);
      await deleteAsset(repository, asset.id, token, fetchImpl);
    }
  }

  for (const name of files) {
    const body = await readFile(join(assetsDir, name));
    const uploadUrl = `https://uploads.github.com/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`;
    const response = await fetchImpl(uploadUrl, {
      method: "POST",
      headers: apiHeaders(token, "application/octet-stream"),
      body,
    });
    if (!response.ok) {
      throw new Error(`Failed to upload release asset ${name}: HTTP ${response.status} ${await response.text()}`);
    }
    console.log(`Uploaded release asset ${name} (${body.length} bytes) to ${tag}.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await uploadReleaseAssets({
    repository: process.env.GITHUB_REPOSITORY ?? "",
    tag: process.env.RELEASE_TAG ?? "",
    assetsDir: process.env.RELEASE_ASSETS_DIR ?? "",
    token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "",
    createPrerelease: process.env.CREATE_PRERELEASE === "true",
    title: process.env.RELEASE_TITLE ?? "",
    notes: process.env.RELEASE_NOTES ?? "",
    targetCommitish: process.env.RELEASE_TARGET_COMMITISH ?? "",
    pruneLegacyAndroidDevAssets: process.env.PRUNE_LEGACY_ANDROID_DEV_ASSETS === "true",
  });
}
