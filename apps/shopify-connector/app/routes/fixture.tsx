import { contractVersion } from "@morrow/contracts";
export function loader() {
  if (process.env.NODE_ENV === "production" || process.env.MORROW_CONNECTOR_FIXTURES !== "1")
    throw new Response("Not found", { status: 404 });
  return null;
}
export default function Fixture() {
  return (
    <main>
      <h1>Morrow connector development fixture</h1>
      <p>Synthetic disconnected installation. No authentication or merchant data.</p>
      <p>Connection controls will be wired after linking and Shopify qualification.</p>
      <small>{contractVersion}</small>
    </main>
  );
}
