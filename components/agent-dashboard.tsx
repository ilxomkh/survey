"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { AlertCircle, Play, LogOut, Loader2 } from "lucide-react"
import { PreparationModal } from "./preparation-modal"
import { apiClient } from "@/lib/api-client"
import { storage } from "@/lib/storage"

interface Survey {
  id: number
  title: string
  description: string
  min_duration_sec: number
  is_active: boolean
}

interface AgentDashboardProps {
  onLogout: () => void
}

export function AgentDashboard({ onLogout }: AgentDashboardProps) {
  const [surveys, setSurveys] = useState<Survey[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [selectedSurvey, setSelectedSurvey] = useState<Survey | null>(null)

  useEffect(() => {
    const fetchSurveys = async () => {
      try {
        const token = localStorage.getItem("auth_token")
        if (token) {
          apiClient.setToken(token)
        }

        // Получаем session_id из URL параметров или localStorage
        const urlParams = new URLSearchParams(window.location.search)
        const sessionIdFromUrl = urlParams.get("session_id")
        const sessionIdFromStorage = storage.getSessionId()
        const sessionId = sessionIdFromUrl || sessionIdFromStorage || undefined

        // Если session_id есть в URL, сохраняем его в localStorage
        if (sessionIdFromUrl) {
          storage.setSessionId(sessionIdFromUrl)
        }

        const data = await apiClient.getSurveys(sessionId)
        setSurveys(Array.isArray(data) ? data : [])
      } catch (err: any) {
        if (err?.status === 401) {
          onLogout()
          return
        }
        setError(err?.message || "Ошибка загрузки данных")
      } finally {
        setLoading(false)
      }
    }

    fetchSurveys()
  }, [onLogout])

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary/5 to-secondary/5">
      <div className="max-w-2xl mx-auto p-4">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold">Мои опросы</h1>
            <p className="text-muted-foreground">Выберите опрос для начала</p>
          </div>
          <Button variant="outline" size="sm" onClick={onLogout} className="gap-2 bg-transparent">
            <LogOut className="h-4 w-4" />
            Выход
          </Button>
        </div>

        {error && (
          <Alert variant="destructive" className="mb-6">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {surveys.length === 0 ? (
          <Card>
            <CardContent className="pt-8 text-center">
              <p className="text-muted-foreground">Опросов не найдено</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {surveys.map((survey) => (
              <Card
                key={survey.id}
                className="border-2 border-primary/20 hover:border-primary/40 transition-colors cursor-pointer"
                onClick={() => survey.is_active && setSelectedSurvey(survey)}
              >
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <CardTitle className="text-lg">{survey.title}</CardTitle>
                      {survey.description && <CardDescription className="mt-1">{survey.description}</CardDescription>}
                    </div>
                    {!survey.is_active && (
                      <span className="text-xs bg-muted text-muted-foreground px-2 py-1 rounded">Неактивно</span>
                    )}
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center justify-between">
                    <div className="text-sm text-muted-foreground">
                      Минимум: <span className="font-semibold">{Math.ceil(survey.min_duration_sec / 60)} мин</span>
                    </div>
                    {survey.is_active && (
                      <Button
                        size="sm"
                        className="bg-primary hover:bg-primary/90 gap-2"
                        onClick={() => setSelectedSurvey(survey)}
                      >
                        <Play className="h-4 w-4" />
                        Начать
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {selectedSurvey && <PreparationModal survey={selectedSurvey} onClose={() => setSelectedSurvey(null)} />}
    </div>
  )
}
