"use client"

import { useState } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { AlertCircle, Loader2, MapPin, Mic, Info } from "lucide-react"
import { RecordingSession } from "./recording-session"
import { apiClient } from "@/lib/api-client"
import { storage } from "@/lib/storage"

interface Survey {
  id: number
  title: string
}

interface PreparationModalProps {
  survey: Survey
  onClose: () => void
}

export function PreparationModal({ survey, onClose }: PreparationModalProps) {
  const [agreed, setAgreed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [showRecording, setShowRecording] = useState(false)

  const handleStart = async () => {
    setError("")
    setLoading(true)

    try {
      // Проверяем поддержку геолокации
      if (!navigator.geolocation) {
        throw new Error("Геолокация не поддерживается вашим браузером")
      }

      // Проверяем HTTPS (критично для Android)
      const isSecure = window.location.protocol === "https:" || window.location.hostname === "localhost"
      if (!isSecure) {
        console.warn("[PreparationModal] ⚠️ Небезопасное соединение. Android может блокировать геолокацию.")
      }

      const position = await new Promise<GeolocationCoordinates>((resolve, reject) => {
        console.log("[PreparationModal] Запрос геолокации...")

        navigator.geolocation.getCurrentPosition(
          (success) => {
            console.log("[PreparationModal] ✅ Геолокация получена:", success)
            resolve(success.coords)
          },
          (err) => {
            alert("Геолокация запрещена. Разрешите доступ в настройках телефона")
            console.error("[PreparationModal] ❌ Ошибка геолокации:", err)
            reject(new Error("Геолокация запрещена. Разрешите доступ в настройках телефона"))
          },
          {
            enableHighAccuracy: true,
            timeout: 15000,
            maximumAge: 0,
          }
        )
      })

      const token = localStorage.getItem("auth_token")
      if (token) {
        apiClient.setToken(token)
      }

      const data = await apiClient.startSession(
        survey.id,
        position.latitude,
        position.longitude,
        position.accuracy,
      )

      const sessionId = data.session_id
      console.log("[PreparationModal] Сессия создана, получен session_id:", sessionId)
      setSessionId(sessionId)
      // Сохраняем session_id в localStorage для использования в других запросах
      storage.setSessionId(sessionId)
      console.log("[PreparationModal] session_id сохранен в localStorage:", sessionId)
      setShowRecording(true)
    } catch (err: any) {
      setError(err?.message || "Ошибка запуска сессии")
    } finally {
      setLoading(false)
    }
  }

  if (showRecording && sessionId) {
    return <RecordingSession sessionId={sessionId} survey={survey} onComplete={onClose} />
  }

  return (
    <Dialog open={true} onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-xl">Подготовка к опросу</DialogTitle>
        </DialogHeader>
        <div className="space-y-6">
          <div className="space-y-3">
            <h3 className="font-semibold text-base">{survey.title}</h3>

            <Alert className="bg-primary/10 border-primary/20">
              <MapPin className="h-4 w-4" />
              <AlertDescription className="text-sm">Геолокация будет запрошена при старте</AlertDescription>
            </Alert>

            <Alert className="bg-primary/10 border-primary/20">
              <Mic className="h-4 w-4" />
              <AlertDescription className="text-sm">Микрофон будет запрошен при старте</AlertDescription>
            </Alert>

            <Alert className="bg-accent/10 border-accent/20">
              <Info className="h-4 w-4" />
              <AlertDescription className="text-sm">
                <div className="space-y-1">
                  <p>✓ Опрос лицом к лицу</p>
                  <p>✓ Аудиозапись автоматически</p>
                </div>
              </AlertDescription>
            </Alert>
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="flex items-start space-x-2">
            <Checkbox id="consent" checked={agreed} onCheckedChange={setAgreed} className="mt-1" />
            <label htmlFor="consent" className="text-sm text-muted-foreground cursor-pointer leading-relaxed">
              Я подтверждаю согласие респондента на проведение опроса и запись аудио
            </label>
          </div>

          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} className="flex-1 bg-transparent">
              Отмена
            </Button>
            <Button
              onClick={handleStart}
              disabled={!agreed || loading}
              className="flex-1 bg-primary hover:bg-primary/90 gap-2"
            >
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Загрузка...
                </>
              ) : (
                "Начать запись и опрос"
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
