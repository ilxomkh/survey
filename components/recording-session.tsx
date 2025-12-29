"use client"

import { useState, useEffect, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { AlertCircle, Pause as Pause2, Play, Square, Loader2, MapPin, Mic } from "lucide-react"
import { apiClient } from "@/lib/api-client"

interface Survey {
  id: number
  title: string
  min_duration_sec: number
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

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const timerRef = useRef<NodeJS.Timeout | null>(null)
  const locationIntervalRef = useRef<NodeJS.Timeout | null>(null)

  // Initialize recording and geolocation
  useEffect(() => {
    const initializeSession = async () => {
      try {
        // Request geolocation
        const token = localStorage.getItem("auth_token")
        if (token) {
          apiClient.setToken(token)
        }

        navigator.geolocation.watchPosition(
          async (position) => {
            setGeoStatus(`✓ Локация получена (${position.coords.accuracy.toFixed(0)}м)`)
            try {
              await apiClient.updateLocation(
                sessionId,
                position.coords.latitude,
                position.coords.longitude,
                position.coords.accuracy,
              )
            } catch (err) {
              console.error("Location update error:", err)
            }
          },
          (err) => {
            setGeoStatus(`✗ Ошибка: ${err.message}`)
            setError("Геолокация недоступна")
          },
          { enableHighAccuracy: true },
        )

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
      if (locationIntervalRef.current) clearInterval(locationIntervalRef.current)
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
      const position = await new Promise<GeolocationCoordinates>((resolve) => {
        navigator.geolocation.getCurrentPosition((pos) => resolve(pos.coords))
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
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-center text-lg">{survey.title}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="space-y-3">
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
            <div className="text-4xl font-bold font-mono text-primary">{formatTime(duration)}</div>
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
  )
}
