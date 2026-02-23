import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import AhoCorasick from "https://esm.sh/aho-corasick";

const supabase = createClient(
  Deno.env.get("PROJECT_URL")!,
  Deno.env.get("EY_SECRET_KEY")!
);

// Reddit requires a highly specific User-Agent. Do not use generic names.
const reqHeaders = { 
  "User-Agent": "web:my-keyword-monitor:v1.0 (by /u/YourRedditUsername)" 
};

serve(async () => {
  console.log("🚀 High-Volume Scanner started");

  /* --------------------------
     1️⃣ Load keywords & Aho-Corasick
  -------------------------- */
  const { data: keywords, error: kwError } = await supabase
    .from("keywords")
    .select("id, term");

  if (kwError || !keywords?.length) {
    console.log("No keywords found.");
    return new Response("No keywords.");
  }

  const keywordMap = new Map();
  keywords.forEach(k => keywordMap.set(k.term.toLowerCase(), k.id));
  
  // Initialize Aho-Corasick tree for O(1) scanning
  const ac = new AhoCorasick(keywords.map(k => k.term.toLowerCase()));

  /* --------------------------
     2️⃣ Load & Parse Global Cursors
  -------------------------- */
  const { data: state } = await supabase
    .from("system_state")
    .select("global_reddit_cursor")
    .single();

  let lastPostId = "";
  let lastCommentId = "";

  // composite cursor (e.g., "t3_abc12,t1_xyz89")
  if (state?.global_reddit_cursor?.includes(",")) {
    [lastPostId, lastCommentId] = state.global_reddit_cursor.split(",");
  } else {
    // Fetch the single latest post and comment if no cursors exist
    const [postRes, commentRes] = await Promise.all([
      fetch("https://www.reddit.com/r/all/new/.json?limit=1", { headers: reqHeaders }),
      fetch("https://www.reddit.com/r/all/comments/.json?limit=1", { headers: reqHeaders })
    ]);

    // Graceful error handling to prevent the "Unexpected token '<'" crash
    if (!postRes.ok || !commentRes.ok) {
      console.error(`Reddit Blocked! Post Status: ${postRes.status}, Comment Status: ${commentRes.status}`);
      return new Response("Reddit API error during primer fetch. Check logs.", { status: 502 });
    }

    const postJson = await postRes.json();
    const commentJson = await commentRes.json();
    
    lastPostId = postJson.data.children[0].data.name; // Use .name to get the t3_ prefix natively
    lastCommentId = commentJson.data.children[0].data.name; // Use .name to get the t1_ prefix natively
  }

  // Convert Base-36 to Decimal for math
  let currentPostDec = parseInt(lastPostId.replace("t3_", ""), 36);
  let currentCommentDec = parseInt(lastCommentId.replace("t1_", ""), 36);
  
  let highestPostId = lastPostId;
  let highestCommentId = lastCommentId;

  /* --------------------------
     3️⃣ Fetch Firehose in Batches
  -------------------------- */
  const allPosts: any[] = [];
  const fetchPromises = [];

  // Launch 20 concurrent requests, asking for 100 items each
  for (let batch = 0; batch < 20; batch++) {
    const ids: string[] = [];
    
    // Mix 50 posts and 50 comments per API call = 100 IDs total
    for (let i = 0; i < 50; i++) {
      currentPostDec++;
      currentCommentDec++;
      ids.push(`t3_${currentPostDec.toString(36)}`); // Post ID
      ids.push(`t1_${currentCommentDec.toString(36)}`); // Comment ID
    }

    const url = `https://api.reddit.com/api/info.json?id=${ids.join(",")}`;
    
    fetchPromises.push(
      fetch(url, { headers: reqHeaders })
        .then(async (res) => {
          if (!res.ok) {
            console.log(`Batch rate-limited or failed: ${res.status}`);
            return null; // Fail gracefully for this specific batch
          }
          // Ensure it's actually JSON before parsing
          const contentType = res.headers.get("content-type");
          if (contentType && contentType.includes("application/json")) {
            return res.json();
          }
          return null;
        })
        .catch(() => null)
    );
  }

  // Wait for all requests to finish and flatten the results
  const results = await Promise.all(fetchPromises);
  results.forEach(json => {
    if (json?.data?.children) allPosts.push(...json.data.children);
  });

  console.log(`Fetched ${allPosts.length} total items (posts + comments)`);
  
  if (!allPosts.length) {
    return new Response("No new posts retrieved. Check rate limits.");
  }

  /* --------------------------
     4️⃣ Load Active Subscribers
  -------------------------- */
  const { data: allSubs } = await supabase
    .from("user_keywords")
    .select("user_id, keyword_id")
    .eq("is_active", true)
    .eq("delete_factor", false);

  const subsByKeyword = new Map();
  allSubs?.forEach(s => {
    if (!subsByKeyword.has(s.keyword_id)) subsByKeyword.set(s.keyword_id, []);
    subsByKeyword.get(s.keyword_id).push(s.user_id);
  });

  /* --------------------------
     5️⃣ Scan Posts & Comments
  -------------------------- */
  const queueEntries: any[] = [];

  for (const item of allPosts) {
    const data = item.data;
    const isComment = item.kind === "t1"; 
    
    // Track highest IDs to update the cursor later
    const idDec = parseInt(data.id, 36);
    if (isComment && idDec > parseInt(highestCommentId.replace("t1_", ""), 36)) {
      highestCommentId = item.data.name || `t1_${data.id}`;
    } else if (!isComment && idDec > parseInt(highestPostId.replace("t3_", ""), 36)) {
      highestPostId = item.data.name || `t3_${data.id}`;
    }

    // Combine relevant text fields
    const textTarget = isComment 
      ? `${data.body || ""}` 
      : `${data.title || ""} ${data.selftext || ""}`;
      
    const matches = ac.search(textTarget.toLowerCase());
    if (!matches.length) continue;

    const matchedTerms = [...new Set(matches.map(m => m[0]))];

    for (const term of matchedTerms) {
      const keywordId = keywordMap.get(term);
      if (!keywordId) continue;

      const users = subsByKeyword.get(keywordId);
      if (!users?.length) continue;

      for (const userId of users) {
        queueEntries.push({
          user_id: userId,
          keyword_term: term,
          post_data: {
            title: isComment ? `Comment mentioning "${term}"` : data.title,
            url: `https://www.reddit.com${data.permalink}`,
            permalink: data.permalink
          },
          status: "pending"
        });
      }
    }
  }

  /* --------------------------
     6️⃣ Batch Insert Alerts
  -------------------------- */
  if (queueEntries.length) {
    const { error } = await supabase.from("alert_queue").insert(queueEntries);
    if (error) console.log("Insert error:", error);
    else console.log(`Queued ${queueEntries.length} alerts!`);
  }

  /* --------------------------
     7️⃣ Save Composite Cursor
  -------------------------- */
  const newCompositeCursor = `${highestPostId},${highestCommentId}`;
  await supabase
    .from("system_state")
    .update({ global_reddit_cursor: newCompositeCursor })
    .eq("id", 1);

  return new Response(`Processed ${allPosts.length} items. New cursor: ${newCompositeCursor}`);
});