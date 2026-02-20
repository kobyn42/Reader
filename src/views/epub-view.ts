import ePub, { Book, Contents, NavItem, Rendition } from "epubjs";
import { FileView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import {
	EPUB_EXTENSION,
	NOTICE_EPUB_NAVIGATION_FAILED,
	NOTICE_EPUB_NOT_OPEN,
	NOTICE_EPUB_OPEN_FAILED,
	VIEW_TYPE_EPUB,
} from "../constants";
import type ReaderPlugin from "../main";
import type { PageDisplayMode, ReaderAppearanceTheme } from "../types";

interface RelocatedEventPayload {
	start?: {
		cfi?: string;
		href?: string;
	};
}

interface DisplayModeRenditionConfig {
	flow: "paginated" | "scrolled-continuous";
	manager: "default" | "continuous";
	spread: "auto" | "always" | "none";
	minSpreadWidth: number;
}

type ResolvedReaderAppearanceTheme = Exclude<ReaderAppearanceTheme, "auto">;

type ContentStylesheetRules = Record<string, Record<string, string>>;

const EMPTY_STATE_TEXT = "Select an EPUB file to start reading.";
const ERROR_STATE_TEXT = "Unable to render this EPUB file.";
const LOADING_STATE_TEXT = "Loading EPUB...";
const MEDIA_FIT_RULE_KEY = "reader-media-fit";
const APPEARANCE_THEME_RULE_KEY = "reader-appearance-theme";
const AUTO_MIN_SPREAD_WIDTH = 800;
const ALWAYS_MIN_SPREAD_WIDTH = 0;
const READER_THEME_CLASS_NAMES = ["reader-theme-light", "reader-theme-dark", "reader-theme-sepia"];

export class EpubReaderView extends FileView {
	private plugin: ReaderPlugin;
	private book: Book | null = null;
	private rendition: Rendition | null = null;

	private toolbarEl: HTMLElement | null = null;
	private readerContainerEl: HTMLElement | null = null;
	private tocSelectEl: HTMLSelectElement | null = null;
	private chapterTitleEl: HTMLElement | null = null;
	private currentAppearanceTheme: ReaderAppearanceTheme = "auto";
	private currentResolvedAppearanceTheme: ResolvedReaderAppearanceTheme = "light";

	private tocLabelByHref = new Map<string, string>();

	private onRelocatedHandler = (location: RelocatedEventPayload): void => {
		const href = location.start?.href;
		if (href) {
			this.updateCurrentSection(href);
		}

		const cfi = location.start?.cfi;
		if (cfi && this.file) {
			void this.plugin.setLastLocation(this.file.path, cfi);
		}
	};

	private mediaFitHookHandler = async (contents: Contents): Promise<void> => {
		if (this.isPrePaginatedLayout()) {
			return;
		}

		await contents.addStylesheetRules(
			{
				img: {
					"max-width": "100% !important",
					"max-height": "100% !important",
					width: "auto !important",
					height: "auto !important",
					"object-fit": "contain !important",
					"box-sizing": "border-box !important",
					"page-break-inside": "avoid !important",
					"break-inside": "avoid !important",
				},
				svg: {
					"max-width": "100% !important",
					"max-height": "100% !important",
					width: "auto !important",
					height: "auto !important",
					"box-sizing": "border-box !important",
					"page-break-inside": "avoid !important",
					"break-inside": "avoid !important",
				},
			},
			MEDIA_FIT_RULE_KEY,
		);
	};

	private appearanceThemeHookHandler = async (contents: Contents): Promise<void> => {
		await this.applyAppearanceThemeToContents(contents, this.currentResolvedAppearanceTheme);
	};

	constructor(leaf: WorkspaceLeaf, plugin: ReaderPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_EPUB;
	}

	getDisplayText(): string {
		if (this.file) {
			return this.file.basename;
		}
		return "Epub reader";
	}

	canAcceptExtension(extension: string): boolean {
		return extension.toLowerCase() === EPUB_EXTENSION;
	}

	async onOpen(): Promise<void> {
		this.buildLayout();
		this.renderState(EMPTY_STATE_TEXT);
		await this.updateAppearanceTheme(this.plugin.settings.appearanceTheme);
	}

	async onClose(): Promise<void> {
		await this.cleanupBook();
		this.contentEl.empty();
	}

	async onLoadFile(file: TFile): Promise<void> {
		const savedLocation = this.plugin.settings.reopenAtLastPosition
			? this.plugin.getLastLocation(file.path)
			: undefined;
		await this.openFileWithMode(file, this.plugin.settings.pageDisplayMode, savedLocation);
	}

	async onUnloadFile(): Promise<void> {
		await this.cleanupBook();
		this.renderState(EMPTY_STATE_TEXT);
	}

	async prevPage(): Promise<void> {
		if (!this.rendition) {
			new Notice(NOTICE_EPUB_NOT_OPEN);
			return;
		}

		try {
			await this.rendition.prev();
		} catch (error: unknown) {
			console.error("Failed to go to previous page", error);
			new Notice(NOTICE_EPUB_NAVIGATION_FAILED);
		}
	}

	async nextPage(): Promise<void> {
		if (!this.rendition) {
			new Notice(NOTICE_EPUB_NOT_OPEN);
			return;
		}

		try {
			await this.rendition.next();
		} catch (error: unknown) {
			console.error("Failed to go to next page", error);
			new Notice(NOTICE_EPUB_NAVIGATION_FAILED);
		}
	}

	async updatePageDisplayMode(mode: PageDisplayMode): Promise<void> {
		if (!this.rendition) {
			return;
		}

		try {
			const currentLocation = await Promise.resolve(this.rendition.currentLocation() as unknown);
			const currentCfi = this.extractCurrentCfi(currentLocation);
			const nextConfig = this.getRenditionConfig(mode);
			const currentFlow = this.rendition.settings.flow;
			const shouldRerender = this.isContinuousFlow(currentFlow) !== this.isContinuousFlow(nextConfig.flow);

			if (shouldRerender) {
				if (!this.file) {
					return;
				}
				await this.openFileWithMode(this.file, mode, currentCfi);
				return;
			}

			this.rendition.settings.minSpreadWidth = nextConfig.minSpreadWidth;
			if (this.rendition.settings.flow !== nextConfig.flow) {
				this.rendition.flow(nextConfig.flow);
			}
			this.rendition.spread(nextConfig.spread, nextConfig.minSpreadWidth);

			if (currentCfi) {
				await this.withTimeout(this.rendition.display(currentCfi), 8000, "re-display current location");
			} else {
				await this.withTimeout(this.rendition.display(), 8000, "re-display current location");
			}

			void this.rendition.reportLocation().catch((error: unknown) => {
				console.debug("Failed to report location", error);
			});
		} catch (error: unknown) {
			console.warn("Failed to apply page display mode", error);
		}
	}

	async updateAppearanceTheme(theme: ReaderAppearanceTheme): Promise<void> {
		const resolvedTheme = this.resolveAppearanceTheme(theme);
		const shouldUpdateContents =
			this.currentAppearanceTheme !== theme || this.currentResolvedAppearanceTheme !== resolvedTheme;

		this.currentAppearanceTheme = theme;
		this.currentResolvedAppearanceTheme = resolvedTheme;
		this.applyReaderThemeClass(resolvedTheme);

		if (!this.rendition || !shouldUpdateContents) {
			return;
		}

		try {
			await this.applyAppearanceThemeToRenditionContents();
		} catch (error: unknown) {
			console.warn("Failed to apply appearance theme", error);
		}
	}

	private async openFileWithMode(
		file: TFile,
		mode: PageDisplayMode,
		preferredLocation?: string,
	): Promise<void> {
		this.ensureLayout();
		await this.cleanupBook();
		await this.updateAppearanceTheme(this.plugin.settings.appearanceTheme);
		this.renderState(LOADING_STATE_TEXT);

		try {
			const buffer = await this.app.vault.readBinary(file);
			this.book = ePub();
			await this.withTimeout(this.book.open(buffer, "binary"), 10000, "open epub binary");

			if (!this.readerContainerEl) {
				throw new Error("Reader container is not initialized.");
			}

			const config = this.getRenditionConfig(mode);
			this.readerContainerEl.empty();
			const renditionOptions = {
				width: "100%",
				height: "100%",
				flow: config.flow,
				manager: config.manager,
				spread: config.spread,
				minSpreadWidth: config.minSpreadWidth,
				method: "write",
			};
			this.rendition = this.book.renderTo(
				this.readerContainerEl,
				renditionOptions as Parameters<Book["renderTo"]>[1],
			);
			this.rendition.on("relocated", this.onRelocatedHandler);
			this.rendition.hooks.content.register(this.mediaFitHookHandler);
			this.rendition.hooks.content.register(this.appearanceThemeHookHandler);

			void this.loadToc();

			await this.displayWithFallback(preferredLocation);
			void this.rendition.reportLocation().catch((error: unknown) => {
				console.debug("Failed to report location", error);
			});
		} catch (error: unknown) {
			console.error("Failed to open EPUB", error);
			new Notice(NOTICE_EPUB_OPEN_FAILED);
			this.renderState(ERROR_STATE_TEXT, true);
		}
	}

	private ensureLayout(): void {
		if (this.readerContainerEl && this.tocSelectEl && this.chapterTitleEl) {
			return;
		}
		this.buildLayout();
	}

	private buildLayout(): void {
		this.contentEl.empty();
		this.contentEl.addClass("reader-epub-view");

		this.toolbarEl = this.contentEl.createDiv({ cls: "reader-epub-toolbar" });

		const prevButton = this.toolbarEl.createEl("button", {
			cls: "reader-epub-button",
			text: "Prev",
		});
		this.registerDomEvent(prevButton, "click", () => {
			void this.prevPage();
		});

		const nextButton = this.toolbarEl.createEl("button", {
			cls: "reader-epub-button",
			text: "Next",
		});
		this.registerDomEvent(nextButton, "click", () => {
			void this.nextPage();
		});

		this.tocSelectEl = this.toolbarEl.createEl("select", {
			cls: "reader-epub-toc",
		});
		this.registerDomEvent(this.tocSelectEl, "change", () => {
			void this.jumpToSelectedSection();
		});

		this.chapterTitleEl = this.toolbarEl.createDiv({
			cls: "reader-epub-chapter",
			text: "",
		});

		this.readerContainerEl = this.contentEl.createDiv({
			cls: "reader-epub-container",
		});

		this.populateToc([]);
	}

	private populateToc(items: NavItem[]): void {
		if (!this.tocSelectEl) {
			return;
		}

		this.clearSelect(this.tocSelectEl);
		this.tocLabelByHref.clear();

		const defaultOption = this.tocSelectEl.createEl("option", {
			text: "Table of contents",
			value: "",
		});
		defaultOption.selected = true;

		this.addTocItems(items, 0);
	}

	private addTocItems(items: NavItem[], depth: number): void {
		if (!this.tocSelectEl) {
			return;
		}

		for (const item of items) {
			const labelPrefix = depth > 0 ? `${"  ".repeat(depth)}- ` : "";
			const option = this.tocSelectEl.createEl("option", {
				text: `${labelPrefix}${item.label}`,
				value: item.href,
			});
			option.dataset.hrefKey = this.normalizeHref(item.href);

			this.tocLabelByHref.set(this.normalizeHref(item.href), item.label);

			if (item.subitems && item.subitems.length > 0) {
				this.addTocItems(item.subitems, depth + 1);
			}
		}
	}

	private async jumpToSelectedSection(): Promise<void> {
		if (!this.rendition || !this.tocSelectEl) {
			return;
		}

		const selected = this.tocSelectEl.value;
		if (!selected) {
			return;
		}

		try {
			await this.rendition.display(selected);
		} catch (error: unknown) {
			console.error("Failed to jump by TOC", error);
			new Notice(NOTICE_EPUB_NAVIGATION_FAILED);
		}
	}

	private async displayWithFallback(savedLocation?: string): Promise<void> {
		if (!this.rendition) {
			throw new Error("Rendition is not initialized.");
		}

		if (savedLocation) {
			try {
				await this.withTimeout(this.rendition.display(savedLocation), 8000, "display saved location");
				return;
			} catch (error: unknown) {
				console.warn("Failed to restore saved location, falling back to start", error);
			}
		}

		await this.withTimeout(this.rendition.display(), 8000, "display start");
	}

	private async loadToc(): Promise<void> {
		if (!this.book) {
			this.populateToc([]);
			return;
		}

		const targetBook = this.book;
		try {
			const navigation = await this.withTimeout(targetBook.loaded.navigation, 8000, "load toc");
			if (this.book !== targetBook) {
				return;
			}
			this.populateToc(navigation?.toc ?? []);
		} catch (error: unknown) {
			console.warn("Failed to load table of contents", error);
			if (this.book === targetBook) {
				this.populateToc([]);
			}
		}
	}

	private updateCurrentSection(href: string): void {
		const normalizedHref = this.normalizeHref(href);
		const title = this.tocLabelByHref.get(normalizedHref) ?? href;
		if (this.chapterTitleEl) {
			this.chapterTitleEl.setText(title);
		}
		this.selectTocByHref(normalizedHref);
	}

	private selectTocByHref(normalizedHref: string): void {
		if (!this.tocSelectEl) {
			return;
		}

		const options = Array.from(this.tocSelectEl.options);
		const exact = options.find((option) => option.dataset.hrefKey === normalizedHref);
		if (exact) {
			exact.selected = true;
			return;
		}

		const partial = options.find((option) => {
			const hrefKey = option.dataset.hrefKey;
			if (!hrefKey) {
				return false;
			}
			return normalizedHref.startsWith(hrefKey) || hrefKey.startsWith(normalizedHref);
		});

		if (partial) {
			partial.selected = true;
		}
	}

	private renderState(message: string, isError = false): void {
		if (!this.readerContainerEl) {
			return;
		}
		this.readerContainerEl.empty();

		const stateEl = this.readerContainerEl.createDiv({ cls: "reader-epub-state" });
		if (isError) {
			stateEl.addClass("is-error");
		}
		stateEl.setText(message);

		if (this.chapterTitleEl) {
			this.chapterTitleEl.setText("");
		}
		if (this.tocSelectEl) {
			this.tocSelectEl.value = "";
		}
	}

	private clearSelect(selectEl: HTMLSelectElement): void {
		while (selectEl.firstChild) {
			selectEl.removeChild(selectEl.firstChild);
		}
	}

	private normalizeHref(href: string): string {
		const hashIndex = href.indexOf("#");
		const withoutHash = hashIndex >= 0 ? href.slice(0, hashIndex) : href;
		try {
			return decodeURIComponent(withoutHash).trim();
		} catch {
			return withoutHash.trim();
		}
	}

	private resolveAppearanceTheme(theme: ReaderAppearanceTheme): ResolvedReaderAppearanceTheme {
		if (theme !== "auto") {
			return theme;
		}
		return document.body.classList.contains("theme-dark") ? "dark" : "light";
	}

	private applyReaderThemeClass(theme: ResolvedReaderAppearanceTheme): void {
		this.contentEl.removeClasses(READER_THEME_CLASS_NAMES);
		this.contentEl.addClass(`reader-theme-${theme}`);
	}

	private async applyAppearanceThemeToRenditionContents(): Promise<void> {
		if (!this.rendition) {
			return;
		}
		const contentsList = this.getRenditionContents(this.rendition);
		const applyTasks = contentsList.map((contents) =>
			this.applyAppearanceThemeToContents(contents, this.currentResolvedAppearanceTheme),
		);
		await Promise.allSettled(applyTasks);
	}

	private getRenditionContents(rendition: Rendition): Contents[] {
		const contents = rendition.getContents() as unknown;
		if (Array.isArray(contents)) {
			return contents as Contents[];
		}
		if (contents) {
			return [contents as Contents];
		}
		return [];
	}

	private async applyAppearanceThemeToContents(
		contents: Contents,
		theme: ResolvedReaderAppearanceTheme,
	): Promise<void> {
		await contents.addStylesheetRules(this.getAppearanceContentRules(theme), APPEARANCE_THEME_RULE_KEY);
	}

	private getAppearanceContentRules(theme: ResolvedReaderAppearanceTheme): ContentStylesheetRules {
		if (theme === "dark") {
			return {
				"html, body": {
					"background-color": "#111318 !important",
					color: "#e8e6de !important",
				},
				"p, li, div, span, h1, h2, h3, h4, h5, h6": {
					"background-color": "transparent !important",
					color: "#e8e6de !important",
				},
				"a, a:link, a:hover, a:active": {
					color: "#7cc7ff !important",
				},
				"a:visited": {
					color: "#c6a6ff !important",
				},
				"a *, a:link *, a:hover *, a:active *": {
					color: "#7cc7ff !important",
				},
				"a:visited *": {
					color: "#c6a6ff !important",
				},
			};
		}

		if (theme === "sepia") {
			return {
				"html, body": {
					"background-color": "#f1e7d0 !important",
					color: "#5a4636 !important",
				},
				"p, li, div, span, h1, h2, h3, h4, h5, h6": {
					"background-color": "transparent !important",
					color: "#5a4636 !important",
				},
			};
		}

		return {
			"html, body": {
				"background-color": "transparent !important",
				color: "inherit !important",
			},
		};
	}

	private getRenditionConfig(mode: PageDisplayMode): DisplayModeRenditionConfig {
		if (mode === "spread-always") {
			return {
				flow: "paginated",
				manager: "default",
				spread: "always",
				minSpreadWidth: ALWAYS_MIN_SPREAD_WIDTH,
			};
		}
		if (mode === "spread-none") {
			return {
				flow: "paginated",
				manager: "default",
				spread: "none",
				minSpreadWidth: AUTO_MIN_SPREAD_WIDTH,
			};
		}
		if (mode === "scroll-continuous") {
			return {
				flow: "scrolled-continuous",
				manager: "continuous",
				spread: "none",
				minSpreadWidth: ALWAYS_MIN_SPREAD_WIDTH,
			};
		}

		return {
			flow: "paginated",
			manager: "default",
			spread: "auto",
			minSpreadWidth: AUTO_MIN_SPREAD_WIDTH,
		};
	}

	private isContinuousFlow(flow: string | undefined): boolean {
		return flow === "scrolled" || flow === "scrolled-doc" || flow === "scrolled-continuous";
	}

	private extractCurrentCfi(location: unknown): string | undefined {
		if (!location || typeof location !== "object") {
			return undefined;
		}

		const withStart = location as { start?: { cfi?: unknown } };
		if (typeof withStart.start?.cfi === "string") {
			return withStart.start.cfi;
		}

		const withCfi = location as { cfi?: unknown };
		if (typeof withCfi.cfi === "string") {
			return withCfi.cfi;
		}

		return undefined;
	}

	private isPrePaginatedLayout(): boolean {
		return this.book?.packaging?.metadata?.layout === "pre-paginated";
	}

	private async withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
		let timeoutId: number | undefined;
		const timeoutPromise = new Promise<never>((_, reject) => {
			timeoutId = window.setTimeout(() => {
				reject(new Error(`Timeout while attempting to ${label}`));
			}, ms);
		});

		try {
			return await Promise.race([promise, timeoutPromise]);
		} finally {
			if (timeoutId !== undefined) {
				window.clearTimeout(timeoutId);
			}
		}
	}

	private async cleanupBook(): Promise<void> {
		if (this.rendition) {
			try {
				this.rendition.off("relocated", this.onRelocatedHandler);
			} catch (error: unknown) {
				console.debug("Failed to detach relocated handler", error);
			}
			try {
				this.rendition.hooks.content.deregister(this.mediaFitHookHandler);
			} catch (error: unknown) {
				console.debug("Failed to detach media fit hook handler", error);
			}
			try {
				this.rendition.hooks.content.deregister(this.appearanceThemeHookHandler);
			} catch (error: unknown) {
				console.debug("Failed to detach appearance theme hook handler", error);
			}
			try {
				this.rendition.destroy();
			} catch (error: unknown) {
				console.debug("Failed to destroy rendition", error);
			}
			this.rendition = null;
		}

		if (this.book) {
			try {
				this.book.destroy();
			} catch (error: unknown) {
				console.debug("Failed to destroy book", error);
			}
			this.book = null;
		}

		this.tocLabelByHref.clear();
	}
}
