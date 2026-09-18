import { describe, expect, it } from 'vitest';
import { rankPlexCandidates, scorePlexCandidate } from './plexOnDemand';

const candidate = (title: string, fileSizeGiB: number, hash: string) => ({
	title,
	fileSize: fileSizeGiB * 1024 ** 3,
	hash,
});

describe('plex on-demand release ranking', () => {
	it('rejects obvious non-release playback sources', () => {
		expect(
			scorePlexCandidate(
				candidate('Movie.2026.2160p.HDCAM.x265', 8, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
			)
		).toBeNull();
	});

	it('quality profile prefers a 4K remux over a smaller 1080p web release', () => {
		const ranked = rankPlexCandidates([
			candidate(
				'Movie.2026.1080p.WEB-DL.DDP5.1.x265',
				9,
				'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
			),
			candidate(
				'Movie.2026.2160p.UHD.BluRay.REMUX.DV.HDR.TrueHD.Atmos.x265',
				68,
				'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
			),
		]);

		expect(ranked[0].hash).toBe('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
		expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
	});

	it('compatibility profile penalizes Dolby Vision and AV1', () => {
		const ranked = rankPlexCandidates(
			[
				candidate(
					'Movie.2026.2160p.WEB-DL.DV.AV1',
					18,
					'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
				),
				candidate(
					'Movie.2026.2160p.WEB-DL.HDR10.x265',
					18,
					'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
				),
			],
			'compatibility'
		);

		expect(ranked[0].hash).toBe('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
	});

	it('ranking is deterministic when quality is otherwise tied', () => {
		const ranked = rankPlexCandidates([
			candidate(
				'Movie.2026.2160p.WEB-DL.HDR.x265',
				20,
				'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
			),
			candidate(
				'Movie.2026.2160p.WEB-DL.HDR.x265',
				20,
				'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
			),
		]);

		expect(ranked.map((item) => item.hash)).toEqual([
			'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
		]);
	});
});
