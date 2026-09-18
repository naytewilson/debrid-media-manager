import { describe, expect, it, vi } from 'vitest';
import { fetchPlexWatchlist, imdbIdFromPlexGuids } from './plexWatchlist';

describe('Plex watchlist client', () => {
	it('extracts IMDb ids from Plex GUIDs', () => {
		expect(
			imdbIdFromPlexGuids([{ id: 'tmdb://278' }, { id: 'imdb://tt0111161' }])
		).toBe('tt0111161');
	});

	it('keeps the Plex token out of the request URL', async () => {
		const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
			const url = input instanceof URL ? input : new URL(String(input));
			expect(url.searchParams.has('X-Plex-Token')).toBe(false);
			expect((init?.headers as Record<string, string>)['X-Plex-Token']).toBe('secret');
			return {
				ok: true,
				status: 200,
				json: async () => ({
					MediaContainer: {
						totalSize: 1,
						size: 1,
						Metadata: [
							{
								ratingKey: 'plex://movie/abc',
								title: 'Example',
								type: 'movie',
								watchlistedAt: 42,
								Guid: [{ id: 'imdb://tt0111161' }],
							},
						],
					},
				}),
			} as Response;
		});

		const items = await fetchPlexWatchlist('secret', fetchMock as typeof fetch);
		expect(items).toEqual([
			{
				ratingKey: 'plex://movie/abc',
				title: 'Example',
				type: 'movie',
				watchlistedAt: 42,
				imdbId: 'tt0111161',
			},
		]);
	});
});
