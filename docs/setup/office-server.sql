-- Run once on the office PostgreSQL 16 machine, as the postgres user.
-- One login and one database per developer, plus one shared database for demos.
-- Replace names and passwords before running.
CREATE ROLE dev_anu  LOGIN PASSWORD 'change-me-1' CREATEDB;  CREATE DATABASE dev_anu  OWNER dev_anu;
CREATE ROLE dev_ravi LOGIN PASSWORD 'change-me-2' CREATEDB;  CREATE DATABASE dev_ravi OWNER dev_ravi;
CREATE ROLE dev_sam  LOGIN PASSWORD 'change-me-3' CREATEDB;  CREATE DATABASE dev_sam  OWNER dev_sam;
CREATE ROLE lead     LOGIN PASSWORD 'change-me-4' CREATEDB;  CREATE DATABASE ageless_shared OWNER lead;
-- postgresql.conf : listen_addresses = '*'
-- pg_hba.conf     : host  all  all  192.168.1.0/24  scram-sha-256   (your office network only)
-- Windows firewall: allow TCP 5432 from the office network only. Never open it to the internet.
