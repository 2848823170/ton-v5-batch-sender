import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { Address, toNano } from "@ton/core"
import { mnemonicNew, mnemonicToPrivateKey } from "@ton/crypto"
import { WalletContractV5R1 } from "@ton/ton"
import {
  buildBatchPlan,
  V5R1_MAX_MESSAGES_PER_BATCH,
} from "../src/batch-planner.js"
import { parseAndValidateRecipientsCsv } from "../src/csv-parser.js"
import {
  createSignedV5BatchCell,
  executeBatchPlan,
  type WalletProviderAdapter,
} from "../src/sender.js"

function makeDeterministicAddress(index: number, bounceable = false): string {
  const hash = Buffer.alloc(32, 0)
  hash.writeUInt32BE(index + 1, 28)
  return new Address(0, hash).toString({ bounceable, urlSafe: true })
}

test("infers bounce=false for UQ non-bounceable wallets and bounce=true for EQ contract addresses", () => {
  const uq = makeDeterministicAddress(1, false)
  const eq = makeDeterministicAddress(2, true)
  const csv = [
    "address,amount_ton,comment,bounce",
    `${uq},1.5,"User payout, tier A",`,
    `${eq},2.25,Contract deposit,`,
  ].join("\n")

  const res = parseAndValidateRecipientsCsv(csv, { network: "testnet" })
  assert.equal(res.recipients.length, 2)
  assert.equal(res.recipients[0].bounce, false)
  assert.equal(res.recipients[0].comment, "User payout, tier A")
  assert.equal(res.recipients[1].bounce, true)
  assert.equal(res.totalNano, toNano("3.75"))
  assert.deepEqual(res.duplicateAddresses, [])
})

test("rejects dust, negative amounts, malformed addresses, and testnet-flagged addresses on mainnet", () => {
  const validUq = makeDeterministicAddress(5, false)
  assert.throws(
    () => parseAndValidateRecipientsCsv(`address,amount_ton\n${validUq},0`, {}),
    /dust guard|invalid/i,
  )
  assert.throws(
    () =>
      parseAndValidateRecipientsCsv(`address,amount_ton\n${validUq},-1.5`, {}),
    /invalid positive TON amount/i,
  )
  assert.throws(
    () =>
      parseAndValidateRecipientsCsv(
        "address,amount_ton\nnot_a_ton_address,1.0",
        {},
      ),
    /invalid TON address/i,
  )

  const testOnlyAddr = Address.parseFriendly(validUq).address.toString({
    bounceable: false,
    testOnly: true,
    urlSafe: true,
  })
  assert.throws(
    () =>
      parseAndValidateRecipientsCsv(`address,amount_ton\n${testOnlyAddr},1.0`, {
        network: "mainnet",
      }),
    /testnet-flagged address/i,
  )
})

test("chunks 600 recipients into [255, 255, 90] V5R1 batches and signs a real 255-message BOC cell", async () => {
  const rows = ["address,amount_ton,comment"]
  for (let i = 0; i < 600; i++) {
    rows.push(`${makeDeterministicAddress(i, false)},0.01,Transfer #${i + 1}`)
  }
  const parsed = parseAndValidateRecipientsCsv(rows.join("\n"), {
    network: "testnet",
  })
  const plan = buildBatchPlan(parsed.recipients)

  assert.equal(plan.maxPerBatch, V5R1_MAX_MESSAGES_PER_BATCH)
  assert.equal(plan.batches.length, 3)
  assert.deepEqual(
    plan.batches.map((b) => b.recipients.length),
    [255, 255, 90],
  )
  assert.equal(plan.summary.totalTransferTon, "6")
  assert.equal(plan.summary.v4EquivalentTxCount, 150)

  // Verify @ton/ton WalletContractV5R1 actually packs and signs all 255 actions into one Cell!
  const mnemonic = await mnemonicNew(24)
  const keyPair = await mnemonicToPrivateKey(mnemonic)
  const wallet = WalletContractV5R1.create({
    workchain: 0,
    publicKey: keyPair.publicKey,
  })
  const signedCell = createSignedV5BatchCell(wallet, {
    seqno: 0,
    secretKey: Buffer.from(keyPair.secretKey),
    batch: plan.batches[0],
  })
  const bocBytes = signedCell.toBoc()
  assert.ok(bocBytes.byteLength > 200)
  assert.equal(signedCell.hash().length, 32)
})

test("executes multi-batch send with seqno confirmation polling and resumes cleanly from JSONL checkpoint", async () => {
  const rows = ["address,amount_ton,comment"]
  for (let i = 0; i < 7; i++) {
    rows.push(`${makeDeterministicAddress(100 + i, false)},0.5,Item ${i}`)
  }
  const parsed = parseAndValidateRecipientsCsv(rows.join("\n"))
  const plan = buildBatchPlan(parsed.recipients, 3) // [3, 3, 1]

  const mnemonic = await mnemonicNew(24)
  const keyPair = await mnemonicToPrivateKey(mnemonic)
  const wallet = WalletContractV5R1.create({
    workchain: 0,
    publicKey: keyPair.publicKey,
  })

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ton-v5-test-"))
  const ckptPath = path.join(tmpDir, "run.checkpoint.jsonl")

  let simulatedSeqno = 10
  const sentBatchIndices: number[] = []
  const mockAdapter: WalletProviderAdapter = {
    getBalance: async () => toNano("50"),
    getSeqno: async () => simulatedSeqno,
    sendBatch: async ({ seqno, secretKey, batch }) => {
      const cell = createSignedV5BatchCell(wallet, { seqno, secretKey, batch })
      sentBatchIndices.push(batch.batchIndex)
      setTimeout(() => {
        simulatedSeqno += 1
      }, 15)
      return { bocHashHex: cell.hash().toString("hex") }
    },
  }

  const firstRun = await executeBatchPlan({
    plan,
    adapter: mockAdapter,
    secretKey: Buffer.from(keyPair.secretKey),
    checkpointPath: ckptPath,
    pollIntervalMs: 10,
    timeoutMs: 2_000,
  })
  assert.equal(firstRun.length, 3)
  assert.deepEqual(sentBatchIndices, [0, 1, 2])
  assert.equal(simulatedSeqno, 13)

  // Re-running against the same checkpoint file sends 0 duplicate batches
  const secondRun = await executeBatchPlan({
    plan,
    adapter: mockAdapter,
    secretKey: Buffer.from(keyPair.secretKey),
    checkpointPath: ckptPath,
    pollIntervalMs: 10,
    timeoutMs: 2_000,
  })
  assert.equal(secondRun.length, 0)
  assert.deepEqual(sentBatchIndices, [0, 1, 2])

  fs.rmSync(tmpDir, { recursive: true, force: true })
})
