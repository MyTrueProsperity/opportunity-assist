const projects = [
  {
    name: "Opportunity Assist",
    url: "https://girldctsnrdvdoktzfrv.supabase.co",
    keyEnvironmentVariable: "OPPORTUNITY_SUPABASE_PUBLISHABLE_KEY",
  },
  {
    name: "Classroom Credit Score",
    url: "https://icsaliamhresfnaupfwt.supabase.co",
    keyEnvironmentVariable: "CCS_SUPABASE_PUBLISHABLE_KEY",
  },
]

async function queryHealthcheck(project) {
  const apiKey = process.env[project.keyEnvironmentVariable]

  if (!apiKey) {
    throw new Error(`Missing Netlify environment variable: ${project.keyEnvironmentVariable}`)
  }

  const response = await fetch(
    `${project.url}/rest/v1/healthcheck?select=id&limit=1`,
    {
      headers: {
        apikey: apiKey,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    },
  )

  const responseBody = await response.text()

  if (!response.ok) {
    throw new Error(
      `${project.name} returned HTTP ${response.status}: ${responseBody.slice(0, 300)}`,
    )
  }

  return {
    project: project.name,
    status: response.status,
    checkedAt: new Date().toISOString(),
  }
}

export default async () => {
  const results = await Promise.allSettled(projects.map(queryHealthcheck))

  const summary = results.map((result, index) => {
    if (result.status === "fulfilled") {
      return { ok: true, ...result.value }
    }

    return {
      ok: false,
      project: projects[index].name,
      error: result.reason instanceof Error ? result.reason.message : String(result.reason),
    }
  })

  console.log(JSON.stringify({ event: "supabase-healthcheck", results: summary }))

  const failures = summary.filter((result) => !result.ok)
  if (failures.length > 0) {
    throw new Error(
      `Supabase health check failed: ${failures.map((failure) => failure.project).join(", ")}`,
    )
  }
}

// Run three times per day. Netlify scheduled functions use UTC.
export const config = {
  schedule: "0 2,10,18 * * *",
}
