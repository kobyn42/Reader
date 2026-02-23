import { Platform, Plugin, TAbstractFile, TFile, WorkspaceLeaf } from "obsidian";
import {
	EPUB_EXTENSION,
	VIEW_TYPE_EPUB,
	VIEW_TYPE_EPUB_TOOLBAR,
} from "./constants";
import { registerReaderCommands } from "./commands/register-commands";
import { DEFAULT_SETTINGS, ReaderSettingTab } from "./settings";
import type { PageDisplayMode, ReaderAppearanceTheme, ReaderPluginSettings } from "./types";
import { EpubReaderView } from "./views/epub-view";
import { EpubToolbarSideView } from "./views/epub-toolbar-side-view";

export default class ReaderPlugin extends Plugin {
	settings: ReaderPluginSettings;
	private isAutoAppearanceThemeSyncQueued = false;
	private isToolbarSyncQueued = false;
	private lastFocusedReaderLeaf: WorkspaceLeaf | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.registerView(VIEW_TYPE_EPUB, (leaf) => new EpubReaderView(leaf, this));
		this.registerView(VIEW_TYPE_EPUB_TOOLBAR, (leaf) => new EpubToolbarSideView(leaf, this));
		this.registerExtensions([EPUB_EXTENSION], VIEW_TYPE_EPUB);

		registerReaderCommands(this);
		this.addSettingTab(new ReaderSettingTab(this.app, this));

		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				void this.handleFileDelete(file);
			}),
		);

		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				void this.handleFileRename(file, oldPath);
			}),
		);

		this.registerEvent(
			this.app.workspace.on("css-change", () => {
				this.queueAutoAppearanceThemeSync();
			}),
		);

		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				this.handleActiveLeafChange(leaf);
			}),
		);

		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				this.queueToolbarSideViewSync();
			}),
		);

		this.app.workspace.onLayoutReady(() => {
			this.queueToolbarSideViewSync();
		});

		const darkSchemeMediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
		const onSystemColorSchemeChange = (): void => {
			this.queueAutoAppearanceThemeSync();
		};
		darkSchemeMediaQuery.addEventListener("change", onSystemColorSchemeChange);
		this.register(() => {
			darkSchemeMediaQuery.removeEventListener("change", onSystemColorSchemeChange);
		});
	}

	async loadSettings(): Promise<void> {
		const loadedData = (await this.loadData()) as Partial<ReaderPluginSettings> | null;
		this.settings = {
			...DEFAULT_SETTINGS,
			...loadedData,
			lastLocations: {
				...DEFAULT_SETTINGS.lastLocations,
				...(loadedData?.lastLocations ?? {}),
			},
		};
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	getLastLocation(filePath: string): string | undefined {
		return this.settings.lastLocations[filePath];
	}

	async setLastLocation(filePath: string, cfi: string): Promise<void> {
		const currentLocation = this.settings.lastLocations[filePath];
		if (currentLocation === cfi) {
			return;
		}
		this.settings.lastLocations[filePath] = cfi;
		await this.saveSettings();
	}

	async openEpubFile(file: TFile, newLeaf: boolean): Promise<void> {
		const leaf = this.app.workspace.getLeaf(newLeaf);
		await leaf.openFile(file, { active: true });
		if (leaf.view.getViewType() !== VIEW_TYPE_EPUB) {
			await leaf.setViewState({
				type: VIEW_TYPE_EPUB,
				state: { file: file.path },
				active: true,
			});
		}
		await this.app.workspace.revealLeaf(leaf);
		this.lastFocusedReaderLeaf = leaf;
		this.queueToolbarSideViewSync();
	}

	getPreferredReaderView(): EpubReaderView | null {
		const activeView = this.app.workspace.getActiveViewOfType(EpubReaderView);
		if (activeView) {
			return activeView;
		}

		if (this.lastFocusedReaderLeaf?.view instanceof EpubReaderView) {
			const openReaderLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_EPUB);
			if (openReaderLeaves.includes(this.lastFocusedReaderLeaf)) {
				return this.lastFocusedReaderLeaf.view;
			}
		}

		const firstOpenReaderView = this.getOpenReaderViews()[0];
		return firstOpenReaderView ?? null;
	}

	async applyPageDisplayModeToOpenViews(mode?: PageDisplayMode): Promise<void> {
		const targetMode = mode ?? this.settings.pageDisplayMode;
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_EPUB);
		const updateTasks = leaves
			.map((leaf) => (leaf.view instanceof EpubReaderView ? leaf.view : null))
			.filter((view): view is EpubReaderView => view !== null)
			.map((view) => view.updatePageDisplayMode(targetMode));
		await Promise.allSettled(updateTasks);
	}

	async applyAppearanceThemeToOpenViews(theme?: ReaderAppearanceTheme): Promise<void> {
		const targetTheme = theme ?? this.settings.appearanceTheme;
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_EPUB);
		const updateTasks = leaves
			.map((leaf) => (leaf.view instanceof EpubReaderView ? leaf.view : null))
			.filter((view): view is EpubReaderView => view !== null)
			.map((view) => view.updateAppearanceTheme(targetTheme));
		await Promise.allSettled(updateTasks);
	}

	private queueAutoAppearanceThemeSync(): void {
		if (this.settings.appearanceTheme !== "auto" || this.isAutoAppearanceThemeSyncQueued) {
			return;
		}

		this.isAutoAppearanceThemeSyncQueued = true;
		window.requestAnimationFrame(() => {
			this.isAutoAppearanceThemeSyncQueued = false;
			if (this.settings.appearanceTheme !== "auto") {
				return;
			}
			void this.applyAppearanceThemeToOpenViews("auto");
		});
	}

	private handleActiveLeafChange(leaf: WorkspaceLeaf | null): void {
		if (leaf?.view instanceof EpubReaderView) {
			this.lastFocusedReaderLeaf = leaf;
		}
		this.refreshToolbarSideViews();
	}

	private getOpenReaderViews(): EpubReaderView[] {
		return this.app.workspace
			.getLeavesOfType(VIEW_TYPE_EPUB)
			.map((leaf) => (leaf.view instanceof EpubReaderView ? leaf.view : null))
			.filter((view): view is EpubReaderView => view !== null);
	}

	private queueToolbarSideViewSync(): void {
		if (this.isToolbarSyncQueued) {
			return;
		}

		this.isToolbarSyncQueued = true;
		window.requestAnimationFrame(() => {
			this.isToolbarSyncQueued = false;
			void this.syncToolbarSideViewVisibility();
		});
	}

	private async syncToolbarSideViewVisibility(): Promise<void> {
		if (Platform.isMobile) {
			this.app.workspace.detachLeavesOfType(VIEW_TYPE_EPUB_TOOLBAR);
			return;
		}

		const openReaderViews = this.getOpenReaderViews();
		if (openReaderViews.length === 0) {
			this.app.workspace.detachLeavesOfType(VIEW_TYPE_EPUB_TOOLBAR);
			return;
		}

		let sideToolbarLeaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_EPUB_TOOLBAR)[0];
		if (!sideToolbarLeaf) {
			sideToolbarLeaf = this.app.workspace.getRightLeaf(true) ?? undefined;
		}
		if (!sideToolbarLeaf) {
			return;
		}

		if (sideToolbarLeaf.view.getViewType() !== VIEW_TYPE_EPUB_TOOLBAR) {
			await sideToolbarLeaf.setViewState({
				type: VIEW_TYPE_EPUB_TOOLBAR,
				active: false,
			});
		}

		this.refreshToolbarSideViews();
	}

	private refreshToolbarSideViews(): void {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_EPUB_TOOLBAR);
		for (const leaf of leaves) {
			if (!(leaf.view instanceof EpubToolbarSideView)) {
				continue;
			}
			leaf.view.requestRefresh();
		}
	}

	private async handleFileDelete(file: TAbstractFile): Promise<void> {
		if (!this.isEpubFile(file)) {
			return;
		}

		if (!(file.path in this.settings.lastLocations)) {
			return;
		}

		delete this.settings.lastLocations[file.path];
		await this.saveSettings();
	}

	private async handleFileRename(file: TAbstractFile, oldPath: string): Promise<void> {
		if (!(oldPath in this.settings.lastLocations)) {
			return;
		}

		const oldLocation = this.settings.lastLocations[oldPath];
		if (oldLocation === undefined) {
			return;
		}
		delete this.settings.lastLocations[oldPath];

		if (this.isEpubFile(file)) {
			this.settings.lastLocations[file.path] = oldLocation;
		}

		await this.saveSettings();
	}

	private isEpubFile(file: TAbstractFile): file is TFile {
		return file instanceof TFile && file.extension.toLowerCase() === EPUB_EXTENSION;
	}
}
