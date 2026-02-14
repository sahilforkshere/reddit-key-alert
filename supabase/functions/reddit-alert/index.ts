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
  const matchedPosts: {
    title: string;
    link: string;
    keyword: string;
    preview: string;
  }[] = [];

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
        const contentMatch =
          entry.match(/<content type="html"><!\[CDATA\[(.*?)\]\]><\/content>/) ||
          entry.match(/<summary type="html"><!\[CDATA\[(.*?)\]\]><\/summary>/);

        if (!titleMatch || !linkMatch) continue;

        const title = titleMatch[1];
        const link = linkMatch[1];

        /// only posts
        if (!link.includes("/comments/")) continue;

        const id = link;
        if (seenPosts.has(id)) continue;
        seenPosts.add(id);

        const lowerTitle = title.toLowerCase();
        if (!lowerTitle.includes(keyword)) continue;

        // Extract preview text (clean HTML)
        let preview = "";
        if (contentMatch && contentMatch[1]) {
          preview = contentMatch[1]
            .replace(/<[^>]*>/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 200);
        }

        matchedPosts.push({
          title,
          link,
          keyword,
          preview,
        });
      }
    } catch (err) {
      console.error("Error in worker:", err);
    }
  }

  // 📩 Send ONE batched summary email
  if (matchedPosts.length > 0) {
    const listHtml = matchedPosts
      .map(
        (p) => `
        <li style="margin-bottom:12px;">
          <b>${p.keyword}</b> →
          <a href="${p.link}" target="_blank">${p.title}</a>
          ${
            p.preview
              ? `<div style="color:#555;margin-top:4px;font-size:13px;">
                   ${p.preview}...
                 </div>`
              : ""
          }
        </li>
      `
      )
      .join("");

    const result = await resend.emails.send({
      from: `Notifications <${SENDING_EMAIL}>`,
      to: [EMAIL_TO],
      subject: `Reddit Alert Summary (${matchedPosts.length} matches)`,
      html: `
        <div style="font-family:Arial,sans-serif;">
          <h2>Reddit Keyword Matches</h2>
          <p>Found <b>${matchedPosts.length}</b> new matching posts.</p>
          <ul style="line-height:1.5;">
            ${listHtml}
          </ul>
        </div>
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
