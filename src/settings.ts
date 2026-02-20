import { App, PluginSettingTab, Setting } from "obsidian";
import type ReaderPlugin from "./main";
import type { PageDisplayMode, ReaderPluginSettings } from "./types";

export const DEFAULT_SETTINGS: ReaderPluginSettings = {
	reopenAtLastPosition: true,
	pageDisplayMode: "spread-auto",
	lastLocations: {},
};

export class ReaderSettingTab extends PluginSettingTab {
	private plugin: ReaderPlugin;

	constructor(app: App, plugin: ReaderPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Reopen at last position")
			.setDesc("Restore the previous reading position when reopening an epub file.")
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.reopenAtLastPosition)
					.onChange(async (value) => {
						this.plugin.settings.reopenAtLastPosition = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Page display mode")
			.setDesc("Choose automatic spread, always two pages, or always a single page.")
			.addDropdown((dropdown) => {
				dropdown
					.addOption("spread-auto", "Spread (auto)")
					.addOption("spread-always", "Two pages")
					.addOption("spread-none", "Single page")
					.setValue(this.plugin.settings.pageDisplayMode)
					.onChange(async (value) => {
						this.plugin.settings.pageDisplayMode = value as PageDisplayMode;
						await this.plugin.saveSettings();
						await this.plugin.applyPageDisplayModeToOpenViews();
					});
			});
	}
}
