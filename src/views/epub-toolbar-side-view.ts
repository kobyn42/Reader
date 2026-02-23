import { ItemView, WorkspaceLeaf } from "obsidian";
import { VIEW_TYPE_EPUB_TOOLBAR } from "../constants";
import type ReaderPlugin from "../main";
import type { ReaderToolbarState } from "../types";
import { EpubReaderView } from "./epub-view";

const NO_READER_STATE_TEXT = "Open an EPUB reader to use toolbar controls.";

export class EpubToolbarSideView extends ItemView {
	private plugin: ReaderPlugin;
	private prevButtonEl: HTMLButtonElement | null = null;
	private nextButtonEl: HTMLButtonElement | null = null;
	private tocSelectEl: HTMLSelectElement | null = null;
	private chapterTitleEl: HTMLElement | null = null;
	private stateTextEl: HTMLElement | null = null;
	private currentReader: EpubReaderView | null = null;
	private unsubscribeToolbarState: (() => void) | null = null;
	private isSyncingSelect = false;

	constructor(leaf: WorkspaceLeaf, plugin: ReaderPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_EPUB_TOOLBAR;
	}

	getDisplayText(): string {
		return "Reader toolbar";
	}

	async onOpen(): Promise<void> {
		this.buildLayout();
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				this.refreshReaderBinding();
			}),
		);
		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				this.refreshReaderBinding();
			}),
		);
		this.refreshReaderBinding();
	}

	async onClose(): Promise<void> {
		this.teardownReaderBinding();
		this.contentEl.empty();
	}

	requestRefresh(): void {
		this.refreshReaderBinding();
	}

	private buildLayout(): void {
		this.contentEl.empty();
		this.contentEl.addClass("reader-side-toolbar");

		const controlsEl = this.contentEl.createDiv({ cls: "reader-side-toolbar-controls" });
		this.prevButtonEl = controlsEl.createEl("button", {
			cls: "reader-epub-button reader-side-toolbar-button",
			text: "Prev",
		});
		this.registerDomEvent(this.prevButtonEl, "click", () => {
			void this.currentReader?.prevPage();
		});

		this.nextButtonEl = controlsEl.createEl("button", {
			cls: "reader-epub-button reader-side-toolbar-button",
			text: "Next",
		});
		this.registerDomEvent(this.nextButtonEl, "click", () => {
			void this.currentReader?.nextPage();
		});

		this.tocSelectEl = this.contentEl.createEl("select", {
			cls: "reader-epub-toc reader-side-toolbar-toc",
		});
		this.registerDomEvent(this.tocSelectEl, "change", () => {
			void this.handleTocChange();
		});

		this.chapterTitleEl = this.contentEl.createDiv({
			cls: "reader-epub-chapter reader-side-toolbar-chapter",
		});

		this.stateTextEl = this.contentEl.createDiv({
			cls: "reader-side-toolbar-state",
			text: NO_READER_STATE_TEXT,
		});
	}

	private refreshReaderBinding(): void {
		const preferredReader = this.plugin.getPreferredReaderView();
		if (preferredReader === this.currentReader) {
			if (!preferredReader) {
				this.renderNoReaderState();
				return;
			}
			this.renderToolbarState(preferredReader.getToolbarState());
			return;
		}

		this.teardownReaderBinding();
		this.currentReader = preferredReader;

		if (!this.currentReader) {
			this.renderNoReaderState();
			return;
		}

		this.unsubscribeToolbarState = this.currentReader.onToolbarStateChange((state) => {
			this.renderToolbarState(state);
		});
	}

	private teardownReaderBinding(): void {
		if (this.unsubscribeToolbarState) {
			this.unsubscribeToolbarState();
			this.unsubscribeToolbarState = null;
		}
		this.currentReader = null;
	}

	private async handleTocChange(): Promise<void> {
		if (this.isSyncingSelect || !this.currentReader || !this.tocSelectEl) {
			return;
		}

		const selected = this.tocSelectEl.value;
		if (!selected) {
			return;
		}
		await this.currentReader.jumpToSection(selected);
	}

	private renderNoReaderState(): void {
		this.renderToolbarState({
			canNavigate: false,
			chapterTitle: "",
			selectedHrefKey: null,
			tocItems: [],
		});
		this.setStateText(NO_READER_STATE_TEXT);
	}

	private renderToolbarState(state: ReaderToolbarState): void {
		const isReaderConnected = this.currentReader !== null;
		const canNavigate = isReaderConnected && state.canNavigate;
		if (this.prevButtonEl) {
			this.prevButtonEl.disabled = !canNavigate;
		}
		if (this.nextButtonEl) {
			this.nextButtonEl.disabled = !canNavigate;
		}

		if (this.chapterTitleEl) {
			this.chapterTitleEl.setText(state.chapterTitle);
		}

		this.syncTocOptions(state, isReaderConnected);
		if (isReaderConnected) {
			this.setStateText("");
		}
	}

	private syncTocOptions(state: ReaderToolbarState, isReaderConnected: boolean): void {
		if (!this.tocSelectEl) {
			return;
		}

		this.isSyncingSelect = true;
		while (this.tocSelectEl.firstChild) {
			this.tocSelectEl.removeChild(this.tocSelectEl.firstChild);
		}

		const defaultOption = this.tocSelectEl.createEl("option", {
			text: "Table of contents",
			value: "",
		});
		defaultOption.selected = true;

		for (const item of state.tocItems) {
			const option = this.tocSelectEl.createEl("option", {
				text: item.label,
				value: item.value,
			});
			option.dataset.hrefKey = item.hrefKey;
		}

		const selectedTocItem = state.selectedHrefKey
			? state.tocItems.find((item) => item.hrefKey === state.selectedHrefKey)
			: null;
		this.tocSelectEl.value = selectedTocItem?.value ?? "";
		this.tocSelectEl.disabled = !isReaderConnected || state.tocItems.length === 0;
		this.isSyncingSelect = false;
	}

	private setStateText(message: string): void {
		if (!this.stateTextEl) {
			return;
		}

		this.stateTextEl.setText(message);
		this.stateTextEl.toggleClass("is-hidden", message.length === 0);
	}
}
