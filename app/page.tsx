"use client"

import { useState, useEffect } from "react"
import { LoginPage } from "@/components/login-page"
import { AgentDashboard } from "@/components/agent-dashboard"
import { SupervisorDashboard } from "@/components/supervisor-dashboard"
import { Loader2 } from "lucide-react"

export default function Home() {
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [role, setRole] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const token = localStorage.getItem("auth_token")
    const userRole = localStorage.getItem("user_role")
    if (token && userRole) {
      setIsAuthenticated(true)
      setRole(userRole)
    }
    setLoading(false)
  }, [])

  const handleLoginSuccess = (newRole: string) => {
    setRole(newRole)
    setIsAuthenticated(true)
  }

  const handleLogout = () => {
    localStorage.removeItem("auth_token")
    localStorage.removeItem("user_role")
    setIsAuthenticated(false)
    setRole(null)
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  if (!isAuthenticated) {
    return <LoginPage onLoginSuccess={handleLoginSuccess} />
  }

  if (role === "SUPERVISOR" || role === "ADMIN") {
    return <SupervisorDashboard onLogout={handleLogout} />
  }

  return <AgentDashboard onLogout={handleLogout} />
}
