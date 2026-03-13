"use client"

import { useEffect } from "react"

export function TelegramInit() {
  useEffect(() => {
    const tg = (window as any).Telegram?.WebApp
    if (!tg) return

    // Разворачиваем на весь экран
    tg.expand()

    // На новых версиях Telegram (7.8+) — полный fullscreen без шапки
    if (tg.requestFullscreen) {
      tg.requestFullscreen()
    }

    // Убираем кнопку закрытия / свайп вниз
    tg.enableClosingConfirmation?.()
  }, [])

  return null
}
