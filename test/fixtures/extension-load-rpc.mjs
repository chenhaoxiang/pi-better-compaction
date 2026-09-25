import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(process.argv[2] ?? "");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tempRoot = path.join(repoRoot, "tmp/pi-better-compaction-test");
mkdirSync(tempRoot, { recursive: true });
const testDir = mkdtempSync(path.join(tempRoot, "rpc-load-"));
const home = path.join(testDir, "home");
const agentDir = path.join(home, ".pi", "agent");
mkdirSync(agentDir, { recursive: true });
writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [], defaultProjectTrust: "always" }));
writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: {
	"loopback-test": {
		baseUrl: "http://127.0.0.1:9/v1", api: "openai-responses", apiKey: "synthetic-only",
		models: [{ id: "gpt-synthetic", name: "Synthetic", reasoning: false, input: ["text"],
			contextWindow: 100_000, maxTokens: 1024,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	},
} }));
const env = Object.fromEntries(["PATH", "LANG", "TMPDIR"].flatMap((key) => process.env[key] ? [[key, process.env[key]]] : []));
Object.assign(env, { HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_SKIP_VERSION_CHECK: "1", PI_OFFLINE: "1", PI_TELEMETRY: "0" });
let child;
try {
	child = spawn("pi", ["--mode", "rpc", "--no-session", "--offline", "--no-tools", "--no-skills",
		"--no-prompt-templates", "--no-extensions", "-e", packageDir, "--model", "loopback-test/gpt-synthetic"],
	{ cwd: testDir, env, stdio: ["pipe", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	let state;
	const completed = new Promise((resolve, reject) => {
		const deadline = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Pi RPC load timed out")); }, 20_000);
		child.stdout.setEncoding("utf8").on("data", (chunk) => {
			stdout += chunk;
			let boundary;
			while ((boundary = stdout.indexOf("\n")) !== -1) {
				const line = stdout.slice(0, boundary);
				stdout = stdout.slice(boundary + 1);
				let record;
				try { record = JSON.parse(line); } catch { continue; }
				if (record.id === "state-1" && record.type === "response") {
					state = record;
					child.stdin.end();
				}
			}
		});
		child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
		child.once("error", (error) => { clearTimeout(deadline); reject(error); });
		child.once("close", (code) => { clearTimeout(deadline); resolve(code); });
	});
	child.stdin.write('{"id":"state-1","type":"get_state"}\n');
	const code = await completed;
	const loaded = code === 0 && state?.success === true && state.data?.model?.id === "gpt-synthetic" &&
		!/extension.*error|cannot find module|failed to load extension/i.test(stderr);
	console.log(JSON.stringify({ loaded, modelId: state?.data?.model?.id, code, stderrTail: stderr.slice(-400) }));
	if (!loaded) process.exitCode = 1;
} finally {
	if (child?.exitCode === null) child.kill("SIGKILL");
	rmSync(testDir, { recursive: true, force: true });
}
