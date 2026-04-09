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
  const questionsRef = useRef<Question[]>([])

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

        const first = item[0]
        if (typeof first === "string") return first

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

  // ✅ Рендер safeHTMLSchema — ВСЕ скобки красным
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

      if (Array.isArray(first)) {
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
          type: "text",
          required: titleBlock.payload?.isRequired === true,
        }
      })
      .filter((q) => q.title.trim().length > 0)
  }

  // ✅ Динамическая инъекция опций из Q2 в Q3
  const injectDynamicOptions = (questions: Question[]): Question[] => {
    // Находим Q2 (checkbox с маркетплейсами)
    const q2 = questions.find(q => 
      q.type === "checkbox" && 
      q.title.toLowerCase().includes("какими онлайн-маркетплейсами") &&
      q.options && q.options.length > 0
    )
    
    // Находим Q3 (multiple choice "чаще всего")
    const q3Index = questions.findIndex(q => 
      q.type === "multiple_choice" && 
      q.title.toLowerCase().includes("чаще всего")
    )

    if (!q2 || q3Index === -1 || !q2.otherInputGroupId) {
      console.log("[DEBUG] Injection skipped:", { 
        hasQ2: !!q2, 
        q3Index, 
        otherInputGroupId: q2?.otherInputGroupId 
      })
      return questions
    }

    const q3 = questions[q3Index]
    
    // Получаем ответ на "Другой" из Q2
    const otherText = answers[q2.otherInputGroupId]
    
    console.log("[DEBUG] Other text from Q2:", otherText)
    
    if (otherText && String(otherText).trim()) {
      // Создаём временный UUID для динамической опции
      const dynamicUuid = `dynamic-other-${q2.otherInputGroupId}`
      
      // Проверяем, не добавили ли уже
      const alreadyExists = q3.options?.some(o => o.uuid === dynamicUuid)
      
      if (!alreadyExists && q3.options) {
        // Находим "Другой" в Q3 и вставляем перед ним
        const otherIndex = q3.options.findIndex(o => 
          o.text.toLowerCase().includes("другой") ||
          o.text.toLowerCase().includes("boshqa") ||
          o.text.toLowerCase().includes("other")
        )
        const insertIndex = otherIndex >= 0 ? otherIndex : q3.options.length
        
        const updatedOptions = [...q3.options]
        updatedOptions.splice(insertIndex, 0, {
          uuid: dynamicUuid,
          text: String(otherText).trim()
        })
        
        console.log("[DEBUG] Injected option:", String(otherText).trim())
        
        const updatedQuestions = [...questions]
        updatedQuestions[q3Index] = {
          ...q3,
          options: updatedOptions
        }
        
        return updatedQuestions
      }
    }

    return questions
  }

  // ✅ Замена @упоминаний на реальные значения в заголовках
  const replaceSchemaPlaceholders = (schema: any, answersMap: Answers): any => {
    if (!schema || !Array.isArray(schema)) return schema

    return schema.map((item: any) => {
      if (typeof item === "string") return item
      if (!Array.isArray(item)) return item

      const first = item[0]

      // Простая строка с mention
      if (typeof first === "string" && first.includes("@")) {
        // Ищем упоминание типа "@Напишите ответ респондента"
        // Это соответствует полю otherInputGroupId из предыдущих вопросов
        
        // Пробуем найти ответ на "Другой" из Q3
        const q3 = questions.find(q => 
          q.type === "multiple_choice" && 
          q.title.toLowerCase().includes("чаще всего")
        )
        
        if (q3?.otherInputGroupId) {
          const otherText = answersMap[q3.otherInputGroupId]
          if (otherText && String(otherText).trim()) {
            return [first.replace(/@[^@]+/g, String(otherText).trim()), ...item.slice(1)]
          }
        }
        
        return item
      }

      // Вложенный массив фрагментов
      if (Array.isArray(first)) {
        const replacedInner = first.map((fragment: any) => {
          if (typeof fragment === "string") return fragment
          if (Array.isArray(fragment)) {
            const text = fragment[0]
            if (typeof text === "string" && text.includes("@")) {
              const q3 = questions.find(q => 
                q.type === "multiple_choice" && 
                q.title.toLowerCase().includes("чаще всего")
              )
              
              if (q3?.otherInputGroupId) {
                const otherText = answersMap[q3.otherInputGroupId]
                if (otherText && String(otherText).trim()) {
                  return [text.replace(/@[^@]+/g, String(otherText).trim()), ...fragment.slice(1)]
                }
              }
            }
            return fragment
          }
          return fragment
        })
        
        return [replacedInner, ...item.slice(1)]
      }

      return item
    })
  }

  // ✅ Рендер с заменой @упоминаний
  const renderSchemaWithReplacements = (schema: any): React.ReactNode => {
    const replacedSchema = replaceSchemaPlaceholders(schema, answers)
    return renderSchema(replacedSchema)
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
        questionsRef.current = extractedQuestions

        if (rawBlocks.length > 0) {
          const engine = buildLogicEngine(rawBlocks)
          setLogicEngine(engine)

          console.log("[DEBUG] Questions parsed:", extractedQuestions.map(q => ({
            id: q.id,
            title: q.title.slice(0, 40),
            type: q.type,
          })))
          console.log("[DEBUG] Engine rules count:", engine.rules.length)
        }
      } catch (err) {
        console.error("[RecordingSession] Ошибка загрузки вопросов:", err)
      } finally {
        setLoadingQuestions(false)
      }
    }

    loadQuestions()
  }, [survey.id, sessionId])

  // ✅ Динамическая инъекция при изменении answers
  useEffect(() => {
    if (questions.length === 0) return
    
    const q2 = questions.find(q => 
      q.type === "checkbox" && 
      q.title.toLowerCase().includes("какими онлайн-маркетплейсами")
    )
    
    if (!q2?.otherInputGroupId) return
    
    const otherText = answers[q2.otherInputGroupId]
    
    if (otherText && String(otherText).trim()) {
      const updated = injectDynamicOptions(questions)
      
      // Избегаем бесконечного цикла - проверяем реальные изменения
      const q3Index = updated.findIndex(q => 
        q.type === "multiple_choice" && 
        q.title.toLowerCase().includes("чаще всего")
      )
      
      if (q3Index !== -1) {
        const prevQ3 = questionsRef.current[q3Index]
        const currQ3 = updated[q3Index]
        
        if (prevQ3?.options?.length !== currQ3?.options?.length) {
          console.log("[DEBUG] Updating questions with injected option")
          questionsRef.current = updated
          setQuestions(updated)
        }
      }
    }
  }, [answers])

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

      const surveyAnswersList = visibleQuestions
        .filter((q) => {
          const val = answers[q.id]
          if (val === undefined || val === null || val === "") return false
          if (Array.isArray(val) && val.length === 0) return false
          return true
        })
        .map((q) => {
          let value = answers[q.id]

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

    if (logicEngine) {
      const result = logicEngine.evaluate(newAnswers)
      setLogicResult(result)
    }
  }

  const currentQuestion = visibleQuestions[currentQuestionIndex]
  const isLastVisible = currentQuestionIndex === visibleQuestions.length - 1

  const canGoNext = (() => {
    if (!currentQuestion) return true

    const baseAnswered = currentQuestion.required
      ? answers[currentQuestion.id] !== undefined &&
        answers[currentQuestion.id] !== "" &&
        (Array.isArray(answers[currentQuestion.id])
          ? answers[currentQuestion.id].length > 0
          : true)
      : true

    if (!baseAnswered) return false

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
            <h3 className="font-medium text-base leading-snug">
              {currentQuestion.rawSchema
                ? renderSchemaWithReplacements(currentQuestion.rawSchema)
                : currentQuestion.title}
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
                        <span className="flex-1 text-sm break-words">{option.text}</span>
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
                          placeholder="Напишите ответ респондента"
                          className="mt-1 w-full p-3 text-sm border-2 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary"
                        />
                      )}
                    </div>
                  )
                })}
              </div>
            )}

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