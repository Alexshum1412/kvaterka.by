-- Runs once, when docker-compose creates the PostgreSQL 10.23 data directory.
--
-- Its whole job is to make the local database as UNPRIVILEGED as the production
-- one. The shared host gives the application a role that owns its own databases
-- and nothing else — it cannot install an extension, create another role, or
-- create a database. A developer connecting as `postgres` would be able to do
-- all three, and would then write a migration that works on their machine and
-- fails on the server. That has already happened once on this project; this
-- file is the fix.
--
-- Connect as `kvaterka` for everything. Use `postgres` only to create or drop
-- databases, which is the one thing the real host does through a control panel
-- rather than through SQL.

CREATE ROLE kvaterka LOGIN PASSWORD 'kvaterka'
  NOSUPERUSER NOCREATEROLE NOCREATEDB;

-- Two databases: one to develop against, one for the test harness, which builds
-- a schema per test file inside it and drops them again.
CREATE DATABASE kvaterka      OWNER kvaterka;
CREATE DATABASE kvaterka_test OWNER kvaterka;
