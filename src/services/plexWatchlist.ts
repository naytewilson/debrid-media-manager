export type PlexWatchlistItem = {
	ratingKey: string;
	title: string;
	type: string;
	watchlistedAt: number;
	imdbId?: string;
};

type PlexGuid = { id?: string };
type PlexMetadata = {
	ratingKey?: string;
	title?: string;
	type?: string;
	watchlistedAt?: number;
	Guid?: PlexGuid[];
};

type PlexWatchlistResponse = {
	MediaContainer?: {
		totalSize?: number;
		size?: number;
		Metadata?: PlexMetadata[];
	};
};

const WATCHLIST_URL = 'https://metadata.provider.plex.tv/library/sections/watchlist/all';
const PAGE_SIZE = 200;

export function imdbIdFromPlexGuids(guids: PlexGuid[] | undefined): string | undefined {
	for (const guid of guids ?? []) {
		const match = guid.id?.match(/^imdb:\/\/(tt\d{5,12})$/i);
		if (match) return match[1].toLowerCase();
	}
	return undefined;
}

function normalizeItem(item: PlexMetadata): PlexWatchlistItem | null {
	if (!item.ratingKey || !item.title || !item.type) return null;
	return {
		ratingKey: item.ratingKey,
		title: item.title,
		type: item.type,
		watchlistedAt: Number(item.watchlistedAt ?? 0),
		imdbId: imdbIdFromPlexGuids(item.Guid),
	};
}

export async function fetchPlexWatchlist(
	plexToken: string,
	fetchImpl: typeof fetch = fetch
): Promise<PlexWatchlistItem[]> {
	if (!plexToken) throw new Error('missing Plex token');

	const items: PlexWatchlistItem[] = [];
	let start = 0;
	let total = 1;

	while (start < total) {
		const url = new URL(WATCHLIST_URL);
		url.searchParams.set('X-Plex-Container-Size', String(PAGE_SIZE));
		url.searchParams.set('X-Plex-Container-Start', String(start));

		const response = await fetchImpl(url, {
			headers: {
				Accept: 'application/json',
				'X-Plex-Token': plexToken,
				'X-Plex-Product': 'DMM Plex On-Demand',
			},
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) {
			throw new Error(`Plex watchlist request failed: HTTP ${response.status}`);
		}

		const payload = (await response.json()) as PlexWatchlistResponse;
		const container = payload.MediaContainer;
		const page = container?.Metadata ?? [];
		for (const raw of page) {
			const item = normalizeItem(raw);
			if (item) items.push(item);
		}

		total = Number(container?.totalSize ?? page.length);
		const reportedSize = Number(container?.size ?? page.length);
		const advanced = reportedSize > 0 ? reportedSize : page.length;
		if (advanced <= 0) break;
		start += advanced;
	}

	return items.sort((a, b) => b.watchlistedAt - a.watchlistedAt);
}

export async function removeFromPlexWatchlist(
	plexToken: string,
	ratingKey: string,
	fetchImpl: typeof fetch = fetch
): Promise<void> {
	const url = new URL('https://metadata.provider.plex.tv/actions/removeFromWatchlist');
	url.searchParams.set('ratingKey', ratingKey);
	const response = await fetchImpl(url, {
		method: 'PUT',
		headers: {
			'X-Plex-Token': plexToken,
			'X-Plex-Product': 'DMM Plex On-Demand',
		},
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) {
		throw new Error(`Plex watchlist remove failed: HTTP ${response.status}`);
	}
}
