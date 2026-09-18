import type {
	PlexRequestState,
	PlexWatchlistState,
} from './database/plexOnDemandState';
import type { PlexWatchlistItem } from './plexWatchlist';

export type PlexBootstrapMode = 'baseline' | 'latest' | 'all';

function moviesOnly(items: PlexWatchlistItem[]): PlexWatchlistItem[] {
	return items.filter((item) => item.type === 'movie');
}

export function baselinePlexWatchlistState(
	items: PlexWatchlistItem[],
	mode: PlexBootstrapMode,
	now: string
): PlexWatchlistState {
	const records: Record<string, PlexRequestState> = {};
	const movies = moviesOnly(items);
	const newestRatingKey = mode === 'latest' ? movies[0]?.ratingKey : undefined;

	for (const item of movies) {
		const shouldResolve = mode === 'all' || item.ratingKey === newestRatingKey;
		records[item.ratingKey] = {
			ratingKey: item.ratingKey,
			title: item.title,
			imdbId: item.imdbId,
			status: shouldResolve ? (item.imdbId ? 'retry' : 'unsupported') : 'seen',
			attempts: 0,
			updatedAt: now,
			nextAttemptAt: shouldResolve && item.imdbId ? now : undefined,
		};
	}

	return { version: 1, initializedAt: now, items: records };
}

export function reconcilePlexWatchlistState(
	state: PlexWatchlistState,
	items: PlexWatchlistItem[],
	now: string
): boolean {
	const movies = moviesOnly(items);
	const currentKeys = new Set(movies.map((item) => item.ratingKey));
	let changed = false;

	// Removal is intentional. Forgetting the state means a later re-add becomes
	// a fresh request rather than staying permanently suppressed.
	for (const key of Object.keys(state.items)) {
		if (!currentKeys.has(key)) {
			delete state.items[key];
			changed = true;
		}
	}

	for (const item of movies) {
		const existing = state.items[item.ratingKey];
		if (!existing) {
			state.items[item.ratingKey] = {
				ratingKey: item.ratingKey,
				title: item.title,
				imdbId: item.imdbId,
				status: item.imdbId ? 'retry' : 'unsupported',
				attempts: 0,
				updatedAt: now,
				nextAttemptAt: item.imdbId ? now : undefined,
			};
			changed = true;
			continue;
		}

		// Plex can occasionally omit external GUIDs transiently. Enrich an
		// existing record when the IMDb GUID appears later. A record that was
		// explicitly unsupported becomes due immediately; baseline "seen"
		// records stay seen so first boot never turns into a surprise bulk import.
		if (existing.title !== item.title) {
			existing.title = item.title;
			existing.updatedAt = now;
			changed = true;
		}
		if (!existing.imdbId && item.imdbId) {
			existing.imdbId = item.imdbId;
			existing.updatedAt = now;
			changed = true;
			if (existing.status === 'unsupported') {
				existing.status = 'retry';
				existing.nextAttemptAt = now;
				delete existing.lastError;
			}
		}
	}

	return changed;
}
