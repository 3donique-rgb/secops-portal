CREATE INDEX IF NOT EXISTS "net_ranges_range_gist" ON "net_ranges" USING gist (int8range("start_num", "end_num", '[]'));
