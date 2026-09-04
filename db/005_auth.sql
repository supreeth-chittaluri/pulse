-- M4: auth support.

alter table users add column if not exists last_login_at timestamptz;

-- Emails are stored lowercased, but index the folded form too so a stray
-- mixed-case row can never create a second account for the same person.
create unique index if not exists users_email_lower_idx on users (lower(email));
