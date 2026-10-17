# Daypass

**Login is payment. The wallet is the account.**

An agent buys a *day pass* to a business's API once, then calls it hundreds of times inside the
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

## How it works

```
agent                       Daypass plugin                    PayBox                 merchant API
  │  daypass_discover ──────▶ offers + prices                                                    │
  │  daypass_buy_pass ──────▶ x402 payment contract                                              │
  │                     ◀──── pay_x402 ──────────────▶ passkey approval + on-chain payment      │
  │  daypass_redeem ───────▶ verifies proof, mints pass_id                                       │
  │  daypass_use ×N ───────▶ spends one use ───────────────────────────▶ serves real content     │
```

The plugin **never moves money itself.** It returns the exact x402 contract, PayBox's own
`pay_x402` collects the passkey approval and settles, and Daypass verifies the resulting
EIP-3009 `TransferWithAuthorization` proof before minting a pass. See `KNOWLEDGE.md` §15 —
a third-party plugin does not get PayBox's money rail, and pretending otherwise produces a
plugin that cannot work.

### The pass is a capability

PayBox sends plugins **no user identity**. So a pass is not bound to a wallet — the unguessable
UUIDv4 `pass_id` (122 bits) *is* the credential. Whoever holds it holds the access, exactly like
a paper ticket. This is deliberate; `my_passes` was cut rather than faked with an OAuth server.

## Tool surface

| Tool | Reads/writes | What it does |
|---|---|---|
| `daypass_ping` | read | health check |
| `daypass_discover` | read | list businesses, prices, access windows |
| `daypass_status` | read | remaining time and uses on one pass |
| `daypass_buy_pass` | write | return the x402 payment contract (**moves no money**) |
| `daypass_redeem` | write | verify a payment proof → mint a pass |
| `daypass_use` | write | spend one use — this is the gate the merchant enforces |

## Verified

Four gates, one command:

```bash
npm test
```

| Gate | Covers |
|---|---|
| `test:plugin` | MCP surface reachable, annotations correct |
| `test:payment` | 12 assertions — valid proof accepted; replay, underpay, wrong recipient, expiry, forged signer, tampered and off-curve signatures all rejected |
| `test:entitlement` | uses decrement, exhaustion, expiry, and **survives a restart** (a real subprocess re-reads the store) |
| `test:merchant` | unpaid requests get `401` **and leak no content**; a real pass serves real content; each call costs exactly one use |

The merchant API is real, not a mock — it runs in this same process behind the same pass store:

```bash
npm start
curl localhost:8787/v1/quotes                                  # 401 — no pass
curl -H "X-Daypass-Pass: <pass_id>" localhost:8787/v1/quotes   # 200 — real quotes
```

## Honest limitations

- **Settlement is verified by signature, not by indexation.** `daypass_redeem` proves the payer
  really signed an authorization for the right amount to the right address, and enforces
  single-use nonces. That is what an x402 facilitator checks before settling; it does not itself
  confirm the transfer landed on-chain.
- **The demo wallet is unfunded**, so the full `pay_x402 → redeem` path has not been exercised
  with real money. Everything downstream of the proof *is* live and was verified through PayBox.

## Layout

```
src/plugin/          the PayBox plugin (MCP server)
  payment.ts         x402 accepts contract + EIP-3009 proof verification
  passes.ts          the pass store — persisted, so sold passes outlive restarts
  tools/             registrations, split read-only vs money-adjacent
src/merchant/        the paywalled API the pass actually gates
scripts/             the four verification gates
```

`KNOWLEDGE.md` holds what was measured against the live PayBox API (and what turned out to be
wrong). `BUILD.md` is the phased plan with hard gates; `PRODUCT.md` is the spec.
