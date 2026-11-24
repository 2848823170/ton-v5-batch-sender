import { fromNano, internal, type MessageRelaxed, SendMode } from "@ton/core"
import type { RecipientRow } from "./csv-parser.js"

/**
 * Wallet V5R1 (`WalletContractV5R1`) supports up to 255 outgoing actions in a single external message
 * (compared to 4 messages in Wallet V4R2).
 */
export const V5R1_MAX_MESSAGES_PER_BATCH = 255

/** Conservative fee estimation constants (in nanoTON) for pre-flight balance simulation */
export const BASE_EXTERNAL_TX_FEE_NANO = 8_000_000n // 0.008 TON external ingress + storage reserve
export const PER_INTERNAL_MSG_FEE_NANO = 4_500_000n // ~0.0045 TON forward + action fee per transfer

export interface PlannedBatch {
  batchIndex: number
  recipients: RecipientRow[]
  messages: MessageRelaxed[]
  subtotalNano: bigint
  estimatedFeeNano: bigint
}

export interface BatchSimulationPlan {
  maxPerBatch: number
  totalRecipients: number
  batches: PlannedBatch[]
  totalTransferNano: bigint
  totalEstimatedFeeNano: bigint
  totalRequiredBalanceNano: bigint
  summary: {
    totalTransferTon: string
    totalEstimatedFeeTon: string
    totalRequiredBalanceTon: string
    v4EquivalentTxCount: number
    txReductionFactor: number
  }
}

export function buildBatchPlan(
  recipients: RecipientRow[],
  maxPerBatch: number = V5R1_MAX_MESSAGES_PER_BATCH,
): BatchSimulationPlan {
  if (!Number.isInteger(maxPerBatch) || maxPerBatch < 1 || maxPerBatch > V5R1_MAX_MESSAGES_PER_BATCH) {
    throw new Error(
      `maxPerBatch must be an integer in 1..${V5R1_MAX_MESSAGES_PER_BATCH} (got ${maxPerBatch})`,
    )
  }
  if (recipients.length === 0) {
    throw new Error("Cannot build batch plan for 0 recipients")
  }

  const batches: PlannedBatch[] = []
  let totalTransferNano = 0n
  let totalEstimatedFeeNano = 0n

  for (let offset = 0; offset < recipients.length; offset += maxPerBatch) {
    const slice = recipients.slice(offset, offset + maxPerBatch)
    const messages = slice.map((r) =>
      internal({
        to: r.address,
        value: r.amountNano,
        bounce: r.bounce,
        body: r.comment ? r.comment : undefined,
      }),
    )
    const subtotalNano = slice.reduce((acc, r) => acc + r.amountNano, 0n)
    const estimatedFeeNano =
      BASE_EXTERNAL_TX_FEE_NANO +
      BigInt(slice.length) * PER_INTERNAL_MSG_FEE_NANO

    batches.push({
      batchIndex: batches.length,
      recipients: slice,
      messages,
      subtotalNano,
      estimatedFeeNano,
    })

    totalTransferNano += subtotalNano
    totalEstimatedFeeNano += estimatedFeeNano
  }

  const totalRequiredBalanceNano = totalTransferNano + totalEstimatedFeeNano
  const v4EquivalentTxCount = Math.ceil(recipients.length / 4)

  return {
    maxPerBatch,
    totalRecipients: recipients.length,
    batches,
    totalTransferNano,
    totalEstimatedFeeNano,
    totalRequiredBalanceNano,
    summary: {
      totalTransferTon: fromNano(totalTransferNano),
      totalEstimatedFeeTon: fromNano(totalEstimatedFeeNano),
      totalRequiredBalanceTon: fromNano(totalRequiredBalanceNano),
      v4EquivalentTxCount,
      txReductionFactor: Number(
        (v4EquivalentTxCount / batches.length).toFixed(2),
      ),
    },
  }
}

export const DEFAULT_V5_SEND_MODE =
  SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS
