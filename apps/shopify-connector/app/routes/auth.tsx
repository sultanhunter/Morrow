// A shop query is never installation or membership proof.
export function loader() {
  throw new Response("Qualified authentication and session storage required", {
    status: 503,
    headers: { "Cache-Control": "no-store" },
  });
}
export function action() {
  throw new Response("Qualified authentication and session storage required", {
    status: 503,
    headers: { "Cache-Control": "no-store" },
  });
}
