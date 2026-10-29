require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { Pool } = require('pg');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const { generateMCQs, isMock } = require('./ai');

const PORT = process.env.PORT || 3000;
const PASS_MARK = 40; // percent, used only in analytics
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 16) {
  JWT_SECRET = require('crypto').randomBytes(32).toString('hex');
  console.warn('WARNING: JWT_SECRET is missing or short. Using a temporary one; everyone is logged out on every restart.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false },
  max: 8,
});
const q = (text, params) => pool.query(text, params).then((r) => r.rows);
async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const r = await fn(c);
    await c.query('commit');
    return r;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

const httpErr = (status, message) => Object.assign(new Error(message), { status });
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const intOrNull = (v) => (/^\d+$/.test(String(v || '')) ? parseInt(v, 10) : null);
const escLike = (s) => '%' + String(s).replace(/[\\%_]/g, (m) => '\\' + m) + '%';

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));
const origins = (process.env.FRONTEND_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors(origins.length ? { origin: origins } : {}));
app.use(express.json({ limit: '1mb' }));
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false }));

// ---------- auth ----------
const USER_SQL = `select u.id,u.role,u.full_name,u.email,u.department_id,u.roll_number,d.name as department_name
  from users u left join departments d on d.id=u.department_id`;

async function session(id) {
  const user = (await q(USER_SQL + ' where u.id=$1', [id]))[0];
  const token = jwt.sign({ id }, JWT_SECRET, { expiresIn: '7d' });
  return { token, user };
}

function auth(...roles) {
  return ah(async (req, res, next) => {
    const h = req.headers.authorization || '';
    const t = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!t) throw httpErr(401, 'Please log in.');
    let p;
    try {
      p = jwt.verify(t, JWT_SECRET);
    } catch (e) {
      throw httpErr(401, 'Session expired. Please log in again.');
    }
    const u = (await q(USER_SQL + ' where u.id=$1', [p.id]))[0];
    if (!u) throw httpErr(401, 'Account not found. Please log in again.');
    if (roles.length && !roles.includes(u.role)) throw httpErr(403, 'You do not have access to this.');
    req.user = u;
    next();
  });
}
const staff = auth('faculty', 'admin');
const ownerId = (req) => (req.user.role === 'admin' ? null : req.user.id); // null = admin sees everything

app.get('/api/health', (req, res) => res.json({ ok: true, ai: isMock() ? 'mock' : 'gemini' }));
app.get('/api/departments', ah(async (req, res) => res.json(await q('select id,name from departments order by id'))));

app.post('/api/auth/register', ah(async (req, res) => {
  const { role, full_name, email, password, department_id, roll_number } = req.body || {};
  if (!['student', 'faculty'].includes(role)) throw httpErr(400, 'Invalid account type.');
  const name = String(full_name || '').trim();
  const mail = String(email || '').trim().toLowerCase();
  const roll = String(roll_number || '').trim();
  const dept = intOrNull(department_id);
  if (name.length < 2 || name.length > 100) throw httpErr(400, 'Please enter your full name.');
  if (!/^\S+@\S+\.\S+$/.test(mail)) throw httpErr(400, 'Please enter a valid email address.');
  if (String(password || '').length < 8) throw httpErr(400, 'Password must be at least 8 characters.');
  if (!dept) throw httpErr(400, 'Please select your department.');
  if (role === 'student' && (!roll || roll.length > 30)) throw httpErr(400, 'Please enter your roll number.');
  if (!(await q('select 1 from departments where id=$1', [dept])).length) throw httpErr(400, 'Unknown department.');
  try {
    const hash = await bcrypt.hash(String(password), 10);
    const r = (await q(
      'insert into users(role,full_name,email,password_hash,department_id,roll_number) values($1,$2,$3,$4,$5,$6) returning id',
      [role, name, mail, hash, dept, role === 'student' ? roll : null]
    ))[0];
    res.json(await session(r.id));
  } catch (e) {
    if (e.code === '23505') {
      throw httpErr(409, String(e.constraint || '').includes('roll') ? 'This roll number is already registered in your department.' : 'This email is already registered. Please log in.');
    }
    throw e;
  }
}));

app.post('/api/auth/login', ah(async (req, res) => {
  const { email, password, role } = req.body || {};
  const u = (await q('select id,role,password_hash from users where email=$1', [String(email || '').trim().toLowerCase()]))[0];
  const ok = u && (await bcrypt.compare(String(password || ''), u.password_hash));
  if (!ok) throw httpErr(401, 'Wrong email or password.');
  if (role === 'student' && u.role !== 'student') throw httpErr(403, 'This is a faculty account. Please use Faculty Login.');
  if (role === 'faculty' && u.role === 'student') throw httpErr(403, 'This is a student account. Please use Student Login.');
  res.json(await session(u.id));
}));

app.get('/api/me', auth(), (req, res) => res.json(req.user));
app.put('/api/me', auth(), ah(async (req, res) => {
  const name = String((req.body || {}).full_name || '').trim();
  if (name.length < 2 || name.length > 100) throw httpErr(400, 'Please enter a valid name.');
  await q('update users set full_name=$1 where id=$2', [name, req.user.id]);
  res.json(await session(req.user.id));
}));
app.put('/api/me/password', auth(), ah(async (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (String(new_password || '').length < 8) throw httpErr(400, 'New password must be at least 8 characters.');
  const u = (await q('select password_hash from users where id=$1', [req.user.id]))[0];
  if (!(await bcrypt.compare(String(current_password || ''), u.password_hash))) throw httpErr(400, 'Current password is wrong.');
  await q('update users set password_hash=$1 where id=$2', [await bcrypt.hash(String(new_password), 10), req.user.id]);
  res.json({ ok: true });
}));

// ---------- admin: departments ----------
const adminOnly = auth('admin');
const deptName = (v) => {
  const n = String((v || {}).name || '').trim();
  if (n.length < 2 || n.length > 100) throw httpErr(400, 'Enter a department name (2-100 characters).');
  return n;
};
app.post('/api/admin/departments', adminOnly, ah(async (req, res) => {
  try {
    res.json((await q('insert into departments(name) values($1) returning id,name', [deptName(req.body)]))[0]);
  } catch (e) {
    if (e.code === '23505') throw httpErr(409, 'That department already exists.');
    throw e;
  }
}));
app.put('/api/admin/departments/:id', adminOnly, ah(async (req, res) => {
  try {
    const r = await q('update departments set name=$1 where id=$2 returning id,name', [deptName(req.body), intOrNull(req.params.id)]);
    if (!r.length) throw httpErr(404, 'Department not found.');
    res.json(r[0]);
  } catch (e) {
    if (e.code === '23505') throw httpErr(409, 'That department already exists.');
    throw e;
  }
}));
app.delete('/api/admin/departments/:id', adminOnly, ah(async (req, res) => {
  try {
    await q('delete from departments where id=$1', [intOrNull(req.params.id)]);
    res.json({ ok: true });
  } catch (e) {
    if (e.code === '23503') throw httpErr(409, 'This department is in use by users or quizzes and cannot be deleted.');
    throw e;
  }
}));

// ---------- faculty: study materials ----------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, f, cb) => cb(/\.(pdf|docx|txt)$/i.test(f.originalname) ? null : httpErr(400, 'Only PDF, DOCX and TXT files are allowed.'), /\.(pdf|docx|txt)$/i.test(f.originalname)),
});

async function extractText(f) {
  const n = f.originalname.toLowerCase();
  if (n.endsWith('.pdf')) {
    if (f.buffer.slice(0, 4).toString() !== '%PDF') throw new Error('bad pdf');
    return (await pdfParse(f.buffer)).text;
  }
  if (n.endsWith('.docx')) {
    if (f.buffer.slice(0, 2).toString() !== 'PK') throw new Error('bad docx');
    return (await mammoth.extractRawText({ buffer: f.buffer })).value;
  }
  return f.buffer.toString('utf8');
}

app.post('/api/materials', staff, upload.single('file'), ah(async (req, res) => {
  const b = req.body || {};
  const subject = String(b.subject || '').trim().slice(0, 120);
  const topic = String(b.topic || '').trim().slice(0, 200);
  const link = String(b.link || '').trim().slice(0, 500);
  const dept = intOrNull(b.department_id);
  if (!subject) throw httpErr(400, 'Please enter the subject name.');
  if (!dept) throw httpErr(400, 'Please select the department.');
  if (link && !/^https?:\/\//i.test(link)) throw httpErr(400, 'The source link must start with http:// or https://');
  let text = '';
  let filename = null;
  if (req.file) {
    filename = req.file.originalname.slice(0, 200);
    try {
      text = (await extractText(req.file)).replace(/\u0000/g, '').trim();
    } catch (e) {
      throw httpErr(400, 'Could not read this file. Make sure it is a real, unprotected PDF, DOCX or TXT file.');
    }
    if (text.length < 50) throw httpErr(400, 'No readable text found. Scanned PDFs (images) are not supported; use a text-based file.');
  } else if (!topic && !link) {
    throw httpErr(400, 'Upload a file or enter a topic.');
  }
  const r = (await q(
    'insert into materials(faculty_id,department_id,subject,topic,link,filename,text_content) values($1,$2,$3,$4,$5,$6,$7) returning id',
    [req.user.id, dept, subject, topic, link || null, filename, text.slice(0, 200000)]
  ))[0];
  res.json({ id: r.id, filename, chars: text.length, subject, topic });
}));
app.get('/api/materials', staff, ah(async (req, res) => {
  res.json(await q(
    `select m.id,m.subject,m.topic,m.link,m.filename,m.department_id,m.created_at,length(coalesce(m.text_content,''))::int as chars
     from materials m where ($1::uuid is null or m.faculty_id=$1) order by m.created_at desc limit 100`,
    [ownerId(req)]
  ));
}));
app.delete('/api/materials/:id', staff, ah(async (req, res) => {
  await q('delete from materials where id=$1 and ($2::uuid is null or faculty_id=$2)', [intOrNull(req.params.id), ownerId(req)]);
  res.json({ ok: true });
}));

// ---------- faculty: AI generation ----------
app.post('/api/generate', staff, ah(async (req, res) => {
  const b = req.body || {};
  let text = '';
  if (b.material_id) {
    const m = (await q('select text_content from materials where id=$1 and ($2::uuid is null or faculty_id=$2)', [intOrNull(b.material_id), ownerId(req)]))[0];
    if (!m) throw httpErr(404, 'Study material not found.');
    text = m.text_content || '';
  }
  const topic = String(b.topic || '').trim().slice(0, 200);
  const subject = String(b.subject || '').trim().slice(0, 120);
  if (!text && !topic && !subject) throw httpErr(400, 'Choose study material or enter a subject/topic.');
  const difficulty = ['Easy', 'Medium', 'Hard', 'Mixed'].includes(b.difficulty) ? b.difficulty : 'Mixed';
  const result = await generateMCQs({ text, topic, subject, count: b.count, difficulty, avoid: Array.isArray(b.avoid) ? b.avoid : [] });
  res.json(result);
}));

// ---------- faculty: question sets ----------
function cleanQ(x, i) {
  x = x || {};
  const question = String(x.question || '').trim();
  const options = Array.isArray(x.options) ? x.options.map((o) => String(o == null ? '' : o).trim()) : [];
  const ci = Number(x.correct_index);
  if (!question) throw httpErr(400, `Question ${i + 1} is empty.`);
  if (options.length !== 4 || options.some((o) => !o)) throw httpErr(400, `Question ${i + 1} needs four non-empty options.`);
  if (!Number.isInteger(ci) || ci < 0 || ci > 3) throw httpErr(400, `Question ${i + 1} needs a correct answer.`);
  return {
    question: question.slice(0, 2000),
    options: options.map((o) => o.slice(0, 500)),
    correct_index: ci,
    explanation: String(x.explanation || '').trim().slice(0, 1000),
    topic: String(x.topic || '').trim().slice(0, 120),
    difficulty: ['Easy', 'Medium', 'Hard'].includes(x.difficulty) ? x.difficulty : 'Medium',
  };
}
function cleanSet(b) {
  b = b || {};
  const title = String(b.title || '').trim().slice(0, 200);
  const dept = intOrNull(b.department_id);
  if (!title) throw httpErr(400, 'Please give the question set a title.');
  if (!dept) throw httpErr(400, 'Please select the department.');
  if (!Array.isArray(b.questions) || !b.questions.length) throw httpErr(400, 'Add at least one question.');
  if (b.questions.length > 200) throw httpErr(400, 'A set can have at most 200 questions.');
  return {
    title, dept,
    subject: String(b.subject || '').trim().slice(0, 120),
    topic: String(b.topic || '').trim().slice(0, 200),
    material_id: intOrNull(b.material_id),
    questions: b.questions.map(cleanQ),
  };
}
async function insertQuestions(c, setId, qs) {
  for (let i = 0; i < qs.length; i++) {
    const x = qs[i];
    await c.query(
      'insert into questions(set_id,position,topic,question,options,correct_index,explanation,difficulty) values($1,$2,$3,$4,$5,$6,$7,$8)',
      [setId, i, x.topic, x.question, JSON.stringify(x.options), x.correct_index, x.explanation, x.difficulty]
    );
  }
}

app.post('/api/sets', staff, ah(async (req, res) => {
  const s = cleanSet(req.body);
  const id = await tx(async (c) => {
    const r = (await c.query(
      'insert into question_sets(faculty_id,department_id,title,subject,topic,material_id) values($1,$2,$3,$4,$5,$6) returning id',
      [req.user.id, s.dept, s.title, s.subject, s.topic, s.material_id]
    )).rows[0];
    await insertQuestions(c, r.id, s.questions);
    return r.id;
  });
  res.json({ id });
}));
app.put('/api/sets/:id', staff, ah(async (req, res) => {
  const s = cleanSet(req.body);
  const sid = intOrNull(req.params.id);
  await tx(async (c) => {
    const r = await c.query(
      'update question_sets set department_id=$1,title=$2,subject=$3,topic=$4,updated_at=now() where id=$5 and ($6::uuid is null or faculty_id=$6) returning id',
      [s.dept, s.title, s.subject, s.topic, sid, ownerId(req)]
    );
    if (!r.rows.length) throw httpErr(404, 'Question set not found.');
    await c.query('delete from questions where set_id=$1', [sid]);
    await insertQuestions(c, sid, s.questions);
  });
  res.json({ id: sid });
}));
app.get('/api/sets', staff, ah(async (req, res) => {
  res.json(await q(
    `select s.id,s.title,s.subject,s.topic,s.department_id,d.name as department_name,s.created_at,
       (select count(*)::int from questions where set_id=s.id) as question_count
     from question_sets s left join departments d on d.id=s.department_id
     where ($1::uuid is null or s.faculty_id=$1) order by s.created_at desc`,
    [ownerId(req)]
  ));
}));
app.get('/api/sets/:id', staff, ah(async (req, res) => {
  const s = (await q('select id,title,subject,topic,department_id,material_id from question_sets where id=$1 and ($2::uuid is null or faculty_id=$2)', [intOrNull(req.params.id), ownerId(req)]))[0];
  if (!s) throw httpErr(404, 'Question set not found.');
  s.questions = await q('select id,topic,question,options,correct_index,explanation,difficulty from questions where set_id=$1 order by position', [s.id]);
  res.json(s);
}));
app.delete('/api/sets/:id', staff, ah(async (req, res) => {
  await q('delete from question_sets where id=$1 and ($2::uuid is null or faculty_id=$2)', [intOrNull(req.params.id), ownerId(req)]);
  res.json({ ok: true });
}));

// ---------- faculty: quizzes ----------
function parseWindow(b) {
  const start = new Date(b.start_at);
  const end = new Date(b.end_at);
  if (isNaN(start) || isNaN(end)) throw httpErr(400, 'Please set valid start and end date/time.');
  if (end <= start) throw httpErr(400, 'The end time must be after the start time.');
  return { start, end };
}
const clampInt = (v, lo, hi, def) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
};

app.post('/api/quizzes', staff, ah(async (req, res) => {
  const b = req.body || {};
  const set = (await q('select id,subject,topic from question_sets where id=$1 and ($2::uuid is null or faculty_id=$2)', [intOrNull(b.set_id), ownerId(req)]))[0];
  if (!set) throw httpErr(404, 'Question set not found.');
  const dept = intOrNull(b.department_id);
  if (!dept || !(await q('select 1 from departments where id=$1', [dept])).length) throw httpErr(400, 'Please select the department.');
  const title = String(b.title || '').trim().slice(0, 200);
  if (!title) throw httpErr(400, 'Please enter a quiz title.');
  const marks = Number(b.marks_per_question);
  if (!(marks > 0 && marks <= 100)) throw httpErr(400, 'Marks per question must be between 0 and 100.');
  const duration = clampInt(b.duration_minutes, 1, 600, 0);
  if (!duration) throw httpErr(400, 'Duration must be 1 to 600 minutes.');
  const { start, end } = parseWindow(b);
  const retakes = !!b.allow_retakes;
  const maxAttempts = retakes ? clampInt(b.max_attempts, 2, 20, 2) : 1;
  const qs = await q('select question,options,correct_index,explanation from questions where set_id=$1 order by position', [set.id]);
  const n = clampInt(b.num_questions, 1, qs.length, qs.length);
  const quizId = await tx(async (c) => {
    const r = (await c.query(
      `insert into quizzes(faculty_id,set_id,department_id,title,subject,topic,marks_per_question,duration_minutes,start_at,end_at,show_review,results_released,allow_retakes,max_attempts)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
      [req.user.id, set.id, dept, title, String(b.subject || set.subject || '').slice(0, 120), String(b.topic || set.topic || '').slice(0, 200), marks, duration, start, end, b.show_review !== false, b.results_released !== false, retakes, maxAttempts]
    )).rows[0];
    for (let i = 0; i < n; i++) {
      await c.query('insert into quiz_questions(quiz_id,position,question,options,correct_index,explanation) values($1,$2,$3,$4,$5,$6)',
        [r.id, i, qs[i].question, JSON.stringify(qs[i].options), qs[i].correct_index, qs[i].explanation]);
    }
    return r.id;
  });
  res.json({ id: quizId });
}));

app.get('/api/quizzes', staff, ah(async (req, res) => {
  res.json(await q(
    `select z.id,z.title,z.subject,z.topic,z.department_id,d.name as department_name,z.marks_per_question::float as marks_per_question,
       z.duration_minutes,z.start_at,z.end_at,z.show_review,z.results_released,z.allow_retakes,z.max_attempts,z.status,z.created_at,
       (select count(*)::int from quiz_questions where quiz_id=z.id) as question_count,
       (select count(*)::int from attempts where quiz_id=z.id) as attempt_count
     from quizzes z left join departments d on d.id=z.department_id
     where ($1::uuid is null or z.faculty_id=$1) order by z.created_at desc`,
    [ownerId(req)]
  ));
}));

app.patch('/api/quizzes/:id', staff, ah(async (req, res) => {
  const b = req.body || {};
  const z = (await q('select * from quizzes where id=$1 and ($2::uuid is null or faculty_id=$2)', [intOrNull(req.params.id), ownerId(req)]))[0];
  if (!z) throw httpErr(404, 'Quiz not found.');
  const hasAttempts = (await q('select 1 from attempts where quiz_id=$1 limit 1', [z.id])).length > 0;
  const next = { ...z };
  if (b.title !== undefined) {
    next.title = String(b.title).trim().slice(0, 200);
    if (!next.title) throw httpErr(400, 'Title cannot be empty.');
  }
  if (b.status !== undefined) {
    if (!['published', 'unpublished', 'archived'].includes(b.status)) throw httpErr(400, 'Invalid status.');
    next.status = b.status;
  }
  if (b.start_at !== undefined || b.end_at !== undefined) {
    const w = parseWindow({ start_at: b.start_at ?? z.start_at, end_at: b.end_at ?? z.end_at });
    next.start_at = w.start;
    next.end_at = w.end;
  }
  if (b.duration_minutes !== undefined) {
    next.duration_minutes = clampInt(b.duration_minutes, 1, 600, 0);
    if (!next.duration_minutes) throw httpErr(400, 'Duration must be 1 to 600 minutes.');
  }
  if (b.show_review !== undefined) next.show_review = !!b.show_review;
  if (b.results_released !== undefined) next.results_released = !!b.results_released;
  if (b.allow_retakes !== undefined) {
    next.allow_retakes = !!b.allow_retakes;
    next.max_attempts = next.allow_retakes ? clampInt(b.max_attempts, 2, 20, 2) : 1;
  }
  // Marks and department can only change while nobody has attempted the quiz.
  if (b.marks_per_question !== undefined || b.department_id !== undefined) {
    if (hasAttempts) throw httpErr(409, 'Marks and department cannot be changed after students have attempted the quiz.');
    if (b.marks_per_question !== undefined) {
      const m = Number(b.marks_per_question);
      if (!(m > 0 && m <= 100)) throw httpErr(400, 'Marks per question must be between 0 and 100.');
      next.marks_per_question = m;
    }
    if (b.department_id !== undefined) {
      const d = intOrNull(b.department_id);
      if (!d || !(await q('select 1 from departments where id=$1', [d])).length) throw httpErr(400, 'Unknown department.');
      next.department_id = d;
    }
  }
  await q(
    `update quizzes set title=$1,status=$2,start_at=$3,end_at=$4,duration_minutes=$5,show_review=$6,results_released=$7,
       allow_retakes=$8,max_attempts=$9,marks_per_question=$10,department_id=$11 where id=$12`,
    [next.title, next.status, next.start_at, next.end_at, next.duration_minutes, next.show_review, next.results_released,
     next.allow_retakes, next.max_attempts, next.marks_per_question, next.department_id, z.id]
  );
  res.json({ ok: true });
}));
app.delete('/api/quizzes/:id', staff, ah(async (req, res) => {
  // "Delete" archives: student results are kept.
  await q("update quizzes set status='archived' where id=$1 and ($2::uuid is null or faculty_id=$2)", [intOrNull(req.params.id), ownerId(req)]);
  res.json({ ok: true });
}));

// ---------- grading ----------
function cleanAnswers(raw, qs) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  const valid = new Set(qs.map((x) => String(x.id)));
  for (const k of Object.keys(raw)) {
    const v = raw[k];
    if (valid.has(k) && Number.isInteger(v) && v >= 0 && v <= 3) out[k] = v;
  }
  return out;
}

async function gradeAttempt(attemptId, answersIn) {
  const a = (await q(
    `select a.*, z.marks_per_question from attempts a join quizzes z on z.id=a.quiz_id where a.id=$1`, [attemptId]
  ))[0];
  if (!a || a.status !== 'in_progress') return a;
  const qs = await q('select id,correct_index from quiz_questions where quiz_id=$1', [a.quiz_id]);
  const answers = cleanAnswers(answersIn === undefined ? a.answers : answersIn, qs);
  let c = 0, w = 0, u = 0;
  for (const x of qs) {
    const s = answers[String(x.id)];
    if (s === undefined) u++;
    else if (s === x.correct_index) c++;
    else w++;
  }
  const marks = Number(a.marks_per_question);
  const total = qs.length * marks;
  const score = c * marks;
  const pctv = total ? Math.round((score / total) * 10000) / 100 : 0;
  const end = Math.min(Date.now(), new Date(a.deadline_at).getTime());
  const taken = Math.max(0, Math.round((end - new Date(a.started_at).getTime()) / 1000));
  const r = await q(
    `update attempts set status='submitted',submitted_at=now(),answers=$2,score=$3,correct=$4,incorrect=$5,unanswered=$6,
       total_marks=$7,percentage=$8,time_taken_sec=$9 where id=$1 and status='in_progress' returning *`,
    [attemptId, JSON.stringify(answers), score, c, w, u, total, pctv, taken]
  );
  return r[0];
}

// Attempts whose time ran out (browser closed etc.) are graded with the answers that were auto-saved.
async function finalizeExpired() {
  const rows = await q("select id from attempts where status='in_progress' and deadline_at < now() - interval '30 seconds' limit 200");
  for (const r of rows) await gradeAttempt(r.id);
}

// ---------- student ----------
const studentOnly = auth('student');
const num = (v) => (v == null ? null : Number(v));

app.get('/api/student/quizzes', studentOnly, ah(async (req, res) => {
  await finalizeExpired();
  const rows = await q(
    `select z.id,z.title,z.subject,z.topic,z.marks_per_question::float as marks_per_question,z.duration_minutes,z.start_at,z.end_at,
       z.allow_retakes,z.max_attempts,f.full_name as faculty_name,
       (select count(*)::int from quiz_questions where quiz_id=z.id) as question_count,
       (select count(*)::int from attempts a where a.quiz_id=z.id and a.student_id=$1 and a.status='submitted') as done_count,
       (select a.id from attempts a where a.quiz_id=z.id and a.student_id=$1 and a.status='in_progress' limit 1) as in_progress_id,
       (select a.id from attempts a where a.quiz_id=z.id and a.student_id=$1 and a.status='submitted' order by a.submitted_at desc limit 1) as last_attempt_id
     from quizzes z join users f on f.id=z.faculty_id
     where z.department_id=$2 and z.status='published' order by z.start_at desc`,
    [req.user.id, req.user.department_id]
  );
  const now = Date.now();
  res.json(rows.map((r) => {
    const phase = now < new Date(r.start_at) ? 'upcoming' : now > new Date(r.end_at) ? 'closed' : 'live';
    const limit = r.allow_retakes ? r.max_attempts : 1;
    return { ...r, total_marks: r.marks_per_question * r.question_count, phase, can_start: phase === 'live' && (!!r.in_progress_id || r.done_count < limit) };
  }));
}));

app.post('/api/student/quizzes/:id/start', studentOnly, ah(async (req, res) => {
  await finalizeExpired();
  const z = (await q("select * from quizzes where id=$1 and status='published'", [intOrNull(req.params.id)]))[0];
  if (!z) throw httpErr(404, 'Quiz not found.');
  if (z.department_id !== req.user.department_id) throw httpErr(403, 'This quiz is not available for your department.');
  const now = Date.now();
  if (now < new Date(z.start_at)) throw httpErr(409, 'This quiz has not started yet.');
  if (now > new Date(z.end_at)) throw httpErr(409, 'This quiz has ended.');
  let a = (await q("select * from attempts where quiz_id=$1 and student_id=$2 and status='in_progress'", [z.id, req.user.id]))[0];
  if (!a) {
    const done = (await q("select count(*)::int as n from attempts where quiz_id=$1 and student_id=$2 and status='submitted'", [z.id, req.user.id]))[0].n;
    if (done >= (z.allow_retakes ? z.max_attempts : 1)) throw httpErr(409, 'You have already used all attempts for this quiz.');
    const deadline = new Date(Math.min(now + z.duration_minutes * 60000, new Date(z.end_at).getTime()));
    a = (await q('insert into attempts(quiz_id,student_id,deadline_at) values($1,$2,$3) returning *', [z.id, req.user.id, deadline]))[0];
  }
  // Correct answers are deliberately NOT selected here.
  const questions = await q('select id,question,options from quiz_questions where quiz_id=$1 order by position', [z.id]);
  res.json({
    attempt_id: a.id, quiz_title: z.title, subject: z.subject,
    deadline_at: a.deadline_at, server_now: new Date().toISOString(),
    questions, answers: a.answers,
  });
}));

async function ownAttempt(req) {
  const a = (await q('select * from attempts where id=$1 and student_id=$2', [intOrNull(req.params.id), req.user.id]))[0];
  if (!a) throw httpErr(404, 'Attempt not found.');
  return a;
}
const GRACE_MS = 30000;

app.post('/api/student/attempts/:id/save', studentOnly, ah(async (req, res) => {
  const a = await ownAttempt(req);
  if (a.status !== 'in_progress' || Date.now() > new Date(a.deadline_at).getTime() + GRACE_MS) throw httpErr(409, 'This attempt is closed.');
  const qs = await q('select id from quiz_questions where quiz_id=$1', [a.quiz_id]);
  await q('update attempts set answers=$1 where id=$2', [JSON.stringify(cleanAnswers((req.body || {}).answers, qs)), a.id]);
  res.json({ ok: true });
}));

app.post('/api/student/attempts/:id/submit', studentOnly, ah(async (req, res) => {
  const a = await ownAttempt(req);
  if (a.status === 'submitted') return res.json({ attempt_id: a.id }); // answers can never change after submission
  const late = Date.now() > new Date(a.deadline_at).getTime() + GRACE_MS;
  await gradeAttempt(a.id, late ? undefined : (req.body || {}).answers);
  res.json({ attempt_id: a.id });
}));

app.get('/api/student/attempts/:id', studentOnly, ah(async (req, res) => {
  await finalizeExpired();
  const a = await ownAttempt(req);
  if (a.status !== 'submitted') throw httpErr(409, 'This attempt has not been submitted yet.');
  const z = (await q('select z.*,f.full_name as faculty_name from quizzes z join users f on f.id=z.faculty_id where z.id=$1', [a.quiz_id]))[0];
  const base = {
    student_name: req.user.full_name, roll_number: req.user.roll_number, department: req.user.department_name,
    quiz_title: z.title, subject: z.subject, submitted_at: a.submitted_at, released: z.results_released,
  };
  if (!z.results_released) {
    return res.json({ ...base, message: 'Your answers are submitted. Your faculty member has not released the results yet. Please check again later.' });
  }
  const out = {
    ...base, score: num(a.score), total_marks: num(a.total_marks), percentage: num(a.percentage),
    correct: a.correct, incorrect: a.incorrect, unanswered: a.unanswered, time_taken_sec: a.time_taken_sec, review: null,
  };
  if (z.show_review) {
    const qs = await q('select id,question,options,correct_index,explanation from quiz_questions where quiz_id=$1 order by position', [a.quiz_id]);
    out.review = qs.map((x) => {
      const sel = a.answers[String(x.id)];
      return { question: x.question, options: x.options, selected: sel === undefined ? null : sel, correct_index: x.correct_index, explanation: x.explanation, is_correct: sel === x.correct_index };
    });
  }
  res.json(out);
}));

app.get('/api/student/results', studentOnly, ah(async (req, res) => {
  await finalizeExpired();
  const rows = await q(
    `select a.id,z.title,z.subject,z.results_released,a.score::float as score,a.total_marks::float as total_marks,a.percentage::float as percentage,
       a.correct,a.incorrect,a.unanswered,a.submitted_at,a.time_taken_sec
     from attempts a join quizzes z on z.id=a.quiz_id where a.student_id=$1 and a.status='submitted' order by a.submitted_at desc`,
    [req.user.id]
  );
  res.json(rows.map((r) => (r.results_released ? r : { ...r, score: null, total_marks: null, percentage: null, correct: null, incorrect: null, unanswered: null })));
}));

// ---------- faculty: responses, marks, analytics ----------
const SORTS = {
  marks_desc: 'a.percentage desc nulls last, u.full_name',
  marks_asc: 'a.percentage asc nulls last, u.full_name',
  name: 'u.full_name asc',
  recent: 'a.started_at desc',
};
async function resultRows(req) {
  await finalizeExpired();
  const f = req.query || {};
  const search = String(f.q || '').trim();
  const subject = String(f.subject || '').trim();
  return q(
    `select a.id,u.full_name as student_name,u.roll_number,d.name as department,z.id as quiz_id,z.title as quiz_title,z.subject,
       a.score::float as score,a.total_marks::float as total_marks,a.percentage::float as percentage,
       case when a.status='submitted' then 'Submitted' else 'In progress' end as status,a.submitted_at,a.time_taken_sec
     from attempts a join quizzes z on z.id=a.quiz_id join users u on u.id=a.student_id left join departments d on d.id=u.department_id
     where ($1::uuid is null or z.faculty_id=$1)
       and ($2::bigint is null or z.id=$2)
       and ($3::text is null or u.full_name ilike $3 or u.roll_number ilike $3)
       and ($4::text is null or z.subject ilike $4)
       and ($5::int is null or u.department_id=$5)
     order by ${SORTS[f.sort] || SORTS.recent} limit 2000`,
    [ownerId(req), intOrNull(f.quiz_id), search ? escLike(search) : null, subject ? escLike(subject) : null, intOrNull(f.department_id)]
  );
}

app.get('/api/faculty/results', staff, ah(async (req, res) => res.json(await resultRows(req))));

app.get('/api/faculty/results.csv', staff, ah(async (req, res) => {
  const rows = await resultRows(req);
  const cell = (v) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const head = ['Student Name', 'Roll Number', 'Department', 'Quiz', 'Subject', 'Marks', 'Total Marks', 'Percentage', 'Status', 'Time Taken (sec)', 'Submitted At'];
  const lines = [head.map(cell).join(',')].concat(
    rows.map((r) => [r.student_name, r.roll_number, r.department, r.quiz_title, r.subject, r.score, r.total_marks, r.percentage, r.status, r.time_taken_sec, r.submitted_at ? new Date(r.submitted_at).toISOString() : ''].map(cell).join(','))
  );
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="results.csv"');
  res.send('﻿' + lines.join('\r\n'));
}));

app.get('/api/faculty/results/:id', staff, ah(async (req, res) => {
  await finalizeExpired();
  const a = (await q(
    `select a.*,z.title,z.subject,z.topic,z.marks_per_question::float as mpq,u.full_name,u.roll_number,d.name as dept
     from attempts a join quizzes z on z.id=a.quiz_id join users u on u.id=a.student_id left join departments d on d.id=u.department_id
     where a.id=$1 and ($2::uuid is null or z.faculty_id=$2)`,
    [intOrNull(req.params.id), ownerId(req)]
  ))[0];
  if (!a) throw httpErr(404, 'Result not found.');
  const qs = await q('select id,question,options,correct_index from quiz_questions where quiz_id=$1 order by position', [a.quiz_id]);
  res.json({
    student_name: a.full_name, roll_number: a.roll_number, department: a.dept, quiz_title: a.title, subject: a.subject,
    status: a.status, score: num(a.score), total_marks: num(a.total_marks), percentage: num(a.percentage),
    correct: a.correct, incorrect: a.incorrect, unanswered: a.unanswered, time_taken_sec: a.time_taken_sec,
    started_at: a.started_at, submitted_at: a.submitted_at,
    questions: qs.map((x) => {
      const sel = a.answers[String(x.id)];
      const ok = sel === x.correct_index;
      return { question: x.question, options: x.options, selected: sel === undefined ? null : sel, correct_index: x.correct_index, is_correct: ok, marks_awarded: a.status === 'submitted' && ok ? a.mpq : 0 };
    }),
  });
}));

app.get('/api/faculty/stats', staff, ah(async (req, res) => {
  await finalizeExpired();
  const o = ownerId(req);
  const [sets, published, students, avg, quizzes] = await Promise.all([
    q('select count(*)::int as n from question_sets where ($1::uuid is null or faculty_id=$1)', [o]),
    q("select count(*)::int as n from quizzes where status='published' and ($1::uuid is null or faculty_id=$1)", [o]),
    q(`select count(distinct a.student_id)::int as n from attempts a join quizzes z on z.id=a.quiz_id where ($1::uuid is null or z.faculty_id=$1)`, [o]),
    q(`select round(avg(a.percentage),1)::float as v from attempts a join quizzes z on z.id=a.quiz_id where a.status='submitted' and ($1::uuid is null or z.faculty_id=$1)`, [o]),
    q(
      `select z.id,z.title,z.subject,d.name as department,z.status,
         (count(a.id) filter (where a.status='submitted'))::int as attempts,
         round(avg(a.percentage) filter (where a.status='submitted'),1)::float as avg_pct,
         (max(a.percentage) filter (where a.status='submitted'))::float as highest,
         (min(a.percentage) filter (where a.status='submitted'))::float as lowest,
         (count(a.id) filter (where a.status='submitted' and a.percentage >= ${PASS_MARK}))::int as passed
       from quizzes z left join attempts a on a.quiz_id=z.id left join departments d on d.id=z.department_id
       where ($1::uuid is null or z.faculty_id=$1) group by z.id,d.name order by z.created_at desc`,
      [o]
    ),
  ]);
  res.json({
    total_sets: sets[0].n, total_published: published[0].n, total_students: students[0].n, average_pct: avg[0].v,
    pass_mark: PASS_MARK, quizzes,
  });
}));

app.get('/api/faculty/analytics/:quizId', staff, ah(async (req, res) => {
  await finalizeExpired();
  const z = (await q('select id,title,subject from quizzes where id=$1 and ($2::uuid is null or faculty_id=$2)', [intOrNull(req.params.quizId), ownerId(req)]))[0];
  if (!z) throw httpErr(404, 'Quiz not found.');
  const qs = await q('select id,question,correct_index from quiz_questions where quiz_id=$1 order by position', [z.id]);
  const att = await q("select answers,percentage::float as pct from attempts where quiz_id=$1 and status='submitted'", [z.id]);
  const buckets = [0, 0, 0, 0, 0]; // 0-20, 20-40, 40-60, 60-80, 80-100
  att.forEach((a) => buckets[Math.min(4, Math.floor(a.pct / 20))]++);
  res.json({
    quiz: z, attempts: att.length, distribution: buckets,
    questions: qs.map((x) => {
      const right = att.filter((a) => a.answers[String(x.id)] === x.correct_index).length;
      return { question: x.question, correct_pct: att.length ? Math.round((right / att.length) * 100) : null };
    }),
  });
}));

// ---------- misc ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
// Website files (only these are public; server.js, .env etc. are never served).
const PUBLIC_FILES = ['index.html', 'style.css', 'config.js', 'app.js', 'faculty.js', 'student.js'];
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
PUBLIC_FILES.forEach((f) => app.get('/' + f, (req, res) => res.sendFile(path.join(__dirname, f))));

app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') err = httpErr(400, 'File is too large (maximum 8 MB).');
  const status = err.status || 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: status === 500 ? 'Something went wrong on the server. Please try again.' : err.message });
});

async function init() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. See README.md, step 2.');
    process.exit(1);
  }
  await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const pw = process.env.ADMIN_PASSWORD || '';
  if (email && pw.length >= 8) {
    const has = await q("select 1 from users where role='admin' limit 1");
    if (!has.length) {
      await q("insert into users(role,full_name,email,password_hash) values('admin','Administrator',$1,$2) on conflict (email) do nothing", [email, await bcrypt.hash(pw, 10)]);
      console.log('Admin account created:', email);
    }
  }
  app.listen(PORT, () => console.log(`NSITE AI MCQ Generator running on port ${PORT} (AI: ${isMock() ? 'demo/mock mode' : 'Gemini'})`));
}
if (require.main === module) {
  init().catch((e) => {
    console.error('Could not start. Check DATABASE_URL (use the Session pooler string). Details:', e.message);
    process.exit(1);
  });
}
module.exports = { app, gradeAttempt, cleanAnswers };
