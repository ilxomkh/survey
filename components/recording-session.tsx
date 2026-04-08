"use client"

import { useState, useEffect, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { AlertCircle, Square, Loader2, MapPin, CheckCircle2 } from "lucide-react"
import { apiClient } from "@/lib/api-client"

interface Survey {
  id: number
  title: string
}

interface Question {
  id: string
  title: string
  type: string
  options?: string[]
  required?: boolean
  scaleMin?: number
  scaleMax?: number
  multiple?: boolean
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
  const [answers, setAnswers] = useState<Record<string, any>>({})
  const [loadingQuestions, setLoadingQuestions] = useState(true)
  const [showFinishConfirm, setShowFinishConfirm] = useState(false)
  const [keyboardOpen, setKeyboardOpen] = useState(false)

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const uploadPromisesRef = useRef<Promise<any>[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const timerRef = useRef<NodeJS.Timeout | null>(null)
  const locationIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const lastPositionRef = useRef<GeolocationCoordinates | null>(null)

  // ─── Парсинг блоков Tally ───────────────────────────────────────
  const extractTextFromSchema = (schema: any): string => {
    if (!schema || !Array.isArray(schema)) return ""
    return schema
      .map((item: any) => {
        if (typeof item === "string") return item
        if (Array.isArray(item) && item.length > 0 && typeof item[0] === "string") return item[0]
        return ""
      })
      .filter(Boolean)
      .join("")
      .trim()
  }

  const parseTallyBlocks = (blocks: any[]): Question[] => {
    const skipTypes = new Set(["FORM_TITLE", "PAGE_BREAK", "CONDITIONAL_LOGIC", "HEADING_2"])

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
          return {
            id: titleBlock.uuid || `question_${questionIndex}`,
            title: questionText,
            type: "linear_scale",
            scaleMin: scaleBlock?.payload?.startValue ?? 0,
            scaleMax: scaleBlock?.payload?.endValue ?? 10,
            required: titleBlock.payload?.isRequired === true,
          }
        }

        // INPUT_NUMBER
        if (groupType === "INPUT_NUMBER" || siblingBlocks.some((b: any) => b.type === "INPUT_NUMBER")) {
          return {
            id: titleBlock.uuid || `question_${questionIndex}`,
            title: questionText,
            type: "number",
            required: titleBlock.payload?.isRequired === true,
          }
        }

        // DROPDOWN
        if (groupType === "DROPDOWN" || siblingBlocks.some((b: any) => b.type === "DROPDOWN_OPTION")) {
          const optionBlocks = siblingBlocks.filter((b: any) => b.type === "DROPDOWN_OPTION")
          const options = optionBlocks
            .map((b: any) => b.payload?.text || extractTextFromSchema(b.payload?.safeHTMLSchema) || b.text || "")
            .filter(Boolean)
          return {
            id: titleBlock.uuid || `question_${questionIndex}`,
            title: questionText,
            type: "dropdown",
            options,
            required: titleBlock.payload?.isRequired === true,
          }
        }

        // CHECKBOX — множественный выбор
        if (groupType === "CHECKBOXES" || siblingBlocks.some((b: any) => b.type === "CHECKBOX")) {
          const optionBlocks = siblingBlocks.filter((b: any) => b.type === "CHECKBOX")
          const options = optionBlocks
            .map((b: any) => b.payload?.text || extractTextFromSchema(b.payload?.safeHTMLSchema) || b.text || "")
            .filter(Boolean)
          return {
            id: titleBlock.uuid || `question_${questionIndex}`,
            title: questionText,
            type: "checkbox",
            options,
            multiple: true,
            required: titleBlock.payload?.isRequired === true,
          }
        }

        // MULTIPLE_CHOICE — одиночный выбор
        const choiceOptionBlocks = siblingBlocks.filter(
          (b: any) => b.type === "MULTIPLE_CHOICE_OPTION" || b.groupType === "MULTIPLE_CHOICE"
        )
        if (choiceOptionBlocks.length > 0) {
          const options = choiceOptionBlocks
            .map((b: any) => b.payload?.text || extractTextFromSchema(b.payload?.safeHTMLSchema) || b.text || "")
            .filter(Boolean)
          return {
            id: titleBlock.uuid || `question_${questionIndex}`,
            title: questionText,
            type: "multiple_choice",
            options,
            required: titleBlock.payload?.isRequired === true,
          }
        }

        // YES_NO
        if (groupType === "YES_NO") {
          return {
            id: titleBlock.uuid || `question_${questionIndex}`,
            title: questionText,
            type: "yes_no",
            required: titleBlock.payload?.isRequired === true,
          }
        }

        // TEXT по умолчанию
        return {
          id: titleBlock.uuid || `question_${questionIndex}`,
          title: questionText,
          type: "text",
          required: titleBlock.payload?.isRequired === true,
        }
      })
      .filter((q) => q.title.trim().length > 0)
  }

  // ─── Загрузка вопросов ──────────────────────────────────────────
  useEffect(() => {
    const loadQuestions = async () => {
      try {
        const token = localStorage.getItem("auth_token")
        if (token) apiClient.setToken(token)

        console.log("[RecordingSession] Загрузка вопросов survey_id:", survey.id, "session_id:", sessionId)
        const surveyData = await apiClient.getSurveyQuestions(survey.id, sessionId)
        console.log("[RecordingSession] Ответ API:", JSON.stringify(surveyData, null, 2))

        let extractedQuestions: Question[] = []

        if (surveyData) {
          if (Array.isArray(surveyData.questions)) {
            extractedQuestions = surveyData.questions
          } else if (Array.isArray(surveyData.blocks)) {
            extractedQuestions = parseTallyBlocks(surveyData.blocks)
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

        console.log("[RecordingSession] Извлечено вопросов:", extractedQuestions.length)
        setQuestions(extractedQuestions)
      } catch (err) {
        console.error("[RecordingSession] Ошибка загрузки вопросов:", err)
      } finally {
        setLoadingQuestions(false)
      }
    }

    loadQuestions()
  }, [survey.id, sessionId])

  // ─── Инициализация записи и геолокации ─────────────────────────
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

      const surveyAnswersList = questions
        .filter((q) => {
          const val = answers[q.id]
          if (val === undefined || val === null || val === "") return false
          if (Array.isArray(val) && val.length === 0) return false
          return true
        })
        .map((q) => ({
          key: q.id,
          question: q.title,
          type: q.type,
          value: answers[q.id],
        }))

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

  const handleAnswer = (questionId: string, answer: any) => {
    setAnswers((prev) => ({ ...prev, [questionId]: answer }))
    if (
      isLastQuestion &&
      currentQuestion?.id === questionId &&
      !["text", "number"].includes(currentQuestion?.type) &&
      answer
    ) {
      setShowFinishConfirm(true)
    }
  }

  const handleCheckboxAnswer = (questionId: string, option: string) => {
    setAnswers((prev) => {
      const current: string[] = Array.isArray(prev[questionId]) ? prev[questionId] : []
      const updated = current.includes(option)
        ? current.filter((o) => o !== option)
        : [...current, option]
      return { ...prev, [questionId]: updated }
    })
  }

  const currentQuestion = questions[currentQuestionIndex]
  const isLastQuestion = currentQuestionIndex === questions.length - 1
  const canGoNext = currentQuestion
    ? currentQuestion.required
      ? answers[currentQuestion.id] !== undefined &&
        answers[currentQuestion.id] !== "" &&
        (Array.isArray(answers[currentQuestion.id]) ? answers[currentQuestion.id].length > 0 : true)
      : true
    : true

  const handleNext = () => {
    if (currentQuestionIndex < questions.length - 1) setCurrentQuestionIndex((prev) => prev + 1)
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
        {/* Заголовок */}
        <div className="mb-4">
          <h2 className="font-semibold text-base sm:text-lg">{survey.title}</h2>
          {questions.length > 0 && (
            <p className="text-xs text-muted-foreground mt-1">
              Вопрос {currentQuestionIndex + 1} из {questions.length}
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
        ) : questions.length === 0 ? (
          <p className="text-sm text-muted-foreground py-10 text-center">
            Вопросы не найдены. Продолжайте запись.
          </p>
        ) : currentQuestion ? (
          <div className="space-y-4">
            {/* Текст вопроса */}
            <h3 className="font-medium text-base leading-snug">
              {currentQuestion.title}
              {currentQuestion.required && <span className="text-red-500 ml-1">*</span>}
            </h3>

            {/* MULTIPLE_CHOICE — одиночный выбор */}
            {currentQuestion.type === "multiple_choice" && currentQuestion.options && (
              <div className="space-y-2">
                {currentQuestion.options.map((option, idx) => (
                  <label
                    key={idx}
                    className="flex items-center gap-3 p-3 border-2 rounded-lg cursor-pointer active:bg-muted/70 transition-colors"
                    style={{
                      borderColor: answers[currentQuestion.id] === option ? "hsl(var(--primary))" : undefined,
                    }}
                  >
                    <input
                      type="radio"
                      name={`question-${currentQuestion.id}`}
                      value={option}
                      checked={answers[currentQuestion.id] === option}
                      onChange={() => handleAnswer(currentQuestion.id, option)}
                      className="w-4 h-4 text-primary flex-shrink-0"
                    />
                    <span className="flex-1 text-sm break-words">{option}</span>
                    {answers[currentQuestion.id] === option && (
                      <CheckCircle2 className="h-4 w-4 text-primary flex-shrink-0" />
                    )}
                  </label>
                ))}
              </div>
            )}

            {/* DROPDOWN — выпадающий список */}
            {currentQuestion.type === "dropdown" && currentQuestion.options && (
              <select
                value={answers[currentQuestion.id] || ""}
                onChange={(e) => handleAnswer(currentQuestion.id, e.target.value)}
                className="w-full p-3 text-sm border-2 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary bg-background"
              >
                <option value="">— Выберите вариант —</option>
                {currentQuestion.options.map((option, idx) => (
                  <option key={idx} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            )}

            {/* CHECKBOX — множественный выбор */}
            {currentQuestion.type === "checkbox" && currentQuestion.options && (
              <div className="space-y-2">
                {currentQuestion.options.map((option, idx) => {
                  const selected: string[] = Array.isArray(answers[currentQuestion.id])
                    ? answers[currentQuestion.id]
                    : []
                  const isChecked = selected.includes(option)
                  return (
                    <label
                      key={idx}
                      className="flex items-center gap-3 p-3 border-2 rounded-lg cursor-pointer active:bg-muted/70 transition-colors"
                      style={{ borderColor: isChecked ? "hsl(var(--primary))" : undefined }}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => handleCheckboxAnswer(currentQuestion.id, option)}
                        className="w-4 h-4 text-primary flex-shrink-0"
                      />
                      <span className="flex-1 text-sm break-words">{option}</span>
                      {isChecked && <CheckCircle2 className="h-4 w-4 text-primary flex-shrink-0" />}
                    </label>
                  )
                })}
              </div>
            )}

            {/* LINEAR_SCALE — шкала */}
            {currentQuestion.type === "linear_scale" && (
              <div className="space-y-3">
                <div className="flex gap-2 flex-wrap">
                  {Array.from(
                    { length: (currentQuestion.scaleMax ?? 10) - (currentQuestion.scaleMin ?? 0) + 1 },
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

            {/* INPUT_NUMBER — число */}
            {currentQuestion.type === "number" && (
              <input
                type="number"
                value={answers[currentQuestion.id] ?? ""}
                onChange={(e) =>
                  handleAnswer(currentQuestion.id, e.target.value ? Number(e.target.value) : "")
                }
                onFocus={() => setKeyboardOpen(true)}
                onBlur={() => setTimeout(() => setKeyboardOpen(false), 150)}
                placeholder="Введите число..."
                className="w-full p-3 text-sm border-2 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary"
              />
            )}

            {/* TEXT — текст */}
            {currentQuestion.type === "text" && (
              <textarea
                value={answers[currentQuestion.id] || ""}
                onChange={(e) => handleAnswer(currentQuestion.id, e.target.value)}
                onFocus={(e) => {
                  setKeyboardOpen(true)
                  const el = e.currentTarget
                  setTimeout(() => el.scrollIntoView({ behavior: "smooth", block: "center" }), 350)
                }}
                onBlur={() => {
                  setTimeout(() => {
                    setKeyboardOpen(false)
                    if (isLastQuestion && answers[currentQuestion.id]) setShowFinishConfirm(true)
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
            {questions.length > 1 && (
              <div className="flex gap-2 pt-2 border-t">
                <Button
                  variant="outline"
                  onClick={handlePrevious}
                  disabled={currentQuestionIndex === 0}
                  className="flex-1 h-10 text-sm"
                >
                  Назад
                </Button>
                {!isLastQuestion ? (
                  <Button onClick={handleNext} disabled={!canGoNext} className="flex-1 h-10 text-sm">
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
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Да, завершить"}
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
          <p className="text-xs text-center text-muted-foreground">Точно хотите завершить опрос?</p>
        )}
      </div>
    </div>
  )
}