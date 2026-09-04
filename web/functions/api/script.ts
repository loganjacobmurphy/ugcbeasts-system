import Anthropic from '@anthropic-ai/sdk'

/**
 * Writes the spoken script for a video, in Logan's voice, from the format's
 * reference transcript. He reads it to camera, and greenroom takes it from there.
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
  formatName?: string
  reference?: string
  hooks?: string[]
  audience?: string
  campaign?: string
  app?: string
  count?: number
  notes?: string
  cta?: string
  audiencePlan?: string[]
  countsDays?: boolean
  funnelPlan?: Record<string, number>[]
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })

const SYSTEM = `You write short-form TikTok scripts for Logan, a UGC creator. He reads them to camera in one take, so what you write is spoken word only.

Rules that matter more than anything else:
- Match the reference transcript's voice, rhythm and structure. It is a real video of his that performed; you are writing the next one in that series, not a new format.
- Spoken English, first person, casual. Contractions. No stage directions, no shot lists, no headings, no emoji, no markdown.
- Never use dashes of any kind. No em dash, no en dash, no hyphen used as punctuation. Use commas, full stops or brackets.
- Open on a hook in the first sentence that earns the next three seconds.
- Keep it to roughly the same length as the reference, which is about 30 seconds spoken.
- Land the CTA exactly as the CTA note describes, and place it where the reference places it: near the end, in passing, as the method he used. Never write it as an ad read or a sponsor slot.
- Each script must be materially different from the others, not a reworded copy.
- When you are told who a script is about, that is the group it is about. Never invent a different group.
- Only count days ("day 6 of ...") when the format's own hook lines count days. Some formats are a how to, not a running challenge, and putting a day number on those is wrong.
- Every funnel video is now dating related and happens on Hinge. Never say he sent generic DMs, messaged a list, got left on delivered, or counted message opens. The action is swiping right on profiles on Hinge, followed by matches and replies.`

export async function onRequestPost({ request, env }: Ctx): Promise<Response> {
  // json, like every other failure here, so the page can read the reason
  // Whoever pressed the button pays: their own key comes up on the request and
  // is used in preference to the project-wide one. The project key stays as a
  // fallback so nothing breaks for anyone who has not set theirs yet.
  const key = request.headers.get('x-anthropic-key')?.trim() || env.ANTHROPIC_API_KEY
  if (!key) {
    return json({ error: 'No Anthropic API key. Add yours at the bottom of the Scripts page.' }, 503)
  }

  const body = (await request.json()) as Body
  const count = Math.min(Math.max(Number(body.count) || 3, 1), 8)

  const parts = [
    `Format: ${body.formatName ?? 'untitled'}`,
    body.app ? `App being promoted: ${body.app}` : '',
    body.campaign ? `Campaign: ${body.campaign}` : '',
    body.audience ? `Who it is about: ${body.audience}` : '',
    body.audiencePlan?.length
      ? `Who each script is about. Use exactly these, in this order, one per script. Do not substitute your own:\n` +
        body.audiencePlan.map((a, i) => `Script ${i + 1}: ${a}`).join('\n')
      : '',
    body.hooks?.length ? `Hook lines this format uses:\n${body.hooks.join('\n')}` : '',
    body.funnelPlan?.length
      ? `THE HINGE FUNNEL. Each script is a DIFFERENT dating video with its own stats, and these figures are on screen as graphics while he talks. The first spoken sentence keeps the format's existing audience hook. The next sentence must say "I swiped right on [exact total] [audience] on Hinge." Never say he DM'd them, messaged them, or sent messages to them. Use the set below that matches the script you are writing, say those exact figures and no others, never round them, never carry a number from one script into another, and walk them in this order: swiped right, matched, did not match, replied, said no, said yes, and the final count last.\n\n` +
        body.funnelPlan
          .map(
            (f, i) =>
              `Script ${i + 1}: swiped right on ${f.sent?.toLocaleString()} profiles on Hinge, matched with ${f.opened?.toLocaleString()}, did not match with ${f.notOpened?.toLocaleString()}, replied ${f.responded?.toLocaleString()}, said no ${f.saidNo?.toLocaleString()}, said yes ${f.saidYes?.toLocaleString()}, actually cracked ${f.cracked?.toLocaleString()}`,
          )
          .join('\n') +
        `\n\nThe reveal of how he got them goes AFTER the replies and BEFORE the final count, exactly as the reference does.` +
        `\n\nKeep each complete funnel script between 90 and 105 words. The numbers are the spine, so move through them quickly and do not pad the transitions.` +
        `\n\nHOT GIRL PROOF. After the exact app line, add one short sentence proving the same method also gets matches from attractive mainstream women. Name one recognisable group, such as ABGs, sorority girls, Latinas or snow bunnies, and vary it across the batch. For example: "It also gets me matches with ABGs, so I know it works." Treat this as conversion proof, not as a complaint about unwanted normal women. One sentence only.`
      : '',
    body.countsDays === false
      ? 'This format does NOT count days. Never open with a day number, never write "day 6 of" or "it is day 6", and never imply a running challenge with a total. The hook is the line itself.'
      : '',
    body.reference
      ? `Reference transcript, a real video in this format:\n"""\n${body.reference}\n"""`
      : 'No reference transcript is available for this format, so follow the hook lines and keep it in his voice.',
    // {app} in a format's CTA is filled in with the app this campaign is actually
    // for. A format can run under two deals, and the text used to name one of them
    // outright, so a Roast video kept saying Regen.
    body.cta ? `How the CTA must land:\n${body.cta.replace(/\{app\}/gi, body.app || 'the app')}` : '',
    body.app
      ? `Hinge is the dating platform and must be named on the right swipe line. Besides Hinge, the ONLY product or tool you may name is ${body.app}. Never name any other tool, app or brand, even if the reference transcript mentions one.`
      : '',
    body.notes ? `Extra direction from Logan for this batch:\n${body.notes}` : '',
    `Write ${count} script${count === 1 ? '' : 's'}.`,
  ].filter(Boolean)

  const client = new Anthropic({ apiKey: key })

  try {
    // .stream(), not .create(). The SDK refuses a non streaming request whose
    // max_tokens implies it could run past ten minutes, which is exactly what
    // raising the ceiling for thinking room did. Streaming keeps the connection
    // fed; we still wait for the whole message before answering.
    const response = await client.messages.stream({
      model: 'claude-opus-5',
      // this ceiling covers thinking as well as the scripts themselves, and running
      // out of it truncates the json, which then surfaced as a parser error
      max_tokens: 32000,
      system: SYSTEM,
      output_config: {
        effort: 'high',
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              scripts: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    hook: { type: 'string', description: 'the on-screen hook text, short' },
                    script: { type: 'string', description: 'the full spoken script' },
                  },
                  required: ['hook', 'script'],
                  additionalProperties: false,
                },
              },
            },
            required: ['scripts'],
            additionalProperties: false,
          },
        },
      },
      messages: [{ role: 'user', content: parts.join('\n\n') }],
    }).finalMessage()

    if (response.stop_reason === 'max_tokens') {
      return json({ error: 'Ran out of room before the scripts finished. Try fewer at a time.' }, 422)
    }
    const text = response.content.find((b) => b.type === 'text')
    if (!text || text.type !== 'text') return json({ error: 'No script came back.' }, 422)
    let parsed: { scripts: { hook: string; script: string }[] }
    try {
      parsed = JSON.parse(text.text) as typeof parsed
    } catch {
      return json({ error: 'The scripts came back malformed. Try again.' }, 422)
    }

    // belt and braces on the no-dashes rule, since it is the one Logan always catches
    const clean = (s: string) => s.replace(/\s+[–—-]\s+/g, ', ').replace(/[–—]/g, ', ')
    return json({
      scripts: (parsed.scripts ?? []).map((s) => ({ hook: clean(s.hook), script: clean(s.script) })),
    })
  } catch (e) {
    // Cloudflare masks a 502 from a Pages Function with its own error page, so
    // upstream failures are reported as 422 instead
    return json({ error: (e as Error).message || 'Script generation failed.' }, 422)
  }
}
