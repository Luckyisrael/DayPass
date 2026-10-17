# Daypass

**Login is payment. The wallet is the account.**

An agent buys a *pass* to a business's API once, then calls it hundreds of times inside a
window. One payment, many uses — and a hard stop when the window or the credit runs out.

Daypass is a [PayBox](https://app.paybox.sh) marketplace plugin.

```bash
# what an agent asks for
"Get live FX quotes from Northwind."
# → Daypass sells a $0.25 hour pass. The human approves once with a passkey.
# → The agent then calls the real API 60 times. No further payment, no API keys, no signup.
```

## Why this isn't just x402

x402 is excellent and it is **one-shot**: pay, fetch, done. The next request pays again.

Daypass sits one level up. It turns a stream of payments into a single **entitlement**:

| | x402 pay-per-call | Daypass |
|---|---|---|
| 500 API calls | 500 payments, 500 approvals | 1 payment, 1 approval |
| Cost | per-call | bundled, cheaper |
| Credential | none — every call re-authenticates | the pass itself |
| Revocation | none | pass expires, or credit runs out |

x402 is the *rail*. Daypass is the *ticket you buy with it*.

## The architecture, and why it is two pieces

PayBox runs hosted plugins in a **fresh sandbox per call with no persistence** — nothing in
memory or on disk survives between operations. So the plugin cannot be the system of record.

```
  ┌──────────────────────┐                    ┌──────────────────────────┐
  │  Daypass plugin      │                    │  Daypass merchant        │
  │  dist/plugin.mjs     │                    │  Render                  │
  │                      │                    │                          │
  │  stateless           │  ── fetch ───────▶ │  holds every pass        │
  │  no memory, no disk  │                    │  every credit, every     │
  │  a storefront + a    │                    │  window. The single      │
  │  client              │ ◀── 200 / 402 ──── │  system of record.       │
  └──────────────────────┘                    └──────────────────────────┘
```

That split is the whole design. The plugin is memoryless by necessity, so "pay once, use many"
only works because the merchant keeps the tally. The plugin dies between calls and nothing is
lost.

### How a purchase actually flows

```
agent                Daypass plugin              PayBox                    merchant
  │  daypass_list_offers ─▶ bundled catalogue (no network)                  │
  │  daypass_buy_pass ────▶ x402 proposal, pointing at the merchant         │
  │                      ─ ─ ─ ─ ─ ─ ─ ─ ─▶ POST /v1/passes (unpaid)  ───▶ │ 402 + challenge
  │                                          passkey approval                │
  │                                          pays in USDC on Base        ──▶ │ verifies EIP-3009
  │                                          retries the POST              │ │ mints, returns pass_id
  │  daypass_use × N ────▶ spends one credit  ───────────────────────────▶ │ serves real content
  │  daypass_status ─────▶ reads remaining, spends nothing ─────────────▶  │
```

Note the middle row: `daypass_buy_pass` **makes no request itself.** It returns an
`io.paybox/transactionProposal` of kind `x402`, and *PayBox* then calls the merchant directly
for the live challenge, collects the passkey approval, settles, and retries. The plugin is
never resumed for that step — an agent passes the paid response into the next tool call.

The plugin **never moves money.** It only ever proposes; PayBox is the payer. Daypass's job is
the entitlement: verify the resulting EIP-3009 `TransferWithAuthorization` proof, then mint.

### The pass is a capability

PayBox sends plugins **no user identity**. So a pass is not bound to a wallet — the unguessable
UUIDv4 `pass_id` (122 bits) *is* the credential. Whoever holds it holds the access, exactly like
a paper ticket. This is deliberate; `my_passes` was cut rather than faked with an OAuth server.

## Tool surface

Four tools, and only two of them touch the network.

| Tool | Network | Reads/writes | What it does |
|---|---|---|---|
| `daypass_list_offers` | none | read | the catalogue of passes for sale |
| `daypass_buy_pass` | none | read | return the x402 proposal (**moves no money**; PayBox calls the merchant) |
| `daypass_use` | merchant | write | spend one credit — the gate the merchant enforces |
| `daypass_status` | merchant | read | remaining time and uses, spends nothing |

`daypass_list_offers` is served from the bundle rather than fetched, so it answers even when
the merchant is down — and it makes the hosted conformance check deterministic.

The catalogue:

| Pass | Business | Price | Window | Calls |
|---|---|---|---|---|
| `northwind-quote-hour` | Northwind Market Data | $0.25 | 60 min | 60 |
| `acme-weather-day` | Acme Weather API | $0.50 | 24 h | 500 |
| `acme-weather-week` | Acme Weather API | $2.00 | 7 days | 3000 |

## Environment variables

**The plugin** — configured in the PayBox developer portal, under Variables & Secrets.
It reads exactly one:

| Name | Required | Value |
|---|---|---|
| `DAYPASS_MERCHANT_URL` | yes | the merchant origin, e.g. `https://daypass-holl.onrender.com` |

A bare origin: no path, no query, no fragment, no trailing slash. Anything else is rejected at
call time. The hostname must **also** be added as a network host in the portal — the sandbox
only permits `fetch` to explicitly configured hosts.

**The merchant** — configured on the Render service:

| Name | Required | Value |
|---|---|---|
| `DAYPASS_PAY_TO` | **yes** | the USDC receiving address on Base. Without it the merchant cannot state where payment must land, so every purchase returns `503` and the log says so at startup. |
| `PUBLIC_URL` | recommended | the public origin, e.g. `https://daypass-holl.onrender.com`. Only the *path* portion is used, so it needs to be a valid absolute URL but routing does not depend on the host. |
| `DAYPASS_STORE` | only with a disk | `/data/passes.json` if a Persistent Disk is attached. Defaults to `.daypass/passes.json`. |
| `PORT` | no | set by Render; the server reads it |

The portal holds no secrets. The plugin carries no keys, and the merchant holds no private key
— it verifies signatures, it never signs.

## Deploying the merchant

`render.yaml` is a Render blueprint: it binds `PORT`, exposes `/health`, and starts with
`npm start`. There is no build step — `tsx` runs the TypeScript directly.

**Durability matters, and this is the sharp edge.** Render's filesystem is ephemeral. Without a
Persistent Disk, passes vanish whenever the service restarts or cold-starts after idling, and a
buyer who comes back later finds their pass gone. Two things follow:

1. Attach a Persistent Disk and set `DAYPASS_STORE=/data/passes.json` for real durability.
2. On the free tier, where disks aren't available, keep the service awake with an uptime pinger
   hitting `/health` every five minutes, and **do not redeploy during judging** — a deploy
   erases sold passes.

The merchant is live at **https://daypass-holl.onrender.com**.

## Verified

One command:

```bash
npm test
```

| Suite | Covers |
|---|---|
| `test:plugin` | MCP surface reachable, annotations correct |
| `test:payment` | 12 assertions — valid proof accepted; replay, underpay, wrong recipient, expiry, forged signer, tampered and off-curve signatures all rejected |
| `test:entitlement` | uses decrement, exhaustion, expiry, and **survives a restart** |
| `test:merchant` | unpaid requests get `401` **and leak no content**; a real pass serves real content; each call costs exactly one use |
| `test:x402` | 28 assertions on the full purchase chain — 402 challenge, signed proof mints, replay and underpayment refused, and the 601st call returns `402 exhausted` |
| `test:bundle` | 31 assertions against the **built artifact**, each in a fresh process — which is what proves the statelessness rather than assuming it |

The submitted bundle has its own gate, on the pinned toolchain:

```bash
cd paybox-plugin && pnpm install --frozen-lockfile && pnpm test
# → status: passed, discoveredToolCount: 4, deterministic double-build
```

The merchant API is real, not a mock — it runs in the same process behind the same pass store:

```bash
DAYPASS_PAY_TO=0x... npm start
curl localhost:8787/v1/quotes                                  # 401 — no pass
curl -H "X-Daypass-Pass: <pass_id>" localhost:8787/v1/quotes   # 200 — real quotes
curl -X POST -d '{"offerId":"northwind-quote-hour"}' \
     'localhost:8787/v1/passes?offer=northwind-quote-hour'     # 402 — the x402 challenge
```

## Honest limitations

- **Settlement is verified by signature, not by indexation.** The merchant proves the payer
  really signed an authorization for the right amount to the right address, and enforces
  single-use nonces. That is what an x402 facilitator checks before settling; it does not itself
  confirm the transfer landed on-chain.
- **Replay protection is in-memory** (`seenNonces` is a `Set`), so it resets on restart. Fine
  for a demo window; a real deployment needs a database.
- **The pass store is a JSON file**, which is the right call at this scale and wrong for
  anything concurrent.
- **The demo wallet is unfunded**, so the `pay_x402` leg has not been exercised with real
  money. Everything downstream of the proof *is* live and was verified through PayBox.

## Layout

```
paybox-plugin/            the submitted artifact — what goes in the PayBox portal
  src/plugin.ts           four tools, stateless, no persistence, no secrets
  src/paybox.ts           the io.paybox/transactionProposal schema + proposeX402
  dist/plugin.mjs         esbuild bundle, ~389 KB, built on Node 24 + pnpm 11.11.0
  scripts/conformance.mjs protocol + schema + artifact-size checks (starter-owned)

src/                      the merchant — the system of record
  merchant/x402.ts        402 challenge, EIP-3009 verification, minting
  merchant/routes.ts      the meta routes and the paywalled API
  merchant/paywall.ts     the gate
  merchant/data.ts        sample weather + quotes the pass actually unlocks
  plugin/payment.ts       x402 accepts contract + proof verification
  plugin/passes.ts        the pass store — persisted, so sold passes outlive restarts
  plugin/offers.ts        the catalogue, and the price conversion both sides share
  plugin/server.ts        HTTP server: MCP on /mcp, merchant on /v1, health on /health

scripts/                  the six verification gates
render.yaml               the Render deployment blueprint
```

`KNOWLEDGE.md` holds what was measured against the live PayBox API (and what turned out to be
wrong). `BUILD.md` is the phased plan with hard gates; `SUBMIT.md` is the portal handoff.
