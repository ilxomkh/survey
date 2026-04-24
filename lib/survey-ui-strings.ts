/** UI copy for survey flows: Russian default, Uzbek for UZ surveys (e.g. NPS Marketpleys). */

export type SurveyUiLocale = "ru" | "uz"

export function getSurveyUiLocale(survey: { language?: string; title?: string }): SurveyUiLocale {
  const lang = (survey.language ?? "").toLowerCase().trim()
  if (lang === "uz" || lang === "uz_latn" || lang === "uz-latn" || lang === "uzbek") return "uz"
  const t = (survey.title ?? "").toLowerCase()
  if (t.includes("marketpleys")) return "uz"
  return "ru"
}

export type RecordingUiStrings = {
  geoLoading: string
  micLoading: string
  geoUnsupportedShort: string
  geoUnsupportedLong: string
  geoDeniedAlert: string
  geoDeniedShort: string
  geoDeniedLong: string
  geoOk: (accuracyM: string) => string
  geoPermissionDenied: string
  geoPositionUnavailable: string
  geoTimeout: string
  geoError: (message: string) => string
  micOk: string
  initError: string
  geoNotSupportedThrow: string
  geoTimeoutThrow: string
  sessionFinishError: string
  initSessionTitle: string
  questionProgress: (current: number, total: number) => string
  loadingQuestions: string
  noQuestions: string
  placeholderOther: string
  selectPlaceholder: string
  placeholderNumber: string
  placeholderText: string
  scaleMinLabel: string
  scaleMaxLabel: string
  yes: string
  no: string
  back: string
  next: string
  finishConfirmNo: string
  finishConfirmYes: string
  finishing: string
  finish: string
  finishConfirmQuestion: string
  otherOptionFallback: string
}

const RU_RECORDING: RecordingUiStrings = {
  geoLoading: "Получение локации...",
  micLoading: "Запрос микрофона...",
  geoUnsupportedShort: "✗ Геолокация не поддерживается",
  geoUnsupportedLong: "Геолокация не поддерживается вашим браузером",
  geoDeniedAlert: "Геолокация запрещена. Разрешите доступ в настройках телефона",
  geoDeniedShort: "✗ Геолокация запрещена",
  geoDeniedLong: "Геолокация запрещена. Разрешите доступ в настройках телефона",
  geoOk: (m) => `✓ Локация получена (${m}м)`,
  geoPermissionDenied: "✗ Доступ запрещен",
  geoPositionUnavailable: "✗ GPS недоступен",
  geoTimeout: "✗ Таймаут GPS",
  geoError: (msg) => `✗ Ошибка: ${msg}`,
  micOk: "✓ Микрофон подключен",
  initError: "Ошибка инициализации",
  geoNotSupportedThrow: "Геолокация не поддерживается",
  geoTimeoutThrow: "Таймаут получения геолокации",
  sessionFinishError: "Ошибка завершения сессии",
  initSessionTitle: "Инициализация сессии...",
  questionProgress: (current, total) => `Вопрос ${current} из ${total}`,
  loadingQuestions: "Загрузка вопросов...",
  noQuestions: "Вопросы не найдены. Продолжайте запись.",
  placeholderOther: "Напишите ответ респондента",
  selectPlaceholder: "— Выберите вариант —",
  placeholderNumber: "Введите число...",
  placeholderText: "Введите ваш ответ...",
  scaleMinLabel: "Точно нет",
  scaleMaxLabel: "Точно да",
  yes: "Да",
  no: "Нет",
  back: "Назад",
  next: "Далее",
  finishConfirmNo: "Нет, продолжить",
  finishConfirmYes: "Да, завершить",
  finishing: "Завершение...",
  finish: "Завершить",
  finishConfirmQuestion: "Точно хотите завершить опрос?",
  otherOptionFallback: "Другой",
}

const UZ_RECORDING: RecordingUiStrings = {
  geoLoading: "Joylashuv olinmoqda...",
  micLoading: "Mikrofon so'ralmoqda...",
  geoUnsupportedShort: "✗ Geolokatsiya qo'llab-quvvatlanmaydi",
  geoUnsupportedLong: "Brauzeringiz geolokatsiyani qo'llab-quvvatlamaydi",
  geoDeniedAlert: "Geolokatsiya taqiqlangan. Sozlamalarda ruxsat bering",
  geoDeniedShort: "✗ Geolokatsiya taqiqlangan",
  geoDeniedLong: "Geolokatsiya taqiqlangan. Sozlamalarda ruxsat bering",
  geoOk: (m) => `✓ Joylashuv olindi (${m} m)`,
  geoPermissionDenied: "✗ Ruxsat berilmagan",
  geoPositionUnavailable: "✗ GPS mavjud emas",
  geoTimeout: "✗ GPS vaqti tugadi",
  geoError: (msg) => `✗ Xato: ${msg}`,
  micOk: "✓ Mikrofon ulandi",
  initError: "Ishga tushirishda xato",
  geoNotSupportedThrow: "Geolokatsiya qo'llab-quvvatlanmaydi",
  geoTimeoutThrow: "Geolokatsiya olish vaqti tugadi",
  sessionFinishError: "Sessiyani tugatishda xato",
  initSessionTitle: "Sessiya tayyorlanmoqda...",
  questionProgress: (current, total) => `${total} tadan ${current}-savol`,
  loadingQuestions: "Savollar yuklanmoqda...",
  noQuestions: "Savollar topilmadi. Yozuvni davom ettiring.",
  placeholderOther: "Respondent javobini yozing",
  selectPlaceholder: "— Variantni tanlang —",
  placeholderNumber: "Son kiriting...",
  placeholderText: "Javobingizni kiriting...",
  scaleMinLabel: "Umuman yo'q",
  scaleMaxLabel: "Albatta ha",
  yes: "Ha",
  no: "Yo'q",
  back: "Orqaga",
  next: "Keyingi",
  finishConfirmNo: "Yo'q, davom etaman",
  finishConfirmYes: "Ha, tugataman",
  finishing: "Tugatilmoqda...",
  finish: "Tugatish",
  finishConfirmQuestion: "So'rovnomani tugatmoqchimisiz?",
  otherOptionFallback: "Boshqa",
}

export const RECORDING_UI: Record<SurveyUiLocale, RecordingUiStrings> = {
  ru: RU_RECORDING,
  uz: UZ_RECORDING,
}

export type PreparationUiStrings = {
  geoUnsupported: string
  geoDeniedAlert: string
  geoDeniedError: string
  geoUnavailable: string
  sessionStartError: string
  checklistIntro: string
  geoBullet: string
  micBullet: string
  modeFaceToFace: string
  modeAudio: string
  consentLabel: string
  cancel: string
  start: string
  loading: string
}

const RU_PREP: PreparationUiStrings = {
  geoUnsupported: "Геолокация не поддерживается вашим браузером",
  geoDeniedAlert: "Геолокация запрещена. Разрешите доступ в настройках телефона",
  geoDeniedError: "Геолокация запрещена. Разрешите доступ в настройках телефона",
  geoUnavailable: "Не удалось получить геолокацию. Проверьте GPS и повторите попытку",
  sessionStartError: "Ошибка запуска сессии",
  checklistIntro: "Перед началом убедитесь, что всё готово:",
  geoBullet: "Геолокация будет запрошена при старте",
  micBullet: "Микрофон будет запрошен при старте",
  modeFaceToFace: "✓ Опрос лицом к лицу",
  modeAudio: "✓ Аудиозапись автоматически",
  consentLabel: "Я подтверждаю согласие респондента на проведение опроса и запись аудио",
  cancel: "Отмена",
  start: "Начать",
  loading: "Загрузка...",
}

const UZ_PREP: PreparationUiStrings = {
  geoUnsupported: "Brauzeringiz geolokatsiyani qo'llab-quvvatlamaydi",
  geoDeniedAlert: "Geolokatsiya taqiqlangan. Sozlamalarda ruxsat bering",
  geoDeniedError: "Geolokatsiya taqiqlangan. Sozlamalarda ruxsat bering",
  geoUnavailable: "Geolokatsiya aniqlanmadi. GPS ni tekshirib, qayta urinib ko'ring",
  sessionStartError: "Sessiyani boshlashda xato",
  checklistIntro: "Boshlashdan oldin tayyorligiga ishonch hosil qiling:",
  geoBullet: "Boshlanganda geolokatsiya so'raladi",
  micBullet: "Boshlanganda mikrofon so'raladi",
  modeFaceToFace: "✓ Yuzma-yuz so'rovnoma",
  modeAudio: "✓ Audio yozuv avtomatik",
  consentLabel:
    "Respondentning so'rovnoma va audio yozuviga roziligini tasdiqlayman",
  cancel: "Bekor qilish",
  start: "Boshlash",
  loading: "Yuklanmoqda...",
}

export const PREPARATION_UI: Record<SurveyUiLocale, PreparationUiStrings> = {
  ru: RU_PREP,
  uz: UZ_PREP,
}

export type AgentSurveyCardStrings = {
  startSurvey: string
  inactive: string
}

export const AGENT_SURVEY_CARD_UI: Record<SurveyUiLocale, AgentSurveyCardStrings> = {
  ru: { startSurvey: "Начать опрос", inactive: "Неактивно" },
  uz: { startSurvey: "So'rovnomani boshlash", inactive: "Nofaol" },
}
