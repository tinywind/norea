import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(path, "utf8");

test("each Cargo patch tracks its locked base, source checksum, and removal check", () => {
  const manifest = read("src-tauri/Cargo.toml");
  const patchSection = manifest.split("[patch.crates-io]")[1].split("\n[")[0];
  const packages = read("src-tauri/Cargo.lock").split("[[package]]");
  const register = read("docs/vendor-patches.md");
  for (const line of patchSection
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)) {
    const patch = /^(\S+) = \{ path = "([^"]+)" \}$/.exec(line);
    assert.ok(patch, `unrecognized patch declaration: ${line}`);
    const [, name, path] = patch;
    const entry = packages.find(
      (block) => block.includes(`\nname = "${name}"\n`) && !block.includes("\nsource = "),
    );
    assert.ok(entry, `missing locked local package: ${name}`);
    const version = /^version = "([^"]+)"/m.exec(entry)[1];
    const row = register.split("\n").find((line) => line.startsWith(`| ${name} | ${version} | `));
    assert.ok(row, `missing patch review for ${name} ${version}`);
    const notePath = /\]\(\.\.\/([^)]*)\)/.exec(row)?.[1];
    assert.ok(notePath?.startsWith(`src-tauri/${path}/`));
    assert.match(read(notePath), /\b[0-9a-f]{64}\b/);
    assert.ok(row.split("|")[4].trim(), `missing removal check for ${name}`);
  }
});
