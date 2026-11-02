-- Run once on your own PC after installing PostgreSQL 16, as the postgres user (SQL Shell / psql).
CREATE ROLE ageless LOGIN PASSWORD 'ageless_dev' CREATEDB;
CREATE DATABASE ageless_dev OWNER ageless;
