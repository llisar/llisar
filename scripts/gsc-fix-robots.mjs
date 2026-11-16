#!/usr/bin/env node
/**
 * From ServerJS: submit sitemap + inspect key URLs via Search Console API.
 *
 * Auth (one of):
 *   - GOOGLE_APPLICATION_CREDENTIALS / gcloud ADC
 *   - GSC_CLIENT_ID + GSC_CLIENT_SECRET + GSC_REFRESH_TOKEN
 *
 *   node scripts/gsc-fix-robots.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SITE = 'sc-domain:llisar.com'
const SITEMAP = 'https://llisar.com/sitemap.xml'
const PAGES = [
  'https://llisar.com/',
  'https://llisar.com/inmobiliarias',
  'https://llisar.com/turismo',
  'https://llisar.com/nosotros',
  'https://llisar.com/contacto',
  'https://llisar.com/blog',
  'https://llisar.com/blog/como-atender-leads-inmobiliaria-whatsapp',
  'https://llisar.com/blog/agente-ia-whatsapp-turismo-cuando-conviene',
  'https://llisar.com/blog/calificar-leads-inmobiliarios-whatsapp',
  'https://llisar.com/blog/agendar-visitas-desde-whatsapp',
  'https://llisar.com/blog/errores-atencion-whatsapp-inmobiliaria-turismo',
]

async function tokenFromRefresh() {
  const clientId = process.env.GSC_CLIENT_ID
  const clientSecret = process.env.GSC_CLIENT_SECRET
  const refreshToken = process.env.GSC_REFRESH_TOKEN
  if (!clientId || !clientSecret || !refreshToken) return null
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })
  const json = await res.json()
  if (!res.ok) throw new Error(`refresh token: ${JSON.stringify(json)}`)
  return json.access_token
}

function loadAdc() {
  const path =
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    join(homedir(), '.config/gcloud/application_default_credentials.json')
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8'))
}

async function tokenFromAdc(creds) {
  if (!creds || creds.type !== 'authorized_user') return null
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: creds.refresh_token,
      grant_type: 'refresh_token',
    }),
  })
  const json = await res.json()
  if (!res.ok) throw new Error(`ADC refresh: ${JSON.stringify(json)}`)
  return json.access_token
}

async function getAuth() {
  const fromEnv = await tokenFromRefresh()
  if (fromEnv) {
    return { accessToken: fromEnv, quotaProject: process.env.GOOGLE_CLOUD_PROJECT || null }
  }
  const creds = loadAdc()
  if (!creds) return null
  if (creds.type === 'service_account') {
    throw new Error(
      'Service account ADC needs JWT flow; use authorized_user or GSC_* refresh env',
    )
  }
  const accessToken = await tokenFromAdc(creds)
  return {
    accessToken,
    quotaProject: creds.quota_project_id || process.env.GOOGLE_CLOUD_PROJECT || null,
  }
}

async function gscFetch(auth, host, path, { method = 'GET', body } = {}) {
  const res = await fetch(`${host}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      ...(auth.quotaProject ? { 'x-goog-user-project': auth.quotaProject } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = { raw: text }
  }
  return { ok: res.ok, status: res.status, json }
}

async function main() {
  const auth = await getAuth()
  if (!auth?.accessToken) {
    console.error(
      'No GSC credentials. Set GSC_CLIENT_ID/SECRET/REFRESH_TOKEN or run gcloud ADC login.',
    )
    process.exit(1)
  }

  const sitePath = encodeURIComponent(SITE)
  const feedPath = encodeURIComponent(SITEMAP)
  const wm = 'https://www.googleapis.com'
  const sc = 'https://searchconsole.googleapis.com'

  console.log('Submitting sitemap', SITEMAP)
  const put = await gscFetch(auth, wm, `/webmasters/v3/sites/${sitePath}/sitemaps/${feedPath}`, {
    method: 'PUT',
  })
  console.log('sitemap:', put.status, put.ok ? 'ok' : put.json)

  const listed = await gscFetch(auth, wm, `/webmasters/v3/sites/${sitePath}/sitemaps`)
  console.log('sitemaps list:', listed.status)
  if (listed.json?.sitemap) {
    for (const s of listed.json.sitemap) {
      console.log('-', s.path, s.errors ?? 0, 'errors', s.warnings ?? 0, 'warnings')
    }
  }

  console.log('\nURL Inspection (robots / index state):')
  for (const url of PAGES) {
    const insp = await gscFetch(auth, sc, `/v1/urlInspection/index:inspect`, {
      method: 'POST',
      body: { inspectionUrl: url, siteUrl: SITE },
    })
    if (!insp.ok) {
      console.log('-', url, 'FAIL', insp.status, insp.json)
      continue
    }
    const i = insp.json?.inspectionResult?.indexStatusResult || {}
    const verdict = i.verdict || i.coverageState || '?'
    console.log(
      '-',
      url,
      '| robots:',
      i.robotsTxtState || '?',
      '|',
      verdict,
      '|',
      i.indexingState || '',
      '|',
      i.coverageState || '',
    )
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
