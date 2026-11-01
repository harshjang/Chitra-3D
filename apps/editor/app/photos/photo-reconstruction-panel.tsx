'use client'
import {
  type AnyNodeId,
  applyStructureReconciliation,
  BuildingNode,
  emitter,
  generateId,
  LevelNode,
  runAsSingleSceneHistoryStep,
  SiteNode,
  SpawnNode,
  useScene,
} from '@pascal-app/core'
import { executePhotoScenePlan, parsePhotoScenePlan } from '@pascal-app/core/agent-operations'
import { applySceneGraphToEditor, getSavedSceneDocument } from '@pascal-app/editor'
import { CATALOG_ITEMS } from '@pascal-app/editor/catalog'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'

type Capture = { id: string; file: File; preview: string }
type Room = {
  name?: string
  polygon?: Array<[number, number]>
  wallHeight?: number
  wallThickness?: number
  doors?: Array<Record<string, unknown>>
  windows?: Array<Record<string, unknown>>
  objects?: Array<{
    id: string
    objectType: string
    category: string
    dimensions: [number, number, number]
    position: [number, number]
    yaw: number
    confidence: number
    [key: string]: unknown
  }>
  [key: string]: unknown
}
type Result = {
  plan?: { rooms?: Room[]; [key: string]: unknown }
  roomAssessments?: Array<{
    roomName?: string
    confidence?: number
    evidenceImageIds?: string[]
    uncertainties?: string[]
  }>
  warnings?: string[]
  [key: string]: unknown
}
type ApiResponse = { ok?: boolean; result?: Result; error?: string }

const MAX_IMAGES = 6
const MAX_BYTES = 2 * 1024 * 1024
const ACCEPTED = new Set(['image/jpeg', 'image/png', 'image/webp'])

async function prepareImage(file: File): Promise<File> {
  if (!ACCEPTED.has(file.type))
    throw new Error(`${file.name}: use JPG, PNG, or WebP. Convert HEIC photos first.`)
  if (file.size <= MAX_BYTES) return file
  const bitmap = await createImageBitmap(file)
  try {
    const scale = Math.min(1, 1600 / bitmap.width, 1200 / bitmap.height)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not prepare image for upload.')
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    let quality = 0.86
    let blob: Blob | null = null
    for (let i = 0; i < 6; i++) {
      blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', quality),
      )
      if (blob && blob.size <= MAX_BYTES) break
      quality -= 0.12
    }
    if (!blob || blob.size > MAX_BYTES)
      throw new Error(`${file.name}: could not resize below 2 MiB.`)
    return new File([blob], file.name.replace(/\.[^.]+$/, '.jpg'), {
      type: 'image/jpeg',
      lastModified: file.lastModified,
    })
  } finally {
    bitmap.close()
  }
}
function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`))
    reader.onload = () => {
      const value = String(reader.result ?? '')
      const comma = value.indexOf(',')
      if (comma < 0) reject(new Error(`Could not encode ${file.name}.`))
      else resolve(value.slice(comma + 1))
    }
    reader.readAsDataURL(file)
  })
}
function sizeLabel(n: number) {
  return n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(2)} MB`
}

/** Extra turn added to the entrance spawn's facing, in radians. 0 faces into the room. */
const SPAWN_YAW_OFFSET = 0

/**
 * A spawn point just outside the room's first door, looking in, so a walkthrough starts at the
 * entrance. The outline is counter-clockwise, so the room lies to the left of each wall and the
 * outside to the right. The walkthrough camera is a standard Three.js camera built from this yaw,
 * so yaw 0 looks along -Z and yaw t looks along (-sin t, -cos t).
 */
function doorEntrySpawn(room: {
  polygon: Array<[number, number]>
  doors?: Array<{ wallIndex: number; distanceAlongWall: number; width: number }>
}): { position: [number, number, number]; rotation: number } | null {
  const door = room.doors?.[0]
  if (!door) return null
  const a = room.polygon[door.wallIndex]
  const b = room.polygon[(door.wallIndex + 1) % room.polygon.length]
  if (!a || !b) return null
  const length = Math.hypot(b[0] - a[0], b[1] - a[1])
  if (!length) return null
  const dx = (b[0] - a[0]) / length
  const dz = (b[1] - a[1]) / length
  const outward: [number, number] = [dz, -dx]
  const reach = Math.max(1.2, door.width + 0.4)
  const cx = a[0] + dx * door.distanceAlongWall
  const cz = a[1] + dz * door.distanceAlongWall
  return {
    position: [cx + outward[0] * reach, 0, cz + outward[1] * reach],
    // Look back through the door: along -outward, which is yaw atan2(outwardX, outwardZ).
    rotation: Math.atan2(outward[0], outward[1]) + SPAWN_YAW_OFFSET,
  }
}

/** Download the furniture models now, so the 3D view opens with everything already available. */
async function preloadModels(
  urls: string[],
  onProgress: (done: number, total: number) => void,
): Promise<string[]> {
  const failed: string[] = []
  let done = 0
  onProgress(0, urls.length)
  await Promise.all(
    urls.map(async (url) => {
      try {
        const response = await fetch(url, {
          cache: 'force-cache',
          signal: AbortSignal.timeout(45_000),
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        await response.arrayBuffer()
      } catch {
        failed.push(url)
      } finally {
        onProgress(++done, urls.length)
      }
    }),
  )
  return failed
}

function interiorPoint(polygon: Array<[number, number]>): [number, number] {
  const bounds = polygon.reduce(
    (b, [x, z]) => ({
      minX: Math.min(b.minX, x),
      maxX: Math.max(b.maxX, x),
      minZ: Math.min(b.minZ, z),
      maxZ: Math.max(b.maxZ, z),
    }),
    { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity },
  )
  const contains = (x: number, z: number) => {
    let inside = false
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const [xi, zi] = polygon[i]!,
        [xj, zj] = polygon[j]!
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside
    }
    return inside
  }
  const x = polygon.reduce((sum, point) => sum + point[0], 0) / polygon.length
  const z = polygon.reduce((sum, point) => sum + point[1], 0) / polygon.length
  if (contains(x, z)) return [x, z]
  for (let row = 1; row <= 20; row++)
    for (let col = 1; col <= 20; col++) {
      const px = bounds.minX + ((bounds.maxX - bounds.minX) * col) / 21
      const pz = bounds.minZ + ((bounds.maxZ - bounds.minZ) * row) / 21
      if (contains(px, pz)) return [px, pz]
    }
  throw new Error('Could not find a safe interior spawn position for the inferred room.')
}

function getValidLevelIds(graph: unknown): string[] {
  if (!graph || typeof graph !== 'object') return []
  const value = graph as { nodes?: Record<string, any>; rootNodeIds?: unknown }
  if (!value.nodes || !Array.isArray(value.rootNodeIds)) return []

  const reachable = new Set<string>()
  const visit = (id: unknown) => {
    if (typeof id !== 'string' || reachable.has(id)) return
    const node = value.nodes?.[id]
    if (!node || node.id !== id) return
    reachable.add(id)
    if (Array.isArray(node.children)) node.children.forEach(visit)
  }
  value.rootNodeIds.forEach(visit)

  return Object.entries(value.nodes)
    .filter(([id, node]) => {
      if (!reachable.has(id) || node?.type !== 'level' || node.id !== id) return false
      const parent = typeof node.parentId === 'string' ? value.nodes?.[node.parentId] : null
      return parent?.type === 'building' && parent.children?.includes(id)
    })
    .map(([id]) => id)
}

/** Change the product name for this page here. */
const BRAND = { name: 'Chitra', tagline: 'Photos to 3D room' }

const STEPS = [
  { id: 'preparing', label: 'Preparing photos' },
  {
    id: 'analyzing',
    label: 'Reading the room',
    hint: 'Finding walls, doors, windows and furniture.',
  },
  { id: 'building', label: 'Building walls and furniture' },
  {
    id: 'models',
    label: 'Loading furniture models',
    hint: 'Getting every piece ready before the 3D view opens.',
  },
  { id: 'saving', label: 'Saving your project' },
] as const

type Stage = 'idle' | (typeof STEPS)[number]['id'] | 'done' | 'ready' | 'error'
type Outcome = {
  url: string
  placed: number
  skipped: {
    id: string
    category: string
    objectType: string
    room: string
    reason: string
    detail?: string
  }[]
  modelWarnings: string[]
}
type Failure = { phase: 'analyze' | 'apply'; message: string }

const MEASUREMENT_PRESETS = ['Door width', 'Ceiling height', 'Window width']

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function clock(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function span(values: number[]) {
  return Math.max(...values) - Math.min(...values)
}

/** What the model found, in the words a person would use. */
function summarize(result: Result | null) {
  const rooms = result?.plan?.rooms ?? []
  const first = rooms[0]
  const size = first?.polygon?.length
    ? `${span(first.polygon.map(([x]) => x)).toFixed(2)} × ${span(first.polygon.map(([, z]) => z)).toFixed(2)} m`
    : null
  const count = (pick: (room: Room) => number) => rooms.reduce((sum, room) => sum + pick(room), 0)
  return {
    rooms: rooms.length,
    name: first?.name,
    size,
    objects: count((room) => room.objects?.length ?? 0),
    doors: count((room) => room.doors?.length ?? 0),
    windows: count((room) => room.windows?.length ?? 0),
  }
}

function Logo({ size = 32 }: { size?: number }) {
  return (
    <span className="cs-logo" style={{ width: size, height: size }} aria-hidden="true">
      <svg
        viewBox="0 0 24 24"
        width={Math.round(size * 0.66)}
        height={Math.round(size * 0.66)}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" />
        <path d="M12 7.5l4 2.3v4.4l-4 2.3-4-2.3V9.8z" />
        <path d="M12 12l-4-2.2M12 12l4-2.2M12 12v4.5" />
      </svg>
    </span>
  )
}

const icon = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const

const IconUpload = () => (
  <svg {...icon} width={22} height={22}>
    <path d="M12 16V5M7.5 9.5 12 5l4.5 4.5M5 19h14" />
  </svg>
)
const IconX = () => (
  <svg {...icon} width={14} height={14} strokeWidth={2.2}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
)
const IconCheck = () => (
  <svg {...icon} width={12} height={12} strokeWidth={3}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
)
const IconAlert = () => (
  <svg {...icon}>
    <path d="M12 4 3 20h18L12 4zM12 10v4.5M12 17.5v.01" />
  </svg>
)

/**
 * All colours live in the first rule. Point them at the editor's own tokens
 * (for example var(--background)) to follow its theme exactly.
 */
const CSS = `
.chitra{--bg:#141414;--panel:#1b1b1c;--raised:#252526;--line:rgba(255,255,255,.09);--line-2:rgba(255,255,255,.18);
--text:#ececec;--muted:#a1a1a6;--faint:#6f6f75;--accent:#8ab4ff;--accent-ink:#0d1626;--danger:#ff8a8a;--ok:#7ddfa8;
min-height:100vh;background:var(--bg);color:var(--text);font-family:inherit;line-height:1.5;-webkit-font-smoothing:antialiased}
:where(.chitra) *,:where(.chitra) *::before,:where(.chitra) *::after{box-sizing:border-box}
:where(.chitra) :is(h1,h2,p,ul,ol,pre){margin:0;padding:0}
:where(.chitra) :is(ul,ol){list-style:none}
:where(.chitra) :is(button,input){font:inherit;color:inherit}
:where(.chitra) a{color:inherit;text-decoration:none}

.cs-top{position:sticky;top:0;z-index:10;display:flex;align-items:center;justify-content:space-between;height:56px;padding:0 20px;
background:rgba(20,20,20,.88);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.cs-brand{display:flex;align-items:center;gap:10px}
.cs-brand-name,.cs-brand-tag,.cs-step-label,.cs-step-hint{display:block}
.cs-brand-name{font-size:15px;font-weight:600;line-height:1.1}
.cs-brand-tag{font-size:12px;color:var(--muted);line-height:1.2;margin-top:2px}
.cs-logo{display:grid;place-items:center;border-radius:9px;background:var(--accent);color:var(--accent-ink);flex:none}

.cs-wrap{max-width:680px;margin:0 auto;padding:40px 20px 72px}
.cs-h1{font-size:clamp(26px,4.2vw,32px);font-weight:600;letter-spacing:-.015em;line-height:1.15}
.cs-lead{margin-top:10px;color:var(--muted);font-size:15px;max-width:52ch}

.cs-stack{display:grid;gap:16px;margin-top:28px}
.cs-card{padding:18px;background:var(--panel);border:1px solid var(--line);border-radius:14px}
.cs-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.cs-h2{font-size:15px;font-weight:600}
.cs-sub{font-size:13px;color:var(--muted)}
.cs-pill{font-size:12px;color:var(--muted);border:1px solid var(--line-2);border-radius:999px;padding:1px 9px}
.cs-note{margin-top:12px;font-size:13px;color:var(--muted)}
.cs-note.warn{color:#f0c674}
.cs-fine{font-size:12.5px;color:var(--faint);text-align:center}

.cs-drop{display:flex;flex-direction:column;align-items:center;gap:4px;width:100%;margin-top:14px;padding:30px 16px;text-align:center;
border:1.5px dashed var(--line-2);border-radius:12px;background:transparent;color:var(--muted);cursor:pointer;
transition:border-color .15s,background-color .15s,color .15s}
.cs-drop.compact{flex-direction:row;justify-content:center;gap:10px;padding:12px 16px}
.cs-drop:hover,.cs-drop.over{border-color:var(--accent);background:rgba(138,180,255,.06);color:var(--text)}
.cs-drop:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.cs-drop-title{font-size:14.5px;font-weight:600;color:var(--text)}

.cs-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:14px}
.cs-thumb{position:relative;aspect-ratio:4/3;overflow:hidden;border-radius:10px;border:1px solid var(--line);background:var(--raised)}
.cs-thumb img{display:block;width:100%;height:100%;object-fit:cover}
.cs-x{position:absolute;top:6px;right:6px;display:grid;place-items:center;width:26px;height:26px;border:0;border-radius:8px;
background:rgba(0,0,0,.66);color:#fff;cursor:pointer}
.cs-x:hover{background:#c0392b}
.cs-x:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.cs-idx{position:absolute;left:6px;bottom:6px;padding:1px 7px;border-radius:6px;background:rgba(0,0,0,.66);font-size:11.5px}

.cs-fields{display:grid;grid-template-columns:1fr 130px;gap:10px;margin-top:14px}
.cs-label{display:block;margin-bottom:6px;font-size:12.5px;color:var(--muted)}
.cs-input{width:100%;height:40px;padding:0 12px;border:1px solid var(--line-2);border-radius:10px;background:var(--bg);outline:none}
.cs-input::placeholder{color:var(--faint)}
.cs-input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(138,180,255,.18)}
.cs-chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.cs-chip{height:28px;padding:0 12px;border:1px solid var(--line-2);border-radius:999px;background:transparent;color:var(--muted);font-size:12.5px;cursor:pointer}
.cs-chip:hover{color:var(--text)}
.cs-chip[aria-pressed="true"]{color:var(--text);border-color:var(--accent);background:rgba(138,180,255,.1)}
.cs-chip:focus-visible{outline:2px solid var(--accent);outline-offset:2px}

.cs-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:44px;padding:0 20px;border:1px solid var(--line-2);
border-radius:11px;background:transparent;font-size:14.5px;font-weight:600;cursor:pointer}
.cs-btn:hover{background:rgba(255,255,255,.05)}
.cs-btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.cs-btn:disabled,.cs-btn-primary:disabled{background:var(--raised);color:var(--faint);border-color:var(--line);cursor:not-allowed}
.cs-btn-primary{background:#ececec;color:#141414;border-color:transparent}
.cs-btn-primary:hover{background:#fff}
.cs-btn-sm{height:34px;padding:0 14px;font-size:13px;font-weight:500}
.cs-cta{display:flex;flex-direction:column;gap:12px;margin-top:20px}

.cs-run-head{display:flex;align-items:center;gap:16px}
.cs-mark{position:relative;display:grid;place-items:center;width:64px;height:64px;overflow:hidden;border-radius:16px;background:var(--accent);color:var(--accent-ink);flex:none}
.cs-mark .cs-logo{background:transparent}
.cs-scan{position:absolute;left:0;right:0;top:-40%;height:40%;background:linear-gradient(to bottom,transparent,rgba(255,255,255,.65),transparent);animation:cs-scan 1.9s ease-in-out infinite}
.cs-run-title{font-size:18px;font-weight:600}
.cs-bar{height:4px;margin-top:20px;overflow:hidden;border-radius:4px;background:var(--raised)}
.cs-bar i{display:block;height:100%;border-radius:4px;background:var(--accent);transition:width .6s ease}
.cs-steps{display:grid;gap:14px;margin-top:20px}
.cs-step{display:flex;gap:12px;align-items:flex-start;color:var(--faint)}
.cs-step.active{color:var(--text)}
.cs-step.done{color:var(--muted)}
.cs-step-label{font-size:14.5px;line-height:22px}
.cs-step-hint{margin-top:1px;font-size:12.5px;color:var(--muted)}
.cs-dot{display:grid;place-items:center;width:22px;height:22px;border:1.5px solid var(--line-2);border-radius:50%;flex:none}
.cs-step.active .cs-dot{border-color:var(--line-2);border-top-color:var(--accent);animation:cs-spin .8s linear infinite}
.cs-step.done .cs-dot{border-color:transparent;background:var(--accent);color:var(--accent-ink)}
.cs-found{margin-top:20px;padding:12px 14px;border-radius:10px;background:var(--raised);font-size:13.5px}
.cs-found strong{font-weight:600}
.cs-found span{display:block;margin-top:2px;color:var(--muted)}
.cs-left{display:grid;gap:6px;margin-top:10px}
.cs-left li{display:flex;flex-wrap:wrap;gap:4px 10px;font-size:13px}
.cs-left b{font-weight:600}
.cs-left i{font-style:normal;color:var(--muted)}
.cs-why{margin-top:12px}
.cs-why summary{cursor:pointer;font-size:12.5px;color:var(--muted)}
.cs-why .cs-mono{margin-top:8px}
.cs-strip{display:flex;gap:6px;margin-top:20px}
.cs-strip img{display:block;width:46px;height:34px;object-fit:cover;border-radius:6px;border:1px solid var(--line)}

.cs-error{border-color:rgba(255,138,138,.4);background:rgba(255,138,138,.06)}
.cs-err-head{display:flex;align-items:center;gap:8px;color:var(--danger)}
.cs-err-head .cs-h2{color:var(--text)}
.cs-err-text{margin-top:8px;font-size:14px;color:var(--muted)}
.cs-mono{margin-top:12px;padding:10px 12px;border-radius:8px;background:rgba(0,0,0,.28);font:12.5px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-word}
.cs-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:14px}

@keyframes cs-scan{0%{top:-40%}100%{top:100%}}
@keyframes cs-spin{to{transform:rotate(360deg)}}
@media (max-width:520px){
  .cs-top{padding:0 14px}
  .cs-wrap{padding:28px 14px 56px}
  .cs-grid{grid-template-columns:repeat(2,1fr)}
  .cs-fields{grid-template-columns:1fr}
}
@media (prefers-reduced-motion:reduce){
  .chitra *{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}
}
`

export function PhotoReconstructionPanel() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const projectId = searchParams.get('projectId')
  const [projectLoading, setProjectLoading] = useState(false)
  const [projectLoaded, setProjectLoaded] = useState(false)
  const [, setProjectLevelIds] = useState<string[]>([])
  const [projectError, setProjectError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const [captures, setCaptures] = useState<Capture[]>([])
  const capturesRef = useRef<Capture[]>([])
  capturesRef.current = captures
  const [measurementDescription, setMeasurementDescription] = useState('')
  const [measurementMetres, setMeasurementMetres] = useState('')
  const [stage, setStage] = useState<Stage>('idle')
  const [detail, setDetail] = useState('')
  const [notice, setNotice] = useState('')
  const [failure, setFailure] = useState<Failure | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const applyingRef = useRef(false)
  const runningRef = useRef(false)
  const running = stage !== 'idle' && stage !== 'error' && stage !== 'ready'

  // Elapsed time makes the long AI step feel alive instead of frozen.
  useEffect(() => {
    if (!running) return
    const startedAt = Date.now()
    setElapsed(0)
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [running])

  // Release preview URLs when leaving the page.
  useEffect(
    () => () => {
      for (const capture of capturesRef.current) URL.revokeObjectURL(capture.preview)
    },
    [],
  )

  function fail(phase: Failure['phase'], error: unknown, fallback: string) {
    const raw = error instanceof Error ? error.message : fallback
    setFailure({
      phase,
      message: phase === 'apply' && raw.includes('timed out') ? `${raw} Try again.` : raw,
    })
    setDetail('')
    setStage('error')
  }

  useEffect(() => {
    let cancelled = false
    setProjectLoading(Boolean(projectId))
    setProjectLoaded(false)
    setProjectLevelIds([])
    setProjectError('')
    if (!projectId) return
    fetch(`/api/scenes/${encodeURIComponent(projectId)}`)
      .then(async (response) => {
        const scene = await response.json()
        if (!response.ok || !scene?.graph || typeof scene.version !== 'number') {
          throw new Error(scene?.error ?? `Could not load project (${response.status}).`)
        }
        const graphLevelIds = getValidLevelIds(scene.graph)
        if (cancelled) return
        applySceneGraphToEditor(scene.graph)
        const hydratedNodes = useScene.getState().nodes
        const hydratedLevelIds = graphLevelIds.filter(
          (id) =>
            hydratedNodes[id as AnyNodeId]?.type === 'level' &&
            hydratedNodes[id as AnyNodeId]?.id === id,
        )
        if (!scene.graph.rootNodeIds.every((id: string) => hydratedNodes[id as AnyNodeId])) {
          throw new Error(
            'The project scene did not hydrate completely. Reload the project before applying.',
          )
        }
        setProjectLevelIds(hydratedLevelIds)
        setProjectLoaded(true)
      })
      .catch((error) => {
        if (!cancelled)
          setProjectError(error instanceof Error ? error.message : 'Could not load project.')
      })
      .finally(() => {
        if (!cancelled) setProjectLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [projectId])

  const addFiles = useCallback(
    async (list: FileList | File[]) => {
      setNotice('')
      const incoming = Array.from(list)
      const slots = MAX_IMAGES - captures.length
      if (slots <= 0) {
        setNotice('You can add up to six photos.')
        return
      }
      const added: Capture[] = []
      const messages: string[] = []
      for (const original of incoming.slice(0, slots)) {
        try {
          const file = await prepareImage(original)
          added.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2)}-${added.length}`,
            file,
            preview: URL.createObjectURL(file),
          })
        } catch (e) {
          messages.push(e instanceof Error ? e.message : `${original.name}: could not be used.`)
        }
      }
      if (incoming.length > slots)
        messages.push(`Only ${plural(slots, 'more photo')} fit. The limit is six.`)
      if (messages.length) setNotice(messages.join(' '))
      if (added.length) {
        setCaptures((old) => [...old, ...added])
        setResult(null)
        setFailure(null)
        setStage('idle')
      }
    },
    [captures.length],
  )

  function removeCapture(id: string) {
    setCaptures((old) => {
      const target = old.find((x) => x.id === id)
      if (target) URL.revokeObjectURL(target.preview)
      return old.filter((x) => x.id !== id)
    })
    setResult(null)
    setFailure(null)
    setNotice('')
    setStage('idle')
  }

  const measurement =
    measurementDescription.trim() && Number(measurementMetres) > 0
      ? { description: measurementDescription.trim(), metres: Number(measurementMetres) }
      : null

  async function analyze() {
    if (!captures.length || runningRef.current) return
    runningRef.current = true
    setNotice('')
    setFailure(null)
    setResult(null)
    setOutcome(null)
    setDetail('')
    setStage('preparing')
    try {
      const ordered = captures.map((capture, sequenceIndex) => ({ capture, sequenceIndex }))
      const images = await Promise.all(
        ordered.map(async ({ capture, sequenceIndex }) => ({
          captureId: capture.id,
          sequenceIndex,
          mimeType: capture.file.type,
          base64: await toBase64(capture.file),
        })),
      )
      const manifest = {
        version: 1,
        purpose: 'rgb-spatial-reconstruction',
        images: ordered.map(({ capture, sequenceIndex }) => ({
          id: capture.id,
          fileName: capture.file.name,
          mimeType: capture.file.type,
          byteSize: capture.file.size,
          sequenceIndex,
          modality: 'rgb',
        })),
      }
      setStage('analyzing')
      const res = await fetch('/api/photo-scene-inference', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          manifest,
          images,
          ...(measurement ? { knownMeasurement: measurement } : {}),
        }),
      })
      const data = (await res.json().catch(() => ({}))) as ApiResponse
      if (!res.ok || !data.ok || !data.result)
        throw new Error(
          data.error || `Inference failed (HTTP ${res.status}). Check the editor terminal.`,
        )
      setResult(data.result)
      await applyToEditor(data.result)
    } catch (e) {
      fail('analyze', e, 'Photo analysis failed.')
    } finally {
      runningRef.current = false
    }
  }

  /** Retry only the step that failed: an apply failure reuses the plan instead of calling the AI again. */
  function retry() {
    if (failure?.phase === 'apply' && result) void applyToEditor(result)
    else void analyze()
  }

  function startOver() {
    setOutcome(null)
    setResult(null)
    setFailure(null)
    setStage('idle')
  }

  function downloadPlan() {
    if (!result) return
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }),
    )
    const a = document.createElement('a')
    a.href = url
    a.download = 'chitra-room-plan.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  async function applyToEditor(planResult: Result | null = result) {
    if (!planResult || applyingRef.current) return
    setFailure(null)
    setDetail('')
    setStage('building')

    if (!planResult.plan?.rooms?.length) {
      fail(
        'apply',
        null,
        'The photos did not produce any rooms. Try clearer photos from different corners.',
      )
      return
    }

    let parsedPlan
    try {
      parsedPlan = parsePhotoScenePlan(planResult.plan)
    } catch (error) {
      fail('apply', error, 'The inferred plan is invalid.')
      return
    }

    applyingRef.current = true
    try {
      let targetProjectId = projectId
      if (!targetProjectId) {
        setDetail('Creating a project…')
        const created = await fetch('/api/scenes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Photo reconstruction',
            graph: { nodes: {}, rootNodeIds: [] },
          }),
        })
        const meta = await created.json()
        if (!created.ok || typeof meta.id !== 'string')
          throw new Error(meta.error ?? `Could not create project (${created.status}).`)
        targetProjectId = meta.id
      }
      if (!targetProjectId) throw new Error('Could not establish a destination project.')
      const destinationId = targetProjectId
      setDetail('Opening the project…')
      const loaded = await fetch(`/api/scenes/${encodeURIComponent(destinationId)}`, {
        signal: AbortSignal.timeout(30_000),
      })
      const document = await loaded.json()
      if (!loaded.ok || !document.graph || typeof document.version !== 'number')
        throw new Error(document.error ?? `Could not load project (${loaded.status}).`)
      let version = document.version
      let graph: any = document.graph
      const nodes: Record<string, any> = { ...(graph.nodes ?? {}) }
      const reachable = new Set<string>()
      const visit = (id: string) => {
        const node = nodes[id]
        if (!node || reachable.has(id)) return
        reachable.add(id)
        for (const child of node.children ?? []) visit(child)
      }
      for (const id of graph.rootNodeIds ?? []) visit(id)
      let building = Object.values(nodes).find(
        (node: any) => reachable.has(node.id) && node.type === 'building',
      ) as any
      let level = building
        ? (building.children ?? [])
            .map((id: string) => nodes[id])
            .find((node: any) => node?.type === 'level')
        : null
      if (!building) {
        const siteId = generateId('site'),
          buildingId = generateId('building'),
          levelId = generateId('level')
        nodes[siteId] = SiteNode.parse({ id: siteId, children: [buildingId] })
        building = BuildingNode.parse({ id: buildingId, parentId: siteId, children: [levelId] })
        level = LevelNode.parse({
          id: levelId,
          parentId: buildingId,
          level: 0,
          height: Math.max(...parsedPlan.rooms.map((room) => room.wallHeight)),
          children: [],
        })
        nodes[buildingId] = building
        nodes[levelId] = level
        graph.rootNodeIds = [...(graph.rootNodeIds ?? []), siteId]
      } else if (!level) {
        const levelId = generateId('level')
        level = LevelNode.parse({
          id: levelId,
          parentId: building.id,
          level: 0,
          height: Math.max(...parsedPlan.rooms.map((room) => room.wallHeight)),
          children: [],
        })
        nodes[levelId] = level
        building = { ...building, children: [...(building.children ?? []), levelId] }
        nodes[building.id] = building
      }
      const levelId = level.id as string
      applySceneGraphToEditor({ ...graph, nodes })
      const state = useScene.getState()
      if (state.readOnly) throw new Error('The current scene is read-only.')
      const targetLevel = useScene.getState().nodes[levelId as AnyNodeId] as any
      if (targetLevel?.type !== 'level')
        throw new Error('Destination level did not load correctly.')
      const hasSpawn = (targetLevel.children ?? []).some(
        (id: string) => (useScene.getState().nodes[id as AnyNodeId] as any)?.type === 'spawn',
      )

      const beforeNodes = state.nodes
      const context = {
        activeLevelId: levelId as AnyNodeId,
        materials: state.materials,
        catalog: CATALOG_ITEMS,
      }

      let execution: ReturnType<typeof executePhotoScenePlan> | undefined

      runAsSingleSceneHistoryStep(useScene, () => {
        const runtime = {
          getNodes: () => useScene.getState().nodes,
          applyChanges: (changes: any) => {
            const store = useScene.getState()
            if (changes.materials?.length) {
              for (const material of changes.materials) {
                store.addSceneMaterial(material)
              }
            }
            store.applyNodeChanges({
              create: (changes.create ?? []).map((item: any) => ({
                node: item.node,
                parentId: item.parentId,
              })),
              update: changes.update ?? [],
              delete: changes.delete ?? [],
            })
          },
          reconcile: () => {
            applyStructureReconciliation(useScene, {
              levelIds: [levelId as AnyNodeId],
              previousNodes: beforeNodes,
              mintId: (kind: string) => generateId(kind as never),
            })
          },
        }

        execution = executePhotoScenePlan(parsedPlan, levelId, context, runtime)
        if (!hasSpawn) {
          const entrance = doorEntrySpawn(parsedPlan.rooms[0]!)
          const [x, z] = interiorPoint(parsedPlan.rooms[0]!.polygon)
          useScene.getState().createNode(
            SpawnNode.parse({
              id: generateId('spawn'),
              parentId: levelId,
              position: entrance?.position ?? [x, 0, z],
              rotation: entrance?.rotation ?? 0,
            }) as never,
            levelId as AnyNodeId,
          )
        }
      })

      if (!execution?.ok || !execution.roomsCreated) {
        throw new Error('The plan did not create any rooms.')
      }
      const roomPoints = parsedPlan.rooms.flatMap((room) => room.polygon)
      const minX = Math.min(...roomPoints.map(([x]) => x))
      const maxX = Math.max(...roomPoints.map(([x]) => x))
      const minZ = Math.min(...roomPoints.map(([, z]) => z))
      const maxZ = Math.max(...roomPoints.map(([, z]) => z))
      emitter.emit('camera-controls:fit-scene', {
        bounds: {
          min: [minX, minZ],
          max: [maxX, maxZ],
          center: [(minX + maxX) / 2, (minZ + maxZ) / 2],
          size: [maxX - minX, maxZ - minZ],
        },
      })
      graph = getSavedSceneDocument()
      const serializedLevel = graph.nodes[levelId as AnyNodeId] as { type?: string } | undefined
      if (!graph.rootNodeIds.length || serializedLevel?.type !== 'level') {
        throw new Error(
          'The serialized scene is incomplete or no longer contains the target level. Reload before saving.',
        )
      }
      // Hold the processing window until every model file is here, so the 3D view opens complete.
      setStage('models')
      const failedModels = await preloadModels(execution.assetUrls ?? [], (done, total) =>
        setDetail(`${done} of ${total} loaded`),
      )
      setStage('saving')
      setDetail('')
      const response = await fetch(`/api/scenes/${encodeURIComponent(destinationId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'If-Match': String(version) },
        body: JSON.stringify({ graph }),
        signal: AbortSignal.timeout(30_000),
      })
      if (response.status === 409)
        throw new Error(
          'This project changed in another session. Reload the project before applying again.',
        )
      if (!response.ok) throw new Error(`Could not save the room plan (${response.status}).`)
      await response.json().catch(() => undefined)
      const destinationUrl = `/project/${encodeURIComponent(destinationId)}`
      const skipped = execution.objectsSkipped ?? []
      if (skipped.length || failedModels.length) {
        // Show what was left out, or could not be loaded, instead of redirecting past it.
        setOutcome({
          url: destinationUrl,
          placed: execution.objectsPlaced,
          skipped,
          modelWarnings: failedModels,
        })
        setStage('ready')
      } else {
        setStage('done')
        router.push(destinationUrl)
      }
    } catch (e) {
      fail('apply', e, 'Could not build the room in the editor.')
    } finally {
      applyingRef.current = false
    }
  }

  const summary = summarize(result)
  const stepIndex = stage === 'done' ? STEPS.length : STEPS.findIndex((step) => step.id === stage)
  const showFound =
    Boolean(result) && (stage === 'building' || stage === 'saving' || stage === 'done')
  const foundDetails = [
    summary.objects ? plural(summary.objects, 'furniture item') : '',
    summary.doors ? plural(summary.doors, 'door') : '',
    summary.windows ? plural(summary.windows, 'window') : '',
  ].filter(Boolean)
  const halfFilled = Boolean(measurementDescription.trim()) !== Number(measurementMetres) > 0

  return (
    <main className="chitra">
      <style>{CSS}</style>

      <header className="cs-top">
        <Link href="/" className="cs-brand" aria-label={`${BRAND.name}, back to the editor`}>
          <Logo />
          <span>
            <span className="cs-brand-name">{BRAND.name}</span>
            <span className="cs-brand-tag">{BRAND.tagline}</span>
          </span>
        </Link>
        <Link href="/" className="cs-btn cs-btn-sm">
          Back to editor
        </Link>
      </header>

      <div className="cs-wrap">
        <h1 className="cs-h1">Turn room photos into a 3D room</h1>
        <p className="cs-lead">
          Add a few photos of one room. {BRAND.name} builds editable walls, doors, windows and
          furniture you can adjust in the editor.
        </p>

        {projectId && projectLoading && <p className="cs-note">Opening your project…</p>}
        {projectId && projectLoaded && (
          <p className="cs-note">The room will be added to your open project.</p>
        )}
        {projectId && projectError && (
          <p className="cs-note warn" role="alert">
            Could not open the project: {projectError} The room will be saved to a new project
            instead.
          </p>
        )}

        <div className="cs-stack">
          {running ? (
            <section className="cs-card" aria-live="polite" aria-busy="true">
              <div className="cs-run-head">
                <div className="cs-mark" aria-hidden="true">
                  <Logo size={40} />
                  <span className="cs-scan" />
                </div>
                <div>
                  <h2 className="cs-run-title">
                    {stage === 'done' ? 'Room ready' : 'Building your room'}
                  </h2>
                  <p className="cs-sub">
                    {stage === 'done'
                      ? 'Opening the 3D editor…'
                      : `Usually about a minute. ${clock(elapsed)} elapsed.`}
                  </p>
                </div>
              </div>

              <div className="cs-bar" aria-hidden="true">
                <i
                  style={{ width: `${Math.min(100, ((stepIndex + 0.5) / STEPS.length) * 100)}%` }}
                />
              </div>

              <ol className="cs-steps">
                {STEPS.map((step, index) => {
                  const state = index < stepIndex ? 'done' : index === stepIndex ? 'active' : ''
                  const hint =
                    step.id === 'analyzing' && elapsed > 60
                      ? 'Still working. Rooms with lots of furniture can take a couple of minutes.'
                      : (step.id === 'building' || step.id === 'models') && detail
                        ? detail
                        : 'hint' in step
                          ? step.hint
                          : ''
                  return (
                    <li
                      key={step.id}
                      className={`cs-step ${state}`}
                      aria-current={state === 'active' ? 'step' : undefined}
                    >
                      <span className="cs-dot">{state === 'done' && <IconCheck />}</span>
                      <span>
                        <span className="cs-step-label">{step.label}</span>
                        {state === 'active' && hint && <span className="cs-step-hint">{hint}</span>}
                      </span>
                    </li>
                  )
                })}
              </ol>

              {showFound && (
                <div className="cs-found">
                  <strong>
                    Found {summary.name ?? 'a room'}
                    {summary.size ? `, ${summary.size}` : ''}
                  </strong>
                  {foundDetails.length > 0 && <span>{foundDetails.join(', ')}</span>}
                </div>
              )}

              <div className="cs-strip" aria-hidden="true">
                {captures.map((capture) => (
                  <img key={capture.id} src={capture.preview} alt="" />
                ))}
              </div>
            </section>
          ) : stage === 'ready' && outcome ? (
            <section className="cs-card" aria-live="polite">
              <div className="cs-run-head">
                <div className="cs-mark" aria-hidden="true">
                  <Logo size={40} />
                </div>
                <div>
                  <h2 className="cs-run-title">Your room is ready</h2>
                  <p className="cs-sub">
                    {summary.name ?? 'Room'}
                    {summary.size ? `, ${summary.size}` : ''}.{' '}
                    {plural(outcome.placed, 'furniture item')} placed.
                  </p>
                </div>
              </div>
              {outcome.skipped.length > 0 && (
                <div className="cs-found">
                  <strong>{plural(outcome.skipped.length, 'item')} left out of the 3D room</strong>
                  <ul className="cs-left">
                    {outcome.skipped.map((item) => (
                      <li key={item.id}>
                        <b>{item.objectType}</b>
                        <i>{item.reason}</i>
                      </li>
                    ))}
                  </ul>
                  <details className="cs-why">
                    <summary>Technical details</summary>
                    <pre className="cs-mono">
                      {outcome.skipped
                        .map((item) => `${item.id}: ${item.detail ?? item.reason}`)
                        .join('\n')}
                    </pre>
                  </details>
                </div>
              )}
              {outcome.modelWarnings.length > 0 && (
                <div className="cs-found">
                  <strong>
                    {plural(outcome.modelWarnings.length, 'model')} could not be loaded ahead of
                    time
                  </strong>
                  <span>
                    They may appear a little later in the editor:{' '}
                    {outcome.modelWarnings
                      .map((url) => url.split('/').slice(-2, -1)[0] ?? url)
                      .join(', ')}
                    .
                  </span>
                </div>
              )}
              <div className="cs-actions">
                <button
                  type="button"
                  className="cs-btn cs-btn-primary"
                  onClick={() => router.push(outcome.url)}
                >
                  Open 3D editor
                </button>
                <button type="button" className="cs-btn" onClick={startOver}>
                  Start over
                </button>
                {result && (
                  <button type="button" className="cs-btn" onClick={downloadPlan}>
                    Download plan
                  </button>
                )}
              </div>
            </section>
          ) : (
            <>
              {failure && (
                <section className="cs-card cs-error" role="alert">
                  <div className="cs-err-head">
                    <IconAlert />
                    <h2 className="cs-h2">
                      {failure.phase === 'analyze'
                        ? 'Couldn’t read the photos'
                        : 'Couldn’t build the room'}
                    </h2>
                  </div>
                  <p className="cs-err-text">
                    {failure.phase === 'analyze'
                      ? 'Check your connection and try again. Sharp photos from different corners also help.'
                      : 'The photos were read, but the room didn’t fit in the editor. Try again, or retake photos that show the whole room.'}
                  </p>
                  <pre className="cs-mono">{failure.message}</pre>
                  <div className="cs-actions">
                    <button type="button" className="cs-btn cs-btn-primary" onClick={retry}>
                      Try again
                    </button>
                    {result && (
                      <button type="button" className="cs-btn" onClick={downloadPlan}>
                        Download plan
                      </button>
                    )}
                  </div>
                </section>
              )}

              <section className="cs-card" aria-labelledby="cs-photos">
                <div className="cs-head">
                  <h2 className="cs-h2" id="cs-photos">
                    Photos
                  </h2>
                  <span className="cs-sub">
                    {captures.length} of {MAX_IMAGES}
                  </span>
                </div>

                {captures.length < MAX_IMAGES && (
                  <button
                    type="button"
                    className={`cs-drop${captures.length ? ' compact' : ''}${dragOver ? ' over' : ''}`}
                    onClick={() => inputRef.current?.click()}
                    onDragOver={(e) => {
                      e.preventDefault()
                      setDragOver(true)
                    }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={(e) => {
                      e.preventDefault()
                      setDragOver(false)
                      void addFiles(e.dataTransfer.files)
                    }}
                  >
                    <IconUpload />
                    <span className="cs-drop-title">
                      {captures.length ? 'Add more photos' : 'Drop photos here or choose files'}
                    </span>
                    {!captures.length && (
                      <span className="cs-sub">
                        JPG, PNG or WebP. Large photos are resized automatically.
                      </span>
                    )}
                  </button>
                )}
                <input
                  ref={inputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  multiple
                  hidden
                  onChange={(e) => {
                    if (e.target.files) void addFiles(e.target.files)
                    e.currentTarget.value = ''
                  }}
                />

                {captures.length > 0 && (
                  <div className="cs-grid">
                    {captures.map((capture, index) => (
                      <div key={capture.id} className="cs-thumb">
                        <img src={capture.preview} alt={`Room view ${index + 1}`} />
                        <button
                          type="button"
                          className="cs-x"
                          onClick={() => removeCapture(capture.id)}
                          aria-label={`Remove photo ${index + 1}`}
                        >
                          <IconX />
                        </button>
                        <span className="cs-idx">{index + 1}</span>
                      </div>
                    ))}
                  </div>
                )}

                {notice && (
                  <p className="cs-note warn" role="status">
                    {notice}
                  </p>
                )}
                <p className="cs-note">
                  Shoot from different corners and keep doors and windows in view.
                </p>
              </section>

              <section className="cs-card" aria-labelledby="cs-size">
                <div className="cs-head">
                  <h2 className="cs-h2" id="cs-size">
                    Real size
                  </h2>
                  <span className="cs-pill">Optional</span>
                </div>
                <p className="cs-sub" style={{ marginTop: 6 }}>
                  Photos alone can’t give exact sizes. One measurement you know sets the scale for
                  the whole room.
                </p>
                <div className="cs-chips">
                  {MEASUREMENT_PRESETS.map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      className="cs-chip"
                      aria-pressed={measurementDescription === preset}
                      onClick={() => setMeasurementDescription(preset)}
                    >
                      {preset}
                    </button>
                  ))}
                </div>
                <div className="cs-fields">
                  <label>
                    <span className="cs-label">What you measured</span>
                    <input
                      className="cs-input"
                      value={measurementDescription}
                      onChange={(e) => setMeasurementDescription(e.target.value)}
                      placeholder="e.g. Width of the main door"
                    />
                  </label>
                  <label>
                    <span className="cs-label">Length in metres</span>
                    <input
                      className="cs-input"
                      type="number"
                      min="0.01"
                      step="0.01"
                      inputMode="decimal"
                      value={measurementMetres}
                      onChange={(e) => setMeasurementMetres(e.target.value)}
                      placeholder="0.9"
                    />
                  </label>
                </div>
                {halfFilled && (
                  <p className="cs-note warn">Fill in both fields to use this measurement.</p>
                )}
              </section>

              <div className="cs-cta">
                <button
                  type="button"
                  className="cs-btn cs-btn-primary"
                  disabled={!captures.length}
                  onClick={() => void analyze()}
                >
                  Build 3D room
                </button>
                <p className="cs-fine">
                  Photos are sent to Gemini for analysis. Sizes are estimates, not surveyed
                  measurements.
                </p>
              </div>
            </>
          )}
        </div>
      </div>
    </main>
  )
}
