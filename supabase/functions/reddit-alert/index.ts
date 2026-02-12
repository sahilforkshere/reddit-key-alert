// public function
export const config = {
  auth: false,
};

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { Resend } from "npm:resend";

const resend = new Resend(Deno.env.get("RESEND_API_KEY")!);
const EMAIL_TO = Deno.env.get("EMAIL_TO")!;
const SENDING_EMAIL = Deno.env.get("SENDING_EMAIL")!;

const KEYWORDS = (Deno.env.get("KEYWORDS") || "")
  .split(",")
  .map((k) => k.trim().toLowerCase());

const seenPosts = new Set<string>();

async function checkRedditAndSend() {
  const matchedPosts: { title: string; link: string; keyword: string }[] = [];

  for (const keyword of KEYWORDS) {
    try {
      const url = `https://www.reddit.com/search.rss?q=${encodeURIComponent(
        keyword
      )}&sort=new`;

      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; RedditKeywordBot/1.0)",
        },
      });

      const xml = await res.text();
      const entries = xml.split("<entry>");

      for (const entry of entries.slice(1)) {
        const titleMatch = entry.match(/<title>(.*?)<\/title>/);
        const linkMatch = entry.match(/<link href="(.*?)"/);

        if (!titleMatch || !linkMatch) continue;

        const title = titleMatch[1];
        const link = linkMatch[1];

        const id = link;
        if (seenPosts.has(id)) continue;
        seenPosts.add(id);

        const lowerTitle = title.toLowerCase();
        if (!lowerTitle.includes(keyword)) continue;

        matchedPosts.push({ title, link, keyword });
      }
    } catch (err) {
      console.error("Error in worker:", err);
    }
  }

 // uodated code for batchign multiple mails of maathcedpost  sarray
  if (matchedPosts.length > 0) {
    const listHtml = matchedPosts
      .map(
        (p) =>
          `<li><b>${p.keyword}</b> → <a href="${p.link}">${p.title}</a></li>`
      )
      .join("");

    const result = await resend.emails.send({
      from: `Notifications <${SENDING_EMAIL}>`,
      to: [EMAIL_TO],
      subject: `Reddit Alert Summary (${matchedPosts.length} matches)`,
      html: `
        <h2>Reddit Keyword Matches</h2>
        <ul>${listHtml}</ul>
      `,
    });

    console.log("Summary email sent:", result);
  } else {
    console.log("No matches found");
  }
}

serve(async () => {
  console.log("Worker started");
  await checkRedditAndSend();
  return new Response("Done", { status: 200 });
});
