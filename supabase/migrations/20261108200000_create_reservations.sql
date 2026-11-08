create table public.reservations (
    id uuid primary key default gen_random_uuid(),
    department text not null check (department in ('tech', 'bike')),
    service_details text not null,
    requested_date date not null,
    requested_time time without time zone not null,
    customer_name text not null,
    customer_phone text not null,
    customer_email text not null,
    created_at timestamptz not null default now()
);

alter table public.reservations enable row level security;
