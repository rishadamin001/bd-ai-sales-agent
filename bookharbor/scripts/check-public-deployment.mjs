import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const expectedMISIds = [
  "mis-digital-firm", "mis-business-driven", "mis-today", "mis-m-baltzan",
];

export function verifyPublicCatalog(health, products) {
  if (health?.ok !== true || health.demo !== true)
    throw Error("The live Worker health response is not the expected BookHarbor demo.");
  if (!Array.isArray(products))
    throw Error("The live /api/catalog endpoint did not return a product array.");
  const ids = new Set(products.map((p) => p.id));
  if (ids.size !== products.length || !ids.has("hobbit") ||
      expectedMISIds.some((id) => !ids.has(id)) || products.length < 12)
    throw Error("The live catalogue is missing the original or new MIS books.");
  if (!products.every((p) =>
    typeof p.title === "string" && Number.isInteger(p.price) && p.price > 0 &&
    Number.isInteger(p.stock) && p.stock >= 0))
    throw Error("Invalid price/stock values found in the live catalogue.");
  return { total: products.length, mis: expectedMISIds.length };
}

export async function checkPublicDeployment(url, fetchFn = fetch) {
  const origin = new URL(url);
  if (origin.protocol !== "https:" || origin.username || origin.password ||
      origin.search || origin.hash || origin.pathname !== "/")
    throw Error("Expected an HTTPS origin URL only.");
  const get = async (route) => {
    const response = await fetchFn(new URL(route, origin), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw Error(`Live ${route} returned HTTP ${response.status}.`);
    return response.json();
  };
  const health = await get("api/health");
  const catalog = await get("api/catalog");
  return verifyPublicCatalog(health, catalog);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const base = process.env.BOOKHARBOR_PUBLIC_URL;
    if (!base) throw Error("BOOKHARBOR_PUBLIC_URL is missing.");
    const result = await checkPublicDeployment(base);
    console.log(`Live site verified: ${result.total} catalogue titles including all ${result.mis} MIS textbooks. No test orders placed.`);
  } catch (error) {
    console.error("Public deployment check failed: " + error.message);
    process.exitCode = 1;
  }
}
