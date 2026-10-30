'use strict';
// ===== Core: helpers, API, router, home, login/register =====
const API = ((window.APP_CONFIG && window.APP_CONFIG.API_URL) || '').replace(/\/$/, '');
const app = document.getElementById('app');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const pct = (n) => (n == null ? '—' : Math.round(n * 10) / 10 + '%');
const mark = (n) => (n == null ? '—' : Math.round(n * 100) / 100);
const dur = (s) => (s == null ? '—' : Math.floor(s / 60) + 'm ' + (s % 60) + 's');
const LETTERS = ['A', 'B', 'C', 'D'];

let token = localStorage.getItem('nsite_token');
let me = null;
try { me = JSON.parse(localStorage.getItem('nsite_user') || 'null'); } catch (e) { me = null; }
let depts = [];
let quizTimer = null;

function toast(msg, type) {
  const el = document.createElement('div');
  el.className = 'toast ' + (type || '');
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), type === 'err' ? 6000 : 3500);
}
const fail = (e) => toast(e && e.message ? e.message : 'Something went wrong', 'err');

async function api(path, opts) {
  opts = opts || {};
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (opts.body) headers['Content-Type'] = 'application/json';
  let r;
  try {
    r = await fetch(API + '/api' + path, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  } catch (e) {
    throw new Error('Cannot reach the server. Check your internet. Free servers sleep when unused, so the first try can take up to a minute - please try again.');
  }
  if (opts.raw) {
    if (!r.ok) throw new Error('Download failed');
    return r;
  }
  const d = await r.json().catch(() => ({}));
  if (r.status === 401 && token) { logout(true); throw new Error(d.error || 'Please log in again.'); }
  if (!r.ok) throw new Error(d.error || 'Request failed');
  return d;
}

function setSession(d) {
  token = d.token; me = d.user;
  localStorage.setItem('nsite_token', token);
  localStorage.setItem('nsite_user', JSON.stringify(me));
}
function logout(silent) {
  token = null; me = null;
  localStorage.removeItem('nsite_token'); localStorage.removeItem('nsite_user');
  clearInterval(quizTimer);
  location.hash = '#/';
  if (!silent) toast('You have been logged out.', 'ok');
}
async function loadDepts() {
  if (!depts.length) depts = await api('/departments');
  return depts;
}
const deptOptions = (sel) => depts.map((d) => `<option value="${d.id}" ${String(d.id) === String(sel) ? 'selected' : ''}>${esc(d.name)}</option>`).join('');

function openModal(html) {
  document.getElementById('modal-root').innerHTML = `<div class="modal-bg" onclick="if(event.target===this)closeModal()"><div class="modal">${html}</div></div>`;
}
function closeModal() { document.getElementById('modal-root').innerHTML = ''; }
function go(path) { if (location.hash === '#/' + path) route(); else location.hash = '#/' + path; }

function navbar() {
  const links = me ? `<a href="#/${me.role === 'student' ? 'student/available' : 'faculty/overview'}">Dashboard</a><a href="#" onclick="logout();return false">Logout</a>` : '';
  return `<header class="nav no-print"><a class="brand" href="#/"><span class="logo">Q</span><span>QUIZORA <b>AI</b></span></a>
    ${me ? `<button class="burger" aria-label="Menu" onclick="document.body.classList.toggle('menu')">☰</button><nav>${links}</nav>` : ''}</header>`;
}
function shell(inner) {
  document.body.classList.remove('menu');
  app.innerHTML = navbar() + inner;
}

// ---------- router ----------
window.addEventListener('hashchange', () => { closeModal(); route(); });
async function route() {
  clearInterval(quizTimer);
  const [, a, b, c] = location.hash.split('/');
  try {
    if (!a || a === 'about' || a === 'features') return renderHome();
    if (a === 'login') return renderAuth(b, c);
    if (a === 'faculty') {
      if (!me || me.role === 'student') return go('login/faculty');
      return renderFaculty(b || 'overview');
    }
    if (a === 'student') {
      if (!me || me.role !== 'student') return go('login/student');
      return renderStudent(b || 'available');
    }
    if (a === 'quiz') { if (!me || me.role !== 'student') return go('login/student'); return renderQuiz(); }
    if (a === 'result') { if (!me || me.role !== 'student') return go('login/student'); return renderResult(b); }
    renderHome();
  } catch (e) { fail(e); }
}

// ---------- home: only the two logins ----------
function renderHome() {
  shell(`
  <section class="hero only">
    <h1>QUIZORA <span>AI</span></h1>
    <p>Smart AI-powered question generation and assessment for students and faculty.</p>
    <div class="cta">
      <a class="btn big" href="#/login/student">🧑‍🎓 Student Login</a>
      <a class="btn big alt" href="#/login/faculty">👩‍🏫 Faculty Login</a>
    </div>
  </section>`);
  window.scrollTo(0, 0);
}

// ---------- login / register ----------
let authMode = 'login';
async function renderAuth(role, mode) {
  if (role !== 'student' && role !== 'faculty') return renderHome();
  if (mode) authMode = mode;
  await loadDepts().catch(fail);
  const reg = authMode === 'register';
  const label = role === 'student' ? 'Student' : 'Faculty';
  shell(`<div class="authwrap"><div class="card">
    <h2>${label} ${reg ? 'Registration' : 'Login'}</h2>
    <div class="tabs"><button class="${reg ? '' : 'on'}" onclick="authMode='login';renderAuth('${role}')">Login</button><button class="${reg ? 'on' : ''}" onclick="authMode='register';renderAuth('${role}')">Register</button></div>
    <form onsubmit="doAuth(event,'${role}')">
      ${reg ? `<label class="f"><span>Full name</span><input name="full_name" required maxlength="100" autocomplete="name"></label>
      <label class="f"><span>Department</span><select name="department_id" required><option value="">Select department</option>${deptOptions()}</select></label>
      ${role === 'student' ? '<label class="f"><span>Roll number</span><input name="roll_number" required maxlength="30"></label>' : ''}` : ''}
      <label class="f"><span>Email address</span><input name="email" type="email" required autocomplete="email"></label>
      <label class="f"><span>Password${reg ? ' (at least 8 characters)' : ''}</span><input name="password" type="password" required minlength="${reg ? 8 : 1}" autocomplete="${reg ? 'new-password' : 'current-password'}"></label>
      <button class="btn" style="width:100%" id="authbtn">${reg ? 'Create account' : 'Login'}</button>
    </form>
    <p style="text-align:center;margin:14px 0 0"><a href="#/">← Back</a></p>
  </div></div>`);
}
async function doAuth(e, role) {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target).entries());
  const btn = document.getElementById('authbtn');
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Please wait…';
  try {
    const d = await api(authMode === 'register' ? '/auth/register' : '/auth/login', { method: 'POST', body: { ...f, role } });
    setSession(d);
    toast('Welcome, ' + d.user.full_name + '!', 'ok');
    go(d.user.role === 'student' ? 'student/available' : 'faculty/overview');
  } catch (err) { fail(err); btn.disabled = false; btn.textContent = authMode === 'register' ? 'Create account' : 'Login'; }
}

// ---------- shared dashboard shell and profile ----------
function dashLayout(kind, items, active, content, subtitle) {
  return `<div class="dash"><aside class="sidebar no-print"><div class="who"><div class="avatar">${esc((me.full_name || '?')[0].toUpperCase())}</div><div><b>${esc(me.full_name)}</b><small>${subtitle}</small></div></div>
  ${items.map(([k, i, l]) => `<a class="${k === active ? 'on' : ''}" href="#/${kind}/${k}">${i} ${l}</a>`).join('')}
  <a href="#" onclick="logout();return false">🚪 Logout</a></aside><main class="main"><div id="content">${content}</div></main></div>`;
}
function profileHtml() {
  return `<h2>Profile</h2><div class="card" style="max-width:560px;margin-bottom:16px"><div class="kv">
    <div><small>Name</small>${esc(me.full_name)}</div><div><small>Email</small>${esc(me.email)}</div>
    <div><small>Role</small>${esc(me.role)}</div>${me.department_name ? `<div><small>Department</small>${esc(me.department_name)}</div>` : ''}
    ${me.roll_number ? `<div><small>Roll number</small>${esc(me.roll_number)}</div>` : ''}</div>
    <form onsubmit="saveName(event)"><label class="f"><span>Change name</span><input name="full_name" value="${esc(me.full_name)}" required maxlength="100"></label><button class="btn sm">Save name</button></form></div>
    <div class="card" style="max-width:560px"><h3>Change password</h3><form onsubmit="savePassword(event)">
    <label class="f"><span>Current password</span><input name="current_password" type="password" required></label>
    <label class="f"><span>New password (min 8 characters)</span><input name="new_password" type="password" minlength="8" required></label><button class="btn sm">Change password</button></form></div>`;
}
async function saveName(e) {
  e.preventDefault();
  try { setSession(await api('/me', { method: 'PUT', body: { full_name: new FormData(e.target).get('full_name') } })); toast('Name updated', 'ok'); route(); } catch (err) { fail(err); }
}
async function savePassword(e) {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target).entries());
  try { await api('/me/password', { method: 'PUT', body: f }); e.target.reset(); toast('Password changed', 'ok'); } catch (err) { fail(err); }
}

route();
