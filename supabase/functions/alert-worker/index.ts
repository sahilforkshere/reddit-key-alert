import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "npm:resend";

const resend = new Resend(Deno.env.get("RESEND_API_KEY")!);

// CRITICAL: You must use the Service Role Key to look up user emails
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("MY_SB_SECRET")! // This might be named MY_SB_SECRET in your dashboard
);

serve(async () => {
  console.log("Worker started...");

  // 1. Fetch 'pending' alerts from the queue
  const { data: queue, error } = await supabase
    .from("alert_queue")
    .select("*")
    .eq("status", "pending")
    .limit(50); // Process up to 50 at a time

  if (error) {
    console.error("DB Error:", error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  if (!queue || queue.length === 0) {
    return new Response("No pending alerts to process.", { status: 200 });
  }

  // 2. Group alerts by "User + Keyword"
  // This ensures a user gets 1 email per keyword, even if there are 10 matches
  const batches: Record<string, typeof queue> = {};

  for (const item of queue) {
    // Create a unique key for grouping: "userID|keyword"
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

    // --- CRITICAL STEP: Fetch the User's REAL Email ---
    // We use the Admin API to look up the user in the hidden auth table
    const { data: { user }, error: userError } = await supabase.auth.admin.getUserById(userId);

    if (userError || !user || !user.email) {
      console.error(`User ${userId} not found or has no email. Skipping.`);
      // Mark as failed so we don't retry endlessly
      await supabase.from("alert_queue").update({ status: "failed" }).in("id", itemIds);
      continue;
    }

    const recipientEmail = user.email; // <--- The Customer's Email
    // -----------------------------------------------------

    // Mark as processing
    await supabase.from("alert_queue").update({ status: "processing" }).in("id", itemIds);

    try {
      // Build the list of posts for the email
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

      // Send the email to the CUSTOMER
      const { error: mailError } = await resend.emails.send({
        from: `Reddit Alert <${Deno.env.get("SENDING_EMAIL")}>`, 
        to: [recipientEmail], // <--- Dynamic Recipient (Sends to the user)
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

      if (mailError) {
        console.error(`Resend Error for ${recipientEmail}:`, mailError);
        throw mailError;
      }

      // Mark batch as SENT
      await supabase.from("alert_queue").update({ status: "sent" }).in("id", itemIds);
      console.log(`✅ Email sent to ${recipientEmail} for '${keywordTerm}'`);
      sentCount++;

    } catch (err) {
      console.error(`Failed to send email batch to ${recipientEmail}:`, err);
      // Mark as failed to allow retry or debugging
      await supabase.from("alert_queue").update({ status: "failed" }).in("id", itemIds);
    }
  }

  return new Response(`Processed ${queue.length} alerts. Sent ${sentCount} emails.`, {
    headers: { "Content-Type": "application/json" },
  });
});