# Examples

Runnable examples covering every combination of protocol, transport, and blockchain.

## Setup

```bash
cp .env.example .env
# Fill in your keys
```

| Variable | Required | Description |
|----------|:--------:|-------------|
| `EVM_PRIVATE_KEY` | Yes | `0x...` — EVM wallet (Base, SKALE) |
| `TEMPO_PRIVATE_KEY` | No | `0x...` — Tempo wallet (defaults to `EVM_PRIVATE_KEY`) |
| `SOLANA_PRIVATE_KEY` | No | `base58...` — Solana wallet |
| `MPP_SECRET_KEY` | No | Server-side MPP secret (default provided) |
| `RECIPIENT_WALLET` | Yes | `0x...` — EVM recipient (must differ from payer) |
| `SOLANA_RECIPIENT_WALLET` | No | `base58...` — Solana recipient |
| `SOLANA_RPC_URL` | No | Solana RPC (default: mainnet-beta) |

## Quick start

Run all 16 combinations at once:

```bash
npx tsx examples/test/all.ts
```

Run all plugin tests (29 tests):

```bash
npx tsx examples/plugins/test/all.ts
```

## Coverage matrix

| Chain | MPP HTTP | MPP WS | x402 HTTP | x402 WS | freeTier | shield | CB | refund | bridge HTTP | bridge WS |
|-------|:--------:|:------:|:---------:|:-------:|:--------:|:------:|:--:|:------:|:----------:|:---------:|
| **Tempo** | ✅ | ✅ | — | — | ✅ | ✅ | ✅ | ✅ | — | — |
| **Base** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **SKALE** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Solana** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

- **Plugins** (freeTier, shield, circuitBreaker, refund) are chain-agnostic — tested on Base over HTTP + WS, applies identically to all chains.
- **Bridge** routes cross-chain — see `examples/bridge/` for all scenarios.
- **x402 Tempo** is not available (Tempo is not in the facilitator's network list).

## Directory structure

```
examples/
├── bridge/                        # Cross-chain bridge examples
│   ├── client-side/               # Server knows NOTHING about bridge — client bridges transparently
│   │   ├── mpp-server-skale.ts        Standard evm/charge SKALE server
│   │   ├── mpp-server-base.ts         Standard evm/charge Base server
│   │   ├── x402-server-base.ts        Standard x402 Base server
│   │   ├── mpp-client-tempo-to-skale.ts   Tempo → SKALE (evmChargeWithBridge)
│   │   ├── mpp-client-tempo-to-base.ts    Tempo → Base  (evmChargeWithBridge)
│   │   └── x402-client-solana-to-base.ts  Solana → Base (bridge: { enabled: true })
│   │
│   └── server-side/               # Server exposes bridge/charge — client uses that method
│       ├── mpp-server-skale.ts        evm/charge + bridge/charge (SKALE)
│       ├── mpp-server-solana.ts       solana/charge + bridge/charge (Solana)
│       ├── mpp-client-tempo-to-skale.ts   Tempo → SKALE (bridgeCharge client)
│       └── mpp-client-tempo-to-solana.ts  Tempo → Solana (bridgeCharge client)
│
├── server/                        # Standalone servers (direct payments, no bridge)
│   ├── http/
│   │   ├── tempo/mpp.ts           # MPP Tempo server ($0.01)
│   │   ├── evm/
│   │   │   ├── mpp-base.ts        # MPP EVM on Base ($0.01)
│   │   │   └── mpp-skale.ts       # MPP EVM on SKALE ($0.01, gas-free)
│   │   └── solana/mpp.ts          # MPP Solana server ($0.01)
│   └── ws/
│       └── relay.ts               # WS + HTTP relay (Tempo MPP + x402 Base)
│
├── client/                        # Standalone clients (direct payments, no bridge)
│   ├── http/                      # HTTP transport
│   │   ├── tempo/mpp.ts
│   │   ├── evm/
│   │   │   ├── mpp.ts             # MPP EVM charge
│   │   │   ├── x402-base.ts       # x402 on Base
│   │   │   └── x402-skale.ts      # x402 on SKALE
│   │   └── solana/
│   │       ├── mpp.ts             # MPP Solana
│   │       └── x402.ts            # x402 Solana SPL
│   └── ws/                        # WebSocket transport
│       ├── tempo/mpp.ts
│       ├── evm/
│       │   ├── mpp.ts
│       │   ├── x402-base.ts
│       │   └── x402-skale.ts
│       └── solana/
│           ├── mpp.ts
│           └── x402.ts
│
├── dualchannel/                   # Same endpoint, two payment protocols
│   ├── server/http/tempo-base.ts  # Server: x402 Base + MPP Tempo
│   └── client/
│       ├── mpp/tempo.ts           # Client pays via MPP (Tempo)
│       └── x402/base.ts           # Client pays via x402 (Base EVM)
│
├── plugins/                       # All plugins + dual protocol + dual transport
│   ├── server/http/tempo-base.ts  # Server with all 5 plugins enabled
│   ├── client/
│   │   ├── http/
│   │   │   ├── mpp/tempo.ts
│   │   │   └── x402/base.ts
│   │   └── ws/
│   │       ├── mpp/tempo.ts
│   │       └── x402/base.ts
│   └── test/
│       ├── all.ts                 # 19 automated tests (plugins x protocols x transports)
│       └── legacy.ts              # Original plugin test (Tempo only)
│
└── test/
    └── all.ts                     # 16 automated tests (all chain x protocol x transport combos)
```

## Running individual examples

### Bridge (cross-chain)

Two approaches to cross-chain payments:

**Client-side bridge** — the server is standard (no bridge config). The client detects it's on a different chain and bridges transparently. Use this when the target chain is EVM.

```bash
# Terminal 1: standard SKALE server (no bridge awareness)
npx tsx examples/bridge/client-side/mpp-server-skale.ts

# Terminal 2: Tempo client bridges transparently
EVM_PRIVATE_KEY=0x... npx tsx examples/bridge/client-side/mpp-client-tempo-to-skale.ts
```

```bash
# Terminal 1: standard x402 Base server
npx tsx examples/bridge/client-side/x402-server-base.ts

# Terminal 2: Solana client auto-bridges
SOLANA_PRIVATE_KEY=... npx tsx examples/bridge/client-side/x402-client-solana-to-base.ts
```

**Server-side bridge** — the server explicitly exposes `bridge/charge` alongside its direct method. The client picks bridge/charge when it can't pay directly. Use this when the target chain is Solana (not EVM).

```bash
# Terminal 1: SKALE server with evm/charge + bridge/charge
npx tsx examples/bridge/server-side/mpp-server-skale.ts

# Terminal 2: Tempo client uses bridge/charge
EVM_PRIVATE_KEY=0x... npx tsx examples/bridge/server-side/mpp-client-tempo-to-skale.ts
```

```bash
# Terminal 1: Solana server with solana/charge + bridge/charge
npx tsx examples/bridge/server-side/mpp-server-solana.ts

# Terminal 2: Tempo client bridges to Solana
EVM_PRIVATE_KEY=0x... npx tsx examples/bridge/server-side/mpp-client-tempo-to-solana.ts
```

### Server + client pairs (HTTP)

```bash
# Terminal 1: start server
npx tsx examples/server/http/tempo/mpp.ts

# Terminal 2: run client
npx tsx examples/client/http/tempo/mpp.ts
```

```bash
# SKALE (gas-free)
npx tsx examples/server/http/evm/mpp-skale.ts
npx tsx examples/client/http/evm/mpp.ts
```

```bash
# Solana
npx tsx examples/server/http/solana/mpp.ts
npx tsx examples/client/http/solana/mpp.ts
```

### WebSocket relay

```bash
# Terminal 1: start relay server (serves both HTTP + WS)
npx tsx examples/server/ws/relay.ts

# Terminal 2: WS client (x402 on Base)
npx tsx examples/client/ws/evm/x402-base.ts

# Terminal 2: WS client (MPP Tempo)
npx tsx examples/client/ws/tempo/mpp.ts

# Terminal 2: HTTP client (x402 on Base, same server)
npx tsx examples/client/http/evm/x402-base.ts http://localhost:4405/api/data
```

### Dual-channel (x402 + MPP on same endpoint)

```bash
# Terminal 1
npx tsx examples/dualchannel/server/http/tempo-base.ts

# Terminal 2: pay via MPP
npx tsx examples/dualchannel/client/mpp/tempo.ts

# Terminal 2: pay via x402
npx tsx examples/dualchannel/client/x402/base.ts
```

### Plugin server (all plugins)

```bash
# Terminal 1
npx tsx examples/plugins/server/http/tempo-base.ts

# Terminal 2: any client
npx tsx examples/plugins/client/http/mpp/tempo.ts
npx tsx examples/plugins/client/ws/x402/base.ts
```

## Protocols

| Protocol | How it works | Chain support |
|----------|-------------|---------------|
| **x402** | Client signs EIP-3009 or Solana SPL transfer, facilitator settles on-chain | Base, SKALE, Solana, Avalanche, Polygon, Ethereum, Telos |
| **MPP Tempo** | Client signs Tempo tx, server verifies via mppx | Tempo (gas-free) |
| **MPP EVM** | Client sends ERC-20 transfer, server verifies receipt on-chain | Base, SKALE, any EVM |
| **MPP Solana** | Client sends SPL transfer, server verifies on-chain | Solana |

## Plugins

| Plugin | What it does |
|--------|-------------|
| **freeTier** | N free calls per buyer before requiring payment |
| **shield** | Health check — returns 503 when service is unhealthy |
| **circuitBreaker** | Opens circuit after N settlement failures, auto-resets |
| **refund** | Grants free credit on next call after settlement failure |

## Notes

- SKALE is gas-free — ideal for testing MPP EVM without gas costs
- Tempo is also gas-free — ideal for testing MPP without any on-chain costs
- The WS relay server (`server/ws/relay.ts`) serves both HTTP and WebSocket on the same port
- Bridge requires minimum $0.05 per transaction
- x402 payments go through the RelAI facilitator (`facilitator.x402.fi`)
