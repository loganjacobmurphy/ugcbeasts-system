import Anthropic from '@anthropic-ai/sdk'

/**
 * Works out which kind of photo each line of a video is calling for.
 *
 * The scenes are cut from what Logan actually said, so the only thing that knows
 * which photo belongs on a scene is the sentence spoken over it. greenroom used to
 * guess this with a keyword scan, which caught "a simple travel shot" and missed
 * everything phrased any other way ("a photo in a fitted shirt, not the one you
 * sleep in"), leaving him to fix most scenes by hand.
 *
 * (functions/ is bundled by Pages, not by the client tsc build, so minimal local
 * types are fine here.)
 */
interface Env {
  ANTHROPIC_API_KEY?: string
}
interface Ctx {
  request: Request
  env: Env
}

interface Body {
  /** what is said during each scene, in order */
  lines?: string[]
  /** the shot types available, which are the tags his photos actually carry */
  shotTypes?: string[]
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })

const SYSTEM = `You match lines of a spoken script to the kind of photo that should be on screen behind them.

Logan is a UGC creator. Each line is one scene of a talking head video, and behind him is a photo. Your job is to say which kind of photo each line is asking for.

Rules:
- Choose only from the shot types given. Never invent one.
- Return an empty string for a line that is not describing a photo at all: an intro, a sign off, a line about the app.
- Return the exact word "same" when a line is the back half of the sentence before it. Scenes are cut on pauses, so one sentence often lands across two lines ("A photo in a fitted shirt," then "not the one you sleep in."). The second is not a new photo, it is the same photo still on screen. Use "same" for every such line, however many in a row.
- A line often names the shot indirectly. "a photo in a fitted shirt, not the one you sleep in" is a well dressed solo shot. "one where you look like you have mates" is a group shot. "somewhere that is obviously not your bedroom" is outdoors or travel. Read what it means, not the words it uses.
- Do not spread your answers evenly for the sake of variety. If four lines in a row all describe the same kind of photo, say so four times.
- Return exactly one entry per line, in the same order.`

export async function onRequestPost({ request, env }: Ctx): Promise<Response> {
  // Whoever pressed the button pays: their own key comes up on the request and
  // is used in preference to the project-wide one. The project key stays as a
  // fallback so nothing breaks for anyone who has not set theirs yet.
  const key = request.headers.get('x-anthropic-key')?.trim() || env.ANTHROPIC_API_KEY
  if (!key) {
    return json({ error: 'No Anthropic API key. Add yours at the bottom of the Scripts page.' }, 503)
  }

  const body = (await request.json()) as Body
  const lines = (body.lines ?? []).map((l) => String(l ?? ''))
  const shotTypes = (body.shotTypes ?? []).map((s) => String(s ?? '')).filter(Boolean)
  if (!lines.length) return json({ error: 'No lines to match.' }, 400)
  if (!shotTypes.length) return json({ error: 'No shot types to choose from.' }, 400)

  const prompt = [
    `Shot types available:\n${shotTypes.map((s) => `- ${s}`).join('\n')}`,
    `The script, one line per scene:\n${lines.map((l, i) => `${i + 1}. ${l || '(silence)'}`).join('\n')}`,
    `Return ${lines.length} entr${lines.length === 1 ? 'y' : 'ies'}, one per line, in order. A shot type, or "same" if the line continues the one before it, or "" if it is not about a photo.`,
  ].join('\n\n')

  const client = new Anthropic({ apiKey: key })

  try {
    // streamed for the same reason as script.ts: the SDK will not run a long
    // non streaming request, and a long script means a lot of lines to match
    const response = await client.messages.stream({
      model: 'claude-opus-5',
      max_tokens: 16000,
      system: SYSTEM,
      output_config: {
        effort: 'medium',
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              shots: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    line: { type: 'integer', description: '1 based line number' },
                    shot: {
                      type: 'string',
                      description: 'a shot type, or "same" to keep the previous photo, or "" for none',
                    },
                  },
                  required: ['line', 'shot'],
                  additionalProperties: false,
                },
              },
            },
            required: ['shots'],
            additionalProperties: false,
          },
        },
      },
      messages: [{ role: 'user', content: prompt }],
    }).finalMessage()

    if (response.stop_reason === 'max_tokens') {
      return json({ error: 'Ran out of room before every line was matched.' }, 422)
    }
    const text = response.content.find((b) => b.type === 'text')
    if (!text || text.type !== 'text') return json({ error: 'Nothing came back.' }, 422)
    let parsed: { shots: { line: number; shot: string }[] }
    try {
      parsed = JSON.parse(text.text) as typeof parsed
    } catch {
      return json({ error: 'The match came back malformed. Try again.' }, 422)
    }

    // rebuild as a dense array in scene order, dropping anything that is not one of
    // the offered types so a hallucinated tag can never reach the library
    const allowed = new Set([...shotTypes, 'same'])
    const plan = lines.map(() => '')
    for (const s of parsed.shots ?? []) {
      const i = Number(s.line) - 1
      if (i >= 0 && i < plan.length && allowed.has(s.shot)) plan[i] = s.shot
    }
    return json({ plan })
  } catch (e) {
    return json({ error: (e as Error).message || 'Matching failed.' }, 422)
  }
}
