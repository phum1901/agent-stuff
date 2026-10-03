import {
	calculateContextTokens,
	compact,
	estimateTokens,
	findCutPoint,
	prepareBranchEntries,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionContext, SessionEntry, TurnEndEvent } from "@earendil-works/pi-coding-agent";

type CompactionSettings = Parameters<typeof compact>[0]["settings"];

// The boundary preview includes edits proposed by earlier turn_end handlers.
// Usage recorded before an edit or compaction cannot measure that new context.
export function boundaryTokens(event: TurnEndEvent, ctx: ExtensionContext): number {
	const messages = event.context.contextMessages;
	const branch = ctx.sessionManager.getBranch();
	const invalidatingIndex = branch.findLastIndex((entry) => entry.type === "context_edit" || entry.type === "compaction");
	const hasDraftEdit = event.entries.some((entry) => entry.type === "context_edit" || entry.type === "compaction");
	if (!hasDraftEdit) {
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message.role !== "assistant" || message.stopReason === "aborted" || message.stopReason === "error") continue;
			const usage = calculateContextTokens(message.usage);
			if (usage <= 0) continue;
			const owner = event.context.contextEntries.find((entry) => entry.messages.includes(message));
			const usageIndex = branch.findIndex((entry) => entry.id === owner?.sourceEntry.id);
			if (usageIndex <= invalidatingIndex) break;
			return usage + messages.slice(i + 1).reduce((total, next) => total + estimateTokens(next), 0);
		}
	}
	return messages.reduce((total, message) => total + estimateTokens(message), 0);
}

// ctx.compact aborts an active run. Generate with Pi's summary implementation
// instead, then let the turn_end boundary commit the returned compaction entry.
export async function compactBoundary(
	event: TurnEndEvent,
	ctx: ExtensionContext,
	settings: CompactionSettings,
	tokensBefore: number,
	retry: Parameters<typeof compact>[9],
) {
	const model = ctx.model;
	if (!model || ctx.signal?.aborted) return;
	const previous = event.context.contextEntries.find((entry) =>
		entry.sourceEntry.type === "compaction" && entry.messages.length > 0);
	const previousCompaction = previous?.sourceEntry.type === "compaction" ? previous.sourceEntry : undefined;
	const entries: SessionEntry[] = event.context.contextEntries.flatMap((entry) => {
		if (entry === previous) return [];
		return entry.messages.filter((message) => message.role !== "system").map((message) => ({
			type: "message" as const,
			id: entry.sourceEntry.id,
			parentId: entry.sourceEntry.parentId,
			timestamp: entry.sourceEntry.timestamp,
			message,
		}));
	});
	const cut = findCutPoint(entries, 0, entries.length, settings.keepRecentTokens);
	const firstKeptEntryId = entries[cut.firstKeptEntryIndex]?.id;
	if (!firstKeptEntryId || cut.firstKeptEntryIndex === 0) return;
	const historyEnd = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptEntryIndex;
	const prefix = entries.slice(0, cut.firstKeptEntryIndex);
	const { fileOps } = prepareBranchEntries(prefix);
	const details = previousCompaction?.details as { readFiles?: unknown; modifiedFiles?: unknown } | undefined;
	for (const [files, target] of [[details?.readFiles, fileOps.read], [details?.modifiedFiles, fileOps.edited]] as const) {
		if (Array.isArray(files)) for (const path of files) if (typeof path === "string") target.add(path);
	}
	const result = await compact({
		firstKeptEntryId,
		messagesToSummarize: entries.slice(0, historyEnd).flatMap((entry) => entry.type === "message" ? [entry.message] : []),
		turnPrefixMessages: cut.isSplitTurn
			? entries.slice(cut.turnStartIndex, cut.firstKeptEntryIndex).flatMap((entry) => entry.type === "message" ? [entry.message] : [])
			: [],
		isSplitTurn: cut.isSplitTurn,
		tokensBefore,
		previousSummary: previousCompaction?.summary,
		fileOps,
		settings,
	}, model, undefined, undefined, undefined, ctx.signal, ctx.thinkingLevel,
		(requestModel, context, options) => ctx.modelRegistry.streamSimple(requestModel, context, options),
		undefined, retry);
	if (ctx.signal?.aborted) return;
	return {
		entries: [...event.entries, {
			type: "compaction" as const,
			summary: result.summary,
			firstKeptEntryId: result.firstKeptEntryId,
			details: result.details,
			usage: result.usage,
		}],
	};
}
