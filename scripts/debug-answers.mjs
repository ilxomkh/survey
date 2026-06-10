// Debug: show raw answer structure from API
const sessionId = process.argv[2]
const token = process.argv[3]

const API_BASE = "https://offline.prosurvey.uz"
const res = await fetch(`${API_BASE}/api/admin/sessions-full?limit=500`, {
  headers: { Authorization: `Bearer ${token}` }
})
const data = await res.json()
const sessions = Array.isArray(data) ? data : (data.sessions || data.items || [])
const sessionData = sessions.find(s => s.session_id === sessionId || s.id === sessionId)

console.log("Session top-level keys:", Object.keys(sessionData))
console.log("\nFirst 3 answers raw:")
const answers = sessionData.survey_answers || sessionData.answers || []
console.log(JSON.stringify(answers.slice(0, 3), null, 2))
