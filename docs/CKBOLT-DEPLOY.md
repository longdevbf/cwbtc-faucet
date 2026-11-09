# CKBolt cWBTC Faucet: VPS Deployment

How to run this fork as the **CKBolt cWBTC faucet** on the CKBolt VPS (`vps229`), next to the `ckbolt-testnet`
compose project, and publish it at `https://ckbolt-faucet.texlabs.org` through the owner's Cloudflare Tunnel.

cWBTC is a CKB testnet xUDT used as test wrapped BTC (8 decimals, 1 raw unit = 1 sat). It has no monetary value.
CKBolt testers use it to swap test BTC on Lightning for cWBTC on Fiber, and back
([CKBolt guide](https://ckbolt.texlabs.org/app/guide)).

## 1. What differs from upstream

| Setting | Upstream public faucet | CKBolt faucet | Why |
| --- | --- | --- | --- |
| `CLAIM_AMOUNT_RAW` | `10000000000` (100 cWBTC) | `1000000` (0.01 cWBTC = 1,000,000 sats) | CKBolt swaps are 1,000 to 20,000 sats: one claim covers 50 of the largest swaps |
| `UDT_CELL_CAPACITY_CKB` | 200 CKB (hard-coded) | 147 CKB | The cWBTC cell's occupied size is 146 CKB; +1 CKB margin (section 2) |
| `IP_COOLDOWN_SECONDS` | 3600 | 1800 | Demo testers often share a network |
| `IP_DAILY_CLAIM_LIMIT` | 5 | 3 | Keeps one network from draining the CKB budget |
| `GLOBAL_DAILY_CLAIM_LIMIT` | 200 | 50 | Bounds the daily CKB spend to 50 x 147 = 7,350 CKB |
| `ADDRESS_COOLDOWN_SECONDS`, `ADDRESS_DAILY_CLAIM_LIMIT` | 86400, 1 | unchanged | |
| Image | pulled from `ghcr.io/retricsu/cwbtc-faucet:latest` | built locally as `ckbolt/cwbtc-faucet:local` (`pull_policy: build`) | No third-party image runs with the hot-wallet key |
| Port | `3008` on all interfaces | `127.0.0.1:3008`, plus cloudflared's Docker network through `compose.tunnel.yaml` (section 5) | Only cloudflared reaches it; a public port would let clients forge `X-Forwarded-For` |
| Compose project | directory name | `ckbolt-faucet` (volume `ckbolt-faucet_faucet-data`) | Stable names, no clash with `ckbolt-testnet` |
| Recipient address | standard secp256k1 lock only | standard secp256k1 lock or JoyID (`src/ckb/recipient.ts`); a JoyID cell gets 148 CKB | CKBolt testers mostly use JoyID; its lock args are 2 bytes longer |
| Cooldown messages | "after the IP cooldown", seconds for an address | the time left, e.g. "in 18 min" or "in 23 h 48 min" | Testers could not tell how long to wait |

The token, its type script and the anti-sybil design (pending-claim lock, address and IP cooldowns, daily caps per
address, IP and globally, optional Turnstile) are unchanged. All values above are overridable in `.env`.

## 2. Why each claim costs about 147 CKB

On CKB a token balance lives in a cell owned by the recipient's lock. The faucet cannot add tokens to a cell it does not
own, so every claim creates a new cWBTC cell for the recipient, and a cell must hold at least as many CKB as the bytes it
occupies:

| Part | Bytes |
| --- | --- |
| capacity field | 8 |
| secp256k1 lock: code_hash 32 + hash_type 1 + args 20 | 53 |
| xUDT type: code_hash 32 + hash_type 1 + args 36 (owner lock hash 32 + flags 4) | 69 |
| data: uint128 amount | 16 |
| **total** | **146** |

The often-quoted 142 CKB is an xUDT whose args have no flags field; cWBTC's args carry the 4-byte flags, hence 146.
`src/ckb/capacity.ts` holds the constants and `src/ckb/capacity.test.ts` checks them with CCC's own size calculation.
The faucet refuses to start with `UDT_CELL_CAPACITY_CKB` below 146, and raises the capacity for a recipient lock with
longer args.

Trade-off: **the recipient receives that CKB with the cWBTC.** It is not burned; it is the tester's, locked in the
cWBTC cell until they spend the cell. The 1 CKB margin lets them move the whole cell to another standard address with the
fee taken from the cell. A larger value gives testers more CKB per claim but drains the faucet faster; a channel reserve
still needs CKB from the Nervos faucet, which the CKBolt guide links. The faucet also keeps one cWBTC change cell of its
own (147 CKB) and needs a 61 CKB plain change cell for fees; `/api/balance` subtracts both from
`estimatedClaimsByCapacity`.

## 3. Deploy on the VPS

Prerequisites on the VPS: Docker with Compose v2, `git`, `openssl` (the hub's VPS has them).

```bash
ssh vps229
sudo mkdir -p /opt/ckbolt/faucet && sudo chown "$USER": /opt/ckbolt/faucet
git clone https://github.com/longdevbf/cwbtc-faucet /opt/ckbolt/faucet   # the branch with the CKBolt changes
cd /opt/ckbolt/faucet
```

Without pushing first, copy the working tree from the workstation instead (secrets and `.env` stay behind):

```bash
rsync -a --exclude .git --exclude node_modules --exclude dist --exclude data --exclude .env \
  --exclude 'secrets/*' ./ vps229:/opt/ckbolt/faucet/
```

Then, on the VPS in `/opt/ckbolt/faucet`:

| Step | Command | Check |
| --- | --- | --- |
| 1. Port free | `ss -ltn \| grep -w 3008` | no output (3008 is not among 3000, 5432, 6300, 8228, 8787, 9735, 18787) |
| 2. Hot wallet and secrets | `./scripts/init.sh` | prints `Faucet address: ckt1...` |
| 3. Public URL values | `nano .env` (section 5) | `PUBLIC_BASE_URL` and `CORS_ORIGIN` set |
| 4. Start (still private) | `docker compose up -d --build` | `docker compose ps` shows `healthy` |
| 5. Health | `curl -fsS http://127.0.0.1:3008/health` | `{"ok":true}` |
| 6. Settings | `curl -fsS http://127.0.0.1:3008/api/info` | `"amount_display":"0.01 cWBTC"`, `"cell_capacity_display":"147 CKB"` |
| 7. Fund | section 4 | `curl -fsS http://127.0.0.1:3008/api/balance` shows the cWBTC and capacity |
| 8. Test claim | below | status `confirmed` |
| 9. Go public | section 5 (owner, Cloudflare dashboard) | `curl -fsS https://ckbolt-faucet.texlabs.org/health` |

What `init.sh` does: copies `.env.example` to `.env` (mode 600); builds `ckbolt/cwbtc-faucet:local` from the checkout if
it is missing; generates the hot wallet inside that image with no network (`docker run --network none`); writes the
private key to `secrets/faucet_private_key` and the address to `secrets/faucet_address`; generates `ip_hash_salt` and
`admin_token`; creates an empty `turnstile_secret_key`. `secrets/` is mode 700, the files 644 so the unprivileged `node`
user in the container can read them. It never prints the key and never overwrites existing files. Never put the cWBTC
issuer key in `secrets/`.

Test claim, from the VPS to one of your own testnet addresses, before the hostname exists:

```bash
curl -fsS -X POST -H 'Content-Type: application/json' \
  -d '{"address":"ckt1...your-test-address"}' http://127.0.0.1:3008/api/claims
curl -fsS http://127.0.0.1:3008/api/claims/<id>     # repeat until "status":"confirmed" (about a minute)
```

## 4. Funding: which address, how much

Fund the address `init.sh` printed (also in `secrets/faucet_address` and `/api/balance` `address`).

| Asset | Source | Amount | Covers |
| --- | --- | --- | --- |
| cWBTC | the public faucet https://faucet-cwbtc.ckb.dev, one claim to the hot-wallet address (or a transfer from the cWBTC custodian) | 100 cWBTC | 10,000 claims of 0.01 cWBTC; it arrives in a cell holding 200 CKB, which covers the faucet's own cWBTC change cell |
| CKB | https://faucet.nervos.org (10,000 or 100,000 CKB per claim; 300,000 CKB per address per month) | N x 147 CKB + 61 CKB | N claims |

Examples: 10,000 CKB is about 67 claims; 100,000 CKB is about 680 claims, two weeks even at the 50-claims-per-day cap.
Start with one 100,000 CKB claim. cWBTC will not run out first; CKB will.

Funds arrive in a minute or two. Check:

```bash
curl -fsS http://127.0.0.1:3008/api/balance
# cwbtc_display: "100 cWBTC", estimatedClaimsByCapacity: about 680 after a 100,000 CKB deposit
```

## 5. Cloudflare Tunnel and public URL values (owner, by hand)

On vps229 cloudflared runs in a container (`ckbolt-testnet-cloudflared-1`, compose project `ckbolt-testnet`), where
`127.0.0.1` is the container itself: it cannot reach the faucet's `127.0.0.1:3008` on the host. So the faucet also
joins cloudflared's Docker network through the optional override `compose.tunnel.yaml`, under the alias
`ckbolt-faucet`, and the tunnel points at `http://ckbolt-faucet:3008`. Nothing changes in the `ckbolt-testnet` project,
and the loopback port stays for the host-side commands in this runbook.

1. Find cloudflared's network (the override assumes `ckbolt-testnet_edge`):

   ```bash
   docker inspect ckbolt-testnet-cloudflared-1 \
     --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}'
   ```

   It prints one name per line. Use the project's own network (for example `ckbolt-testnet_edge`), never `host` or
   `bridge`. If it prints `host`, cloudflared shares the host's network and reaches `127.0.0.1:3008` already: skip the
   override and use `http://127.0.0.1:3008` below.
2. Turn the override on for every `docker compose` command in `/opt/ckbolt/faucet` by adding to `.env`:

   ```env
   COMPOSE_FILE=compose.yaml:compose.tunnel.yaml
   CLOUDFLARED_NETWORK=ckbolt-testnet_edge
   ```

   (the name from step 1). Keep both lines: without `COMPOSE_FILE`, a later `docker compose up -d --build` would
   recreate the container off that network and the hostname would answer 502.
3. Apply and check, without pulling anything (the check runs the local image on that network; put the name from
   step 1 after `--network`):

   ```bash
   docker compose up -d --build
   docker inspect ckbolt-faucet-faucet-1 \
     --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}'   # ckbolt-faucet_default and the network above
   docker run --rm --pull never --network ckbolt-testnet_edge --entrypoint node ckbolt/cwbtc-faucet:local \
     -e "fetch('http://ckbolt-faucet:3008/health').then(r => r.text()).then(console.log)"            # {"ok":true}
   ```

   The container name `ckbolt-faucet-faucet-1` resolves on that network too; the alias does not depend on Compose's
   naming.
4. Add the public hostname to the existing tunnel:
   - **Dashboard-managed tunnel**: Cloudflare Zero Trust, Networks, Tunnels, the CKBolt tunnel, Public Hostname, Add a
     public hostname: subdomain `ckbolt-faucet`, domain `texlabs.org`, path empty, service type `HTTP`, URL
     `ckbolt-faucet:3008`. Cloudflare creates the DNS record. Nothing to restart.
   - **Locally-managed tunnel** (the `config.yml` mounted into the cloudflared container): add before the catch-all
     rule

     ```yaml
     - hostname: ckbolt-faucet.texlabs.org
       service: http://ckbolt-faucet:3008
     ```

     then `cloudflared tunnel route dns <tunnel-name> ckbolt-faucet.texlabs.org` and restart the container
     (`docker restart ckbolt-testnet-cloudflared-1`).

Every container on cloudflared's network can now reach the faucet on port 3008 (and send it any `X-Forwarded-For`),
and the faucet can reach them. Keep only cloudflared and the services it publishes on that network.

Then in `/opt/ckbolt/faucet/.env`:

```env
PUBLIC_BASE_URL=https://ckbolt-faucet.texlabs.org
CORS_ORIGIN=https://ckbolt-faucet.texlabs.org
TRUST_PROXY_HOPS=1
```

and apply with `docker compose up -d --build`.

- The page calls its own API (same origin), so `CORS_ORIGIN` only matters for other sites calling the API from a
  browser. If the CKBolt app ever calls the faucet from the browser, add it: `CORS_ORIGIN=https://ckbolt-faucet.texlabs.org,https://ckbolt.texlabs.org`.
- `PUBLIC_BASE_URL` is informational in the current code; keep it accurate.
- `TRUST_PROXY_HOPS=1` makes the app take the visitor IP from the last `X-Forwarded-For` entry, which Cloudflare sets.
  The IP cooldowns depend on it. Check once after going public: claim from two different networks (for example a phone
  on mobile data and a laptop) within 30 minutes. If the second gets "This network can claim again in … min", the
  header is not reaching the app and every visitor shares one IP; tell the maintainer.

Optional, against abuse: enable Cloudflare Turnstile. In the Cloudflare dashboard, Turnstile, Add widget for
`ckbolt-faucet.texlabs.org`; put the secret key in `secrets/turnstile_secret_key` (one line), set
`TURNSTILE_SITE_KEY=<site key>` and `REQUIRE_TURNSTILE=true` in `.env`, then `docker compose up -d --build`.

Verify: `curl -fsS https://ckbolt-faucet.texlabs.org/health`, open the page, claim once from a browser.

## 6. Operations

All commands run in `/opt/ckbolt/faucet`.

| Task | Command |
| --- | --- |
| Status | `docker compose ps` |
| Logs | `docker compose logs -f faucet` (worker errors start with `[worker] claim ... failed`) |
| Balance | `curl -fsS http://127.0.0.1:3008/api/balance` |
| Recent claims | `curl -fsS -H "Authorization: Bearer $(cat secrets/admin_token)" http://127.0.0.1:3008/api/admin/summary` |
| Restart | `docker compose restart faucet` |
| Upgrade | `git pull` (or the rsync above), then `docker compose up -d --build` |
| Stop | `docker compose down` (never `-v`: it deletes the claim history and in-flight state) |

Inspect claims in SQLite (there is no `sqlite3` binary in the image):

```bash
docker compose exec -T faucet node -e "const db = require('better-sqlite3')('/app/data/faucet.sqlite', { readonly: true });
  console.table(db.prepare(\"SELECT id, status, tx_hash, error, datetime(created_at / 1000, 'unixepoch') AS at FROM claims ORDER BY created_at DESC LIMIT 20\").all())"
```

Stuck claims (`processing` after a crash, `sent` that never confirms): see `docs/OPERATIONS.md`, section Stuck Claims.

### Refill

Refill before `estimatedClaimsByCapacity` drops below a day of claims (50 at the default cap):

1. Send CKB from https://faucet.nervos.org to the same hot-wallet address (cWBTC lasts 10,000 claims; when it runs low,
   claim 100 cWBTC again at https://faucet-cwbtc.ckb.dev).
2. Nothing to restart: the worker uses the new cells on the next claim. Check `/api/balance`.

When the wallet runs dry, claims fail (`Insufficient coin` for cWBTC, an insufficient-capacity error for CKB) and, by
the upstream design, still count against the tester's cooldowns. After a refill, let those testers retry by deleting the
failed claims:

```bash
docker compose exec -T faucet node -e "const db = require('better-sqlite3')('/app/data/faucet.sqlite');
  console.log(db.prepare(\"DELETE FROM claims WHERE status = 'failed'\").run())"
```

### Backup and restore

The volume `ckbolt-faucet_faucet-data` holds `/app/data/faucet.sqlite`: claims, cooldowns and in-flight transactions.
The hot-wallet key is in `secrets/faucet_private_key`; copy it somewhere private if losing the remaining testnet funds
would matter.

Backup (online, consistent):

```bash
mkdir -p backups
docker compose exec -T faucet node -e "require('better-sqlite3')('/app/data/faucet.sqlite')
  .backup('/app/data/faucet-backup.sqlite').then(() => console.log('backup ok'))"
docker compose cp faucet:/app/data/faucet-backup.sqlite "backups/faucet-$(date +%F).sqlite"
# off the VPS, from the workstation:
scp "vps229:/opt/ckbolt/faucet/backups/faucet-*.sqlite" .
```

Restore (stops the faucet; uses the local image, nothing is pulled):

```bash
docker compose stop faucet
docker run --rm --user root --entrypoint sh -v ckbolt-faucet_faucet-data:/app/data -v "$PWD/backups:/backup:ro" \
  ckbolt/cwbtc-faucet:local -c 'rm -f /app/data/faucet.sqlite-wal /app/data/faucet.sqlite-shm &&
  cp /backup/faucet-YYYY-MM-DD.sqlite /app/data/faucet.sqlite && chown node:node /app/data/faucet.sqlite'
docker compose start faucet
```

## 7. Container publishing on this fork

The VPS never pulls an image: `compose.yaml` builds `ckbolt/cwbtc-faucet:local` from the checkout
(`pull_policy: build`, so `docker compose pull` skips it). `.github/workflows/publish-container.yml` runs the checks on
pushes and pull requests and publishes only when started by hand (Actions tab, Run workflow), to
`ghcr.io/longdevbf/cwbtc-faucet` (the image name comes from the repository, never `retricsu`). GitHub also keeps
workflows of a fresh fork disabled until they are enabled in the Actions tab.
