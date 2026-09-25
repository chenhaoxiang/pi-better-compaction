import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tmpRoot = path.join(repoRoot, "tmp/pi-better-compaction-test");
mkdirSync(tmpRoot, { recursive: true });
const agentDir = mkdtempSync(path.join(tmpRoot, "abort-"));
const marker = path.join(agentDir, "abort-hook-fired");
let receivedRequests = 0;
const server = createServer((_request, response) => {
	receivedRequests++;
	response.writeHead(200, { "content-type": "text/event-stream" });
	response.end("data: [DONE]\n\n");
});

try {
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing loopback port");
	writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
		providers: {
			"loopback-test": {
				baseUrl: `http://127.0.0.1:${address.port}/v1`,
				api: "openai-responses",
				apiKey: "local-test-only",
				models: [{
					id: "gpt-synthetic",
					name: "Synthetic loopback model",
					reasoning: false,
					input: ["text"],
					contextWindow: 100_000,
					maxTokens: 1024,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				}],
			},
		},
	}));
	writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [], defaultProjectTrust: "always" }));

	const env = {
		PATH: process.env.PATH,
		HOME: process.env.HOME,
		TMPDIR: process.env.TMPDIR,
		LANG: process.env.LANG,
		PI_CODING_AGENT_DIR: agentDir,
		PI_SKIP_VERSION_CHECK: "1",
		PI_OFFLINE: "1",
		PI_TELEMETRY: "0",
		PI_ABORT_MARKER_PATH: marker,
		PI_ABORT_EVENT: process.argv[2] ?? "before_provider_request",
	};
	const output = await new Promise((resolve, reject) => {
		const child = spawn("pi", [
			"--no-extensions", "-e", path.join(repoRoot, "test/fixtures/abort-before-provider.ts"),
			"--no-skills", "--no-prompt-templates", "--no-tools",
			"--no-session", "--offline", "--model", "loopback-test/gpt-synthetic",
			"-p", "synthetic request",
		], { cwd: agentDir, env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
		child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
		const deadline = setTimeout(() => child.kill("SIGKILL"), 20_000);
		child.once("error", (error) => { clearTimeout(deadline); reject(error); });
		child.once("close", (code) => { clearTimeout(deadline); resolve({ code, stdout, stderr }); });
	});
	const result = {
		event: env.PI_ABORT_EVENT,
		hookFired: existsSync(marker) && readFileSync(marker, "utf8") === "hook-fired",
		receivedRequests,
		piCode: output.code,
		piOutput: output.stdout.trim().slice(-200),
		piError: output.stderr.trim().slice(-200),
	};
	console.log(JSON.stringify(result));
	if (!result.hookFired || result.receivedRequests !== 0 || result.piCode === null) process.exitCode = 1;
} finally {
	await new Promise((resolve) => server.close(resolve));
	rmSync(agentDir, { recursive: true, force: true });
}
