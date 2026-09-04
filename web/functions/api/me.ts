// Who am I, and am I allowed in yet.
//
// The one call the app makes before rendering anything. Reaching this route at
// all means the middleware already verified an Access token and found an
// approved user, so a 200 here is the app's green light. A 403 with
// code "pending" is what an unapproved person gets, and the UI turns that into
// the waiting screen rather than an error.

interface Ctx {
  data: { user?: { email: string; isAdmin: boolean; status: string } }
}

export async function onRequestGet({ data }: Ctx): Promise<Response> {
  const user = data.user
  if (!user) return new Response('Unauthorized', { status: 401 })
  return Response.json({
    email: user.email,
    isAdmin: user.isAdmin,
    status: user.status,
  })
}
