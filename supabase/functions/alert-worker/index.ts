import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "npm:resend";

const resend = new Resend(Deno.env.get("RESEND_API_KEY")!);
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SERVICE_ROLE_KEY")! 
);

serve(async () => {
 
  const { data: queue, error } = await supabase
    .from("alert_queue")
    .select("*")
    .eq("status", "pending")
    .limit(20); // Process bigger batches since we group them
    if (error) console.error("DATABASE ERROR:", error);

  if (error || !queue || queue.length === 0) {
    return new Response("No pending alerts to process.");
  }

  // 2. Group alerts by User + Keyword
  // Structure: { "user_id|keyword": [alert1, alert2, ...] }
  const batches: Record<string, typeof queue> = {};

  for (const item of queue) {
    const key = `${item.user_id}|${item.keyword_term}`;
    if (!batches[key]) batches[key] = [];
    batches[key].push(item);
  }

  // 3. Process each batch
  for (const key in batches) {
    const items = batches[key];
    const [userId, keyword] = key.split("|");
    const itemIds = items.map(i => i.id);

    // Set to processing
    await supabase.from("alert_queue").update({ status: "processing" }).in("id", itemIds);

    try {
      // Build HTML list of posts
      const postsHtml = items.map(item => `
        <div style="margin-bottom: 20px; border-bottom: 1px solid #eee; padding-bottom: 10px;">
          <p><b><a href="${item.post_data.url}" style="font-size: 16px;">${item.post_data.title}</a></b></p>
          <p style="color: #666; font-size: 14px;">${item.post_data.preview}...</p>
        </div>
      `).join("");

      // Send ONE email for the batch
      const { error: mailError } = await resend.emails.send({
        from: `Reddit Alert <${Deno.env.get("SENDING_EMAIL")}>`,
        to: ["paalsahil04@gmail.com"], // TODO: Fetch real user email from 'profiles' table using userId
        subject: `New Matches for: ${keyword} (${items.length})`,
        html: `
          <h3>${items.length} new matches found for "${keyword}"</h3>
          ${postsHtml}
          <p style="font-size: 12px; color: #999;">Only real post links included.</p>
        `
      });

      if (mailError) throw mailError;

      // Mark all in batch as sent
      await supabase.from("alert_queue").update({ status: "sent" }).in("id", itemIds);
      console.log(`Sent batch email for ${keyword} to user ${userId}`);

    } catch (err) {
      console.error(`Failed to send batch for ${key}:`, err);
      // Mark all in batch as failed so they can be retried or debugged
      await supabase.from("alert_queue").update({ status: "failed" }).in("id", itemIds);
    }
  }

  return new Response(`Processed ${queue.length} alerts into ${Object.keys(batches).length} emails.`);
});