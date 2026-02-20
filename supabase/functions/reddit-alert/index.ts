import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabaseUrl = Deno.env.get('PROJECT_URL')!;
const adminKey = Deno.env.get('EY_SECRET_KEY')!;
const supabase = createClient(supabaseUrl, adminKey);

function isMatch(text: string, keyword: string, wholeWord: boolean): boolean {
  if (!text) return false;
  const cleanText = text.toLowerCase();
  const cleanKeyword = keyword.toLowerCase();

  if (wholeWord) {
    const escaped = cleanKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`, "i");
    return regex.test(cleanText);
  }
  return cleanText.includes(cleanKeyword);
}

serve(async () => {
  console.log("Starting Scan Cycle...");

  const { data: keywords, error: fetchError } = await supabase
    .from('keywords')
    .select('*')
    .or(`locked_until.is.null,locked_until.lt.${new Date().toISOString()}`)
    .limit(5);

  if (fetchError) console.error("DB Error fetching keywords:", fetchError);
  if (!keywords || keywords.length === 0) return new Response("No keywords to scan.");

  for (const kw of keywords) {
    await supabase.from('keywords').update({ 
      locked_until: new Date(Date.now() + 300000).toISOString() 
    }).eq('id', kw.id);

    try {
      const res = await fetch(`https://www.reddit.com/search.rss?q=${encodeURIComponent(kw.term)}&sort=new`, {
        headers: { 
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" 
        }
      });
      
      if (!res.ok) throw new Error(`Reddit API Error: ${res.status} ${res.statusText}`);

      const xml = await res.text();
      const entries = xml.split("<entry>").slice(1);

      let newestId = null;
      for (const entry of entries) {
        const idMatch = entry.match(/<id>(?:.*\/)?(t3_[a-z0-9]+)<\/id>/i);
        if (idMatch) {
            newestId = idMatch[1];
            break; 
        }
      }

      if (newestId) {
        console.log(`Found newest ID for ${kw.term}: ${newestId}`);

        if (entries.length > 0) {
            // Fetch subscribers (removed missing columns)
            const { data: subs, error: subsError } = await supabase
              .from('user_keywords')
              .select('user_id') 
              .eq('keyword_id', kw.id)
              .eq('is_active', true)
              .eq('delete_factor', false);

            if (subsError) console.error(`❌ DB Error fetching subs for ${kw.term}:`, subsError);
            console.log(`👥 Found ${subs?.length || 0} active subscribers for ${kw.term}`);

            if (subs && subs.length > 0) {
              const queueEntries = [];
              for (const entry of entries) {
                const entryId = entry.match(/<id>(?:.*\/)?(t3_[a-z0-9]+)<\/id>/i)?.[1];
                if (!entryId) continue;
                
                if (kw.last_reddit_id && entryId === kw.last_reddit_id) break;

                const title = entry.match(/<title>(.*?)<\/title>/)?.[1] || "";
                const linkMatch = entry.match(/<link href="(.*?comments.*?)"/);
                const link = linkMatch ? linkMatch[1] : ""; 

                if (!link) continue; 

                for (const s of subs) {
                  // Hardcoded match_posts to true, whole_word to false
                  const titleMatch = isMatch(title, kw.term, false); 
                  const urlMatch = isMatch(link, kw.term, false);

                  if (titleMatch || urlMatch) {
                    queueEntries.push({
                      user_id: s.user_id,
                      keyword_term: kw.term,
                      post_data: { title, url: link, preview: "..." },
                      status: 'pending'
                    });
                  }
                }
              }

              if (queueEntries.length > 0) {
                const { error: insertError } = await supabase.from('alert_queue').insert(queueEntries);
                if (insertError) {
                   console.error("❌ Failed to insert into alert_queue. RLS might be blocking this!", insertError);
                } else {
                   console.log(`✅ Queued ${queueEntries.length} alerts.`);
                }
              }
            }
        }

        if (newestId !== kw.last_reddit_id) {
            console.log(`SAVING CURSOR: ${kw.term} -> ${newestId}`);
            await supabase.from('keywords').update({ 
                last_reddit_id: newestId, 
                locked_until: null 
            }).eq('id', kw.id);
        } else {
            await supabase.from('keywords').update({ locked_until: null }).eq('id', kw.id);
        }

      } else {
        console.log(`No valid posts found for ${kw.term}`);
        await supabase.from('keywords').update({ locked_until: null }).eq('id', kw.id);
      }
    } catch (err) {
      console.error(`Error scanning ${kw.term}:`, err);
      await supabase.from('keywords').update({ locked_until: null }).eq('id', kw.id);
    }
  }

  return new Response("Scanner Finished.");
});