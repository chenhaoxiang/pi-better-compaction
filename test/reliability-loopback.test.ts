import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

test.each(["automatic-fallback", "manual-fallback", "automatic-native", "manual-native"])("installed Pi loader and loopback %s preserve metadata, fallback and resumed history", scenario => {
	const root = path.resolve(import.meta.dir, "..");
	const result = spawnSync("node", [path.join(import.meta.dir, "fixtures/reliability-loopback.mjs"), root, scenario], { encoding: "utf8", timeout: 45_000 });
	if (result.status !== 0) console.error(result.stderr || result.stdout || result.error);
	expect(result.status).toBe(0);
	expect(JSON.parse(result.stdout.trim())).toMatchObject({ scenario, firstCode: 0, resumedCode: 0, compactOk: true, nativeRequests: 1, noNativeReplay: true, checkpointSaved: true, expectedCheckpoint: true, replaySafe: true, nativeBlobReplayed: true });
}, 50_000);
