import assert from "node:assert/strict";
import test from "node:test";
import type { ToolExposure } from "@earendil-works/pi-coding-agent";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";

const identity = (text: string) => text;
const { default: toolsExtension } = await import("../extensions/tools.ts");

type Tool = { name: string; exposure: ToolExposure };

function setup(initialTools: Tool[] = [
	{ name: "read", exposure: "direct" }, { name: "bash", exposure: "direct" },
]) {
	const handlers = new Map<string, Function>();
	const commands = new Map<string, any>();
	let tools = initialTools;
	let active = ["read", "bash"];
	let component: any;
	let closed = false;
	let opens = 0;
	const notifications: string[] = [];
	const ctx = {
		mode: "tui",
		sessionManager: { getBranch: () => {
			assert.fail("Read-only /tools must not restore saved selections");
		} },
		ui: {
			notify: (text: string) => notifications.push(text),
			custom: async (factory: Function) => {
				opens++;
				closed = false;
				component = factory({ requestRender() {} }, {
					fg: (_color: string, text: string) => text, bold: identity,
				}, getKeybindings(), () => { closed = true; });
			},
		},
	};
	toolsExtension({
		on: (name: string, handler: Function) => handlers.set(name, handler),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		getAllTools: () => tools,
		getActiveTools: () => [...active],
		setActiveTools: () => assert.fail("Read-only /tools must not change active tools"),
		appendEntry: () => assert.fail("Read-only /tools must not save selections"),
	} as any);
	return {
		ctx, handlers, notifications,
		open: () => commands.get("tools").handler("", ctx),
		emit: (name: string) => handlers.get(name)?.({}, ctx),
		render: (width = 180) => component.render(width).join("\n") as string,
		lines: (width: number) => component.render(width) as string[],
		input: (data: string) => component.handleInput(data),
		closed: () => closed,
		opens: () => opens,
		setActive: (names: string[]) => { active = names; },
		addTool: (tool: Tool) => { tools = [...tools, tool]; },
	};
}

test("shows exposure, model activation and codemode access for every exposure", async () => {
	const s = setup([
		{ name: "direct_active", exposure: "direct" },
		{ name: "direct_inactive", exposure: "direct" },
		{ name: "model_only", exposure: "model-only" },
		{ name: "indirect", exposure: "codemode" },
		{ name: "deferred", exposure: "deferred" },
		{ name: "hidden", exposure: "hidden" },
	]);
	s.setActive(["direct_active", "model_only"]);
	await s.open();
	const rows = s.lines(180);
	for (const [name, exposure, model, callable] of [
		["direct_active", "direct", "active", "yes"],
		["direct_inactive", "direct", "inactive", "no"],
		["model_only", "model-only", "active", "no"],
		["indirect", "codemode", "inactive", "yes"],
		["deferred", "deferred", "inactive", "yes"],
		["hidden", "hidden", "inactive", "no"],
	]) {
		assert.ok(rows.some((row) => row.includes(name) &&
			row.includes(`Exposure: ${exposure} | Model: ${model} | Codemode: ${callable}`)), name);
	}
});

test("takes a fresh snapshot each time the viewer opens", async () => {
	const s = setup();
	await s.open();
	s.addTool({ name: "mcp__context7__query_docs", exposure: "direct" });
	s.setActive(["read", "mcp__context7__query_docs"]);
	await s.open();
	assert.ok(s.lines(180).some((row) => row.includes("mcp__context7__query_docs") &&
		row.includes("Model: active | Codemode: yes")));
	assert.ok(s.lines(180).some((row) => row.includes("bash") && row.includes("Model: inactive | Codemode: no")));
});

test("does not restore or persist selections, and Enter only closes the viewer", async () => {
	const s = setup();
	await s.emit("session_start");
	await s.emit("session_tree");
	assert.equal(s.handlers.size, 0);
	await s.open();
	s.input("\u001b[B");
	s.input("\r");
	assert.equal(s.closed(), true);
});

test("searches inside tool names and keeps full selected-tool details", async () => {
	const s = setup();
	s.addTool({ name: "mcp__context7__query_docs", exposure: "deferred" });
	await s.open();
	for (const char of "context7") s.input(char);
	const view = s.render();
	assert.ok(view.includes("mcp__context7__query_docs"));
	assert.ok(view.includes("Exposure: deferred | Model: inactive | Codemode: yes"));
	assert.ok(!view.includes("Exposure: direct"));
	s.input("\u001b");
	assert.equal(s.closed(), true);
});

test("supports scrolling and renders within narrow terminal widths", async () => {
	const s = setup(Array.from({ length: 20 }, (_, i) => ({
		name: `mcp__server__tool_${String(i).padStart(2, "0")}_with_a_long_name`,
		exposure: "codemode",
	})));
	await s.open();
	for (let i = 0; i < 15; i++) s.input("\u001b[B");
	assert.ok(s.render().includes("tool_15"));
	for (const width of [20, 40, 80]) {
		assert.ok(s.lines(width).every((line) => visibleWidth(line) <= width));
	}
});

test("handles no tools and no search matches without changing tool state", async () => {
	const s = setup([]);
	await s.open();
	assert.ok(s.render().includes("No matching"));
	s.input("x");
	s.input("\u001b[B");
	s.input("\r");
	assert.equal(s.closed(), true);
});

test("rejects non-TUI mode without opening the viewer", async () => {
	const s = setup();
	s.ctx.mode = "print";
	await s.open();
	assert.deepEqual(s.notifications, ["/tools requires TUI mode"]);
	assert.equal(s.opens(), 0);
});
