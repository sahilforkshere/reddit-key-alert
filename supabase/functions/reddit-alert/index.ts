import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';


const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SERVICE_ROLE_KEY')! 
);

function matchKeyword(text: string, keyword: string, wholeWord: boolean): boolean {
  if (!text) return false;
  text = text.toLowerCase();
  keyword = keyword.toLowerCase();
  if (!wholeWord) return text.includes(keyword);
  const regex = new RegExp(`\\b${keyword}\\b`, "i");
  return regex.test(text);
}

async function checkRedditAndQueue() {
  // 1. Fetch & Lock Keywords that need scanning 
  const { data: keywords } = await supabase
    .from('keywords')
    .select('*')
    .or(`locked_until.is.null,locked_until.lt.${new Date().toISOString()}`)
    .limit(5); // Process in small batches for stability

  if (!keywords) return;

  for (const kw of keywords) {
    // Lock the keyword for 5 minutes 
    await supabase.from('keywords').update({ 
      locked_until: new Date(Date.now() + 300000).toISOString() 
    }).eq('id', kw.id);

    try {
      // 2. Scan Reddit (Global Scan)
      const res = await fetch(`https://www.reddit.com/search.rss?q=${encodeURIComponent(kw.term)}&sort=new`, {
        headers: { "User-Agent": "Mozilla/5.0 (RedditKeywordBot)" }
      });
      const xml = await res.text();
      const entries = xml.split("<entry>").slice(1);

      // 3. Find all users tracking this keyword 
      const { data: subs } = await supabase
        .from('user_keywords')
        .select('user_id, whole_word_enabled, match_posts, match_comments')
        .eq('keyword_id', kw.id)
        .eq('is_active', true)
        .eq('delete_factor', false);

      if (subs && subs.length > 0 && entries.length > 0) {
        const queueEntries = [];

        for (const entry of entries) {
          const title = entry.match(/<title>(.*?)<\/title>/)?.[1] || "";
          const link = entry.match(/<link href="(.*?)"/)?.[1] || "";
          const content = entry.match(/<!\[CDATA\[(.*?)\]\]>/)?.[1] || "";
          const cleanPreview = content.replace(/<[^>]*>/g, "").trim().slice(0, 200);

          // 4. Fan-Out: Filter matches per user preference and add to Queue 
          for (const s of subs) {
            const isTitleMatch = s.match_posts && matchKeyword(title, kw.term, s.whole_word_enabled);
            const isContentMatch = s.match_comments && matchKeyword(cleanPreview, kw.term, s.whole_word_enabled);

            if (isTitleMatch || isContentMatch) {
              queueEntries.push({
                user_id: s.user_id,
                keyword_term: kw.term,
                post_data: { title, url: link, preview: cleanPreview },
                status: 'pending' // Buffer for the alert-worker 
              });
            }
          }
        }

        if (queueEntries.length > 0) {
          await supabase.from('alert_queue').insert(queueEntries);
        }
      }
    } catch (err) {
      console.error(`Error scanning ${kw.term}:`, err);
    }

    // 5. Unlock Keyword 
    await supabase.from('keywords').update({ locked_until: null }).eq('id', kw.id);
  }
}

serve(async () => {
  await checkRedditAndQueue();
  return new Response("Scanner Finished & Queue Updated");
});