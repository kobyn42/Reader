import { App, FuzzySuggestModal, Notice, TFile } from "obsidian";
import { NOTICE_EPUB_OPEN_FAILED } from "../constants";

export class EpubFileSuggestModal extends FuzzySuggestModal<TFile> {
	private files: TFile[];
	private onChooseFile: (file: TFile) => Promise<void>;

	constructor(app: App, files: TFile[], onChooseFile: (file: TFile) => Promise<void>) {
		super(app);
		this.files = files;
		this.onChooseFile = onChooseFile;
		this.setPlaceholder("Type to search epub files...");
		this.setInstructions([
			{ command: "↑/↓", purpose: "Move" },
			{ command: "Enter", purpose: "Open" },
			{ command: "Esc", purpose: "Close" },
		]);
	}

	getItems(): TFile[] {
		return this.files;
	}

	getItemText(item: TFile): string {
		return item.path;
	}

	onChooseItem(item: TFile): void {
		void this.onChooseFile(item).catch((error: unknown) => {
			console.error("Failed to open EPUB from picker", error);
			new Notice(NOTICE_EPUB_OPEN_FAILED);
		});
	}
}
