import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const tempRoot = path.join(repoRoot, "tmp/pi-better-compaction-test");
const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function checkCoverage(hits: [number, number], patch: string) {
	mkdirSync(tempRoot, { recursive: true });
	const dir = mkdtempSync(path.join(tempRoot, "coverage-gate-"));
	dirs.push(dir);
	const baselinePath = path.join(dir, "baseline.json");
	const lcovPath = path.join(dir, "lcov.info");
	const patchPath = path.join(dir, "changed.patch");
	writeFileSync(baselinePath, JSON.stringify({
		sourceCommit: "synthetic",
		totals: { LF: 2, LH: 1, FNF: 1, FNH: 1, BRF: 0, BRH: 0 },
		files: { "src/compact-client-v2.ts": { LF: 2, LH: 1, FNF: 1, FNH: 1 } },
	}));
	writeFileSync(lcovPath, [
		"SF:src/compact-client-v2.ts", "FN:10,one", "FNDA:1,one",
		`DA:10,${hits[0]}`, `DA:11,${hits[1]}`,
		"LF:2", `LH:${hits.filter(Boolean).length}`, "FNF:1", "FNH:1", "BRF:0", "BRH:0", "end_of_record", "",
	].join("\n"));
	writeFileSync(patchPath, patch);
	return spawnSync("node", [path.join(repoRoot, "scripts/check-lcov.mjs"), lcovPath,
		"--baseline", baselinePath, "--patch", patchPath], { encoding: "utf8" });
}

const changedLines = [
	"diff --git a/src/compact-client-v2.ts b/src/compact-client-v2.ts",
	"--- a/src/compact-client-v2.ts", "+++ b/src/compact-client-v2.ts",
	"@@ -9,0 +10,2 @@", "+const one = 1;", "+const two = 2;", "",
].join("\n");

test("coverage gate accepts a candidate above the pinned baseline with changed lines covered", () => {
	const result = checkCoverage([1, 1], changedLines);
	expect(result.status).toBe(0);
	expect(result.stdout).toContain("Coverage gate OK");
	expect(result.stdout).toContain("branch coverage not gated");
});

test("coverage gate rejects a new uncovered source line even when aggregate coverage matches baseline", () => {
	const result = checkCoverage([1, 0], changedLines);
	expect(result.status).not.toBe(0);
	expect(result.stderr).toContain("changed line");
});

test("coverage gate cannot mistake a newly added ++ line for a patch file header", () => {
	const result = checkCoverage([1, 0], changedLines.replace("+const two = 2;", "+++ counter;"));
	expect(result.status).not.toBe(0);
	expect(result.stderr).toContain("changed line not covered: src/compact-client-v2.ts:11");
});

test("coverage gate rejects a regression below the pinned overall ratio", () => {
	const result = checkCoverage([0, 0], "");
	expect(result.status).not.toBe(0);
	expect(result.stderr).toContain("overall lines");
});
