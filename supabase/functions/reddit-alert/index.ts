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

const WHOLE_WORD = (Deno.env.get("WHOLE_WORD") || "false") === "true";
const MATCH_POSTS = (Deno.env.get("MATCH_POSTS") || "true") === "true";
const MATCH_COMMENTS = (Deno.env.get("MATCH_COMMENTS") || "true") === "true";

const seen = new Set<string>();

// ---------- keyword matching helper ----------
function matchKeyword(text: string, keyword: string): boolean {
  if (!text) return false;

  text = text.toLowerCase();
  keyword = keyword.toLowerCase();

  if (!WHOLE_WORD) return text.includes(keyword);

  const regex = new RegExp(`\\b${keyword}\\b`, "i");
  return regex.test(text);
}

async function checkRedditAndSend() {
  const matches: {
    title: string;
    link: string;
    keyword: string;
    preview: string;
  }[] = [];

  for (const keyword of KEYWORDS) {
    try {
      // ---------------- POSTS ----------------
      if (MATCH_POSTS) {
        const postUrl = `https://www.reddit.com/search.rss?q=${encodeURIComponent(
          keyword
        )}&sort=new`;

        const res = await fetch(postUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (RedditKeywordBot)",
          },
        });

        const xml = await res.text();
        const entries = xml.split("<entry>");

        for (const entry of entries.slice(1)) {
          const titleMatch = entry.match(/<title>(.*?)<\/title>/);
          const linkMatch = entry.match(/<link href="(.*?)"/);
          const contentMatch =
            entry.match(
              /<content type="html"><!\[CDATA\[(.*?)\]\]><\/content>/
            ) ||
            entry.match(
              /<summary type="html"><!\[CDATA\[(.*?)\]\]><\/summary>/
            );

          if (!titleMatch || !linkMatch) continue;

          const title = titleMatch[1];
          const link = linkMatch[1];

          // only real posts
          if (!link.includes("/comments/")) continue;

          const id = link;
          if (seen.has(id)) continue;
          seen.add(id);

          if (
            !matchKeyword(title, keyword) &&
            !matchKeyword(link, keyword)
          )
            continue;

          let preview = "";
          if (contentMatch && contentMatch[1]) {
            preview = contentMatch[1]
              .replace(/<[^>]*>/g, "")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 200);
          }

          matches.push({ title, link, keyword, preview });
        }
      }

    //comments
      if (MATCH_COMMENTS) {
        const commentUrl = `https://www.reddit.com/search.rss?q=${encodeURIComponent(
          keyword
        )}&type=comment&sort=new`;

        const res = await fetch(commentUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (RedditKeywordBot)",
          },
        });

        const xml = await res.text();
        const entries = xml.split("<entry>");

        for (const entry of entries.slice(1)) {
          const titleMatch = entry.match(/<title>(.*?)<\/title>/);
          const linkMatch = entry.match(/<link href="(.*?)"/);
          const contentMatch =
            entry.match(
              /<content type="html"><!\[CDATA\[(.*?)\]\]><\/content>/
            );

          if (!titleMatch || !linkMatch || !contentMatch) continue;

          const link = linkMatch[1];
          const body = contentMatch[1]
            .replace(/<[^>]*>/g, "")
            .toLowerCase();

          const id = link;
          if (seen.has(id)) continue;
          seen.add(id);

          if (!matchKeyword(body, keyword)) continue;

          matches.push({
            title: `Comment match: ${titleMatch[1]}`,
            link,
            keyword,
            preview: body.slice(0, 200),
          });
        }
      }
    } catch (err) {
      console.error("Error:", err);
    }
  }

  // snd batch emails collected 
  if (matches.length > 0) {
    const html = matches
      .map(
        (m) => `
        <li>
          <b>${m.keyword}</b> →
          <a href="${m.link}">${m.title}</a><br/>
          <small>${m.preview}...</small>
        </li>`
      )
      .join("");

    await resend.emails.send({
      from: `Notifications <${SENDING_EMAIL}>`,
      to: [EMAIL_TO],
      subject: `Reddit Alert (${matches.length} matches)`,
      html: `<h3>Keyword Matches</h3><ul>${html}</ul>`,
    });

    console.log("Summary email sent");
  } else {
    console.log("No matches");
  }
}

serve(async () => {
  await checkRedditAndSend();
  return new Response("Done");
});
