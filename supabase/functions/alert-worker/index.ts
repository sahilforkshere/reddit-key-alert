import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "npm:resend";

const resend = new Resend(Deno.env.get("RESEND_API_KEY")!);

const supabase = createClient(
  Deno.env.get("PROJECT_URL")!,
  Deno.env.get("EY_SECRET_KEY")!
);

serve(async () => {
  console.log("🚀 Worker started");

  /* -------------------------
     1️⃣ Fetch & LOCK queue
  ------------------------- */
  const { data: queue, error } = await supabase
    .from("alert_queue")
    .select("*")
    .eq("status", "pending")
    .limit(500);

  if (error || !queue?.length) {
    return new Response("No alerts.");
  }

  const allIds = queue.map(q => q.id);

  // Lock them immediately (prevents duplicate worker sending)
  await supabase
    .from("alert_queue")
    .update({ status: "processing" })
    .in("id", allIds);

  /* -------------------------
     2️⃣ Batch fetch emails
  ------------------------- */
  const userIds = [...new Set(queue.map(q => q.user_id))];

  const { data: profiles } = await supabase
    .from("profiles")
    .select("id, email")
    .in("id", userIds);

  const emailMap = Object.fromEntries(
    profiles?.map(p => [p.id, p.email]) || []
  );

  /* -------------------------
     3️⃣ Group alerts
  ------------------------- */
  const batches: Record<string, typeof queue> = {};

  for (const item of queue) {
    const key = `${item.user_id}|${item.keyword_term}`;
    if (!batches[key]) batches[key] = [];
    batches[key].push(item);
  }

  const sentIds: string[] = [];
  const failedIds: string[] = [];

  /* -------------------------
     4️⃣ Send emails
  ------------------------- */
  for (const key in batches) {
    const items = batches[key];
    const [userId, keywordTerm] = key.split("|");
    const recipientEmail = emailMap[userId];

    if (!recipientEmail) {
      failedIds.push(...items.map(i => i.id));
      continue;
    }

    try {
      const postsHtml = items.map(item => `
        <div style="margin-bottom:12px">
          <a href="${item.post_data.url}" style="font-weight:bold;">
            ${item.post_data.title}
          </a>
        </div>
      `).join("");

      await resend.emails.send({
        from: `Reddit Alerts <${Deno.env.get("SENDING_EMAIL")}>`,
        to: [recipientEmail],
        subject: `New matches for "${keywordTerm}" (${items.length})`,
        html: `
          <div style="font-family:sans-serif">
            <h3>${items.length} new matches for "${keywordTerm}"</h3>
            ${postsHtml}
          </div>
        `
      });

      sentIds.push(...items.map(i => i.id));
      console.log(`✅ Sent to ${recipientEmail}`);

    } catch (err) {
      console.error("Mail failed:", err);
      failedIds.push(...items.map(i => i.id));
    }
  }

  /* -------------------------
     5️⃣ Bulk update results
  ------------------------- */
  if (sentIds.length)
    await supabase
      .from("alert_queue")
      .update({ status: "sent" })
      .in("id", sentIds);

  if (failedIds.length)
    await supabase
      .from("alert_queue")
      .update({ status: "failed" })
      .in("id", failedIds);

  return new Response(
    `Processed ${queue.length}. Sent: ${sentIds.length}, Failed: ${failedIds.length}`
  );
});