import { App, PluginSettingTab, Setting } from "obsidian";
import type ReaderPlugin from "./main";
import type { ReaderPluginSettings } from "./types";

export const DEFAULT_SETTINGS: ReaderPluginSettings = {
	reopenAtLastPosition: true,
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
	}
}
