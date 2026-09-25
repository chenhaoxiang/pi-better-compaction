import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

describe("pi smoke", () => {
	test("loads the local extension via isolated RPC without sending a model prompt", () => {
		const packageDir = path.resolve(import.meta.dir, "..");
		const fixture = path.resolve(import.meta.dir, "fixtures/extension-load-rpc.mjs");
		const result = spawnSync("node", [fixture, packageDir], { encoding: "utf8", timeout: 30_000 });
		if (result.status !== 0) console.error(result.stderr || result.stdout || result.error);
		expect(result.status).toBe(0);
		const state = JSON.parse(result.stdout.trim());
		expect(state).toMatchObject({ loaded: true, modelId: "gpt-synthetic", code: 0 });
	}, 35_000);
});
