// Usage: node scripts/check-logic.mjs "C:/Users/Санжар/Desktop/Текстовый документ.txt"
// Shows all questions, which are hidden by default, and what triggers each to appear.

import { readFileSync } from "fs"

const filePath = process.argv[2]
if (!filePath) {
  console.error("Usage: node scripts/check-logic.mjs <path-to-json.txt>")
  process.exit(1)
}

const raw = readFileSync(filePath, "utf-8")
const data = JSON.parse(raw)
const blocks = data.blocks

// ── Build logic engine (mirrors lib/tally-logic-engine.ts) ──────────────────

const rules = []
for (const block of blocks) {
  if (block.type !== "CONDITIONAL_LOGIC") continue
  const payload = block.payload
  if (!payload) continue
  const conditionals = (payload.conditionals || []).map((c) => ({
    fieldGroupUuid: c.payload?.field?.blockGroupUuid || c.payload?.field?.uuid || "",
    comparison: c.payload?.comparison,
    value: c.payload?.value,
  }))
  const actions = (payload.actions || []).map((a) => {
    if (a.type === "JUMP_TO_PAGE") return { type: "JUMP_TO_PAGE", jumpToPage: a.payload?.jumpToPage }
    if (a.type === "HIDE_BLOCKS") return { type: "HIDE_BLOCKS", blocks: a.payload?.hideBlocks || [] }
    if (a.type === "SHOW_BLOCKS") return { type: "SHOW_BLOCKS", blocks: a.payload?.showBlocks || [] }
    return { type: a.type }
  })
  rules.push({ logicalOperator: payload.logicalOperator || "AND", conditionals, actions })
}

const defaultHiddenByShowBlocks = new Set()
for (const rule of rules) {
  for (const action of rule.actions) {
    if (action.type === "SHOW_BLOCKS" && action.blocks) {
      for (const uuid of action.blocks) defaultHiddenByShowBlocks.add(uuid)
    }
  }
}

// ── Parse questions (simplified) ────────────────────────────────────────────

const skipTypes = new Set(["FORM_TITLE", "PAGE_BREAK", "HEADING_2", "CONDITIONAL_LOGIC", "HIDDEN_FIELDS"])

function extractText(schema) {
  if (!schema) return ""
  if (typeof schema === "string") return schema
  if (!Array.isArray(schema)) return ""
  return schema.map((item) => {
    if (typeof item === "string") return item
    if (!Array.isArray(item)) return ""
    const first = item[0]
    if (typeof first === "string") return first
    if (Array.isArray(first)) {
      return first.map((fragment) => {
        if (typeof fragment === "string") return fragment
        if (Array.isArray(fragment) && typeof fragment[0] === "string") return fragment[0]
        return ""
      }).join("")
    }
    return ""
  }).filter(Boolean).join("").trim()
}

const titleBlocks = blocks.filter((b) => b.type === "TITLE" && b.groupType === "QUESTION")
const questions = titleBlocks.map((titleBlock, qi) => {
  const titleBlockIndex = blocks.indexOf(titleBlock)
  const prevTitleBlockIndex = qi > 0 ? blocks.indexOf(titleBlocks[qi - 1]) + 1 : 0
  const nextTitleBlockIndex = qi < titleBlocks.length - 1 ? blocks.indexOf(titleBlocks[qi + 1]) : blocks.length
  const siblingBlocks = blocks.slice(titleBlockIndex + 1, nextTitleBlockIndex)
  const firstSibling = siblingBlocks.find((b) => !skipTypes.has(b.type))
  const groupType = firstSibling?.groupType || titleBlock.groupType || ""

  let type = "text"
  let id = titleBlock.groupUuid

  if (groupType === "LINEAR_SCALE" || siblingBlocks.some((b) => b.type === "LINEAR_SCALE")) {
    const scaleBlock = siblingBlocks.find((b) => b.type === "LINEAR_SCALE") || firstSibling
    id = scaleBlock?.groupUuid || titleBlock.groupUuid
    type = "linear_scale"
  } else if (groupType === "INPUT_NUMBER" || siblingBlocks.some((b) => b.type === "INPUT_NUMBER")) {
    const inputBlock = siblingBlocks.find((b) => b.type === "INPUT_NUMBER")
    id = inputBlock?.groupUuid || titleBlock.groupUuid
    type = "number"
  } else if (groupType === "CHECKBOXES" || siblingBlocks.some((b) => b.type === "CHECKBOX")) {
    const optionBlocks = siblingBlocks.filter((b) => b.type === "CHECKBOX")
    id = optionBlocks[0]?.groupUuid || titleBlock.groupUuid
    type = "checkbox"
  } else if (groupType === "DROPDOWN" || siblingBlocks.some((b) => b.type === "DROPDOWN_OPTION")) {
    const optionBlocks = siblingBlocks.filter((b) => b.type === "DROPDOWN_OPTION")
    id = optionBlocks[0]?.groupUuid || titleBlock.groupUuid
    type = "dropdown"
  } else if (siblingBlocks.some((b) => b.type === "MULTIPLE_CHOICE_OPTION" || b.groupType === "MULTIPLE_CHOICE")) {
    const optionBlocks = siblingBlocks.filter((b) => b.type === "MULTIPLE_CHOICE_OPTION" || b.groupType === "MULTIPLE_CHOICE")
    id = optionBlocks[0]?.groupUuid || titleBlock.groupUuid
    type = "multiple_choice"
  } else if (groupType === "YES_NO") {
    id = titleBlock.groupUuid
    type = "yes_no"
  }

  const title = extractText(titleBlock.payload?.safeHTMLSchema) || titleBlock.payload?.title || ""
  return { id, type, title: title.slice(0, 80) }
}).filter((q) => q.title.trim().length > 0)

// ── Find what triggers each LINEAR_SCALE to show ────────────────────────────

console.log("\n=== ALL QUESTIONS ===\n")
questions.forEach((q, i) => {
  const hidden = defaultHiddenByShowBlocks.has(q.id) ? " [HIDDEN by default]" : ""
  console.log(`${String(i + 1).padStart(3)}. [${q.type.padEnd(14)}] ${q.title}${hidden}`)
})

console.log("\n=== LINEAR_SCALE QUESTIONS & TRIGGERS ===\n")
for (const q of questions) {
  if (q.type !== "linear_scale") continue
  const isHidden = defaultHiddenByShowBlocks.has(q.id)
  console.log(`NPS: "${q.title}"`)
  console.log(`  id: ${q.id}`)
  console.log(`  hidden by default: ${isHidden}`)

  if (isHidden) {
    const showRules = rules.filter((r) =>
      r.actions.some((a) => a.type === "SHOW_BLOCKS" && a.blocks?.includes(q.id))
    )
    for (const rule of showRules) {
      const conds = rule.conditionals.map((c) => {
        const refQ = questions.find((x) => x.id === c.fieldGroupUuid)
        const label = refQ ? `"${refQ.title}"` : c.fieldGroupUuid
        return `    ${label} ${c.comparison} ${JSON.stringify(c.value)}`
      })
      console.log(`  appears when (${rule.logicalOperator}):`)
      conds.forEach((c) => console.log(c))
    }
  }
  console.log()
}

console.log(`Total questions parsed: ${questions.length}`)
console.log(`Total hidden by default: ${[...defaultHiddenByShowBlocks].filter(uuid => questions.some(q => q.id === uuid)).length}`)
