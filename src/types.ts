export type ReaderLocationMap = Record<string, string>;
export type PageDisplayMode = "spread-auto" | "spread-always" | "spread-none" | "scroll-continuous";
export type ReaderAppearanceTheme = "auto" | "light" | "dark" | "sepia";
export type ResolvedReaderAppearanceTheme = Exclude<ReaderAppearanceTheme, "auto">;

export interface ReaderToolbarTocItem {
	value: string;
	label: string;
	hrefKey: string;
}

export interface ReaderToolbarState {
	canNavigate: boolean;
	chapterTitle: string;
	selectedHrefKey: string | null;
	tocItems: ReaderToolbarTocItem[];
}

export interface ReaderPluginSettings {
	reopenAtLastPosition: boolean;
	pageDisplayMode: PageDisplayMode;
	appearanceTheme: ReaderAppearanceTheme;
	lastLocations: ReaderLocationMap;
}
