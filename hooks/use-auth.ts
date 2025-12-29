"use client"

import { useState, useEffect, useCallback } from "react"
import { apiClient } from "@/lib/api-client"
import { storage } from "@/lib/storage"

export function useAuth() {
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [role, setRole] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const token = storage.getToken()
    const userRole = storage.getRole()
    if (token) {
      apiClient.setToken(token)
      setIsAuthenticated(true)
      setRole(userRole)
    }
    setLoading(false)
  }, [])

  const login = useCallback(async (username: string, password: string) => {
    const response = await apiClient.login(username, password)
    const token = response.access_token || response.token
    const userRole = response.role || "AGENT"

    apiClient.setToken(token)
    storage.setToken(token)
    storage.setRole(userRole)

    setIsAuthenticated(true)
    setRole(userRole)

    return { token, role: userRole }
  }, [])

  const logout = useCallback(() => {
    apiClient.clearToken()
    storage.clearToken()
    storage.clearToken()
    setIsAuthenticated(false)
    setRole(null)
  }, [])

  return {
    isAuthenticated,
    role,
    loading,
    login,
    logout,
  }
}
