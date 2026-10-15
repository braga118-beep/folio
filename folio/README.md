# Folio: estimates and invoices

Create estimates and invoices for one or more companies, email them to customers, see when they're opened, let customers accept estimates online, and track payments.

## What's in the folder

| File | Purpose |
| --- | --- |
| `index.html` | The app you use |
| `view.html` | The page your customer sees when they open the emailed link |
| `app.js`, `render.js`, `data.js`, `styles.css` | App code and styling |
| `config.js` | Where you paste your Supabase keys |
| `supabase/schema.sql` | Database tables, security rules and view tracking |
| `supabase/functions/send-document/index.ts` | Sends the emails |

## 1. Try it first (demo mode)

With `config.js` left empty, Folio runs in demo mode. Data is saved in your browser, sample data is included, and no email is sent.

Run a small local web server from the folder, then open the app:

```
cd folio
python -m http.server 8000
```

Open http://localhost:8000. To test view notifications, open an estimate, click **Send**, then click **Open customer page** in the message that appears. Accept the estimate on that page and switch back to the app tab.

## 2. Create the database (Supabase, free tier)

1. Create a project at https://supabase.com.
2. Open **SQL Editor**, paste the contents of `supabase/schema.sql` and click **Run**.
3. Open **Project Settings > API** and copy the **Project URL** and the **anon public** key into `config.js`.
4. In **Authentication > URL Configuration**, set **Site URL** to the address where you'll host Folio (step 4).

## 3. Set up email (Resend, free tier)

1. Create an account at https://resend.com and verify the domain you'll send from. Customers are more likely to receive mail from your own domain than from a free address.
2. Create an API key.
3. Install the Supabase CLI (https://supabase.com/docs/guides/cli), then from the `folio` folder run:

```
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase secrets set RESEND_API_KEY=re_xxx FROM_EMAIL=billing@yourdomain.com APP_URL=https://your-site-address
supabase functions deploy send-document
```

`APP_URL` is the address where Folio is hosted, without a trailing slash. The emailed button links to `APP_URL/view.html`. Replies from customers go to the email address on the company profile.

## 4. Host the app

The app is static files, so any static host works:

- **GitHub Pages:** push the folder to a repository, then go to **Settings > Pages** and deploy from the main branch.
- **Netlify or Cloudflare Pages:** drag the folder into a new site.

Open the site, create your account, and Folio asks for your company details first.

## How tracking works

Each estimate and invoice gets a private, unguessable link. The email includes a button to that link. When your customer opens it, Folio records the view, marks the document **Viewed**, and notifies you in the app (bell icon and a pop-up). You can also turn on desktop notifications in **Settings**. Refreshing the page within 30 minutes doesn't send another notification.

Use **Open as customer** in the app to see the customer page without it counting as a view.

Folio doesn't use hidden tracking pixels in emails. Many email apps block or pre-load those, so link opens are the more reliable signal.

## Good to know

- Each sign-in account sees only its own companies, customers and documents.
- Logos are resized and stored with the company record. Keep them simple and small.
- Long documents are split across PDF pages automatically. A page break can fall in the middle of a line item.
- Online payments (PayPal, Zelle, Venmo) aren't included. Put your payment details in the company's **How to pay** field so they appear on every invoice, and record payments when they arrive.
