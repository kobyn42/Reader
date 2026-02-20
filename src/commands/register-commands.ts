import { Notice, TFile } from "obsidian";
import {
	COMMAND_EPUB_NEXT_PAGE,
	COMMAND_EPUB_PREV_PAGE,
	COMMAND_OPEN_EPUB_FILE,
	EPUB_EXTENSION,
	NOTICE_NO_EPUB_FILES,
} from "../constants";
import type ReaderPlugin from "../main";
import { EpubFileSuggestModal } from "../ui/epub-file-suggest-modal";
import { EpubReaderView } from "../views/epub-view";

function getEpubFiles(plugin: ReaderPlugin): TFile[] {
	return plugin.app.vault
		.getFiles()
		.filter((file) => file.extension.toLowerCase() === EPUB_EXTENSION)
		.sort((a, b) => a.path.localeCompare(b.path));
}

export function registerReaderCommands(plugin: ReaderPlugin): void {
	plugin.addCommand({
		id: COMMAND_OPEN_EPUB_FILE,
		name: "Open epub file",
		callback: () => {
			const files = getEpubFiles(plugin);
			if (files.length === 0) {
				new Notice(NOTICE_NO_EPUB_FILES);
				return;
			}

			new EpubFileSuggestModal(plugin.app, files, async (file) => {
				await plugin.openEpubFile(file, true);
			}).open();
		},
	});

	plugin.addCommand({
		id: COMMAND_EPUB_PREV_PAGE,
		name: "Epub: previous page",
		checkCallback: (checking) => {
			const view = plugin.app.workspace.getActiveViewOfType(EpubReaderView);
			if (!view) {
				return false;
			}

			if (!checking) {
				void view.prevPage();
			}
			return true;
		},
	});

	plugin.addCommand({
		id: COMMAND_EPUB_NEXT_PAGE,
		name: "Epub: next page",
		checkCallback: (checking) => {
			const view = plugin.app.workspace.getActiveViewOfType(EpubReaderView);
			if (!view) {
				return false;
			}

			if (!checking) {
				void view.nextPage();
			}
			return true;
		},
	});
}
