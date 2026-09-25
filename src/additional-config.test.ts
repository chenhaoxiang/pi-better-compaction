import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadExtensionConfig } from "./config";

const tempRoot = path.resolve(import.meta.dir, "../tmp/pi-better-compaction-test");
const tempDirs: string[] = [];

function configFile(value: unknown): string {
	mkdirSync(tempRoot, { recursive: true });
	const dir = mkdtempSync(path.join(tempRoot, "config-"));
	tempDirs.push(dir);
	const file = path.join(dir, "config.json");
	writeFileSync(file, JSON.stringify(value));
	return file;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("ordered additional compaction models default to none", () => {
	const config = loadExtensionConfig(path.join(tempRoot, "missing-config.json"));
	expect(config.config.additionalCompactionModels).toEqual([]);
});

test("valid additional models preserve order while malformed entries are skipped with warnings", () => {
	const config = loadExtensionConfig(configFile({
		compactionModel: "codex-local/kimi-k3",
		additionalCompactionModels: [
			" codex-local/gpt-5.6-sol ",
			"broken",
			"bad / model",
			"ba d/model",
			"codex-local/gpt-5.6-sol",
			42,
			"zai-coding-cn/glm-5.3",
		],
	}));
	expect(config.config.additionalCompactionModels).toEqual([
		"codex-local/gpt-5.6-sol",
		"zai-coding-cn/glm-5.3",
	]);
	expect(config.warnings.length).toBeGreaterThanOrEqual(4);
});
