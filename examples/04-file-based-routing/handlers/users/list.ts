export function GET(): Response {
  return Response.json(["Ada", "Grace"]);
}

export function POST(): Response {
  return new Response("created", { status: 201 });
}
