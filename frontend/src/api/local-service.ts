import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveAll, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 用工派工的字段名集中在这儿，完工结算要往派工记录上回写这些列。
const LABOR_KEY = 'labor'
const ACCEPTANCE_KEY = 'acceptance'
const LABOR_DONE = '已完工'
const LABOR_FIELDS = {
  code: '派工编号',
  area: '作业区域',
  category: '用工类别',
  headcount: '出工人数',
  leader: '带队人',
  workDate: '出工日期',
  workdays: '结算工日',
  rate: '工日单价',
  amount: '结算金额',
  finishDate: '完工日期',
  statusMirror: '派工状态',
} as const
// 探方验收单与派工清单共用的列，结算结果同步过去时写这些列。
const ACCEPTANCE_FIELDS = {
  code: '验收单号',
  target: '验收探方',
  category: '验收类别',
  inspector: '验收人',
  date: '验收日期',
  issues: '遗留问题数',
  conclusion: '验收结论',
  statusMirror: '验收状态',
} as const

// 现行工日单价（元/工日）：只在「这次完工」时取用工类别对应的价格。
// 一旦完工，单价会快照进派工记录；以后工价怎么调都不重算历史单。
const CURRENT_RATE_BY_CATEGORY: Record<string, number> = {
  技工: 260,
  普工: 180,
}
const FALLBACK_RATE = 200

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

function toCount(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0
}

function toMoney(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function todayISO(): string {
  const now = new Date()
  return monthKey(now) + `-${String(now.getDate()).padStart(2, '0')}`
}

function currentMonthKey(): string {
  return monthKey(new Date())
}

function monthKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  return `${date.getFullYear()}-${month}`
}

// 结算工日：按出工人数计，一个人一个工日（没有单独登记出勤天数时沿用这个口径）。
function settleWorkdays(headcount: number): number {
  return headcount
}

function currentRate(category: string): number {
  return CURRENT_RATE_BY_CATEGORY[category] ?? FALLBACK_RATE
}

// 已完工的派工保留完工当时快照下来的单价；缺快照的历史数据按当前默认工价补展示，
// 但不会把补出来的值写回派工记录，历史单不被这次修补重算。
function snapshotRate(row: EntryRow): number {
  const stored = toMoney(row[LABOR_FIELDS.rate])
  if (stored > 0) {
    return stored
  }
  return currentRate(String(row[LABOR_FIELDS.category] ?? ''))
}

// 验收清单里的一条记录对应一个派工编号：同编号完工只更新这一条，不新增、不重复计工日。
function acceptanceCodeOf(laborCode: string): string {
  return `ACCE-L-${laborCode.replace(/^LABO-/, '')}`
}

function buildAcceptanceRow(labor: EntryRow, id: number, workdays: number, amount: number, finishDate: string): EntryRow {
  const laborCode = String(labor[LABOR_FIELDS.code] ?? '')
  return {
    id,
    status: '已通过',
    pending: false,
    abnormal: false,
    [ACCEPTANCE_FIELDS.code]: acceptanceCodeOf(laborCode),
    [ACCEPTANCE_FIELDS.target]: labor[LABOR_FIELDS.area] ?? '',
    [ACCEPTANCE_FIELDS.category]: '派工完工结算',
    [ACCEPTANCE_FIELDS.inspector]: labor[LABOR_FIELDS.leader] ?? '',
    [ACCEPTANCE_FIELDS.date]: finishDate,
    [ACCEPTANCE_FIELDS.issues]: 0,
    [ACCEPTANCE_FIELDS.conclusion]: `派工${laborCode}完工，结算工日${workdays}，工价${snapshotRate(labor)}元/工日，合计${amount}元`,
    [ACCEPTANCE_FIELDS.statusMirror]: '已通过',
  }
}

// 完工与结算一次落库：派工记录回写工日/单价/金额、验收清单 upsert 对应验收单，
// 两个模块合在同一次持久化写入里。重复完工按已完工处理：不新增记录、不重复计工日，
// 验收单缺失时只用派工上已结算的值补同步，绝不再算一遍。
function completeLabor(row: EntryRow, acceptance: EntryRow[]): { labor: EntryRow[]; acceptance: EntryRow[] } {
  const labor = listRows(LABOR_KEY)
  const alreadyDone = String(row.status) === LABOR_DONE
  const laborCode = String(row[LABOR_FIELDS.code] ?? '')
  let updated: EntryRow
  let workdays: number
  let amount: number
  let finishDate: string

  if (alreadyDone) {
    // 已完工：工日、单价、金额全部沿用派工记录里已经结算的结果，绝不重新计算。
    workdays = toCount(row[LABOR_FIELDS.workdays])
    amount = toMoney(row[LABOR_FIELDS.amount])
    finishDate = String(row[LABOR_FIELDS.finishDate] ?? todayISO())
    updated = { ...row }
  } else {
    const headcount = toCount(row[LABOR_FIELDS.headcount])
    const rate = currentRate(String(row[LABOR_FIELDS.category] ?? ''))
    workdays = settleWorkdays(headcount)
    amount = roundMoney(workdays * rate)
    finishDate = todayISO()
    updated = {
      ...row,
      status: LABOR_DONE,
      pending: false,
      abnormal: false,
      [LABOR_FIELDS.workdays]: workdays,
      [LABOR_FIELDS.rate]: rate,
      [LABOR_FIELDS.amount]: amount,
      [LABOR_FIELDS.finishDate]: finishDate,
      [LABOR_FIELDS.statusMirror]: LABOR_DONE,
    }
  }

  const nextLabor = labor.map((item) => (Number(item.id) === Number(row.id) ? updated : item))
  const code = acceptanceCodeOf(laborCode)
  const existingIndex = acceptance.findIndex(
    (item) => String(item[ACCEPTANCE_FIELDS.code]) === code,
  )
  let nextAcceptance = acceptance
  if (existingIndex < 0) {
    const nextId = acceptance.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1
    nextAcceptance = [...acceptance, buildAcceptanceRow(updated, nextId, workdays, amount, finishDate)]
  } else if (alreadyDone) {
    // 派工早已完工但验收清单缺数据时，按历史结算结果补齐这一条（仍是同一条验收单）。
    const synced = buildAcceptanceRow(updated, Number(acceptance[existingIndex].id), workdays, amount, finishDate)
    nextAcceptance = acceptance.map((item, index) => (index === existingIndex ? synced : item))
  }

  saveAll({ [LABOR_KEY]: nextLabor, [ACCEPTANCE_KEY]: nextAcceptance })
  return { labor: nextLabor, acceptance: nextAcceptance }
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

// 业务模块的指标卡片：用工派工的「本月结算工日」从已完工派工的结算工日汇总，
// 列表页与运营概览都调这一个函数，读到的数必然一致。
export function moduleMetricCards(key: string): { label: string; value: number }[] {
  const meta = moduleMeta(key)
  const rows = listRows(key)
  return meta.metrics.map((label) => {
    if (key === LABOR_KEY && label === '本月结算工日') {
      const total = rows
        .filter((row) => String(row.status) === LABOR_DONE)
        .filter((row) => {
          const month = String(
            row[LABOR_FIELDS.finishDate] ?? row[LABOR_FIELDS.workDate] ?? '',
          ).slice(0, 7)
          return month === currentMonthKey()
        })
        .reduce((sum, row) => sum + toCount(row[LABOR_FIELDS.workdays]), 0)
      return { label, value: total }
    }
    const matched = meta.statuses.find((status) => label.includes(status))
    if (matched) {
      return { label, value: rows.filter((row) => String(row.status) === matched).length }
    }
    return { label, value: 0 }
  })
}

export function runAction(key: string, id: number, action: string): ActionResult {
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
  const current = rows[index]

  // 用工派工的确认完工：完工 + 结算 + 验收同步一起做，重复点击按已完工幂等处理。
  if (key === LABOR_KEY && action === '确认完工') {
    if (String(current.status) === LABOR_DONE) {
      completeLabor(current, listRows(ACCEPTANCE_KEY))
      return {
        ok: true,
        message: `${meta.entity}已完工，结算结果已保留，未重复登记完工记录、未重复计工日`,
      }
    }
    if (String(current.status) === '已取消') {
      return { ok: false, message: '派工已取消，不能确认完工' }
    }
    completeLabor(current, listRows(ACCEPTANCE_KEY))
    return { ok: true, message: `派工已完工并结算，结果已同步到探方验收清单` }
  }

  if (String(current.status) === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  // 若该模块有与状态同义的业务列（如「派工状态」「验收状态」），一并回写，避免两列对不上。
  const statusMirror = meta.fields.find((field) => field.endsWith('状态'))
  const updated: EntryRow = {
    ...current,
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
    ...(statusMirror ? { [statusMirror]: target } : {}),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
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
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
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
      metrics: moduleMetricCards(meta.key),
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
    {
      label: '本月结算工日',
      value: moduleMetricCards(LABOR_KEY).find((item) => item.label === '本月结算工日')?.value ?? 0,
    },
  ]
  return { cards, modules }
}
