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

    // Устанавливаем CSS-переменную с реальным отступом сверху от Telegram
    const setSafeTop = () => {
      const top =
        tg.safeAreaInsets?.top ??
        tg.contentSafeAreaInsets?.top ??
        0
      // Минимум 60px в Telegram чтобы гарантированно не перекрывалось хедером
      const safeTop = Math.max(top, tg.isExpanded ? 60 : 16)
      document.documentElement.style.setProperty("--tg-safe-top", `${safeTop}px`)
    }
    setSafeTop()
    tg.onEvent?.("safeAreaChanged", setSafeTop)
    tg.onEvent?.("contentSafeAreaChanged", setSafeTop)
  }, [])

  return null
}
