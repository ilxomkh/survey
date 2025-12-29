"use client"

import { useState, useEffect, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { AlertCircle, Pause as Pause2, Play, Square, Loader2, MapPin, Mic, CheckCircle2 } from "lucide-react"
import { apiClient } from "@/lib/api-client"
import { ScrollArea } from "@/components/ui/scroll-area"

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
        console.log("[RecordingSession] Получены данные опроса:", surveyData)

        if (surveyData && Array.isArray(surveyData.questions)) {
          setQuestions(surveyData.questions)
        } else if (Array.isArray(surveyData)) {
          setQuestions(surveyData)
        } else {
          console.warn("[RecordingSession] Неожиданный формат данных опроса:", surveyData)
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
            audioChunksRef.current.push(event.data)

            // Upload chunk every 10 seconds
            if (audioChunksRef.current.length > 0) {
              const audioBlob = new Blob(audioChunksRef.current, { type: "audio/webm" })

              try {
                await apiClient.uploadAudio(sessionId, audioBlob)
                audioChunksRef.current = []
              } catch (err) {
                console.error("Audio upload error:", err)
              }
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

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop()
      setIsRecording(false)
    }

    if (timerRef.current) clearInterval(timerRef.current)
    streamRef.current?.getTracks().forEach((track) => track.stop())

    try {
      // Проверяем поддержку геолокации
      if (!navigator.geolocation) {
        throw new Error("Геолокация не поддерживается")
      }

      const position = await new Promise<GeolocationCoordinates>((resolve, reject) => {
        console.log("[RecordingSession] Запрос финальной геолокации...")
        
        // Timeout для Android (8 секунд)
        const timeoutId = setTimeout(() => {
          console.error("[RecordingSession] Timeout финальной геолокации")
          reject(new Error("Таймаут получения геолокации"))
        }, 8000)

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
            enableHighAccuracy: false, // Для финального запроса используем менее точную, но более быструю
            timeout: 8000,
            maximumAge: 10000, // Можно использовать кеш до 10 секунд
          }
        )
      })

      await apiClient.completeSession(sessionId, position.latitude, position.longitude, position.accuracy)

      onComplete()
    } catch (err: any) {
      setError(err?.message || "Ошибка завершения сессии")
    } finally {
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
  }

  const handlePrevious = () => {
    if (currentQuestionIndex > 0) {
      setCurrentQuestionIndex((prev) => prev - 1)
    }
  }

  if (loading) {
    return (
      <div className="fixed inset-0 bg-background/95 flex items-center justify-center z-50">
        <Card className="max-w-md w-full mx-4">
          <CardContent className="pt-8 text-center space-y-4">
            <Loader2 className="h-8 w-8 animate-spin text-primary mx-auto" />
            <p className="font-semibold">Инициализация сессии...</p>
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>{geoStatus}</p>
              <p>{micStatus}</p>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 bg-background/95 flex items-center justify-center z-50 p-4">
      <div className="w-full max-w-4xl max-h-[90vh] flex flex-col gap-4">
        {/* Левая панель - вопросы опроса */}
        <Card className="flex-1 flex flex-col min-h-0">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg">{survey.title}</CardTitle>
            {questions.length > 0 && (
              <p className="text-sm text-muted-foreground mt-1">
                Вопрос {currentQuestionIndex + 1} из {questions.length}
              </p>
            )}
          </CardHeader>
          <CardContent className="flex-1 flex flex-col min-h-0">
            {loadingQuestions ? (
              <div className="flex items-center justify-center flex-1">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
                <span className="ml-2 text-sm text-muted-foreground">Загрузка вопросов...</span>
              </div>
            ) : questions.length === 0 ? (
              <div className="flex items-center justify-center flex-1 text-center">
                <div>
                  <p className="text-muted-foreground mb-2">Вопросы опроса не найдены</p>
                  <p className="text-xs text-muted-foreground">Продолжайте запись аудио</p>
                </div>
              </div>
            ) : (
              <ScrollArea className="flex-1">
                <div className="space-y-4 pr-4">
                  {currentQuestion && (
                    <div className="space-y-4">
                      <div>
                        <h3 className="font-semibold text-base mb-2">
                          {currentQuestion.title}
                          {currentQuestion.required && <span className="text-red-500 ml-1">*</span>}
                        </h3>
                        <p className="text-xs text-muted-foreground mb-4">
                          Тип: {currentQuestion.type}
                        </p>
                      </div>

                      {/* Отображение вопроса в зависимости от типа */}
                      {currentQuestion.type === "multiple_choice" && currentQuestion.options && (
                        <div className="space-y-2">
                          {currentQuestion.options.map((option, idx) => (
                            <label
                              key={idx}
                              className="flex items-center space-x-2 p-3 border rounded-lg cursor-pointer hover:bg-muted/50 transition-colors"
                            >
                              <input
                                type="radio"
                                name={`question-${currentQuestion.id}`}
                                value={option}
                                checked={answers[currentQuestion.id] === option}
                                onChange={() => handleAnswer(currentQuestion.id, option)}
                                className="w-4 h-4"
                              />
                              <span className="flex-1">{option}</span>
                              {answers[currentQuestion.id] === option && (
                                <CheckCircle2 className="h-4 w-4 text-primary" />
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
                          className="w-full min-h-[100px] p-3 border rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-primary"
                        />
                      )}

                      {currentQuestion.type === "yes_no" && (
                        <div className="flex gap-2">
                          <Button
                            variant={answers[currentQuestion.id] === "yes" ? "default" : "outline"}
                            onClick={() => handleAnswer(currentQuestion.id, "yes")}
                            className="flex-1"
                          >
                            Да
                          </Button>
                          <Button
                            variant={answers[currentQuestion.id] === "no" ? "default" : "outline"}
                            onClick={() => handleAnswer(currentQuestion.id, "no")}
                            className="flex-1"
                          >
                            Нет
                          </Button>
                        </div>
                      )}

                      {/* Навигация по вопросам */}
                      {questions.length > 1 && (
                        <div className="flex gap-2 pt-4 border-t">
                          <Button
                            variant="outline"
                            onClick={handlePrevious}
                            disabled={currentQuestionIndex === 0}
                            className="flex-1"
                          >
                            Назад
                          </Button>
                          <Button
                            onClick={handleNext}
                            disabled={!canGoNext || isLastQuestion}
                            className="flex-1"
                          >
                            {isLastQuestion ? "Последний вопрос" : "Далее"}
                          </Button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </ScrollArea>
            )}
          </CardContent>
        </Card>

        {/* Правая панель - управление записью */}
        <Card className="w-full">
          <CardContent className="pt-6 space-y-4">
            {error && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm p-2 bg-muted rounded">
                <MapPin className="h-4 w-4 text-primary" />
                <span>{geoStatus}</span>
              </div>
              <div className="flex items-center gap-2 text-sm p-2 bg-muted rounded">
                <Mic className="h-4 w-4 text-primary" />
                <span>{micStatus}</span>
              </div>
            </div>

            <div className="text-center space-y-2">
              <div className="text-3xl font-bold font-mono text-primary">{formatTime(duration)}</div>
              <p className="text-sm text-muted-foreground">Минимум: {Math.ceil(survey.min_duration_sec / 60)} мин</p>
              {canFinish && <p className="text-sm text-green-600 font-semibold">✓ Можно завершить</p>}
            </div>

            <div className="flex gap-2">
              {isRecording && (
                <Button variant="outline" size="sm" onClick={togglePause} className="flex-1 bg-transparent">
                  {isPaused ? (
                    <>
                      <Play className="h-4 w-4 mr-2" />
                      Продолжить
                    </>
                  ) : (
                    <>
                      <Pause2 className="h-4 w-4 mr-2" />
                      Пауза
                    </>
                  )}
                </Button>
              )}

              <Button
                onClick={finishRecording}
                disabled={!canFinish || loading}
                className="flex-1 bg-primary hover:bg-primary/90 gap-2"
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
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
