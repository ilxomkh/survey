"use client"

import { useState, useEffect, useRef, useMemo, Fragment } from "react"
import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { AlertCircle, Square, Loader2, MapPin, CheckCircle2 } from "lucide-react"
import { apiClient } from "@/lib/api-client"
import { storage } from "@/lib/storage"
import { buildLogicEngine, TallyLogicEngine, LogicResult, Answers } from "@/lib/tally-logic-engine"
import { getSurveyUiLocale, RECORDING_UI } from "@/lib/survey-ui-strings"

interface Survey {
  id: number
  title: string
  description?: string
  language?: string
}

interface QuestionOption {
  uuid: string
  text: string
}

interface Question {
  id: string
  title: string
  rawSchema?: any
  /** HEADING_2 block text preceding this question (e.g. "A4. Какие приложения...") */
  contextHeading?: string
  type: string
  options?: QuestionOption[]
  required?: boolean
  scaleMin?: number
  scaleMax?: number
  multiple?: boolean
  otherOptionUuid?: string
  otherInputGroupId?: string
  /** UUID вариантов, зафиксированных в Tally (payload.lockInPlace), не перемешивать */
  checkboxLockUuids?: string[]
  /** Для multi_text: отдельные поля (каждый INPUT_FIELD — отдельный uuid) */
  subFields?: { id: string }[]
}

/** Текст из поля «другой» Q2/Q3 (как в оригинальной логике @). */
function getLegacyOtherMentionText(questions: Question[], answersMap: Answers): string | null {
  const q2Market = resolveMarketplaceQ2(questions)
  const q3Idx = resolveFrequencyQ3Index(questions, q2Market)
  const q3Freq = q3Idx >= 0 ? questions[q3Idx] : undefined
  if (q2Market?.otherInputGroupId) {
    const t = answersMap[q2Market.otherInputGroupId]
    if (t && String(t).trim()) return String(t).trim()
  }
  if (q3Freq?.otherInputGroupId) {
    const t = answersMap[q3Freq.otherInputGroupId]
    if (t && String(t).trim()) return String(t).trim()
  }
  return null
}

/** Подпись выбранного варианта в Q3 «чаще всего» (в т.ч. динамические options после Q2). */
function formatQ3ChoiceAsDisplay(q3: Question | undefined, answersMap: Answers): string | null {
  if (!q3) return null
  const v = answersMap[q3.id]
  if (v === undefined || v === null || v === "") return null
  if (q3.type === "multiple_choice" && q3.options) {
    const opt = q3.options.find((o) => o.uuid === v)
    return (opt?.text ?? "").trim() || String(v)
  }
  if (q3.type === "dropdown" && q3.options) {
    const opt = q3.options.find((o) => o.uuid === v)
    return (opt?.text ?? "").trim() || String(v)
  }
  return String(v)
}

/** Вопрос Q3 «чаще всего»: сначала индекс в полном списке, иначе первый MC/dropdown после Q2 в видимой цепочке. */
function findQ3FrequencyQuestion(
  questions: Question[],
  visibleQuestions: Question[]
): Question | undefined {
  const q2 = resolveMarketplaceQ2(questions)
  const idx = resolveFrequencyQ3Index(questions, q2)
  if (idx >= 0) return questions[idx]

  const q2Ref = q2 ? visibleQuestions.find((q) => q.id === q2.id) ?? q2 : undefined
  const i2 = q2Ref ? visibleQuestions.findIndex((q) => q.id === q2Ref.id) : -1
  if (i2 >= 0) {
    for (let i = i2 + 1; i < visibleQuestions.length; i++) {
      const q = visibleQuestions[i]!
      if (q.type === "multiple_choice" || q.type === "dropdown") return q
    }
  }
  return visibleQuestions.find(
    (q) =>
      (q.type === "multiple_choice" || q.type === "dropdown") &&
      titleMatchesAnyFragment(q.title, Q3_FREQUENCY_TITLE_FRAGMENTS)
  )
}

/**
 * После шага Q3 «чаще всего» (по visibleQuestions) в @ подставляем подпись выбора из Q3.
 * На шаге Q3 и раньше — только текст «другой» Q2/Q3 (legacy).
 */
function getAtMentionReplacement(
  questions: Question[],
  visibleQuestions: Question[],
  answersMap: Answers,
  current: Question | undefined
): string | null {
  const legacy = getLegacyOtherMentionText(questions, answersMap)
  if (!current) return legacy

  const q3Template = findQ3FrequencyQuestion(questions, visibleQuestions)
  if (!q3Template) return legacy

  const q3VisIdx = visibleQuestions.findIndex((q) => q.id === q3Template.id)
  const curVisIdx = visibleQuestions.findIndex((q) => q.id === current.id)
  if (q3VisIdx < 0 || curVisIdx < 0 || curVisIdx <= q3VisIdx) return legacy

  const q3Live = visibleQuestions.find((q) => q.id === q3Template.id) ?? q3Template
  const q3Label = formatQ3ChoiceAsDisplay(q3Live, answersMap)
  if (q3Label && q3Label.trim()) return q3Label.trim()
  return legacy
}

function applyAtMentionPlain(text: string, mention: string | null | undefined): string {
  const value = String(mention ?? "").trim()
  if (!value || !text.includes("@")) return text

  return String(text)
    // Tally mention examples:
    // @B3. Ularning qaysi biridan ...
    // @B3. Каким приложением Вы пользуетесь ЧАЩЕ ВСЕГО?
    .replace(/@B3\.[^?。！？!\n\r)]*[?。！？!]?/gi, value)
    .replace(/@B3\b\.?/gi, value)
}

interface RecordingSessionProps {
  sessionId: string
  survey: Survey
  onComplete: () => void
}

/** Tally хранит CSS-стили как ["tagfont-weight", ...], ["tagcolor", ...] и т.п. — это не текст */
function isTallyStyleMarker(s: string): boolean {
  return /^tag[a-z]/.test(s)
}

/** Плоский текст из группы фрагментов Tally (как в extractTextFromSchema для одного блока) */
function extractPlainTextFromSchemaGroup(first: any[]): string {
  if (!Array.isArray(first)) return ""
  return first
    .map((fragment: any) => {
      if (typeof fragment === "string") return isTallyStyleMarker(fragment) ? "" : fragment
      if (Array.isArray(fragment) && typeof fragment[0] === "string")
        return isTallyStyleMarker(fragment[0]) ? "" : fragment[0]
      if (Array.isArray(fragment) && Array.isArray(fragment[0]))
        return extractPlainTextFromSchemaGroup(fragment)
      return ""
    })
    .join("")
}

/**
 * Если в объединённом тексте есть замкнутая пара `{…}`, склеиваем фрагменты Tally и красим
 * содержимое скобок. Иначе (mention, color, background-color) строка режется — `{` и `}` в
 * разных узлах, regex не срабатывает (чёрный текст в RU Q3, узб. Q2). Подсветка фона Tally на
 * таком заголовке может не сохраниться — приоритет у читаемых инструкций в `{…}`.
 */

/** Полноширинные фигурные скобки (иногда в типографике / копипасте) */
function normalizeCurlyBraceChars(text: string): string {
  return text.replace(/\uFF5B/g, "{").replace(/\uFF5D/g, "}")
}

/** Tally иногда склеивает закрывающую `}` со стилевым токеном (`}tagfont-weight`) в одну строку. */
function sanitizeTallyTextLeak(text: string): string {
  if (!text) return text
  // Strip only Tally CSS marker suffix glued directly to } (no space), keep {…} content visible
  return text.replace(/\}tag[a-z][a-z0-9-]*/g, "}").trimEnd()
}

/** Текст внутри `{…}` — явный красный (виден поверх цвета Tally); скобки — цвет текста вопроса */
function renderCurlyBraceInnerRed(text: string, keyPrefix: string): ReactNode {
  const normalized = sanitizeTallyTextLeak(normalizeCurlyBraceChars(text))
  const hasCurly = normalized.includes("{") && normalized.includes("}")
  if (!hasCurly) return text
  const parts: ReactNode[] = []
  const re = /\{([^}]*)\}/g
  let last = 0
  let m: RegExpExecArray | null
  let k = 0
  while ((m = re.exec(normalized)) !== null) {
    if (m.index > last) {
      parts.push(<span key={`${keyPrefix}t${k++}`}>{normalized.slice(last, m.index)}</span>)
    }
    parts.push(
      <Fragment key={`${keyPrefix}b${k++}`}>
        <span className="text-foreground">{"{"}</span>
        <span className="font-semibold !text-[#b91c1c] dark:!text-[#ff5252]">{m[1]}</span>
        <span className="text-foreground">{"}"}</span>
      </Fragment>
    )
    last = m.index + m[0].length
  }
  if (last < normalized.length) {
    parts.push(<span key={`${keyPrefix}t${k++}`}>{normalized.slice(last)}</span>)
  }
  return parts.length > 0 ? <>{parts}</> : text
}

/** Заголовок Q2 (маркетплейсы): русский + типичная узбекская латиница в Tally */
const Q2_MARKETPLACE_TITLE_FRAGMENTS = [
  "какими онлайн-маркетплейсами",
  "онлайн-маркетплейс",
  "marketpleys",
  "marketpley",
  "onlayn market",
  "qaysi onlayn",
] as const

/** Заголовок Q3 («чаще всего»): русский + узбекские формулировки */
const Q3_FREQUENCY_TITLE_FRAGMENTS = [
  "b3.",
  "чаще всего",
  "eng ko'p",
  "eng ko'p foydalanasiz",
  "qaysi biridan eng ko'p",
  "ularning qaysi biridan",
  "ko'proq",
  "koproq",
] as const

function normalizeSurveyText(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[’‘`´ʻʼ]/g, "'")
    .replace(/ё/g, "е")
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s+/g, " ")
    .trim()
}

function titleMatchesAnyFragment(title: string, fragments: readonly string[]): boolean {
  const t = normalizeSurveyText(title)
  return fragments.some((f) => t.includes(normalizeSurveyText(f)))
}

const P2P_TRANSFER_TITLE_FRAGMENTS = [
  "p2p",
  "kartadan kartaga",
  "pul o'tkazish",
  "перевести деньги с карты на карту",
  "перевести деньги другу",
] as const

const P2P_TRANSFER_EXTRA_OPTIONS = [
  "Ничего/Не знаю",
  "Другой [записать]",
] as const

function normalizeSurveyOptionText(text: string): string {
  return normalizeSurveyText(text)
}

function isP2PTransferQuestion(question: Question): boolean {
  if (question.type !== "checkbox") return false
  return titleMatchesAnyFragment(question.title, P2P_TRANSFER_TITLE_FRAGMENTS)
}

function findOptionByNormalizedText(options: QuestionOption[] | undefined, text: string): QuestionOption | undefined {
  const normalized = normalizeSurveyOptionText(text)
  return options?.find((option) => normalizeSurveyOptionText(option.text) === normalized)
}

function isNoKnowledgeOptionText(text: string): boolean {
  const normalized = normalizeSurveyOptionText(text)
  return normalized.includes("ничего") && normalized.includes("знаю")
}

function isOtherOptionText(text: string): boolean {
  const normalized = normalizeSurveyOptionText(text)
  return normalized.includes("другой") || normalized.includes("boshqa") || normalized.includes("other")
}

function limitP2PTransferOptions(question: Question, previousQuestion: Question | undefined, answersMap: Answers): Question {
  if (!isP2PTransferQuestion(question) || !question.options?.length) return question

  const selectedPreviousUuids = Array.isArray(previousQuestion ? answersMap[previousQuestion.id] : undefined)
    ? (answersMap[previousQuestion!.id] as string[])
    : []
  if (!previousQuestion?.options?.length || selectedPreviousUuids.length === 0) return question

  const selectedOptions: QuestionOption[] = []
  for (const uuid of selectedPreviousUuids) {
    const previousOption = previousQuestion.options.find((option) => option.uuid === uuid)
    if (!previousOption) continue

    const matchingP2POption = findOptionByNormalizedText(question.options, previousOption.text)
    selectedOptions.push(matchingP2POption ?? { uuid: previousOption.uuid, text: previousOption.text })
  }

  const extraOptionsByDisplayText = new Map<string, QuestionOption>()
  for (const option of question.options) {
    if (isNoKnowledgeOptionText(option.text)) {
      extraOptionsByDisplayText.set("Ничего/Не знаю", { ...option, text: "Ничего/Не знаю" })
    } else if (isOtherOptionText(option.text)) {
      extraOptionsByDisplayText.set("Другой [записать]", { ...option, text: "Другой [записать]" })
    }
  }

  const extraOptions = P2P_TRANSFER_EXTRA_OPTIONS
    .map((displayText) => extraOptionsByDisplayText.get(displayText))
    .filter((option): option is QuestionOption => Boolean(option))
  const options = [...selectedOptions, ...extraOptions].filter(
    (option, index, all) => all.findIndex((item) => item.uuid === option.uuid) === index
  )

  if (selectedOptions.length === 0 || extraOptions.length !== P2P_TRANSFER_EXTRA_OPTIONS.length) {
    console.warn("[RecordingSession] P2P transfer options were not limited: expected options not found", {
      question: question.title,
      previousQuestion: previousQuestion?.title,
      selectedPreviousUuids,
      found: options.map((option) => option.text),
      expectedExtraOptions: P2P_TRANSFER_EXTRA_OPTIONS,
    })
    return question
  }

  return {
    ...question,
    options,
    checkboxLockUuids: question.checkboxLockUuids?.filter((uuid) =>
      options.some((option) => option.uuid === uuid)
    ),
  }
}

/** Q2: по тексту вопроса или единственный чекбокс с полем «другой» и несколькими вариантами */
function resolveMarketplaceQ2(questions: Question[]): Question | undefined {
  const byTitle = questions.find(
    (q) =>
      q.type === "checkbox" &&
      titleMatchesAnyFragment(q.title, Q2_MARKETPLACE_TITLE_FRAGMENTS)
  )
  if (byTitle) return byTitle

  const withOther = questions.filter(
    (q) =>
      q.type === "checkbox" &&
      q.otherOptionUuid &&
      q.otherInputGroupId &&
      (q.options?.length ?? 0) >= 3
  )
  if (withOther.length === 1) return withOther[0]
  return undefined
}

/** Индекс Q3: первый multiple_choice после Q2, иначе по заголовку */
function resolveFrequencyQ3Index(questions: Question[], q2: Question | undefined): number {
  if (q2) {
    const i2 = questions.indexOf(q2)
    const after = questions.findIndex((q, i) => i > i2 && q.type === "multiple_choice")
    if (after >= 0) return after
  }
  return questions.findIndex(
    (q) =>
      q.type === "multiple_choice" &&
      titleMatchesAnyFragment(q.title, Q3_FREQUENCY_TITLE_FRAGMENTS)
  )
}

/** Перемешивание вариантов Q2; последний в списке (обычно «Другой») всегда в конце */
function shuffleOptionsKeepLast(options: QuestionOption[]): QuestionOption[] {
  if (options.length <= 1) return options.slice()
  const head = options.slice(0, -1)
  const last = options[options.length - 1]!
  for (let i = head.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
      ;[head[i], head[j]] = [head[j]!, head[i]!]
  }
  return [...head, last]
}

/** Как в Tally: варианты из lockInPlace не трогаем, остальные перемешиваем; зафиксированные — в конце в исходном порядке */
function shuffleOptionsWithLocks(options: QuestionOption[], lockUuids: Set<string>): QuestionOption[] {
  const movable: QuestionOption[] = []
  const locked: QuestionOption[] = []
  for (const o of options) {
    if (lockUuids.has(o.uuid)) locked.push(o)
    else movable.push(o)
  }
  for (let i = movable.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
      ;[movable[i], movable[j]] = [movable[j]!, movable[i]!]
  }
  return [...movable, ...locked]
}

// ─── Загрузка аудио с retry ──────────────────────────────────
async function uploadAudioWithRetry(
  sessionId: string,
  blob: Blob,
  retries = 3
): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await apiClient.uploadAudio(sessionId, blob)
      return
    } catch (err) {
      console.warn(`[Audio] Попытка ${i + 1}/${retries} не удалась:`, err)
      if (i < retries - 1) {
        await new Promise((r) => setTimeout(r, 2000 * (i + 1)))
      }
    }
  }
  console.error("[Audio] Все попытки исчерпаны, чанк потерян")
  throw new Error("[Audio] Все попытки исчерпаны, чанк не загружен")
}


export function RecordingSession({ sessionId, survey, onComplete }: RecordingSessionProps) {
  const locale = getSurveyUiLocale(survey)
  const ui = RECORDING_UI[locale]

  const [isRecording, setIsRecording] = useState(false)
  const [duration, setDuration] = useState(0)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)
  const [geoStatus, setGeoStatus] = useState(ui.geoLoading)
  const [micStatus, setMicStatus] = useState(ui.micLoading)
  const [questions, setQuestions] = useState<Question[]>([])
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0)
  const [answers, setAnswers] = useState<Answers>({})
  const [loadingQuestions, setLoadingQuestions] = useState(true)
  const [showFinishConfirm, setShowFinishConfirm] = useState(false)
  const [keyboardOpen, setKeyboardOpen] = useState(false)

  const [logicEngine, setLogicEngine] = useState<TallyLogicEngine | null>(null)
  const [logicResult, setLogicResult] = useState<LogicResult>({
    hiddenGroupUuids: new Set(),
    jumpToPageUuid: null,
  })


  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const uploadPromisesRef = useRef<Promise<any>[]>([])
  // ✅ FIX: локальное хранение чанков для fallback при завершении
  const audioChunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const timerRef = useRef<NodeJS.Timeout | null>(null)
  const locationIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const lastPositionRef = useRef<GeolocationCoordinates | null>(null)
  const answersRef = useRef<Answers>({})
  const visibleQuestionsRef = useRef<Question[]>([])

  // ─── Answers o'zgarganda logic qayta hisoblash ──────────────
  useEffect(() => {
    if (!logicEngine) return
    const result = logicEngine.evaluate(answers)
    setLogicResult(result)
  }, [answers, logicEngine])

  // ─── Q3: только выбранные в Q2; «Другой» → текст респондента ─
  const questionsResolved = useMemo(() => {
    const limitedQuestions = questions.map((question, index) =>
      limitP2PTransferOptions(question, questions[index - 1], answers)
    )
    let q2 = resolveMarketplaceQ2(limitedQuestions)
    let q3Index = resolveFrequencyQ3Index(limitedQuestions, q2)

    // Fallback: if Q2 not found by title but Q3 found, use last checkbox with "Другой" before Q3
    if (!q2 && q3Index !== -1) {
      const candidates = limitedQuestions
        .slice(0, q3Index)
        .filter(q => q.type === "checkbox" && q.otherOptionUuid && q.otherInputGroupId && (q.options?.length ?? 0) >= 3)
      q2 = candidates[candidates.length - 1]
    }

    if (!q2 || q3Index === -1) return limitedQuestions

    const selected = answers[q2.id]
    if (!Array.isArray(selected) || selected.length === 0) return limitedQuestions

    const q3 = limitedQuestions[q3Index]
    const newOptions: QuestionOption[] = []

    for (const uuid of selected) {
      if (uuid === q2.otherOptionUuid) {
        const custom =
          q2.otherInputGroupId != null
            ? String(answers[q2.otherInputGroupId] ?? "").trim()
            : ""
        const otherLabel =
          q2.options?.find((o) => o.uuid === uuid)?.text?.trim() || ui.otherOptionFallback
        newOptions.push({ uuid, text: custom || otherLabel })
      } else {
        const opt = q2.options?.find((o) => o.uuid === uuid)
        if (opt) newOptions.push({ uuid: opt.uuid, text: opt.text })
      }
    }

    if (newOptions.length === 0) return limitedQuestions

    return limitedQuestions.map((q, i) =>
      i === q3Index
        ? {
          ...q3,
          options: newOptions,
          otherOptionUuid: undefined,
          otherInputGroupId: undefined,
        }
        : q
    )
  }, [questions, answers, locale])

  // ─── Q2 (маркетплейсы): случайный порядок; учитываем Tally lockInPlace или последний вариант ─
  const marketplaceQ2OptionOrder = useMemo(() => {
    const q2 = resolveMarketplaceQ2(questionsResolved)
    if (!q2?.options?.length) return null
    if (isP2PTransferQuestion(q2)) {
      return {
        questionId: q2.id,
        uuids: q2.options.map((o) => o.uuid),
      }
    }
    const lockSet = new Set(
      (q2.checkboxLockUuids ?? []).filter((u) => typeof u === "string" && u.length > 0)
    )
    const shuffled =
      lockSet.size > 0
        ? shuffleOptionsWithLocks(q2.options, lockSet)
        : shuffleOptionsKeepLast(q2.options)
    return {
      questionId: q2.id,
      uuids: shuffled.map((o) => o.uuid),
    }
  }, [questionsResolved])

  // ─── Visible questions (yashirilmaganlar) ──────────────────
  const visibleQuestions = questionsResolved.filter((q) => {
    if (logicResult.hiddenGroupUuids.has(q.id)) return false
    if (q.type === "multi_text" && q.subFields) {
      // скрываем если ВСЕ subField uuid скрыты
      if (q.subFields.every((f) => logicResult.hiddenGroupUuids.has(f.id))) return false
    }
    return true
  })
  answersRef.current = answers
  visibleQuestionsRef.current = visibleQuestions

  // ─── Парсинг блоков Tally ───────────────────────────────────
  const extractTextFromSchema = (schema: any): string => {
    if (!schema) return ""
    if (typeof schema === "string") return schema
    if (!Array.isArray(schema)) return ""

    return schema
      .map((item: any): string => {
        if (typeof item === "string") return isTallyStyleMarker(item) ? "" : item
        if (!Array.isArray(item)) return ""

        const first = item[0]
        if (typeof first === "string") return isTallyStyleMarker(first) ? "" : first

        if (Array.isArray(first)) {
          return first
            .map((fragment: any) => {
              if (typeof fragment === "string") return isTallyStyleMarker(fragment) ? "" : fragment
              if (Array.isArray(fragment) && typeof fragment[0] === "string")
                return isTallyStyleMarker(fragment[0]) ? "" : fragment[0]
              return ""
            })
            .join("")
        }
        return ""
      })
      .filter(Boolean)
      .join("")
      .trim()
  }

  const renderSchema = (schema: any, atMention?: string | null): React.ReactNode => {
    if (!schema || !Array.isArray(schema)) return null

    const mention =
      atMention != null && String(atMention).trim() !== "" ? String(atMention).trim() : null

    const fullMerged = sanitizeTallyTextLeak(
      normalizeCurlyBraceChars(extractTextFromSchema(schema))
    )
    const displayMerged = mention ? applyAtMentionPlain(fullMerged, mention) : fullMerged

    if (
      displayMerged.includes("{") &&
      displayMerged.includes("}") &&
      /\{[^}]*\}/.test(displayMerged)
    ) {
      return renderCurlyBraceInnerRed(displayMerged, "sch-prescan-")
    }

    if (!fullMerged.includes("{") && fullMerged.includes("}")) {
      let charOffset = 0
      let insertAt = -1
      for (const item of schema) {
        if (typeof item === "string") {
          if (!isTallyStyleMarker(item)) charOffset += item.length
        } else if (Array.isArray(item)) {
          const f = item[0]
          if (typeof f === "string") {
            if (!isTallyStyleMarker(f)) charOffset += f.length
          } else if (Array.isArray(f)) {
            const inlineText = f
              .map((fragment: any): string => {
                if (typeof fragment === "string") return isTallyStyleMarker(fragment) ? "" : fragment
                if (Array.isArray(fragment) && typeof fragment[0] === "string")
                  return isTallyStyleMarker(fragment[0]) ? "" : fragment[0]
                return ""
              })
              .join("")
            if (inlineText.trim().length === 0) {
              if (insertAt < 0) insertAt = charOffset
            } else {
              charOffset += inlineText.length
            }
          }
        }
      }
      if (insertAt >= 0) {
        const patchedMerged = normalizeCurlyBraceChars(
          fullMerged.slice(0, insertAt) + "{" + fullMerged.slice(insertAt)
        )
        if (/\{[^}]*\}/.test(patchedMerged)) {
          const patchedDisplay = mention
            ? applyAtMentionPlain(patchedMerged, mention)
            : patchedMerged
          return renderCurlyBraceInnerRed(patchedDisplay, "sch-prescan-")
        }
      }
    }

    const nodes: React.ReactNode[] = []

    schema.forEach((item: any, i: number) => {
      if (typeof item === "string") {
        if (isTallyStyleMarker(item)) return
        nodes.push(
          <span key={i}>
            {renderCurlyBraceInnerRed(applyAtMentionPlain(item, mention), `sch-s-${i}-`)}
          </span>
        )
        return
      }
      if (!Array.isArray(item)) return

      const first = item[0]

      if (typeof first === "string") {
        if (isTallyStyleMarker(first)) return
        const styleArr = item.slice(1)
        const color = styleArr
          .flat(2)
          .find((s: any, idx: number, arr: any[]) => arr[idx - 1] === "color")
        nodes.push(
          <span key={i} style={color ? { color } : undefined}>
            {renderCurlyBraceInnerRed(applyAtMentionPlain(first, mention), `sch-f-${i}-`)}
          </span>
        )
        return
      }

      if (Array.isArray(first)) {
        const mergedPlain = normalizeCurlyBraceChars(extractPlainTextFromSchemaGroup(first))
        const mergedPlainAt = mention ? applyAtMentionPlain(mergedPlain, mention) : mergedPlain
        if (
          mergedPlainAt.includes("{") &&
          mergedPlainAt.includes("}") &&
          /\{[^}]*\}/.test(mergedPlainAt)
        ) {
          nodes.push(
            <span key={i}>{renderCurlyBraceInnerRed(mergedPlainAt, `sch-merge-${i}-`)}</span>
          )
          return
        }

        const groupStyleArr: any[] = Array.isArray(item[1]) ? item[1] : []
        const groupColor = groupStyleArr
          .flat(2)
          .find((s: any, idx: number, arr: any[]) => arr[idx - 1] === "color")

        const inner = first.map((fragment: any, j: number) => {
          if (typeof fragment === "string") {
            if (isTallyStyleMarker(fragment)) return null
            return (
              <span key={j}>
                {renderCurlyBraceInnerRed(applyAtMentionPlain(fragment, mention), `sch-g-${i}-${j}-`)}
              </span>
            )
          }
          if (Array.isArray(fragment)) {
            const text = fragment[0]
            if (typeof text !== "string") return null
            if (isTallyStyleMarker(text)) return null
            const fragStyles: any[] = fragment.slice(1).flat(1)
            const fragColor = fragStyles
              .find((s: any, idx: number, arr: any[]) => arr[idx - 1] === "color")

            const finalColor = fragColor || groupColor

            return (
              <span key={j} style={finalColor ? { color: finalColor } : undefined}>
                {renderCurlyBraceInnerRed(applyAtMentionPlain(text, mention), `sch-x-${i}-${j}-`)}
              </span>
            )
          }
          return null
        })
        nodes.push(<span key={i}>{inner}</span>)
      }
    })

    return <>{nodes}</>
  }

  const parseTallyBlocks = (blocks: any[]): Question[] => {
    const skipTypes = new Set(["FORM_TITLE", "PAGE_BREAK", "HEADING_2", "CONDITIONAL_LOGIC", "HIDDEN_FIELDS"])

    // Tally sometimes stores only a short visual TITLE like "NPS1.",
    // while the full question text is duplicated inside CONDITIONAL_LOGIC field.title.
    // Example: NPS1. (если 0-6) Что вам не понравилось? ...
    const fieldTitleByGroupUuid = new Map<string, string>()
    for (const block of blocks) {
      const conditionals = block?.payload?.conditionals
      if (!Array.isArray(conditionals)) continue

      for (const conditional of conditionals) {
        const field = conditional?.payload?.field
        const key = field?.blockGroupUuid || field?.uuid
        const title = typeof field?.title === "string" ? sanitizeTallyTextLeak(field.title.trim()) : ""
        if (key && title && !fieldTitleByGroupUuid.has(key)) {
          fieldTitleByGroupUuid.set(key, title)
        }
      }
    }

    const isWeakParsedQuestionTitle = (text: string): boolean => {
      const t = normalizeSurveyText(sanitizeTallyTextLeak(text))
      return (
        t === "nps1" ||
        t === "nps1." ||
        /^nps\d+\.?$/.test(t) ||
        t.length <= 6
      )
    }

    const getBestParsedQuestionTitle = (fallbackTitle: string, groupId: string | undefined): string => {
      if (!groupId) return fallbackTitle
      const fromLogic = fieldTitleByGroupUuid.get(groupId)
      if (fromLogic && isWeakParsedQuestionTitle(fallbackTitle)) return fromLogic
      return fallbackTitle
    }

    // Build section heading map: each block index → the active section heading at that point.
    // PAGE_BREAK resets the heading; HEADING_2 and TITLE(groupType!="QUESTION") set it.
    let _activeSectionHeading: string | undefined = undefined
    const sectionHeadingAtIndex: (string | undefined)[] = blocks.map((b: any) => {
      if (b.type === "PAGE_BREAK") {
        _activeSectionHeading = undefined
      } else if (b.type === "HEADING_2" || (b.type === "TITLE" && b.groupType !== "QUESTION")) {
        const text = sanitizeTallyTextLeak(
          (extractTextFromSchema(b.payload?.safeHTMLSchema) || b.payload?.title || b.text || "").trim()
        )
        if (text) _activeSectionHeading = text
      }
      return _activeSectionHeading
    })

    const titleBlocks = blocks.filter(
      (b: any) => b.type === "TITLE" && b.groupType === "QUESTION"
    )

    return titleBlocks
      .map((titleBlock: any, questionIndex: number) => {
        const questionText = sanitizeTallyTextLeak(
          extractTextFromSchema(titleBlock.payload?.safeHTMLSchema) ||
          titleBlock.payload?.title ||
          titleBlock.text ||
          ""
        )
        const rawSchema = titleBlock.payload?.safeHTMLSchema || null

        const titleBlockIndex = blocks.indexOf(titleBlock)
        const contextHeading = sectionHeadingAtIndex[titleBlockIndex]

        const nextTitleBlockIndex =
          questionIndex < titleBlocks.length - 1
            ? blocks.indexOf(titleBlocks[questionIndex + 1])
            : blocks.length

        const siblingBlocks = blocks.slice(titleBlockIndex + 1, nextTitleBlockIndex)
        const firstSibling = siblingBlocks.find((b: any) => !skipTypes.has(b.type))
        const groupType = firstSibling?.groupType || titleBlock.groupType || ""

        if (groupType === "LINEAR_SCALE" || siblingBlocks.some((b: any) => b.type === "LINEAR_SCALE")) {
          const scaleBlock = siblingBlocks.find((b: any) => b.type === "LINEAR_SCALE") || firstSibling
          const groupId = scaleBlock?.groupUuid || titleBlock.groupUuid
          return {
            id: groupId,
            title: questionText,
            rawSchema,
            contextHeading,
            type: "linear_scale",
            scaleMin: scaleBlock?.payload?.startValue ?? scaleBlock?.payload?.start ?? 1,
            scaleMax: scaleBlock?.payload?.endValue ?? scaleBlock?.payload?.end ?? 10,
            required: scaleBlock?.payload?.isRequired === true || titleBlock.payload?.isRequired === true,
          }
        }

        if (groupType === "INPUT_NUMBER" || siblingBlocks.some((b: any) => b.type === "INPUT_NUMBER")) {
          const inputBlock = siblingBlocks.find((b: any) => b.type === "INPUT_NUMBER")
          const groupId = inputBlock?.groupUuid || titleBlock.groupUuid
          return {
            id: groupId,
            title: questionText,
            rawSchema,
            contextHeading,
            type: "number",
            required: titleBlock.payload?.isRequired === true,
          }
        }

        if (groupType === "DROPDOWN" || siblingBlocks.some((b: any) => b.type === "DROPDOWN_OPTION")) {
          const optionBlocks = siblingBlocks.filter((b: any) => b.type === "DROPDOWN_OPTION")
          const options: QuestionOption[] = optionBlocks
            .map((b: any) => ({
              uuid: b.uuid,
              text: b.payload?.text || extractTextFromSchema(b.payload?.safeHTMLSchema) || b.text || "",
            }))
            .filter((o) => o.text)
          const groupId = optionBlocks[0]?.groupUuid || titleBlock.groupUuid
          return {
            id: groupId,
            title: questionText,
            rawSchema,
            contextHeading,
            type: "dropdown",
            options,
            required: titleBlock.payload?.isRequired === true,
          }
        }

        if (groupType === "CHECKBOXES" || siblingBlocks.some((b: any) => b.type === "CHECKBOX")) {
          const optionBlocks = siblingBlocks.filter((b: any) => b.type === "CHECKBOX")
          const options: QuestionOption[] = optionBlocks
            .map((b: any) => ({
              uuid: b.uuid,
              text: b.payload?.text || extractTextFromSchema(b.payload?.safeHTMLSchema) || b.text || "",
            }))
            .filter((o) => o.text)
          const groupId = optionBlocks[0]?.groupUuid || titleBlock.groupUuid
          const lockRaw = optionBlocks[0]?.payload?.lockInPlace
          const checkboxLockUuids = Array.isArray(lockRaw)
            ? lockRaw.filter((u: unknown) => typeof u === "string")
            : undefined

          const inputTextBlock = siblingBlocks.find((b: any) => b.type === "INPUT_TEXT")
          const otherOptionBlock = optionBlocks.find(
            (b: any) =>
              (b.payload?.text || "").toLowerCase().includes("boshqa") ||
              (b.payload?.text || "").toLowerCase().includes("другой") ||
              (b.payload?.text || "").toLowerCase().includes("other")
          )
          const checkboxOtherInputGroupId = otherOptionBlock && inputTextBlock
            ? inputTextBlock.groupUuid
            : undefined

          const lockSet = new Set<string>(checkboxLockUuids ?? [])
          if (otherOptionBlock) lockSet.add(otherOptionBlock.uuid)
          const shuffledOptions = lockSet.size > 0
            ? shuffleOptionsWithLocks(options, lockSet)
            : shuffleOptionsKeepLast(options)

          return {
            id: groupId,
            title: questionText,
            rawSchema,
            contextHeading,
            type: "checkbox",
            options: shuffledOptions,
            multiple: true,
            required: titleBlock.payload?.isRequired === true,
            otherOptionUuid: otherOptionBlock?.uuid,
            otherInputGroupId: checkboxOtherInputGroupId,
            checkboxLockUuids,
          }
        }

        const choiceOptionBlocks = siblingBlocks.filter(
          (b: any) => b.type === "MULTIPLE_CHOICE_OPTION" || b.groupType === "MULTIPLE_CHOICE"
        )
        if (choiceOptionBlocks.length > 0) {
          const options: QuestionOption[] = choiceOptionBlocks
            .map((b: any) => ({
              uuid: b.uuid,
              text: b.payload?.text || extractTextFromSchema(b.payload?.safeHTMLSchema) || b.text || "",
            }))
            .filter((o) => o.text)
          const groupId = choiceOptionBlocks[0]?.groupUuid || titleBlock.groupUuid

          const mcInputTextBlock = siblingBlocks.find((b: any) => b.type === "INPUT_TEXT")
          const mcOtherOptionBlock = choiceOptionBlocks.find(
            (b: any) =>
              (b.payload?.text || "").toLowerCase().includes("boshqa") ||
              (b.payload?.text || "").toLowerCase().includes("другой") ||
              (b.payload?.text || "").toLowerCase().includes("other")
          )

          const mcLockSet = new Set<string>()
          if (mcOtherOptionBlock) mcLockSet.add(mcOtherOptionBlock.uuid)
          const mcShuffled = mcLockSet.size > 0
            ? shuffleOptionsWithLocks(options, mcLockSet)
            : shuffleOptionsKeepLast(options)

          return {
            id: groupId,
            title: questionText,
            rawSchema,
            contextHeading,
            type: "multiple_choice",
            options: mcShuffled,
            required: titleBlock.payload?.isRequired === true,
            otherOptionUuid: mcOtherOptionBlock?.uuid,
            otherInputGroupId: mcInputTextBlock?.groupUuid,
          }
        }

        if (groupType === "YES_NO") {
          return {
            id: titleBlock.groupUuid,
            title: questionText,
            rawSchema,
            contextHeading,
            type: "yes_no",
            required: titleBlock.payload?.isRequired === true,
          }
        }

        const inputFieldBlocks = siblingBlocks.filter((b: any) => b.type === "INPUT_FIELD")
        if (inputFieldBlocks.length > 0) {
          const groupId = inputFieldBlocks[0]?.groupUuid || titleBlock.groupUuid
          const subFields = inputFieldBlocks.map((b: any) => ({ id: b.uuid || b.groupUuid }))
          return {
            id: groupId,
            title: questionText,
            rawSchema,
            contextHeading,
            type: "multi_text",
            required: titleBlock.payload?.isRequired === true,
            subFields,
          }
        }

        const allTextBlocks = siblingBlocks.filter((b: any) => b.type === "INPUT_TEXT")
        if (allTextBlocks.length > 1) {
          const groupId = allTextBlocks[0]?.groupUuid || titleBlock.groupUuid
          const subFields = allTextBlocks.map((b: any) => ({ id: b.uuid || b.groupUuid }))
          return {
            id: groupId,
            title: questionText,
            rawSchema,
            contextHeading,
            type: "multi_text",
            required: titleBlock.payload?.isRequired === true,
            subFields,
          }
        }

        const textBlock = allTextBlocks[0] ?? null
        const groupId = textBlock?.groupUuid || titleBlock.groupUuid
        const bestQuestionText = getBestParsedQuestionTitle(questionText, groupId)
        const bestRawSchema = bestQuestionText !== questionText ? null : rawSchema

        return {
          id: groupId,
          title: bestQuestionText,
          rawSchema: bestRawSchema,
          type: "text",
          required: textBlock?.payload?.isRequired === true || titleBlock.payload?.isRequired === true,
        }
      })
      .filter((q) => q.title.trim().length > 0)
  }

  // ─── Загрузка вопросов ──────────────────────────────────────
  useEffect(() => {
    const loadQuestions = async () => {
      try {
        const token = localStorage.getItem("auth_token")
        if (token) apiClient.setToken(token)

        const surveyData = await Promise.race([
          apiClient.getSurveyQuestions(survey.id, sessionId),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(locale === "uz" ? "Savollar yuklanmadi (timeout)" : "Вопросы не загрузились (timeout)")), 15000)
          ),
        ])

        let extractedQuestions: Question[] = []
        let rawBlocks: any[] = []

        if (surveyData) {
          if (Array.isArray(surveyData.blocks)) {
            rawBlocks = surveyData.blocks
            extractedQuestions = parseTallyBlocks(rawBlocks)
          } else if (Array.isArray(surveyData.questions)) {
            extractedQuestions = surveyData.questions
          } else if (Array.isArray(surveyData)) {
            extractedQuestions = surveyData
          } else {
            for (const field of ["data", "items", "results", "content"]) {
              if (Array.isArray((surveyData as any)[field])) {
                extractedQuestions = (surveyData as any)[field]
                break
              }
            }
          }
        }

        setQuestions(extractedQuestions)

        if (rawBlocks.length > 0) {
          const engine = buildLogicEngine(rawBlocks)
          setLogicEngine(engine)

          if (extractedQuestions.length === 0) {
            const blockTypes = rawBlocks.map((b: any) => `${b.type}/${b.groupType}`).join(", ")
            console.warn("[RecordingSession] 0 вопросов из", rawBlocks.length, "блоков. Типы:", blockTypes)
            const titleBlocks = rawBlocks.filter((b: any) => b.type === "TITLE" && b.groupType === "QUESTION")
            console.warn("[RecordingSession] TITLE+QUESTION блоков:", titleBlocks.length)
            if (titleBlocks.length > 0) {
              console.warn("[RecordingSession] Первый TITLE блок:", JSON.stringify(titleBlocks[0]).slice(0, 400))
            }
          }
        } else if (surveyData) {
          console.warn("[RecordingSession] surveyData получен, но blocks отсутствует. Ключи:", Object.keys(surveyData as object))
        }
      } catch (err: any) {
        console.error("[RecordingSession] Ошибка загрузки вопросов:", err)
        const msg = err?.message || String(err) || "Ошибка загрузки вопросов"
        setError(msg)
      } finally {
        setLoadingQuestions(false)
      }
    }

    loadQuestions()
  }, [survey.id, sessionId, locale])

  // Сброс ответа Q3, если соответствующий вариант снят в Q2
  useEffect(() => {
    const q2 = resolveMarketplaceQ2(questions)
    const q3Index = resolveFrequencyQ3Index(questions, q2)
    const q3 = q3Index >= 0 ? questions[q3Index] : undefined
    if (!q2 || !q3) return
    const selected = answers[q2.id]
    const q3ans = answers[q3.id]
    if (q3ans == null || q3ans === "") return
    const ok =
      Array.isArray(selected) &&
      selected.length > 0 &&
      selected.includes(String(q3ans))
    if (!ok) {
      setAnswers((prev) => {
        const next = { ...prev }
        delete next[q3.id]
        return next
      })
    }
  }, [questions, answers])

  const renderSchemaWithReplacements = (schema: any, forQuestionId?: string): React.ReactNode => {
    const cur = forQuestionId
      ? visibleQuestions.find((q) => q.id === forQuestionId)
      : undefined
    const mention = getAtMentionReplacement(questions, visibleQuestions, answers, cur)
    return renderSchema(schema, mention)
  }

  // ─── Инициализация записи и геолокации ─────────────────────
  useEffect(() => {
    const initializeSession = async () => {
      try {
        const token = localStorage.getItem("auth_token")
        if (token) apiClient.setToken(token)

        const tg = (window as any).Telegram?.WebApp
        const lm = tg?.LocationManager

        // Получить позицию через Telegram LocationManager (обходит WKWebView ограничения на iOS)
        const getViaTelegram = (): Promise<{ latitude: number; longitude: number; accuracy: number } | null> => {
          if (!lm) return Promise.resolve(null)
          return new Promise((resolve) => {
            const doGet = () => lm.getLocation((loc: any) => resolve(
              loc ? { latitude: loc.latitude, longitude: loc.longitude, accuracy: loc.horizontal_accuracy ?? 100 } : null
            ))
            lm.isInited ? doGet() : lm.init(doGet)
          })
        }

        if (lm) {
          // iOS Telegram: используем LocationManager
          const loc = await getViaTelegram()
          if (loc) {
            lastPositionRef.current = loc as GeolocationCoordinates
            setGeoStatus(ui.geoOk(loc.accuracy.toFixed(0)))
            apiClient.updateLocation(sessionId, loc.latitude, loc.longitude, loc.accuracy).catch(() => { })
          } else {
            setGeoStatus(ui.geoPermissionDenied)
            // Не блокируем — используем сохранённую позицию из подготовки
          }

          // Периодические обновления через LocationManager
          const intervalId = setInterval(async () => {
            const updated = await getViaTelegram()
            if (updated) {
              lastPositionRef.current = updated as GeolocationCoordinates
              setGeoStatus(ui.geoOk(updated.accuracy.toFixed(0)))
              apiClient.updateLocation(sessionId, updated.latitude, updated.longitude, updated.accuracy).catch(() => { })
            }
          }, 30000)
          locationIntervalRef.current = intervalId as any
        } else {
          // Fallback: стандартный navigator.geolocation
          if (!navigator.geolocation) {
            setGeoStatus(ui.geoUnsupportedShort)
            // Не блокируем — продолжаем с сохранённой позицией
          } else {
            await new Promise<void>((resolve) => {
              navigator.geolocation.getCurrentPosition(
                () => resolve(),
                () => {
                  navigator.geolocation.getCurrentPosition(
                    () => resolve(),
                    (err) => {
                      console.warn("[RecordingSession] geolocation precheck failed:", err)
                      setGeoStatus(ui.geoDeniedShort)
                      // Не ставим setError — сессия уже создана с координатами
                      resolve()
                    },
                    { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 }
                  )
                },
                { enableHighAccuracy: false, timeout: 10000, maximumAge: 0 }
              )
            })

            let watchId: number | null = null
            let fallbackAttempted = false

            const startWatching = (highAccuracy: boolean) => {
              if (watchId !== null) navigator.geolocation.clearWatch(watchId)
              watchId = navigator.geolocation.watchPosition(
                async (position) => {
                  lastPositionRef.current = position.coords
                  setGeoStatus(ui.geoOk(position.coords.accuracy.toFixed(0)))
                  try {
                    await apiClient.updateLocation(sessionId, position.coords.latitude, position.coords.longitude, position.coords.accuracy)
                  } catch (err) {
                    console.error("[RecordingSession] Ошибка отправки геолокации:", err)
                  }
                },
                (err) => {
                  if (highAccuracy && !fallbackAttempted) {
                    fallbackAttempted = true
                    startWatching(false)
                    return
                  }
                  switch (err.code) {
                    case err.PERMISSION_DENIED: setGeoStatus(ui.geoPermissionDenied); break
                    case err.POSITION_UNAVAILABLE: setGeoStatus(ui.geoPositionUnavailable); break
                    case err.TIMEOUT: setGeoStatus(ui.geoTimeout); break
                    default: setGeoStatus(ui.geoError(err.message))
                  }
                },
                { enableHighAccuracy: highAccuracy, timeout: 10000, maximumAge: 5000 }
              )
            }

            startWatching(true)
            locationIntervalRef.current = watchId as any
          }
        }

        // ✅ FIX: микрофон блокирует сессию так же как геолокация
        let stream: MediaStream
        try {
          stream = await Promise.race([
            navigator.mediaDevices.getUserMedia({ audio: true }),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(ui.micLoading.replace("...", "") + " timeout")), 12000)
            ),
          ])
        } catch (err: any) {
          const isDenied =
            err?.name === "NotAllowedError" ||
            err?.name === "PermissionDeniedError"
          const msg = isDenied
            ? (locale === "uz"
              ? "Mikrofonga ruxsat berilmadi. Iltimos, brauzer sozlamalarida ruxsat bering va qayta urinib ko'ring."
              : "Доступ к микрофону запрещён. Разрешите доступ в настройках браузера и попробуйте снова.")
            : (err?.message || ui.initError)


          setMicStatus(locale === "uz" ? "Mikrofon: ruxsat yo'q" : "Микрофон: нет доступа")
          setError(msg)
          setLoading(false)
          return // ✅ блокируем сессию — не открываем опросник
        }

        streamRef.current = stream
        setMicStatus(ui.micOk)

        const mediaRecorder = new MediaRecorder(stream)
        mediaRecorderRef.current = mediaRecorder

        mediaRecorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            // ✅ FIX: сохраняем чанк локально
            audioChunksRef.current.push(event.data)
            // ✅ FIX: загружаем с retry вместо fire-and-forget
            const uploadPromise = uploadAudioWithRetry(sessionId, event.data, 3)
            uploadPromisesRef.current.push(uploadPromise)
          }
        }

        setLoading(false)
      } catch (err) {
        setError(err instanceof Error ? err.message : ui.initError)
        setLoading(false)
      }
    }

    initializeSession()

    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
      if (locationIntervalRef.current !== null) {
        const tg = (window as any).Telegram?.WebApp
        if (tg?.LocationManager) {
          clearInterval(locationIntervalRef.current as any)
        } else {
          navigator.geolocation?.clearWatch(locationIntervalRef.current as unknown as number)
        }
        locationIntervalRef.current = null
      }
      streamRef.current?.getTracks().forEach((track) => track.stop())
    }
  }, [sessionId, locale])

  useEffect(() => {
    if (!loading && mediaRecorderRef.current && !isRecording) startRecording()
  }, [loading])

  const startRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "inactive") {
      // ✅ FIX: 5000мс вместо 10000 — меньше потерь при обрыве сети
      mediaRecorderRef.current.start(5000)
      setIsRecording(true)
      timerRef.current = setInterval(() => setDuration((prev) => prev + 1), 1000)
    }
  }

  const finishRecording = async () => {
    setLoading(true)
    try {
      if (timerRef.current) clearInterval(timerRef.current)

      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        await new Promise<void>((resolve) => {
          const recorder = mediaRecorderRef.current!
          recorder.onstop = () => resolve()
          if (recorder.state === "recording") recorder.requestData()
          recorder.stop()
        })
        setIsRecording(false)
      }

      // ✅ FIX: проверяем результаты — если были ошибки, отправляем весь аудио целиком
      const results = await Promise.allSettled(uploadPromisesRef.current)
      uploadPromisesRef.current = []

      const failedCount = results.filter((r) => r.status === "rejected").length
      if (failedCount > 0 && audioChunksRef.current.length > 0) {
        console.warn(`[Audio] ${failedCount} чанков не загрузились, отправляем весь аудио целиком`)
        const fullBlob = new Blob(audioChunksRef.current, { type: "audio/webm" })
        await uploadAudioWithRetry(sessionId, fullBlob, 5)
      }
      audioChunksRef.current = []

      streamRef.current?.getTracks().forEach((track) => track.stop())

      let position: { latitude: number; longitude: number; accuracy: number }

      if (lastPositionRef.current) {
        position = lastPositionRef.current
      } else {
        // Fallback 1: сохранённые координаты из подготовки
        const stored = storage.getLastPosition()
        if (stored) {
          console.warn("[RecordingSession] finishRecording: используем сохранённую позицию")
          position = { latitude: stored.lat, longitude: stored.lng, accuracy: stored.acc }
        } else {
          // Fallback 2: попытка через navigator.geolocation
          try {
            position = await new Promise<GeolocationCoordinates>((resolve, reject) => {
              if (!navigator.geolocation) { reject(new Error(ui.geoNotSupportedThrow)); return }
              const timeoutId = setTimeout(() => reject(new Error(ui.geoTimeoutThrow)), 15000)
              navigator.geolocation.getCurrentPosition(
                (pos) => { clearTimeout(timeoutId); resolve(pos.coords) },
                (err) => { clearTimeout(timeoutId); reject(err) },
                { enableHighAccuracy: false, timeout: 15000, maximumAge: 30000 }
              )
            })
          } catch {
            // Последний резерв — нули (сессия всё равно завершится)
            console.error("[RecordingSession] finishRecording: координаты недоступны, используем 0,0")
            position = { latitude: 0, longitude: 0, accuracy: 0 }
          }
        }
      }

      const snapshotAnswers = answersRef.current
      const snapshotVisible = visibleQuestionsRef.current

      const isComplete = snapshotVisible.every((q) => {
        if (q.type === "multi_text") {
          return (q.subFields ?? []).some(
            (f) => typeof snapshotAnswers[f.id] === "string" && (snapshotAnswers[f.id] as string).trim().length > 0
          )
        }
        const val = snapshotAnswers[q.id]
        if (val === undefined || val === null || val === "") return false
        if (Array.isArray(val) && val.length === 0) return false
        return true
      })

      const surveyAnswersList = snapshotVisible
        .filter((q) => {
          if (q.type === "multi_text") {
            return (q.subFields ?? []).some(
              (f) => typeof snapshotAnswers[f.id] === "string" && (snapshotAnswers[f.id] as string).trim().length > 0
            )
          }
          const val = snapshotAnswers[q.id]
          if (val === undefined || val === null || val === "") return false
          if (Array.isArray(val) && val.length === 0) return false
          return true
        })
        .map((q) => {
          if (q.type === "multi_text") {
            const value = (q.subFields ?? [])
              .map((f) => snapshotAnswers[f.id])
              .filter((v) => typeof v === "string" && (v as string).trim().length > 0)
            return { key: q.id, question: q.title, type: q.type, value }
          }

          let value = snapshotAnswers[q.id]

          if (q.type === "multiple_choice" && q.options) {
              if (value === q.otherOptionUuid && q.otherInputGroupId) {
                  const customText = String(snapshotAnswers[q.otherInputGroupId] ?? "").trim()
                  value = customText ? `Другой: ${customText}` : (q.options.find((o) => o.uuid === value)?.text ?? value)
              } else {
                  const found = q.options.find((o) => o.uuid === value)
                  value = found?.text ?? value
              }
          }
          if (q.type === "checkbox" && q.options && Array.isArray(value)) {
              value = (value as string[]).map((uuid) => {
                  if (uuid === q.otherOptionUuid && q.otherInputGroupId) {
                      const customText = String(snapshotAnswers[q.otherInputGroupId] ?? "").trim()
                      if (customText) return `Другой: ${customText}`
                  }
                  const found = q.options!.find((o) => o.uuid === uuid)
                  return found?.text ?? uuid
              })
          }
          if (q.type === "dropdown" && q.options) {
            const found = q.options.find((o) => o.uuid === value)
            value = found?.text ?? value
          }

          return {
            key: q.id,
            question: q.title,
            type: q.type,
            value,
          }
        })

      let lastErr: any = null
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await apiClient.completeSession(sessionId, position.latitude, position.longitude, position.accuracy as number, surveyAnswersList, isComplete)
          onComplete()
          return
        } catch (err: any) {
          lastErr = err
          if (attempt < 2) await new Promise<void>((r) => setTimeout(r, 1500 * (attempt + 1)))
        }
      }
      throw lastErr
    } catch (err: any) {
      setError(err?.message || ui.sessionFinishError)
      setLoading(false)
    }
  }

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60)
    const s = seconds % 60
    return `${m}:${s.toString().padStart(2, "0")}`
  }

  const handleAnswer = (questionId: string, value: any) => {
    const newAnswers = { ...answers, [questionId]: value }
    setAnswers(newAnswers)

    const isOtherSelected =
      currentQuestion?.otherOptionUuid &&
      currentQuestion?.otherInputGroupId &&
      value === currentQuestion.otherOptionUuid

    let newResult = logicResult
    if (logicEngine) {
      newResult = logicEngine.evaluate(newAnswers)
      setLogicResult(newResult)

      if (newResult.jumpToPageUuid && !isOtherSelected) {
        // JUMP_TO_PAGE always means end-of-path for this respondent (quota/screening or real end)
        setShowFinishConfirm(true)
        return
      }
    }

    const answeredForFinish =
      value !== undefined &&
      value !== null &&
      value !== "" &&
      !(typeof value === "number" && Number.isNaN(value))

    if (
      currentQuestion?.id === questionId &&
      !["text", "number", "multi_text"].includes(currentQuestion?.type ?? "") &&
      answeredForFinish
    ) {
      // compute visibleQuestions with the NEW logic result (not stale state)
      const newVisible = questionsResolved.filter((q) => {
        if (newResult.hiddenGroupUuids.has(q.id)) return false
        if (q.type === "multi_text" && q.subFields) {
          if (q.subFields.every((f) => newResult.hiddenGroupUuids.has(f.id))) return false
        }
        return true
      })
      const curIdx = newVisible.findIndex((q) => q.id === questionId)
      const nextQ = curIdx >= 0 ? newVisible[curIdx + 1] : undefined

      const hasInlineTextFollowUp =
        currentQuestion?.type === "linear_scale" && nextQ?.type === "text"

      const isLastInNew = curIdx >= 0 && curIdx === newVisible.length - 1

      if (hasInlineTextFollowUp) {
        setShowFinishConfirm(false)
      } else if (isLastInNew) {
        setShowFinishConfirm(true)
      }
    }
  }

  const handleCheckboxAnswer = (questionId: string, optionUuid: string) => {
    const current: string[] = Array.isArray(answers[questionId]) ? answers[questionId] : []
    const isAdding = !current.includes(optionUuid)
    const updated = isAdding
      ? [...current, optionUuid]
      : current.filter((o) => o !== optionUuid)

    let newAnswers = { ...answers, [questionId]: updated }

    // When checking "Другой", auto-copy text from nearest previous checkbox that has Другой text
    if (isAdding && currentQuestion?.otherOptionUuid === optionUuid && currentQuestion?.otherInputGroupId) {
      const currentOtherText = answers[currentQuestion.otherInputGroupId]
      if (!currentOtherText || String(currentOtherText).trim() === "") {
        const curIdx = questionsResolved.findIndex(q => q.id === questionId)
        for (let i = curIdx - 1; i >= 0; i--) {
          const prev = questionsResolved[i]
          if (!prev || prev.type !== "checkbox" || !prev.otherInputGroupId) continue
          const prevText = answers[prev.otherInputGroupId]
          if (prevText && String(prevText).trim()) {
            newAnswers = { ...newAnswers, [currentQuestion.otherInputGroupId]: String(prevText) }
            break
          }
        }
      }
    }

    setAnswers(newAnswers)

    if (logicEngine) {
      const result = logicEngine.evaluate(newAnswers)
      setLogicResult(result)
    }
  }

  const currentQuestion = visibleQuestions[currentQuestionIndex]
  const isLastVisible = currentQuestionIndex === visibleQuestions.length - 1

const scaleAnswered =
  currentQuestion?.type === "linear_scale" &&
  answers[currentQuestion.id] !== undefined &&
  answers[currentQuestion.id] !== null &&
  answers[currentQuestion.id] !== ""

  // Для inline follow-up фильтруем с актуальным logicResult (уже обновлён в handleAnswer)
const visibleForFollowUp = questionsResolved.filter((q) => {
    if (logicResult.hiddenGroupUuids.has(q.id)) return false
    if (q.type === "multi_text" && q.subFields) {
      if (q.subFields.every((f) => logicResult.hiddenGroupUuids.has(f.id))) return false
    }
    return true
  })

  const curIdxForFollowUp = visibleForFollowUp.findIndex(q => q.id === currentQuestion?.id)
  const nextVisibleQ = curIdxForFollowUp >= 0 ? visibleForFollowUp[curIdxForFollowUp + 1] : undefined
  const inlineFollowUp =
    scaleAnswered && nextVisibleQ?.type === "text" ? nextVisibleQ : null

  useEffect(() => {
    if (!showFinishConfirm) return
    if (!currentQuestion || !inlineFollowUp) return

    const followUpValue = answers[inlineFollowUp.id]
    const followUpFilled =
      typeof followUpValue === "string" && followUpValue.trim().length > 0

    if (!followUpFilled) {
      setShowFinishConfirm(false)
    }
  }, [showFinishConfirm, currentQuestion?.id, inlineFollowUp?.id, answers])

  const canGoNext = (() => {
    if (!currentQuestion) return true

    const v = answers[currentQuestion.id]
    let answered = false
    switch (currentQuestion.type) {
      case "multiple_choice":
      case "dropdown":
        answered = v !== undefined && v !== null && String(v).length > 0
        break
      case "checkbox":
        answered = Array.isArray(v) && v.length > 0
        break
      case "linear_scale":
      case "number":
        answered = v !== undefined && v !== null && v !== ""
        break
      case "text":
        answered = typeof v === "string" && v.trim().length > 0
        break
      case "multi_text":
        answered = (currentQuestion.subFields ?? []).some(
          (f) => typeof answers[f.id] === "string" && (answers[f.id] as string).trim().length > 0
        )
        break
      case "yes_no":
        answered = v === "yes" || v === "no"
        break
      default:
        answered = v !== undefined && v !== null && v !== ""
    }

    if (!answered) return false

    // If there's an inline follow-up, require it to be filled too
    if (inlineFollowUp) {
      const fv = answers[inlineFollowUp.id]
      if (!fv || (typeof fv === "string" && fv.trim().length === 0)) return false
    }

    if (currentQuestion.otherOptionUuid && currentQuestion.otherInputGroupId) {
      const isOtherSelected =
        currentQuestion.type === "multiple_choice"
          ? answers[currentQuestion.id] === currentQuestion.otherOptionUuid
          : Array.isArray(answers[currentQuestion.id]) &&
          answers[currentQuestion.id].includes(currentQuestion.otherOptionUuid)

      if (isOtherSelected) {
        const otherText = answers[currentQuestion.otherInputGroupId]
        if (!otherText || String(otherText).trim() === "") return false
      }
    }

    return true
  })()

  const handleNext = () => {
    if (!canGoNext) return

    // If quota/screening rule fired, never advance — re-show finish dialog
    if (logicResult.jumpToPageUuid) {
      setShowFinishConfirm(true)
      return
    }

    // Skip inline follow-up (already answered on this screen)
    const step = inlineFollowUp ? 2 : 1
    if (currentQuestionIndex + step < visibleQuestions.length) {
      setCurrentQuestionIndex((prev) => prev + step)
    } else if (inlineFollowUp) {
      // inline follow-up was the last question → finish
      setShowFinishConfirm(true)
    }
  }

  const handlePrevious = () => {
    if (currentQuestionIndex > 0) {
      setShowFinishConfirm(false)
      setCurrentQuestionIndex((prev) => prev - 1)
    }
  }

  if (loading) {
    return (
      <div className="fixed inset-0 bg-background/95 flex items-center justify-center z-50 p-4">
        <Card className="max-w-md w-full">
          <CardContent className="pt-6 sm:pt-8 text-center space-y-3 sm:space-y-4 px-4 sm:px-6">
            <Loader2 className="h-6 w-6 sm:h-8 sm:w-8 animate-spin text-primary mx-auto" />
            <p className="font-semibold text-sm sm:text-base">{ui.initSessionTitle}</p>
            <div className="space-y-1 sm:space-y-2 text-xs sm:text-sm text-muted-foreground">
              <p>{geoStatus}</p>
              <p>{micStatus}</p>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  const isForcedFinish = Boolean(logicResult.jumpToPageUuid)

  if (error && !streamRef.current) {
    return (
      <div className="fixed inset-0 bg-background flex flex-col items-center justify-center z-50 p-6 text-center">
        <AlertCircle className="h-16 w-16 text-destructive mb-4" />
        <h2 className="font-bold text-xl mb-2">
          {locale === "uz" ? "Ruxsat majburiy" : "Доступ обязателен"}
        </h2>
        <p className="text-muted-foreground text-sm mb-6">
          {locale === "uz" ? (
            <>So'rovnomani o'tkazish uchun <b>mikrofon</b> va <b>geolokatsiyaga</b> ruxsat berish majburiydir. Busiz so'rovnomani boshlash imkonsiz.</>
          ) : (
            <>Для проведения опроса необходимо обязательно разрешить доступ к <b>микрофону</b> и <b>геолокации</b>. Без этого начать опрос невозможно.</>
          )}
        </p>
        <p className="text-xs text-destructive mb-6 font-mono bg-destructive/10 p-2 rounded w-full max-w-md break-words">
          {error}
        </p>
        <Button onClick={() => window.location.reload()} className="w-full max-w-xs h-12">
          {locale === "uz" ? "Yangilash va ruxsat berish" : "Обновить и разрешить доступ"}
        </Button>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 bg-background overflow-y-auto">
      <div
        className="pb-[140px] px-4"
        style={{ paddingTop: "var(--tg-safe-top, max(16px, env(safe-area-inset-top)))" }}
        onClick={(e) => {
          const tag = (e.target as HTMLElement).tagName
          if (!["INPUT", "TEXTAREA", "BUTTON", "LABEL", "SELECT"].includes(tag)) {
            ; (document.activeElement as HTMLElement)?.blur()
          }
        }}
      >
        <div className="mb-4 min-w-0">
          <h2 className="font-semibold text-base sm:text-lg break-words">{survey.title}</h2>
          {visibleQuestions.length > 0 && (
            <p className="text-xs text-muted-foreground mt-1">
              {ui.questionProgress(currentQuestionIndex + 1, visibleQuestions.length)}
            </p>
          )}
        </div>

        {error && (
          <Alert variant="destructive" className="mb-4 text-xs">
            <AlertCircle className="h-3 w-3" />
            <AlertDescription className="text-xs">{error}</AlertDescription>
          </Alert>
        )}

        {loadingQuestions ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
            <span className="ml-2 text-sm text-muted-foreground">{ui.loadingQuestions}</span>
          </div>
        ) : visibleQuestions.length === 0 ? (
          <p className="text-sm text-muted-foreground py-10 text-center">
            {ui.noQuestions}
          </p>
        ) : currentQuestion ? (
          <div className="space-y-4">
            {currentQuestion.contextHeading && (
              <p className="text-base font-semibold text-foreground leading-snug">
                {renderCurlyBraceInnerRed(
                  applyAtMentionPlain(
                    currentQuestion.contextHeading,
                    getAtMentionReplacement(
                      questions,
                      visibleQuestions,
                      answers,
                      currentQuestion
                    )
                  ),
                  "ctx-"
                )}
              </p>
            )}
            <h3 className="font-medium text-sm text-muted-foreground leading-snug">
              {currentQuestion.rawSchema
                ? renderSchemaWithReplacements(currentQuestion.rawSchema, currentQuestion.id)
                : renderCurlyBraceInnerRed(
                  applyAtMentionPlain(
                    currentQuestion.title,
                    getAtMentionReplacement(
                      questions,
                      visibleQuestions,
                      answers,
                      currentQuestion
                    )
                  ),
                  "qtitle-"
                )}
              {currentQuestion.required && <span className="text-red-500 ml-1">*</span>}
            </h3>

            {currentQuestion.type === "multiple_choice" && currentQuestion.options && (
              <div className="space-y-2">
                {currentQuestion.options
                  .filter((option) => !logicResult.hiddenGroupUuids.has(option.uuid))
                  .map((option) => {
                    const isSelected = answers[currentQuestion.id] === option.uuid
                    const isOtherOption = option.uuid === currentQuestion.otherOptionUuid
                    return (
                      <div key={option.uuid}>
                        <label
                          className="flex items-center gap-3 p-3 border-2 rounded-lg cursor-pointer active:bg-muted/70 transition-colors"
                          style={{
                            borderColor: isSelected ? "hsl(var(--primary))" : undefined,
                          }}
                        >
                          <input
                            type="radio"
                            name={`question-${currentQuestion.id}`}
                            value={option.uuid}
                            checked={isSelected}
                            onChange={() => handleAnswer(currentQuestion.id, option.uuid)}
                            className="w-4 h-4 text-primary flex-shrink-0"
                          />
                          <span className="flex-1 text-sm break-words">
                            {renderCurlyBraceInnerRed(option.text, `mc-${option.uuid}-`)}
                          </span>
                          {isSelected && (
                            <CheckCircle2 className="h-4 w-4 text-primary flex-shrink-0" />
                          )}
                        </label>
                        {isOtherOption && isSelected && currentQuestion.otherInputGroupId && (
                          <input
                            type="text"
                            value={answers[currentQuestion.otherInputGroupId!] || ""}
                            onChange={(e) =>
                              setAnswers((prev) => ({
                                ...prev,
                                [currentQuestion.otherInputGroupId!]: e.target.value,
                              }))
                            }
                            placeholder={ui.placeholderOther}
                            className="mt-1 w-full p-3 text-sm border-2 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary"
                          />
                        )}
                      </div>
                    )
                  })}
              </div>
            )}

            {currentQuestion.type === "dropdown" && currentQuestion.options && (
              <Select
                value={
                  typeof answers[currentQuestion.id] === "string" &&
                    answers[currentQuestion.id] !== ""
                    ? (answers[currentQuestion.id] as string)
                    : undefined
                }
                onValueChange={(v: string) => handleAnswer(currentQuestion.id, v)}
              >
                <SelectTrigger className="w-full h-auto min-h-12 py-3 text-sm border-2 rounded-lg focus:ring-2 focus:ring-primary bg-background whitespace-normal [&_[data-slot=select-value]]:text-left [&_[data-slot=select-value]]:whitespace-normal">
                  {(() => {
                    const selUuid =
                      typeof answers[currentQuestion.id] === "string" &&
                        answers[currentQuestion.id] !== ""
                        ? (answers[currentQuestion.id] as string)
                        : undefined
                    const selOption = selUuid
                      ? currentQuestion.options!.find((o: QuestionOption) => o.uuid === selUuid)
                      : undefined
                    return selOption ? (
                      <span data-slot="select-value">
                        {renderCurlyBraceInnerRed(selOption.text, "dd-trg-")}
                      </span>
                    ) : (
                      <SelectValue placeholder={ui.selectPlaceholder} />
                    )
                  })()}
                </SelectTrigger>
                <SelectContent>
                  {currentQuestion.options.map((option: QuestionOption) => (
                    <SelectItem key={option.uuid} value={option.uuid} className="py-2.5">
                      {renderCurlyBraceInnerRed(option.text, `dd-${option.uuid}-`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {currentQuestion.type === "checkbox" && currentQuestion.options && (() => {
              const opts = currentQuestion.options!
              const visibleOptions = (marketplaceQ2OptionOrder?.questionId === currentQuestion.id
                ? marketplaceQ2OptionOrder.uuids
                  .map((uuid: string) => opts.find((o: QuestionOption) => o.uuid === uuid))
                  .filter((o): o is QuestionOption => !!o && !logicResult.hiddenGroupUuids.has(o.uuid))
                : opts.filter((option: QuestionOption) => !logicResult.hiddenGroupUuids.has(option.uuid))
              )
              return (
                <div className="space-y-2">
                  {visibleOptions.map((option: QuestionOption) => {
                    const selected: string[] = Array.isArray(answers[currentQuestion.id])
                      ? answers[currentQuestion.id]
                      : []
                    const isChecked = selected.includes(option.uuid)
                    const isOtherOption = option.uuid === currentQuestion.otherOptionUuid
                    return (
                      <div key={option.uuid}>
                        <label
                          className="flex items-center gap-3 p-3 border-2 rounded-lg cursor-pointer active:bg-muted/70 transition-colors"
                          style={{ borderColor: isChecked ? "hsl(var(--primary))" : undefined }}
                        >
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => handleCheckboxAnswer(currentQuestion.id, option.uuid)}
                            className="w-4 h-4 text-primary flex-shrink-0"
                          />
                          <span className="flex-1 text-sm break-words">
                            {renderCurlyBraceInnerRed(option.text, `cb-${option.uuid}-`)}
                          </span>
                          {isChecked && <CheckCircle2 className="h-4 w-4 text-primary flex-shrink-0" />}
                        </label>
                        {isOtherOption && isChecked && currentQuestion.otherInputGroupId && (
                          <input
                            type="text"
                            value={answers[currentQuestion.otherInputGroupId!] || ""}
                            onChange={(e: any) =>
                              setAnswers((prev: Answers) => ({
                                ...prev,
                                [currentQuestion.otherInputGroupId!]: e.target.value,
                              }))
                            }
                            placeholder={ui.placeholderOther}
                            className="mt-1 w-full p-3 text-sm border-2 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary"
                          />
                        )}
                      </div>
                    )
                  })}
                </div>
              )
            })()}

            {currentQuestion.type === "linear_scale" && (
              <div className="space-y-3">
                <div className="flex gap-2 flex-wrap">
                  {Array.from(
                    {
                      length:
                        (currentQuestion.scaleMax ?? 10) -
                        (currentQuestion.scaleMin ?? 0) +
                        1,
                    },
                    (_, i) => (currentQuestion.scaleMin ?? 0) + i
                  ).map((val) => (
                    <button
                      key={val}
                      onClick={() => handleAnswer(currentQuestion.id, val)}
                      className={`w-10 h-10 rounded-lg border-2 text-sm font-semibold transition-colors ${answers[currentQuestion.id] === val
                        ? "bg-primary text-primary-foreground border-primary"
                        : "border-border hover:border-primary"
                        }`}
                    >
                      {val}
                    </button>
                  ))}
                </div>
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>{ui.scaleMinLabel}</span>
                  <span>{ui.scaleMaxLabel}</span>
                </div>
              </div>
            )}

            {inlineFollowUp && (
              <div className="mt-4 space-y-2">
                <p className="text-sm font-medium text-foreground leading-snug">
                  {inlineFollowUp.title}
                </p>
                <textarea
                  value={String(answers[inlineFollowUp.id] ?? "")}
                  onChange={(e) => handleAnswer(inlineFollowUp.id, e.target.value)}
                  onFocus={(e) => {
                    setKeyboardOpen(true)
                    const el = e.currentTarget
                    setTimeout(() => el.scrollIntoView({ behavior: "smooth", block: "center" }), 350)
                  }}
                  onBlur={() => setTimeout(() => setKeyboardOpen(false), 150)}
                  rows={3}
                  placeholder={ui.placeholderText}
                  className="w-full p-3 text-sm border-2 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary"
                />
              </div>
            )}

            {currentQuestion.type === "number" && (
              <input
                type="number"
                value={answers[currentQuestion.id] ?? ""}
                onChange={(e) =>
                  handleAnswer(
                    currentQuestion.id,
                    e.target.value ? Number(e.target.value) : ""
                  )
                }
                onFocus={() => setKeyboardOpen(true)}
                onBlur={() => setTimeout(() => setKeyboardOpen(false), 150)}
                placeholder={ui.placeholderNumber}
                className="w-full p-3 text-sm border-2 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary"
              />
            )}

            {currentQuestion.type === "text" && (
              <textarea
                value={answers[currentQuestion.id] ?? ""}
                onChange={(e) => handleAnswer(currentQuestion.id, e.target.value)}
                onFocus={(e) => {
                  setKeyboardOpen(true)
                  const el = e.currentTarget
                  setTimeout(
                    () => el.scrollIntoView({ behavior: "smooth", block: "center" }),
                    350
                  )
                }}
                onBlur={() => {
                  const qid = currentQuestion.id
                  setTimeout(() => {
                    setKeyboardOpen(false)
                    const t = answersRef.current[qid]
                    if (isLastVisible && typeof t === "string" && t.trim().length > 0) {
                      setShowFinishConfirm(true)
                    }
                  }, 150)
                }}
                placeholder={ui.placeholderText}
                rows={4}
                className="w-full p-3 text-sm border-2 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary transition-all"
              />
            )}

            {currentQuestion.type === "multi_text" && currentQuestion.subFields && (
              <div className="space-y-2">
                {currentQuestion.subFields.map((field, idx) => (
                  <input
                    key={field.id}
                    type="text"
                    value={typeof answers[field.id] === "string" ? answers[field.id] : ""}
                    onChange={(e) => {
                      const newVal = e.target.value
                      setAnswers((prev) => {
                        const updated = { ...prev, [field.id]: newVal }
                        // sync question.id so conditional logic (IS_NOT_EMPTY) sees this answer
                        const firstFilled = currentQuestion.subFields!
                          .map((f) => (f.id === field.id ? newVal : String(prev[f.id] ?? "")))
                          .find((v) => v.trim().length > 0) ?? ""
                        updated[currentQuestion.id] = firstFilled
                        return updated
                      })
                    }}
                    onFocus={() => setKeyboardOpen(true)}
                    onBlur={() => setTimeout(() => setKeyboardOpen(false), 150)}
                    placeholder={`${idx + 1}.`}
                    className="w-full p-3 text-sm border-2 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary"
                  />
                ))}
              </div>
            )}

            {currentQuestion.type === "yes_no" && (
              <div className="flex gap-3">
                <Button
                  variant={answers[currentQuestion.id] === "yes" ? "default" : "outline"}
                  onClick={() => handleAnswer(currentQuestion.id, "yes")}
                  className="flex-1 h-11"
                >
                  {ui.yes}
                </Button>
                <Button
                  variant={answers[currentQuestion.id] === "no" ? "default" : "outline"}
                  onClick={() => handleAnswer(currentQuestion.id, "no")}
                  className="flex-1 h-11"
                >
                  {ui.no}
                </Button>
              </div>
            )}

            {visibleQuestions.length > 1 && (
              <div className="flex gap-2 pt-2 border-t">
                <Button
                  variant="outline"
                  onClick={handlePrevious}
                  disabled={currentQuestionIndex === 0}
                  className="flex-1 h-10 text-sm"
                >
                  {ui.back}
                </Button>
                {!isLastVisible && (
                  <Button
                    onClick={handleNext}
                    disabled={!canGoNext}
                    className="flex-1 h-10 text-sm"
                  >
                    {ui.next}
                  </Button>
                )}
              </div>
            )}
          </div>
        ) : null}
      </div>

      <div
        className="fixed bottom-0 left-0 right-0 bg-background border-t z-50 px-4 pt-3 space-y-2 transition-transform duration-200"
        style={{
          paddingBottom: "max(12px, env(safe-area-inset-bottom))",
          transform: keyboardOpen ? "translateY(100%)" : "translateY(0)",
        }}
      >
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <div className="flex items-center gap-1">
            <MapPin className="h-3 w-3 text-primary" />
            <span className="truncate max-w-[200px]">{geoStatus}</span>
          </div>
          <span className="font-mono font-bold text-primary text-sm">{formatTime(duration)}</span>
        </div>

        {showFinishConfirm ? (
          <div className="flex gap-2">
            {!isForcedFinish && (
              <Button
                variant="outline"
                onClick={() => setShowFinishConfirm(false)}
                className="flex-1 h-11 text-sm"
              >
                {ui.finishConfirmNo}
              </Button>
            )}

            <Button
              onClick={finishRecording}
              disabled={loading}
              className={`${isForcedFinish ? "w-full" : "flex-1"} h-11 bg-destructive hover:bg-destructive/90 text-white text-sm`}
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                ui.finishConfirmYes
              )}
            </Button>
          </div>
        ) : (
          <Button
            onClick={() => setShowFinishConfirm(true)}
            disabled={loading}
            className="w-full h-11 bg-primary hover:bg-primary/90 gap-2"
          >
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {ui.finishing}
              </>
            ) : (
              <>
                <Square className="h-4 w-4" />
                {ui.finish}
              </>
            )}
          </Button>
        )}

        {showFinishConfirm && (
          <p className="text-xs text-center text-muted-foreground">
            {isForcedFinish
              ? locale === "uz"
                ? "Respondent so‘rov shartlariga mos kelmaydi."
                : "Респондент не подходит по условиям опроса."
              : ui.finishConfirmQuestion}
          </p>
        )}
      </div>
    </div>
  )
}
