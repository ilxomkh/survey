"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { AlertCircle, Play, LogOut, Loader2, ClipboardList } from "lucide-react"
import Image from "next/image"
import { PreparationModal } from "./preparation-modal"
import { apiClient } from "@/lib/api-client"

interface Survey {
  id: number
  title: string
  description: string
  is_active: boolean
  language?: string
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

        const data = await apiClient.getSurveys()
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
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[#7C65FF]/10 via-white to-[#8888FC]/10">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Загрузка опросов...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#7C65FF]/8 via-white to-[#8888FC]/8">
      <div
        className="max-w-2xl mx-auto px-4 pb-8"
        style={{ paddingTop: "var(--tg-safe-top, max(16px, env(safe-area-inset-top)))" }}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-8 pt-2">
          <div className="flex items-center gap-3">
            <Image src="/logo.jpg" alt="ProSurvey" width={40} height={40} className="rounded-xl shadow-lg" />
            <div>
              <h1 className="text-xl font-bold text-foreground">Мои опросы</h1>
              <p className="text-xs text-muted-foreground">Выберите опрос для начала</p>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={onLogout}
            className="gap-1.5 text-muted-foreground hover:text-destructive hover:border-destructive/40 bg-transparent"
          >
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
          <Card className="border-dashed border-2 border-primary/20">
            <CardContent className="pt-10 pb-10 text-center flex flex-col items-center gap-2">
              <ClipboardList className="h-10 w-10 text-primary/30 mb-1" />
              <p className="font-medium text-muted-foreground">Опросов не найдено</p>
              <p className="text-xs text-muted-foreground">Обратитесь к администратору</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {surveys.map((survey) => (
              <Card
                key={survey.id}
                className={`border transition-all duration-200 ${survey.is_active
                    ? "border-primary/20 hover:border-primary/50 hover:shadow-md hover:shadow-primary/10 cursor-pointer"
                    : "border-border opacity-60"
                  }`}
                onClick={() => survey.is_active && setSelectedSurvey(survey)}
              >
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <CardTitle className="text-base font-semibold leading-snug break-words">
                        {survey.title}
                      </CardTitle>
                      {survey.description?.trim() && (
                        <CardDescription className="mt-1.5 text-sm break-words whitespace-pre-wrap leading-relaxed text-muted-foreground">
                          {survey.description}
                        </CardDescription>
                      )}
                    </div>
                    {!survey.is_active && (
                      <span className="shrink-0 text-xs bg-muted text-muted-foreground px-2 py-1 rounded-full">
                        Неактивно
                      </span>
                    )}
                  </div>
                </CardHeader>
                {survey.is_active && (
                  <CardContent className="pt-0">
                    <Button
                      size="sm"
                      className="w-full bg-primary hover:bg-primary/90 shadow-sm shadow-primary/20 gap-2"
                      onClick={(e) => {
                        e.stopPropagation()
                        setSelectedSurvey(survey)
                      }}
                    >
                      <Play className="h-4 w-4" />
                      Начать опрос
                    </Button>
                  </CardContent>
                )}
              </Card>
            ))}
          </div>
        )}
      </div>

      {selectedSurvey && <PreparationModal survey={selectedSurvey} onClose={() => setSelectedSurvey(null)} />}
    </div>
  )
}
