# Helm relay

T3 Connect's relay ([`infra/relay`](../relay/README.md)) packaged as a plain Node service for Railway.
It serves the same HTTP API with the same services; only the Cloudflare Worker platform is swapped:

| Worker (upstream)          | Here                                                     |
| -------------------------- | -------------------------------------------------------- |
| PlanetScale via Hyperdrive | Any Postgres (`DATABASE_URL`), migrated on start         |
| Cloudflare Queues          | In-process queues with the same retries; lost on restart |
| Worker cron                | A 5-minute timer in the process                          |
| Scoped Alchemy tokens      | One Cloudflare API token for tunnels and DNS             |
| Axiom tracing              | None                                                     |
| Alchemy-generated secrets  | `node src/generateSecrets.ts`, pasted into Railway once  |

Managed tunnels are still Cloudflare Tunnels, so a free Cloudflare account with a domain is required.
[`src/main.ts`](./src/main.ts) mirrors [`infra/relay/src/worker.ts`](../relay/src/worker.ts); keep the
service graphs in step when merging upstream.

## Deploy on Railway

1. **Cloudflare.** Add a domain (for example `example.com`). Create an API token with
   _Account → Cloudflare Tunnel → Edit_ and _Zone → DNS → Edit_ for that zone. Note the account ID
   and the zone ID from the zone's overview page.
2. **Clerk.** Create an application and follow the [Connect setup runbook](../../docs/operations/connect-setup.md)
   (JWT template, CLI OAuth application, sign-up restrictions). Helm's desktop redirects are
   `helm://app/` and `helm-dev://app/`; its iOS app is team `4KSA86792T`, bundle `com.sketchpiece.helm`.
3. **Apple push.** Create an APNs key (.p8) in the team that signs the iOS app.
4. **Railway.** Create a project from this repository, add a PostgreSQL database, and point the
   service at `infra/helm-relay/railway.json` (Settings → Config-as-code). Generate a public domain.
5. **Variables.** Set these on the service:

   ```dotenv
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   CLERK_SECRET_KEY=sk_live_...
   CLERK_PUBLISHABLE_KEY=pk_live_...
   CLERK_JWT_AUDIENCE=t3-code-relay
   CLOUDFLARE_API_TOKEN=...
   CLOUDFLARE_ACCOUNT_ID=...
   CLOUDFLARE_TUNNEL_ZONE_ID=...
   RELAY_TUNNEL_ZONE_NAME=example.com
   APNS_ENVIRONMENT=production
   APNS_TEAM_ID=4KSA86792T
   APNS_KEY_ID=...
   APNS_BUNDLE_ID=com.sketchpiece.helm
   APNS_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----
   ```

   Then add the output of `node src/generateSecrets.ts` (the mint key pair and job signing secret).
   Generate them once: a new mint key invalidates every token the relay has issued.

   Optional: `RELAY_PUBLIC_ORIGIN` (defaults to Railway's public domain), `RELAY_TUNNEL_NAMESPACE`
   (tunnel hostname prefix, default `helm`), `RELAY_TUNNEL_CLEANUP_MODE`, `FCM_SERVICE_ACCOUNT`, and
   `APNS_ENABLED=false` to run without push.

6. **Clients.** Put the public values in the repository-root `.env` and rebuild Helm and the
   mobile app:

   ```dotenv
   T3CODE_CLERK_PUBLISHABLE_KEY=pk_live_...
   T3CODE_CLERK_JWT_TEMPLATE=t3-relay
   T3CODE_CLERK_CLI_OAUTH_CLIENT_ID=...
   T3CODE_RELAY_URL=https://<railway domain>
   ```

## Run locally

```sh
docker run -d --rm -e POSTGRES_PASSWORD=helm -p 127.0.0.1:55432:5432 postgres:17-alpine
DATABASE_URL=postgres://postgres:helm@127.0.0.1:55432/postgres \
RELAY_PUBLIC_ORIGIN=http://127.0.0.1:8080 APNS_ENABLED=false ... node src/main.ts
```
