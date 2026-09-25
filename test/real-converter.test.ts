import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

test("the serializer accepts Pi's real system and legacy tool-result message shapes", () => {
	const repoRoot = path.resolve(import.meta.dir, "..");
	const fixture = path.join(import.meta.dir, "fixtures/real-converter.ts");
	const tempRoot = path.join(repoRoot, "tmp/pi-better-compaction-test");
	mkdirSync(tempRoot, { recursive: true });
	const home = mkdtempSync(path.join(tempRoot, "converter-home-"));
	try {
		const result = spawnSync("bun", [fixture], {
			cwd: repoRoot,
			encoding: "utf8",
			timeout: 10_000,
			env: { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: path.join(home, ".pi/agent"), PI_OFFLINE: "1" },
		});
		if (result.status !== 0) console.error(result.stderr || result.stdout || result.error);
		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout.trim())).toEqual({ passed: true, inputItems: 2 });
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}, 15_000);
