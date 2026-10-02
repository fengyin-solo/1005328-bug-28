import type { EntryRow } from './types'

// 用工派工的完工结算规则集中在这里，列表与概览都从同一份口径读数，
// 避免页面各自算一遍、刷新后对不上的情况。

export const LABOR_KEY = 'labor'
export const ACCEPTANCE_KEY = 'acceptance'

export const STATUS_PENDING = '待派工'
export const STATUS_DISPATCHED = '已派工'
export const STATUS_COMPLETED = '已完工'
export const STATUS_CANCELLED = '已取消'

type Snapshot = Record<string, EntryRow[]>

function toNumber(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100
}

export function currentMonthPrefix(now: Date = new Date()): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  return `${year}-${month}`
}

/** 已完工且结算日期落在本月的派工记录（本月结算工日的唯一读数口径）。 */
export function settledThisMonth(rows: EntryRow[], now: Date = new Date()): EntryRow[] {
  const prefix = currentMonthPrefix(now)
  return rows.filter(
    (row) => String(row.status) === STATUS_COMPLETED
      && String(row['结算日期'] ?? '').startsWith(prefix),
  )
}

export function monthSettledWorkdays(rows: EntryRow[], now: Date = new Date()): number {
  return settledThisMonth(rows, now).reduce((sum, row) => sum + toNumber(row['结算工日']), 0)
}

export function countByStatus(rows: EntryRow[], status: string): number {
  return rows.filter((row) => String(row.status) === status).length
}

// 验收单号按既有 ACCE-XXXX 的顺序号往后排。
function nextAcceptanceNo(rows: EntryRow[]): string {
  let max = 0
  for (const row of rows) {
    const code = String(row['验收单号'] ?? '')
    const match = /^ACCE-(\d+)$/.exec(code)
    if (match) {
      max = Math.max(max, Number(match[1]))
    }
  }
  return `ACCE-${String(max + 1).padStart(4, '0')}`
}

/**
 * 完工与结算一次落库：在内存快照里同时改派工记录、生成结算快照、同步验收清单，
 * 最后由调用方一次性写回 localStorage，中间不产生半成品数据。
 *
 * - 已完工再次提交：按已完工幂等处理，不新增完工记录、不重复计工日；
 * - 历史已结算派工：沿用记录里冻结的结算工价，绝不跟着本次规则重算。
 */
export function settleCompletion(
  snapshot: Snapshot,
  id: number,
  now: Date = new Date(),
): { ok: boolean; message: string; snapshot: Snapshot } {
  const laborRows = snapshot[LABOR_KEY] ?? []
  const index = laborRows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的出工记录`, snapshot }
  }
  const target = laborRows[index]
  const current = String(target.status)

  // 幂等：同一派工编号重复点确认完工，按已完工直接返回，不再写一条、不再算一遍。
  if (current === STATUS_COMPLETED) {
    return {
      ok: true,
      message: `出工记录已完工结算（工日 ${target['结算工日'] ?? 0}），无需重复操作`,
      snapshot,
    }
  }
  if (current !== STATUS_DISPATCHED) {
    return {
      ok: false,
      message: `当前为「${current}」的派工不能确认完工，已派工后才能结算`,
      snapshot,
    }
  }

  // 结算口径：出工一人计一个工日；工价沿用派工时登记的单价，冻结到结算快照。
  const workdays = Math.round(toNumber(target['出工人数']))
  const wageRate = roundMoney(toNumber(target['派工工价']))
  const settledAt = formatDate(now)
  const dispatchNo = String(target['派工编号'] ?? id)

  const settled: EntryRow = {
    ...target,
    status: STATUS_COMPLETED,
    pending: false,
    abnormal: false,
    结算工日: workdays,
    结算工价: wageRate,
    结算金额: roundMoney(workdays * wageRate),
    结算日期: settledAt,
    派工状态: STATUS_COMPLETED,
  }

  const nextLabor = laborRows.slice()
  nextLabor[index] = settled

  // 结算结果同步到验收清单：同一派工只对应一条验收单，重复结算不重复生成。
  const acceptanceRows = snapshot[ACCEPTANCE_KEY] ?? []
  const alreadySynced = acceptanceRows.some(
    (row) => String(row['来源派工编号'] ?? '') === dispatchNo,
  )
  let nextAcceptance = acceptanceRows
  if (!alreadySynced) {
    nextAcceptance = [
      ...acceptanceRows,
      {
        id: nextId(acceptanceRows),
        status: '待验收',
        pending: true,
        abnormal: false,
        验收单号: nextAcceptanceNo(acceptanceRows),
        验收探方: String(target['作业区域'] ?? ''),
        验收类别: '派工完工结算',
        验收人: String(target['带队人'] ?? ''),
        验收日期: settledAt,
        遗留问题数: 0,
        验收结论: `派工 ${dispatchNo} 完工，结算工日 ${workdays}，结算金额 ${roundMoney(
          workdays * wageRate,
        )} 元`,
        验收状态: '待验收',
        来源派工编号: dispatchNo,
      },
    ]
  }

  return {
    ok: true,
    message: `出工记录已完工并结算：工日 ${workdays}，结算金额 ${roundMoney(
      workdays * wageRate,
    )} 元，已同步验收清单`,
    snapshot: { ...snapshot, [LABOR_KEY]: nextLabor, [ACCEPTANCE_KEY]: nextAcceptance },
  }
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function formatDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
