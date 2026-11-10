import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { registerExtensionRuntime } from "../src/extension-runtime";
import { PORTABLE_PROGRESS_ENTRY_TYPE, summarizePortableHistory } from "../src/portable-summary";
import { createNativeCompactionDetails, DEFAULT_EXTENSION_CONFIG, NATIVE_COMPACTION_FALLBACK_SUMMARY } from "../src/types";

// Actual supported SDK entries, persistence, lifecycle and fresh owner. Summary transport is synthetic.
test("native SDK persists a completed prefix and a fresh runtime resumes without rewriting the checkpoint", async () => {
	const base = path.resolve("tmp/portable-sdk-fixtures"); fs.mkdirSync(base, { recursive: true });
	const root = fs.mkdtempSync(path.join(base, "case-")), cwd = path.join(root, "project"), agentDir = path.join(root, "agent");
	fs.mkdirSync(cwd); fs.mkdirSync(agentDir);
	const manager = SessionManager.create(cwd, path.join(root, "sessions"));
	for (const fact of ["fact-A-aaaaaaaaaa", "fact-B-bbbbbbbbbb", "fact-C-cccccccccc"]) manager.appendMessage({ role: "user", content: [{ type: "text", text: fact }], timestamp: 1 });
	const kept = manager.appendMessage({ role: "user", content: [{ type: "text", text: "retained tail" }], timestamp: 2 });
	manager.appendMessage(fauxAssistantMessage("seed outside hidden boundary"));
	const checkpointId = manager.appendCompaction(NATIVE_COMPACTION_FALLBACK_SUMMARY, kept, 9000, createNativeCompactionDetails({ provider: "old-native", api: "openai-responses", model: "original", baseUrl: "https://example.invalid/v1", compactedWindow: [{ type: "compaction", encrypted_content: "synthetic-opaque" }] }));
	const original = JSON.stringify(manager.getEntry(checkpointId));
	const faux = fauxProvider({ provider: "portable-sdk-synthetic" });
	const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false }); runtime.registerNativeProvider(faux.provider);
	const settings = SettingsManager.inMemory({ packages: [], compaction: { enabled: false }, retry: { enabled: false } });
	const textModel = { provider: "fixture", id: "text", api: "openai-responses", contextWindow: 100000, maxTokens: 4096, baseUrl: "https://example.invalid/v1", input: ["text"], reasoning: false };
	const controller = new AbortController(); let first = true; const calls: string[] = [];
	const factory = (pi: any) => registerExtensionRuntime(pi, {
		loadExtensionConfig: () => ({ config: { ...DEFAULT_EXTENSION_CONFIG, compactionModel: "fixture/text" }, warnings: [] }),
		summarizePortableHistory: async args => summarizePortableHistory({ ...args, signal: first ? controller.signal : args.signal, maxChunkBytes: 40,
			ctx: { ...args.ctx, modelRegistry: { find: () => textModel, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "synthetic-only" }) } } as never,
			onCheckpoint: data => { args.onCheckpoint?.(data); if (first) controller.abort(); },
			generate: async ({ messages, previousSummary }) => { calls.push(JSON.stringify(messages)); return { text: `${previousSummary ?? ""} ${JSON.stringify(messages)}` }; },
		}),
	});
	async function create(selected: SessionManager) {
		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true, extensionFactories: [factory] });
		await loader.reload(); expect(loader.getExtensions().errors).toEqual([]);
		const { session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model: faux.getModel(), settingsManager: settings, sessionManager: selected, resourceLoader: loader, tools: [] });
		await session.bindExtensions({ mode: "json" }); return session;
	}
	const messages = [{ role: "compactionSummary", summary: NATIVE_COMPACTION_FALLBACK_SUMMARY, tokensBefore: 9000, timestamp: 1 }, { role: "user", content: [{ type: "text", text: "new tail" }], timestamp: 2 }];
	let session = await create(manager);
	try {
		await session.extensionRunner.emitContext(messages as never);
		expect(calls).toHaveLength(1); expect(manager.getBranch().filter(e => e.type === "custom" && e.customType === PORTABLE_PROGRESS_ENTRY_TYPE)).toHaveLength(1);
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); first = false;
		const file = manager.getSessionFile()!; expect(fs.existsSync(file)).toBe(true);
		const reopened = SessionManager.open(file); session = await create(reopened);
		const result = await session.extensionRunner.emitContext(messages as never);
		expect(calls).toHaveLength(3); expect(calls[1]).not.toContain("fact-A");
		const summary = (result[0] as any).summary;
		for (const fact of ["fact-A", "fact-B", "fact-C"]) expect(summary).toContain(fact);
		expect(result[1]).toEqual(messages[1]); expect(JSON.stringify(reopened.getEntry(checkpointId))).toBe(original);
		expect(faux.state.callCount).toBe(0);
	} finally { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
});
