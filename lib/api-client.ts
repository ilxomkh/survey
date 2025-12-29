const API_BASE_URL = "https://8a71c4b4c1fd.ngrok-free.app"

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
    console.log("[ApiClient] request: отправка запроса", {
      method: options.method || "GET",
      url,
      endpoint,
      fullUrl: url,
    })
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
      const response = await fetch(url, {
        ...options,
        headers,
        mode: "cors",
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
            errorMessage = errorData.detail || errorData.message || errorMessage
          } catch {
            // Если не удалось распарсить JSON, используем дефолтное сообщение
          }
        } else {
          // Если получили HTML вместо JSON, это может быть страница ошибки
          const text = await response.text()
          if (text.includes("<!DOCTYPE") || text.includes("<html")) {
            errorMessage = `Сервер вернул HTML вместо JSON. Возможно, проблема с CORS или URL неправильный.`
          } else {
            errorMessage = text.substring(0, 200) || errorMessage
          }
        }
        throw {
          message: errorMessage,
          status: response.status,
        } as ApiError
      }

      if (response.status === 204) {
        return undefined as T
      }

      // Проверяем, что ответ действительно JSON
      if (!isJson) {
        const text = await response.text()
        if (text.includes("<!DOCTYPE") || text.includes("<html")) {
          throw {
            message: `Сервер вернул HTML вместо JSON. Проверьте URL и настройки CORS.`,
            status: response.status,
          } as ApiError
        }
        // Пытаемся распарсить как JSON, даже если Content-Type не указан
        try {
          return JSON.parse(text) as T
        } catch {
          throw {
            message: `Ожидался JSON, но получен: ${text.substring(0, 100)}`,
            status: response.status,
          } as ApiError
        }
      }

      return response.json()
    } catch (error) {
      if (error instanceof TypeError && error.message === "Failed to fetch") {
        console.error("[v0] Network error - check if backend is running at", API_BASE_URL)
        throw {
          message: `Не удается подключиться к серверу. Убедитесь, что сервер запущен на ${API_BASE_URL}`,
          status: 0,
        } as ApiError
      }
      // Если это уже ApiError, пробрасываем дальше
      if (error && typeof error === "object" && "status" in error) {
        throw error
      }
      // Иначе оборачиваем в ApiError
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

  async getSurveys(sessionId?: string) {
    let endpoint = "/api/agent/surveys"
    if (sessionId) {
      const params = new URLSearchParams({ session_id: sessionId })
      endpoint = `${endpoint}?${params.toString()}`
      console.log("[ApiClient] getSurveys: session_id передан, endpoint:", endpoint)
    } else {
      console.log("[ApiClient] getSurveys: session_id не передан, endpoint:", endpoint)
    }
    return this.request(endpoint, { method: "GET" })
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

  async completeSession(sessionId: string, latitude: number, longitude: number, accuracy: number) {
    return this.request(`/api/sessions/${sessionId}/complete`, {
      method: "POST",
      body: JSON.stringify({ latitude, longitude, accuracy }),
    })
  }

  async getSupervisorSessions(status?: string, limit = 50) {
    const params = new URLSearchParams()
    if (status) params.append("status", status)
    params.append("limit", limit.toString())

    return this.request(`/api/supervisor/sessions?${params.toString()}`, { method: "GET" })
  }

  async getSurveyQuestions(surveyId: number, sessionId?: string) {
    let endpoint = `/api/surveys/${surveyId}/questions`
    if (sessionId) {
      const params = new URLSearchParams({ session_id: sessionId })
      endpoint = `${endpoint}?${params.toString()}`
    }
    console.log("[ApiClient] getSurveyQuestions: получение вопросов опроса", { surveyId, sessionId, endpoint })
    return this.request(endpoint, { method: "GET" })
  }
}

export const apiClient = new ApiClient()
