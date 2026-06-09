import type { APIRoute } from "astro";
import { fetchTerms } from "@/lib/search";

export const GET: APIRoute = async () => {
  try {
    const terms = await fetchTerms();
    return new Response(JSON.stringify(terms), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Failed to fetch terms:", err);
    return new Response(
      JSON.stringify({ error: "Failed to fetch terms" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};
