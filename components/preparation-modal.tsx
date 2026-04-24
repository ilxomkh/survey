"use client"

import { useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { AlertCircle, Loader2, MapPin, Mic, Shield } from "lucide-react"
import { RecordingSession } from "./recording-session"
import { apiClient } from "@/lib/api-client"
import { storage } from "@/lib/storage"
import { getSurveyUiLocale, PREPARATION_UI } from "@/lib/survey-ui-strings"

interface Survey {
  id: number
  title: string
  description?: string
  language?: string
}

interface PreparationModalProps {
  survey: Survey
  onClose: () => void
}

export function PreparationModal({ survey, onClose }: PreparationModalProps) {
  const locale = getSurveyUiLocale(survey)
  const p = PREPARATION_UI[locale]

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
        throw new Error(p.geoUnsupported)
      }

      const isSecure =
        window.location.protocol === "https:" ||
        window.location.hostname === "localhost"

      if (!isSecure) {
        console.warn("[PreparationModal] Небезопасное соединение")
      }

      const position = await new Promise<GeolocationCoordinates>((resolve, reject) => {
        console.log("[PreparationModal] Запрос геолокации...")

        const tg = (window as any).Telegram?.WebApp
        const lm = tg?.LocationManager

        // Telegram LocationManager API (Bot API 8.0+) — обходит проблему WKWebView на iOS
        if (lm) {
          console.log("[PreparationModal] Используем Telegram LocationManager")
          const doGetLocation = () => {
            lm.getLocation((loc: any) => {
              if (loc) {
                console.log("[PreparationModal] ✅ Геолокация через LocationManager:", loc)
                resolve({
                  latitude: loc.latitude,
                  longitude: loc.longitude,
                  accuracy: loc.horizontal_accuracy ?? 100,
                } as GeolocationCoordinates)
              } else {
                console.warn("[PreparationModal] LocationManager вернул null — нет доступа")
                if (lm.isAccessGranted === false) {
                  lm.openSettings()
                  reject(new Error(p.geoDeniedError))
                } else {
                  reject(new Error(p.geoUnavailable))
                }
              }
            })
          }

          if (!lm.isInited) {
            lm.init(doGetLocation)
          } else {
            doGetLocation()
          }
          return
        }

        // Fallback: стандартный navigator.geolocation
        console.log("[PreparationModal] Используем navigator.geolocation")
        navigator.geolocation.getCurrentPosition(
          (success) => {
            console.log("[PreparationModal] ✅ Геолокация получена:", success)
            resolve(success.coords)
          },
          (err) => {
            console.warn("[PreparationModal] Первая попытка geo failed:", err.code, err.message)

            if (err.code === 1) {
              reject(new Error(p.geoDeniedError))
              return
            }

            navigator.geolocation.getCurrentPosition(
              (success) => {
                console.log("[PreparationModal] ✅ Геолокация получена (fallback):", success)
                resolve(success.coords)
              },
              (fallbackErr) => {
                console.error("[PreparationModal] ❌ Ошибка fallback геолокации:", fallbackErr.code, fallbackErr.message)
                reject(new Error(fallbackErr.code === 1 ? p.geoDeniedError : p.geoUnavailable))
              },
              {
                enableHighAccuracy: false,
                timeout: 15000,
                maximumAge: 120000,
              }
            )
          },
          {
            enableHighAccuracy: false,
            timeout: 8000,
            maximumAge: 0,
          }
        )
      })

      storage.setLastPosition(position.latitude, position.longitude, position.accuracy)

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
      console.log("[PreparationModal] Сессия создана:", sessionId)

      setSessionId(sessionId)
      storage.setSessionId(sessionId)
      setShowRecording(true)
    } catch (err: any) {
      console.error("[PreparationModal] Ошибка старта:", err)
      setError(err?.message || p.sessionStartError)
    } finally {
      setLoading(false)
    }
  }

  if (showRecording && sessionId) {
    return (
      <RecordingSession
        sessionId={sessionId}
        survey={survey}
        onComplete={onClose}
      />
    )
  }

  return (
    <Dialog open={true} onOpenChange={onClose}>
      <DialogContent className="max-h-[min(90dvh,720px)] w-full max-w-sm sm:max-w-md border-primary/20 overflow-y-auto overflow-x-hidden">
        <DialogHeader className="space-y-2 text-left">
          <DialogTitle className="text-lg font-semibold leading-snug break-words pr-6">
            {survey.title}
          </DialogTitle>

          {survey.description?.trim() && (
            <DialogDescription className="break-words whitespace-pre-wrap leading-relaxed text-left">
              {survey.description}
            </DialogDescription>
          )}
        </DialogHeader>

        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">{p.checklistIntro}</p>

          <div className="space-y-2">
            <div className="flex items-center gap-3 rounded-xl bg-primary/8 border border-primary/15 px-4 py-3">
              <MapPin className="h-4 w-4 text-primary shrink-0" />
              <span className="text-sm">{p.geoBullet}</span>
            </div>

            <div className="flex items-center gap-3 rounded-xl bg-primary/8 border border-primary/15 px-4 py-3">
              <Mic className="h-4 w-4 text-primary shrink-0" />
              <span className="text-sm">{p.micBullet}</span>
            </div>

            <div className="flex items-center gap-3 rounded-xl bg-[#7C65FF]/5 border border-[#7C65FF]/10 px-4 py-3">
              <Shield className="h-4 w-4 text-primary/70 shrink-0" />
              <div className="text-sm text-muted-foreground space-y-0.5">
                <p>{p.modeFaceToFace}</p>
                <p>{p.modeAudio}</p>
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
            <label
              htmlFor="consent"
              className="text-sm text-muted-foreground cursor-pointer leading-relaxed"
            >
              {p.consentLabel}
            </label>
          </div>

          <div className="flex gap-2 pt-1">
            <Button
              variant="outline"
              onClick={onClose}
              className="flex-1 bg-transparent"
            >
              {p.cancel}
            </Button>

            <Button
              onClick={handleStart}
              disabled={!agreed || loading}
              className="flex-1 bg-primary hover:bg-primary/90 shadow-sm shadow-primary/20 gap-2"
            >
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {p.loading}
                </>
              ) : (
                p.start
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}