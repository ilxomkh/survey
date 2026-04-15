const API_BASE_URL = "https://offline.prosurvey.uz"

export interface ApiError {
  message: string
  status: number
  code?: string
}

class ApiClient {
  private token: string | null = null

  setToken(token: string) {
    this.token = token
  }

  getToken(): string | null {
    return this.token
  }

  clearToken() {
    this.token = null
  }

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = `${API_BASE_URL}${endpoint}`
    const method = options.method || "GET"
    
    // Детальное логирование запроса
    console.group(`[ApiClient] ${method} ${endpoint}`)
    console.log("📤 Запрос:", {
      method,
      url,
      endpoint,
      fullUrl: url,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "ngrok-skip-browser-warning": "true",
        ...(this.token ? { Authorization: `Bearer ${this.token.substring(0, 20)}...` } : {}),
      },
      body: options.body ? JSON.parse(options.body as string) : undefined,
    })
    console.log("⏰ Время запроса:", new Date().toISOString())
    
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "ngrok-skip-browser-warning": "true", // Обход страницы предупреждения ngrok
      ...(options.headers as Record<string, string>),
    }

    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`
    }

    try {
      const requestStartTime = Date.now()
      const response = await fetch(url, {
        ...options,
        headers,
        mode: "cors",
      })
      const requestDuration = Date.now() - requestStartTime

      // Логирование ответа
      console.log("📥 Ответ получен:", {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        duration: `${requestDuration}ms`,
      })

      // Проверяем Content-Type перед парсингом
      const contentType = response.headers.get("content-type") || ""
      const isJson = contentType.includes("application/json")

      if (response.status === 401) {
        this.clearToken()
        throw {
          message: "Не авторизован. Пожалуйста, войдите снова.",
          status: 401,
        } as ApiError
      }

      if (!response.ok) {
        let errorMessage = `HTTP ${response.status}`
        if (isJson) {
          try {
            const errorData = await response.json()
            console.error("❌ Ошибка ответа:", errorData)
            errorMessage = errorData.detail || errorData.message || errorMessage
          } catch {
            // Если не удалось распарсить JSON, используем дефолтное сообщение
          }
        } else {
          // Если получили HTML вместо JSON, это может быть страница ошибки
          const text = await response.text()
          console.error("❌ Получен не-JSON ответ:", text.substring(0, 500))
          if (text.includes("<!DOCTYPE") || text.includes("<html")) {
            errorMessage = `Сервер вернул HTML вместо JSON. Возможно, проблема с CORS или URL неправильный.`
          } else {
            errorMessage = text.substring(0, 200) || errorMessage
          }
        }
        console.groupEnd()
        throw {
          message: errorMessage,
          status: response.status,
        } as ApiError
      }

      if (response.status === 204) {
        console.log("✅ Успешный ответ (204 No Content)")
        console.groupEnd()
        return undefined as T
      }

      // Проверяем, что ответ действительно JSON
      if (!isJson) {
        const text = await response.text()
        if (text.includes("<!DOCTYPE") || text.includes("<html")) {
          console.error("❌ Получен HTML вместо JSON")
          console.groupEnd()
          throw {
            message: `Сервер вернул HTML вместо JSON. Проверьте URL и настройки CORS.`,
            status: response.status,
          } as ApiError
        }
        // Пытаемся распарсить как JSON, даже если Content-Type не указан
        try {
          const parsed = JSON.parse(text) as T
          console.log("✅ Успешный ответ (парсинг текста):", parsed)
          console.groupEnd()
          return parsed
        } catch {
          console.error("❌ Не удалось распарсить ответ как JSON")
          console.groupEnd()
          throw {
            message: `Ожидался JSON, но получен: ${text.substring(0, 100)}`,
            status: response.status,
          } as ApiError
        }
      }

      const data = await response.json()
      console.log("✅ Успешный ответ:", data)
      console.log("📊 Размер ответа:", JSON.stringify(data).length, "байт")
      console.groupEnd()
      return data
    } catch (error) {
      if (error instanceof TypeError && error.message === "Failed to fetch") {
        console.error("❌ Ошибка сети - не удается подключиться к серверу:", API_BASE_URL)
        console.error("Проверьте:")
        console.error("  - Запущен ли бекенд")
        console.error("  - Правильный ли URL")
        console.error("  - Настройки CORS")
        console.groupEnd()
        throw {
          message: `Не удается подключиться к серверу. Убедитесь, что сервер запущен на ${API_BASE_URL}`,
          status: 0,
        } as ApiError
      }
      // Если это уже ApiError, пробрасываем дальше
      if (error && typeof error === "object" && "status" in error) {
        console.error("❌ API ошибка:", error)
        console.groupEnd()
        throw error
      }
      // Иначе оборачиваем в ApiError
      console.error("❌ Неизвестная ошибка:", error)
      console.groupEnd()
      throw {
        message: error instanceof Error ? error.message : "Неизвестная ошибка",
        status: 0,
      } as ApiError
    }
  }

  async login(username: string, password: string) {
    return this.request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    })
  }

  async register(data: { username: string; email: string; password: string; full_name: string; role: string }) {
    return this.request("/api/auth/register", {
      method: "POST",
      body: JSON.stringify(data),
    })
  }

  async getSurveys() {
    // Параметры session_id и lang не передаются: бэкенд их игнорирует
    // и всегда возвращает все назначенные опросы (RU + UZ)
    return this.request("/api/agent/surveys", { method: "GET" })
  }

  async startSession(surveyId: number, latitude: number, longitude: number, accuracy: number) {
    console.log("[ApiClient] startSession: создание сессии", {
      surveyId,
      latitude,
      longitude,
      accuracy,
    })
    const result = await this.request("/api/sessions/start", {
      method: "POST",
      body: JSON.stringify({ survey_id: surveyId, latitude, longitude, accuracy }),
    })
    console.log("[ApiClient] startSession: получен ответ от бекенда", result)
    return result
  }

  async updateLocation(sessionId: string, latitude: number, longitude: number, accuracy: number) {
    return this.request(`/api/sessions/${sessionId}/location`, {
      method: "POST",
      body: JSON.stringify({ latitude, longitude, accuracy, timestamp: new Date().toISOString() }),
    })
  }

  async uploadAudio(sessionId: string, audioBlob: Blob) {
    const formData = new FormData()
    formData.append("audio", audioBlob)

    const headers: Record<string, string> = {
      "ngrok-skip-browser-warning": "true", // Обход страницы предупреждения ngrok
    }
    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`
    }

    try {
      const response = await fetch(`${API_BASE_URL}/api/sessions/${sessionId}/audio`, {
        method: "POST",
        body: formData,
        headers,
        mode: "cors",
      })

      if (response.status === 401) {
        this.clearToken()
        throw {
          message: "Не авторизован. Пожалуйста, войдите снова.",
          status: 401,
        } as ApiError
      }

      if (!response.ok) {
        const contentType = response.headers.get("content-type") || ""
        let errorMessage = "Ошибка загрузки аудио"
        if (contentType.includes("application/json")) {
          try {
            const errorData = await response.json()
            errorMessage = errorData.detail || errorData.message || errorMessage
          } catch {
            // Игнорируем ошибку парсинга
          }
        }
        throw {
          message: errorMessage,
          status: response.status,
        } as ApiError
      }

      const contentType = response.headers.get("content-type") || ""
      if (contentType.includes("application/json")) {
        return response.json()
      }
      // Если не JSON, возвращаем пустой объект
      return {} as any
    } catch (error) {
      if (error instanceof TypeError && error.message === "Failed to fetch") {
        throw {
          message: `Не удается загрузить аудио. Проверьте соединение с сервером.`,
          status: 0,
        } as ApiError
      }
      if (error && typeof error === "object" && "status" in error) {
        throw error
      }
      throw {
        message: error instanceof Error ? error.message : "Ошибка загрузки аудио",
        status: 0,
      } as ApiError
    }
  }

  async completeSession(
    sessionId: string,
    latitude: number,
    longitude: number,
    accuracy: number,
    surveyAnswers?: Array<{ key: string; question: string; type: string; value: any }>
  ) {
    const body: any = { latitude, longitude, accuracy }
    if (surveyAnswers && surveyAnswers.length > 0) {
      // Используем survey_answers — именно это поле ждёт бэкенд (schemas.py: SessionComplete)
      body.survey_answers = surveyAnswers
    }
    return this.request(`/api/sessions/${sessionId}/complete`, {
      method: "POST",
      body: JSON.stringify(body),
    })
  }

  async getSupervisorSessions(status?: string, limit = 50) {
    const params = new URLSearchParams()
    if (status) params.append("status", status)
    params.append("limit", limit.toString())

    return this.request(`/api/supervisor/sessions?${params.toString()}`, { method: "GET" })
  }

  async getAdminSessions(params?: {
    status?: string
    survey_id?: number
    agent_id?: number
    limit?: number
    offset?: number
  }) {
    const p = new URLSearchParams()
    if (params?.status) p.append("status", params.status)
    if (params?.survey_id) p.append("survey_id", String(params.survey_id))
    if (params?.agent_id) p.append("agent_id_filter", String(params.agent_id))
    p.append("limit", String(params?.limit ?? 200))
    p.append("offset", String(params?.offset ?? 0))
    return this.request(`/api/admin/sessions-full?${p.toString()}`, { method: "GET" })
  }

  async getAdminAgents() {
    return this.request("/api/admin/agents-list", { method: "GET" })
  }

  async toggleAgentStatus(agentId: string, isActive: boolean) {
    return this.request(`/api/admin/agents/${agentId}/status`, {
      method: "PATCH",
      body: JSON.stringify({ is_active: isActive }),
    })
  }

  async getAdminSurveys() {
    return this.request("/api/admin/surveys-full", { method: "GET" })
  }

  async getDashboardStats() {
    return this.request("/api/admin/dashboard-stats", { method: "GET" })
  }

  getAudioUrl(sessionId: string): string {
    const token = this.token
    return `${API_BASE_URL}/api/admin/audio/${sessionId}?token=${token}`
  }

  async getCustomers() {
    return this.request("/api/admin/customers", { method: "GET" })
  }

  async createCustomer(data: { name: string; contact_info?: string }) {
    return this.request("/api/admin/customers", {
      method: "POST",
      body: JSON.stringify(data),
    })
  }

  async updateCustomer(id: number, data: { name?: string; contact_info?: string }) {
    return this.request(`/api/admin/customers/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    })
  }

  async deleteCustomer(id: number) {
    return this.request(`/api/admin/customers/${id}`, { method: "DELETE" })
  }

  async getSurveyQuestions(surveyId: number, sessionId?: string) {
    let endpoint = `/api/webhooks/tally/surveys/${surveyId}/questions`
    if (sessionId) {
      const params = new URLSearchParams({ session_id: sessionId })
      endpoint = `${endpoint}?${params.toString()}`
    }
    console.log("[ApiClient] getSurveyQuestions: получение вопросов опроса", { surveyId, sessionId, endpoint })
    return this.request(endpoint, { method: "GET" })
  }

}

export const apiClient = new ApiClient()
