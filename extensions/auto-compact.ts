import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// =============================================================================
// Types
// =============================================================================

type AutoCompactConfig = {
	enabled: boolean;
	percentThreshold?: number;
	percentEnabled?: boolean;
	usedTokensThreshold?: number;
	usedTokensEnabled?: boolean;
};

type ConfigIssue = { message: string };

type ThresholdSource = "remaining" | "percent" | "used";

type ThresholdCandidate = {
	source: ThresholdSource;
	usedTokens: number;
	describe: string;
};

type EffectiveThreshold = {
	value: number | null;
	source: ThresholdSource | null;
	candidates: ThresholdCandidate[];
	builtInValue: number | null;
	handleByExtension: boolean;
};

const EXT_NAME = "auto-compact";
const FILE_NAME = "auto-compact.json";

// =============================================================================
// Config
// =============================================================================

function globalConfigPath(): string {
	return join(getAgentDir(), FILE_NAME);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFile(raw: unknown, issues: ConfigIssue[]): Partial<AutoCompactConfig> {
	if (raw === undefined) return {};
	if (!isPlainObject(raw)) {
		issues.push({ message: "config must be a JSON object, file ignored" });
		return {};
	}
	const out: Partial<AutoCompactConfig> = {};
	if (raw.enabled !== undefined) {
		if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
		else issues.push({ message: `enabled must be boolean, got ${JSON.stringify(raw.enabled)}, ignored` });
	}
	if (raw.percentThreshold !== undefined) {
		const v = raw.percentThreshold;
		if (typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 100) out.percentThreshold = v;
		else issues.push({ message: `percentThreshold must be in (0, 100], got ${JSON.stringify(v)}, ignored` });
	}
	if (raw.usedTokensThreshold !== undefined) {
		const v = raw.usedTokensThreshold;
		if (typeof v === "number" && Number.isInteger(v) && v > 0) out.usedTokensThreshold = v;
		else issues.push({ message: `usedTokensThreshold must be a positive integer, got ${JSON.stringify(v)}, ignored` });
	}
	for (const field of ["percentEnabled", "usedTokensEnabled"] as const) {
		if (raw[field] !== undefined) {
			if (typeof raw[field] === "boolean") (out as Record<string, unknown>)[field] = raw[field];
			else issues.push({ message: `${field} must be boolean, got ${JSON.stringify(raw[field])}, ignored` });
		}
	}
	return out;
}

function readJson(path: string): unknown {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch (error) {
		return { __parseError: error instanceof Error ? error.message : String(error) };
	}
}

function loadConfig(): { config: AutoCompactConfig; issues: ConfigIssue[] } {
	const issues: ConfigIssue[] = [];
	const raw = readJson(globalConfigPath());
	if (isPlainObject(raw) && typeof raw.__parseError === "string") {
		issues.push({ message: `JSON parse failed: ${raw.__parseError}, config ignored` });
	}
	const config: AutoCompactConfig = {
		enabled: true,
		...parseFile(isPlainObject(raw) && !("__parseError" in raw) ? raw : undefined, issues),
	};
	return { config, issues };
}

// =============================================================================
// Thresholds (pure: convert all to used-tokens, lowest wins)
// =============================================================================

function computeThresholds(
	config: AutoCompactConfig,
	contextWindow: number,
	builtIn: { enabled: boolean; reserveTokens: number },
): EffectiveThreshold {
	const candidates: ThresholdCandidate[] = [];
	let builtInValue: number | null = null;

	if (builtIn.enabled && Number.isFinite(contextWindow) && builtIn.reserveTokens >= 0) {
		builtInValue = Math.max(0, contextWindow - builtIn.reserveTokens);
		candidates.push({
			source: "remaining",
			usedTokens: builtInValue,
			describe: `remaining ${builtIn.reserveTokens.toLocaleString("en-US")} tokens (pi built-in)`,
		});
	}

	let hasExtension = false;
	if (config.enabled) {
		if (config.percentThreshold !== undefined && config.percentEnabled !== false) {
			hasExtension = true;
			candidates.push({
				source: "percent",
				usedTokens: Math.floor((contextWindow * config.percentThreshold) / 100),
				describe: `${config.percentThreshold}% of context window`,
			});
		}
		if (config.usedTokensThreshold !== undefined && config.usedTokensEnabled !== false) {
			hasExtension = true;
			candidates.push({
				source: "used",
				usedTokens: config.usedTokensThreshold,
				describe: `used ${config.usedTokensThreshold.toLocaleString("en-US")} tokens`,
			});
		}
	}

	const sorted = [...candidates].sort((a, b) => a.usedTokens - b.usedTokens);
	const lowest = sorted[0];
	return {
		value: lowest ? lowest.usedTokens : null,
		source: lowest ? lowest.source : null,
		candidates: sorted,
		builtInValue,
		handleByExtension:
			lowest !== undefined && hasExtension && (builtInValue === null || lowest.usedTokens < builtInValue),
	};
}

// =============================================================================
// Extension
// =============================================================================

export default function (pi: ExtensionAPI) {
	let config: AutoCompactConfig = { enabled: true };
	let issues: ConfigIssue[] = [];
	let builtIn = { enabled: true, reserveTokens: 16384 };
	let inFlight: Promise<boolean> | null = null;
	let lastRunAborted = false;

	const fmt = (n: number): string => n.toLocaleString("en-US");

	const reloadAll = (cwd: string): void => {
		const loaded = loadConfig();
		config = loaded.config;
		issues = loaded.issues;
		try {
			const compaction = SettingsManager.create(cwd).getCompactionSettings();
			builtIn = { enabled: compaction.enabled, reserveTokens: compaction.reserveTokens };
		} catch {
			builtIn = { enabled: true, reserveTokens: 16384 };
		}
	};

	const notify = (ctx: ExtensionContext, message: string, type: "info" | "error" | "warning"): void => {
		if (!ctx.hasUI) return;
		try {
			ctx.ui.notify(message, type);
		} catch {
			// UI may be stale during reload; ignore.
		}
	};

	// ctx.compact is fire-and-forget (void + callbacks). Wrap in a Promise so
	// safe checkpoints can wait for compaction before the next turn starts.
	const compactOnce = (ctx: ExtensionContext, reason: string): Promise<boolean> => {
		const promise = new Promise<boolean>((resolve) => {
			let settled = false;
			const settle = (ok: boolean, message: string, type: "info" | "error"): void => {
				if (settled) return;
				settled = true;
				resolve(ok);
				notify(ctx, message, type);
			};
			try {
				ctx.compact({
					onComplete: () => settle(true, `${EXT_NAME}: ${reason}, compact done`, "info"),
					onError: (error) => settle(false, `${EXT_NAME}: ${reason}, compact failed: ${error.message}`, "error"),
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				settle(false, `${EXT_NAME}: ${reason}, compact failed: ${message}`, "error");
			}
		});
		const tracked = promise.finally(() => {
			if (inFlight === tracked) inFlight = null;
		});
		return tracked;
	};

	const checkAndTrigger = (ctx: ExtensionContext): Promise<void> => {
		if (!config.enabled || inFlight || !ctx.isIdle() || ctx.hasPendingMessages()) {
			return Promise.resolve();
		}
		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens === null || !Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0) {
			return Promise.resolve();
		}
		const tokens = usage.tokens;
		const effective = computeThresholds(config, usage.contextWindow, builtIn);
		if (!effective.handleByExtension || effective.value === null) return Promise.resolve();
		// Past the built-in limit: let pi native handle it (full threshold/overflow path).
		if (effective.builtInValue !== null && tokens > effective.builtInValue) return Promise.resolve();
		if (!(tokens > effective.value)) return Promise.resolve();
		const lowest = effective.candidates[0];
		inFlight = compactOnce(
			ctx,
			`used ${fmt(tokens)} tokens, reached ${fmt(effective.value)} (${lowest?.describe ?? ""})`,
		);
		return inFlight.then(() => undefined);
	};

	pi.on("session_start", (_event, ctx) => {
		reloadAll(ctx.cwd);
		inFlight = null;
		lastRunAborted = false;
	});

	pi.on("agent_end", (event) => {
		const lastAssistant = [...event.messages].reverse().find((m) => m.role === "assistant");
		lastRunAborted = lastAssistant?.stopReason === "aborted";
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (lastRunAborted) {
			lastRunAborted = false;
			return;
		}
		await checkAndTrigger(ctx);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (inFlight) await inFlight;
		await checkAndTrigger(ctx);
	});

	// ---------- single command: status + control ----------

	const statusLines = (ctx: ExtensionContext): { lines: string[]; level: "info" | "warning" } => {
		const lines: string[] = [];
		if (!config.enabled) {
			lines.push(`${EXT_NAME}: disabled via enabled:false, pi built-in auto-compact unaffected.`);
		}
		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens === null || !Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0) {
			lines.push("Context usage unknown (no model or no messages yet), cannot compute thresholds.");
		} else {
			const effective = computeThresholds(config, usage.contextWindow, builtIn);
			lines.push(`Model context window: ${fmt(usage.contextWindow)} tokens`);
			lines.push("Thresholds in used-tokens (lowest wins):");
			for (const c of effective.candidates) {
				const mark = c.source === effective.source ? " <- lowest" : "";
				const owner = c.source === "remaining" ? "(pi built-in)" : "(this extension)";
				lines.push(`  - ${c.describe} -> ${fmt(c.usedTokens)} tokens${mark} ${owner}`);
			}
			if (effective.candidates.length === 0) {
				lines.push("  - no active threshold, and pi built-in auto-compact is off.");
			}
			const pct = usage.percent === null ? "unknown" : `${usage.percent.toFixed(1)}%`;
			lines.push(`Current usage: ${fmt(usage.tokens)} / ${fmt(usage.contextWindow)} tokens (${pct})`);
			if (effective.handleByExtension && effective.value !== null) {
				const remaining = effective.value - usage.tokens;
				lines.push(remaining > 0 ? `${fmt(remaining)} tokens left before threshold.` : "Threshold reached.");
			}
		}
		if (issues.length > 0) {
			lines.push("Config issues:");
			for (const issue of issues) lines.push(`  - ${issue.message}`);
		}
		lines.push(`Config file: ${globalConfigPath()}`);
		return { lines, level: issues.length > 0 ? "warning" : "info" };
	};

	const writeConfig = (cwd: string, mutate: (obj: Record<string, unknown>) => void): string => {
		const path = globalConfigPath();
		let obj: Record<string, unknown> = {};
		if (existsSync(path)) {
			try {
				const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
				if (isPlainObject(parsed)) obj = { ...parsed };
				else throw new Error("config must be a JSON object");
			} catch (error) {
				throw new Error(`config JSON broken (${error instanceof Error ? error.message : String(error)}), fix it first`);
			}
		}
		mutate(obj);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`);
		reloadAll(cwd);
		return path;
	};

	const parseArgs = (args: string): { target: "percent" | "used"; next: boolean } | { target: "percent" | "used"; value: number } | { error: string } => {
		const parts = args.toLowerCase().split(/\s+/).filter(Boolean);
		const targetMap: Record<string, "percent" | "used"> = { percent: "percent", pct: "percent", used: "used" };
		const target = targetMap[parts[0] ?? ""];
		if (!target) return { error: `unknown threshold "${parts[0] ?? ""}", use percent or used.` };
		const arg = parts[1] ?? "";
		if (arg === "") {
			return { error: `missing value, use on / off or a number (e.g. /auto-compact ${target} ${target === "percent" ? "90" : "240000"}).` };
		}
		if (arg === "on" || arg === "off") return { target, next: arg === "on" };
		const value = Number(arg);
		if (!Number.isFinite(value)) {
			return { error: `unknown arg "${arg}", use on / off or a number (e.g. percent 90, used 240000).` };
		}
		if (target === "percent") {
			if (!(value > 0 && value <= 100)) return { error: `percent must be in (0, 100], got "${arg}".` };
		} else if (!(Number.isInteger(value) && value > 0)) {
			return { error: `used must be a positive integer, got "${arg}" (e.g. 240000).` };
		}
		return { target, value };
	};

	pi.registerCommand("auto-compact", {
		description: "Manage auto-compact thresholds (menu, or percent|used on|off|<value>)",
		getArgumentCompletions: (prefix) => {
			const on = (target: "percent" | "used") => ({
				value: `${target} on`,
				label: `${target} on`,
				description: `Enable ${target} threshold`,
			});
			const off = (target: "percent" | "used") => ({
				value: `${target} off`,
				label: `${target} off`,
				description: `Disable ${target} threshold`,
			});
			const p = prefix.trim().toLowerCase();
			if (p === "") {
				return [
					{ value: "percent ", label: "percent", description: "Percent threshold" },
					{ value: "used ", label: "used", description: "Used-tokens threshold" },
				];
			}
			const m = p.match(/^(percent|pct|used)\s*(.*)$/);
			if (!m) return [];
			const word = m[1] as "percent" | "pct" | "used";
			const rest = m[2].trim();
			const target = word === "used" ? "used" : "percent";
			if (rest === "") {
				// First token partial or complete target with no second token yet.
				if (p.endsWith(" ") || word.length === p.length) {
					const hint = target === "percent" ? "90" : "240000";
					return [
						on(target),
						off(target),
						{
							value: `${target} `,
							label: `${target} <${target === "percent" ? "0-100" : "int"}>`,
							description: `Set value, e.g. ${hint}`,
						},
					];
				}
				return [
					{ value: "percent ", label: "percent", description: "Percent threshold" },
					{ value: "used ", label: "used", description: "Used-tokens threshold" },
				].filter((i) => i.value.startsWith(p));
			}
			// Second token started: typing a number -> no popup, let Enter submit.
			if (/^\d/.test(rest)) return [];
			return [on(target), off(target)].filter((i) => i.value.startsWith(`${target} ${rest}`));
		},
		handler: async (args, ctx) => {
			const applyValue = (target: "percent" | "used", value: number): void => {
				const meta: { valueField: "percentThreshold" | "usedTokensThreshold"; flagField: "percentEnabled" | "usedTokensEnabled"; label: string } =
					target === "percent"
						? { valueField: "percentThreshold", flagField: "percentEnabled", label: "percentThreshold" }
						: { valueField: "usedTokensThreshold", flagField: "usedTokensEnabled", label: "usedTokensThreshold" };
				const path = writeConfig(ctx.cwd, (obj) => {
					obj[meta.valueField] = value;
					delete obj[meta.flagField];
				});
				const label = target === "percent" ? `${value}%` : `${fmt(value)} tokens`;
				notify(ctx, `${EXT_NAME}: ${meta.label} set to ${label}, wrote ${path}, active now.`, "info");
			};
			const applyToggle = (target: "percent" | "used", next: boolean): void => {
				const meta: { valueField: "percentThreshold" | "usedTokensThreshold"; flagField: "percentEnabled" | "usedTokensEnabled"; label: string } =
					target === "percent"
						? { valueField: "percentThreshold", flagField: "percentEnabled", label: "percentThreshold" }
						: { valueField: "usedTokensThreshold", flagField: "usedTokensEnabled", label: "usedTokensThreshold" };
				if (config[meta.valueField] === undefined) {
					notify(
						ctx,
						`${EXT_NAME}: ${meta.label} has no value yet, set one first (e.g. /auto-compact ${target} ${target === "percent" ? "90" : "240000"}).`,
						"warning",
					);
					return;
				}
				const path = writeConfig(ctx.cwd, (obj) => {
					if (next) delete obj[meta.flagField];
					else obj[meta.flagField] = false;
				});
				notify(ctx, `${EXT_NAME}: ${meta.label} ${next ? "enabled" : "disabled"}, wrote ${path}, active now.`, "info");
			};

			const trimmed = args.trim();
			if (trimmed) {
				const parsed = parseArgs(trimmed);
				if ("error" in parsed) {
					notify(ctx, `${EXT_NAME}: ${parsed.error}`, "warning");
					return;
				}
				try {
					if ("value" in parsed) applyValue(parsed.target, parsed.value);
					else applyToggle(parsed.target, parsed.next);
				} catch (error) {
					notify(ctx, `${EXT_NAME}: ${error instanceof Error ? error.message : String(error)}`, "warning");
				}
				return;
			}

			// No args: status text, plus interactive menu in TUI (like /mode).
			{
				const { lines, level } = statusLines(ctx);
				notify(ctx, lines.join("\n"), level);
			}
			if (!ctx.hasUI) return;

			for (;;) {
				const usage = ctx.getContextUsage();
				const known =
					usage && usage.tokens !== null && Number.isFinite(usage.contextWindow) && usage.contextWindow > 0;
				const effective = known
					? computeThresholds(config, (usage as { contextWindow: number }).contextWindow, builtIn)
					: null;
				const winner = effective?.source ?? null;
				const title = known
					? `Auto-compact — used ${fmt((usage as { tokens: number }).tokens)} / ${fmt((usage as { contextWindow: number }).contextWindow)}, lowest wins (Esc exits)`
					: "Auto-compact thresholds (Esc exits)";

				const row = (target: "percent" | "used"): string => {
					const isPercent = target === "percent";
					const value = isPercent ? config.percentThreshold : config.usedTokensThreshold;
					const enabled = isPercent ? config.percentEnabled : config.usedTokensEnabled;
					const name = isPercent ? "Percent" : "Used tokens";
					if (value === undefined) return `${name}: not set`;
					const shown = isPercent ? `${value}%` : `${fmt(value)} tokens`;
					const wins = winner === target ? ", wins" : "";
					return `${name}: ${shown} (${enabled === false ? "off" : "on"}${wins})`;
				};
				const percentRow = row("percent");
				const usedRow = row("used");
				const choice = await ctx.ui.select(title, [percentRow, usedRow]);
				if (choice === undefined) break;
				const target = choice === percentRow ? "percent" : "used";
				const isPercent = target === "percent";

				const action = await ctx.ui.select(choice, [
					"Set value…",
					`${(isPercent ? config.percentEnabled : config.usedTokensEnabled) === false ? "Enable" : "Disable"}`,
					"Back",
				]);
				if (action === undefined || action === "Back") continue;
				try {
					if (action === "Set value…") {
						if (isPercent) {
							const raw = await ctx.ui.input(
								"Percent threshold (0-100)",
								config.percentThreshold?.toString() ?? "90",
							);
							if (raw === undefined) continue;
							const value = Number(raw.trim());
							if (!(value > 0 && value <= 100)) {
								notify(ctx, `${EXT_NAME}: percent must be in (0, 100], got "${raw.trim()}".`, "warning");
								continue;
							}
							applyValue("percent", value);
						} else {
							const raw = await ctx.ui.input(
								"Used-tokens threshold (positive integer)",
								config.usedTokensThreshold?.toString() ?? "240000",
							);
							if (raw === undefined) continue;
							const value = Number(raw.trim());
							if (!(Number.isInteger(value) && value > 0)) {
								notify(ctx, `${EXT_NAME}: used must be a positive integer, got "${raw.trim()}".`, "warning");
								continue;
							}
							applyValue("used", value);
						}
					} else if (action === "Enable") {
						applyToggle(target, true);
					} else {
						applyToggle(target, false);
					}
				} catch (error) {
					notify(ctx, `${EXT_NAME}: ${error instanceof Error ? error.message : String(error)}`, "warning");
				}
			}
		},
	});
}
