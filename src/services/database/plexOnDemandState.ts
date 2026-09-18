import { Prisma } from '@prisma/client';
import { DatabaseClient } from './client';

export type PlexRequestStatus = 'seen' | 'resolving' | 'ready' | 'retry' | 'unsupported';

export type PlexRequestState = {
	ratingKey: string;
	title: string;
	imdbId?: string;
	status: PlexRequestStatus;
	attempts: number;
	updatedAt: string;
	nextAttemptAt?: string;
	lastError?: string;
	resolvedHash?: string;
};

export type PlexWatchlistState = {
	version: 1;
	initializedAt: string;
	items: Record<string, PlexRequestState>;
};

const PREFIX = 'plex-on-demand:watchlist:';

function stateKey(accountId: string): string {
	if (!/^[a-zA-Z0-9._-]{1,64}$/.test(accountId)) {
		throw new Error('invalid Plex on-demand account id');
	}
	return `${PREFIX}${accountId}`;
}

export class PlexOnDemandStateService extends DatabaseClient {
	async get(accountId: string): Promise<PlexWatchlistState | null> {
		const row = await this.prisma.cache.findUnique({
			where: { key: stateKey(accountId) },
			select: { value: true },
		});
		if (!row) return null;

		const value = row.value as unknown as PlexWatchlistState;
		if (!value || value.version !== 1 || typeof value.items !== 'object') return null;
		return value;
	}

	async put(accountId: string, state: PlexWatchlistState): Promise<void> {
		const value = state as unknown as Prisma.InputJsonValue;
		await this.prisma.cache.upsert({
			where: { key: stateKey(accountId) },
			update: { value },
			create: { key: stateKey(accountId), value },
		});
	}
}

export const plexOnDemandState = new PlexOnDemandStateService();
