import { MODULE_BY_KEY } from '@/data/modules'
import {
  LABOR_KEY,
  STATUS_CANCELLED,
  STATUS_COMPLETED,
  STATUS_DISPATCHED,
  STATUS_PENDING,
  monthSettledWorkdays,
  settleCompletion,
} from '@/data/labor'
import { allRows, listRows, resetRows, saveAll, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  if (key === LABOR_KEY) {
    return runLaborAction(id, action)
  }
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const statusField = meta.fields.find((field) => field.endsWith('状态'))
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
    ...(statusField ? { [statusField]: target } : {}),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// 派工的状态流转走自己的校验：完工与结算由 settleCompletion 一次落库，
// 其余动作（提交派工、取消派工）就地更新并同步派工状态字段。
function runLaborAction(id: number, action: string): ActionResult {
  const rows = listRows(LABOR_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的出工记录` }
  }
  const current = String(rows[index].status)

  if (action === '确认完工') {
    const result = settleCompletion(allRows(), id)
    if (result.ok) {
      saveAll(result.snapshot)
    }
    return { ok: result.ok, message: result.message }
  }

  let target: string
  if (action === '提交派工') {
    if (current === STATUS_COMPLETED) {
      return { ok: false, message: '已完工的派工不能重新提交，结算结果需保留' }
    }
    target = STATUS_DISPATCHED
  } else if (action === '取消派工') {
    if (current === STATUS_COMPLETED) {
      return { ok: false, message: '已完工结算的派工不能取消，工日与工价已冻结' }
    }
    target = STATUS_CANCELLED
  } else {
    return { ok: false, message: `出工记录没有登记「${action}」这个动作` }
  }

  if (current === target) {
    return { ok: false, message: `出工记录已经是「${target}」，不用重复操作` }
  }
  if (action === '提交派工' && current !== STATUS_PENDING) {
    return { ok: false, message: `当前为「${current}」的派工不能提交` }
  }
  if (action === '取消派工' && current !== STATUS_PENDING && current !== STATUS_DISPATCHED) {
    return { ok: false, message: `当前为「${current}」的派工不能取消` }
  }

  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target === STATUS_DISPATCHED,
    abnormal: target === STATUS_CANCELLED,
    派工状态: target,
  }
  const next = rows.slice()
  next[index] = updated
  saveRows(LABOR_KEY, next)
  return { ok: true, message: `出工记录已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  // 概览的本月结算工日与用工派工列表共用同一个读数口径，两边一起变。
  const monthWorkdays = monthSettledWorkdays(rows[LABOR_KEY] ?? [])
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
    { label: '本月结算工日', value: monthWorkdays },
  ]
  return { cards, modules }
}
