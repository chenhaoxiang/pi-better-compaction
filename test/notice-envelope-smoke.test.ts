import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

// Real Pi loader -> separate context handler -> production replay hook -> local
// HTTP capture. No actual model, private session, account or external transport.
test.each(["before", "after"])("native replay survives request-local provenance with the notice handler loaded %s", (order) => {
	const root = path.resolve(import.meta.dir, "..");
	const result = spawnSync(process.execPath, [path.join(import.meta.dir, "fixtures/notice-loopback.mjs"), root, order], {
		cwd: root, encoding: "utf8", timeout: 25000,
		env: { PATH: process.env.PATH, HOME: path.join(root, "tmp/unused-home"), PI_OFFLINE: "1" },
	});
	if (result.status !== 0) console.error(result.stderr || result.stdout || result.error);
	expect(result.status).toBe(0);
	expect(JSON.parse(result.stdout.trim())).toEqual({
		code: 0, requests: 1, opaque: true, tailAnnotated: true, keptExcluded: true,
		placeholderAbsent: true, checkpointIntact: true,
	});
}, 30000);
