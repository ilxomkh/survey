"use client"

import type React from "react"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { AlertCircle, Loader2, ClipboardList } from "lucide-react"
import { apiClient } from "@/lib/api-client"

interface LoginPageProps {
  onLoginSuccess: (role: string) => void
}

export function LoginPage({ onLoginSuccess }: LoginPageProps) {
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setError("")
    setLoading(true)

    try {
      const data = await apiClient.login(username, password)
      const token = data.token
      const role = data.agent?.role || "AGENT"

      localStorage.setItem("auth_token", token)
      localStorage.setItem("user_role", role)
      localStorage.setItem("agent_id", data.agent?.id?.toString() || "")

      apiClient.setToken(token)
      onLoginSuccess(role)
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : (err as any)?.message || "Ошибка входа"
      setError(errorMessage)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[#7C65FF]/10 via-white to-[#8888FC]/10 px-4 pb-4"
      style={{ paddingTop: "var(--tg-safe-top, max(16px, env(safe-area-inset-top)))" }}
    >
      <div className="w-full max-w-sm">
        {/* Logo / Brand */}
        <div className="flex flex-col items-center mb-8">
          <div className="h-16 w-16 rounded-2xl bg-primary flex items-center justify-center shadow-xl shadow-primary/30 mb-4">
            <ClipboardList className="h-8 w-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-foreground">ProSurvey</h1>
          <p className="text-sm text-muted-foreground mt-1">Система контроля опросов</p>
        </div>

        <Card className="border border-primary/15 shadow-lg shadow-primary/5">
          <CardHeader className="pb-2">
            <p className="text-sm text-center text-muted-foreground">Войдите в свой аккаунт</p>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleLogin} className="space-y-4">
              {error && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <div className="space-y-2">
                <label className="text-sm font-medium">Имя пользователя</label>
                <Input
                  placeholder="Введите имя пользователя"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  disabled={loading}
                  autoComplete="username"
                  className="focus-visible:ring-primary"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Пароль</label>
                <Input
                  type="password"
                  placeholder="Введите пароль"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={loading}
                  autoComplete="current-password"
                  className="focus-visible:ring-primary"
                />
              </div>
              <Button
                type="submit"
                className="w-full bg-primary hover:bg-primary/90 shadow-sm shadow-primary/20 mt-2"
                disabled={loading}
              >
                {loading ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Загрузка...
                  </>
                ) : (
                  "Войти"
                )}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
