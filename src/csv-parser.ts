import { Address, toNano } from "@ton/core"

export interface RecipientRow {
  rowNumber: number
  rawAddress: string
  address: Address
  friendlyAddress: string
  amountTon: string
  amountNano: bigint
  comment: string
  bounce: boolean
  isTestOnlyFlag: boolean
}

export interface CsvValidationResult {
  recipients: RecipientRow[]
  totalNano: bigint
  duplicateAddresses: string[]
}

const MIN_TRANSFER_NANO = 1_000n // 0.000001 TON anti-dust floor

function splitCsvLine(line: string): string[] {
  const fields: string[] = []
  let cur = ""
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"'
        i += 1
      } else {
        inQuotes = !inQuotes
      }
    } else if (ch === "," && !inQuotes) {
      fields.push(cur.trim())
      cur = ""
    } else {
      cur += ch
    }
  }
  fields.push(cur.trim())
  return fields
}

export function parseAndValidateRecipientsCsv(
  csvText: string,
  options: { rejectTestOnlyOnMainnet?: boolean; network?: "mainnet" | "testnet" } = {},
): CsvValidationResult {
  const lines = csvText
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"))

  if (lines.length === 0) {
    throw new Error("CSV input is empty")
  }

  const firstCells = splitCsvLine(lines[0]).map((c) => c.toLowerCase())
  const hasHeader =
    firstCells[0] === "address" ||
    firstCells[0] === "recipient" ||
    firstCells[0] === "wallet"
  const startIndex = hasHeader ? 1 : 0

  if (lines.length <= startIndex) {
    throw new Error("CSV contains header row only and zero recipient rows")
  }

  const recipients: RecipientRow[] = []
  const seenCounts = new Map<string, number>()
  let totalNano = 0n

  for (let idx = startIndex; idx < lines.length; idx++) {
    const rowNumber = idx + 1
    const cols = splitCsvLine(lines[idx])
    const [rawAddress = "", rawAmount = "", comment = "", rawBounce = ""] = cols

    if (!rawAddress) {
      throw new Error(`Row ${rowNumber}: missing TON recipient address`)
    }
    if (!rawAmount) {
      throw new Error(`Row ${rowNumber}: missing amount_ton value`)
    }

    let address: Address
    let inferredBounce = false
    let isTestOnlyFlag = false

    if (Address.isFriendly(rawAddress)) {
      const parsed = Address.parseFriendly(rawAddress)
      address = parsed.address
      // CRITICAL TON SAFETY: UQ... / 0Q... non-bounceable addresses default to bounce=false
      // so transfers to uninitialized user wallets are credited rather than bounced!
      inferredBounce = parsed.isBounceable
      isTestOnlyFlag = parsed.isTestOnly
    } else if (Address.isRaw(rawAddress)) {
      address = Address.parseRaw(rawAddress)
      inferredBounce = false
    } else {
      throw new Error(`Row ${rowNumber}: invalid TON address "${rawAddress}"`)
    }

    if (
      options.network === "mainnet" &&
      options.rejectTestOnlyOnMainnet !== false &&
      isTestOnlyFlag
    ) {
      throw new Error(
        `Row ${rowNumber}: testnet-flagged address "${rawAddress}" rejected on mainnet`,
      )
    }

    let bounce = inferredBounce
    if (rawBounce !== "") {
      const low = rawBounce.toLowerCase()
      if (low === "true" || low === "1" || low === "yes") bounce = true
      else if (low === "false" || low === "0" || low === "no") bounce = false
      else {
        throw new Error(
          `Row ${rowNumber}: invalid bounce value "${rawBounce}" (expected true/false)`,
        )
      }
    }

    if (!/^\d+(?:\.\d{1,9})?$/.test(rawAmount)) {
      throw new Error(
        `Row ${rowNumber}: invalid positive TON amount "${rawAmount}"`,
      )
    }

    const amountNano = toNano(rawAmount)
    if (amountNano < MIN_TRANSFER_NANO) {
      throw new Error(
        `Row ${rowNumber}: amount ${rawAmount} TON is below minimum 0.000001 TON dust guard`,
      )
    }

    if (Buffer.byteLength(comment, "utf8") > 512) {
      throw new Error(`Row ${rowNumber}: comment exceeds 512-byte safety cap`)
    }

    const canonical = address.toRawString()
    seenCounts.set(canonical, (seenCounts.get(canonical) ?? 0) + 1)
    const friendlyAddress = address.toString({
      bounceable: bounce,
      testOnly: options.network === "testnet",
      urlSafe: true,
    })

    recipients.push({
      rowNumber,
      rawAddress,
      address,
      friendlyAddress,
      amountTon: rawAmount,
      amountNano,
      comment,
      bounce,
      isTestOnlyFlag,
    })
    totalNano += amountNano
  }

  const duplicateAddresses = [...seenCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([raw]) => Address.parseRaw(raw).toString({ bounceable: false, urlSafe: true }))

  return {
    recipients,
    totalNano,
    duplicateAddresses,
  }
}
