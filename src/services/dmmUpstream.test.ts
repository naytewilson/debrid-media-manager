import { describe, expect, it, vi } from 'vitest';
import { fetchDmmUpstreamMovie } from './dmmUpstream';

describe('DMM upstream corpus fallback', () => {
	it('uses the challenge for movie and availability reads', async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
			const url = String(input);
			calls.push({ url, init });
			if (url.endsWith('/api/challenge')) {
				return {
					ok: true,
					status: 200,
					json: async () => ({ token: 'tok', hash: 'sig' }),
				} as Response;
			}
			if (url.includes('/api/torrents/movie')) {
				const page = new URL(url).searchParams.get('page');
				return {
					ok: true,
					status: 200,
					json: async () => ({
						results:
							page === '0'
								? [
										{
											title: 'Example.2026.2160p.REMUX',
											fileSize: 65536,
											hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
										},
									]
								: [],
					}),
				} as Response;
			}
			if (url.endsWith('/api/availability/check')) {
				const payload = JSON.parse(String(init?.body));
				expect(payload).toMatchObject({
					dmmProblemKey: 'tok',
					solution: 'sig',
					imdbId: 'tt0111161',
				});
				return {
					ok: true,
					status: 200,
					json: async () => ({
						available: [
							{
								hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
								files: [],
							},
						],
					}),
				} as Response;
			}
			throw new Error(`unexpected URL ${url}`);
		});

		const result = await fetchDmmUpstreamMovie('tt0111161', fetchMock as typeof fetch);
		expect(result?.candidates).toHaveLength(1);
		expect(result?.cachedHashes.has('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(true);
		expect(calls.some((call) => call.url.includes('dmmProblemKey=tok'))).toBe(true);
	});
});
