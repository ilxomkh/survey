"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { AlertCircle, LogOut, Loader2, Filter } from "lucide-react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { apiClient } from "@/lib/api-client"

interface Session {
  session_id: string
  survey_id: number
  agent_id: number
  status: string
  started_at: string
  duration_sec?: number
  validation_details?: Record<string, any>
}

interface SupervisorDashboardProps {
  onLogout: () => void
}

export function SupervisorDashboard({ onLogout }: SupervisorDashboardProps) {
  const [sessions, setSessions] = useState<Session[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [statusFilter, setStatusFilter] = useState<string>("all")

  useEffect(() => {
    const fetchSessions = async () => {
      try {
        const token = localStorage.getItem("auth_token")
        if (token) {
          apiClient.setToken(token)
        }

        const data = await apiClient.getSupervisorSessions(
          statusFilter !== "all" ? statusFilter : undefined,
        )

        setSessions(Array.isArray(data) ? data : [])
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

    setLoading(true)
    fetchSessions()
  }, [statusFilter, onLogout])

  const getStatusColor = (status: string) => {
    const colors: Record<string, string> = {
      PENDING: "bg-yellow-100 text-yellow-800 border-yellow-300",
      IN_PROGRESS: "bg-blue-100 text-blue-800 border-blue-300",
      COMPLETED: "bg-green-100 text-green-800 border-green-300",
      VALID: "bg-green-100 text-green-800 border-green-300",
      SUSPICIOUS: "bg-orange-100 text-orange-800 border-orange-300",
      INVALID: "bg-red-100 text-red-800 border-red-300",
    }
    return colors[status] || "bg-gray-100 text-gray-800 border-gray-300"
  }

  const formatDate = (dateString: string) => {
    const date = new Date(dateString)
    return date.toLocaleDateString("ru-RU", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary/5 to-secondary/5">
      <div className="max-w-6xl mx-auto p-4">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold">Панель супервизора</h1>
            <p className="text-muted-foreground">Мониторинг всех сессий опросов</p>
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

        <div className="mb-6 flex gap-2">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-48">
              <Filter className="h-4 w-4 mr-2" />
              <SelectValue placeholder="Фильтр по статусу" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Все статусы</SelectItem>
              <SelectItem value="PENDING">В ожидании</SelectItem>
              <SelectItem value="IN_PROGRESS">В процессе</SelectItem>
              <SelectItem value="COMPLETED">Завершено</SelectItem>
              <SelectItem value="VALID">Действительно</SelectItem>
              <SelectItem value="SUSPICIOUS">Подозрительно</SelectItem>
              <SelectItem value="INVALID">Недействительно</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        ) : sessions.length === 0 ? (
          <Card>
            <CardContent className="pt-8 text-center">
              <p className="text-muted-foreground">Сессий не найдено</p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4">
            {sessions.map((session) => (
              <Card
                key={session.session_id}
                className="border-2 border-primary/10 hover:border-primary/20 transition-colors"
              >
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between">
                    <div>
                      <CardTitle className="text-base">Сессия {session.session_id.slice(0, 8)}...</CardTitle>
                      <p className="text-sm text-muted-foreground mt-1">
                        Опрос #{session.survey_id} • Агент #{session.agent_id}
                      </p>
                    </div>
                    <span
                      className={`text-xs font-semibold px-3 py-1 rounded border ${getStatusColor(session.status)}`}
                    >
                      {session.status}
                    </span>
                  </div>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Начало:</span>
                    <span className="font-medium">{formatDate(session.started_at)}</span>
                  </div>
                  {session.duration_sec && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Длительность:</span>
                      <span className="font-medium">{session.duration_sec} сек</span>
                    </div>
                  )}
                  {session.validation_details && Object.keys(session.validation_details).length > 0 && (
                    <div className="mt-3 p-2 bg-muted rounded text-xs">
                      <p className="font-semibold mb-1">Детали валидации:</p>
                      <pre className="text-muted-foreground overflow-auto">
                        {JSON.stringify(session.validation_details, null, 2)}
                      </pre>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
