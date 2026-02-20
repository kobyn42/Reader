export type ReaderLocationMap = Record<string, string>;
export type PageDisplayMode = "spread-auto" | "spread-always" | "spread-none";

export interface ReaderPluginSettings {
	reopenAtLastPosition: boolean;
	pageDisplayMode: PageDisplayMode;
	lastLocations: ReaderLocationMap;
}
