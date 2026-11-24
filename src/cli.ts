#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import { fromNano } from "@ton/core"
import {
  buildBatchPlan,
  V5R1_MAX_MESSAGES_PER_BATCH,
} from "./batch-planner.js"
import { parseAndValidateRecipientsCsv } from "./csv-parser.js"
import { createLiveTonV5Adapter, executeBatchPlan } from "./sender.js"

function parseArgs(argv: string[]) {
  const out: {
    csv?: string
    network: "mainnet" | "testnet"
    dryRun: boolean
    execute: boolean
    maxPerBatch: number
    checkpoint?: string
    allowDuplicates: boolean
  } = {
    network: "testnet",
    dryRun: true,
    execute: false,
    maxPerBatch: V5R1_MAX_MESSAGES_PER_BATCH,
    allowDuplicates: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--csv" && argv[i + 1]) out.csv = argv[++i]
    else if (arg === "--network" && argv[i + 1]) {
      const n = argv[++i]
      if (n !== "mainnet" && n !== "testnet") {
        throw new Error(`Invalid --network "${n}" (expected mainnet|testnet)`)
      }
      out.network = n
    } else if (arg === "--dry-run") {
      out.dryRun = true
      out.execute = false
    } else if (arg === "--execute") {
      out.execute = true
      out.dryRun = false
    } else if (arg === "--max-per-batch" && argv[i + 1]) {
      out.maxPerBatch = Number(argv[++i])
    } else if (arg === "--checkpoint" && argv[i + 1]) {
      out.checkpoint = argv[++i]
    } else if (arg === "--allow-duplicates") {
      out.allowDuplicates = true
    }
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.csv) {
    console.error(
      "Usage: ton-v5-batch --csv <recipients.csv> [--network testnet|mainnet] [--dry-run | --execute] [--checkpoint run.checkpoint.jsonl]",
    )
    process.exit(1)
  }

  const csvPath = path.resolve(args.csv)
  const csvText = fs.readFileSync(csvPath, "utf8")
  const parsed = parseAndValidateRecipientsCsv(csvText, {
    network: args.network,
  })

  if (parsed.duplicateAddresses.length > 0 && !args.allowDuplicates) {
    throw new Error(
      `Duplicate recipient addresses detected (${parsed.duplicateAddresses.join(", ")}). Re-run with --allow-duplicates if intentional.`,
    )
  }

  const plan = buildBatchPlan(parsed.recipients, args.maxPerBatch)

  console.log("==================================================================")
  console.log(" TON Wallet V5R1 Non-Custodial Batch Sender — Pre-Flight Summary")
  console.log("==================================================================")
  console.log(` Network                : ${args.network.toUpperCase()}`)
  console.log(` Mode                   : ${args.execute ? "LIVE EXECUTE" : "DRY-RUN SIMULATION (0 network writes)"}`)
  console.log(` Validated Recipients   : ${plan.totalRecipients}`)
  console.log(` V5R1 Batches (<=255/tx): ${plan.batches.length} tx (vs ${plan.summary.v4EquivalentTxCount} tx on Wallet V4R2 -> ${plan.summary.txReductionFactor}x fewer txs)`)
  console.log(` Total Transfer Amount  : ${plan.summary.totalTransferTon} TON`)
  console.log(` Est. Gas & Fwd Headroom: ${plan.summary.totalEstimatedFeeTon} TON`)
  console.log(` Min Wallet Balance Req : ${plan.summary.totalRequiredBalanceTon} TON`)
  console.log("------------------------------------------------------------------")
  for (const b of plan.batches) {
    const bounceCount = b.recipients.filter((r) => r.bounce).length
    console.log(
      `  Batch #${b.batchIndex + 1}: ${String(b.recipients.length).padStart(3)} msgs | subtotal=${fromNano(b.subtotalNano).padStart(10)} TON | estFee=${fromNano(b.estimatedFeeNano)} TON | bounceable=${bounceCount}/${b.recipients.length}`,
    )
  }
  console.log("==================================================================")

  if (!args.execute) {
    console.log("[DRY-RUN OK] CSV validated & V5R1 batches simulated cleanly.")
    return
  }

  const rawMnemonic = (process.env.TON_MNEMONIC ?? "").trim()
  if (!rawMnemonic) {
    throw new Error(
      "Missing TON_MNEMONIC environment variable (24 words) required for --execute mode.",
    )
  }
  const words = rawMnemonic.split(/\s+/)
  if (words.length !== 24) {
    throw new Error(`Expected 24 mnemonic words in TON_MNEMONIC (got ${words.length})`)
  }

  const { senderFriendlyAddress, secretKey, adapter } =
    await createLiveTonV5Adapter({
      mnemonicWords: words,
      network: args.network,
      endpoint: process.env.TON_RPC_ENDPOINT,
      apiKey: process.env.TON_API_KEY,
    })

  console.log(` Sender Wallet (V5R1)   : ${senderFriendlyAddress}`)
  const entries = await executeBatchPlan({
    plan,
    adapter,
    secretKey,
    checkpointPath: args.checkpoint ?? `${csvPath}.checkpoint.jsonl`,
    onProgress: (msg) => console.log(msg),
  })
  console.log(`[COMPLETE] Confirmed ${entries.length} V5R1 batch transaction(s).`)
}

main().catch((err) => {
  console.error(`[ERROR] ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
