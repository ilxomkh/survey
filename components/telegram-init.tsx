"use client"

import { useEffect } from "react"

export function TelegramInit() {
  useEffect(() => {
    const tg = (window as any).Telegram?.WebApp
    if (!tg) return

    // Разворачиваем на весь экран
    tg.expand()

    // На новых версиях Telegram (7.8+) — полный fullscreen без шапки
    try {
      if (typeof tg.requestFullscreen === "function") {
        tg.requestFullscreen()
      }
    } catch {
      // Старые клиенты не поддерживают requestFullscreen — игнорируем
    }

    // Запрещаем вертикальный свайп вниз чтобы не закрыть приложение
    tg.disableVerticalSwipes?.()

    // Убираем кнопку закрытия / подтверждение закрытия
    tg.enableClosingConfirmation?.()

    // Скрываем MainButton если он виден (не нужен в нашем UI)
    tg.MainButton?.hide?.()
  }, [])

  return null
}
