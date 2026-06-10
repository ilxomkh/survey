// Usage: node scripts/fetch-survey.mjs [tallyFormId]
// Fetches Tally form blocks directly, saves to scripts/survey-data.json,
// then runs check-logic.mjs on it.
//
// Alternative: node scripts/fetch-survey.mjs <username> <password> <numericSurveyId>

import { writeFileSync } from "fs"
import { execSync } from "child_process"
import { fileURLToPath } from "url"
import { dirname, join } from "path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)

let data

if (args.length === 1) {
  // Direct Tally fetch by form ID (e.g. xX4oQ5)
  const tallyId = args[0]
  console.log(`Fetching Tally form ${tallyId} directly...`)

  const urls = [
    `https://tally.so/api/forms/${tallyId}`,
    `https://api.tally.so/v1/forms/${tallyId}`,
  ]

  let lastErr
  for (const url of urls) {
    try {
      console.log(`  Trying ${url}`)
      const res = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0",
        },
      })
      const text = await res.text()
      if (!res.ok) { lastErr = new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`); continue }
      data = JSON.parse(text)
      console.log(`  OK — status ${res.status}`)
      break
    } catch (e) { lastErr = e }
  }
  if (!data) throw lastErr

} else if (args.length === 3) {
  // Backend login + fetch
  const [username, password, surveyIdArg] = args
  const API_BASE = "https://offline.prosurvey.uz"

  async function req(endpoint, options = {}) {
    const res = await fetch(`${API_BASE}${endpoint}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "ngrok-skip-browser-warning": "true",
        ...(options.headers || {}),
      },
    })
    if (!res.ok) { const t = await res.text(); throw new Error(`HTTP ${res.status}: ${t.slice(0, 200)}`) }
    return res.json()
  }

  console.log("1. Logging in...")
  const auth = await req("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) })
  const token = auth.access_token || auth.token
  if (!token) throw new Error("No token: " + JSON.stringify(auth).slice(0, 200))
  console.log("   OK")

  console.log(`2. Fetching survey ${surveyIdArg}...`)
  data = await req(`/api/webhooks/tally/surveys/${surveyIdArg}/questions`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  console.log("   OK, blocks:", data?.blocks?.length ?? "?")

} else {
  console.error("Usage:")
  console.error("  node scripts/fetch-survey.mjs xX4oQ5")
  console.error("  node scripts/fetch-survey.mjs <username> <password> <surveyId>")
  process.exit(1)
}

const outPath = join(__dirname, "survey-data.json")
writeFileSync(outPath, JSON.stringify(data, null, 2), "utf-8")
console.log(`Saved to ${outPath}`)

console.log("\n=== Running check-logic ===\n")
execSync(`node "${join(__dirname, "check-logic.mjs")}" "${outPath}"`, { stdio: "inherit" })
