# Plex On-Demand Resolver V1

This branch adds a private server-side DMM capability for the media-fabric stack.

## Contract

`POST /api/local/plex/resolve`

Authorization:

`Authorization: Bearer <PLEX_ON_DEMAND_SECRET>`

Body:

```json
{
  "imdbId": "tt0111161",
  "profile": "quality"
}
```

Profiles are `quality`, `balanced`, and `compatibility`.

The endpoint:

1. reads DMM's existing scraped release corpus for the IMDb title;
2. uses Debridio as DMM already does when the title needs a first-fill or cache-marker refresh;
3. restricts candidates to releases DMM currently knows are cached on Real-Debrid;
4. deterministically ranks the releases;
5. attempts at most five candidates;
6. adds the candidate to the configured Real-Debrid account;
7. selects playable files;
8. requires the torrent to reach `downloaded` quickly;
9. removes a failed/non-instant candidate before trying the next one.

No Real-Debrid token is accepted from the request body and no token is returned.

## Required environment

```text
PLEX_ON_DEMAND_SECRET=<long random secret>
PLEX_ON_DEMAND_RD_TOKEN=<server-side Real-Debrid API token>
PLEX_ON_DEMAND_PROFILE=quality
```

The endpoint should remain private to the media stack. The intended caller is the local media-fabric/Plex request bridge, not a public browser client.

## Boundary

This endpoint resolves media. It does not own Plex refreshes, media-fabric sync, Zurg lifecycle, or catalog authority. Those remain in the media-fabric side of the stack.
