CREATE TABLE "domain_ips" (
	"indicator_id" uuid PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"ip" text,
	"ip_num" bigint,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "domain_ips_status_ck" CHECK ("domain_ips"."status" in ('ok', 'unresolved'))
);
--> statement-breakpoint
CREATE TABLE "net_ranges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"start_num" bigint NOT NULL,
	"end_num" bigint NOT NULL,
	"country_code" text,
	"net_name" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "net_ranges_range_uq" UNIQUE("start_num","end_num")
);
--> statement-breakpoint
ALTER TABLE "domain_ips" ADD CONSTRAINT "domain_ips_indicator_id_indicators_id_fk" FOREIGN KEY ("indicator_id") REFERENCES "public"."indicators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "domain_ips_resolved_idx" ON "domain_ips" USING btree ("resolved_at");--> statement-breakpoint
CREATE INDEX "net_ranges_start_idx" ON "net_ranges" USING btree ("start_num","end_num");