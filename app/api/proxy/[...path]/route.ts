import { type NextRequest, NextResponse } from "next/server"

export async function POST(request: NextRequest, { params }: { params: { path: string[] } }) {
  const endpoint = `/${params.path.join("/")}`

  const backendUrl = process.env.BACKEND_URL || process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"

  const url = `${backendUrl}${endpoint}`

  console.log("[v0] Proxying POST to:", url)

  const headers = new Headers(request.headers)
  headers.delete("host")

  try {
    const body = await request.text()
    const response = await fetch(url, {
      method: "POST",
      headers: headers,
      body: body,
    })

    const data = await response.text()

    return new NextResponse(data, {
      status: response.status,
      headers: {
        "Content-Type": response.headers.get("Content-Type") || "application/json",
      },
    })
  } catch (error) {
    console.error("[v0] Proxy error:", error)
    return NextResponse.json({ error: "Backend connection failed" }, { status: 503 })
  }
}

export async function GET(request: NextRequest, { params }: { params: { path: string[] } }) {
  const endpoint = `/${params.path.join("/")}`
  const backendUrl = process.env.BACKEND_URL || process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"

  const url = `${backendUrl}${endpoint}${request.nextUrl.search}`

  console.log("[v0] Proxying GET to:", url)

  const headers = new Headers(request.headers)
  headers.delete("host")

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: headers,
    })

    const data = await response.text()

    return new NextResponse(data, {
      status: response.status,
      headers: {
        "Content-Type": response.headers.get("Content-Type") || "application/json",
      },
    })
  } catch (error) {
    console.error("[v0] Proxy error:", error)
    return NextResponse.json({ error: "Backend connection failed" }, { status: 503 })
  }
}
