# Architecture Note: Wallet V5R1 (`255` msgs/tx) vs Highload Wallet V3 (`254` msgs/tx * Parallel)

When sending bulk TON or Jetton payouts on TON, choosing the right wallet contract prevents stuck `seqno` queues and bounced funds:

| Criteria | Legacy Wallet V4R2 | **Wallet V5R1 (`WalletContractV5R1` — Default Here)** | **Highload Wallet V3 (`HighloadWalletV3`)** |
|---|---|---|---|
| **Max transfers / external tx** | `4` | **`255`** (`OutActionSendMsg` list) | `254` (via internal self-dispatch action pack) |
| **Replay protection** | Sequential `seqno` | Sequential `seqno` + `wallet_id` | **`subwallet_id` + 23-bit `(shift << 10) \| bit_number` `query_id` bitmap** (no sequential `seqno` lock!) |
| **Ideal batch scale** | `< 20` recipients | **`5` – `10,000` recipients** (`1–40` sequential txs, standard Tonkeeper/MyTonWallet seed compatible!) | **`10,000` – `1,000,000+` recipients** (exchanges, high-RPS faucets, parallel workers) |
| **Seed compatibility** | Standard 24-word | **Standard 24-word TON mnemonic** (same wallet visible in Tonkeeper V5!) | Dedicated contract deployment & custom `HighloadQueryId` state tracker |

## Upgrading to Highload V3 or Jetton (`USDT` on TON) Bulk Transfers
1. **Jetton (`USDT` `EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs`) Batching**:
   - In TON, each Jetton transfer is an internal message sent to **your sender's Jetton Wallet contract** carrying opcode `0x0f8a7ea5` (`transfer#0f8a7ea5`), `amount` (6 decimals for TON `USDT`), `destination` recipient owner address, `response_destination` (your V5R1 address so excess `TON` gas returns automatically!), and `forward_ton_amount` (`1 nanoTON` notification).
   - `WalletContractV5R1` packs up to **255 `USDT` Jetton transfer messages** in a single external transaction (~`0.05 TON` attached per transfer, ~`85%+` refunded via `excesses#d53276db`).
2. **Highload Wallet V3 Parallelism**:
   - When throughput exceeds `~50 transfers/sec`, deploy `HighloadWalletV3` (`timeout = 3600s`) and replace `waitForSeqnoAdvance` with monotonic `HighloadQueryId` (`shift: 0..8191`, `bitNumber: 0..1022` -> `8,380,416` unique queries per timeout window) so batches dispatch concurrently without waiting for block finality between chunks.
