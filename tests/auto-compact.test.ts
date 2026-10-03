import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import * as native from "@earendil-works/pi-coding-agent";

const agentDir = mkdtempSync(join(tmpdir(), "auto-compact-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const compact = mock.fn(async (preparation: any) => ({
	summary: "Checkpoint",
	firstKeptEntryId: preparation.firstKeptEntryId,
	tokensBefore: preparation.tokensBefore,
	usage: { input: 100, output: 10, totalTokens: 110 },
	details: { readFiles: [], modifiedFiles: [] },
}));
mock.module("@earendil-works/pi-coding-agent", { namedExports: { ...native, compact } });
const { default: autoCompact } = await import("../extensions/auto-compact.ts");

test.after(() => rmSync(agentDir, { recursive: true, force: true }));
test.beforeEach(() => {
	compact.mock.resetCalls();
	writeFileSync(join(agentDir, "auto-compact.json"), JSON.stringify({ percentThreshold: 70 }));
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 100 } }));
});

async function setup(tokens = 71000) {
	const handlers = new Map<string, Function>();
	const session = native.SessionManager.inMemory();
	session.appendMessage({ role: "user", content: "Original task " + "x".repeat(1000), timestamp: 1 });
	session.appendMessage({
		role: "assistant", content: [{ type: "text", text: "Earlier progress." }],
		api: "openai-responses", provider: "test", model: "test", stopReason: "stop",
		usage: { input: tokens - 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: tokens }, timestamp: 2,
	} as any);
	session.appendMessage({ role: "user", content: "Continue " + "x".repeat(1000), timestamp: 3 });
	const message = {
		role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "file.ts" } }],
		api: "openai-responses", provider: "test", model: "test", stopReason: "toolUse",
		usage: { input: tokens - 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: tokens }, timestamp: 4,
	};
	const messageEntryId = session.appendMessage(message as any);
	const toolResult = {
		role: "toolResult", toolCallId: "call-1", toolName: "read",
		content: [{ type: "text", text: "x".repeat(1000) }], details: {}, isError: false, timestamp: 5,
	};
	const toolResultEntryId = session.appendMessage(toolResult as any);
	let idle = true;
	let pending = false;
	const notifications: string[] = [];
	const manualCompact = mock.fn((options: any) => options.onComplete({}));
	const controller = new AbortController();
	const ctx = {
		cwd: agentDir, hasUI: true, model: { provider: "test", id: "test", contextWindow: 100000, maxTokens: 8192 },
		sessionManager: session, signal: controller.signal, thinkingLevel: "off",
		modelRegistry: { streamSimple: mock.fn() },
		isProjectTrusted: () => false,
		isIdle: () => idle, hasPendingMessages: () => pending,
		getContextUsage: () => ({ tokens, contextWindow: 100000, percent: tokens / 1000 }),
		compact: manualCompact, ui: { notify: (text: string) => notifications.push(text) },
	};
	autoCompact({
		on: (name: string, handler: Function) => handlers.set(name, handler),
		registerCommand: () => {}, getThinkingLevel: () => "off",
	} as any);
	const emit = (name: string, event: any = {}) => handlers.get(name)?.(event, ctx);
	await emit("session_start");
	await emit("turn_start");
	const event = {
		type: "turn_end", turnIndex: 0, message, toolResults: [toolResult], messageEntryId,
		toolResultEntryIds: [toolResultEntryId], entries: [], continue: false, outcome: "completed",
		context: { contextEntries: session.buildSessionProjection().entries,
			contextMessages: session.buildSessionProjection().messages, pendingMessages: [], canContinue: true },
	};
	return { ctx, event, emit, handlers, notifications, manualCompact, controller,
		setIdle: (value: boolean) => { idle = value; },
		setPending: (value: boolean) => { pending = value; } };
}

test("compacts after tools during an active run without manual compaction or forced continuation", async () => {
	const s = await setup();
	s.setIdle(false);
	const result = await s.emit("turn_end", s.event);
	assert.equal(compact.mock.callCount(), 1);
	assert.equal(s.manualCompact.mock.callCount(), 0);
	assert.equal(result.entries.at(-1).type, "compaction");
	assert.equal(result.entries.at(-1).summary, "Checkpoint");
	assert.equal(result.entries.at(-1).firstKeptEntryId, s.event.messageEntryId);
	assert.equal(result.continue, undefined);
	assert.deepEqual(result.entries.at(-1).usage, { input: 100, output: 10, totalTokens: 110 });
});

test("does not compact at settlement or after a final answer with no next response", async () => {
	const s = await setup();
	assert.equal(s.handlers.has("agent_settled"), false);
	s.event.toolResults = [];
	s.event.context.canContinue = false;
	assert.equal(await s.emit("turn_end", s.event), undefined);
	assert.equal(compact.mock.callCount(), 0);
});

test("queued messages do not prevent between-turn compaction", async () => {
	const s = await setup();
	s.setIdle(false);
	s.setPending(true);
	assert.ok((await s.emit("turn_end", s.event))?.entries);
});

test("skips a terminating tool batch unless another response is queued", async () => {
	const s = await setup();
	await s.emit("tool_execution_end", { toolCallId: "call-1", result: { terminate: true } });
	assert.equal(await s.emit("turn_end", s.event), undefined);
	s.setPending(true);
	assert.ok((await s.emit("turn_end", s.event))?.entries);
});

test("skips failed and aborted turns", async () => {
	for (const outcome of ["aborted", "error"]) {
		const s = await setup();
		s.event.outcome = outcome;
		assert.equal(await s.emit("turn_end", s.event), undefined);
	}
	assert.equal(compact.mock.callCount(), 0);
});

test("uses projected tool-result tokens rather than stale footer usage", async () => {
	const s = await setup(69900);
	assert.ok((await s.emit("turn_end", s.event))?.entries);
});

test("preserves previous boundary entries and respects their edited projection", async () => {
	const s = await setup(69900);
	const draft = { type: "custom", customType: "test", data: {} };
	s.event.entries = [draft] as any;
	const result = await s.emit("turn_end", s.event);
	assert.equal(result.entries[0], draft);
	const s2 = await setup(69900);
	s2.event.entries = [{ type: "context_edit", targetId: s2.event.toolResultEntryIds[0], replacement: null }] as any;
	const preview = native.SessionManager.inMemory(undefined, undefined, [s2.ctx.sessionManager.getHeader()!, ...s2.ctx.sessionManager.getBranch()]);
	preview.appendContextEdit(s2.event.toolResultEntryIds[0], null);
	s2.event.context.contextEntries = preview.buildSessionProjection().entries;
	s2.event.context.contextMessages = preview.buildSessionProjection().messages;
	assert.equal(await s2.emit("turn_end", s2.event), undefined);
});

test("uses a strict threshold and yields to Pi above its native limit", async () => {
	const s = await setup(90000);
	assert.equal(await s.emit("turn_end", s.event), undefined);
	const s2 = await setup(70000);
	await s2.emit("before_agent_start");
	assert.equal(s2.manualCompact.mock.callCount(), 0);
});

test("respects model-specific built-in thresholds and model changes", async () => {
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: {
		keepRecentTokens: 100, modelOverrides: { "test/test": { reserveTokens: 40000 } },
	} }));
	const s = await setup();
	assert.equal(await s.emit("turn_end", s.event), undefined);
	s.ctx.model.id = "other";
	assert.ok((await s.emit("turn_end", s.event))?.entries);
});

test("compaction errors leave the active run and entries unchanged", async () => {
	const s = await setup();
	compact.mock.mockImplementationOnce(async () => { throw new Error("Provider unavailable"); });
	assert.equal(await s.emit("turn_end", s.event), undefined);
	assert.equal(s.manualCompact.mock.callCount(), 0);
	assert.ok(s.notifications.some((message) => message.includes("Provider unavailable")));
});

test("waits for one summary and honours cancellation", async () => {
	const s = await setup();
	let finish!: (result: any) => void;
	compact.mock.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
	const first = s.emit("turn_end", s.event);
	await Promise.resolve();
	assert.equal(await s.emit("turn_end", s.event), undefined);
	s.controller.abort();
	finish({ summary: "Cancelled summary", firstKeptEntryId: s.event.messageEntryId });
	assert.equal(await first, undefined);
	assert.equal(s.manualCompact.mock.callCount(), 0);
});

test("retains the idle pre-prompt check and disables extension thresholds when configured off", async () => {
	const s = await setup();
	await s.emit("before_agent_start");
	assert.equal(s.manualCompact.mock.callCount(), 1);
	writeFileSync(join(agentDir, "auto-compact.json"), JSON.stringify({ enabled: false, percentThreshold: 70 }));
	const s2 = await setup();
	assert.equal(await s2.emit("turn_end", s2.event), undefined);
});
