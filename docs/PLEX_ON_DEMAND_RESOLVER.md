# Plex On-Demand Resolver V1

This branch turns the DMM fork into the private resolution brain for the existing Plex + Real-Debrid + Zurg + media-fabric stack.

## Data path

```text
Plex Watchlist
    -> private DMM poll
    -> DMM release corpus + Debridio cache truth
    -> deterministic quality ranking
    -> Real-Debrid add + feature-file selection
    -> Zurg library-update event
    -> media-fabric sync
    -> scoped Plex refresh
    -> normal Plex playback
```

DMM owns Plex cloud auth and Real-Debrid credentials. media-fabric only needs the narrow local bearer capability used to trigger a poll.

## Private endpoints

### `POST /api/local/plex/poll`

Polls the Plex Watchlist once and resolves at most one due movie request. State is persisted in DMM's existing `Cache` table, so restarts do not reset the queue.

The first poll defaults to `baseline`: existing watchlist movies are recorded but not imported. Set `PLEX_ON_DEMAND_BOOTSTRAP=latest` for rollout to resolve only the newest existing movie, or `all` to admit the entire existing movie watchlist gradually.

Removing an item from Plex removes its durable request state on the next poll. Re-adding it is therefore an intentional fresh request.

### `POST /api/local/plex/resolve`

Manual/private discriminator for one movie:

```json
{
  "imdbId": "tt0111161",
  "profile": "quality"
}
```

Both endpoints require:

```text
Authorization: Bearer <PLEX_ON_DEMAND_SECRET>
```

## Release policy

Profiles: `quality`, `balanced`, `compatibility`.

The resolver:

1. reads the complete trusted DMM release row plus current scrape candidates;
2. first-fills/refreshes through DMM's existing Debridio integration where configured;
3. admits only hashes DMM currently records as Real-Debrid cached;
4. rejects obvious CAM/telesync/screener sources;
5. scores resolution, source, HDR/DV, audio, codec and DMM-native MiB size;
6. attempts at most five ranked candidates;
7. selects the largest playable video file rather than blindly selecting extras;
8. requires the RD item to become `downloaded` quickly;
9. deletes a failed/non-instant attempt before trying the next candidate.

## Required environment

```text
PLEX_ON_DEMAND_SECRET=<long random secret>
PLEX_ON_DEMAND_PLEX_TOKEN=<server-side Plex token>
PLEX_ON_DEMAND_RD_TOKEN=<server-side Real-Debrid API token>
PLEX_ON_DEMAND_ACCOUNT_ID=default
PLEX_ON_DEMAND_PROFILE=quality
PLEX_ON_DEMAND_BOOTSTRAP=baseline
PLEX_ON_DEMAND_AUTO_REMOVE=false
```

The Plex token is sent to Plex in `X-Plex-Token`, not a query string. The RD token is never accepted from a request body and neither credential is returned by these endpoints.

## Boundary

DMM resolves and admits media. It does not own media-fabric catalog truth or Plex filesystem publication. Zurg's existing library-update hook remains the event that synchronizes media-fabric and performs the scoped Plex refresh.
