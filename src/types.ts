export type ReaderLocationMap = Record<string, string>;
export type PageDisplayMode = "spread-auto" | "spread-always" | "spread-none" | "scroll-continuous";
export type ReaderAppearanceTheme = "auto" | "light" | "dark" | "sepia";

export interface ReaderPluginSettings {
	reopenAtLastPosition: boolean;
	pageDisplayMode: PageDisplayMode;
	appearanceTheme: ReaderAppearanceTheme;
	lastLocations: ReaderLocationMap;
}
