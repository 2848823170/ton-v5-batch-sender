# ton-v5-batch-sender

[![CI](https://github.com/2848823170/ton-v5-batch-sender/actions/workflows/ci.yml/badge.svg)](https://github.com/2848823170/ton-v5-batch-sender/actions/workflows/ci.yml)

Non-custodial TypeScript CLI & library for **bulk TON multi-address payouts** built on **`@ton/ton` Wallet V5R1 (`WalletContractV5R1`)** — packing up to **`255` transfers into a single transaction** (`63.75x` fewer transactions than Wallet V4R2's 4-message limit).

## Key Engineering & Safety Guarantees

- **Wallet V5R1 Native Batching (`<= 255` transfers/tx)**: Automatically chunks large CSVs (e.g. `600` rows -> `[255, 255, 90]`) and signs valid V5R1 `OutList` BOC cells using standard 24-word Tonkeeper-compatible V5 mnemonics.
- **`UQ...` vs `EQ...` Bounce-Safety Inference**: Automatically sets `bounce: false` on non-bounceable `UQ...` / `0Q...` user addresses so payouts to uninitialized recipient wallets are credited rather than bounced, while preserving `bounce: true` on `EQ...` smart contracts (with optional per-row CSV override).
- **Mainnet/Testnet Guardrails & Pre-Flight Balance Simulation**: Rejects testnet-flagged (`kQ`/`0Q`) addresses on `--network mainnet`, blocks dust/malformed rows and accidental duplicate recipients, and verifies live wallet balance covers `transfers + gas headroom` before broadcasting a single transaction.
- **Sequential `seqno` Confirmation Polling + Crash-Safe JSONL Checkpointing**: Polls `wallet.getSeqno()` between batches and records every confirmed batch (`seqnoUsed`, `bocHashHex`, `confirmedAt`) to `<csv>.checkpoint.jsonl` so interrupted runs resume with **zero double-sends**.
- **Highload V3 & Jetton (`USDT` on TON) Architecture Guide**: See [`docs/HIGHLOAD_V3_GUIDE.md`](docs/HIGHLOAD_V3_GUIDE.md) for `USDT` Jetton (`0x0f8a7ea5`) batching and `100,000+`-recipient `HighloadWalletV3` parallel query-bitmap scaling.

## Quick Start

```bash
npm install
npm test
npm run dry-run:sample
```

### Sample `--dry-run` Output

```text
==================================================================
 TON Wallet V5R1 Non-Custodial Batch Sender — Pre-Flight Summary
==================================================================
 Network                : TESTNET
 Mode                   : DRY-RUN SIMULATION (0 network writes)
 Validated Recipients   : 5
 V5R1 Batches (<=255/tx): 1 tx (vs 2 tx on Wallet V4R2 -> 2x fewer txs)
 Total Transfer Amount  : 3 TON
 Est. Gas & Fwd Headroom: 0.0305 TON
 Min Wallet Balance Req : 3.0305 TON
------------------------------------------------------------------
  Batch #1:   5 msgs | subtotal=         3 TON | estFee=0.0305 TON | bounceable=1/5
==================================================================
[DRY-RUN OK] CSV validated & V5R1 batches simulated cleanly.
```

### Live Execution (`TON_MNEMONIC` Never Passed in CLI History)

```bash
export TON_MNEMONIC="word1 word2 ... word24"
export TON_API_KEY="optional_toncenter_api_key"

# 1. Pre-flight check on mainnet (0 network writes)
npx ton-v5-batch --csv payouts.csv --network mainnet --dry-run

# 2. Live execution with automatic seqno confirmation & JSONL checkpointing
npx ton-v5-batch --csv payouts.csv --network mainnet --execute
```

## CSV Schema (`examples/recipients.sample.csv`)

```csv
address,amount_ton,comment,bounce
UQDnKS0_5OAKbrDOyr8NuePEuA4FiLmnkYlI5t7dzBkhemIn,0.25,Payout #101 - Partner share,
UQBoqsPeK5lgLAM8cEDOOM0MStfKu3UWWMWFdhKlRFLxstNU,0.50,"Payout #102, bonus tier",
UQApknIF6pC3WUjE5hTcCWH3DAOb_-IIz4pMxqdubayWYLZY,0.75,Payout #103 - Referral reward,
UQAcfT90zCOckiS-ZEyggu4xdyav-dzzyxr9JaKn5xdhbn-Z,0.375,Payout #104 - Node rebate,
EQDL-d1J8PRbFEmy3abuPLoNcrsLjahxja3h5ALQjm_06RN8,1.125,Vault settlement,true
```

## Programmatic Usage

```ts
import { parseBatchCsv, buildBatchPlan, executeBatchPlan } from "ton-v5-batch-sender";

const rows = parseBatchCsv(csvText, { network: "mainnet", allowDuplicates: false });
const plan = buildBatchPlan(rows, { network: "mainnet", batchSize: 255 });
console.log(`Chunks: ${plan.totalBatches}, Min required: ${plan.minWalletBalanceTon} TON`);
```

## Custom Extensions Available

- **TON `USDT` (`EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs`) Jetton `0x0f8a7ea5` Batch Dispatcher** (automatic sender Jetton wallet resolution + excess TON gas refund to treasury).
- **Highload Wallet V3 (`HighloadWalletV3`)** subwallet + query-id bitmap dispatcher for `10,000–100,000+` concurrent transfers without sequential `seqno` waits.
- **Telegram Ops Bot / REST API Wrapper** with hardware/multisig approval gates and accounting CSV/JSON exports (see also [LedgerClean Pro](https://2848823170.github.io/ledgerclean-pro/)).

## License

MIT
