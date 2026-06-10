// Usage: node scripts/verify-session.mjs <session_id> <admin_token> [form_json.txt]
// Example: node scripts/verify-session.mjs session_101_1778745612_d85450 eyJhbGci... "C:/Users/Санжар/Desktop/Текстовый документ.txt"

import { readFileSync } from "fs"

const sessionId = process.argv[2]
const token = process.argv[3]
const formJsonPath = process.argv[4] || "C:/Users/Санжар/Desktop/Текстовый документ.txt"

if (!sessionId || !token) {
  console.error("Usage: node scripts/verify-session.mjs <session_id> <admin_token> [form_json.txt]")
  process.exit(1)
}

const API_BASE = "https://offline.prosurvey.uz"

// ── Fetch session answers ────────────────────────────────────────────────────
console.log(`\nFetching session: ${sessionId}...`)
let sessionData
try {
  const res = await fetch(`${API_BASE}/api/admin/sessions-full?limit=500`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  const data = await res.json()
  const sessions = Array.isArray(data) ? data : (data.sessions || data.items || [])
  sessionData = sessions.find(s => s.session_id === sessionId || s.id === sessionId)
  if (!sessionData) {
    console.error(`Session ${sessionId} not found in ${sessions.length} sessions`)
    console.log("First session keys:", sessions[0] ? Object.keys(sessions[0]) : "none")
    process.exit(1)
  }
} catch (e) {
  console.error("Failed to fetch sessions:", e.message)
  process.exit(1)
}

const rawAnswers = sessionData.answers || sessionData.survey_answers || []
console.log(`Found session. Answers count: ${rawAnswers.length}`)

// Convert answers array to map: questionId → answerText
const answersMap = {}
for (const a of rawAnswers) {
  const key = a.questionId || a.key || a.question_id || a.id
  const val = a.answerText ?? a.value
  if (key !== undefined) answersMap[key] = val
}

// ── Parse form JSON ──────────────────────────────────────────────────────────
const raw = readFileSync(formJsonPath, "utf-8")
const formData = JSON.parse(raw)
const blocks = formData.blocks

// Build logic engine
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

function isEmpty(val) {
  return val === undefined || val === null || val === "" || (Array.isArray(val) && val.length === 0)
}

function evalCondition(cond, answers) {
  const raw = answers[cond.fieldGroupUuid]
  const empty = isEmpty(raw)
  switch (cond.comparison) {
    case "IS_EMPTY": return empty
    case "IS_NOT_EMPTY": return !empty
    case "IS": return !empty && String(raw) === String(cond.value)
    case "IS_NOT": return empty ? true : String(raw) !== String(cond.value)
    case "CONTAINS": return !empty && (Array.isArray(raw) ? raw : [String(raw)]).includes(String(cond.value))
    case "DOES_NOT_CONTAIN": return empty ? true : !(Array.isArray(raw) ? raw : [String(raw)]).includes(String(cond.value))
    case "GREATER_THAN": return !empty && Number(raw) > Number(cond.value)
    case "LESS_THAN": return !empty && Number(raw) < Number(cond.value)
    case "GREATER_THAN_OR_EQUAL": return !empty && Number(raw) >= Number(cond.value)
    case "LESS_THAN_OR_EQUAL": return !empty && Number(raw) <= Number(cond.value)
    default: return false
  }
}

function evaluate(answers) {
  const hiddenByRule = new Set(defaultHiddenByShowBlocks)
  const shownByRule = new Set()
  for (const rule of rules) {
    const fired = rule.logicalOperator === "OR"
      ? rule.conditionals.some(c => evalCondition(c, answers))
      : rule.conditionals.every(c => evalCondition(c, answers))
    if (!fired) continue
    for (const action of rule.actions) {
      if (action.type === "HIDE_BLOCKS" && action.blocks) action.blocks.forEach(u => hiddenByRule.add(u))
      if (action.type === "SHOW_BLOCKS" && action.blocks) action.blocks.forEach(u => shownByRule.add(u))
    }
  }
  for (const uuid of shownByRule) hiddenByRule.delete(uuid)
  return hiddenByRule
}

// Parse questions
const skipTypes = new Set(["FORM_TITLE", "PAGE_BREAK", "HEADING_2", "CONDITIONAL_LOGIC", "HIDDEN_FIELDS"])
function extractText(schema) {
  if (!schema) return ""
  if (typeof schema === "string") return schema
  if (!Array.isArray(schema)) return ""
  return schema.map((item) => {
    if (typeof item === "string") return item
    if (!Array.isArray(item)) return ""
    const first = item[0]
    return typeof first === "string" ? first : ""
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

  let type = "text", id = titleBlock.groupUuid
  if (groupType === "LINEAR_SCALE" || siblingBlocks.some(b => b.type === "LINEAR_SCALE")) {
    const sb = siblingBlocks.find(b => b.type === "LINEAR_SCALE") || firstSibling
    id = sb?.groupUuid || titleBlock.groupUuid; type = "linear_scale"
  } else if (groupType === "INPUT_NUMBER" || siblingBlocks.some(b => b.type === "INPUT_NUMBER")) {
    const ib = siblingBlocks.find(b => b.type === "INPUT_NUMBER")
    id = ib?.groupUuid || titleBlock.groupUuid; type = "number"
  } else if (groupType === "CHECKBOXES" || siblingBlocks.some(b => b.type === "CHECKBOX")) {
    const ob = siblingBlocks.filter(b => b.type === "CHECKBOX")
    id = ob[0]?.groupUuid || titleBlock.groupUuid; type = "checkbox"
  } else if (groupType === "DROPDOWN" || siblingBlocks.some(b => b.type === "DROPDOWN_OPTION")) {
    const ob = siblingBlocks.filter(b => b.type === "DROPDOWN_OPTION")
    id = ob[0]?.groupUuid || titleBlock.groupUuid; type = "dropdown"
  } else if (siblingBlocks.some(b => b.type === "MULTIPLE_CHOICE_OPTION" || b.groupType === "MULTIPLE_CHOICE")) {
    const ob = siblingBlocks.filter(b => b.type === "MULTIPLE_CHOICE_OPTION" || b.groupType === "MULTIPLE_CHOICE")
    id = ob[0]?.groupUuid || titleBlock.groupUuid; type = "multiple_choice"
  } else if (groupType === "YES_NO") {
    type = "yes_no"
  } else {
    // text / multi_text: use INPUT_TEXT groupUuid (same as recording-session.tsx)
    const allText = siblingBlocks.filter(b => b.type === "INPUT_TEXT")
    const inputField = siblingBlocks.find(b => b.type === "INPUT_FIELD")
    const tb = allText[0] || inputField
    if (tb) id = tb.groupUuid || titleBlock.groupUuid
  }

  const title = extractText(titleBlock.payload?.safeHTMLSchema) || titleBlock.payload?.title || ""
  return { id, type, title: title.slice(0, 90) }
}).filter(q => q.title.trim().length > 0)

// ── Evaluate with actual answers ─────────────────────────────────────────────
const hiddenSet = evaluate(answersMap)
const visibleQuestions = questions.filter(q => !hiddenSet.has(q.id))

console.log(`\n=== QUESTION SEQUENCE (with your answers applied) ===\n`)
console.log(`Total questions in form: ${questions.length}`)
console.log(`Visible after your answers: ${visibleQuestions.length}`)
console.log(`Hidden (conditions not met): ${questions.length - visibleQuestions.length}`)
console.log()

visibleQuestions.forEach((q, i) => {
  const answered = !isEmpty(answersMap[q.id])
  const answerVal = answersMap[q.id]
  const answerStr = answered
    ? ` → ${JSON.stringify(answerVal).slice(0, 50)}`
    : " → [NOT ANSWERED]"
  const mark = answered ? "✓" : "✗"
  console.log(`${String(i + 1).padStart(3)}. ${mark} [${q.type.padEnd(14)}] ${q.title}${answerStr}`)
})

console.log(`\n=== HIDDEN QUESTIONS (skipped by logic) ===\n`)
questions.filter(q => hiddenSet.has(q.id)).forEach(q => {
  console.log(`  [${q.type.padEnd(14)}] ${q.title}`)
})
