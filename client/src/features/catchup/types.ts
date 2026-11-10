import type { RequestOptions } from '../activity/public-api';
export interface Item {Id: string; Name: string; Type?: string | undefined; SeriesId?: string | undefined; SeriesPrimaryImageTag?: string | undefined;
 ImageTags?: {Primary?: string | undefined} | undefined; Genres?: string[] | undefined; Overview?: string | undefined;
 ChildCount?: number | undefined; RunTimeTicks?: number | undefined; ProductionYear?: number | undefined; CommunityRating?: number | undefined;
 IndexNumber?: number | undefined; UserData?: {UnplayedItemCount?: number | undefined} | undefined;}
export type Direction = 'left' | 'right' | 'up';
export type Gesture = Direction | 'down';
export interface Options {seasons: string[] | null; numbers: string[]}
export interface Undo {item: Item; dir: Direction; opts?: Options | null | undefined}
export interface State {mode: 'Movie' | 'Series'; queue: Item[]; seen: Set<string>; undoStack: Undo[]; dismissed: Set<string>; loading: boolean; pickerOpen: boolean}
export interface Image {id: string; tag: string}
export interface CatchRuntime {
 LOG: string; state: State;
 tt(key: string, fallback: string, params?: Record<string, string | number>): string;
 h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string | null): HTMLElementTagNameMap[K];
 icon(name: string): HTMLElement;
 userId(): string; jf(path: string, options?: RequestOptions): Promise<unknown>;
 imageOf(item: Item): Image | null; imageUrl(image: Image | null, width: number): string; navigateToItem(id: string): void;
 loadDismissed(): void; saveDismissed(): void; isHidden(item: Item): boolean; refill(): Promise<number>;
 ACTIONS: Record<Direction, {name: string; run(item: Item, options?: Options | null): Promise<unknown>; undo(item: Item, options?: Options | null): Promise<unknown>}>;
 ACT_NAME: Record<Gesture, string>; logEvent(event: unknown): void; logSwipe(item: Item, dir: Gesture, options: Options | null | undefined, ok: boolean): void;
 injectStyles?: () => void; deck?: {mount(root: HTMLElement, main: HTMLElement): {start(): Promise<void>; headActions: HTMLElement}; start(): Promise<void>; dispose(): void};
 activity?: {mount(root: HTMLElement, head: HTMLElement): Promise<void>; dispose(): void};
 reset(): void; lease(): () => boolean;
}
