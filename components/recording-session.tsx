"use client"

import { useState, useEffect, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { AlertCircle, Pause as Pause2, Play, Square, Loader2, MapPin, Mic, CheckCircle2 } from "lucide-react"
import { apiClient } from "@/lib/api-client"

interface Survey {
  id: number
  title: string
  min_duration_sec: number
}

interface Question {
  id: string
  title: string
  type: string
  options?: string[]
  required?: boolean
}

interface SurveyQuestions {
  questions: Question[]
  tally_url?: string
}

interface RecordingSessionProps {
  sessionId: string
  survey: Survey
  onComplete: () => void
}

// Функция для преобразования типов вопросов Tally в формат приложения
function mapTallyTypeToQuestionType(tallyType: string): string {
  const normalizedType = String(tallyType).toUpperCase()
  const typeMap: Record<string, string> = {
    TEXT: "text",
    MULTIPLE_CHOICE: "multiple_choice",
    MULTIPLECHOICE: "multiple_choice",
    CHOICE: "multiple_choice",
    YES_NO: "yes_no",
    YESNO: "yes_no",
    BOOLEAN: "yes_no",
    text: "text",
    multiple_choice: "multiple_choice",
    multiplechoice: "multiple_choice",
    yes_no: "yes_no",
    yesno: "yes_no",
    boolean: "yes_no",
  }
  return typeMap[normalizedType] || typeMap[tallyType] || "text"
}

export function RecordingSession({ sessionId, survey, onComplete }: RecordingSessionProps) {
  const [isRecording, setIsRecording] = useState(false)
  const [isPaused, setIsPaused] = useState(false)
  const [duration, setDuration] = useState(0)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)
  const [geoStatus, setGeoStatus] = useState("Получение локации...")
  const [micStatus, setMicStatus] = useState("Запрос микрофона...")
  const [canFinish, setCanFinish] = useState(false)
  const [questions, setQuestions] = useState<Question[]>([])
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0)
  const [answers, setAnswers] = useState<Record<string, any>>({})
  const [loadingQuestions, setLoadingQuestions] = useState(true)

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const timerRef = useRef<NodeJS.Timeout | null>(null)
  const locationIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const lastPositionRef = useRef<GeolocationCoordinates | null>(null)

  // Load survey questions
  useEffect(() => {
    const loadQuestions = async () => {
      try {
        const token = localStorage.getItem("auth_token")
        if (token) {
          apiClient.setToken(token)
        }

        console.log("[RecordingSession] Загрузка вопросов опроса для survey_id:", survey.id, "session_id:", sessionId)
        const surveyData = await apiClient.getSurveyQuestions(survey.id, sessionId)
        console.log("[RecordingSession] Получены данные опроса (полный объект):", JSON.stringify(surveyData, null, 2))

        // Обработка разных форматов ответа API
        let extractedQuestions: Question[] = []
        
        if (surveyData) {
          // Формат 1: { questions: Question[] }
          if (Array.isArray(surveyData.questions)) {
            console.log("[RecordingSession] Формат 1: найден массив questions")
            extractedQuestions = surveyData.questions
          }
          // Формат 2: { blocks: Block[] } - формат Tally
          else if (Array.isArray(surveyData.blocks)) {
            console.log("[RecordingSession] Формат 2: найден массив blocks, количество:", surveyData.blocks.length)
            
            // Функция для извлечения текста из safeHTMLSchema
            const extractTextFromSchema = (schema: any): string => {
              if (!schema || !Array.isArray(schema)) return ""
              return schema
                .map((item: any) => {
                  if (typeof item === "string") return item
                  if (Array.isArray(item) && item.length > 0 && typeof item[0] === "string") {
                    return item[0]
                  }
                  return ""
                })
                .filter(Boolean)
                .join("")
                .trim()
            }
            
            // Находим все блоки с заголовками вопросов (TITLE с groupType QUESTION)
            const questionTitleBlocks = surveyData.blocks.filter(
              (block: any) => block.type === "TITLE" && block.groupType === "QUESTION"
            )
            
            console.log("[RecordingSession] Найдено блоков с заголовками вопросов:", questionTitleBlocks.length)
            
            // Обрабатываем каждый вопрос
            extractedQuestions = questionTitleBlocks.map((titleBlock: any, questionIndex: number) => {
              // Извлекаем текст вопроса из payload.safeHTMLSchema или payload.title
              const questionText = 
                extractTextFromSchema(titleBlock.payload?.safeHTMLSchema) ||
                titleBlock.payload?.title ||
                titleBlock.text ||
                ""
              
              console.log(`[RecordingSession] Вопрос ${questionIndex + 1}: "${questionText}"`)
              
              // Определяем тип вопроса по следующим блокам
              // Ищем опции MULTIPLE_CHOICE_OPTION после этого заголовка
              const titleBlockIndex = surveyData.blocks.indexOf(titleBlock)
              const nextTitleBlockIndex = questionIndex < questionTitleBlocks.length - 1
                ? surveyData.blocks.indexOf(questionTitleBlocks[questionIndex + 1])
                : surveyData.blocks.length
              
              // Ищем опции между текущим заголовком и следующим
              const optionBlocks = surveyData.blocks
                .slice(titleBlockIndex + 1, nextTitleBlockIndex)
                .filter((block: any) => 
                  block.type === "MULTIPLE_CHOICE_OPTION" || 
                  block.groupType === "MULTIPLE_CHOICE"
                )
              
              console.log(`[RecordingSession] Вопрос ${questionIndex + 1} - найдено опций:`, optionBlocks.length)
              
              // Определяем тип вопроса
              let questionType = "text"
              if (optionBlocks.length > 0) {
                questionType = "multiple_choice"
              } else {
                // Проверяем groupType заголовка или следующих блоков
                const nextBlock = surveyData.blocks[titleBlockIndex + 1]
                if (nextBlock?.groupType === "MULTIPLE_CHOICE") {
                  questionType = "multiple_choice"
                } else if (nextBlock?.groupType === "YES_NO") {
                  questionType = "yes_no"
                }
              }
              
              // Извлекаем опции
              const options: string[] = []
              if (questionType === "multiple_choice" && optionBlocks.length > 0) {
                optionBlocks.forEach((optionBlock: any) => {
                  const optionText = 
                    optionBlock.payload?.text ||
                    optionBlock.text ||
                    extractTextFromSchema(optionBlock.payload?.safeHTMLSchema) ||
                    ""
                  if (optionText) {
                    options.push(optionText)
                  }
                })
                console.log(`[RecordingSession] Вопрос ${questionIndex + 1} - опции:`, options)
              }
              
              // Проверяем обязательность вопроса
              const isRequired = 
                optionBlocks.some((block: any) => block.payload?.isRequired === true) ||
                titleBlock.payload?.isRequired === true ||
                false
              
              const question: Question = {
                id: titleBlock.uuid || `question_${questionIndex}`,
                title: questionText,
                type: questionType,
                required: isRequired,
              }
              
              if (options.length > 0) {
                question.options = options
              }
              
              console.log(`[RecordingSession] Сформированный вопрос ${questionIndex + 1}:`, question)
              return question
            }).filter((q: Question) => q.title && q.title.trim().length > 0)
          }
          // Формат 3: массив вопросов напрямую
          else if (Array.isArray(surveyData)) {
            console.log("[RecordingSession] Формат 3: ответ - массив напрямую")
            extractedQuestions = surveyData
          }
          // Формат 4: возможно, данные в другом поле
          else {
            console.log("[RecordingSession] Формат 4: проверка других полей...")
            // Пробуем найти данные в других возможных полях
            const possibleFields = ['data', 'items', 'results', 'content']
            for (const field of possibleFields) {
              if (surveyData[field] && Array.isArray(surveyData[field])) {
                console.log(`[RecordingSession] Найдены данные в поле ${field}`)
                extractedQuestions = surveyData[field]
                break
              }
            }
          }
        }
        
        console.log("[RecordingSession] Итоговые извлеченные вопросы:", extractedQuestions)
        console.log("[RecordingSession] Количество вопросов:", extractedQuestions.length)
        setQuestions(extractedQuestions)
        
        if (extractedQuestions.length === 0) {
          console.error("[RecordingSession] ❌ Не удалось извлечь вопросы из ответа!")
          console.error("[RecordingSession] Структура ответа:", JSON.stringify(surveyData, null, 2))
        } else {
          console.log("[RecordingSession] ✅ Успешно извлечено вопросов:", extractedQuestions.length)
        }
      } catch (err) {
        console.error("[RecordingSession] Ошибка загрузки вопросов:", err)
        // Не блокируем запись, если вопросы не загрузились
      } finally {
        setLoadingQuestions(false)
      }
    }

    loadQuestions()
  }, [survey.id, sessionId])

  // Initialize recording and geolocation
  useEffect(() => {
    const initializeSession = async () => {
      try {
        // Request geolocation
        const token = localStorage.getItem("auth_token")
        if (token) {
          apiClient.setToken(token)
        }

        // Проверяем поддержку геолокации
        if (!navigator.geolocation) {
          setGeoStatus("✗ Геолокация не поддерживается")
          setError("Геолокация не поддерживается вашим браузером")
          setLoading(false)
          return
        }

        // Проверяем HTTPS (критично для Android)
        const isSecure = window.location.protocol === "https:" || window.location.hostname === "localhost"
        if (!isSecure) {
          console.warn("[RecordingSession] ⚠️ Небезопасное соединение. Android может блокировать геолокацию.")
        }

        // Предварительная проверка доступности геолокации
        console.log("[RecordingSession] Проверка доступности геолокации...")
        await new Promise<void>((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(
            (success) => {
              console.log("[RecordingSession] ✅ Геолокация доступна:", success)
              resolve()
            },
            (err) => {
              alert("Геолокация запрещена. Разрешите доступ в настройках телефона")
              console.error("[RecordingSession] ❌ Геолокация недоступна:", err)
              setGeoStatus("✗ Геолокация запрещена")
              setError("Геолокация запрещена. Разрешите доступ в настройках телефона")
              reject(err)
            },
            {
              enableHighAccuracy: true,
              timeout: 15000,
              maximumAge: 0,
            }
          )
        })

        console.log("[RecordingSession] Запуск отслеживания геолокации...")
        
        // Fallback: сначала пробуем точную геолокацию, потом обычную
        let watchId: number | null = null
        let fallbackAttempted = false

        const startWatching = (highAccuracy: boolean) => {
          if (watchId !== null) {
            navigator.geolocation.clearWatch(watchId)
          }

          watchId = navigator.geolocation.watchPosition(
            async (position) => {
              const accuracy = position.coords.accuracy
              // Сохраняем последнюю позицию для использования при завершении
              lastPositionRef.current = position.coords
              setGeoStatus(`✓ Локация получена (${accuracy.toFixed(0)}м)`)
              console.log("[RecordingSession] ✅ Геолокация обновлена:", {
                latitude: position.coords.latitude,
                longitude: position.coords.longitude,
                accuracy,
                highAccuracy,
              })
              
              try {
                await apiClient.updateLocation(
                  sessionId,
                  position.coords.latitude,
                  position.coords.longitude,
                  position.coords.accuracy,
                )
              } catch (err) {
                console.error("[RecordingSession] Ошибка отправки геолокации:", err)
              }
            },
            (err) => {
              console.error("[RecordingSession] ❌ Ошибка геолокации:", {
                code: err.code,
                message: err.message,
                PERMISSION_DENIED: err.PERMISSION_DENIED,
                POSITION_UNAVAILABLE: err.POSITION_UNAVAILABLE,
                TIMEOUT: err.TIMEOUT,
                highAccuracy,
              })

              // Fallback: если точная геолокация не работает, пробуем обычную
              if (highAccuracy && !fallbackAttempted) {
                fallbackAttempted = true
                console.log("[RecordingSession] Пробуем fallback с enableHighAccuracy: false")
                setGeoStatus("Попытка получить геолокацию...")
                startWatching(false)
                return
              }

              let errorMessage = "Геолокация недоступна"
              switch (err.code) {
                case err.PERMISSION_DENIED:
                  errorMessage = "Доступ к геолокации запрещен"
                  setGeoStatus("✗ Доступ запрещен")
                  break
                case err.POSITION_UNAVAILABLE:
                  errorMessage = "Геолокация недоступна"
                  setGeoStatus("✗ GPS недоступен")
                  break
                case err.TIMEOUT:
                  errorMessage = "Таймаут получения геолокации"
                  setGeoStatus("✗ Таймаут GPS")
                  break
                default:
                  setGeoStatus(`✗ Ошибка: ${err.message}`)
              }
              
              if (!fallbackAttempted) {
                setError(errorMessage)
              }
            },
            {
              enableHighAccuracy: highAccuracy,
              timeout: 10000, // 10 секунд таймаут (критично для Android)
              maximumAge: 5000, // Использовать кеш не старше 5 секунд
            }
          )
        }

        // Начинаем с точной геолокации
        startWatching(true)

        // Сохраняем watchId для очистки
        locationIntervalRef.current = watchId as any

        // Request microphone
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        streamRef.current = stream
        setMicStatus("✓ Микрофон подключен")

        // Setup media recorder
        const mediaRecorder = new MediaRecorder(stream)
        mediaRecorderRef.current = mediaRecorder

        mediaRecorder.ondataavailable = async (event) => {
          if (event.data.size > 0) {
            // Сохраняем чанк для финальной отправки
            audioChunksRef.current.push(event.data)

            // Отправляем каждый чанк отдельно на бекенд
              try {
              console.log("[RecordingSession] Отправка аудио чанка, размер:", event.data.size, "байт")
              await apiClient.uploadAudio(sessionId, event.data)
              console.log("[RecordingSession] ✅ Аудио чанк успешно отправлен")
              } catch (err) {
              console.error("[RecordingSession] ❌ Ошибка отправки аудио чанка:", err)
              // Не очищаем чанки при ошибке, чтобы можно было повторить отправку при завершении
            }
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

  // Auto-start recording
  useEffect(() => {
    if (!loading && mediaRecorderRef.current && !isRecording) {
      startRecording()
    }
  }, [loading])

  // Check if minimum duration is met
  useEffect(() => {
    setCanFinish(duration >= survey.min_duration_sec)
  }, [duration, survey.min_duration_sec])

  const startRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "inactive") {
      mediaRecorderRef.current.start(10000) // Upload every 10 seconds
      setIsRecording(true)
      setIsPaused(false)

      timerRef.current = setInterval(() => {
        setDuration((prev) => prev + 1)
      }, 1000)
    }
  }

  const togglePause = () => {
    if (mediaRecorderRef.current) {
      if (isPaused) {
        mediaRecorderRef.current.resume()
        setIsPaused(false)
      } else {
        mediaRecorderRef.current.pause()
        setIsPaused(true)
      }
    }
  }

  const finishRecording = async () => {
    setLoading(true)

    try {
      // Останавливаем запись и получаем последний чанк
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        // Запрашиваем последний чанк перед остановкой
        if (mediaRecorderRef.current.state === "recording") {
          mediaRecorderRef.current.requestData()
        }
      mediaRecorderRef.current.stop()
      setIsRecording(false)
        
        // Ждем немного, чтобы последний чанк успел обработаться
        await new Promise(resolve => setTimeout(resolve, 500))
    }

    if (timerRef.current) clearInterval(timerRef.current)

      // Собираем и отправляем финальное аудио (если есть оставшиеся чанки)
      if (audioChunksRef.current.length > 0) {
        try {
          console.log("[RecordingSession] Отправка финального аудио, чанков:", audioChunksRef.current.length)
          const finalAudioBlob = new Blob(audioChunksRef.current, { type: "audio/webm" })
          console.log("[RecordingSession] Размер финального аудио:", finalAudioBlob.size, "байт")
          await apiClient.uploadAudio(sessionId, finalAudioBlob)
          console.log("[RecordingSession] ✅ Финальное аудио успешно отправлено")
          audioChunksRef.current = []
        } catch (err) {
          console.error("[RecordingSession] ❌ Ошибка отправки финального аудио:", err)
          // Не блокируем завершение, если аудио не отправилось
        }
      } else {
        console.log("[RecordingSession] Нет оставшихся аудио чанков для отправки")
      }

      // Останавливаем поток микрофона
    streamRef.current?.getTracks().forEach((track) => track.stop())

      // Получаем финальную геолокацию
      let position: GeolocationCoordinates
      
      // Используем последнюю сохраненную позицию, если она есть
      if (lastPositionRef.current) {
        console.log("[RecordingSession] Использование последней известной геолокации:", {
          latitude: lastPositionRef.current.latitude,
          longitude: lastPositionRef.current.longitude,
          accuracy: lastPositionRef.current.accuracy,
        })
        position = lastPositionRef.current
      } else {
        // Если последней позиции нет, пытаемся получить новую
        console.log("[RecordingSession] Последней позиции нет, запрос новой геолокации...")
        
      if (!navigator.geolocation) {
        throw new Error("Геолокация не поддерживается")
      }

        try {
          position = await new Promise<GeolocationCoordinates>((resolve, reject) => {
            // Увеличиваем таймаут до 15 секунд и используем кеш до 30 секунд
        const timeoutId = setTimeout(() => {
          console.error("[RecordingSession] Timeout финальной геолокации")
          reject(new Error("Таймаут получения геолокации"))
            }, 15000)

        navigator.geolocation.getCurrentPosition(
          (pos) => {
            clearTimeout(timeoutId)
            console.log("[RecordingSession] ✅ Финальная геолокация получена:", {
              latitude: pos.coords.latitude,
              longitude: pos.coords.longitude,
              accuracy: pos.coords.accuracy,
            })
            resolve(pos.coords)
          },
          (err) => {
            clearTimeout(timeoutId)
            console.error("[RecordingSession] ❌ Ошибка финальной геолокации:", err)
            reject(err)
          },
          {
                enableHighAccuracy: false,
                timeout: 15000,
                maximumAge: 30000, // Используем кеш до 30 секунд
              }
            )
          })
        } catch (err) {
          // Если не удалось получить новую позицию, используем дефолтные значения
          console.warn("[RecordingSession] ⚠️ Не удалось получить геолокацию, используем дефолтные значения")
          throw new Error("Не удалось получить геолокацию для завершения сессии")
        }
      }

      // Завершаем сессию с геолокацией и ответами
      console.log("[RecordingSession] Завершение сессии с ответами:", answers)
      await apiClient.completeSession(sessionId, position.latitude, position.longitude, position.accuracy, answers)
      console.log("[RecordingSession] ✅ Сессия успешно завершена")

      onComplete()
    } catch (err: any) {
      console.error("[RecordingSession] ❌ Ошибка завершения сессии:", err)
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
    setAnswers((prev) => ({
      ...prev,
      [questionId]: answer,
    }))
  }

  const currentQuestion = questions[currentQuestionIndex]
  const isLastQuestion = currentQuestionIndex === questions.length - 1
  const canGoNext = currentQuestion
    ? currentQuestion.required
      ? answers[currentQuestion.id] !== undefined && answers[currentQuestion.id] !== ""
      : true
    : true

  const handleNext = () => {
    if (currentQuestionIndex < questions.length - 1) {
      setCurrentQuestionIndex((prev) => prev + 1)
    }
    // Ответы будут отправлены при завершении сессии
  }

  const handlePrevious = () => {
    if (currentQuestionIndex > 0) {
      setCurrentQuestionIndex((prev) => prev - 1)
    }
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
    <div className="fixed inset-0 bg-background/95 z-50 overflow-y-auto">
      <div className="min-h-full flex items-start justify-center p-2 sm:p-4 py-4">
        <div className="w-full max-w-7xl flex flex-col lg:flex-row gap-2 sm:gap-4">
        {/* Левая панель - вопросы опроса */}
          <Card className="flex-1 flex flex-col min-h-0 lg:max-h-[90vh] shadow-lg overflow-hidden">
          <CardHeader className="pb-2 sm:pb-4 border-b px-3 sm:px-6 flex-shrink-0">
            <CardTitle className="text-base sm:text-xl font-semibold">{survey.title}</CardTitle>
            {questions.length > 0 && (
              <p className="text-xs sm:text-sm text-muted-foreground mt-1 sm:mt-2">
                Вопрос {currentQuestionIndex + 1} из {questions.length}
              </p>
            )}
          </CardHeader>
          <CardContent className="flex-1 flex flex-col min-h-0 overflow-hidden pt-3 sm:pt-6 px-3 sm:px-6">
            {loadingQuestions ? (
              <div className="flex items-center justify-center flex-1">
                <Loader2 className="h-5 w-5 sm:h-6 sm:w-6 animate-spin text-primary" />
                <span className="ml-2 text-xs sm:text-sm text-muted-foreground">Загрузка вопросов...</span>
              </div>
            ) : questions.length === 0 ? (
              <div className="flex items-center justify-center flex-1 text-center px-2">
                <div>
                  <p className="text-sm sm:text-base text-muted-foreground mb-2">Вопросы опроса не найдены</p>
                  <p className="text-xs text-muted-foreground">Продолжайте запись аудио</p>
                </div>
              </div>
            ) : (
              <div className="flex-1 min-h-0 overflow-y-auto -mx-3 sm:-mx-6 px-3 sm:px-6">
                <div className="space-y-4 sm:space-y-6 pb-4">
                  {currentQuestion && (
                    <div className="space-y-4 sm:space-y-6">
                      <div>
                        <h3 className="font-semibold text-base sm:text-lg mb-2 sm:mb-3 leading-relaxed">
                          {currentQuestion.title}
                          {currentQuestion.required && <span className="text-red-500 ml-1">*</span>}
                        </h3>
                        <p className="text-xs text-muted-foreground mb-3 sm:mb-4">
                          Тип: {currentQuestion.type}
                        </p>
                      </div>

                      {/* Отображение вопроса в зависимости от типа */}
                      {currentQuestion.type === "multiple_choice" && currentQuestion.options && (
                        <div className="space-y-2 sm:space-y-3">
                          {currentQuestion.options.map((option, idx) => (
                            <label
                              key={idx}
                              className="flex items-center space-x-2 sm:space-x-3 p-3 sm:p-4 border-2 rounded-lg cursor-pointer hover:bg-muted/50 hover:border-primary/50 active:bg-muted/70 transition-all duration-200"
                            >
                              <input
                                type="radio"
                                name={`question-${currentQuestion.id}`}
                                value={option}
                                checked={answers[currentQuestion.id] === option}
                                onChange={() => handleAnswer(currentQuestion.id, option)}
                                className="w-4 h-4 sm:w-5 sm:h-5 text-primary flex-shrink-0"
                              />
                              <span className="flex-1 text-sm sm:text-base break-words">{option}</span>
                              {answers[currentQuestion.id] === option && (
                                <CheckCircle2 className="h-4 w-4 sm:h-5 sm:w-5 text-primary flex-shrink-0" />
                              )}
                            </label>
                          ))}
                        </div>
                      )}

                      {currentQuestion.type === "text" && (
                        <textarea
                          value={answers[currentQuestion.id] || ""}
                          onChange={(e) => handleAnswer(currentQuestion.id, e.target.value)}
                          placeholder="Введите ваш ответ..."
                          className="w-full min-h-[100px] sm:min-h-[120px] p-3 sm:p-4 text-sm sm:text-base border-2 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary transition-all"
                        />
                      )}

                      {currentQuestion.type === "yes_no" && (
                        <div className="flex gap-2 sm:gap-3">
                          <Button
                            variant={answers[currentQuestion.id] === "yes" ? "default" : "outline"}
                            onClick={() => handleAnswer(currentQuestion.id, "yes")}
                            className="flex-1 h-10 sm:h-12 text-sm sm:text-base"
                          >
                            Да
                          </Button>
                          <Button
                            variant={answers[currentQuestion.id] === "no" ? "default" : "outline"}
                            onClick={() => handleAnswer(currentQuestion.id, "no")}
                            className="flex-1 h-10 sm:h-12 text-sm sm:text-base"
                          >
                            Нет
                          </Button>
                        </div>
                      )}

                      {/* Навигация по вопросам */}
                      <div className="flex gap-2 sm:gap-3 pt-4 sm:pt-6 border-t">
                      {questions.length > 1 && (
                          <Button
                            variant="outline"
                            onClick={handlePrevious}
                            disabled={currentQuestionIndex === 0}
                            className="flex-1 h-10 sm:h-11 text-sm sm:text-base"
                          >
                            Назад
                          </Button>
                        )}
                          <Button
                            onClick={handleNext}
                          disabled={!canGoNext}
                          className={`${questions.length > 1 ? "flex-1" : "w-full"} h-10 sm:h-11 text-sm sm:text-base`}
                          >
                            {isLastQuestion ? "Последний вопрос" : "Далее"}
                          </Button>
                        </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Правая панель - управление записью */}
          <Card className="w-full lg:w-80 flex flex-col min-h-0 lg:max-h-[90vh] shadow-lg overflow-hidden lg:sticky lg:top-4">
          <CardHeader className="pb-2 sm:pb-4 border-b px-3 sm:px-6 flex-shrink-0">
            <CardTitle className="text-base sm:text-lg font-semibold">Управление записью</CardTitle>
          </CardHeader>
          <CardContent className="flex-1 flex flex-col lg:overflow-y-auto pt-3 sm:pt-6 px-3 sm:px-6 space-y-4 sm:space-y-6">
            {error && (
              <Alert variant="destructive" className="text-xs sm:text-sm">
                <AlertCircle className="h-3 w-3 sm:h-4 sm:w-4" />
                <AlertDescription className="text-xs sm:text-sm">{error}</AlertDescription>
              </Alert>
            )}

            {/* Статусы */}
            <div className="space-y-2 sm:space-y-3">
              <div className="flex items-center gap-2 sm:gap-3 text-xs sm:text-sm p-2 sm:p-3 bg-muted/50 rounded-lg border">
                <MapPin className="h-4 w-4 sm:h-5 sm:w-5 text-primary flex-shrink-0" />
                <span className="text-xs sm:text-sm break-words">{geoStatus}</span>
              </div>
              <div className="flex items-center gap-2 sm:gap-3 text-xs sm:text-sm p-2 sm:p-3 bg-muted/50 rounded-lg border">
                <Mic className="h-4 w-4 sm:h-5 sm:w-5 text-primary flex-shrink-0" />
                <span className="text-xs sm:text-sm break-words">{micStatus}</span>
              </div>
            </div>

            {/* Таймер */}
            <div className="text-center space-y-2 sm:space-y-3 py-3 sm:py-4 bg-gradient-to-br from-primary/5 to-primary/10 rounded-lg border-2 border-primary/20">
              <div className="text-3xl sm:text-5xl font-bold font-mono text-primary tracking-wider">
                {formatTime(duration)}
              </div>
              <p className="text-xs sm:text-sm text-muted-foreground font-medium">
                Минимум: {Math.ceil(survey.min_duration_sec / 60)} мин
              </p>
              {canFinish && (
                <p className="text-xs sm:text-sm text-green-600 font-semibold flex items-center justify-center gap-1">
                  <CheckCircle2 className="h-3 w-3 sm:h-4 sm:w-4" />
                  Можно завершить
                </p>
              )}
            </div>

            {/* Кнопки управления */}
            <div className="flex flex-col gap-2 sm:gap-3 mt-auto">
              {isRecording && (
                <Button 
                  variant="outline" 
                  onClick={togglePause} 
                  className="w-full h-10 sm:h-11 text-sm sm:text-base border-2"
                >
                  {isPaused ? (
                    <>
                      <Play className="h-3 w-3 sm:h-4 sm:w-4 mr-2" />
                      Продолжить
                    </>
                  ) : (
                    <>
                      <Pause2 className="h-3 w-3 sm:h-4 sm:w-4 mr-2" />
                      Пауза
                    </>
                  )}
                </Button>
              )}

              <Button
                onClick={finishRecording}
                disabled={!canFinish || loading}
                className="w-full h-10 sm:h-11 text-sm sm:text-base bg-primary hover:bg-primary/90 gap-2 shadow-md"
              >
                {loading ? (
                  <>
                    <Loader2 className="h-3 w-3 sm:h-4 sm:w-4 animate-spin" />
                    Завершение...
                  </>
                ) : (
                  <>
                    <Square className="h-3 w-3 sm:h-4 sm:w-4" />
                    Завершить
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
        </div>
      </div>
    </div>
  )
}
