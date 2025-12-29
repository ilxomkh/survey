export const storage = {
  getToken: () => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("auth_token")
    }
    return null
  },
  setToken: (token: string) => {
    if (typeof window !== "undefined") {
      localStorage.setItem("auth_token", token)
    }
  },
  clearToken: () => {
    if (typeof window !== "undefined") {
      localStorage.removeItem("auth_token")
    }
  },
  getRole: () => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("user_role")
    }
    return null
  },
  setRole: (role: string) => {
    if (typeof window !== "undefined") {
      localStorage.setItem("user_role", role)
    }
  },
  getSessionId: () => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("current_session_id")
    }
    return null
  },
  setSessionId: (sessionId: string) => {
    if (typeof window !== "undefined") {
      localStorage.setItem("current_session_id", sessionId)
    }
  },
  clearSessionId: () => {
    if (typeof window !== "undefined") {
      localStorage.removeItem("current_session_id")
    }
  },
}
