"use client"

import { useState, useEffect, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  AlertCircle, LogOut, Loader2, Filter, Play, Pause, Volume2,
  ChevronDown, ChevronUp, Users, ClipboardList, UserCheck, Building2, Plus, X
} from "lucide-react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { apiClient } from "@/lib/api-client"

// ─── Типы ─────────────────────────────────────────────────────────────────────

interface Answer {
  questionId: string
  questionText: string
  answerText: string
  type: string
}

interface Session {
  id: string
  surveyTitle: string
  agentName: string
  agentEmail: string
  status: string
  language: string
  audioUrl: string
  hasAudio: boolean
  hasGps: boolean
  answers: Answer[]
  completedAt: string
  startedAt: string
  durationSec: number | null
}

interface Agent {
  id: string
  name: string
  email: string
  username: string
  status: string
  role: string
  totalSessions: number
  assignedSurveys: string[]
  createdAt: string
}

interface Customer {
  id: number
  name: string
  contact_info: string | null
  created_at: string
}

interface SupervisorDashboardProps {
  onLogout: () => void
}

// ─── Утилиты ──────────────────────────────────────────────────────────────────

function formatDate(d: string) {
  if (!d) return "—"
  return new Date(d).toLocaleString("ru-RU", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  })
}

function formatDuration(sec: number | null) {
  if (!sec) return "—"
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}м ${s}с`
}

const STATUS_COLORS: Record<string, string> = {
  PENDING: "bg-yellow-100 text-yellow-800 border-yellow-300",
  IN_PROGRESS: "bg-blue-100 text-blue-800 border-blue-300",
  COMPLETED: "bg-green-100 text-green-800 border-green-300",
  VALID: "bg-green-100 text-green-800 border-green-300",
  SUSPICIOUS: "bg-orange-100 text-orange-800 border-orange-300",
  INVALID: "bg-red-100 text-red-800 border-red-300",
}

const STATUS_LABELS: Record<string, string> = {
  PENDING: "Ожидание",
  IN_PROGRESS: "В процессе",
  COMPLETED: "Завершено",
  VALID: "Валидно",
  SUSPICIOUS: "Подозрительно",
  INVALID: "Невалидно",
}

// ─── Аудио-плеер ──────────────────────────────────────────────────────────────

function AudioPlayer({ sessionId }: { sessionId: string }) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState("")
  const audioUrl = apiClient.getAudioUrl(sessionId)

  const toggle = () => {
    const audio = audioRef.current
    if (!audio) return
    if (playing) {
      audio.pause()
      setPlaying(false)
    } else {
      audio.play().catch(() => setError("Не удалось воспроизвести"))
      setPlaying(true)
    }
  }

  return (
    <div className="flex items-center gap-2 mt-2">
      <audio
        ref={audioRef}
        src={audioUrl}
        onCanPlay={() => setLoaded(true)}
        onEnded={() => setPlaying(false)}
        onError={() => setError("Аудио недоступно")}
        preload="metadata"
      />
      <Button
        size="sm"
        variant="outline"
        className="gap-1 h-7 text-xs"
        onClick={toggle}
        disabled={!!error}
      >
        {playing ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
        {error ? error : playing ? "Пауза" : "Слушать"}
      </Button>
      {loaded && !error && (
        <Volume2 className="h-3 w-3 text-muted-foreground" />
      )}
    </div>
  )
}

// ─── Вкладка Сессии ───────────────────────────────────────────────────────────

function SessionsTab() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [statusFilter, setStatusFilter] = useState("all")
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const fetchSessions = async (status?: string) => {
    setLoading(true)
    setError("")
    try {
      const data: any = await apiClient.getAdminSessions({
        status: status && status !== "all" ? status : undefined,
        limit: 200,
      })
      setSessions(data.items ?? [])
      setTotal(data.total ?? 0)
    } catch (e: any) {
      setError(e?.message || "Ошибка загрузки")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchSessions(statusFilter) }, [statusFilter])

  const toggleExpand = (id: string) =>
    setExpandedId(prev => prev === id ? null : id)

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-muted-foreground">Всего: {total}</p>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-44">
            <Filter className="h-4 w-4 mr-2" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Все статусы</SelectItem>
            {Object.entries(STATUS_LABELS).map(([v, l]) => (
              <SelectItem key={v} value={v}>{l}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      ) : sessions.length === 0 ? (
        <Card><CardContent className="pt-8 text-center text-muted-foreground">Сессий не найдено</CardContent></Card>
      ) : (
        <div className="grid gap-3">
          {sessions.map(session => {
            const expanded = expandedId === session.id
            return (
              <Card key={session.id} className="border border-border">
                {/* Заголовок сессии — кликабельный */}
                <div
                  className="flex items-center justify-between p-4 cursor-pointer hover:bg-muted/40 transition-colors"
                  onClick={() => toggleExpand(session.id)}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-xs text-muted-foreground truncate max-w-[200px]">
                        {session.id}
                      </span>
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded border ${STATUS_COLORS[session.status] ?? "bg-gray-100"}`}>
                        {STATUS_LABELS[session.status] ?? session.status}
                      </span>
                      <span className="text-xs bg-secondary text-secondary-foreground px-2 py-0.5 rounded">
                        {session.language?.toUpperCase()}
                      </span>
                    </div>
                    <div className="mt-1 text-sm font-medium truncate">{session.surveyTitle}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      Агент: {session.agentName} • {formatDate(session.completedAt)} • {formatDuration(session.durationSec)}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 ml-2 shrink-0">
                    {session.hasAudio && (
                      <span className="text-xs text-green-600 font-medium">🎙</span>
                    )}
                    {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </div>
                </div>

                {/* Раскрытая панель с ответами и аудио */}
                {expanded && (
                  <div className="border-t px-4 pb-4 pt-3 space-y-4">
                    {/* Аудиоплеер */}
                    {session.hasAudio && (
                      <div>
                        <p className="text-xs font-semibold text-muted-foreground mb-1">Голосовая запись</p>
                        <AudioPlayer sessionId={session.id} />
                      </div>
                    )}

                    {/* Ответы */}
                    {session.answers && session.answers.length > 0 ? (
                      <div>
                        <p className="text-xs font-semibold text-muted-foreground mb-2">
                          Ответы ({session.answers.length})
                        </p>
                        <div className="space-y-2">
                          {session.answers.map((ans, i) => (
                            <div key={ans.questionId || i} className="bg-muted/50 rounded p-2">
                              <p className="text-xs text-muted-foreground">{ans.questionText || ans.questionId}</p>
                              <p className="text-sm font-medium mt-0.5">{ans.answerText || "—"}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">Ответы ещё не получены</p>
                    )}

                    {/* Мета-информация */}
                    <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground pt-1 border-t">
                      <div>Начало: {formatDate(session.startedAt)}</div>
                      <div>Конец: {formatDate(session.completedAt)}</div>
                      <div>GPS: {session.hasGps ? "✓" : "✗"}</div>
                      <div>Аудио: {session.hasAudio ? "✓" : "✗"}</div>
                    </div>
                  </div>
                )}
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Вкладка Агенты ───────────────────────────────────────────────────────────

function AgentsTab() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [togglingId, setTogglingId] = useState<string | null>(null)

  const fetchAgents = async () => {
    setLoading(true)
    setError("")
    try {
      const data: any = await apiClient.getAdminAgents()
      setAgents(Array.isArray(data) ? data : [])
    } catch (e: any) {
      setError(e?.message || "Ошибка загрузки")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchAgents() }, [])

  const handleToggle = async (agent: Agent) => {
    setTogglingId(agent.id)
    try {
      const newStatus = agent.status === "active" ? false : true
      await apiClient.toggleAgentStatus(agent.id, newStatus)
      setAgents(prev => prev.map(a =>
        a.id === agent.id
          ? { ...a, status: newStatus ? "active" : "inactive" }
          : a
      ))
    } catch (e: any) {
      setError(e?.message || "Ошибка смены статуса")
    } finally {
      setTogglingId(null)
    }
  }

  if (loading) return (
    <div className="flex justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>
  )

  return (
    <div>
      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="grid gap-3">
        {agents.length === 0 ? (
          <Card><CardContent className="pt-8 text-center text-muted-foreground">Агентов нет</CardContent></Card>
        ) : agents.map(agent => (
          <Card key={agent.id} className="border border-border">
            <div className="flex items-center justify-between p-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-sm">{agent.name}</span>
                  <span className="text-xs text-muted-foreground">@{agent.username}</span>
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded border ${
                    agent.status === "active"
                      ? "bg-green-100 text-green-800 border-green-300"
                      : "bg-gray-100 text-gray-600 border-gray-300"
                  }`}>
                    {agent.status === "active" ? "Активен" : "Неактивен"}
                  </span>
                  <span className="text-xs bg-secondary text-secondary-foreground px-2 py-0.5 rounded">
                    {agent.role}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  {agent.email} • Сессий: {agent.totalSessions} • С {formatDate(agent.createdAt).split(",")[0]}
                </div>
              </div>
              <Button
                size="sm"
                variant={agent.status === "active" ? "destructive" : "default"}
                className="ml-3 h-7 text-xs shrink-0"
                disabled={togglingId === agent.id}
                onClick={() => handleToggle(agent)}
              >
                {togglingId === agent.id
                  ? <Loader2 className="h-3 w-3 animate-spin" />
                  : agent.status === "active" ? "Деактивировать" : "Активировать"
                }
              </Button>
            </div>
          </Card>
        ))}
      </div>
    </div>
  )
}

// ─── Вкладка Заказчики ────────────────────────────────────────────────────────

function CustomersTab() {
  const [customers, setCustomers] = useState<Customer[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [showForm, setShowForm] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [newName, setNewName] = useState("")
  const [newContact, setNewContact] = useState("")

  const fetchCustomers = async () => {
    setLoading(true)
    setError("")
    try {
      const data: any = await apiClient.getCustomers()
      setCustomers(Array.isArray(data) ? data : [])
    } catch (e: any) {
      setError(e?.message || "Ошибка загрузки")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchCustomers() }, [])

  const handleCreate = async () => {
    if (!newName.trim()) return
    setSubmitting(true)
    setError("")
    try {
      await apiClient.createCustomer({ name: newName.trim(), contact_info: newContact.trim() || undefined })
      setNewName("")
      setNewContact("")
      setShowForm(false)
      await fetchCustomers()
    } catch (e: any) {
      setError(e?.message || "Ошибка создания")
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async (id: number) => {
    if (!confirm("Удалить заказчика? Опросы не будут удалены.")) return
    try {
      await apiClient.deleteCustomer(id)
      setCustomers(prev => prev.filter(c => c.id !== id))
    } catch (e: any) {
      setError(e?.message || "Ошибка удаления")
    }
  }

  return (
    <div>
      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex justify-end mb-4">
        <Button size="sm" className="gap-1" onClick={() => setShowForm(v => !v)}>
          {showForm ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
          {showForm ? "Отмена" : "Добавить заказчика"}
        </Button>
      </div>

      {showForm && (
        <Card className="mb-4 border-primary/30">
          <CardContent className="pt-4 space-y-3">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Название *</label>
              <input
                className="w-full border rounded px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-primary"
                placeholder="Название организации / заказчика"
                value={newName}
                onChange={e => setNewName(e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Контактная информация</label>
              <input
                className="w-full border rounded px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-primary"
                placeholder="Телефон, email, примечание..."
                value={newContact}
                onChange={e => setNewContact(e.target.value)}
              />
            </div>
            <Button
              size="sm"
              className="w-full"
              disabled={!newName.trim() || submitting}
              onClick={handleCreate}
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Сохранить
            </Button>
          </CardContent>
        </Card>
      )}

      {loading ? (
        <div className="flex justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>
      ) : customers.length === 0 ? (
        <Card><CardContent className="pt-8 text-center text-muted-foreground">Заказчиков нет. Добавьте первого.</CardContent></Card>
      ) : (
        <div className="grid gap-3">
          {customers.map(customer => (
            <Card key={customer.id} className="border border-border">
              <div className="flex items-center justify-between p-4">
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm">{customer.name}</div>
                  {customer.contact_info && (
                    <div className="text-xs text-muted-foreground mt-0.5">{customer.contact_info}</div>
                  )}
                  <div className="text-xs text-muted-foreground mt-0.5">
                    ID: {customer.id} • Добавлен: {formatDate(customer.created_at)}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:text-destructive ml-2 h-7 shrink-0"
                  onClick={() => handleDelete(customer.id)}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Главный дашборд ──────────────────────────────────────────────────────────

type TabId = "sessions" | "agents" | "customers"

export function SupervisorDashboard({ onLogout }: SupervisorDashboardProps) {
  const [activeTab, setActiveTab] = useState<TabId>("sessions")

  useEffect(() => {
    const token = localStorage.getItem("auth_token")
    if (token) apiClient.setToken(token)
  }, [])

  const tabs: { id: TabId; label: string; icon: React.ReactNode }[] = [
    { id: "sessions", label: "Сессии", icon: <ClipboardList className="h-4 w-4" /> },
    { id: "agents", label: "Агенты", icon: <UserCheck className="h-4 w-4" /> },
    { id: "customers", label: "Заказчики", icon: <Building2 className="h-4 w-4" /> },
  ]

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary/5 to-secondary/5">
      <div className="max-w-5xl mx-auto p-4">
        {/* Шапка */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold">Панель администратора</h1>
            <p className="text-sm text-muted-foreground">Управление сессиями, агентами и заказчиками</p>
          </div>
          <Button variant="outline" size="sm" onClick={onLogout} className="gap-2 bg-transparent">
            <LogOut className="h-4 w-4" />
            Выход
          </Button>
        </div>

        {/* Табы */}
        <div className="flex gap-1 mb-6 bg-muted p-1 rounded-lg w-fit">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                activeTab === tab.id
                  ? "bg-background shadow-sm text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>

        {/* Контент */}
        {activeTab === "sessions" && <SessionsTab />}
        {activeTab === "agents" && <AgentsTab />}
        {activeTab === "customers" && <CustomersTab />}
      </div>
    </div>
  )
}
