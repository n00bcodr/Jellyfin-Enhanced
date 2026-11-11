export interface CalendarEvent {
 id: string; releaseDate: string; title: string; type: string; releaseType: string; source: string;
 subtitle?: string | undefined; instanceName?: string | undefined; alsoInInstances?: string[] | undefined;
 itemId?: string | undefined; itemEpisodeId?: string | undefined; imdbId?: string | undefined; episodeImdbId?: string | undefined;
 tvdbId?: number | undefined; tmdbId?: number | undefined; episodeTvdbId?: number | undefined; shokoEpisodeId?: number | undefined; shokoSeriesId?: number | undefined;
 seasonNumber?: number | undefined; episodeNumber?: number | undefined; monitored?: boolean | undefined; hasFile?: boolean | undefined;
 posterUrl?: string | undefined; backdropUrl?: string | undefined; finaleType?: string | undefined;
 groupKey?: string | undefined; groupExpanded?: boolean | undefined; groupMembers?: CalendarEvent[] | undefined;
}
export interface InstanceError { source?: string | undefined; instanceName?: string | undefined; reason?: string | undefined }
export interface UrlMapping { jellyfinUrl: string; arrUrl: string }
export interface CalendarSettings {
 firstDayOfWeek: string; timeFormat: string; highlightFavorites: boolean; highlightWatchedSeries: boolean;
 showUnmonitored: boolean; showOnlyRequested: boolean; forceOnlyRequested: boolean;
 collapseEpisodes?: boolean; displayMode?: string; filterByLibraryAccess?: boolean;
}
export interface CalendarState {
 events: CalendarEvent[]; isLoading: boolean; pageVisible: boolean; previousPage: HTMLElement | null;
 currentDate: Date; viewMode: string; rangeStart: Date | null; rangeEnd: Date | null; sidebarCollapsed: boolean | null;
 settings: CalendarSettings; userDataMap: Map<string, {isFavorite: boolean; isWatched: boolean}>;
 activeFilters: Set<string>; expandedGroups: Set<string>; filterMatchMode: string; filterInvert: boolean;
 requestedItems: Set<string>; requestedLoaded: boolean; requestedLoading: boolean;
 locationSignature: string | null; locationUnsubscribe: (() => void) | null; _customTabContainer: HTMLElement | null;
 filtersRestored?: boolean; error?: string | null; requestError?: string | null;
}
export interface CalendarInternal {
 state: CalendarState;
 STATUS_COLORS: {CinemaRelease: string; DigitalRelease: string; PhysicalRelease: string; Episode: string; Anime: string};
 saveFilters(): void; setStoredCollapse(value: boolean): void; setStoredShowUnmonitored(value: boolean): void; loadSettings(): void;
 fetchCalendarEvents(start: Date, end: Date): Promise<unknown>; fetchUserData(): Promise<void>; ensureRequestData(): Promise<void>;
 filterEvents(events: CalendarEvent[]): CalendarEvent[]; groupEventsByDate(events: CalendarEvent[]): Record<string, CalendarEvent[]>;
 searchFromProviders(event: CalendarEvent, options?: {preferSeries?: boolean}): Promise<string | null>;
 getRangeForView(date: Date, mode: string): {start: Date; end: Date}; getDaysInMonth(date: Date): number; getFirstDayOfMonth(date: Date): number;
 isTodayDate(date: Date): boolean; formatRangeLabel(): string; formatHourLabel(hour: number): string; locale(): string | undefined;
 renderEvent(event: CalendarEvent): string; renderAgendaEvent(event: CalendarEvent): string; renderCardItems(events: CalendarEvent[]): string;
 collapseEpisodes(events: CalendarEvent[]): CalendarEvent[]; eventHasTime(event: CalendarEvent): boolean; compareEventsWithinDay(a: CalendarEvent,b: CalendarEvent): number;
 updateDisplayModeButtons(): void; toggleSidebarCollapsed(): void; renderPage(target?: HTMLElement): void; syncPageModeClasses(): void; createPageContainer(): HTMLElement;
 loadAllData(): Promise<void>; setViewMode(mode: string): void; setDisplayMode(mode: string): void; shiftPeriod(direction: string): void;
 goToday(): void; toggleFilter(type: string): void; toggleShowUnmonitored(): void; toggleCollapseEpisodes(): void; handleEventClick(event: Event): void; injectStyles(): void;
}
export interface CalendarFacade extends Pick<CalendarInternal,'setViewMode'|'shiftPeriod'|'goToday'|'toggleFilter'|'toggleShowUnmonitored'|'toggleCollapseEpisodes'|'renderPage'|'injectStyles'|'loadSettings'|'handleEventClick'|'setDisplayMode'> {
 initialize(): void; showPage(): void; hidePage(): void; refresh(): Promise<void>; renderForCustomTab(target?: HTMLElement): void;
}
