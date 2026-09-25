import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

test.each(["before_provider_request", "context"])("an abort in %s sends no bytes to a local provider", (event) => {
	// Keep the synthetic HTTP server in a separate process while Pi runs. The
	// fixture closes Pi's stdin so print mode never waits for input or EOF.
	const script = path.resolve(import.meta.dir, "fixtures/abort-loopback.mjs");
	const result = spawnSync("node", [script, event], { encoding: "utf8", timeout: 30_000 });
	if (result.status !== 0) {
		console.error(result.stderr || result.stdout || result.error);
	}
	const observed = JSON.parse(result.stdout.trim()) as {
		event: string;
		hookFired: boolean;
		receivedRequests: number;
		piCode: number | null;
		piError: string;
	};
	expect(result.status).toBe(0);
	expect(observed.event).toBe(event);
	expect(observed.hookFired).toBe(true);
	expect(observed.receivedRequests).toBe(0);
	expect(observed.piCode).not.toBe(0);
	expect(observed.piError.toLowerCase()).toContain("abort");
}, 35_000);
