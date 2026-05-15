import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/obsidian/open")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const target = new URL(request.url).searchParams.get("target") ?? "";
        if (!isSafeObsidianOpenLink(target)) {
          return new Response("Bad Obsidian link", { status: 400 });
        }

        return new Response(null, {
          status: 302,
          headers: { Location: target },
        });
      },
    },
  },
});

function isSafeObsidianOpenLink(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "obsidian:" && url.hostname === "open" && url.searchParams.has("vault") && url.searchParams.has("file");
  } catch {
    return false;
  }
}