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
  if (mention == null || String(mention).trim() === "" || !text.includes("@")) return text
  return text.replace(/@[^@]*/g, String(mention).trim())
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
  return text.replace(/\}\s*tag[a-z][a-z0-9-]*/gi, "}").trimEnd()
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
  "чаще всего",
  "eng ko'p",
  "eng ko`p",
  "ko'proq",
  "ko`proq",
  "koproq",
] as const

function titleMatchesAnyFragment(title: string, fragments: readonly string[]): boolean {
  const t = title.toLowerCase()
  return fragments.some((f) => t.includes(f.toLowerCase()))
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
    const q2 = resolveMarketplaceQ2(questions)
    const q3Index = resolveFrequencyQ3Index(questions, q2)
    if (!q2 || q3Index === -1) return questions

    const selected = answers[q2.id]
    if (!Array.isArray(selected) || selected.length === 0) return questions

    const q3 = questions[q3Index]
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

    if (newOptions.length === 0) return questions

    return questions.map((q, i) =>
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
    const q2 = resolveMarketplaceQ2(questions)
    if (!q2?.options?.length) return null
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
  }, [questions])

  // ─── Visible questions (yashirilmaganlar) ──────────────────
  const visibleQuestions = questionsResolved.filter(
    (q) => !logicResult.hiddenGroupUuids.has(q.id)
  )
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

  // Рендер safeHTMLSchema; `{плейсхолдер}` — красный текст внутри скобок.
  // Pre-scan: если {…} обнаружены где угодно в схеме (даже разбитые по разным фрагментам
  // Tally через mention/color/background-color), склеиваем весь текст и рендерим целиком —
  // это гарантирует красный цвет для ЛЮБОГО будущего опросника.
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

    // Tally хранит открывающую { как чистый вложенный массив-маркер (напр. [["tagmention"]]) —
    // extractTextFromSchema его фильтрует, и { теряется. Закрывающая } при этом лежит в
    // отдельном текстовом узле и проходит нормально.
    // Второй проход: находим позицию «чистого маркера» в fullMerged и вставляем туда {.
    // Важно: используем fullMerged как основу (а не пересобранный текст), чтобы имена Tally-
    // маркеров (tagfont-weight и т.п.) не просочились в итоговую строку.
    if (!fullMerged.includes("{") && fullMerged.includes("}")) {
      let charOffset = 0
      let insertAt = -1
      for (const item of schema) {
        // Воспроизводим логику extractTextFromSchema — ровно столько символов добавляет каждый item
        // (включая фильтрацию top-level Tally-маркеров, добавленную в extractTextFromSchema)
        if (typeof item === "string") {
          if (!isTallyStyleMarker(item)) charOffset += item.length
        } else if (Array.isArray(item)) {
          const f = item[0]
          if (typeof f === "string") {
            if (!isTallyStyleMarker(f)) charOffset += f.length
            // Tally-маркер → 0 символов
          } else if (Array.isArray(f)) {
            // Повторяем инлайн-извлечение из extractTextFromSchema (без рекурсии extractPlainTextFromSchemaGroup,
            // чтобы точно совпадать с длиной fullMerged и не захватить лишний текст)
            const inlineText = f
              .map((fragment: any): string => {
                if (typeof fragment === "string") return isTallyStyleMarker(fragment) ? "" : fragment
                if (Array.isArray(fragment) && typeof fragment[0] === "string")
                  return isTallyStyleMarker(fragment[0]) ? "" : fragment[0]
                return ""
              })
              .join("")
            if (inlineText.trim().length === 0) {
              // Чистый маркер-массив без текста → неявная { (позиция вставки)
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
        // Пропускаем Tally-стилевые маркеры ["tagfont-weight", ...], ["tagcolor", ...] и т.п.
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
            type: "linear_scale",
            scaleMin: scaleBlock?.payload?.startValue ?? scaleBlock?.payload?.start ?? 0,
            scaleMax: scaleBlock?.payload?.endValue ?? scaleBlock?.payload?.end ?? 10,
            required: titleBlock.payload?.isRequired === true,
          }
        }

        if (groupType === "INPUT_NUMBER" || siblingBlocks.some((b: any) => b.type === "INPUT_NUMBER")) {
          const inputBlock = siblingBlocks.find((b: any) => b.type === "INPUT_NUMBER")
          const groupId = inputBlock?.groupUuid || titleBlock.groupUuid
          return {
            id: groupId,
            title: questionText,
            rawSchema,
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

          return {
            id: groupId,
            title: questionText,
            rawSchema,
            type: "checkbox",
            options,
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

          return {
            id: groupId,
            title: questionText,
            rawSchema,
            type: "multiple_choice",
            options,
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
            type: "yes_no",
            required: titleBlock.payload?.isRequired === true,
          }
        }

        const textBlock = siblingBlocks.find((b: any) => b.type === "INPUT_TEXT")
        const groupId = textBlock?.groupUuid || titleBlock.groupUuid
        return {
          id: groupId,
          title: questionText,
          rawSchema,
          type: "text",
          required: titleBlock.payload?.isRequired === true,
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

        const surveyData = await apiClient.getSurveyQuestions(survey.id, sessionId)

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

          console.log("[DEBUG] Questions parsed:", extractedQuestions.map(q => ({
            id: q.id,
            title: q.title.slice(0, 40),
            type: q.type,
          })))
          console.log("[DEBUG] Engine rules count:", engine.rules.length)

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
  }, [survey.id, sessionId])

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

  // @ в safeHTMLSchema: подстановка на **склеенной** строке внутри renderSchema (глубокая правка массива ломала extractTextFromSchema → один «обрубок» текста на последнем шаге).
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

        if (!navigator.geolocation) {
          setGeoStatus(ui.geoUnsupportedShort)
          setError(ui.geoUnsupportedLong)
          setLoading(false)
          return
        }

        await new Promise<void>((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(
            () => resolve(),
            (err) => {
              alert(ui.geoDeniedAlert)
              setGeoStatus(ui.geoDeniedShort)
              setError(ui.geoDeniedLong)
              reject(err)
            },
            { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
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
                await apiClient.updateLocation(
                  sessionId,
                  position.coords.latitude,
                  position.coords.longitude,
                  position.coords.accuracy
                )
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

        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        streamRef.current = stream
        setMicStatus(ui.micOk)

        const mediaRecorder = new MediaRecorder(stream)
        mediaRecorderRef.current = mediaRecorder

        mediaRecorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            const uploadPromise = (async () => {
              try {
                await apiClient.uploadAudio(sessionId, event.data)
              } catch (err) {
                console.error("[RecordingSession] Ошибка отправки аудио:", err)
              }
            })()
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
        navigator.geolocation.clearWatch(locationIntervalRef.current as number)
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
      mediaRecorderRef.current.start(10000)
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

      await Promise.allSettled(uploadPromisesRef.current)
      uploadPromisesRef.current = []

      streamRef.current?.getTracks().forEach((track) => track.stop())

      let position: GeolocationCoordinates

      if (lastPositionRef.current) {
        position = lastPositionRef.current
      } else {
        if (!navigator.geolocation) throw new Error(ui.geoNotSupportedThrow)
        position = await new Promise<GeolocationCoordinates>((resolve, reject) => {
          const timeoutId = setTimeout(() => reject(new Error(ui.geoTimeoutThrow)), 15000)
          navigator.geolocation.getCurrentPosition(
            (pos) => { clearTimeout(timeoutId); resolve(pos.coords) },
            (err) => { clearTimeout(timeoutId); reject(err) },
            { enableHighAccuracy: false, timeout: 15000, maximumAge: 30000 }
          )
        })
      }

      const snapshotAnswers = answersRef.current
      const snapshotVisible = visibleQuestionsRef.current

      // Завершён = все видимые вопросы имеют ответ
      const isComplete = snapshotVisible.every((q) => {
        const val = snapshotAnswers[q.id]
        if (val === undefined || val === null || val === "") return false
        if (Array.isArray(val) && val.length === 0) return false
        return true
      })

      const surveyAnswersList = snapshotVisible
        .filter((q) => {
          const val = snapshotAnswers[q.id]
          if (val === undefined || val === null || val === "") return false
          if (Array.isArray(val) && val.length === 0) return false
          return true
        })
        .map((q) => {
          let value = snapshotAnswers[q.id]

          if (q.type === "multiple_choice" && q.options) {
            const found = q.options.find((o) => o.uuid === value)
            value = found?.text ?? value
          }
          if (q.type === "checkbox" && q.options && Array.isArray(value)) {
            value = (value as string[]).map((uuid) => {
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

      await apiClient.completeSession(sessionId, position.latitude, position.longitude, position.accuracy, surveyAnswersList, isComplete)
      onComplete()
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

    if (logicEngine) {
      const result = logicEngine.evaluate(newAnswers)
      setLogicResult(result)
      if (result.hiddenGroupUuids.size > 0) {
        console.log("[DEBUG] Hidden uuids:", [...result.hiddenGroupUuids])
      }

      const isOtherSelected =
        currentQuestion?.otherOptionUuid &&
        currentQuestion?.otherInputGroupId &&
        value === currentQuestion.otherOptionUuid
      if (result.jumpToPageUuid && !isOtherSelected) {
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
      isLastVisible &&
      currentQuestion?.id === questionId &&
      !["text", "number"].includes(currentQuestion?.type ?? "") &&
      answeredForFinish
    ) {
      setShowFinishConfirm(true)
    }
  }

  const handleCheckboxAnswer = (questionId: string, optionUuid: string) => {
    const current: string[] = Array.isArray(answers[questionId]) ? answers[questionId] : []
    const updated = current.includes(optionUuid)
      ? current.filter((o) => o !== optionUuid)
      : [...current, optionUuid]
    const newAnswers = { ...answers, [questionId]: updated }
    setAnswers(newAnswers)

    if (logicEngine) {
      const result = logicEngine.evaluate(newAnswers)
      setLogicResult(result)
    }
  }

  const currentQuestion = visibleQuestions[currentQuestionIndex]
  const isLastVisible = currentQuestionIndex === visibleQuestions.length - 1

  // «Далее» только после ответа на текущий вопрос (независимо от флага required в Tally)
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
      case "yes_no":
        answered = v === "yes" || v === "no"
        break
      default:
        answered = v !== undefined && v !== null && v !== ""
    }

    if (!answered) return false

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
    // ✅ ФИХ 7: Блокировка если нет ответа
    if (!canGoNext) return

    if (logicResult.jumpToPageUuid) {
      setShowFinishConfirm(true)
      return
    }

    if (currentQuestionIndex < visibleQuestions.length - 1) {
      setCurrentQuestionIndex((prev) => prev + 1)
    }
  }

  const handlePrevious = () => {
    if (currentQuestionIndex > 0) setCurrentQuestionIndex((prev) => prev - 1)
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
            {/* Заголовок: rawSchema — глубокая замена @; плоский title — applyAtMentionPlain + getAtMentionReplacement */}
            <h3 className="font-medium text-base leading-snug">
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
                onValueChange={(v) => handleAnswer(currentQuestion.id, v)}
              >
                <SelectTrigger className="w-full h-auto min-h-12 py-3 text-sm border-2 rounded-lg focus:ring-2 focus:ring-primary bg-background whitespace-normal [&_[data-slot=select-value]]:text-left [&_[data-slot=select-value]]:whitespace-normal">
                  {(() => {
                    const selUuid =
                      typeof answers[currentQuestion.id] === "string" &&
                      answers[currentQuestion.id] !== ""
                        ? (answers[currentQuestion.id] as string)
                        : undefined
                    const selOption = selUuid
                      ? currentQuestion.options!.find((o) => o.uuid === selUuid)
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
                  {currentQuestion.options.map((option) => (
                    <SelectItem key={option.uuid} value={option.uuid} className="py-2.5">
                      {renderCurlyBraceInnerRed(option.text, `dd-${option.uuid}-`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {currentQuestion.type === "checkbox" && currentQuestion.options && (
              <div className="space-y-2">
                {(marketplaceQ2OptionOrder?.questionId === currentQuestion.id
                  ? marketplaceQ2OptionOrder.uuids
                    .map((uuid) =>
                      currentQuestion.options!.find((o) => o.uuid === uuid)
                    )
                    .filter(
                      (o): o is QuestionOption =>
                        !!o && !logicResult.hiddenGroupUuids.has(o.uuid)
                    )
                  : currentQuestion.options.filter(
                    (option) => !logicResult.hiddenGroupUuids.has(option.uuid)
                  )
                ).map((option) => {
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
            <Button
              variant="outline"
              onClick={() => setShowFinishConfirm(false)}
              className="flex-1 h-11 text-sm"
            >
              {ui.finishConfirmNo}
            </Button>
            <Button
              onClick={finishRecording}
              disabled={loading}
              className="flex-1 h-11 bg-destructive hover:bg-destructive/90 text-white text-sm"
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
            {ui.finishConfirmQuestion}
          </p>
        )}
      </div>
    </div>
  )
}