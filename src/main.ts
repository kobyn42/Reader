import { Plugin, TAbstractFile, TFile } from "obsidian";
import {
	EPUB_EXTENSION,
	VIEW_TYPE_EPUB,
} from "./constants";
import { registerReaderCommands } from "./commands/register-commands";
import { DEFAULT_SETTINGS, ReaderSettingTab } from "./settings";
import type { PageDisplayMode, ReaderAppearanceTheme, ReaderPluginSettings } from "./types";
import { EpubReaderView } from "./views/epub-view";

export default class ReaderPlugin extends Plugin {
	settings: ReaderPluginSettings;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.registerView(VIEW_TYPE_EPUB, (leaf) => new EpubReaderView(leaf, this));
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
				if (this.settings.appearanceTheme !== "auto") {
					return;
				}
				void this.applyAppearanceThemeToOpenViews("auto");
			}),
		);
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
