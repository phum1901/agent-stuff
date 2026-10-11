/**
 * Read-only tool inspector.
 *
 * /tools shows exposure, model activation and codemode access.
 * It does not change active tools or restore saved selections.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	fuzzyFilter,
	getKeybindings,
	Input,
	type SelectItem,
	SelectList,
	Text,
	truncateToWidth,
} from "@earendil-works/pi-tui";

export default function toolsExtension(pi: ExtensionAPI) {
	pi.registerCommand("tools", {
		description: "Inspect tool access (read-only)",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/tools requires TUI mode", "error");
				return;
			}

			// Read a fresh snapshot on each open. Pi owns tool activation.
			const activeTools = new Set(pi.getActiveTools());
			const items: SelectItem[] = pi.getAllTools().map((tool) => {
				const active = activeTools.has(tool.name);
				const callable = tool.exposure === "codemode" || tool.exposure === "deferred" ||
					(tool.exposure === "direct" && active);
				return {
					value: tool.name,
					label: tool.name,
					description: `Exposure: ${tool.exposure} | Model: ${active ? "active" : "inactive"} | Codemode: ${callable ? "yes" : "no"}`,
				};
			});

			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				const search = new Input({ prompt: "Search: " });
				const details = new Text("", 0, 0);
				const title = new Text(theme.fg("accent", theme.bold("Tools (read-only snapshot)")), 0, 0);
				const hint = new Text(theme.fg("dim", "Type to search · ↑↓ scroll · Enter/Esc close"), 0, 0);
				const listTheme = {
					selectedPrefix: (text: string) => theme.fg("accent", text),
					selectedText: (text: string) => theme.fg("accent", text),
					description: (text: string) => theme.fg("muted", text),
					scrollInfo: (text: string) => theme.fg("dim", text),
					noMatch: (text: string) => theme.fg("warning", text),
				};

				function updateDetails(item: SelectItem | null) {
					details.setText(item ? `${item.label}\n${item.description}` : "No matching tools");
				}

				function createList(query: string) {
					const filtered = fuzzyFilter(items, query, (item) => item.value);
					const list = new SelectList(filtered, Math.max(1, Math.min(filtered.length, 12)), listTheme);
					list.onSelectionChange = updateDetails;
					updateDetails(list.getSelectedItem());
					return list;
				}

				let list = createList("");
				return {
					get focused() { return search.focused; },
					set focused(value: boolean) { search.focused = value; },
					render(width: number) {
						return [
							...title.render(width), "", ...search.render(width), "",
							...list.render(width), "", ...details.render(width), "", ...hint.render(width),
						].map((line) => truncateToWidth(line, width));
					},
					invalidate() {
						title.invalidate();
						search.invalidate();
						list.invalidate();
						details.invalidate();
						hint.invalidate();
					},
					handleInput(data: string) {
						const kb = getKeybindings();
						if (kb.matches(data, "tui.select.cancel") || kb.matches(data, "tui.select.confirm")) {
							done(undefined);
							return;
						}
						if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) {
							list.handleInput(data);
						} else {
							const previous = search.getValue();
							search.handleInput(data);
							if (search.getValue() !== previous) list = createList(search.getValue());
						}
						tui.requestRender();
					},
				};
			});
		},
	});
}
