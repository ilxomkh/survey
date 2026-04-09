"use client"

import { useState, useEffect, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { AlertCircle, Square, Loader2, MapPin, CheckCircle2 } from "lucide-react"
import { apiClient } from "@/lib/api-client"
import { buildLogicEngine, TallyLogicEngine, LogicResult, Answers } from "@/lib/tally-logic-engine"

interface Survey {
  id: number
  title: string
}

// option uuid + text birga saqlanadi
interface QuestionOption {
  uuid: string
  text: string
}

interface Question {
  id: string        // blockGroupUuid (input blok groupUuid) — answers kaliti va engine kaliti
  title: string
  rawSchema?: any   // oригинальный safeHTMLSchema для цветного рендера
  type: string
  options?: QuestionOption[]
  required?: boolean
  scaleMin?: number
  scaleMax?: number
  multiple?: boolean
  otherOptionUuid?: string    // "Другой" option uuid — checkbox uchun
  otherInputGroupId?: string  // INPUT_TEXT groupUuid — "Другой" yozuvi uchun
}

interface RecordingSessionProps {
  sessionId: string
  survey: Survey
  onComplete: () => void
}

export function RecordingSession({ sessionId, survey, onComplete }: RecordingSessionProps) {
  const [isRecording, setIsRecording] = useState(false)
  const [duration, setDuration] = useState(0)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)
  const [geoStatus, setGeoStatus] = useState("Получение локации...")
  const [micStatus, setMicStatus] = useState("Запрос микрофона...")
  const [questions, setQuestions] = useState<Question[]>([])
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0)
  const [answers, setAnswers] = useState<Answers>({})
  const [loadingQuestions, setLoadingQuestions] = useState(true)
  const [showFinishConfirm, setShowFinishConfirm] = useState(false)
  const [keyboardOpen, setKeyboardOpen] = useState(false)

  // Conditional logic
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

  // ─── Answers o'zgarganda logic qayta hisoblash ──────────────
  useEffect(() => {
    if (!logicEngine) return
    const result = logicEngine.evaluate(answers)
    setLogicResult(result)
  }, [answers, logicEngine])

  // ─── Visible questions (yashirilmaganlar) ──────────────────
  const visibleQuestions = questions.filter(
    (q) => !logicResult.hiddenGroupUuids.has(q.id)
  )

  // ─── Парсинг блоков Tally ───────────────────────────────────
  const extractTextFromSchema = (schema: any): string => {
    if (!schema) return ""
    if (typeof schema === "string") return schema
    if (!Array.isArray(schema)) return ""

    return schema
      .map((item: any): string => {
        if (typeof item === "string") return item
        if (!Array.isArray(item)) return ""

        // Структура: [текст_или_массив, ...стили]
        // item[0] может быть: строка, или массив [[текст, стили], ...]
        const first = item[0]
        if (typeof first === "string") return first

        // item[0] — вложенный массив фрагментов [[текст, стили], ...]
        if (Array.isArray(first)) {
          return first
            .map((fragment: any) => {
              if (typeof fragment === "string") return fragment
              if (Array.isArray(fragment) && typeof fragment[0] === "string") return fragment[0]
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

  // Рендер safeHTMLSchema с цветами (красный текст подсказок)
  const renderSchema = (schema: any): React.ReactNode => {
    if (!schema || !Array.isArray(schema)) return null

    const nodes: React.ReactNode[] = []

    schema.forEach((item: any, i: number) => {
      if (typeof item === "string") {
        nodes.push(<span key={i}>{item}</span>)
        return
      }
      if (!Array.isArray(item)) return

      const first = item[0]

      // Простая строка с возможными стилями: ["текст", [["color","red"],...]]
      if (typeof first === "string") {
        const styleArr = item.slice(1)
        const color = styleArr
          .flat(2)
          .find((s: any, idx: number, arr: any[]) => arr[idx - 1] === "color")
        nodes.push(
          <span key={i} style={color ? { color } : undefined}>
            {first}
          </span>
        )
        return
      }

      // Вложенный массив фрагментов: [[["текст", стили], ...], [стили группы...]]
      if (Array.isArray(first)) {
        // Стили группы (второй элемент item)
        const groupStyleArr: any[] = Array.isArray(item[1]) ? item[1] : []
        const groupColor = groupStyleArr
          .flat(2)
          .find((s: any, idx: number, arr: any[]) => arr[idx - 1] === "color")

        const inner = first.map((fragment: any, j: number) => {
          if (typeof fragment === "string") {
            return <span key={j}>{fragment}</span>
          }
          if (Array.isArray(fragment)) {
            const text = fragment[0]
            if (typeof text !== "string") return null
            // Стили фрагмента: [["tag","span"],["color","rgb(...)"]]
            const fragStyles: any[] = fragment.slice(1).flat(1)
            const fragColor = fragStyles
              .find((s: any, idx: number, arr: any[]) => arr[idx - 1] === "color")
            const finalColor = fragColor || groupColor
            return (
              <span key={j} style={finalColor ? { color: finalColor } : undefined}>
                {text}
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
    // CONDITIONAL_LOGIC bu yerda skip QILINMAYDI — engine uchun kerak
    // Faqat UI uchun keraksiz turlar o'tkazib yuboriladi
    const skipTypes = new Set(["FORM_TITLE", "PAGE_BREAK", "HEADING_2", "CONDITIONAL_LOGIC", "HIDDEN_FIELDS"])

    const titleBlocks = blocks.filter(
      (b: any) => b.type === "TITLE" && b.groupType === "QUESTION"
    )

    return titleBlocks
      .map((titleBlock: any, questionIndex: number) => {
        const questionText =
          extractTextFromSchema(titleBlock.payload?.safeHTMLSchema) ||
          titleBlock.payload?.title ||
          titleBlock.text ||
          ""
        const rawSchema = titleBlock.payload?.safeHTMLSchema || null

        const titleBlockIndex = blocks.indexOf(titleBlock)
        const nextTitleBlockIndex =
          questionIndex < titleBlocks.length - 1
            ? blocks.indexOf(titleBlocks[questionIndex + 1])
            : blocks.length

        const siblingBlocks = blocks.slice(titleBlockIndex + 1, nextTitleBlockIndex)
        const firstSibling = siblingBlocks.find((b: any) => !skipTypes.has(b.type))
        const groupType = firstSibling?.groupType || titleBlock.groupType || ""

        // LINEAR_SCALE
        if (groupType === "LINEAR_SCALE" || siblingBlocks.some((b: any) => b.type === "LINEAR_SCALE")) {
          const scaleBlock = siblingBlocks.find((b: any) => b.type === "LINEAR_SCALE") || firstSibling
          // id = scaleBlock groupUuid (engine shu uuid ni kutadi)
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

        // INPUT_NUMBER
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

        // DROPDOWN
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

        // CHECKBOXES — multiple choice
        if (groupType === "CHECKBOXES" || siblingBlocks.some((b: any) => b.type === "CHECKBOX")) {
          const optionBlocks = siblingBlocks.filter((b: any) => b.type === "CHECKBOX")
          const options: QuestionOption[] = optionBlocks
            .map((b: any) => ({
              uuid: b.uuid,
              text: b.payload?.text || extractTextFromSchema(b.payload?.safeHTMLSchema) || b.text || "",
            }))
            .filter((o) => o.text)
          const groupId = optionBlocks[0]?.groupUuid || titleBlock.groupUuid

          // "Другой" option — ищем только по тексту (не по lockInPlace — он у всех)
          // INPUT_TEXT блок рядом = поле ввода для "Другой"
          const inputTextBlock = siblingBlocks.find((b: any) => b.type === "INPUT_TEXT")
          const otherOptionBlock = optionBlocks.find(
            (b: any) =>
              (b.payload?.text || "").toLowerCase().includes("boshqa") ||
              (b.payload?.text || "").toLowerCase().includes("другой") ||
              (b.payload?.text || "").toLowerCase().includes("other")
          )
          // Показывать поле только если otherOptionBlock найден (иначе inputText — не для "Другой")
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
          }
        }

        // MULTIPLE_CHOICE — single choice
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
          // groupId = choice option larning groupUuid (barida bir xil)
          const groupId = choiceOptionBlocks[0]?.groupUuid || titleBlock.groupUuid

          // "Другой" option + INPUT_TEXT поле рядом
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

        // YES_NO
        if (groupType === "YES_NO") {
          return {
            id: titleBlock.groupUuid,
            title: questionText,
            rawSchema,
            type: "yes_no",
            required: titleBlock.payload?.isRequired === true,
          }
        }

        // INPUT_TEXT — default
        const textBlock = siblingBlocks.find((b: any) => b.type === "INPUT_TEXT")
        const groupId = textBlock?.groupUuid || titleBlock.groupUuid
        return {
          id: groupId,
          title: questionText,
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

        // Engine qurish — blocks mavjud bo'lsa
        if (rawBlocks.length > 0) {
          const engine = buildLogicEngine(rawBlocks)
          setLogicEngine(engine)

          // DEBUG: вопросы и их id
          console.log("[DEBUG] Questions parsed:", extractedQuestions.map(q => ({
            id: q.id,
            title: q.title.slice(0, 40),
            type: q.type,
          })))
          console.log("[DEBUG] Engine rules count:", engine.rules.length)
          console.log("[DEBUG] HIDE rules:", engine.rules
            .filter(r => r.actions.some(a => a.type === "HIDE_BLOCKS"))
            .map(r => ({
              conditions: r.conditionals.map(c => `${c.fieldGroupUuid.slice(0,8)} ${c.comparison} ${c.value}`),
              hides: r.actions.filter(a => a.type === "HIDE_BLOCKS").map(a => a.blocks).flat()
            }))
          )
        }
      } catch (err) {
        console.error("[RecordingSession] Ошибка загрузки вопросов:", err)
      } finally {
        setLoadingQuestions(false)
      }
    }

    loadQuestions()
  }, [survey.id, sessionId])

  // ─── Инициализация записи и геолокации ─────────────────────
  useEffect(() => {
    const initializeSession = async () => {
      try {
        const token = localStorage.getItem("auth_token")
        if (token) apiClient.setToken(token)

        if (!navigator.geolocation) {
          setGeoStatus("✗ Геолокация не поддерживается")
          setError("Геолокация не поддерживается вашим браузером")
          setLoading(false)
          return
        }

        await new Promise<void>((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(
            () => resolve(),
            (err) => {
              alert("Геолокация запрещена. Разрешите доступ в настройках телефона")
              setGeoStatus("✗ Геолокация запрещена")
              setError("Геолокация запрещена. Разрешите доступ в настройках телефона")
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
              setGeoStatus(`✓ Локация получена (${position.coords.accuracy.toFixed(0)}м)`)
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
                case err.PERMISSION_DENIED: setGeoStatus("✗ Доступ запрещен"); break
                case err.POSITION_UNAVAILABLE: setGeoStatus("✗ GPS недоступен"); break
                case err.TIMEOUT: setGeoStatus("✗ Таймаут GPS"); break
                default: setGeoStatus(`✗ Ошибка: ${err.message}`)
              }
            },
            { enableHighAccuracy: highAccuracy, timeout: 10000, maximumAge: 5000 }
          )
        }

        startWatching(true)
        locationIntervalRef.current = watchId as any

        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        streamRef.current = stream
        setMicStatus("✓ Микрофон подключен")

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
        setError(err instanceof Error ? err.message : "Ошибка инициализации")
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
  }, [sessionId])

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
        if (!navigator.geolocation) throw new Error("Геолокация не поддерживается")
        position = await new Promise<GeolocationCoordinates>((resolve, reject) => {
          const timeoutId = setTimeout(() => reject(new Error("Таймаут получения геолокации")), 15000)
          navigator.geolocation.getCurrentPosition(
            (pos) => { clearTimeout(timeoutId); resolve(pos.coords) },
            (err) => { clearTimeout(timeoutId); reject(err) },
            { enableHighAccuracy: false, timeout: 15000, maximumAge: 30000 }
          )
        })
      }

      // UUID → Text conversion для backend
      const surveyAnswersList = visibleQuestions
        .filter((q) => {
          const val = answers[q.id]
          if (val === undefined || val === null || val === "") return false
          if (Array.isArray(val) && val.length === 0) return false
          return true
        })
        .map((q) => {
          let value = answers[q.id]

          // uuid → text
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

      await apiClient.completeSession(sessionId, position.latitude, position.longitude, position.accuracy, surveyAnswersList)
      onComplete()
    } catch (err: any) {
      setError(err?.message || "Ошибка завершения сессии")
      setLoading(false)
    }
  }

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60)
    const s = seconds % 60
    return `${m}:${s.toString().padStart(2, "0")}`
  }

  // ─── Answer handlers ────────────────────────────────────────
  // MUHIM: multiple_choice va dropdown uchun uuid saqlanadi (text emas)
  // Checkbox uchun uuid[] massivi saqlanadi

  const handleAnswer = (questionId: string, value: any) => {
    const newAnswers = { ...answers, [questionId]: value }
    setAnswers(newAnswers)

    // Синхронно считаем логику с новыми ответами — не ждём useEffect
    if (logicEngine) {
      const result = logicEngine.evaluate(newAnswers)
      setLogicResult(result)
      if (result.hiddenGroupUuids.size > 0) {
        console.log("[DEBUG] Hidden uuids:", [...result.hiddenGroupUuids])
      }

      // Если JUMP_TO_PAGE сработал — сразу показываем завершение
      // НО: если выбран "Другой" и есть поле ввода — не завершаем, ждём ввода
      const isOtherSelected =
        currentQuestion?.otherOptionUuid &&
        currentQuestion?.otherInputGroupId &&
        value === currentQuestion.otherOptionUuid
      if (result.jumpToPageUuid && !isOtherSelected) {
        setShowFinishConfirm(true)
        return
      }
    }

    // Последний вопрос и не text/number — предлагаем завершить
    if (
      isLastVisible &&
      currentQuestion?.id === questionId &&
      !["text", "number"].includes(currentQuestion?.type) &&
      value
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

    // Синхронно пересчитываем — SHOW/HIDE_BLOCKS сработают сразу
    if (logicEngine) {
      const result = logicEngine.evaluate(newAnswers)
      setLogicResult(result)
    }
  }

  // ─── Navigation ─────────────────────────────────────────────
  const currentQuestion = visibleQuestions[currentQuestionIndex]
  const isLastVisible = currentQuestionIndex === visibleQuestions.length - 1

  const canGoNext = (() => {
    if (!currentQuestion) return true

    // Базовая проверка — ответ дан
    const baseAnswered = currentQuestion.required
      ? answers[currentQuestion.id] !== undefined &&
        answers[currentQuestion.id] !== "" &&
        (Array.isArray(answers[currentQuestion.id])
          ? answers[currentQuestion.id].length > 0
          : true)
      : true

    if (!baseAnswered) return false

    // Если выбран "Другой" и есть поле ввода — оно должно быть заполнено
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
    // JUMP_TO_PAGE triggered — oprosni tugatish
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

  // ─── Loading screen ──────────────────────────────────────────
  if (loading) {
    return (
      <div className="fixed inset-0 bg-background/95 flex items-center justify-center z-50 p-4">
        <Card className="max-w-md w-full">
          <CardContent className="pt-6 sm:pt-8 text-center space-y-3 sm:space-y-4 px-4 sm:px-6">
            <Loader2 className="h-6 w-6 sm:h-8 sm:w-8 animate-spin text-primary mx-auto" />
            <p className="font-semibold text-sm sm:text-base">Инициализация сессии...</p>
            <div className="space-y-1 sm:space-y-2 text-xs sm:text-sm text-muted-foreground">
              <p>{geoStatus}</p>
              <p>{micStatus}</p>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  // ─── Main render ─────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-50 bg-background overflow-y-auto">
      <div
        className="pb-[140px] px-4"
        style={{ paddingTop: "var(--tg-safe-top, max(16px, env(safe-area-inset-top)))" }}
        onClick={(e) => {
          const tag = (e.target as HTMLElement).tagName
          if (!["INPUT", "TEXTAREA", "BUTTON", "LABEL", "SELECT"].includes(tag)) {
            ;(document.activeElement as HTMLElement)?.blur()
          }
        }}
      >
        {/* Заголовок */}
        <div className="mb-4">
          <h2 className="font-semibold text-base sm:text-lg">{survey.title}</h2>
          {visibleQuestions.length > 0 && (
            <p className="text-xs text-muted-foreground mt-1">
              Вопрос {currentQuestionIndex + 1} из {visibleQuestions.length}
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
            <span className="ml-2 text-sm text-muted-foreground">Загрузка вопросов...</span>
          </div>
        ) : visibleQuestions.length === 0 ? (
          <p className="text-sm text-muted-foreground py-10 text-center">
            Вопросы не найдены. Продолжайте запись.
          </p>
        ) : currentQuestion ? (
          <div className="space-y-4">
            {/* Текст вопроса с цветами */}
            <h3 className="font-medium text-base leading-snug">
              {currentQuestion.rawSchema
                ? renderSchema(currentQuestion.rawSchema)
                : currentQuestion.title}
              {currentQuestion.required && <span className="text-red-500 ml-1">*</span>}
            </h3>

            {/* MULTIPLE_CHOICE — uuid saqlanadi, text ko'rsatiladi */}
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
                        <span className="flex-1 text-sm break-words">{option.text}</span>
                        {isSelected && (
                          <CheckCircle2 className="h-4 w-4 text-primary flex-shrink-0" />
                        )}
                      </label>
                      {/* "Другой" — inline текстовое поле */}
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
                          placeholder="Напишите ответ респондента"
                          className="mt-1 w-full p-3 text-sm border-2 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary"
                        />
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {/* DROPDOWN — uuid saqlanadi, text ko'rsatiladi */}
            {currentQuestion.type === "dropdown" && currentQuestion.options && (
              <select
                value={answers[currentQuestion.id] || ""}
                onChange={(e) => handleAnswer(currentQuestion.id, e.target.value)}
                className="w-full p-3 text-sm border-2 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary bg-background"
              >
                <option value="">— Выберите вариант —</option>
                {currentQuestion.options.map((option) => (
                  <option key={option.uuid} value={option.uuid}>
                    {option.text}
                  </option>
                ))}
              </select>
            )}

            {/* CHECKBOX — uuid[] saqlanadi */}
            {currentQuestion.type === "checkbox" && currentQuestion.options && (
              <div className="space-y-2">
                {currentQuestion.options
                  .filter((option) => !logicResult.hiddenGroupUuids.has(option.uuid))
                  .map((option) => {
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
                        <span className="flex-1 text-sm break-words">{option.text}</span>
                        {isChecked && <CheckCircle2 className="h-4 w-4 text-primary flex-shrink-0" />}
                      </label>
                      {/* "Другой" — inline текстовое поле */}
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
                          placeholder="Напишите ответ респондента"
                          className="mt-1 w-full p-3 text-sm border-2 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary"
                        />
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {/* LINEAR_SCALE */}
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
                      className={`w-10 h-10 rounded-lg border-2 text-sm font-semibold transition-colors ${
                        answers[currentQuestion.id] === val
                          ? "bg-primary text-primary-foreground border-primary"
                          : "border-border hover:border-primary"
                      }`}
                    >
                      {val}
                    </button>
                  ))}
                </div>
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Точно нет</span>
                  <span>Точно да</span>
                </div>
              </div>
            )}

            {/* INPUT_NUMBER */}
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
                placeholder="Введите число..."
                className="w-full p-3 text-sm border-2 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary"
              />
            )}

            {/* TEXT */}
            {currentQuestion.type === "text" && (
              <textarea
                value={answers[currentQuestion.id] || ""}
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
                  setTimeout(() => {
                    setKeyboardOpen(false)
                    if (isLastVisible && answers[currentQuestion.id])
                      setShowFinishConfirm(true)
                  }, 150)
                }}
                placeholder="Введите ваш ответ..."
                rows={4}
                className="w-full p-3 text-sm border-2 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary transition-all"
              />
            )}

            {/* YES_NO */}
            {currentQuestion.type === "yes_no" && (
              <div className="flex gap-3">
                <Button
                  variant={answers[currentQuestion.id] === "yes" ? "default" : "outline"}
                  onClick={() => handleAnswer(currentQuestion.id, "yes")}
                  className="flex-1 h-11"
                >
                  Да
                </Button>
                <Button
                  variant={answers[currentQuestion.id] === "no" ? "default" : "outline"}
                  onClick={() => handleAnswer(currentQuestion.id, "no")}
                  className="flex-1 h-11"
                >
                  Нет
                </Button>
              </div>
            )}

            {/* Навигация */}
            {visibleQuestions.length > 1 && (
              <div className="flex gap-2 pt-2 border-t">
                <Button
                  variant="outline"
                  onClick={handlePrevious}
                  disabled={currentQuestionIndex === 0}
                  className="flex-1 h-10 text-sm"
                >
                  Назад
                </Button>
                {!isLastVisible ? (
                  <Button
                    onClick={handleNext}
                    disabled={!canGoNext}
                    className="flex-1 h-10 text-sm"
                  >
                    Далее
                  </Button>
                ) : (
                  canGoNext && (
                    <Button
                      onClick={() => setShowFinishConfirm(true)}
                      className="flex-1 h-10 text-sm bg-green-600 hover:bg-green-700 text-white"
                    >
                      Завершить опрос
                    </Button>
                  )
                )}
              </div>
            )}
          </div>
        ) : null}
      </div>

      {/* ─── Фиксированная панель снизу ─── */}
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
              Нет, продолжить
            </Button>
            <Button
              onClick={finishRecording}
              disabled={loading}
              className="flex-1 h-11 bg-destructive hover:bg-destructive/90 text-white text-sm"
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                "Да, завершить"
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
                Завершение...
              </>
            ) : (
              <>
                <Square className="h-4 w-4" />
                Завершить
              </>
            )}
          </Button>
        )}

        {showFinishConfirm && (
          <p className="text-xs text-center text-muted-foreground">
            Точно хотите завершить опрос?
          </p>
        )}
      </div>
    </div>
  )
}