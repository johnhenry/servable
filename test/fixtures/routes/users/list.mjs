export function GET() {
  return new Response("users list GET");
}
export function POST() {
  return new Response("users list POST", { status: 201 });
}
