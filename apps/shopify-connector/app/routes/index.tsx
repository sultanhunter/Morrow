export function loader() {
  throw new Response("Connection setup is not configured", {
    status: 503,
    headers: { "Cache-Control": "no-store" },
  });
}
export default function Entry() {
  return (
    <main>
      <h1>Morrow Shopify connector</h1>
      <p>Awaiting qualified authentication.</p>
    </main>
  );
}
