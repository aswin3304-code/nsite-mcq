-- Runs automatically every time the server starts. Safe to run repeatedly.
create extension if not exists pgcrypto;

create table if not exists departments (
  id serial primary key,
  name text unique not null
);

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  role text not null check (role in ('student','faculty','admin')),
  full_name text not null,
  email text unique not null,
  password_hash text not null,
  department_id int references departments(id),
  roll_number text,
  created_at timestamptz default now()
);
create unique index if not exists users_roll_unique on users (department_id, lower(roll_number)) where role = 'student';

create table if not exists materials (
  id bigserial primary key,
  faculty_id uuid not null references users(id) on delete cascade,
  department_id int references departments(id),
  subject text,
  topic text,
  link text,
  filename text,
  text_content text,
  created_at timestamptz default now()
);

create table if not exists question_sets (
  id bigserial primary key,
  faculty_id uuid not null references users(id) on delete cascade,
  department_id int references departments(id),
  title text not null,
  subject text,
  topic text,
  material_id bigint references materials(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists questions (
  id bigserial primary key,
  set_id bigint not null references question_sets(id) on delete cascade,
  position int not null default 0,
  topic text,
  question text not null,
  options jsonb not null,
  correct_index int not null check (correct_index between 0 and 3),
  explanation text,
  difficulty text default 'Medium'
);

create table if not exists quizzes (
  id bigserial primary key,
  faculty_id uuid not null references users(id) on delete cascade,
  set_id bigint references question_sets(id) on delete set null,
  department_id int not null references departments(id),
  title text not null,
  subject text,
  topic text,
  marks_per_question numeric not null default 1,
  duration_minutes int not null default 30,
  start_at timestamptz not null,
  end_at timestamptz not null,
  show_review boolean not null default true,
  results_released boolean not null default true,
  allow_retakes boolean not null default false,
  max_attempts int not null default 1,
  status text not null default 'published' check (status in ('published','unpublished','archived')),
  created_at timestamptz default now()
);

-- Copy of the questions at publishing time, so later edits to a set never change a live quiz.
create table if not exists quiz_questions (
  id bigserial primary key,
  quiz_id bigint not null references quizzes(id) on delete cascade,
  position int not null default 0,
  question text not null,
  options jsonb not null,
  correct_index int not null,
  explanation text
);

create table if not exists attempts (
  id bigserial primary key,
  quiz_id bigint not null references quizzes(id) on delete cascade,
  student_id uuid not null references users(id) on delete cascade,
  started_at timestamptz not null default now(),
  deadline_at timestamptz not null,
  submitted_at timestamptz,
  status text not null default 'in_progress' check (status in ('in_progress','submitted')),
  answers jsonb not null default '{}'::jsonb,
  score numeric,
  correct int,
  incorrect int,
  unanswered int,
  total_marks numeric,
  percentage numeric,
  time_taken_sec int
);
create index if not exists attempts_quiz_idx on attempts (quiz_id);
create index if not exists attempts_student_idx on attempts (student_id);
create index if not exists quiz_questions_quiz_idx on quiz_questions (quiz_id);
create index if not exists questions_set_idx on questions (set_id);

-- Block direct access through Supabase's public API. Only this server (database login) can read data.
alter table departments enable row level security;
alter table users enable row level security;
alter table materials enable row level security;
alter table question_sets enable row level security;
alter table questions enable row level security;
alter table quizzes enable row level security;
alter table quiz_questions enable row level security;
alter table attempts enable row level security;

insert into departments (name)
select x from unnest(array[
  'Computer Science and Engineering',
  'Artificial Intelligence and Machine Learning',
  'Electronics and Communication Engineering',
  'Electrical and Electronics Engineering',
  'Mechanical Engineering',
  'Civil Engineering',
  'Other'
]) as x
where not exists (select 1 from departments);
