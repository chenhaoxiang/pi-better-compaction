import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tempRoot = path.join(root, "tmp/pi-better-compaction-test");
mkdirSync(tempRoot, { recursive: true });
const home = mkdtempSync(path.join(tempRoot, "notice-replay-"));
const agentDir = path.join(home, ".pi/agent");
mkdirSync(agentDir, { recursive: true });
const requests = [];
const server = createServer(async (request, response) => {
	const chunks = [];
	for await (const chunk of request) chunks.push(chunk);
	requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
	response.writeHead(200, { "content-type": "text/event-stream" });
	for (const event of [
		{ type: "response.created", response: { id: "resp_synthetic", created_at: 1793310000 } },
		{ type: "response.completed", response: { id: "resp_synthetic", status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 0, total_tokens: 10 } } },
	]) response.write(`data: ${JSON.stringify(event)}\n\n`);
	response.end();
});

try {
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
	const provider = "loopback-test";
	const model = "gpt-synthetic";
	const stamp = "2026-10-30T00:00:00.000Z";
	const message = (id, parentId, text) => ({ type: "message", id, parentId, timestamp: stamp, message: { role: "user", content: [{ type: "text", text }], timestamp: 1 } });
	const checkpoint = {
		type: "compaction", id: "checkpoint", parentId: "kept-notice", timestamp: stamp,
		firstKeptEntryId: "kept", summary: "[OpenAI native compaction checkpoint]", tokensBefore: 2000,
		details: { strategy: "openai-native-compact-v2", provider, api: "openai-responses", model, baseUrl,
			createdAt: stamp, compactedWindow: [{ type: "compaction", encrypted_content: "synthetic-blob" }] },
	};
	const entries = [
		{ type: "session", id: randomUUID(), version: 3, timestamp: stamp, cwd: home },
		message("old", null, "hidden old instruction"),
		message("kept", "old", "kept human instruction"),
		{ type: "custom_message", id: "kept-notice", parentId: "kept", timestamp: stamp, customType: "subagent-notify", content: "kept machine result", display: true },
		checkpoint,
		{ type: "custom_message", id: "tail-notice", parentId: "checkpoint", timestamp: stamp, customType: "subagent-notify", content: "tail machine result", display: true },
	];
	const sessionFile = path.join(home, "synthetic-session.jsonl");
	writeFileSync(sessionFile, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [], defaultProjectTrust: "always", compaction: { enabled: false }, retry: { enabled: false } }));
	writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { [provider]: {
		baseUrl, api: "openai-responses", apiKey: "synthetic-loopback-only",
		models: [{ id: model, name: "Synthetic", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1024,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	} } }));
	const extension = path.resolve(process.argv[2] || root);
	const extensions = [extension, path.join(root, "test/fixtures/notice-envelope.ts")];
	if (process.argv[3] === "before") extensions.reverse();
	const output = await new Promise((resolve, reject) => {
		const child = spawn("pi", ["--no-extensions", ...extensions.flatMap((file) => ["-e", file]),
			"--no-skills", "--no-prompt-templates", "--no-tools", "--offline", "--session", sessionFile,
			"--model", `${provider}/${model}`, "-p", "new human instruction"], {
			cwd: home, stdio: ["ignore", "pipe", "pipe"],
			env: { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: agentDir,
				PI_SKIP_VERSION_CHECK: "1", PI_OFFLINE: "1", PI_TELEMETRY: "0" },
		});
		let stderr = "";
		child.stdout.resume();
		child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
		const timeout = setTimeout(() => child.kill("SIGKILL"), 20000);
		child.once("error", (error) => { clearTimeout(timeout); reject(error); });
		child.once("close", (code) => { clearTimeout(timeout); resolve({ code, stderr }); });
	});
	const input = requests[0]?.input ?? [];
	const wire = JSON.stringify(input);
	const stored = readFileSync(sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line)).find((entry) => entry.id === "checkpoint");
	const result = {
		code: output.code, requests: requests.length,
		opaque: input.some((item) => item.type === "compaction" && item.encrypted_content === "synthetic-blob"),
		tailAnnotated: wire.includes("<pi_subagents_notice") && wire.includes("tail machine result") && wire.includes("new human instruction"),
		keptExcluded: !wire.includes("kept human instruction") && !wire.includes("kept machine result"),
		placeholderAbsent: !wire.includes("[OpenAI native compaction checkpoint]"),
		checkpointIntact: JSON.stringify(stored) === JSON.stringify(checkpoint),
	};
	console.log(JSON.stringify(result));
	if (result.code !== 0 || result.requests !== 1 || !result.opaque || !result.tailAnnotated || !result.keptExcluded || !result.placeholderAbsent || !result.checkpointIntact) {
		console.error(output.stderr.slice(-600));
		process.exitCode = 1;
	}
} finally {
	await new Promise((resolve) => server.close(resolve));
	rmSync(home, { recursive: true, force: true });
}
