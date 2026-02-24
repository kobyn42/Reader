import ePub, { Book, Contents, NavItem, Rendition } from "epubjs";
import { FileView, Notice, Platform, TFile, WorkspaceLeaf } from "obsidian";
import {
	EPUB_EXTENSION,
	NOTICE_EPUB_NAVIGATION_FAILED,
	NOTICE_EPUB_NOT_OPEN,
	NOTICE_EPUB_OPEN_FAILED,
	VIEW_TYPE_EPUB,
} from "../constants";
import type ReaderPlugin from "../main";
import type {
	PageDisplayMode,
	ReaderAppearanceTheme,
	ReaderToolbarState,
	ReaderToolbarTocItem,
	ResolvedReaderAppearanceTheme,
} from "../types";
import { FootnotePopoverController } from "./footnote-popover-controller";

interface RelocatedEventPayload {
	start?: {
		cfi?: string;
		href?: string;
		index?: number;
	};
}

interface DisplayModeRenditionConfig {
	flow: "paginated" | "scrolled-continuous";
	manager: "default" | "continuous";
	spread: "auto" | "always" | "none";
	minSpreadWidth: number;
}

interface SpineSectionLike {
	linear?: boolean;
	next?: () => SpineSectionLike | undefined;
	prev?: () => SpineSectionLike | undefined;
}

interface SpineLike {
	spineItems?: SpineSectionLike[];
}

type PrefetchRequestMethod = (...args: unknown[]) => Promise<unknown>;

interface PrefetchSectionLike {
	index?: number;
	href?: string;
	next?: () => PrefetchSectionLike | undefined;
	prev?: () => PrefetchSectionLike | undefined;
	load?: (request?: PrefetchRequestMethod) => Promise<unknown>;
}

interface PendingTapNavigationGesture {
	touchIdentifier: number;
	startX: number;
	startY: number;
	startedAt: number;
	target: EventTarget | null;
}

const EMPTY_STATE_TEXT = "Select an EPUB file to start reading.";
const ERROR_STATE_TEXT = "Unable to render this EPUB file.";
const LOADING_STATE_TEXT = "Loading EPUB...";
const MEDIA_FIT_RULE_KEY = "reader-media-fit";
const APPEARANCE_THEME_RULE_KEY = "reader-appearance-theme";
const SCROLL_ANCHORING_RULE_PROPERTY = "overflow-anchor";
const AUTO_MIN_SPREAD_WIDTH = 800;
const ALWAYS_MIN_SPREAD_WIDTH = 0;
const TAP_NAVIGATION_LEFT_ZONE_MAX_RATIO = 0.4;
const TAP_NAVIGATION_RIGHT_ZONE_MIN_RATIO = 0.6;
const TAP_NAVIGATION_MAX_DURATION_MS = 350;
const TAP_NAVIGATION_MAX_MOVE_PX = 10;
const READER_THEME_CLASS_NAMES = ["reader-theme-light", "reader-theme-dark", "reader-theme-sepia"];
const MONOSPACE_WRAP_CSS = `
pre, pre code {
	white-space: pre-wrap !important;
	overflow-wrap: anywhere !important;
	word-break: break-word !important;
	max-width: 100% !important;
	box-sizing: border-box !important;
}
code, kbd, samp, tt {
	overflow-wrap: anywhere !important;
	word-break: break-word !important;
}
`;

export class EpubReaderView extends FileView {
	private plugin: ReaderPlugin;
	private book: Book | null = null;
	private rendition: Rendition | null = null;
	private keyboardBoundDocuments = new WeakSet<Document>();
	private tapNavigationBoundDocuments = new WeakSet<Document>();
	private tapNavigationPendingGestures = new WeakMap<Document, PendingTapNavigationGesture>();
	private footnotePopoverController: FootnotePopoverController | null = null;

	private toolbarEl: HTMLElement | null = null;
	private mobileToolbarToggleButtonEl: HTMLButtonElement | null = null;
	private readerContainerEl: HTMLElement | null = null;
	private tocSelectEl: HTMLSelectElement | null = null;
	private chapterTitleEl: HTMLElement | null = null;
	private isMobileToolbarCollapsed = true;
	private currentAppearanceTheme: ReaderAppearanceTheme = "auto";
	private currentResolvedAppearanceTheme: ResolvedReaderAppearanceTheme = "light";

	private tocLabelByHref = new Map<string, string>();
	private toolbarTocItems: ReaderToolbarTocItem[] = [];
	private toolbarChapterTitle = "";
	private toolbarSelectedHrefKey: string | null = null;
	private toolbarStateListeners = new Set<(state: ReaderToolbarState) => void>();
	private prefetchedSectionIndexes = new Set<number>();
	private prefetchInFlightIndexes = new Set<number>();
	private lastPrefetchAnchorIndex: number | null = null;
	private prefetchSessionId = 0;

	private onRelocatedHandler = (location: RelocatedEventPayload): void => {
		this.applyScrollAnchoringWorkaroundToStageContainer();

		const href = location.start?.href;
		if (href) {
			this.updateCurrentSection(href);
		}

		const cfi = location.start?.cfi;
		if (cfi && this.file) {
			void this.plugin.setLastLocation(this.file.path, cfi);
		}

		this.prefetchAdjacentSections(location);
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

	private keyboardNavigationHookHandler = async (contents: Contents): Promise<void> => {
		const targetDocument = contents.document;
		if (this.keyboardBoundDocuments.has(targetDocument)) {
			return;
		}
		targetDocument.addEventListener("keydown", this.handleArrowNavigationKeydown);
		this.keyboardBoundDocuments.add(targetDocument);
	};

	private tapNavigationHookHandler = async (contents: Contents): Promise<void> => {
		const targetDocument = contents.document;
		if (this.tapNavigationBoundDocuments.has(targetDocument)) {
			return;
		}
		targetDocument.addEventListener("touchstart", this.handleTapNavigationTouchStart);
		targetDocument.addEventListener("touchmove", this.handleTapNavigationTouchMove);
		targetDocument.addEventListener("touchend", this.handleTapNavigationTouchEnd);
		targetDocument.addEventListener("touchcancel", this.handleTapNavigationTouchCancel);
		this.tapNavigationBoundDocuments.add(targetDocument);
	};

	private footnotePopoverHookHandler = async (contents: Contents): Promise<void> => {
		if (!this.footnotePopoverController) {
			return;
		}
		await this.footnotePopoverController.bindContents(contents);
	};

	private scrollAnchoringWorkaroundHookHandler = async (contents: Contents): Promise<void> => {
		const targetDocument = contents.document;
		this.setCssProps(targetDocument.documentElement, {
			[SCROLL_ANCHORING_RULE_PROPERTY]: "none !important",
		});
		this.setCssProps(targetDocument.body, {
			[SCROLL_ANCHORING_RULE_PROPERTY]: "none !important",
		});
		const embeddedContainers = Array.from(targetDocument.querySelectorAll<HTMLElement>(".epub-container"));
		for (const element of embeddedContainers) {
			this.setCssProps(element, {
				[SCROLL_ANCHORING_RULE_PROPERTY]: "none !important",
			});
		}
		if (targetDocument.scrollingElement instanceof HTMLElement) {
			this.setCssProps(targetDocument.scrollingElement, {
				[SCROLL_ANCHORING_RULE_PROPERTY]: "none !important",
			});
		}
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
		this.registerDomEvent(window, "keydown", this.handleArrowNavigationKeydown);
		this.renderState(EMPTY_STATE_TEXT);
		await this.updateAppearanceTheme(this.plugin.settings.appearanceTheme);
	}

	async onClose(): Promise<void> {
		await this.cleanupBook();
		this.toolbarStateListeners.clear();
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

	getToolbarState(): ReaderToolbarState {
		return {
			canNavigate: this.rendition !== null,
			chapterTitle: this.toolbarChapterTitle,
			selectedHrefKey: this.toolbarSelectedHrefKey,
			tocItems: this.toolbarTocItems.map((item) => ({ ...item })),
		};
	}

	onToolbarStateChange(listener: (state: ReaderToolbarState) => void): () => void {
		this.toolbarStateListeners.add(listener);
		listener(this.getToolbarState());

		return () => {
			this.toolbarStateListeners.delete(listener);
		};
	}

	async jumpToSection(href: string): Promise<void> {
		if (!this.rendition || !href) {
			return;
		}

		try {
			await this.rendition.display(href);
		} catch (error: unknown) {
			console.error("Failed to jump by TOC", error);
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

		if (this.footnotePopoverController) {
			try {
				await this.footnotePopoverController.updateTheme(resolvedTheme);
			} catch (error: unknown) {
				console.warn("Failed to update footnote popover theme", error);
			}
		}

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
			if (mode === "scroll-continuous") {
				this.patchNonLinearSpineNavigationForContinuousMode();
			}

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
			this.footnotePopoverController = new FootnotePopoverController(this.currentResolvedAppearanceTheme);
			this.rendition.on("relocated", this.onRelocatedHandler);
			this.rendition.hooks.content.register(this.mediaFitHookHandler);
			this.rendition.hooks.content.register(this.appearanceThemeHookHandler);
			this.rendition.hooks.content.register(this.keyboardNavigationHookHandler);
			this.rendition.hooks.content.register(this.tapNavigationHookHandler);
			this.rendition.hooks.content.register(this.footnotePopoverHookHandler);
			this.rendition.hooks.content.register(this.scrollAnchoringWorkaroundHookHandler);
			this.applyScrollAnchoringWorkaroundToStageContainer();

			void this.loadToc();

			await this.displayWithFallback(preferredLocation);
			this.applyScrollAnchoringWorkaroundToStageContainer();
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
		if (this.readerContainerEl) {
			return;
		}
		this.buildLayout();
	}

	private buildLayout(): void {
		this.contentEl.empty();
		this.contentEl.addClass("reader-epub-view");
		const shouldShowTopToolbar = Platform.isMobile;
		if (shouldShowTopToolbar) {
			this.mobileToolbarToggleButtonEl = this.contentEl.createEl("button", {
				cls: "reader-mobile-toolbar-toggle",
				text: "",
			});
			this.registerDomEvent(this.mobileToolbarToggleButtonEl, "click", () => {
				this.isMobileToolbarCollapsed = !this.isMobileToolbarCollapsed;
				this.updateMobileToolbarCollapsedState();
			});

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
			this.updateMobileToolbarCollapsedState();
		} else {
			this.mobileToolbarToggleButtonEl = null;
			this.toolbarEl = null;
			this.tocSelectEl = null;
			this.chapterTitleEl = null;
		}

		this.readerContainerEl = this.contentEl.createDiv({
			cls: "reader-epub-container",
		});

		this.syncToolbarDom();
	}

	private populateToc(items: NavItem[]): void {
		this.tocLabelByHref.clear();
		this.toolbarTocItems = this.flattenTocItems(items, 0);
		if (this.toolbarSelectedHrefKey && !this.hasMatchingTocItem(this.toolbarSelectedHrefKey)) {
			this.toolbarSelectedHrefKey = null;
		}
		this.syncToolbarDom();
		this.notifyToolbarStateChange();
	}

	private flattenTocItems(items: NavItem[], depth: number): ReaderToolbarTocItem[] {
		const flattenedItems: ReaderToolbarTocItem[] = [];
		for (const item of items) {
			const labelPrefix = depth > 0 ? `${"  ".repeat(depth)}- ` : "";
			const hrefKey = this.normalizeHref(item.href);
			flattenedItems.push({
				label: `${labelPrefix}${item.label}`,
				value: item.href,
				hrefKey,
			});
			this.tocLabelByHref.set(hrefKey, item.label);

			if (item.subitems && item.subitems.length > 0) {
				flattenedItems.push(...this.flattenTocItems(item.subitems, depth + 1));
			}
		}

		return flattenedItems;
	}

	private hasMatchingTocItem(hrefKey: string): boolean {
		return this.toolbarTocItems.some((item) => item.hrefKey === hrefKey);
	}

	private async jumpToSelectedSection(): Promise<void> {
		if (!this.tocSelectEl) {
			return;
		}

		const selected = this.tocSelectEl.value;
		if (!selected) {
			return;
		}

		this.toolbarSelectedHrefKey = this.normalizeHref(selected);
		this.syncToolbarDom();
		this.notifyToolbarStateChange();
		await this.jumpToSection(selected);
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

	private handleArrowNavigationKeydown = (event: KeyboardEvent): void => {
		if (event.defaultPrevented || event.isComposing) {
			return;
		}
		if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
			return;
		}
		if (!this.isActiveReaderView()) {
			return;
		}
		if (!this.rendition) {
			return;
		}
		if (this.isEditableEventTarget(event.target)) {
			return;
		}

		if (event.key === "ArrowLeft") {
			event.preventDefault();
			void this.prevPage();
			return;
		}
		if (event.key === "ArrowRight") {
			event.preventDefault();
			void this.nextPage();
		}
	};

	private handleTapNavigationTouchStart = (event: TouchEvent): void => {
		const targetDocument = this.extractDocumentFromEvent(event);
		if (!targetDocument) {
			return;
		}
		if (!this.shouldHandleTapNavigationEvent(event, targetDocument)) {
			this.tapNavigationPendingGestures.delete(targetDocument);
			return;
		}
		if (event.touches.length !== 1) {
			this.tapNavigationPendingGestures.delete(targetDocument);
			return;
		}

		const touch = event.touches[0];
		if (!touch) {
			this.tapNavigationPendingGestures.delete(targetDocument);
			return;
		}
		this.tapNavigationPendingGestures.set(targetDocument, {
			touchIdentifier: touch.identifier,
			startX: touch.clientX,
			startY: touch.clientY,
			startedAt: Date.now(),
			target: event.target,
		});
	};

	private handleTapNavigationTouchMove = (event: TouchEvent): void => {
		const targetDocument = this.extractDocumentFromEvent(event);
		if (!targetDocument) {
			return;
		}

		const pending = this.tapNavigationPendingGestures.get(targetDocument);
		if (!pending) {
			return;
		}
		if (event.touches.length !== 1) {
			this.tapNavigationPendingGestures.delete(targetDocument);
			return;
		}

		const touch = this.findTouchByIdentifier(event.touches, pending.touchIdentifier);
		if (!touch) {
			this.tapNavigationPendingGestures.delete(targetDocument);
			return;
		}

		const moveX = Math.abs(touch.clientX - pending.startX);
		const moveY = Math.abs(touch.clientY - pending.startY);
		if (moveX > TAP_NAVIGATION_MAX_MOVE_PX || moveY > TAP_NAVIGATION_MAX_MOVE_PX) {
			this.tapNavigationPendingGestures.delete(targetDocument);
		}
	};

	private handleTapNavigationTouchEnd = (event: TouchEvent): void => {
		const targetDocument = this.extractDocumentFromEvent(event);
		if (!targetDocument) {
			return;
		}

		const pending = this.tapNavigationPendingGestures.get(targetDocument);
		this.tapNavigationPendingGestures.delete(targetDocument);
		if (!pending) {
			return;
		}
		if (!this.shouldHandleTapNavigationEvent(event, targetDocument)) {
			return;
		}
		if (event.touches.length > 0) {
			return;
		}

		const endedTouch = this.findTouchByIdentifier(event.changedTouches, pending.touchIdentifier);
		if (!endedTouch) {
			return;
		}

		const elapsedMs = Date.now() - pending.startedAt;
		if (elapsedMs > TAP_NAVIGATION_MAX_DURATION_MS) {
			return;
		}

		const moveX = Math.abs(endedTouch.clientX - pending.startX);
		const moveY = Math.abs(endedTouch.clientY - pending.startY);
		if (moveX > TAP_NAVIGATION_MAX_MOVE_PX || moveY > TAP_NAVIGATION_MAX_MOVE_PX) {
			return;
		}
		if (this.hasTextSelection(targetDocument)) {
			return;
		}
		if (this.isTapNavigationIgnoredTarget(pending.target) || this.isTapNavigationIgnoredTarget(event.target)) {
			return;
		}

		const viewportWidth = this.getDocumentViewportWidth(targetDocument);
		if (!viewportWidth) {
			return;
		}

		const positionRatio = endedTouch.clientX / viewportWidth;
		if (positionRatio <= TAP_NAVIGATION_LEFT_ZONE_MAX_RATIO) {
			void this.prevPage();
			return;
		}
		if (positionRatio >= TAP_NAVIGATION_RIGHT_ZONE_MIN_RATIO) {
			void this.nextPage();
		}
	};

	private handleTapNavigationTouchCancel = (event: TouchEvent): void => {
		const targetDocument = this.extractDocumentFromEvent(event);
		if (!targetDocument) {
			return;
		}
		this.tapNavigationPendingGestures.delete(targetDocument);
	};

	private isActiveReaderView(): boolean {
		return this.app.workspace.getActiveViewOfType(EpubReaderView) === this;
	}

	private isEditableEventTarget(target: EventTarget | null): boolean {
		const maybeNode = target as { nodeType?: number; parentElement?: Element | null } | null;
		if (!maybeNode) {
			return false;
		}

		const eventElement = maybeNode.nodeType === 1 ? (target as Element) : maybeNode.parentElement;
		if (!eventElement) {
			return false;
		}

		return eventElement.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']") !== null;
	}

	private shouldHandleTapNavigationEvent(event: TouchEvent, targetDocument: Document): boolean {
		if (event.defaultPrevented) {
			return false;
		}
		if (!this.rendition) {
			return false;
		}
		if (!this.isActiveReaderView()) {
			return false;
		}
		if (this.plugin.settings.pageDisplayMode === "scroll-continuous") {
			return false;
		}
		if (!targetDocument.defaultView) {
			return false;
		}
		return true;
	}

	private extractDocumentFromEvent(event: Event): Document | null {
		return event.currentTarget instanceof Document ? event.currentTarget : null;
	}

	private findTouchByIdentifier(touches: TouchList, identifier: number): Touch | null {
		for (let index = 0; index < touches.length; index += 1) {
			const touch = touches.item(index);
			if (touch?.identifier === identifier) {
				return touch;
			}
		}
		return null;
	}

	private hasTextSelection(targetDocument: Document): boolean {
		const selectedText = targetDocument.getSelection()?.toString().trim() ?? "";
		return selectedText.length > 0;
	}

	private isTapNavigationIgnoredTarget(target: EventTarget | null): boolean {
		const maybeNode = target as { nodeType?: number; parentElement?: Element | null } | null;
		if (!maybeNode) {
			return false;
		}

		const eventElement = maybeNode.nodeType === 1 ? (target as Element) : maybeNode.parentElement;
		if (!eventElement) {
			return false;
		}

		return (
			eventElement.closest(
				"a, button, input, textarea, select, option, label, summary, [role='button'], [contenteditable=''], [contenteditable='true']",
			) !== null
		);
	}

	private getDocumentViewportWidth(targetDocument: Document): number | null {
		const documentWidth = targetDocument.documentElement.clientWidth;
		if (documentWidth > 0) {
			return documentWidth;
		}

		const bodyWidth = targetDocument.body?.clientWidth ?? 0;
		if (bodyWidth > 0) {
			return bodyWidth;
		}

		const viewportWidth = targetDocument.defaultView?.innerWidth ?? 0;
		return viewportWidth > 0 ? viewportWidth : null;
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
		this.toolbarChapterTitle = title;
		this.toolbarSelectedHrefKey = this.findBestMatchingHrefKey(normalizedHref);
		this.syncToolbarDom();
		this.notifyToolbarStateChange();
	}

	private prefetchAdjacentSections(location: RelocatedEventPayload): void {
		if (!this.book || !this.rendition) {
			return;
		}
		if (this.plugin.settings.pageDisplayMode !== "scroll-continuous") {
			return;
		}

		const currentSection = this.resolveCurrentSectionForPrefetch(location);
		if (!currentSection) {
			return;
		}

		const anchorIndex = this.resolvePrefetchAnchorIndex(currentSection, location);
		if (anchorIndex === undefined || this.lastPrefetchAnchorIndex === anchorIndex) {
			return;
		}
		this.lastPrefetchAnchorIndex = anchorIndex;

		const prevSection = currentSection.prev?.();
		if (prevSection) {
			this.queueSectionPrefetch(prevSection);
		}

		const nextSection = currentSection.next?.();
		if (nextSection) {
			this.queueSectionPrefetch(nextSection);
		}
	}

	private resolveCurrentSectionForPrefetch(location: RelocatedEventPayload): PrefetchSectionLike | null {
		if (!this.book) {
			return null;
		}

		const sectionIndex = location.start?.index;
		if (typeof sectionIndex === "number") {
			return (this.book.spine.get(sectionIndex) as unknown as PrefetchSectionLike | null) ?? null;
		}

		const sectionHref = location.start?.href;
		if (!sectionHref) {
			return null;
		}
		return (this.book.spine.get(sectionHref) as unknown as PrefetchSectionLike | null) ?? null;
	}

	private resolvePrefetchAnchorIndex(
		section: PrefetchSectionLike,
		location: RelocatedEventPayload,
	): number | undefined {
		if (typeof section.index === "number") {
			return section.index;
		}
		if (typeof location.start?.index === "number") {
			return location.start.index;
		}
		return undefined;
	}

	private queueSectionPrefetch(section: PrefetchSectionLike): void {
		if (!this.book || typeof section.index !== "number") {
			return;
		}
		if (typeof section.load !== "function") {
			return;
		}

		const sectionIndex = section.index;
		if (this.prefetchedSectionIndexes.has(sectionIndex) || this.prefetchInFlightIndexes.has(sectionIndex)) {
			return;
		}

		const activeSessionId = this.prefetchSessionId;
		const requestMethod = this.book.request as PrefetchRequestMethod;
		this.prefetchInFlightIndexes.add(sectionIndex);

		void Promise.resolve(section.load(requestMethod))
			.then(() => {
				if (activeSessionId !== this.prefetchSessionId) {
					return;
				}
				this.prefetchedSectionIndexes.add(sectionIndex);
			})
			.catch((error: unknown) => {
				if (activeSessionId !== this.prefetchSessionId) {
					return;
				}
				console.debug("Failed to prefetch adjacent section", error);
			})
			.finally(() => {
				if (activeSessionId !== this.prefetchSessionId) {
					return;
				}
				this.prefetchInFlightIndexes.delete(sectionIndex);
			});
	}

	private findBestMatchingHrefKey(normalizedHref: string): string | null {
		const exact = this.toolbarTocItems.find((item) => item.hrefKey === normalizedHref);
		if (exact) {
			return exact.hrefKey;
		}

		const partial = this.toolbarTocItems.find(
			(item) => normalizedHref.startsWith(item.hrefKey) || item.hrefKey.startsWith(normalizedHref),
		);
		return partial?.hrefKey ?? null;
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

		this.toolbarChapterTitle = "";
		this.toolbarSelectedHrefKey = null;
		this.syncToolbarDom();
		this.notifyToolbarStateChange();
	}

	private clearSelect(selectEl: HTMLSelectElement): void {
		while (selectEl.firstChild) {
			selectEl.removeChild(selectEl.firstChild);
		}
	}

	private syncToolbarDom(): void {
		if (this.chapterTitleEl) {
			this.chapterTitleEl.setText(this.toolbarChapterTitle);
		}
		if (!this.tocSelectEl) {
			return;
		}

		this.clearSelect(this.tocSelectEl);
		const defaultOption = this.tocSelectEl.createEl("option", {
			text: "Table of contents",
			value: "",
		});
		defaultOption.selected = true;

		for (const item of this.toolbarTocItems) {
			const option = this.tocSelectEl.createEl("option", {
				text: item.label,
				value: item.value,
			});
			option.dataset.hrefKey = item.hrefKey;
		}

		const selectedTocItem = this.toolbarSelectedHrefKey
			? this.toolbarTocItems.find((item) => item.hrefKey === this.toolbarSelectedHrefKey)
			: null;
		if (selectedTocItem) {
			this.tocSelectEl.value = selectedTocItem.value;
		} else {
			this.tocSelectEl.value = "";
		}
	}

	private updateMobileToolbarCollapsedState(): void {
		if (!Platform.isMobile) {
			return;
		}
		if (this.toolbarEl) {
			this.toolbarEl.toggleClass("is-collapsed", this.isMobileToolbarCollapsed);
		}
		if (this.mobileToolbarToggleButtonEl) {
			this.mobileToolbarToggleButtonEl.setText(this.isMobileToolbarCollapsed ? "Show controls" : "Hide controls");
		}
	}

	private notifyToolbarStateChange(): void {
		const state = this.getToolbarState();
		for (const listener of this.toolbarStateListeners) {
			listener(state);
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
		await contents.addStylesheetCss(this.getAppearanceContentCss(theme), APPEARANCE_THEME_RULE_KEY);
	}

	private getAppearanceContentCss(theme: ResolvedReaderAppearanceTheme): string {
		if (theme === "dark") {
			return `
html, body {
	background-color: #111318 !important;
	color: #e8e6de !important;
}
p, li, div, span, h1, h2, h3, h4, h5, h6 {
	background-color: transparent !important;
	color: #e8e6de !important;
}
a, a:link, a:hover, a:active {
	color: #7cc7ff !important;
}
a:visited {
	color: #c6a6ff !important;
}
a *, a:link *, a:hover *, a:active * {
	color: #7cc7ff !important;
}
a:visited * {
	color: #c6a6ff !important;
}
${MONOSPACE_WRAP_CSS}`;
		}

		if (theme === "sepia") {
			return `
html, body {
	background-color: #f1e7d0 !important;
	color: #5a4636 !important;
}
p, li, div, span, h1, h2, h3, h4, h5, h6 {
	background-color: transparent !important;
	color: #5a4636 !important;
}
${MONOSPACE_WRAP_CSS}`;
		}

		return `
html, body {
	background-color: transparent !important;
	color: inherit !important;
}
${MONOSPACE_WRAP_CSS}`;
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

	private patchNonLinearSpineNavigationForContinuousMode(): void {
		if (!this.book) {
			return;
		}

		const spine = this.book.spine as unknown as SpineLike;
		const sections = spine.spineItems;
		if (!Array.isArray(sections) || sections.length === 0) {
			return;
		}

		const findNextLinearSection = (startIndex: number): SpineSectionLike | undefined => {
			for (let nextIndex = startIndex + 1; nextIndex < sections.length; nextIndex += 1) {
				const candidate = sections[nextIndex];
				if (candidate?.linear === true) {
					return candidate;
				}
			}
			return undefined;
		};

		const findPrevLinearSection = (startIndex: number): SpineSectionLike | undefined => {
			for (let prevIndex = startIndex - 1; prevIndex >= 0; prevIndex -= 1) {
				const candidate = sections[prevIndex];
				if (candidate?.linear === true) {
					return candidate;
				}
			}
			return undefined;
		};

		for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex += 1) {
			const section = sections[sectionIndex];
			if (!section || section.linear !== false) {
				continue;
			}

			section.next = () => findNextLinearSection(sectionIndex);
			section.prev = () => findPrevLinearSection(sectionIndex);
		}
	}

	private applyScrollAnchoringWorkaroundToStageContainer(): void {
		const container = this.getRenditionManagerContainer();
		if (!container) {
			return;
		}

		this.setCssProps(container, {
			[SCROLL_ANCHORING_RULE_PROPERTY]: "none !important",
		});
	}

	private removeScrollAnchoringWorkaroundFromStageContainer(): void {
		const container = this.getRenditionManagerContainer();
		if (!container) {
			return;
		}

		container.style.removeProperty(SCROLL_ANCHORING_RULE_PROPERTY);
	}

	private getRenditionManagerContainer(): HTMLElement | null {
		const renditionLike = this.rendition as unknown as {
			manager?: { container?: unknown };
		} | null;
		const container = renditionLike?.manager?.container;
		return container instanceof HTMLElement ? container : null;
	}

	private setCssProps(element: HTMLElement, props: Record<string, string>): void {
		const maybeSetCssProps = (element as HTMLElement & { setCssProps?: (nextProps: Record<string, string>) => void })
			.setCssProps;
		if (typeof maybeSetCssProps === "function") {
			maybeSetCssProps.call(element, props);
			return;
		}

		for (const [key, value] of Object.entries(props)) {
			element.style.setProperty(key, value);
		}
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
		this.prefetchSessionId += 1;
		this.prefetchedSectionIndexes.clear();
		this.prefetchInFlightIndexes.clear();
		this.lastPrefetchAnchorIndex = null;

		const footnoteController = this.footnotePopoverController;
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
				this.rendition.hooks.content.deregister(this.keyboardNavigationHookHandler);
			} catch (error: unknown) {
				console.debug("Failed to detach keyboard navigation hook handler", error);
			}
			try {
				this.rendition.hooks.content.deregister(this.tapNavigationHookHandler);
			} catch (error: unknown) {
				console.debug("Failed to detach tap navigation hook handler", error);
			}
			try {
				this.rendition.hooks.content.deregister(this.footnotePopoverHookHandler);
			} catch (error: unknown) {
				console.debug("Failed to detach footnote popover hook handler", error);
			}
			try {
				this.rendition.hooks.content.deregister(this.scrollAnchoringWorkaroundHookHandler);
			} catch (error: unknown) {
				console.debug("Failed to detach scroll anchoring workaround hook handler", error);
			}
			const contentsList = this.getRenditionContents(this.rendition);
			for (const contents of contentsList) {
				try {
					contents.document.removeEventListener("keydown", this.handleArrowNavigationKeydown);
				} catch (error: unknown) {
					console.debug("Failed to detach keyboard navigation listener", error);
				}
				try {
					contents.document.removeEventListener("touchstart", this.handleTapNavigationTouchStart);
					contents.document.removeEventListener("touchmove", this.handleTapNavigationTouchMove);
					contents.document.removeEventListener("touchend", this.handleTapNavigationTouchEnd);
					contents.document.removeEventListener("touchcancel", this.handleTapNavigationTouchCancel);
				} catch (error: unknown) {
					console.debug("Failed to detach tap navigation listeners", error);
				}
				if (footnoteController) {
					try {
						footnoteController.unbindContents(contents);
					} catch (error: unknown) {
						console.debug("Failed to detach footnote popover listeners", error);
					}
				}
			}
			this.removeScrollAnchoringWorkaroundFromStageContainer();
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

		if (footnoteController) {
			try {
				footnoteController.destroy();
			} catch (error: unknown) {
				console.debug("Failed to destroy footnote popover controller", error);
			}
		}
		this.footnotePopoverController = null;

		this.tocLabelByHref.clear();
		this.toolbarTocItems = [];
		this.toolbarChapterTitle = "";
		this.toolbarSelectedHrefKey = null;
		this.keyboardBoundDocuments = new WeakSet<Document>();
		this.tapNavigationBoundDocuments = new WeakSet<Document>();
		this.tapNavigationPendingGestures = new WeakMap<Document, PendingTapNavigationGesture>();
		this.syncToolbarDom();
		this.notifyToolbarStateChange();
	}
}
