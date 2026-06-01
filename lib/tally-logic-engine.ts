// lib/tally-logic-engine.ts
// Универсальный движок для Tally conditional logic
// Работает с любым опросником — просто передайте blocks массив

export type Answers = Record<string, any>
// key = blockGroupUuid поля (field.uuid в conditionals)
// value:
//   MULTIPLE_CHOICE  → string (uuid выбранного option)
//   CHECKBOXES       → string[] (uuid выбранных option'ов)
//   INPUT_NUMBER / LINEAR_SCALE → number
//   INPUT_TEXT       → string
//   пусто            → undefined | null | ""

type Comparison =
  | "IS" | "IS_NOT"
  | "IS_ANY_OF" | "IS_NOT_ANY_OF"
  | "IS_EMPTY" | "IS_NOT_EMPTY"
  | "CONTAINS" | "DOES_NOT_CONTAIN"
  | "GREATER_THAN" | "LESS_THAN"
  | "GREATER_THAN_OR_EQUAL" | "LESS_THAN_OR_EQUAL"

type ActionType = "JUMP_TO_PAGE" | "HIDE_BLOCKS" | "SHOW_BLOCKS"

interface ParsedConditional {
  fieldGroupUuid: string
  comparison: Comparison
  value: any
}

interface ParsedAction {
  type: ActionType
  jumpToPage?: string   // PAGE_BREAK uuid (groupUuid)
  blocks?: string[]     // groupUuid list
}

interface ParsedRule {
  logicalOperator: "AND" | "OR"
  conditionals: ParsedConditional[]
  actions: ParsedAction[]
}

export interface LogicResult {
  /** groupUuid'lar to'plami — bu gruppalar yashirilgan */
  hiddenGroupUuids: Set<string>
  /** JUMP_TO_PAGE triggered bo'lsa — maqsad PAGE_BREAK uuid, aks holda null */
  jumpToPageUuid: string | null
}

export interface TallyLogicEngine {
  evaluate(answers: Answers): LogicResult
  rules: ParsedRule[]
}

export function buildLogicEngine(blocks: any[]): TallyLogicEngine {
  const rules: ParsedRule[] = []

  for (const block of blocks) {
    if (block.type !== "CONDITIONAL_LOGIC") continue
    const payload = block.payload
    if (!payload) continue

    const conditionals: ParsedConditional[] = (payload.conditionals || []).map(
      (c: any): ParsedConditional => ({
        fieldGroupUuid:
          c.payload?.field?.blockGroupUuid ||
          c.payload?.field?.uuid ||
          "",
        comparison: c.payload?.comparison as Comparison,
        value: c.payload?.value,
      })
    )

    const actions: ParsedAction[] = (payload.actions || []).map(
      (a: any): ParsedAction => {
        if (a.type === "JUMP_TO_PAGE") {
          return { type: "JUMP_TO_PAGE", jumpToPage: a.payload?.jumpToPage }
        }
        if (a.type === "HIDE_BLOCKS") {
          return { type: "HIDE_BLOCKS", blocks: a.payload?.hideBlocks || [] }
        }
        if (a.type === "SHOW_BLOCKS") {
          return { type: "SHOW_BLOCKS", blocks: a.payload?.showBlocks || [] }
        }
        return { type: a.type as ActionType }
      }
    )

    rules.push({
      logicalOperator: (payload.logicalOperator as "AND" | "OR") || "AND",
      conditionals,
      actions,
    })
  }

  function evalCondition(cond: ParsedConditional, answers: Answers): boolean {
    const raw = answers[cond.fieldGroupUuid]
    const isEmpty =
      raw === undefined ||
      raw === null ||
      raw === "" ||
      (Array.isArray(raw) && raw.length === 0)

    switch (cond.comparison) {
      case "IS_EMPTY":
        return isEmpty

      case "IS_NOT_EMPTY":
        return !isEmpty

      case "IS":
        if (isEmpty) return false
        return String(raw) === String(cond.value)

      case "IS_NOT":
        if (isEmpty) return true
        return String(raw) !== String(cond.value)

      case "IS_ANY_OF": {
        if (isEmpty) return false
        const list: string[] = Array.isArray(cond.value)
          ? cond.value
          : [cond.value]
        return list.some((v) => String(v) === String(raw))
      }

      case "IS_NOT_ANY_OF": {
        if (isEmpty) return true
        const list: string[] = Array.isArray(cond.value)
          ? cond.value
          : [cond.value]
        return !list.some((v) => String(v) === String(raw))
      }

      case "CONTAINS": {
        if (isEmpty) return false
        const selected: string[] = Array.isArray(raw) ? raw : [String(raw)]
        return selected.includes(String(cond.value))
      }

      case "DOES_NOT_CONTAIN": {
        if (isEmpty) return true
        const selected: string[] = Array.isArray(raw) ? raw : [String(raw)]
        return !selected.includes(String(cond.value))
      }

      case "GREATER_THAN":
        if (isEmpty) return false
        return Number(raw) > Number(cond.value)

      case "LESS_THAN":
        if (isEmpty) return false
        return Number(raw) < Number(cond.value)

      case "GREATER_THAN_OR_EQUAL":
        if (isEmpty) return false
        return Number(raw) >= Number(cond.value)

      case "LESS_THAN_OR_EQUAL":
        if (isEmpty) return false
        return Number(raw) <= Number(cond.value)

      default:
        return false
    }
  }

  function evalRule(rule: ParsedRule, answers: Answers): boolean {
    if (rule.conditionals.length === 0) return false
    if (rule.logicalOperator === "OR") {
      return rule.conditionals.some((c) => evalCondition(c, answers))
    }
    return rule.conditionals.every((c) => evalCondition(c, answers))
  }

  // Blocks that appear in any SHOW_BLOCKS action are hidden by default —
  // they only become visible when the corresponding rule fires.
  const defaultHiddenByShowBlocks = new Set<string>()
  for (const rule of rules) {
    for (const action of rule.actions) {
      if (action.type === "SHOW_BLOCKS" && action.blocks) {
        for (const uuid of action.blocks) defaultHiddenByShowBlocks.add(uuid)
      }
    }
  }

  const DEBUG_UUIDS = new Set([
    "78a3dc24-2f52-4914-ba07-eeaa4be6ce69",
    "7055c04f-5eb1-4e4f-b1c5-ad2d9572ccef",
    "25dcabd7-6c43-4c58-9a9e-5d586b2ca0a2",
    "00ea5764-4727-4eca-9070-4ab4d1c615c0",
  ])

  function evaluate(answers: Answers): LogicResult {
    const hiddenByRule = new Set<string>(defaultHiddenByShowBlocks)
    const explicitlyHidden = new Set<string>()
    const shownByRule = new Set<string>()
    let jumpToPageUuid: string | null = null

    const debugB3Answer = answers["00ea5764-4727-4eca-9070-4ab4d1c615c0"]
    if (debugB3Answer !== undefined || [...Object.keys(answers)].some(k => k.startsWith("00ea5764"))) {
      console.log("[LogicEngine] evaluate called, B3 answer:", debugB3Answer, "| all keys:", Object.keys(answers).filter(k => DEBUG_UUIDS.has(k)))
    }

    for (const rule of rules) {
      const fired = evalRule(rule, answers)
      const ruleInvolvesDebug = rule.conditionals.some(c => DEBUG_UUIDS.has(c.fieldGroupUuid)) ||
        rule.actions.some(a => (a.blocks || []).some((u: string) => DEBUG_UUIDS.has(u)))
      if (ruleInvolvesDebug) {
        console.log("[LogicEngine] rule fired=" + fired, {
          op: rule.logicalOperator,
          conds: rule.conditionals.map(c => ({ field: c.fieldGroupUuid.slice(0, 8), cmp: c.comparison, val: c.value, ans: answers[c.fieldGroupUuid] })),
          actions: rule.actions.map(a => ({ type: a.type, blocks: a.blocks?.map((u: string) => u.slice(0, 8)) })),
        })
      }
      if (!fired) continue

      for (const action of rule.actions) {
        if (action.type === "JUMP_TO_PAGE" && action.jumpToPage) {
          if (!jumpToPageUuid) jumpToPageUuid = action.jumpToPage
        } else if (action.type === "HIDE_BLOCKS" && action.blocks) {
          for (const uuid of action.blocks) {
            hiddenByRule.add(uuid)
            explicitlyHidden.add(uuid)
          }
        } else if (action.type === "SHOW_BLOCKS" && action.blocks) {
          for (const uuid of action.blocks) shownByRule.add(uuid)
        }
      }
    }

    // SHOW_BLOCKS overrides default-hidden-by-SHOW_BLOCKS,
    // but explicit HIDE_BLOCKS rules take priority over SHOW_BLOCKS
    for (const uuid of shownByRule) {
      if (!explicitlyHidden.has(uuid)) hiddenByRule.delete(uuid)
    }

    const debugHidden78 = hiddenByRule.has("78a3dc24-2f52-4914-ba07-eeaa4be6ce69")
    const debugHidden70 = hiddenByRule.has("7055c04f-5eb1-4e4f-b1c5-ad2d9572ccef")
    if (debugB3Answer !== undefined || debugHidden78 || debugHidden70) {
      console.log("[LogicEngine] result: 78a3dc24 hidden=" + debugHidden78 + " 7055c04f hidden=" + debugHidden70 + " | defaultHidden has 78a3dc24=" + defaultHiddenByShowBlocks.has("78a3dc24-2f52-4914-ba07-eeaa4be6ce69"))
    }

    return { hiddenGroupUuids: hiddenByRule, jumpToPageUuid }
  }

  return { evaluate, rules }
}