# NSITE AI MCQ Generator

Faculty upload study material (PDF / DOCX / TXT), AI writes MCQs, faculty review and publish them to a department, students take timed quizzes, and faculty see every student's marks and reports.

**Stack:** Node.js + Express server, PostgreSQL database on Supabase, free Google Gemini AI (or demo mode), plain HTML/CSS/JS website served by the same server. Total cost: ₹0.

All files are in one flat folder on purpose, so you can upload them to GitHub from a phone.

---

## Setup (about 20 minutes, all in a phone browser)

### Step 1: Database (Supabase)
1. Go to supabase.com, sign up free, tap **New project**. Choose a name and a strong **database password** (save it!). Pick the region closest to you (e.g. Mumbai).
2. When the project is ready, tap **Connect** (top of the page) and copy the **Session pooler** connection string. It looks like  
   `postgresql://postgres.abcd:[YOUR-PASSWORD]@aws-0-ap-south-1.pooler.supabase.com:5432/postgres`  
   Replace `[YOUR-PASSWORD]` with your real password. This is your `DATABASE_URL`.  
   (Use the *Session pooler* one, not "Direct connection": Render cannot reach that one.)

You do **not** need to create tables. The server creates them automatically.

### Step 2: Free AI key (Google Gemini)
1. Open aistudio.google.com/apikey, sign in, tap **Create API key**, copy it. This is your `GEMINI_API_KEY`.
2. No key yet? Set `AI_MODE=mock` to try the site with simple demo questions.

### Step 3: Put the code on GitHub
1. Create a free account at github.com, tap **New repository**, name it `nsite-mcq`, create it.
2. Unzip this project on your phone. In the repository tap **Add file → Upload files**, select **all the files** from the unzipped folder (`server.js`, `ai.js`, `schema.sql`, `package.json`, `index.html`, `style.css`, `config.js`, `app.js`, `faculty.js`, `student.js`) and tap **Commit changes**.
   Do **not** upload any `.env` file with real passwords.

### Step 4: Run it on Render (free)
1. Go to render.com, sign up with GitHub, tap **New → Web Service**, and pick your `nsite-mcq` repository.
2. Settings: **Runtime** Node, **Build Command** `npm install`, **Start Command** `npm start`, **Instance type** Free.
3. Under **Environment Variables** add:

| Name | Value |
|---|---|
| `DATABASE_URL` | the Session pooler string from Step 1 |
| `JWT_SECRET` | any long random text (30+ characters) |
| `AI_MODE` | `gemini` (or `mock` for demo) |
| `GEMINI_API_KEY` | your key from Step 2 |
| `ADMIN_EMAIL` | the email you want for the administrator |
| `ADMIN_PASSWORD` | a strong password (8+ characters) |

4. Tap **Create Web Service**. After a few minutes you get an address like `https://nsite-mcq.onrender.com`. Open it: that is your website.

### Step 5: First use
1. Open **Faculty Login** → log in with `ADMIN_EMAIL` / `ADMIN_PASSWORD` to manage departments (menu: Departments), or **Register** a normal faculty account.
2. Faculty: Upload Study Material → Generate MCQs → review and save → Publish Quiz.
3. Students register on **Student Login → Register** and see quizzes of their department.

---

## Good to know
- **Free servers sleep.** Render's free service sleeps after ~15 minutes without visits; the first page load afterwards can take up to a minute. Supabase free projects pause after about a week of no use (restore with one tap in Supabase).
- **Scanned PDFs** (photos of pages) have no text and cannot be read. Use text-based PDFs, DOCX or TXT.
- **Source links** are saved as a reference only; the server does not download web pages.
- **Marks are calculated on the server.** The quiz page never receives the correct answers before submission.
- If a student closes the browser during a quiz, the saved answers are graded automatically after the time runs out.
- **Free AI limits:** if Gemini says the limit is reached, wait a minute and press Generate again.
- Quizzes are copied when published, so editing a question set later does not change a live quiz.
- "Delete" on a quiz **archives** it; student results are always kept.

## Running on a computer (optional)
```
npm install
cp .env.example .env     # then fill in the values
npm start                # open http://localhost:3000
```

## Hosting the website separately (optional)
If you host the website files on Netlify, put your Render address in `config.js` (`API_URL`) and set `FRONTEND_ORIGIN` on Render to your Netlify address.

## Roles and access rules (enforced on the server)
- **Student:** sees and starts only quizzes of their own department, only inside the start/end window, within the allowed attempts.
- **Faculty:** manages only their own materials, question sets and quizzes, and sees results only for their own quizzes.
- **Administrator:** can add/rename/delete departments and sees all quizzes and results.
