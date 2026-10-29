'use strict';
// ===== Faculty (and administrator) dashboard =====
const FSEC = [
  ['overview', '📊', 'Dashboard Overview'], ['upload', '⬆️', 'Upload Study Material'], ['generate', '✨', 'Generate MCQs'],
  ['sets', '📚', 'My Question Sets'], ['publish', '🚀', 'Publish Quiz'], ['responses', '👥', 'Student Responses & Marks'],
  ['reports', '📈', 'Performance Reports'], ['profile', '👤', 'Profile'],
];
let draft = null;          // question set being generated/edited
let setsCache = [];
let pubSetId = '';
let rf = { q: '', quiz_id: '', subject: '', department_id: '', sort: 'recent' }; // results filters

function newDraft() {
  return { id: null, title: '', subject: '', topic: '', department_id: me.department_id || '', material_id: '', questions: [], mode: '' };
}
const blankQ = () => ({ topic: '', question: '', options: ['', '', '', ''], correct_index: 0, explanation: '', difficulty: 'Medium' });
const toLocalInput = (d) => {
  d = new Date(d); const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

async function renderFaculty(sec) {
  await loadDepts().catch(() => {});
  if (!draft) draft = newDraft();
  const items = FSEC.slice();
  if (me.role === 'admin') items.splice(7, 0, ['departments', '🏫', 'Departments']);
  if (!items.find((i) => i[0] === sec)) sec = 'overview';
  shell(dashLayout('faculty', items, sec, '<div class="loading">Loading…</div>', esc(me.department_name || 'Administrator')));
  try {
    const html = await FPAGES[sec]();
    const el = document.getElementById('content');
    if (!el) return;
    el.innerHTML = html;
    if (FAFTER[sec]) FAFTER[sec]();
  } catch (e) {
    const el = document.getElementById('content');
    if (el) el.innerHTML = `<div class="notice err">${esc(e.message)}</div>`;
  }
}

const banner = () => `<div class="welcome"><h2>Welcome, ${esc(me.full_name)}!</h2><p>${esc(me.department_name || 'Administrator')}${me.role === 'admin' ? ' · Administrator' : ''}</p></div>`;

const FPAGES = {
  async overview() {
    const s = await api('/faculty/stats');
    return `${banner()}<div class="grid" style="margin-bottom:20px">
      <div class="stat"><b>${s.total_sets}</b><span>Total question sets</span></div>
      <div class="stat"><b>${s.total_published}</b><span>Published quizzes</span></div>
      <div class="stat"><b>${s.total_students}</b><span>Students who attempted</span></div>
      <div class="stat"><b>${pct(s.average_pct)}</b><span>Average student marks</span></div></div>
      <h3>Quick start</h3><div class="actions"><a class="btn" href="#/faculty/upload">⬆️ Upload material</a><a class="btn alt" href="#/faculty/generate">✨ Generate MCQs</a><a class="btn alt" href="#/faculty/responses">👥 View results</a></div>`;
  },

  // ----- upload -----
  async upload() {
    const mats = await api('/materials');
    return `<h2>Upload Study Material</h2>
    <div class="card" style="max-width:720px;margin-bottom:20px"><form id="upform" onsubmit="doUpload(event)">
      <div class="row"><label class="f"><span>Department</span><select name="department_id" required>${deptOptions(me.department_id)}</select></label>
      <label class="f"><span>Subject name *</span><input name="subject" required maxlength="120" placeholder="e.g. Engineering Chemistry"></label></div>
      <label class="f"><span>Topic / chapter</span><input name="topic" maxlength="200" placeholder="e.g. Electrochemistry"></label>
      <label class="f"><span>File (PDF, DOCX or TXT, max 8 MB)</span><input type="file" name="file" accept=".pdf,.docx,.txt"></label>
      <label class="f"><span>Source link (optional, saved as a reference only)</span><input name="link" type="url" placeholder="https://"></label>
      <p style="color:var(--mut);font-size:.85rem;margin-top:-6px">You can upload a file, or just enter a topic and the AI will use general knowledge.</p>
      <div id="upfile" style="font-weight:600"></div>
      <div class="progress"><div id="upbar"></div></div><div id="upstatus" style="margin-bottom:12px;color:var(--mut)">Waiting for upload…</div>
      <button class="btn" id="upbtn">Upload</button></form></div>
    <h3>Your uploaded materials</h3>${matsTable(mats)}`;
  },

  // ----- generate + review -----
  async generate() {
    const mats = await api('/materials');
    const cur = mats.find((m) => String(m.id) === String(draft.material_id));
    if (cur) { if (!draft.subject) draft.subject = cur.subject || ''; if (!draft.topic) draft.topic = cur.topic || ''; }
    return `<h2>Generate MCQs</h2>
    <div class="card" style="margin-bottom:20px"><form onsubmit="doGenerate(event)">
      <label class="f"><span>Study material</span><select name="material_id" onchange="pickMaterial(this)"><option value="">None - use subject/topic only</option>
        ${mats.map((m) => `<option value="${m.id}" data-subject="${esc(m.subject)}" data-topic="${esc(m.topic)}" data-dept="${m.department_id || ''}" ${String(draft.material_id) === String(m.id) ? 'selected' : ''}>${esc(m.filename || m.topic || 'Topic only')} - ${esc(m.subject)}</option>`).join('')}</select></label>
      <div class="row"><label class="f"><span>Subject</span><input name="subject" value="${esc(draft.subject)}" required></label>
      <label class="f"><span>Topic / chapter</span><input name="topic" value="${esc(draft.topic)}"></label></div>
      <div class="row"><label class="f"><span>Number of questions (1-30)</span><input name="count" type="number" min="1" max="30" value="10" required></label>
      <label class="f"><span>Difficulty</span><select name="difficulty"><option>Mixed</option><option>Easy</option><option selected>Medium</option><option>Hard</option></select></label></div>
      <button class="btn" id="genbtn">✨ Generate MCQs Using AI</button>
      <div id="generr"></div></form></div>
    <div id="review"></div>`;
  },

  async sets() {
    setsCache = await api('/sets');
    if (!setsCache.length) return '<h2>My Question Sets</h2><div class="empty">No question sets yet. Generate MCQs and save them as a set.</div>';
    return `<h2>My Question Sets</h2><div class="tablewrap"><table><tr><th>Title</th><th>Subject</th><th>Department</th><th>Questions</th><th>Created</th><th></th></tr>
    ${setsCache.map((s) => `<tr><td>${esc(s.title)}</td><td>${esc(s.subject)}</td><td>${esc(s.department_name)}</td><td>${s.question_count}</td><td>${fmt(s.created_at)}</td>
      <td class="actions"><button class="btn xs ghost" onclick="editSet('${s.id}')">Edit</button><button class="btn xs" onclick="pubSetId='${s.id}';go('faculty/publish')">Publish</button><button class="btn xs danger" onclick="delSet('${s.id}')">Delete</button></td></tr>`).join('')}</table></div>`;
  },

  // ----- publish -----
  async publish() {
    const [sets, quizzes] = await Promise.all([api('/sets'), api('/quizzes')]);
    setsCache = sets;
    const sel = sets.find((s) => String(s.id) === String(pubSetId)) || sets[0];
    const now = new Date(); const week = new Date(Date.now() + 7 * 864e5);
    const form = !sets.length ? '<div class="empty">Create and save a question set first (Generate MCQs).</div>' : `
    <div class="card" style="margin-bottom:22px"><form onsubmit="doPublish(event)">
      <label class="f"><span>Question set</span><select name="set_id" onchange="prefillPublish(this.value)">${sets.map((s) => `<option value="${s.id}" ${sel && s.id === sel.id ? 'selected' : ''}>${esc(s.title)} (${s.question_count} questions)</option>`).join('')}</select></label>
      <div class="row"><label class="f"><span>Quiz title</span><input name="title" required value="${esc(sel.title)}"></label>
      <label class="f"><span>Department (who can take it)</span><select name="department_id" required>${deptOptions(sel.department_id)}</select></label></div>
      <div class="row"><label class="f"><span>Subject</span><input name="subject" value="${esc(sel.subject)}"></label><label class="f"><span>Topic</span><input name="topic" value="${esc(sel.topic)}"></label></div>
      <div class="row"><label class="f"><span>Number of questions</span><input name="num_questions" type="number" min="1" max="${sel.question_count}" value="${sel.question_count}" required></label>
      <label class="f"><span>Marks per question</span><input name="marks" type="number" min="0.5" step="0.5" value="1" required></label>
      <label class="f"><span>Duration (minutes)</span><input name="duration" type="number" min="1" max="600" value="30" required></label></div>
      <div class="row"><label class="f"><span>Available from</span><input name="start" type="datetime-local" value="${toLocalInput(now)}" required></label>
      <label class="f"><span>Available until</span><input name="end" type="datetime-local" value="${toLocalInput(week)}" required></label></div>
      <label class="chk"><input type="checkbox" name="review" checked> Students can review their answers after submission</label>
      <label class="chk"><input type="checkbox" name="released" checked> Show results to students immediately</label>
      <label class="chk"><input type="checkbox" name="retakes" onchange="document.getElementById('maxa').style.display=this.checked?'block':'none'"> Allow retakes</label>
      <label class="f" id="maxa" style="display:none"><span>Maximum attempts per student</span><input name="max_attempts" type="number" min="2" max="20" value="2"></label>
      <button class="btn">🚀 Publish Quiz</button></form></div>`;
    return `<h2>Publish Quiz</h2>${form}<h3>My quizzes</h3>${quizzesTable(quizzes)}`;
  },

  // ----- responses -----
  async responses() {
    const quizzes = await api('/quizzes');
    const subjects = [...new Set(quizzes.map((x) => x.subject).filter(Boolean))];
    return `<h2>Student Responses &amp; Marks</h2>
    <div class="filters no-print">
      <input placeholder="Search name or roll no." value="${esc(rf.q)}" oninput="rf.q=this.value;debounceResp()">
      <select onchange="rf.quiz_id=this.value;loadResponses()"><option value="">All quizzes</option>${quizzes.map((z) => `<option value="${z.id}" ${String(rf.quiz_id) === String(z.id) ? 'selected' : ''}>${esc(z.title)}</option>`).join('')}</select>
      <select onchange="rf.subject=this.value;loadResponses()"><option value="">All subjects</option>${subjects.map((s) => `<option ${rf.subject === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>
      <select onchange="rf.department_id=this.value;loadResponses()"><option value="">All departments</option>${deptOptions(rf.department_id)}</select>
      <select onchange="rf.sort=this.value;loadResponses()">${[['recent', 'Newest first'], ['marks_desc', 'Marks: high to low'], ['marks_asc', 'Marks: low to high'], ['name', 'Name A-Z']].map(([v, l]) => `<option value="${v}" ${rf.sort === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
    </div>
    <div class="actions no-print" style="margin-bottom:12px"><button class="btn sm ghost" onclick="exportCsv()">⬇️ Export CSV (opens in Excel)</button><button class="btn sm ghost" onclick="window.print()">🖨️ Print</button></div>
    <div id="rtable"><div class="loading">Loading…</div></div>`;
  },

  // ----- reports -----
  async reports() {
    const s = await api('/faculty/stats');
    const rows = s.quizzes;
    return `<h2>Performance Reports</h2><div class="grid" style="margin-bottom:18px">
      <div class="stat"><b>${rows.reduce((a, r) => a + r.attempts, 0)}</b><span>Total submissions</span></div>
      <div class="stat"><b>${pct(s.average_pct)}</b><span>Overall average</span></div>
      <div class="stat"><b>${s.total_students}</b><span>Students attempted</span></div></div>
      ${rows.length ? `<div class="tablewrap"><table><tr><th>Quiz</th><th>Subject</th><th>Department</th><th>Attempts</th><th>Average</th><th>Highest</th><th>Lowest</th><th>Pass (≥${s.pass_mark}%)</th><th></th></tr>
      ${rows.map((r) => `<tr><td>${esc(r.title)}</td><td>${esc(r.subject)}</td><td>${esc(r.department)}</td><td>${r.attempts}</td>
        <td><div style="display:flex;gap:8px;align-items:center"><div class="bar" style="width:80px"><div style="width:${r.avg_pct || 0}%"></div></div>${pct(r.avg_pct)}</div></td>
        <td>${pct(r.highest)}</td><td>${pct(r.lowest)}</td><td>${r.attempts ? r.passed + ' / ' + r.attempts : '—'}</td>
        <td><button class="btn xs ghost" onclick="quizReport('${r.id}')">Details</button></td></tr>`).join('')}</table></div>` : '<div class="empty">No quizzes yet.</div>'}`;
  },

  async profile() { return profileHtml(); },

  async departments() {
    await loadDepts(); depts = await api('/departments');
    return `<h2>Departments</h2><div class="card" style="max-width:560px;margin-bottom:16px"><form onsubmit="addDept(event)" class="actions" style="flex-wrap:nowrap"><input name="name" placeholder="New department name" required maxlength="100"><button class="btn sm">Add</button></form></div>
    <div class="tablewrap"><table>${depts.map((d) => `<tr><td>${esc(d.name)}</td><td class="actions"><button class="btn xs ghost" onclick="renameDept(${d.id})">Rename</button><button class="btn xs danger" onclick="delDept(${d.id})">Delete</button></td></tr>`).join('')}</table></div>`;
  },
};
const FAFTER = {
  generate() { renderReview(); },
  responses() { loadResponses(); },
};

// ----- materials -----
function matsTable(mats) {
  if (!mats.length) return '<div class="empty">Nothing uploaded yet.</div>';
  return `<div class="tablewrap"><table><tr><th>File / topic</th><th>Subject</th><th>Text size</th><th>Uploaded</th><th></th></tr>${mats.map((m) => `<tr><td>${esc(m.filename || m.topic || m.link || 'Topic only')}</td><td>${esc(m.subject)}</td><td>${m.chars ? m.chars.toLocaleString() + ' chars' : '—'}</td><td>${fmt(m.created_at)}</td>
    <td class="actions"><button class="btn xs" onclick="useMaterial('${m.id}')">Use for MCQs</button><button class="btn xs danger" onclick="delMaterial('${m.id}')">Delete</button></td></tr>`).join('')}</table></div>`;
}
function useMaterial(id) {
  draft.material_id = id;
  go('faculty/generate');
}
async function delMaterial(id) {
  if (!confirm('Delete this material?')) return;
  try { await api('/materials/' + id, { method: 'DELETE' }); route(); } catch (e) { fail(e); }
}
function doUpload(e) {
  e.preventDefault();
  const form = e.target;
  const fd = new FormData(form);
  const file = fd.get('file');
  const status = document.getElementById('upstatus'), bar = document.getElementById('upbar'), btn = document.getElementById('upbtn');
  if (file && file.size) {
    if (!/\.(pdf|docx|txt)$/i.test(file.name)) return toast('Only PDF, DOCX or TXT files are allowed.', 'err');
    if (file.size > 8 * 1024 * 1024) return toast('File is too large. Maximum is 8 MB.', 'err');
    document.getElementById('upfile').textContent = '📎 ' + file.name;
  } else { fd.delete('file'); if (!fd.get('topic') && !fd.get('link')) return toast('Choose a file or enter a topic.', 'err'); }
  btn.disabled = true; bar.style.width = '0%'; status.textContent = 'Uploading…';
  const xhr = new XMLHttpRequest();
  xhr.open('POST', API + '/api/materials');
  xhr.setRequestHeader('Authorization', 'Bearer ' + token);
  xhr.upload.onprogress = (ev) => { if (ev.lengthComputable) { const p = Math.round((ev.loaded / ev.total) * 100); bar.style.width = p + '%'; status.textContent = p < 100 ? 'Uploading… ' + p + '%' : 'Processing the file…'; } };
  xhr.onerror = () => { btn.disabled = false; status.textContent = '❌ Upload failed. Check your connection.'; };
  xhr.onload = () => {
    btn.disabled = false;
    let d = {}; try { d = JSON.parse(xhr.responseText); } catch (x) { /* ignore */ }
    if (xhr.status >= 200 && xhr.status < 300) {
      bar.style.width = '100%'; status.innerHTML = '✅ Upload complete' + (d.filename ? ': ' + esc(d.filename) + ' (' + d.chars.toLocaleString() + ' characters read)' : '') + '.';
      draft = newDraft(); draft.material_id = d.id; draft.subject = d.subject; draft.topic = d.topic;
      const dep = fd.get('department_id'); if (dep) draft.department_id = dep;
      toast('Upload complete. You can now generate MCQs.', 'ok');
      setTimeout(() => go('faculty/generate'), 900);
    } else { bar.style.width = '0%'; status.textContent = '❌ ' + (d.error || 'Upload failed.'); toast(d.error || 'Upload failed', 'err'); }
  };
  xhr.send(fd);
}

// ----- generation -----
function pickMaterial(sel) {
  const o = sel.options[sel.selectedIndex];
  draft.material_id = sel.value;
  const f = sel.form;
  if (sel.value) { f.subject.value = o.dataset.subject || ''; f.topic.value = o.dataset.topic || ''; if (o.dataset.dept) draft.department_id = o.dataset.dept; }
}
async function doGenerate(e) {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target).entries());
  const btn = document.getElementById('genbtn'), err = document.getElementById('generr');
  draft.subject = f.subject; draft.topic = f.topic; draft.material_id = f.material_id;
  err.innerHTML = ''; btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Generating… (can take up to a minute)';
  try {
    const r = await api('/generate', { method: 'POST', body: { material_id: f.material_id || null, subject: f.subject, topic: f.topic, count: +f.count, difficulty: f.difficulty } });
    draft.questions = draft.questions.concat(r.questions);
    draft.mode = r.mode;
    if (!draft.title) draft.title = (f.topic || f.subject) + ' MCQs';
    toast(r.questions.length + ' questions generated', 'ok');
    renderReview();
    document.getElementById('review').scrollIntoView({ behavior: 'smooth' });
  } catch (x) {
    err.innerHTML = `<div class="notice err" style="margin-top:12px">❌ ${esc(x.message)} Please press <b>Generate MCQs Using AI</b> to try again.</div>`;
  }
  btn.disabled = false; btn.textContent = '✨ Generate MCQs Using AI';
}
function renderReview() {
  const el = document.getElementById('review');
  if (!el) return;
  const qs = draft.questions;
  el.innerHTML = `<h3>Review and edit questions ${qs.length ? `(${qs.length})` : ''}</h3>
  ${draft.mode === 'mock' ? '<div class="notice">⚠️ Demo mode: the AI key is not set, so these are simple practice questions, not real AI output. Add GEMINI_API_KEY on the server for real AI.</div>' : ''}
  ${qs.length ? qs.map(qCard).join('') : '<div class="empty">No questions yet. Generate with AI above, or add one manually.</div>'}
  <div class="actions" style="margin-bottom:18px"><button class="btn alt sm" onclick="draft.questions.push(blankQ());renderReview()">➕ Add question manually</button></div>
  ${qs.length ? `<div class="card"><h3>Save question set</h3><div class="row">
    <label class="f"><span>Set title</span><input value="${esc(draft.title)}" oninput="draft.title=this.value"></label>
    <label class="f"><span>Department</span><select onchange="draft.department_id=this.value">${deptOptions(draft.department_id)}</select></label></div>
    <button class="btn" onclick="saveSet()">💾 Save question set</button>${draft.id ? ' <span class="tag ok">Editing saved set</span>' : ''}</div>` : ''}`;
}
function qCard(x, i) {
  return `<div class="qcard"><div class="qhead"><b>Q${i + 1}</b>${x.topic ? `<span class="tag gray">${esc(x.topic)}</span>` : ''}
    <select style="width:auto;padding:4px 8px" onchange="draft.questions[${i}].difficulty=this.value">${['Easy', 'Medium', 'Hard'].map((d) => `<option ${x.difficulty === d ? 'selected' : ''}>${d}</option>`).join('')}</select><span class="grow"></span>
    <button class="btn xs ghost" onclick="regenQ(${i})" id="rg${i}">↻ Regenerate</button><button class="btn xs danger" onclick="delQ(${i})">Delete</button></div>
    <label class="f"><span>Question</span><textarea oninput="draft.questions[${i}].question=this.value">${esc(x.question)}</textarea></label>
    <div style="color:var(--mut);font-size:.8rem;margin-bottom:6px">Select the radio button next to the correct answer.</div>
    ${x.options.map((o, j) => `<label class="opt"><input type="radio" name="c${i}" ${x.correct_index === j ? 'checked' : ''} onchange="draft.questions[${i}].correct_index=${j}"><b>${LETTERS[j]}</b><input type="text" value="${esc(o)}" oninput="draft.questions[${i}].options[${j}]=this.value"></label>`).join('')}
    <label class="f"><span>Explanation</span><textarea oninput="draft.questions[${i}].explanation=this.value">${esc(x.explanation)}</textarea></label></div>`;
}
function delQ(i) { draft.questions.splice(i, 1); renderReview(); }
async function regenQ(i) {
  const x = draft.questions[i], btn = document.getElementById('rg' + i);
  btn.disabled = true; btn.textContent = 'Working…';
  try {
    const r = await api('/generate', { method: 'POST', body: { material_id: draft.material_id || null, subject: draft.subject, topic: x.topic || draft.topic, count: 1, difficulty: x.difficulty, avoid: draft.questions.map((q) => q.question) } });
    draft.questions[i] = r.questions[0];
    renderReview();
  } catch (e) { fail(e); btn.disabled = false; btn.textContent = '↻ Regenerate'; }
}
async function saveSet() {
  const body = { title: draft.title, subject: draft.subject, topic: draft.topic, department_id: draft.department_id, material_id: draft.material_id || null, questions: draft.questions };
  try {
    const r = draft.id ? await api('/sets/' + draft.id, { method: 'PUT', body }) : await api('/sets', { method: 'POST', body });
    draft.id = r.id;
    toast('Question set saved. You can publish it now.', 'ok');
    renderReview();
  } catch (e) { fail(e); }
}
async function editSet(id) {
  try {
    const s = await api('/sets/' + id);
    draft = { id: s.id, title: s.title, subject: s.subject, topic: s.topic, department_id: s.department_id, material_id: s.material_id || '', questions: s.questions, mode: '' };
    go('faculty/generate');
  } catch (e) { fail(e); }
}
async function delSet(id) {
  if (!confirm('Delete this question set? Published quizzes made from it are not affected.')) return;
  try { await api('/sets/' + id, { method: 'DELETE' }); if (draft && String(draft.id) === String(id)) draft = newDraft(); route(); } catch (e) { fail(e); }
}

// ----- publish -----
function prefillPublish(id) { pubSetId = id; route(); }
async function doPublish(e) {
  e.preventDefault();
  const f = new FormData(e.target), g = (k) => f.get(k);
  let body;
  try {
    body = {
      set_id: g('set_id'), title: g('title'), department_id: +g('department_id'), subject: g('subject'), topic: g('topic'),
      num_questions: +g('num_questions'), marks_per_question: +g('marks'), duration_minutes: +g('duration'),
      start_at: new Date(g('start')).toISOString(), end_at: new Date(g('end')).toISOString(),
      show_review: f.has('review'), results_released: f.has('released'), allow_retakes: f.has('retakes'), max_attempts: +g('max_attempts') || 2,
    };
  } catch (x) { return toast('Please set a valid start and end date/time.', 'err'); }
  try { await api('/quizzes', { method: 'POST', body }); toast('Quiz published!', 'ok'); route(); } catch (x) { fail(x); }
}
function quizzesTable(list) {
  if (!list.length) return '<div class="empty">No quizzes published yet.</div>';
  const st = { published: 'ok', unpublished: 'warn', archived: 'gray' };
  return `<div class="tablewrap"><table><tr><th>Title</th><th>Department</th><th>Questions</th><th>Window</th><th>Attempts</th><th>Status</th><th></th></tr>
  ${list.map((z) => `<tr><td>${esc(z.title)}<br><small style="color:var(--mut)">${esc(z.subject)}</small></td><td>${esc(z.department_name)}</td><td>${z.question_count} × ${z.marks_per_question}</td>
    <td>${fmt(z.start_at)}<br>→ ${fmt(z.end_at)}</td><td>${z.attempt_count}</td><td><span class="tag ${st[z.status]}">${z.status}</span></td>
    <td class="actions"><button class="btn xs ghost" onclick="viewQuizResults('${z.id}')">Results</button><button class="btn xs ghost" onclick="editQuiz('${z.id}')">Edit</button>
    ${z.status === 'published' ? `<button class="btn xs ghost" onclick="setQuizStatus('${z.id}','unpublished')">Unpublish</button>` : z.status === 'unpublished' ? `<button class="btn xs" onclick="setQuizStatus('${z.id}','published')">Republish</button>` : ''}
    ${z.status !== 'archived' ? `<button class="btn xs danger" onclick="archiveQuiz('${z.id}')">Archive</button>` : ''}</td></tr>`).join('')}</table></div>`;
}
let quizListCache = [];
async function setQuizStatus(id, status) { try { await api('/quizzes/' + id, { method: 'PATCH', body: { status } }); route(); } catch (e) { fail(e); } }
async function archiveQuiz(id) { if (confirm('Archive this quiz? Students will no longer see it, but all results are kept.')) setQuizStatus(id, 'archived'); }
function viewQuizResults(id) { rf = { q: '', quiz_id: id, subject: '', department_id: '', sort: 'recent' }; go('faculty/responses'); }
async function editQuiz(id) {
  const z = (await api('/quizzes')).find((x) => String(x.id) === String(id));
  if (!z) return;
  openModal(`<div class="mh"><h3>Edit quiz</h3><button class="btn xs ghost" onclick="closeModal()">✕</button></div>
  <form onsubmit="saveQuiz(event,'${z.id}')"><label class="f"><span>Title</span><input name="title" value="${esc(z.title)}" required></label>
  <div class="row"><label class="f"><span>From</span><input type="datetime-local" name="start" value="${toLocalInput(z.start_at)}" required></label><label class="f"><span>Until</span><input type="datetime-local" name="end" value="${toLocalInput(z.end_at)}" required></label>
  <label class="f"><span>Duration (min)</span><input type="number" name="duration" min="1" max="600" value="${z.duration_minutes}"></label></div>
  ${z.attempt_count ? '<div class="notice">Students have already attempted this quiz, so marks and department can no longer be changed.</div>' : `<div class="row"><label class="f"><span>Marks per question</span><input type="number" name="marks" min="0.5" step="0.5" value="${z.marks_per_question}"></label><label class="f"><span>Department</span><select name="department_id">${deptOptions(z.department_id)}</select></label></div>`}
  <label class="chk"><input type="checkbox" name="review" ${z.show_review ? 'checked' : ''}> Students can review answers</label>
  <label class="chk"><input type="checkbox" name="released" ${z.results_released ? 'checked' : ''}> Results released to students</label>
  <label class="chk"><input type="checkbox" name="retakes" ${z.allow_retakes ? 'checked' : ''}> Allow retakes (max attempts: <input name="max_attempts" type="number" min="2" max="20" value="${z.max_attempts > 1 ? z.max_attempts : 2}" style="width:70px">)</label>
  <button class="btn">Save changes</button></form>`);
}
async function saveQuiz(e, id) {
  e.preventDefault();
  const f = new FormData(e.target);
  const body = { title: f.get('title'), start_at: new Date(f.get('start')).toISOString(), end_at: new Date(f.get('end')).toISOString(), duration_minutes: +f.get('duration'), show_review: f.has('review'), results_released: f.has('released'), allow_retakes: f.has('retakes'), max_attempts: +f.get('max_attempts') || 2 };
  if (f.has('marks')) { body.marks_per_question = +f.get('marks'); body.department_id = +f.get('department_id'); }
  try { await api('/quizzes/' + id, { method: 'PATCH', body }); closeModal(); toast('Quiz updated', 'ok'); route(); } catch (x) { fail(x); }
}

// ----- responses -----
let respTimer = null;
function debounceResp() { clearTimeout(respTimer); respTimer = setTimeout(loadResponses, 350); }
const rfQuery = () => new URLSearchParams(Object.fromEntries(Object.entries(rf).filter(([, v]) => v))).toString();
async function loadResponses() {
  const box = document.getElementById('rtable');
  if (!box) return;
  try {
    const rows = await api('/faculty/results?' + rfQuery());
    if (!rows.length) { box.innerHTML = '<div class="empty">No results match.</div>'; return; }
    box.innerHTML = `<div class="tablewrap"><table><tr><th>Student Name</th><th>Roll Number</th><th>Department</th><th>Quiz Name</th><th>Marks</th><th>Percentage</th><th>Status</th></tr>
    ${rows.map((r) => `<tr class="click" onclick="showDetail('${r.id}')"><td>${esc(r.student_name)}</td><td>${esc(r.roll_number)}</td><td>${esc(r.department)}</td><td>${esc(r.quiz_title)}</td>
      <td>${r.status === 'Submitted' ? mark(r.score) + ' / ' + mark(r.total_marks) : '—'}</td><td>${pct(r.percentage)}</td><td><span class="tag ${r.status === 'Submitted' ? 'ok' : 'warn'}">${r.status}</span></td></tr>`).join('')}</table></div>
    <p class="no-print" style="color:var(--mut);font-size:.85rem">${rows.length} result(s). Click a row for the detailed report.</p>`;
  } catch (e) { box.innerHTML = `<div class="notice err">${esc(e.message)}</div>`; }
}
async function exportCsv() {
  try {
    const r = await api('/faculty/results.csv?' + rfQuery(), { raw: true });
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement('a'); a.href = url; a.download = 'nsite-results.csv'; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch (e) { fail(e); }
}
async function showDetail(id) {
  try {
    const d = await api('/faculty/results/' + id);
    openModal(`<div class="mh"><h3>Student report</h3><button class="btn xs ghost no-print" onclick="printModal()">🖨️ Print</button><button class="btn xs ghost no-print" onclick="closeModal()">✕</button></div>
    <div class="kv"><div><small>Student</small>${esc(d.student_name)}</div><div><small>Roll number</small>${esc(d.roll_number)}</div><div><small>Department</small>${esc(d.department)}</div><div><small>Quiz</small>${esc(d.quiz_title)}</div>
    <div><small>Marks</small>${d.status === 'submitted' ? mark(d.score) + ' / ' + mark(d.total_marks) : 'Not submitted'}</div><div><small>Percentage</small>${pct(d.percentage)}</div>
    <div><small>Correct / Wrong / Unanswered</small>${d.correct ?? '—'} / ${d.incorrect ?? '—'} / ${d.unanswered ?? '—'}</div><div><small>Time taken</small>${dur(d.time_taken_sec)}</div>
    <div><small>Submitted</small>${fmt(d.submitted_at)}</div></div>
    ${d.questions.map((x, i) => `<div class="qcard"><b>Q${i + 1}.</b> ${esc(x.question)}
      <div style="margin:8px 0">${x.options.map((o, j) => `<div class="choice static ${j === x.correct_index ? 'right' : j === x.selected ? 'wrong' : ''}" style="padding:8px 12px;margin-bottom:6px"><b>${LETTERS[j]}</b><span>${esc(o)}${j === x.selected ? ' <em>(student)</em>' : ''}${j === x.correct_index ? ' ✓' : ''}</span></div>`).join('')}</div>
      <span class="tag ${x.selected == null ? 'gray' : x.is_correct ? 'ok' : 'bad'}">${x.selected == null ? 'Unanswered' : x.is_correct ? 'Correct' : 'Incorrect'}</span> Marks awarded: <b>${mark(x.marks_awarded)}</b></div>`).join('')}`);
  } catch (e) { fail(e); }
}
function printModal() { document.body.classList.add('print-modal'); window.print(); setTimeout(() => document.body.classList.remove('print-modal'), 500); }

// ----- reports -----
async function quizReport(id) {
  try {
    const d = await api('/faculty/analytics/' + id);
    const max = Math.max(1, ...d.distribution);
    openModal(`<div class="mh"><h3>${esc(d.quiz.title)}</h3><button class="btn xs ghost" onclick="closeModal()">✕</button></div>
    <p>${d.attempts} submission(s)</p><h4>Score distribution</h4>
    ${['0-20%', '20-40%', '40-60%', '60-80%', '80-100%'].map((l, i) => `<div style="display:flex;gap:10px;align-items:center;margin-bottom:6px"><span style="width:70px">${l}</span><div class="bar" style="flex:1"><div style="width:${(d.distribution[i] / max) * 100}%"></div></div><b>${d.distribution[i]}</b></div>`).join('')}
    <h4 style="margin-top:18px">Question-wise performance</h4>
    ${d.questions.map((x, i) => `<div style="margin-bottom:10px"><div style="font-size:.9rem">Q${i + 1}. ${esc(x.question)}</div><div style="display:flex;gap:10px;align-items:center"><div class="bar" style="flex:1"><div style="width:${x.correct_pct || 0}%"></div></div><b>${x.correct_pct == null ? '—' : x.correct_pct + '% correct'}</b></div></div>`).join('')}`);
  } catch (e) { fail(e); }
}

// ----- admin: departments -----
async function addDept(e) { e.preventDefault(); try { await api('/admin/departments', { method: 'POST', body: { name: new FormData(e.target).get('name') } }); depts = []; route(); } catch (x) { fail(x); } }
async function renameDept(id) {
  const cur = depts.find((d) => d.id === id);
  const name = prompt('New name for the department:', cur ? cur.name : '');
  if (!name) return;
  try { await api('/admin/departments/' + id, { method: 'PUT', body: { name } }); depts = []; route(); } catch (x) { fail(x); }
}
async function delDept(id) { if (!confirm('Delete this department?')) return; try { await api('/admin/departments/' + id, { method: 'DELETE' }); depts = []; route(); } catch (x) { fail(x); } }
