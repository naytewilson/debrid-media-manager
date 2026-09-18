import { describe, expect, it } from 'vitest';
import {
	baselinePlexWatchlistState,
	reconcilePlexWatchlistState,
} from './plexOnDemandWatchlist';
import type { PlexWatchlistItem } from './plexWatchlist';

const movie = (
	ratingKey: string,
	imdbId?: string,
	watchlistedAt = 1
): PlexWatchlistItem => ({
	ratingKey,
	title: ratingKey,
	type: 'movie',
	watchlistedAt,
	imdbId,
});

describe('Plex on-demand watchlist state', () => {
	it('baselines existing movies without acquiring them', () => {
		const now = '2026-09-18T00:00:00.000Z';
		const state = baselinePlexWatchlistState([movie('a', 'tt0111161')], 'baseline', now);
		expect(state.items.a).toMatchObject({
			imdbId: 'tt0111161',
			status: 'seen',
			attempts: 0,
		});
		expect(state.items.a.nextAttemptAt).toBeUndefined();
	});

	it('queues a newly added movie immediately when it has an IMDb GUID', () => {
		const now = '2026-09-18T00:00:00.000Z';
		const later = '2026-09-18T00:01:00.000Z';
		const state = baselinePlexWatchlistState([], 'baseline', now);
		reconcilePlexWatchlistState(state, [movie('new', 'tt0111161')], later);
		expect(state.items.new).toMatchObject({
			imdbId: 'tt0111161',
			status: 'retry',
			nextAttemptAt: later,
		});
	});

	it('recovers an unsupported new request when Plex supplies its IMDb GUID later', () => {
		const now = '2026-09-18T00:00:00.000Z';
		const later = '2026-09-18T00:01:00.000Z';
		const state = baselinePlexWatchlistState([], 'baseline', now);
		reconcilePlexWatchlistState(state, [movie('late-guid')], now);
		expect(state.items['late-guid'].status).toBe('unsupported');

		reconcilePlexWatchlistState(state, [movie('late-guid', 'tt0111161')], later);
		expect(state.items['late-guid']).toMatchObject({
			imdbId: 'tt0111161',
			status: 'retry',
			nextAttemptAt: later,
		});
	});

	it('does not accidentally queue a baseline-seen item when its GUID appears later', () => {
		const now = '2026-09-18T00:00:00.000Z';
		const later = '2026-09-18T00:01:00.000Z';
		const state = baselinePlexWatchlistState([movie('existing')], 'baseline', now);
		reconcilePlexWatchlistState(state, [movie('existing', 'tt0111161')], later);
		expect(state.items.existing).toMatchObject({
			imdbId: 'tt0111161',
			status: 'seen',
		});
		expect(state.items.existing.nextAttemptAt).toBeUndefined();
	});


	it('reports an unchanged idle poll so callers can avoid a database write', () => {
		const now = '2026-09-18T00:00:00.000Z';
		const later = '2026-09-18T00:01:00.000Z';
		const state = baselinePlexWatchlistState([movie('existing', 'tt0111161')], 'baseline', now);
		const changed = reconcilePlexWatchlistState(
			state,
			[movie('existing', 'tt0111161')],
			later
		);
		expect(changed).toBe(false);
		expect(state.items.existing.updatedAt).toBe(now);
	});

	it('forgets removed items so a later re-add is a fresh request', () => {
		const now = '2026-09-18T00:00:00.000Z';
		const later = '2026-09-18T00:01:00.000Z';
		const state = baselinePlexWatchlistState([movie('existing', 'tt0111161')], 'baseline', now);
		reconcilePlexWatchlistState(state, [], later);
		expect(state.items.existing).toBeUndefined();

		reconcilePlexWatchlistState(state, [movie('existing', 'tt0111161')], later);
		expect(state.items.existing.status).toBe('retry');
	});
});
