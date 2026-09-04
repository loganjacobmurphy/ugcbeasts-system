import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { useDB, store, uid } from '../lib/store'
import type { Board, BoardColor, BoardItem } from '../lib/types'
import { Icon } from '../components/icons'
import { LIME, LIME_DEEP, cx, tones, type Tone } from '../lib/tokens'

/**
 * A note's stored colour is a hue name, but the paint comes from the kit's tones
 * so the board cannot invent a palette of its own. The keys stay as they are
 * because they are persisted on every existing note.
 */
const NOTE_TONE: Record<BoardColor, Tone> = {
  yellow: 'yellow',
  pink: 'red',
  blue: 'mint',
  green: 'lime',
  purple: 'grey',
  orange: 'amber',
}
const noteBg = (c: BoardColor) => tones[NOTE_TONE[c]].bg
const COLOR_LIST = Object.keys(NOTE_TONE) as BoardColor[]
const STICKERS = ['🔥', '✅', '⭐', '💡', '❤️', '👍', '🎯', '🚀', '📈', '💪', '📌', '⚡', '🧠', '💰', '👀', '🙌']
const NOTE_W = 216
const TEXT_W = 240

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n))
}

function readAsDataURL(file: File) {
  return new Promise<string>((res, rej) => {
    const fr = new FileReader()
    fr.onload = () => res(fr.result as string)
    fr.onerror = rej
    fr.readAsDataURL(file)
  })
}
function loadImg(src: string) {
  return new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image()
    i.onload = () => res(i)
    i.onerror = rej
    i.src = src
  })
}
async function downscale(file: File, max = 900) {
  const dataUrl = await readAsDataURL(file)
  const img = await loadImg(dataUrl)
  const scale = Math.min(1, max / Math.max(img.width, img.height))
  if (scale >= 1) return { src: dataUrl, w: img.width, h: img.height }
  const c = document.createElement('canvas')
  c.width = Math.round(img.width * scale)
  c.height = Math.round(img.height * scale)
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
  return { src: c.toDataURL('image/jpeg', 0.75), w: c.width, h: c.height }
}

type Anchor = { cx: number; cy: number; w: number; h: number }
function edgePoint(a: Anchor, towardX: number, towardY: number) {
  const dx = towardX - a.cx
  const dy = towardY - a.cy
  if (dx === 0 && dy === 0) return { x: a.cx, y: a.cy }
  const hw = a.w / 2 + 6
  const hh = a.h / 2 + 6
  const sx = dx !== 0 ? hw / Math.abs(dx) : Infinity
  const sy = dy !== 0 ? hh / Math.abs(dy) : Infinity
  const s = Math.min(sx, sy)
  return { x: a.cx + dx * s, y: a.cy + dy * s }
}

type Interaction =
  | { type: 'pan'; sx: number; sy: number; vx: number; vy: number }
  | { type: 'drag'; id: string; sx: number; sy: number; ox: number; oy: number; curX: number; curY: number }
  | { type: 'resize'; id: string; sx: number; ow: number; oh: number; curW: number; curH: number }
  | null

export default function FixMyPosture() {
  const { board } = useDB()
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 })
  const [dragging, setDragging] = useState<{ id: string; x: number; y: number } | null>(null)
  const [resizing, setResizing] = useState<{ id: string; w: number; h: number } | null>(null)
  const [tool, setTool] = useState<'select' | 'arrow'>('select')
  const [arrowFrom, setArrowFrom] = useState<string | null>(null)
  const [selectedArrow, setSelectedArrow] = useState<string | null>(null)
  const [stickerOpen, setStickerOpen] = useState(false)
  const [focusId, setFocusId] = useState<string | null>(null)
  const [anchors, setAnchors] = useState<Record<string, Anchor>>({})

  const viewportRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const interaction = useRef<Interaction>(null)
  const viewRef = useRef(view)
  viewRef.current = view
  const boardRef = useRef(board)
  boardRef.current = board
  const toolRef = useRef(tool)
  toolRef.current = tool

  const setItems = (items: BoardItem[]) => store.setBoard({ ...boardRef.current, items })
  const setArrows = (arrows: Board['arrows']) => store.setBoard({ ...boardRef.current, arrows })
  const addItem = (item: BoardItem) => setItems([...boardRef.current.items, item])
  const updateItem = (id: string, patch: Partial<BoardItem>) =>
    setItems(boardRef.current.items.map((i) => (i.id === id ? { ...i, ...patch } : i)))
  const removeItem = (id: string) =>
    store.setBoard({
      items: boardRef.current.items.filter((i) => i.id !== id),
      arrows: boardRef.current.arrows.filter((a) => a.from !== id && a.to !== id),
    })
  const bringToFront = (id: string) => {
    const items = boardRef.current.items
    const i = items.find((it) => it.id === id)
    if (!i || items[items.length - 1]?.id === id) return
    setItems([...items.filter((it) => it.id !== id), i])
  }

  function centerCanvas() {
    const r = viewportRef.current?.getBoundingClientRect()
    return screenToCanvas((r?.left ?? 0) + (r?.width ?? 600) / 2, (r?.top ?? 0) + (r?.height ?? 400) / 2)
  }
  function screenToCanvas(clientX: number, clientY: number) {
    const r = viewportRef.current!.getBoundingClientRect()
    const v = viewRef.current
    return { x: (clientX - r.left - v.x) / v.scale, y: (clientY - r.top - v.y) / v.scale }
  }

  function addNote(at?: { x: number; y: number }) {
    const c = at ?? centerCanvas()
    const id = uid()
    addItem({ id, type: 'note', x: Math.round(c.x - NOTE_W / 2), y: Math.round(c.y - 60), text: '', color: 'yellow' })
    setFocusId(id)
  }
  function addText(at?: { x: number; y: number }) {
    const c = at ?? centerCanvas()
    const id = uid()
    addItem({ id, type: 'text', x: Math.round(c.x - TEXT_W / 2), y: Math.round(c.y - 16), html: '', w: TEXT_W })
    setFocusId(id)
  }
  function addSticker(emoji: string) {
    const c = centerCanvas()
    addItem({ id: uid(), type: 'sticker', x: Math.round(c.x - 36), y: Math.round(c.y - 36), emoji, w: 72, h: 72 })
    setStickerOpen(false)
  }
  async function onPickImage(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const { src, w, h } = await downscale(file)
    const c = centerCanvas()
    const dw = Math.min(300, w)
    const dh = Math.round((dw * h) / w)
    addItem({ id: uid(), type: 'image', x: Math.round(c.x - dw / 2), y: Math.round(c.y - dh / 2), w: dw, h: dh, src })
  }

  function handleArrowClick(id: string) {
    if (!arrowFrom) {
      setArrowFrom(id)
    } else if (arrowFrom !== id) {
      setArrows([...boardRef.current.arrows, { id: uid(), from: arrowFrom, to: id }])
      setArrowFrom(null)
    } else {
      setArrowFrom(null)
    }
  }

  function onBackgroundPointerDown(e: ReactPointerEvent) {
    if (e.button !== 0) return
    setSelectedArrow(null)
    if (toolRef.current === 'arrow') {
      setArrowFrom(null)
      return
    }
    const v = viewRef.current
    interaction.current = { type: 'pan', sx: e.clientX, sy: e.clientY, vx: v.x, vy: v.y }
  }
  function onItemPointerDown(e: ReactPointerEvent, item: BoardItem) {
    e.stopPropagation()
    setSelectedArrow(null)
    if (toolRef.current === 'arrow') {
      e.preventDefault()
      handleArrowClick(item.id)
      return
    }
    const t = e.target as HTMLElement
    if (t.closest('[data-noxdrag]')) return
    if (t.closest('[data-resize]')) {
      interaction.current = {
        type: 'resize',
        id: item.id,
        sx: e.clientX,
        ow: item.w ?? 200,
        oh: item.h ?? 140,
        curW: item.w ?? 200,
        curH: item.h ?? 140,
      }
      return
    }
    bringToFront(item.id)
    interaction.current = {
      type: 'drag',
      id: item.id,
      sx: e.clientX,
      sy: e.clientY,
      ox: item.x,
      oy: item.y,
      curX: item.x,
      curY: item.y,
    }
    setDragging({ id: item.id, x: item.x, y: item.y })
  }

  useEffect(() => {
    function move(e: PointerEvent) {
      const it = interaction.current
      if (!it) return
      if (it.type === 'pan') {
        setView((v) => ({ ...v, x: it.vx + (e.clientX - it.sx), y: it.vy + (e.clientY - it.sy) }))
      } else if (it.type === 'drag') {
        const s = viewRef.current.scale
        const x = Math.round(it.ox + (e.clientX - it.sx) / s)
        const y = Math.round(it.oy + (e.clientY - it.sy) / s)
        it.curX = x
        it.curY = y
        setDragging({ id: it.id, x, y })
      } else {
        const s = viewRef.current.scale
        const w = Math.max(60, Math.round(it.ow + (e.clientX - it.sx) / s))
        const ratio = it.ow ? it.oh / it.ow : 0.7
        it.curW = w
        it.curH = Math.round(w * ratio)
        setResizing({ id: it.id, w, h: it.curH })
      }
    }
    function up() {
      const it = interaction.current
      if (it?.type === 'drag') updateItem(it.id, { x: it.curX, y: it.curY })
      else if (it?.type === 'resize') updateItem(it.id, { w: it.curW, h: it.curH })
      interaction.current = null
      setDragging(null)
      setResizing(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [])

  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    function onWheel(e: WheelEvent) {
      e.preventDefault()
      const v = viewRef.current
      if (e.ctrlKey || e.metaKey) {
        const r = el!.getBoundingClientRect()
        const cxp = e.clientX - r.left
        const cyp = e.clientY - r.top
        const scale = clamp(v.scale * Math.exp(-e.deltaY * 0.01), 0.3, 2.5)
        const k = scale / v.scale
        setView({ x: cxp - (cxp - v.x) * k, y: cyp - (cyp - v.y) * k, scale })
      } else {
        setView({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY })
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setTool('select')
        setArrowFrom(null)
        setSelectedArrow(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!focusId) return
    const el = document.getElementById(`text-${focusId}`) || document.getElementById(`note-${focusId}`)
    ;(el as HTMLElement | null)?.focus()
    setFocusId(null)
  }, [focusId])

  function zoomBy(factor: number) {
    setView((v) => {
      const r = viewportRef.current?.getBoundingClientRect()
      const cxp = (r?.width ?? 600) / 2
      const cyp = (r?.height ?? 400) / 2
      const scale = clamp(v.scale * factor, 0.3, 2.5)
      const k = scale / v.scale
      return { x: cxp - (cxp - v.x) * k, y: cyp - (cyp - v.y) * k, scale }
    })
  }

  useLayoutEffect(() => {
    const vp = viewportRef.current
    if (!vp) return
    const v = vp.getBoundingClientRect()
    const next: Record<string, Anchor> = {}
    for (const it of board.items) {
      const el = document.getElementById(`item-${it.id}`)
      if (!el) continue
      const r = el.getBoundingClientRect()
      const w = r.width / view.scale
      const h = r.height / view.scale
      let cxv = (r.left + r.width / 2 - v.left - view.x) / view.scale
      let cyv = (r.top + r.height / 2 - v.top - view.y) / view.scale
      if (dragging && dragging.id === it.id) {
        cxv = dragging.x + w / 2
        cyv = dragging.y + h / 2
      }
      next[it.id] = { cx: cxv, cy: cyv, w, h }
    }
    setAnchors((prev) => {
      const ks = Object.keys(next)
      const same =
        ks.length === Object.keys(prev).length &&
        ks.every(
          (k) =>
            prev[k] && prev[k].cx === next[k].cx && prev[k].cy === next[k].cy && prev[k].w === next[k].w && prev[k].h === next[k].h,
        )
      return same ? prev : next
    })
  })

  const arrowGeoms = board.arrows
    .map((arr) => {
      const a = anchors[arr.from]
      const b = anchors[arr.to]
      if (!a || !b) return null
      const src = edgePoint(a, b.cx, b.cy)
      const tgt = edgePoint(b, a.cx, a.cy)
      return { id: arr.id, src, tgt, mid: { x: (src.x + tgt.x) / 2, y: (src.y + tgt.y) / 2 } }
    })
    .filter(Boolean) as { id: string; src: { x: number; y: number }; tgt: { x: number; y: number }; mid: { x: number; y: number } }[]

  const arrowMode = tool === 'arrow'

  return (
    <div className="animate-in">
      <div className="mb-5 flex items-center gap-3">
        <img src="/fixmyposture.png" alt="FixMyPosture" className="size-10 rounded-xl object-cover ring-1 ring-black/5" />
        <div>
          <h1 className="text-3xl font-bold text-neutral-900">FixMyPosture</h1>
          <p className="mt-0.5 text-base font-medium text-neutral-500">
            Planning board, drop notes, text, images, stickers and connect them with arrows
          </p>
        </div>
      </div>

      <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onPickImage} />

      <div
        ref={viewportRef}
        onPointerDown={onBackgroundPointerDown}
        onDoubleClick={(e) => tool === 'select' && addNote(screenToCanvas(e.clientX, e.clientY))}
        className={cx(
          'relative h-[74vh] min-h-[460px] touch-none select-none overflow-hidden rounded-2xl border border-neutral-200 bg-neutral-50',
          arrowMode ? 'cursor-crosshair' : 'cursor-grab active:cursor-grabbing',
        )}
        style={{
          backgroundImage: 'radial-gradient(rgba(0,0,0,0.08) 1px, transparent 1px)',
          backgroundSize: `${24 * view.scale}px ${24 * view.scale}px`,
          backgroundPosition: `${view.x}px ${view.y}px`,
        }}
      >
        {/* Toolbar */}
        <div
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          className="absolute left-3 top-3 z-20 flex items-center gap-1 rounded-2xl border border-neutral-200 bg-white p-1 shadow-sm"
        >
          <ToolBtn label="Note" icon="plus" onClick={() => addNote()} />
          <ToolBtn label="Text" icon="type" onClick={() => addText()} />
          <ToolBtn label="Image" icon="image" onClick={() => fileRef.current?.click()} />
          <div className="relative">
            <ToolBtn label="Sticker" icon="sticker" active={stickerOpen} onClick={() => setStickerOpen((v) => !v)} />
            {stickerOpen && (
              <div className="absolute left-0 top-11 z-30 grid w-56 grid-cols-6 gap-1 rounded-2xl border border-neutral-200 bg-white p-2 shadow-lg">
                {STICKERS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => addSticker(s)}
                    className="grid size-8 place-items-center rounded-lg text-xl hover:bg-neutral-100"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
          <ToolBtn label="Arrow" icon="arrow" active={arrowMode} onClick={() => setTool((t) => (t === 'arrow' ? 'select' : 'arrow'))} />
          <div className="mx-1 h-6 w-px bg-neutral-200" />
          <button type="button" onClick={() => zoomBy(1 / 1.2)} aria-label="Zoom out" className="grid size-8 place-items-center rounded-full text-lg font-bold leading-none text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900">−</button>
          <span className="w-11 text-center text-[15px] font-semibold tabular-nums text-neutral-500">{Math.round(view.scale * 100)}%</span>
          <button type="button" onClick={() => zoomBy(1.2)} aria-label="Zoom in" className="grid size-8 place-items-center rounded-full text-lg font-bold leading-none text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900">+</button>
          <button type="button" onClick={() => setView({ x: 0, y: 0, scale: 1 })} aria-label="Reset view" className="grid size-8 place-items-center rounded-full text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"><Icon name="target" className="size-4" /></button>
        </div>

        {arrowMode && (
          <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex justify-center">
            <span className="rounded-full bg-neutral-900 px-3 py-1 text-[15px] font-semibold text-white">
              {arrowFrom ? 'Click the item to connect to' : 'Click an item to start an arrow'} (Esc to exit)
            </span>
          </div>
        )}

        {board.items.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <p className="text-base font-medium text-neutral-400">Double-click anywhere, or use the toolbar, to start</p>
          </div>
        )}

        {/* Canvas layer */}
        <div className="absolute left-0 top-0" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, transformOrigin: '0 0' }}>
          {/* Arrows (behind items) */}
          <svg className="absolute left-0 top-0 overflow-visible" width="1" height="1">
            <defs>
              <marker id="arrowhead" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto" markerUnits="userSpaceOnUse">
                <path d="M0 0 L8 3 L0 6 z" fill="#525252" />
              </marker>
            </defs>
            {arrowGeoms.map((g) => (
              <g key={g.id}>
                <line
                  x1={g.src.x}
                  y1={g.src.y}
                  x2={g.tgt.x}
                  y2={g.tgt.y}
                  stroke="transparent"
                  strokeWidth={16}
                  className="pointer-events-auto cursor-pointer"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => setSelectedArrow(g.id)}
                />
                <line
                  x1={g.src.x}
                  y1={g.src.y}
                  x2={g.tgt.x}
                  y2={g.tgt.y}
                  stroke={selectedArrow === g.id ? '#171717' : '#525252'}
                  strokeWidth={selectedArrow === g.id ? 3 : 2}
                  markerEnd="url(#arrowhead)"
                />
              </g>
            ))}
          </svg>

          {/* Arrow delete button */}
          {selectedArrow &&
            arrowGeoms
              .filter((g) => g.id === selectedArrow)
              .map((g) => (
                <button
                  key={g.id}
                  type="button"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => {
                    setArrows(boardRef.current.arrows.filter((a) => a.id !== g.id))
                    setSelectedArrow(null)
                  }}
                  className="absolute z-20 grid size-6 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-neutral-200 bg-white text-neutral-500 shadow-sm hover:text-red-500"
                  style={{ left: g.mid.x, top: g.mid.y }}
                  aria-label="Delete arrow"
                >
                  <Icon name="x" className="size-3.5" />
                </button>
              ))}

          {/* Items */}
          {board.items.map((item) => {
            const pos = dragging && dragging.id === item.id ? dragging : item
            const sz = resizing && resizing.id === item.id ? resizing : { w: item.w, h: item.h }
            const connectable = arrowMode
            const isFrom = arrowFrom === item.id
            return (
              <div
                key={item.id}
                id={`item-${item.id}`}
                onPointerDown={(e) => onItemPointerDown(e, item)}
                onDoubleClick={(e) => e.stopPropagation()}
                className={cx('group absolute', connectable && 'ring-2 ring-offset-2')}
                style={
                  {
                    left: pos.x,
                    top: pos.y,
                    // arrow mode outlines every item in lime, and the chosen source in deep green
                    ...(connectable ? { '--tw-ring-color': isFrom ? LIME_DEEP : LIME } : null),
                  } as CSSProperties
                }
              >
                {item.type === 'note' && (
                  <div
                    className="flex w-[216px] flex-col rounded-xl shadow-md ring-1 ring-black/5"
                    style={{ background: noteBg(item.color ?? 'yellow') }}
                  >
                    <Handle>
                      <Swatches active={item.color ?? 'yellow'} onPick={(c) => updateItem(item.id, { color: c })} />
                      <DeleteBtn onClick={() => removeItem(item.id)} />
                    </Handle>
                    <textarea
                      id={`note-${item.id}`}
                      data-noxdrag
                      value={item.text ?? ''}
                      onChange={(e) => updateItem(item.id, { text: e.target.value })}
                      placeholder="Type…"
                      className="min-h-24 w-full select-text resize-none bg-transparent px-3 pb-3 pt-0.5 text-[15px] font-medium text-neutral-900 outline-none placeholder:text-black/30"
                    />
                  </div>
                )}

                {item.type === 'text' && (
                  <div className="flex flex-col rounded-xl bg-white/70 shadow-sm ring-1 ring-black/5 backdrop-blur-sm" style={{ width: item.w ?? TEXT_W }}>
                    <Handle>
                      <button type="button" data-noxdrag onMouseDown={(e) => e.preventDefault()} onClick={() => exec(item.id, updateItem, 'bold')} className="grid size-6 place-items-center rounded text-[15px] font-extrabold text-neutral-700 hover:bg-black/5" aria-label="Bold">B</button>
                      {/* the chip is painted with the exact colour hiliteColor writes, so the
                          swatch never drifts from the highlight it applies */}
                      <button type="button" data-noxdrag onMouseDown={(e) => e.preventDefault()} onClick={() => exec(item.id, updateItem, 'hiliteColor', '#fde68a')} className="grid size-6 place-items-center rounded text-[15px] font-bold text-neutral-800 hover:brightness-95" style={{ background: '#fde68a' }} aria-label="Highlight">H</button>
                      <DeleteBtn onClick={() => removeItem(item.id)} />
                    </Handle>
                    <RichText itemId={item.id} initialHtml={item.html ?? ''} onChange={(html) => updateItem(item.id, { html })} />
                  </div>
                )}

                {item.type === 'image' && (
                  <div className="relative">
                    <img src={item.src} alt="" draggable={false} className="block rounded-lg shadow-md ring-1 ring-black/5" style={{ width: sz.w ?? 240, height: sz.h ?? 'auto' }} />
                    <div className="absolute -right-2 -top-2 opacity-0 transition-opacity group-hover:opacity-100">
                      <DeleteBtn onClick={() => removeItem(item.id)} solid />
                    </div>
                    <span data-resize className="absolute -bottom-1 -right-1 size-4 cursor-nwse-resize rounded-full border border-white bg-neutral-700 opacity-0 transition-opacity group-hover:opacity-100" />
                  </div>
                )}

                {item.type === 'sticker' && (
                  <div className="relative grid place-items-center" style={{ width: item.w ?? 72, height: item.h ?? 72 }}>
                    <span className="select-none leading-none" style={{ fontSize: (item.w ?? 72) * 0.8 }}>{item.emoji}</span>
                    <div className="absolute -right-2 -top-2 opacity-0 transition-opacity group-hover:opacity-100">
                      <DeleteBtn onClick={() => removeItem(item.id)} solid />
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function exec(
  itemId: string,
  updateItem: (id: string, patch: Partial<BoardItem>) => void,
  cmd: string,
  value?: string,
) {
  document.execCommand('styleWithCSS', false, 'true')
  document.execCommand(cmd, false, value)
  const el = document.getElementById(`text-${itemId}`)
  if (el) updateItem(itemId, { html: el.innerHTML })
}

function ToolBtn({ label, icon, active, onClick }: { label: string; icon: Parameters<typeof Icon>[0]['name']; active?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[15px] font-semibold transition-colors',
        active ? 'bg-neutral-900 text-white' : 'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900',
      )}
    >
      <Icon name={icon} className="size-4" />
      <span className="hidden sm:inline">{label}</span>
    </button>
  )
}

function Handle({ children }: { children: ReactNode }) {
  return <div className="flex cursor-grab items-center gap-1 px-2 py-1 active:cursor-grabbing"><Icon name="grip" className="size-4 text-black/30" /><div className="ml-auto flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">{children}</div></div>
}

function Swatches({ active, onPick }: { active: BoardColor; onPick: (c: BoardColor) => void }) {
  return (
    <>
      {COLOR_LIST.map((c) => (
        <button
          key={c}
          type="button"
          data-noxdrag
          onClick={() => onPick(c)}
          aria-label={`Color ${c}`}
          className={cx('size-3.5 rounded-full ring-1 ring-black/10', active === c && 'ring-2 ring-neutral-900')}
          style={{ background: noteBg(c) }}
        />
      ))}
    </>
  )
}

function DeleteBtn({ onClick, solid }: { onClick: () => void; solid?: boolean }) {
  return (
    <button
      type="button"
      data-noxdrag
      onClick={onClick}
      aria-label="Delete"
      className={cx(
        'grid size-5 place-items-center rounded-full',
        solid ? 'border border-white bg-neutral-700 text-white shadow hover:bg-red-500' : 'text-black/40 hover:bg-black/10 hover:text-black',
      )}
    >
      <Icon name="x" className="size-3.5" />
    </button>
  )
}

function RichText({ itemId, initialHtml, onChange }: { itemId: string; initialHtml: string; onChange: (html: string) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.innerHTML = initialHtml || ''
    // mount only — never re-sync to avoid caret jumps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <div
      id={`text-${itemId}`}
      ref={ref}
      contentEditable
      suppressContentEditableWarning
      data-noxdrag
      onInput={() => onChange(ref.current?.innerHTML ?? '')}
      data-placeholder="Type…"
      className="min-h-[1.75rem] w-full select-text whitespace-pre-wrap break-words px-3 pb-2.5 pt-0.5 text-base font-medium text-neutral-900 outline-none empty:before:text-black/30 empty:before:content-[attr(data-placeholder)]"
    />
  )
}
