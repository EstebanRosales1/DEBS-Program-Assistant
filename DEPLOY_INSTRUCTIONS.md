# Medi-Cal Handbook Chatbot — Deployment Guide
## Deploy to Render.com (Free, No coding needed)

---

## What you need before starting
- A free account at **render.com** (sign up at render.com)
- A free account at **github.com** (sign up at github.com)
- Your Anthropic API key (from console.anthropic.com)

This will take about 15 minutes.

---

## STEP 1 — Upload the files to GitHub

GitHub stores your code online so Render can access it.

1. Go to **github.com** and sign in
2. Click the **+** button (top right) → "New repository"
3. Name it: `medi-cal-chat`
4. Make sure it's set to **Public**
5. Click **"Create repository"**
6. On the next page, click **"uploading an existing file"**
7. Drag and drop these files into the upload area:
   - `server.js`
   - `package.json`
   - The entire `public` folder (drag the whole folder)
8. Click **"Commit changes"**

---

## STEP 2 — Deploy on Render

1. Go to **render.com** and sign in
2. Click **"New +"** → **"Web Service"**
3. Click **"Connect a repository"**
4. Select your `medi-cal-chat` repository from GitHub
   *(You may need to click "Configure account" to give Render access to GitHub)*
5. Fill in these settings:
   - **Name:** `medi-cal-chat` (or anything you like)
   - **Region:** US West (Oregon) — or closest to you
   - **Branch:** `main`
   - **Runtime:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Instance Type:** `Free`
6. Click **"Create Web Service"**

Render will now build your app. This takes 2–3 minutes.

---

## STEP 3 — Add your API Key (Important!)

This is what connects your app to Claude.

1. In your Render dashboard, click on your `medi-cal-chat` service
2. Click **"Environment"** in the left sidebar
3. Click **"Add Environment Variable"**
4. Set:
   - **Key:** `ANTHROPIC_API_KEY`
   - **Value:** *(paste your Anthropic API key here — starts with sk-ant-)*
5. Click **"Save Changes"**
6. Render will automatically restart your app with the key

---

## STEP 4 — Get your URL

1. At the top of your Render service page you'll see a URL like:
   `https://medi-cal-chat.onrender.com`
2. Click it — your chatbot is live!
3. Share this URL with your coworkers

---

## Important notes

**Free tier sleep:** Render's free tier "sleeps" after 15 minutes of inactivity.
The first person to visit after a sleep will wait ~30 seconds for it to wake up.
This is normal — subsequent messages will be instant.

**To avoid sleep:** Render's $7/month "Starter" plan keeps it always on.

**Your API key is safe:** It's stored as a secret on Render's servers.
It never appears in the browser or in your code.

**API costs:** The Claude API is pay-as-you-go. Typical usage for a small team
costs a few dollars per month. Check console.anthropic.com for usage.

---

## Troubleshooting

**"Build failed"** — Check that all 3 files (server.js, package.json, public/index.html)
were uploaded to GitHub correctly.

**"API key not configured"** — Make sure you added the environment variable in Step 3
and that the app restarted after saving.

**App won't load** — Wait 2–3 minutes after deploying. First builds take time.

---

## Need to update the chatbot?

Edit the files in your GitHub repository. Render will automatically redeploy
within a minute or two whenever you save changes to GitHub.
