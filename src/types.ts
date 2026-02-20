export type ReaderLocationMap = Record<string, string>;

export interface ReaderPluginSettings {
	reopenAtLastPosition: boolean;
	lastLocations: ReaderLocationMap;
}
