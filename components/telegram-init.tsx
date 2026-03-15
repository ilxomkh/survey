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

    // Когда клавиатура открывается:
    //   Android — window.innerHeight уменьшается
    //   iOS     — window.visualViewport.height уменьшается (innerHeight остаётся прежним)
    // В обоих случаях position:fixed; bottom:0 оказывается прямо НАД клавиатурой.
    // Смещаем панель вниз на высоту клавиатуры, чтобы она скрылась ЗА ней.
    const vpHeight = () => window.visualViewport?.height ?? window.innerHeight
    let stableVPHeight = vpHeight()

    const setKeyboardOffset = () => {
      const current = vpHeight()
      // Если высота выросла — обновляем "стабильную" (клавиатура закрылась / expand)
      if (current > stableVPHeight) {
        stableVPHeight = current
      }
      const offset = Math.max(0, stableVPHeight - current)
      document.documentElement.style.setProperty("--tg-keyboard-offset", `${offset}px`)
    }

    window.addEventListener("resize", setKeyboardOffset)
    window.visualViewport?.addEventListener("resize", setKeyboardOffset)
    tg.onEvent?.("viewportChanged", setKeyboardOffset)

    return () => {
      window.removeEventListener("resize", setKeyboardOffset)
      window.visualViewport?.removeEventListener("resize", setKeyboardOffset)
    }
  }, [])

  return null
}
