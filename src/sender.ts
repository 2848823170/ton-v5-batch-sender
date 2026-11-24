import fs from "node:fs"
import { type Cell, fromNano } from "@ton/core"
import { mnemonicToPrivateKey } from "@ton/crypto"
import { TonClient, WalletContractV5R1 } from "@ton/ton"
import {
  type BatchSimulationPlan,
  DEFAULT_V5_SEND_MODE,
  type PlannedBatch,
} from "./batch-planner.js"

export interface WalletProviderAdapter {
  getBalance(): Promise<bigint>
  getSeqno(): Promise<number>
  sendBatch(args: {
    seqno: number
    secretKey: Buffer
    batch: PlannedBatch
  }): Promise<{ bocHashHex: string }>
}

export interface BatchCheckpointEntry {
  batchIndex: number
  seqnoUsed: number
  recipientCount: number
  subtotalTon: string
  bocHashHex: string
  confirmedAt: string
}

export async function waitForSeqnoAdvance(
  getSeqno: () => Promise<number>,
  previousSeqno: number,
  options: { pollIntervalMs?: number; timeoutMs?: number } = {},
): Promise<number> {
  const pollIntervalMs = options.pollIntervalMs ?? 2_500
  const timeoutMs = options.timeoutMs ?? 90_000
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const current = await getSeqno()
    if (current > previousSeqno) {
      return current
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for Wallet V5R1 seqno > ${previousSeqno}`,
  )
}

export function loadCompletedBatchIndices(checkpointPath?: string): Set<number> {
  const done = new Set<number>()
  if (!checkpointPath || !fs.existsSync(checkpointPath)) {
    return done
  }
  const lines = fs
    .readFileSync(checkpointPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
  for (const line of lines) {
    const parsed = JSON.parse(line) as BatchCheckpointEntry
    done.add(parsed.batchIndex)
  }
  return done
}

export function appendCheckpoint(
  checkpointPath: string | undefined,
  entry: BatchCheckpointEntry,
): void {
  if (!checkpointPath) return
  fs.appendFileSync(checkpointPath, `${JSON.stringify(entry)}\n`, "utf8")
}

export function createSignedV5BatchCell(
  wallet: WalletContractV5R1,
  args: { seqno: number; secretKey: Buffer; batch: PlannedBatch },
): Cell {
  return wallet.createTransfer({
    seqno: args.seqno,
    secretKey: args.secretKey,
    sendMode: DEFAULT_V5_SEND_MODE,
    messages: args.batch.messages,
  })
}

export async function createLiveTonV5Adapter(options: {
  mnemonicWords: string[]
  network: "mainnet" | "testnet"
  endpoint?: string
  apiKey?: string
}): Promise<{
  wallet: WalletContractV5R1
  senderFriendlyAddress: string
  secretKey: Buffer
  adapter: WalletProviderAdapter
}> {
  const keyPair = await mnemonicToPrivateKey(options.mnemonicWords)
  const wallet = WalletContractV5R1.create({
    workchain: 0,
    publicKey: keyPair.publicKey,
  })
  const defaultEndpoint =
    options.network === "testnet"
      ? "https://testnet.toncenter.com/api/v2/jsonRPC"
      : "https://toncenter.com/api/v2/jsonRPC"

  const client = new TonClient({
    endpoint: options.endpoint ?? defaultEndpoint,
    apiKey: options.apiKey,
  })
  const opened = client.open(wallet)
  const senderFriendlyAddress = wallet.address.toString({
    bounceable: false,
    testOnly: options.network === "testnet",
    urlSafe: true,
  })

  const adapter: WalletProviderAdapter = {
    getBalance: () => opened.getBalance(),
    getSeqno: () => opened.getSeqno(),
    sendBatch: async ({ seqno, secretKey, batch }) => {
      const transferCell = createSignedV5BatchCell(wallet, {
        seqno,
        secretKey,
        batch,
      })
      await opened.send(transferCell)
      return { bocHashHex: transferCell.hash().toString("hex") }
    },
  }

  return {
    wallet,
    senderFriendlyAddress,
    secretKey: Buffer.from(keyPair.secretKey),
    adapter,
  }
}

export async function executeBatchPlan(options: {
  plan: BatchSimulationPlan
  adapter: WalletProviderAdapter
  secretKey: Buffer
  checkpointPath?: string
  pollIntervalMs?: number
  timeoutMs?: number
  onProgress?: (msg: string) => void
}): Promise<BatchCheckpointEntry[]> {
  const { plan, adapter, secretKey, checkpointPath, onProgress } = options
  const completedIndices = loadCompletedBatchIndices(checkpointPath)
  const pendingBatches = plan.batches.filter(
    (b) => !completedIndices.has(b.batchIndex),
  )

  const remainingRequiredNano = pendingBatches.reduce(
    (acc, b) => acc + b.subtotalNano + b.estimatedFeeNano,
    0n,
  )
  const liveBalance = await adapter.getBalance()
  if (liveBalance < remainingRequiredNano) {
    throw new Error(
      `Insufficient wallet balance: have ${fromNano(liveBalance)} TON, need at least ${fromNano(remainingRequiredNano)} TON for ${pendingBatches.length} remaining batch(es)`,
    )
  }

  const results: BatchCheckpointEntry[] = []
  for (const batch of pendingBatches) {
    const seqno = await adapter.getSeqno()
    onProgress?.(
      `[Batch ${batch.batchIndex + 1}/${plan.batches.length}] Sending ${batch.recipients.length} transfers (seqno=${seqno}, subtotal=${fromNano(batch.subtotalNano)} TON)...`,
    )
    const { bocHashHex } = await adapter.sendBatch({
      seqno,
      secretKey,
      batch,
    })
    const newSeqno = await waitForSeqnoAdvance(
      () => adapter.getSeqno(),
      seqno,
      {
        pollIntervalMs: options.pollIntervalMs,
        timeoutMs: options.timeoutMs,
      },
    )
    const entry: BatchCheckpointEntry = {
      batchIndex: batch.batchIndex,
      seqnoUsed: seqno,
      recipientCount: batch.recipients.length,
      subtotalTon: fromNano(batch.subtotalNano),
      bocHashHex,
      confirmedAt: new Date().toISOString(),
    }
    appendCheckpoint(checkpointPath, entry)
    results.push(entry)
    onProgress?.(
      `[Batch ${batch.batchIndex + 1}/${plan.batches.length}] Confirmed on-chain (seqno ${seqno} -> ${newSeqno}, bocHash=${bocHashHex.slice(0, 16)}...)`,
    )
  }

  return results
}
