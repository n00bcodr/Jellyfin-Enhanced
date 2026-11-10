import {object, string, number, optionalString, optionalNumber, optionalBoolean, array} from '../shared/wire';
export function readItem(value: unknown) {
 const v = object(value), tags = v.ImageTags == null ? {} : object(v.ImageTags);
 return {Id: string(v.Id), Name: string(v.Name), SeriesName: optionalString(v.SeriesName), SeriesId: optionalString(v.SeriesId),
 SeasonNumber: optionalNumber(v.SeasonNumber), EpisodeNumber: optionalNumber(v.EpisodeNumber), RunTimeTicks: optionalNumber(v.RunTimeTicks),
 HasThumbImage: optionalBoolean(v.HasThumbImage), HasPrimaryImage: optionalBoolean(v.HasPrimaryImage), SeriesHasThumbImage: optionalBoolean(v.SeriesHasThumbImage), SeriesHasPrimaryImage: optionalBoolean(v.SeriesHasPrimaryImage),
 ImageTags: {Thumb: optionalString(tags.Thumb), Primary: optionalString(tags.Primary)}, ParentThumbImageTag: optionalString(v.ParentThumbImageTag), ParentThumbItemId: optionalString(v.ParentThumbItemId), SeriesPrimaryImageTag: optionalString(v.SeriesPrimaryImageTag)};
}
export function readEntry(value: unknown) {const v=object(value); return {ActivityType: string(v.ActivityType), UserId: string(v.UserId), UserName: string(v.UserName), UserHasPrimaryImage: optionalBoolean(v.UserHasPrimaryImage), Timestamp: number(v.Timestamp), Item: readItem(v.Item), Rating: optionalNumber(v.Rating), Content: optionalString(v.Content), Completed: optionalBoolean(v.Completed), Progress: optionalNumber(v.Progress)};}
export function readFeed(value: unknown) {return array(object(value).items, readEntry);}
export function readSessions(value: unknown) {return array(value, object).filter(v => v.NowPlayingItem != null).map(v => {const ps = v.PlayState == null ? {} : object(v.PlayState); return {UserId: string(v.UserId), UserName: string(v.UserName), UserHasPrimaryImage: optionalBoolean(v.UserHasPrimaryImage), NowPlayingItem: readItem(v.NowPlayingItem), PlayState: {IsPaused: optionalBoolean(ps.IsPaused), PositionTicks: optionalNumber(ps.PositionTicks)}};});}
export type ActivityItem = ReturnType<typeof readItem>;
export type Entry = ReturnType<typeof readEntry>;
export type Stream = ReturnType<typeof readSessions>[number];
