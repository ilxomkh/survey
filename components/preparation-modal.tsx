"use client"

import { useState } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { AlertCircle, Loader2, MapPin, Mic, Shield } from "lucide-react"
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
      if (!navigator.geolocation) {
        throw new Error("Геолокация не поддерживается вашим браузером")
      }

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
      <DialogContent className="max-w-sm border-primary/20">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold">{survey.title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">Перед началом убедитесь, что всё готово:</p>

          <div className="space-y-2">
            <div className="flex items-center gap-3 rounded-xl bg-primary/8 border border-primary/15 px-4 py-3">
              <MapPin className="h-4 w-4 text-primary shrink-0" />
              <span className="text-sm">Геолокация будет запрошена при старте</span>
            </div>

            <div className="flex items-center gap-3 rounded-xl bg-primary/8 border border-primary/15 px-4 py-3">
              <Mic className="h-4 w-4 text-primary shrink-0" />
              <span className="text-sm">Микрофон будет запрошен при старте</span>
            </div>

            <div className="flex items-center gap-3 rounded-xl bg-[#7C65FF]/5 border border-[#7C65FF]/10 px-4 py-3">
              <Shield className="h-4 w-4 text-primary/70 shrink-0" />
              <div className="text-sm text-muted-foreground space-y-0.5">
                <p>✓ Опрос лицом к лицу</p>
                <p>✓ Аудиозапись автоматически</p>
              </div>
            </div>
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="flex items-start space-x-3 rounded-xl border border-border p-3">
            <Checkbox
              id="consent"
              checked={agreed}
              onCheckedChange={setAgreed}
              className="mt-0.5 data-[state=checked]:bg-primary data-[state=checked]:border-primary"
            />
            <label htmlFor="consent" className="text-sm text-muted-foreground cursor-pointer leading-relaxed">
              Я подтверждаю согласие респондента на проведение опроса и запись аудио
            </label>
          </div>

          <div className="flex gap-2 pt-1">
            <Button variant="outline" onClick={onClose} className="flex-1 bg-transparent">
              Отмена
            </Button>
            <Button
              onClick={handleStart}
              disabled={!agreed || loading}
              className="flex-1 bg-primary hover:bg-primary/90 shadow-sm shadow-primary/20 gap-2"
            >
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Загрузка...
                </>
              ) : (
                "Начать"
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
