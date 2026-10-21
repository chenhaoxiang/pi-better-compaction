import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const lock = JSON.parse(readFileSync(new URL("package-lock.json", root), "utf8"));
const version = "1.3.0-fork.1";
const release = "https://github.com/chenhaoxiang/pi/releases/download/v" + version + "/";

test("development SDK stays on the exact maintained Pi release without runtime copies", () => {
  const direct = Object.entries(manifest.devDependencies).filter(([name]) => name.startsWith("@earendil-works/pi-"));
  assert.ok(direct.length > 0);
  for (const [name, source] of direct) {
    assert.equal(source, release + "earendil-works-" + name.split("/")[1] + "-" + version + ".tgz");
    assert.ok(manifest.peerDependencies[name]);
    assert.equal(lock.packages[""].devDependencies[name], source);
  }
  const sdk = Object.entries(lock.packages).filter(([key]) => /node_modules\/@earendil-works\/pi-[^/]+$/.test(key));
  assert.ok(sdk.length >= direct.length);
  for (const [key, dependency] of sdk) {
    assert.equal(dependency.version, version, key);
    assert.equal(manifest.dependencies?.[key.split("node_modules/").at(-1)], undefined, key);
    assert.equal(dependency.dev, true, key);
    assert.ok(dependency.resolved.startsWith(release), key);
    assert.match(dependency.integrity, /^sha512-/, key);
    const installed = JSON.parse(readFileSync(new URL(key + "/package.json", root), "utf8"));
    assert.equal(installed.version, version, key);
  }
});
