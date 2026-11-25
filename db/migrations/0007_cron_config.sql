CREATE TABLE "cron_config" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cron_config" ENABLE ROW LEVEL SECURITY;