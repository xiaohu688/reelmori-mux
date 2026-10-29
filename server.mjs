// 最小合轨服务：接两个 URL，用 ffmpeg 合轨，上传到 EvoLink 文件服务，返回公网 URL。
// 契约（来自 airapvideo src/server/jobs.ts）：
//   POST /mux { videoUrl, audioUrl, audioDurationSeconds, videoDurationSeconds, requireExactDuration, noShortest }
//   → { url, audioDurationSeconds, videoDurationSeconds, durationDeltaSeconds }
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const PORT = Number(process.env.PORT || 8080)
const HOST = process.env.HOST || '0.0.0.0'
const TOKEN = process.env.MUX_TOKEN || ''
const EVOLINK_KEY = process.env.EVOLINK_API_KEY || ''
const MAX_DELTA = 0.15

const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }

async function download(url, path) {
  const res = await fetch(url, { headers: UA })
  if (!res.ok) throw new Error(`download ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length < 1024) throw new Error('downloaded file too small')
  await (await import('node:fs/promises')).writeFile(path, buf)
  return path
}

async function probe(file, entry) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', entry, '-of', 'csv=p=0', file])
  return Number(stdout.trim().split('\n')[0])
}

async function uploadToEvolink(file) {
  if (!EVOLINK_KEY) throw new Error('EVOLINK_API_KEY missing (needed to host the result)')
  const b64 = (await readFile(file)).toString('base64')
  const res = await fetch('https://files-api.evolink.ai/api/v1/files/upload/base64', {
    method: 'POST',
    headers: { ...UA, Authorization: `Bearer ${EVOLINK_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ base64_data: `data:video/mp4;base64,${b64}` }),
  })
  const body = await res.json().catch(() => ({}))
  const url = body?.data?.file_url
  if (!res.ok || !url) throw new Error(`upload failed ${res.status} ${JSON.stringify(body).slice(0, 160)}`)
  return url
}

const server = createServer(async (req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(obj))
  }
  if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true })

  if (req.method !== 'POST' || !req.url.startsWith('/mux')) return send(404, { error: 'not_found' })
  if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'unauthorized' })

  let raw = ''
  for await (const chunk of req) raw += chunk
  let body
  try { body = JSON.parse(raw) } catch { return send(400, { error: 'invalid_json' }) }

  const { videoUrl, audioUrl } = body || {}
  if (!videoUrl || !audioUrl) return send(400, { error: 'videoUrl_audioUrl_required' })

  const dir = await mkdtemp(join(tmpdir(), 'mux-'))
  try {
    const vPath = join(dir, 'video.mp4')
    const aPath = join(dir, 'audio.mp3')
    const outPath = join(dir, 'out.mp4')
    await Promise.all([download(videoUrl, vPath), download(audioUrl, aPath)])

    const vDur = await probe(vPath, 'format=duration')
    const aDur = await probe(aPath, 'format=duration')
    const target = Math.min(vDur, aDur) === aDur ? aDur : vDur

    // 不加 -shortest：按较短者对齐，另一条用 -t 截到同一长度，避免半句话被切在末尾之外
    await run('ffmpeg', [
      '-y', '-v', 'error',
      '-i', vPath, '-i', aPath,
      '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k',
      '-t', String(Math.min(vDur, aDur).toFixed(3)),
      outPath,
    ])

    const outDur = await probe(outPath, 'format=duration')
    const delta = Math.abs(outDur - Math.min(vDur, aDur))
    if (body.requireExactDuration && delta > MAX_DELTA) {
      return send(422, { error: 'duration_mismatch', durationDeltaSeconds: delta })
    }
    const url = await uploadToEvolink(outPath)
    return send(200, {
      url,
      outputUrl: url,
      audioDurationSeconds: aDur,
      videoDurationSeconds: vDur,
      durationDeltaSeconds: delta,
    })
  } catch (error) {
    return send(500, { error: String(error && error.message || error) })
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

server.listen(PORT, HOST, () => console.log(`mux service on http://${HOST}:${PORT}`))

