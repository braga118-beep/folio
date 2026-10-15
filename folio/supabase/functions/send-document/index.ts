// Supabase Edge Function: send-document
// Emails an estimate or invoice (or a payment reminder) to the customer through Resend,
// with a button that opens the customer page, plus an optional PDF attachment.
//
// Secrets required (set with `supabase secrets set ...`):
//   RESEND_API_KEY  your Resend API key
//   FROM_EMAIL      an address on a domain you verified in Resend, e.g. billing@yourcompany.com
//   APP_URL         where Folio is hosted, e.g. https://yourname.github.io/folio
// SUPABASE_URL and SUPABASE_ANON_KEY are provided automatically.

import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    const FROM_EMAIL = Deno.env.get("FROM_EMAIL");
    const APP_URL = (Deno.env.get("APP_URL") || "").replace(/\/+$/, "");
    if (!RESEND_API_KEY || !FROM_EMAIL || !APP_URL) {
      return json({ error: "Email isn't set up yet. Set RESEND_API_KEY, FROM_EMAIL and APP_URL as function secrets." }, 500);
    }

    // Act as the signed-in user so row level security applies.
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "You're signed out. Sign in again and retry." }, 401);

    const { document_id, to, subject, message, kind, pdf_base64, filename } = await req.json();
    if (!document_id || !to) return json({ error: "Missing document or recipient." }, 400);

    const { data: doc, error: docErr } = await supabase.from("documents").select("*").eq("id", document_id).single();
    if (docErr || !doc) return json({ error: "Document not found." }, 404);
    const { data: company } = await supabase.from("companies").select("*").eq("id", doc.company_id).single();
    if (!company) return json({ error: "Company not found." }, 404);

    const link = `${APP_URL}/view.html?t=${doc.public_token}`;
    const brand = /^#[0-9a-f]{3,8}$/i.test(company.color || "") ? company.color : "#1F4E46";
    const typeLabel = doc.type === "invoice" ? "invoice" : "estimate";
    const button = `View ${typeLabel} ${doc.number}`;
    const paragraphs = esc(message || "")
      .split(/\n{2,}/)
      .map((p) => `<p style="margin:0 0 16px">${p.replace(/\n/g, "<br>")}</p>`)
      .join("");

    const html = `<!doctype html><html><body style="margin:0;background:#E9ECEA;padding:32px 12px;font-family:Helvetica,Arial,sans-serif;color:#16202A">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td style="height:6px;background:${brand};font-size:0;line-height:0">&nbsp;</td></tr>
<tr><td style="padding:32px 36px 30px">
<div style="font-size:19px;font-weight:700;color:#16202A;margin-bottom:24px">${esc(company.name)}</div>
<div style="font-size:15px;line-height:1.6;color:#3A4652">${paragraphs}</div>
<a href="${link}" style="display:inline-block;background:${brand};color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;font-size:15px">${esc(button)}</a>
<p style="font-size:12px;color:#6B7682;margin:28px 0 0;line-height:1.5">If the button doesn't work, copy this link into your browser:<br><span style="word-break:break-all">${link}</span></p>
</td></tr></table>
<p style="font-size:12px;color:#6B7682;margin:16px 0 0">${esc([company.name, company.phone, company.email].filter(Boolean).join("  |  "))}</p>
</td></tr></table></body></html>`;

    const text = `${message || ""}\n\n${button}: ${link}`;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: `${company.name} <${FROM_EMAIL}>`,
        to: [to],
        reply_to: company.email || undefined,
        subject: subject || `${doc.type === "invoice" ? "Invoice" : "Estimate"} ${doc.number} from ${company.name}`,
        html,
        text,
        attachments: pdf_base64 ? [{ filename: filename || `${doc.number}.pdf`, content: pdf_base64 }] : undefined,
      }),
    });
    if (!res.ok) {
      const detail = await res.text();
      return json({ error: `The email service rejected the message: ${detail}` }, 502);
    }

    const now = new Date().toISOString();
    const patch: Record<string, unknown> = { last_sent_at: now, sent_at: doc.sent_at ?? now, updated_at: now };
    if (doc.status === "draft") patch.status = "sent";
    await supabase.from("documents").update(patch).eq("id", doc.id);
    await supabase.from("events").insert({ document_id: doc.id, kind: kind === "reminder" ? "reminder" : "sent", detail: to, seen: true });

    return json({ ok: true, link });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
