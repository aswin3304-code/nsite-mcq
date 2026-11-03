'use strict';
// ===== Student dashboard, quiz taking, results =====
const SSEC = [
  ['available', '📝', 'Available Quizzes'], ['subjects', '📘', 'My Subjects'], ['upcoming', '⏳', 'Upcoming Quizzes'],
  ['completed', '✅', 'Completed Quizzes'], ['marks', '🏅', 'My Marks'], ['performance', '📈', 'My Performance'], ['profile', '👤', 'Profile'],
];
let qs = null; // active quiz state

async function renderStudent(sec) {
  if (!SSEC.find((i) => i[0] === sec)) sec = 'available';
  shell(dashLayout('student', SSEC, sec, '<div class="loading">Loading…</div>', `${esc(me.department_name)}<br>Roll no: ${esc(me.roll_number)}`));
  const el = () => document.getElementById('content');
  try {
    const welcome = `<div class="welcome"><h2>Welcome, ${esc(me.full_name)}!</h2><p>${esc(me.department_name)} · Roll number ${esc(me.roll_number)}</p></div>`;
    let html;
    if (sec === 'profile') html = welcome + profileHtml();
    else {
      const [quizzes, results] = await Promise.all([api('/student/quizzes'), api('/student/results')]);
      html = welcome + SPAGES[sec](quizzes, results);
    }
    if (el()) el().innerHTML = html;
  } catch (e) { if (el()) el().innerHTML = `<div class="notice err">${esc(e.message)}</div>`; }
}

function quizCard(z) {
  const status = z.phase === 'live' ? '<span class="tag ok">Open now</span>' : z.phase === 'upcoming' ? '<span class="tag warn">Upcoming</span>' : '<span class="tag gray">Closed</span>';
  let btn = '';
  if (z.in_progress_id && z.phase === 'live') btn = `<button class="btn sm" onclick="startQuiz('${z.id}')">▶ Resume quiz</button>`;
  else if (z.can_start) btn = `<button class="btn sm" onclick="startQuiz('${z.id}')">${z.done_count ? '🔁 Retake quiz' : '▶ Start Quiz'}</button>`;
  else if (z.last_attempt_id) btn = `<a class="btn sm alt" href="#/result/${z.last_attempt_id}">View result</a>`;
  return `<div class="card"><div style="display:flex;justify-content:space-between;gap:8px;align-items:start"><h3 style="margin:0">${esc(z.title)}</h3>${status}</div>
    <p style="color:var(--mut);margin:6px 0 10px">${esc(z.subject)}${z.topic ? ' · ' + esc(z.topic) : ''}<br>Faculty: ${esc(z.faculty_name)}</p>
    <div class="kv" style="margin-bottom:10px"><div><small>Questions</small>${z.question_count}</div><div><small>Total marks</small>${mark(z.total_marks)}</div><div><small>Duration</small>${z.duration_minutes} min</div></div>
    <p style="font-size:.85rem;color:var(--mut)">${fmt(z.start_at)} → ${fmt(z.end_at)}${z.done_count ? `<br>Attempts used: ${z.done_count}${z.allow_retakes ? ' / ' + z.max_attempts : ''}` : ''}</p>${btn}</div>`;
}
const cards = (list, msg) => (list.length ? `<div class="grid">${list.map(quizCard).join('')}</div>` : `<div class="empty">${msg}</div>`);

const SPAGES = {
  available: (qz) => `<h2>Available Quizzes</h2>${cards(qz.filter((z) => z.phase === 'live'), 'No quizzes are open for your department right now.')}`,
  upcoming: (qz) => `<h2>Upcoming Quizzes</h2>${cards(qz.filter((z) => z.phase === 'upcoming'), 'No upcoming quizzes.')}`,
  subjects: (qz, rs) => {
    const subs = [...new Set(qz.map((z) => z.subject).filter(Boolean).concat(rs.map((r) => r.subject).filter(Boolean)))];
    if (!subs.length) return '<h2>My Subjects</h2><div class="empty">Subjects appear here once quizzes are published for your department.</div>';
    return `<h2>My Subjects</h2><div class="grid">${subs.map((s) => {
      const total = qz.filter((z) => z.subject === s).length, done = rs.filter((r) => r.subject === s && r.percentage != null);
      const avg = done.length ? done.reduce((a, r) => a + r.percentage, 0) / done.length : null;
      return `<div class="card"><div class="ico">📘</div><h3>${esc(s)}</h3><p style="color:var(--mut);margin:0">${total} quiz(zes) · ${rs.filter((r) => r.subject === s).length} completed<br>Average: <b>${pct(avg)}</b></p></div>`;
    }).join('')}</div>`;
  },
  completed: (qz, rs) => `<h2>Completed Quizzes</h2>${rs.length ? `<div class="tablewrap"><table><tr><th>Quiz</th><th>Subject</th><th>Submitted</th><th>Score</th><th></th></tr>${rs.map((r) => `<tr><td>${esc(r.title)}</td><td>${esc(r.subject)}</td><td>${fmt(r.submitted_at)}</td><td>${r.score == null ? '<span class="tag warn">Not released</span>' : mark(r.score) + ' / ' + mark(r.total_marks)}</td><td><a class="btn xs ghost" href="#/result/${r.id}">View</a></td></tr>`).join('')}</table></div>` : '<div class="empty">You have not completed any quiz yet.</div>'}`,
  marks: (qz, rs) => `<h2>My Marks</h2>${rs.length ? `<div class="tablewrap"><table><tr><th>Quiz</th><th>Subject</th><th>Marks</th><th>Percentage</th><th>Correct</th><th>Wrong</th><th>Unanswered</th></tr>${rs.map((r) => `<tr><td>${esc(r.title)}</td><td>${esc(r.subject)}</td><td>${r.score == null ? '—' : mark(r.score) + ' / ' + mark(r.total_marks)}</td><td>${pct(r.percentage)}</td><td>${r.correct ?? '—'}</td><td>${r.incorrect ?? '—'}</td><td>${r.unanswered ?? '—'}</td></tr>`).join('')}</table></div>` : '<div class="empty">No marks yet.</div>'}`,
  performance: (qz, rs) => {
    const vis = rs.filter((r) => r.percentage != null);
    if (!vis.length) return '<h2>My Performance</h2><div class="empty">Your performance chart appears after you complete a quiz.</div>';
    const avg = vis.reduce((a, r) => a + r.percentage, 0) / vis.length, best = Math.max(...vis.map((r) => r.percentage));
    return `<h2>My Performance</h2><div class="grid" style="margin-bottom:18px"><div class="stat"><b>${vis.length}</b><span>Quizzes completed</span></div><div class="stat"><b>${pct(avg)}</b><span>Average score</span></div><div class="stat"><b>${pct(best)}</b><span>Best score</span></div></div>
    <div class="card"><h3>Score by quiz</h3>${vis.slice().reverse().map((r) => `<div style="margin-bottom:12px"><div style="display:flex;justify-content:space-between;font-size:.9rem"><span>${esc(r.title)}</span><b>${pct(r.percentage)}</b></div><div class="bar"><div style="width:${r.percentage}%"></div></div></div>`).join('')}</div>`;
  },
};

// ----- taking a quiz -----
async function startQuiz(id) {
  try {
    const d = await api('/student/quizzes/' + id + '/start', { method: 'POST' });
    qs = { attempt: d.attempt_id, title: d.quiz_title, questions: d.questions, answers: d.answers || {}, idx: 0, skew: new Date(d.server_now).getTime() - Date.now(), deadline: new Date(d.deadline_at).getTime(), submitting: false, saveT: null };
    if (location.hash === '#/quiz/' + d.attempt_id) route(); else location.hash = '#/quiz/' + d.attempt_id;
  } catch (e) { fail(e); }
}
function renderQuiz() {
  if (!qs) return go('student/available');
  app.innerHTML = `<div class="qtop"><b style="flex:1;min-width:140px">${esc(qs.title)}</b><span id="qcount" style="color:var(--mut);font-size:.9rem"></span><span class="timer" id="timer">--:--</span><button class="btn sm" onclick="submitQuiz(false)">Submit Quiz</button></div>
    <div class="qpage" id="qbody"></div>`;
  drawQuestion();
  const tick = () => {
    const left = Math.max(0, qs.deadline - (Date.now() + qs.skew));
    const t = document.getElementById('timer');
    if (!t) return;
    const s = Math.ceil(left / 1000);
    t.textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
    t.classList.toggle('low', s <= 60);
    if (left <= 0 && !qs.submitting) { toast("Time is up! Submitting your quiz…", 'ok'); submitQuiz(true); }
  };
  tick();
  quizTimer = setInterval(tick, 1000);
}
function drawQuestion() {
  const x = qs.questions[qs.idx], n = qs.questions.length;
  const answered = Object.keys(qs.answers).length;
  document.getElementById('qcount').textContent = `Answered ${answered} · Unanswered ${n - answered}`;
  document.getElementById('qbody').innerHTML = `
    <div class="pal">${qs.questions.map((q, i) => `<button class="${qs.answers[q.id] !== undefined ? 'done' : ''} ${i === qs.idx ? 'cur' : ''}" onclick="qs.idx=${i};drawQuestion()">${i + 1}</button>`).join('')}</div>
    <div class="card"><div style="color:var(--mut);font-weight:700;margin-bottom:6px">Question ${qs.idx + 1} of ${n}</div>
    <h3 style="font-size:1.15rem;margin-bottom:16px">${esc(x.question)}</h3>${x.image ? `<img class="qimg" src="${x.image}" alt="Question picture">` : ''}
    ${x.options.map((o, j) => `<button class="choice ${qs.answers[x.id] === j ? 'sel' : ''}" onclick="pick('${x.id}',${j})"><b>${LETTERS[j]}</b><span>${esc(o)}</span></button>`).join('')}
    <div class="actions" style="justify-content:space-between;margin-top:14px"><button class="btn alt sm" ${qs.idx === 0 ? 'disabled' : ''} onclick="qs.idx--;drawQuestion()">← Previous</button>
    ${qs.idx < n - 1 ? '<button class="btn sm" onclick="qs.idx++;drawQuestion()">Next →</button>' : '<button class="btn sm" onclick="submitQuiz(false)">Submit Quiz</button>'}</div></div>`;
}
function pick(qid, j) {
  if (qs.submitting) return;
  qs.answers[qid] = j;
  drawQuestion();
  clearTimeout(qs.saveT);
  qs.saveT = setTimeout(() => api('/student/attempts/' + qs.attempt + '/save', { method: 'POST', body: { answers: qs.answers } }).catch(() => {}), 700);
}
async function submitQuiz(auto) {
  if (!qs || qs.submitting) return;
  const n = qs.questions.length, answered = Object.keys(qs.answers).length;
  if (!auto && !confirm(`Submit your quiz now?\n\nAnswered: ${answered} of ${n}` + (answered < n ? `\nUnanswered: ${n - answered}` : '') + '\n\nYou cannot change answers after submitting.')) return;
  unlockSound(); // a tap is needed before browsers allow sound
  qs.submitting = true; clearTimeout(qs.saveT);
  const id = qs.attempt;
  try {
    await api('/student/attempts/' + id + '/submit', { method: 'POST', body: { answers: qs.answers } });
    qs = null; clearInterval(quizTimer);
    location.hash = '#/result/' + id;
  } catch (e) {
    qs.submitting = false; fail(e);
    if (auto) setTimeout(() => submitQuiz(true), 4000); // keep retrying if the connection dropped
  }
}

// ----- results -----
async function renderResult(id) {
  shell('<div class="loading">Loading result…</div>');
  try {
    const d = await api('/student/attempts/' + id);
    const head = `<div class="kv"><div><small>Student</small>${esc(d.student_name)}</div><div><small>Roll number</small>${esc(d.roll_number)}</div><div><small>Department</small>${esc(d.department)}</div><div><small>Quiz</small>${esc(d.quiz_title)}</div><div><small>Submitted</small>${fmt(d.submitted_at)}</div></div>`;
    let body;
    if (!d.released) body = `<div class="notice ok">✅ ${esc(d.message)}</div>`;
    else {
      body = `<div class="grid" style="margin-bottom:18px"><div class="stat"><div class="bigscore">${mark(d.score)} <small style="font-size:1.1rem;color:var(--mut)">/ ${mark(d.total_marks)}</small></div><span>Marks obtained</span></div>
        <div class="stat"><b>${pct(d.percentage)}</b><span>Percentage</span></div><div class="stat"><b style="color:var(--ok)">${d.correct}</b><span>Correct</span></div>
        <div class="stat"><b style="color:var(--bad)">${d.incorrect}</b><span>Incorrect</span></div><div class="stat"><b>${d.unanswered}</b><span>Unanswered</span></div><div class="stat"><b>${dur(d.time_taken_sec)}</b><span>Time taken</span></div></div>`;
      if (d.review) body += '<h3>Answer review</h3>' + d.review.map((x, i) => `<div class="qcard"><b>Q${i + 1}.</b> ${esc(x.question)}${x.image ? `<img class="qimg" style="margin-top:10px" src="${x.image}" alt="">` : ''}<div style="margin:10px 0">${x.options.map((o, j) => `<div class="choice static ${j === x.correct_index ? 'right' : j === x.selected ? 'wrong' : ''}" style="padding:9px 12px;margin-bottom:6px"><b>${LETTERS[j]}</b><span>${esc(o)}${j === x.selected ? ' <em>(your answer)</em>' : ''}${j === x.correct_index ? ' ✓' : ''}</span></div>`).join('')}</div>
        ${x.selected == null ? '<span class="tag gray">Unanswered</span>' : x.is_correct ? '<span class="tag ok">Correct</span>' : '<span class="tag bad">Incorrect</span>'}${x.explanation ? `<p style="color:var(--mut);margin:8px 0 0"><b>Explanation:</b> ${esc(x.explanation)}</p>` : ''}</div>`).join('');
      else body += '<div class="notice">Answer review is not enabled for this quiz.</div>';
    }
    shell(`<div class="qpage"><div class="card" style="margin-bottom:16px"><h2>Quiz result</h2>${head}</div>${body}<div class="actions no-print" style="margin:16px 0"><a class="btn" href="#/student/completed">Back to dashboard</a><button class="btn alt" onclick="window.print()">🖨️ Print</button></div></div>`);
    if (d.released && d.percentage > CELEBRATE_AT) celebrate(d, id);
  } catch (e) {
    shell(`<div class="qpage"><div class="notice err">${esc(e.message)}</div><a class="btn" href="#/student/completed">Back to dashboard</a></div>`);
  }
}

// ----- congratulations popup (above 80%) -----
const CELEBRATE_AT = 80; // popup + music only when the percentage is MORE than this
let sndCtx = null;
function unlockSound() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    if (!sndCtx) sndCtx = new AC();
    if (sndCtx.state === 'suspended') sndCtx.resume();
  } catch (e) { /* sound is optional */ }
}
function celebMusic() {
  try {
    unlockSound(); const ctx = sndCtx; if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    const t0 = ctx.currentTime + 0.05;
    // C E G C(high) then a held chord: a short happy fanfare
    const notes = [[523.25, 0], [659.25, 0.16], [783.99, 0.32], [1046.5, 0.48], [783.99, 0.8], [1046.5, 0.96], [1318.5, 1.12]];
    notes.forEach(([f, t]) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'triangle'; o.frequency.value = f; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.0001, t0 + t); g.gain.exponentialRampToValueAtTime(0.25, t0 + t + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, t0 + t + 0.45);
      o.start(t0 + t); o.stop(t0 + t + 0.5);
    });
  } catch (e) { /* sound is optional */ }
}
function celebrate(d, id) {
  try { if (sessionStorage.getItem('celebrated-' + id)) return; sessionStorage.setItem('celebrated-' + id, '1'); } catch (e) { /* ignore */ }
  const p = Math.round(d.percentage), top = p >= 90;
  const first = esc((d.student_name || '').split(' ')[0]);
  const bits = ['🎉', '🎊', '⭐', '🏆', '✨', '👏', '🌟'];
  const confetti = Array.from({ length: 60 }, (_, i) => {
    const left = Math.random() * 100, delay = Math.random() * 1.5, dur = 2.8 + Math.random() * 2.5;
    return i % 3 === 0 ? `<i class="cf e" style="left:${left}%;animation-delay:${delay}s;animation-duration:${dur}s">${bits[i % bits.length]}</i>`
      : `<i class="cf" style="left:${left}%;animation-delay:${delay}s;animation-duration:${dur}s;background:hsl(${Math.random() * 360},85%,60%)"></i>`;
  }).join('');
  const el = document.createElement('div');
  el.className = 'celeb'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Congratulations');
  el.innerHTML = `${confetti}<div class="celebbox"><div class="trophy">${top ? '🏆' : '🎉'}</div>
    <h2>${top ? 'Outstanding!' : 'Congratulations!'} ${first}</h2>
    <div class="ring"><b>${p}%</b></div>
    <p>${top ? 'Brilliant work, you are among the top scorers! 🌟' : 'Great job! You scored well, keep it up! 👏'}</p>
    <div class="emo">🎊 🥳 ⭐ 👏 🎉</div>
    <div class="actions" style="justify-content:center"><button class="btn" id="celebOk">Continue</button><button class="btn ghost sm" id="celebSnd" title="Play sound">🔊</button></div></div>`;
  document.body.appendChild(el);
  const close = () => el.remove();
  el.querySelector('#celebOk').onclick = close;
  el.querySelector('#celebSnd').onclick = celebMusic;
  el.addEventListener('click', (e) => { if (e.target === el) close(); });
  celebMusic();
  setTimeout(() => { document.querySelectorAll('.celeb .cf').forEach((c) => c.remove()); }, 8000);
}
