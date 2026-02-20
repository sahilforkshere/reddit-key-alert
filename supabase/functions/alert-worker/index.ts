import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "npm:resend";

const resend = new Resend(Deno.env.get("RESEND_API_KEY")!);

// Uses the Service Role Key to bypass RLS
const supabase = createClient(
  Deno.env.get("PROJECT_URL")!,
  Deno.env.get("EY_SECRET_KEY")! 
);

serve(async () => {
  console.log("Worker started...");

  // 1. Fetch 'pending' alerts from the queue
  const { data: queue, error } = await supabase
    .from("alert_queue")
    .select("*")
    .eq("status", "pending")
    .limit(50); 

  if (error) {
    console.error("DB Error fetching queue:", error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  if (!queue || queue.length === 0) {
    return new Response("No pending alerts to process.", { status: 200 });
  }

  // 2. Group alerts by "User + Keyword"
  const batches: Record<string, typeof queue> = {};
  for (const item of queue) {
    const key = `${item.user_id}|${item.keyword_term}`;
    if (!batches[key]) batches[key] = [];
    batches[key].push(item);
  }

  // 3. Process each batch and Send Emails
  let sentCount = 0;

  for (const key in batches) {
    const items = batches[key];
    const [userId, keywordTerm] = key.split("|");
    const itemIds = items.map(i => i.id);

    // Fetch from the public 'profiles' table
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('email')
      .eq('id', userId)
      .single();

    if (profileError || !profile || !profile.email) {
       console.error(`❌ Profile/Email for user ${userId} not found.`);
       await supabase.from("alert_queue").update({ status: "failed" }).in("id", itemIds);
       continue;
    }

    const recipientEmail = profile.email;

    // Mark as processing
    await supabase.from("alert_queue").update({ status: "processing" }).in("id", itemIds);

    try {
      const postsHtml = items.map(item => `
        <div style="margin-bottom: 15px; border-bottom: 1px solid #eee; padding-bottom: 10px;">
          <a href="${item.post_data.url}" style="font-size: 16px; font-weight: bold; color: #0070f3; text-decoration: none;">
            ${item.post_data.title}
          </a>
          <div style="color: #555; font-size: 14px; margin-top: 5px;">
            ${item.post_data.preview || "No preview available"}...
          </div>
        </div>
      `).join("");

      const { error: mailError } = await resend.emails.send({
        from: `Reddit Alert <${Deno.env.get("SENDING_EMAIL")}>`, 
        to: [recipientEmail], 
        subject: `New Matches: "${keywordTerm}" (${items.length} posts)`,
        html: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>${items.length} new matches for "<b>${keywordTerm}</b>"</h2>
            <p style="color: #666;">Here are the latest posts found on Reddit:</p>
            <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
            ${postsHtml}
            <p style="font-size: 12px; color: #999; margin-top: 30px;">
              You are receiving this because you subscribed to alerts for "${keywordTerm}".
            </p>
          </div>
        `
      });

      if (mailError) throw mailError;

      // Mark batch as SENT
      await supabase.from("alert_queue").update({ status: "sent" }).in("id", itemIds);
      console.log(`✅ Email sent to ${recipientEmail} for '${keywordTerm}'`);
      sentCount++;

    } catch (err) {
      console.error(`❌ Failed to send email to ${recipientEmail}:`, err);
      await supabase.from("alert_queue").update({ status: "failed" }).in("id", itemIds);
    }
  }

  return new Response(`Processed ${queue.length} alerts. Sent ${sentCount} emails.`, {
    headers: { "Content-Type": "application/json" },
  });
});