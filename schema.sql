-- 우리집 냉장고 · Supabase 테이블 정의
-- Supabase 대시보드 > SQL Editor 에 전체를 붙여넣고 RUN 하세요.
-- (프로젝트 생성 후 1회만 실행하면 됩니다)

create table if not exists public.storage_spaces (
  id          text primary key,
  family_code text not null,
  name        text not null,
  icon        text default '📦',
  sort_order  integer default 0,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

create table if not exists public.fridge_items (
  id          text primary key,
  family_code text not null,
  name        text not null,
  space_id    text,
  quantity    numeric default 1,
  unit        text default '개',
  expiry      date,
  memo        text default '',
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

create table if not exists public.shopping_items (
  id          text primary key,
  family_code text not null,
  name        text not null,
  quantity    numeric default 1,
  unit        text default '개',
  checked     boolean default false,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

create index if not exists storage_spaces_family_idx on public.storage_spaces (family_code);
create index if not exists fridge_items_family_idx on public.fridge_items (family_code);
create index if not exists shopping_items_family_idx on public.shopping_items (family_code);

alter table public.storage_spaces enable row level security;
alter table public.fridge_items enable row level security;
alter table public.shopping_items enable row level security;

drop policy if exists "family storage" on public.storage_spaces;
create policy "family storage" on public.storage_spaces
  for all to anon, authenticated using (true) with check (true);

drop policy if exists "family fridge" on public.fridge_items;
create policy "family fridge" on public.fridge_items
  for all to anon, authenticated using (true) with check (true);

drop policy if exists "family shopping" on public.shopping_items;
create policy "family shopping" on public.shopping_items
  for all to anon, authenticated using (true) with check (true);

grant select, insert, update, delete on public.storage_spaces to anon, authenticated;
grant select, insert, update, delete on public.fridge_items to anon, authenticated;
grant select, insert, update, delete on public.shopping_items to anon, authenticated;

-- updated_at 자동 갱신
create or replace function public.touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_touch_storage on public.storage_spaces;
create trigger trg_touch_storage before update on public.storage_spaces
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_touch_fridge on public.fridge_items;
create trigger trg_touch_fridge before update on public.fridge_items
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_touch_shopping on public.shopping_items;
create trigger trg_touch_shopping before update on public.shopping_items
  for each row execute function public.touch_updated_at();

-- 참고: 가족 공유는 "공유 코드"로만 구분하는 간단한 구조입니다.
-- 같은 URL·Anon Key를 아는 사람은 다른 가족 코드도 조회할 수 있으니,
-- 집 안에서 쓰는 가벼운 용도로만 사용하세요.
