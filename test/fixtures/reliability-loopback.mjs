import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const extension = path.resolve(process.argv[2] || root);
const scenario = process.argv[3] || "automatic-fallback";
const automatic = scenario.startsWith("automatic");
const fallback = scenario.endsWith("fallback");
const tempRoot = path.join(root, "tmp/pi-better-compaction-test");
mkdirSync(tempRoot, { recursive: true });
const home = mkdtempSync(path.join(tempRoot, "reliability-loopback-"));
const agentDir = path.join(home, ".pi/agent");
mkdirSync(path.join(agentDir, "extensions/pi-better-compaction"), { recursive: true });
const requests = [];
let nativeRequests = 0;
const server = createServer(async (request, response) => {
	try {
		const chunks = []; for await (const chunk of request) chunks.push(chunk);
		const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		requests.push(body);
		const native = body.input?.some(item => item.type === "compaction_trigger");
		if (native) nativeRequests++;
		response.writeHead(200, { "content-type": "text/event-stream" });
		const send = event => response.write(`data: ${JSON.stringify(event)}\n\n`);
		const id = `resp_synthetic_${requests.length}`;
		send({ type: "response.created", response: { id, created_at: 1794182400, status: "in_progress", output: [] } });
		if (native && fallback) return; // Deliberately silent until the configured local idle bound.
		let output;
		if (native) {
			output = { type: "compaction", id: "cmp_synthetic", encrypted_content: "synthetic-new-checkpoint" };
			send({ type: "response.output_item.done", output_index: 0, item: output });
		} else {
			output = { type: "message", id: `msg_${requests.length}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "## Goal\nContinue the synthetic user goal.\n## Progress\nSafe synthetic response.", annotations: [] }] };
			send({ type: "response.output_item.added", output_index: 0, item: { ...output, status: "in_progress", content: [] } });
			send({ type: "response.content_part.added", item_id: output.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
			send({ type: "response.output_text.delta", item_id: output.id, output_index: 0, content_index: 0, delta: output.content[0].text });
			send({ type: "response.output_text.done", item_id: output.id, output_index: 0, content_index: 0, text: output.content[0].text });
			send({ type: "response.output_item.done", output_index: 0, item: output });
		}
		send({ type: "response.completed", response: { id, status: "completed", output: [output], usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } } });
		response.end();
	} catch { response.destroy(); }
});

let child;
async function runPi(manual = false) {
	return new Promise((resolve, reject) => {
		const args = ["--no-extensions", "-e", extension, "--no-skills", "--no-prompt-templates", "--no-tools", "--offline", "--session", sessionFile, "--model", "loopback-test/gpt-synthetic",
			...(manual ? ["--mode", "rpc"] : ["-p", "Continue the synthetic goal."])];
		child = spawn(process.env.PI_RELIABILITY_CLI || "pi", args, { cwd: home, stdio: [manual ? "pipe" : "ignore", "pipe", "pipe"],
			env: { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_SKIP_VERSION_CHECK: "1", PI_OFFLINE: "1", PI_TELEMETRY: "0" } });
		let stderr = "", stdout = "", compactOk = !manual;
		const deadline = setTimeout(() => child.kill("SIGKILL"), 20000);
		child.stderr.setEncoding("utf8").on("data", text => { stderr += text; });
		child.stdout.setEncoding("utf8").on("data", text => {
			if (!manual) return;
			stdout += text;
			let newline;
			while ((newline = stdout.indexOf("\n")) >= 0) {
				const line = stdout.slice(0, newline); stdout = stdout.slice(newline + 1);
				let event; try { event = JSON.parse(line); } catch { continue; }
				if (event.type === "response" && event.id === "compact-1") { compactOk = event.success; child.stdin.end(); }
			}
		});
		child.once("error", error => { clearTimeout(deadline); reject(error); });
		child.once("close", code => { clearTimeout(deadline); resolve({ code, compactOk, stderr }); });
		if (manual) child.stdin.write('{"id":"compact-1","type":"compact"}\n');
	});
}
const sessionFile = path.join(home, "synthetic-session.jsonl");
try {
	await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
	const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
	writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [], defaultProjectTrust: "always", compaction: { enabled: automatic, reserveTokens: 1024, keepRecentTokens: 256 }, retry: { enabled: false } }));
	writeFileSync(path.join(agentDir, "extensions/pi-better-compaction/config.json"), JSON.stringify({ nativeV2IdleTimeoutMs: fallback ? 80 : 0 }));
	writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "loopback-test": { baseUrl, api: "openai-responses", apiKey: "synthetic-loopback-only", models: [{ id: "gpt-synthetic", name: "Synthetic", reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
	const stamp = "2026-11-09T00:00:00.000Z";
	const usage = { input: 7500, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 7510, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const assistant = { role: "assistant", provider: "loopback-test", api: "openai-responses", model: "gpt-synthetic", usage };
	const entries = [
		{ type: "session", id: randomUUID(), version: 3, timestamp: stamp, cwd: home },
		{ type: "message", id: "history", parentId: null, timestamp: stamp, message: { role: "user", content: [{ type: "text", text: "Synthetic history and original user goal." }], timestamp: 1 } },
		{ type: "message", id: "call", parentId: "history", timestamp: stamp, message: { ...assistant, stopReason: "toolUse", content: [{ type: "toolCall", id: "call_synthetic", name: "synthetic", arguments: {} }], timestamp: 2 } },
		{ type: "message", id: "output", parentId: "call", timestamp: stamp, message: { role: "toolResult", toolCallId: "call_synthetic", toolName: "synthetic", isError: false, content: [{ type: "text", text: "synthetic tool output ".repeat(4000) }], timestamp: 3 } },
		{ type: "message", id: "prior", parentId: "output", timestamp: stamp, message: { ...assistant, stopReason: "stop", content: [{ type: "text", text: "Prior synthetic response." }], timestamp: 4 } },
	];
	writeFileSync(sessionFile, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
	const first = await runPi(!automatic);
	const saved = readFileSync(sessionFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
	const observation = saved.find(entry => entry.customType === "pi-better-compaction-native-attempt");
	const checkpoint = saved.find(entry => entry.type === "compaction");
	const beforeResume = nativeRequests;
	const resumed = await runPi();
	const normalWire = JSON.stringify(requests.at(-1)?.input ?? []);
	const result = {
		scenario, firstCode: first.code, resumedCode: resumed.code, compactOk: first.compactOk,
		nativeRequests, noNativeReplay: beforeResume === nativeRequests,
		trigger: observation?.data?.trigger, outcome: observation?.data?.reason || observation?.data?.outcome,
		checkpointSaved: !!checkpoint,
		expectedCheckpoint: fallback ? checkpoint?.fromHook === false || checkpoint?.fromHook === undefined : checkpoint?.details?.strategy === "openai-native-compact-v2",
		replaySafe: !normalWire.includes("[OpenAI native compaction checkpoint]") && !normalWire.includes("pi-better-compaction-native-attempt"),
		nativeBlobReplayed: fallback || normalWire.includes("synthetic-new-checkpoint"),
	};
	console.log(JSON.stringify(result));
	if (first.code !== 0 || resumed.code !== 0 || !first.compactOk || nativeRequests !== 1 || !result.noNativeReplay || result.trigger !== (automatic ? "threshold" : "manual") || !result.checkpointSaved || !result.expectedCheckpoint || !result.replaySafe || !result.nativeBlobReplayed || result.outcome !== (fallback ? "idle-timeout" : "response-ok")) {
		console.error((first.stderr + resumed.stderr).slice(-1400)); process.exitCode = 1;
	}
} finally {
	if (child?.exitCode === null) child.kill("SIGKILL");
	server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
	rmSync(home, { recursive: true, force: true });
}
