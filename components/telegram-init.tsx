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
      // Минимум 90px — покрывает все стандартные телефоны:
      // Android (статус-бар 24px + TG хедер 56px = 80px)
      // iPhone без чёлки (20px + 56px = 76px)
      // iPhone с чёлкой (44px + 56px = 100px → берём из safeAreaInsets)
      // iPhone Dynamic Island (59px + 56px = 115px → берём из safeAreaInsets)
      const safeTop = Math.max(top, tg.isExpanded ? 90 : 16)
      document.documentElement.style.setProperty("--tg-safe-top", `${safeTop}px`)
    }
    setSafeTop()
    tg.onEvent?.("safeAreaChanged", setSafeTop)
    tg.onEvent?.("contentSafeAreaChanged", setSafeTop)

    // Когда клавиатура открывается, viewportHeight уменьшается, а viewportStableHeight остаётся.
    // Устанавливаем отступ, чтобы фиксированная нижняя панель уходила ЗА клавиатуру (не над ней).
    const setKeyboardOffset = () => {
      const stable = tg.viewportStableHeight ?? tg.viewportHeight ?? window.innerHeight
      const current = tg.viewportHeight ?? window.innerHeight
      const offset = Math.max(0, stable - current)
      document.documentElement.style.setProperty("--tg-keyboard-offset", `${offset}px`)
    }
    setKeyboardOffset()
    tg.onEvent?.("viewportChanged", setKeyboardOffset)
  }, [])

  return null
}
