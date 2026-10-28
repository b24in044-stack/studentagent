create table if not exists public.course_sections (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  name text not null,
  course text not null,
  term text not null default '',
  faculty text not null,
  faculty_email text not null default '',
  room text not null default '',
  schedule text not null default '',
  faculty_user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.section_subjects (
  section_id uuid not null references public.course_sections(id) on delete cascade,
  subject text not null,
  position integer not null default 0,
  primary key (section_id, subject)
);

create table if not exists public.students (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid references auth.users(id) on delete set null,
  name text not null,
  roll_no text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.section_enrollments (
  section_id uuid not null references public.course_sections(id) on delete cascade,
  student_id uuid not null references public.students(id) on delete restrict,
  attendance numeric(5, 2) check (attendance is null or attendance between 0 and 100),
  primary key (section_id, student_id)
);

create table if not exists public.student_marks (
  section_id uuid not null,
  student_id uuid not null,
  subject text not null,
  score numeric(6, 2) not null check (score between 0 and 100),
  primary key (section_id, student_id, subject),
  foreign key (section_id, student_id)
    references public.section_enrollments(section_id, student_id) on delete cascade,
  foreign key (section_id, subject)
    references public.section_subjects(section_id, subject) on delete cascade
);

create table if not exists public.course_materials (
  id text primary key,
  section_id uuid not null references public.course_sections(id) on delete cascade,
  name text not null,
  type text not null,
  subject text not null default 'All subjects',
  tags text[] not null default '{}',
  source text not null default 'Faculty upload'
    check (source in ('Faculty upload', 'Demo library')),
  excerpt text,
  created_at timestamptz not null default now()
);

create index if not exists course_sections_faculty_user_id_idx
  on public.course_sections(faculty_user_id);
create index if not exists section_enrollments_student_id_idx
  on public.section_enrollments(student_id);
create index if not exists students_auth_user_id_idx
  on public.students(auth_user_id);
create index if not exists course_materials_section_id_idx
  on public.course_materials(section_id);

create or replace function public.can_access_section(p_section_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.course_sections c
    where c.id = p_section_id
      and (
        (
          (auth.jwt() -> 'app_metadata' ->> 'role') = 'faculty'
          and c.faculty_user_id = (select auth.uid())
        )
        or (
          (auth.jwt() -> 'app_metadata' ->> 'role') = 'student'
          and exists (
            select 1
            from public.section_enrollments e
            join public.students s on s.id = e.student_id
            where e.section_id = c.id
              and s.auth_user_id = (select auth.uid())
          )
        )
      )
  );
$$;

create or replace function public.is_section_faculty(p_section_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'faculty'
    and exists (
      select 1 from public.course_sections c
      where c.id = p_section_id and c.faculty_user_id = (select auth.uid())
    );
$$;

create or replace function public.can_access_enrollment(p_section_id uuid, p_student_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.section_enrollments e
    join public.students s on s.id = e.student_id
    where e.section_id = p_section_id
      and e.student_id = p_student_id
      and (
        (
          (auth.jwt() -> 'app_metadata' ->> 'role') = 'faculty'
          and exists (
            select 1 from public.course_sections c
            where c.id = e.section_id and c.faculty_user_id = (select auth.uid())
          )
        )
        or (
          (auth.jwt() -> 'app_metadata' ->> 'role') = 'student'
          and s.auth_user_id = (select auth.uid())
        )
      )
  );
$$;

create or replace function public.can_access_student(p_student_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.section_enrollments e
    join public.course_sections c on c.id = e.section_id
    join public.students s on s.id = e.student_id
    where s.id = p_student_id
      and (
        (
          (auth.jwt() -> 'app_metadata' ->> 'role') = 'faculty'
          and c.faculty_user_id = (select auth.uid())
        )
        or (
          (auth.jwt() -> 'app_metadata' ->> 'role') = 'student'
          and s.auth_user_id = (select auth.uid())
        )
      )
  );
$$;

revoke all on function public.can_access_section(uuid) from public, anon;
revoke all on function public.is_section_faculty(uuid) from public, anon;
revoke all on function public.can_access_enrollment(uuid, uuid) from public, anon;
revoke all on function public.can_access_student(uuid) from public, anon;
grant execute on function public.can_access_section(uuid) to authenticated;
grant execute on function public.is_section_faculty(uuid) to authenticated;
grant execute on function public.can_access_enrollment(uuid, uuid) to authenticated;
grant execute on function public.can_access_student(uuid) to authenticated;

alter table public.course_sections enable row level security;
alter table public.section_subjects enable row level security;
alter table public.students enable row level security;
alter table public.section_enrollments enable row level security;
alter table public.student_marks enable row level security;
alter table public.course_materials enable row level security;

drop policy if exists "Section members can read their sections" on public.course_sections;
create policy "Section members can read their sections"
  on public.course_sections for select to authenticated
  using (public.can_access_section(id));
drop policy if exists "Faculty can create their sections" on public.course_sections;
create policy "Faculty can create their sections"
  on public.course_sections for insert to authenticated
  with check (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'faculty'
    and faculty_user_id = (select auth.uid())
  );
drop policy if exists "Faculty can update their sections" on public.course_sections;
create policy "Faculty can update their sections"
  on public.course_sections for update to authenticated
  using (public.is_section_faculty(id))
  with check (public.is_section_faculty(id));
drop policy if exists "Faculty can delete their sections" on public.course_sections;
create policy "Faculty can delete their sections"
  on public.course_sections for delete to authenticated
  using (public.is_section_faculty(id));

drop policy if exists "Section members can read subjects" on public.section_subjects;
create policy "Section members can read subjects"
  on public.section_subjects for select to authenticated
  using (public.can_access_section(section_id));
drop policy if exists "Faculty can manage subjects" on public.section_subjects;
create policy "Faculty can manage subjects"
  on public.section_subjects for all to authenticated
  using (public.is_section_faculty(section_id))
  with check (public.is_section_faculty(section_id));

drop policy if exists "Section faculty and students can read student profiles" on public.students;
create policy "Section faculty and students can read student profiles"
  on public.students for select to authenticated
  using (public.can_access_student(id));
drop policy if exists "Faculty can create student profiles" on public.students;
create policy "Faculty can create student profiles"
  on public.students for insert to authenticated
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'faculty');
drop policy if exists "Faculty can update student profiles" on public.students;
create policy "Faculty can update student profiles"
  on public.students for update to authenticated
  using (
    exists (
      select 1 from public.section_enrollments e
      where e.student_id = id and public.is_section_faculty(e.section_id)
    )
  )
  with check (
    exists (
      select 1 from public.section_enrollments e
      where e.student_id = id and public.is_section_faculty(e.section_id)
    )
  );
drop policy if exists "Members can read their own enrollment rows" on public.section_enrollments;
create policy "Members can read their own enrollment rows"
  on public.section_enrollments for select to authenticated
  using (public.can_access_enrollment(section_id, student_id));
drop policy if exists "Faculty can manage section enrollments" on public.section_enrollments;
create policy "Faculty can manage section enrollments"
  on public.section_enrollments for all to authenticated
  using (public.is_section_faculty(section_id))
  with check (public.is_section_faculty(section_id));

drop policy if exists "Members can read marks in their section" on public.student_marks;
create policy "Members can read marks in their section"
  on public.student_marks for select to authenticated
  using (public.can_access_enrollment(section_id, student_id));
drop policy if exists "Faculty can manage section marks" on public.student_marks;
create policy "Faculty can manage section marks"
  on public.student_marks for all to authenticated
  using (public.is_section_faculty(section_id))
  with check (public.is_section_faculty(section_id));

drop policy if exists "Section members can read materials" on public.course_materials;
create policy "Section members can read materials"
  on public.course_materials for select to authenticated
  using (public.can_access_section(section_id));
drop policy if exists "Faculty can manage course materials" on public.course_materials;
create policy "Faculty can manage course materials"
  on public.course_materials for all to authenticated
  using (public.is_section_faculty(section_id))
  with check (public.is_section_faculty(section_id));

create or replace function public.save_course_section(p_section jsonb)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_section_id uuid;
  v_student jsonb;
  v_student_id uuid;
  v_mark record;
  v_material jsonb;
  v_material_id text;
begin
  if (auth.jwt() -> 'app_metadata' ->> 'role') is distinct from 'faculty' then
    raise exception 'Faculty role required to save course sections';
  end if;

  v_section_id := coalesce(nullif(p_section ->> 'id', '')::uuid, gen_random_uuid());

  insert into public.course_sections (
    id, code, name, course, term, faculty, faculty_email, room, schedule, faculty_user_id
  ) values (
    v_section_id,
    p_section ->> 'code',
    p_section ->> 'name',
    p_section ->> 'course',
    coalesce(p_section ->> 'term', ''),
    p_section ->> 'faculty',
    coalesce(p_section ->> 'facultyEmail', ''),
    coalesce(p_section ->> 'room', ''),
    coalesce(p_section ->> 'schedule', ''),
    (select auth.uid())
  )
  on conflict (id) do update set
    code = excluded.code,
    name = excluded.name,
    course = excluded.course,
    term = excluded.term,
    faculty = excluded.faculty,
    faculty_email = excluded.faculty_email,
    room = excluded.room,
    schedule = excluded.schedule
  where public.course_sections.faculty_user_id = (select auth.uid());

  if not found then
    raise exception 'Section not found or not assigned to this faculty account';
  end if;

  delete from public.section_subjects where section_id = v_section_id;
  insert into public.section_subjects(section_id, subject, position)
  select v_section_id, subject, ordinality::integer - 1
  from jsonb_array_elements_text(coalesce(p_section -> 'subjects', '[]'::jsonb))
    with ordinality as values_by_position(subject, ordinality);

  for v_student in
    select value from jsonb_array_elements(coalesce(p_section -> 'students', '[]'::jsonb))
  loop
    v_student_id := coalesce(nullif(v_student ->> 'id', '')::uuid, gen_random_uuid());

    insert into public.students(id, name, roll_no)
    values (v_student_id, v_student ->> 'name', v_student ->> 'rollNo')
    on conflict (id) do update
      set name = excluded.name, roll_no = excluded.roll_no;
  end loop;

  delete from public.student_marks where section_id = v_section_id;
  delete from public.section_enrollments where section_id = v_section_id;

  for v_student in
    select value from jsonb_array_elements(coalesce(p_section -> 'students', '[]'::jsonb))
  loop
    v_student_id := coalesce(nullif(v_student ->> 'id', '')::uuid, gen_random_uuid());

    insert into public.section_enrollments(section_id, student_id, attendance)
    values (
      v_section_id,
      v_student_id,
      nullif(v_student ->> 'attendance', '')::numeric
    );

    for v_mark in
      select key as subject, value::numeric as score
      from jsonb_each_text(coalesce(v_student -> 'marks', '{}'::jsonb))
    loop
      insert into public.student_marks(section_id, student_id, subject, score)
      values (v_section_id, v_student_id, v_mark.subject, v_mark.score);
    end loop;
  end loop;

  delete from public.course_materials where section_id = v_section_id;
  for v_material in
    select value from jsonb_array_elements(coalesce(p_section -> 'materials', '[]'::jsonb))
  loop
    v_material_id := coalesce(nullif(v_material ->> 'id', ''), gen_random_uuid()::text);
    insert into public.course_materials(id, section_id, name, type, subject, tags, source, excerpt)
    values (
      v_material_id,
      v_section_id,
      v_material ->> 'name',
      v_material ->> 'type',
      coalesce(v_material ->> 'subject', 'All subjects'),
      array(select jsonb_array_elements_text(coalesce(v_material -> 'tags', '[]'::jsonb))),
      case when v_material ->> 'source' = 'Demo library' then 'Demo library' else 'Faculty upload' end,
      v_material ->> 'excerpt'
    );
  end loop;

  return v_section_id;
end;
$$;

revoke all on function public.save_course_section(jsonb) from public, anon;
grant execute on function public.save_course_section(jsonb) to authenticated;

revoke all on public.course_sections, public.section_subjects, public.students,
  public.section_enrollments, public.student_marks, public.course_materials
  from public, anon, authenticated;

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.course_sections to authenticated;
grant select, insert, update, delete on public.section_subjects to authenticated;
grant select on public.students to authenticated;
grant insert (id, name, roll_no) on public.students to authenticated;
grant update (name, roll_no) on public.students to authenticated;
grant select, insert, update, delete on public.section_enrollments to authenticated;
grant select, insert, update, delete on public.student_marks to authenticated;
grant select, insert, update, delete on public.course_materials to authenticated;
