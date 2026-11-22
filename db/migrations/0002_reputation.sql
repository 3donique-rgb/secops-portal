CREATE TYPE "public"."reputation_verdict" AS ENUM('malicious', 'suspicious', 'harmless', 'unknown');--> statement-breakpoint
CREATE TABLE "indicator_reputations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"indicator_id" uuid NOT NULL,
	"origin" text DEFAULT 'manual' NOT NULL,
	"verdict" "reputation_verdict" DEFAULT 'unknown' NOT NULL,
	"vt_malicious" integer,
	"vt_suspicious" integer,
	"vt_harmless" integer,
	"vt_undetected" integer,
	"vt_reputation" integer,
	"note" text,
	"created_by" uuid,
	CONSTRAINT "indicator_reputations_origin_ck" CHECK ("indicator_reputations"."origin" in ('manual', 'virustotal'))
);
--> statement-breakpoint
ALTER TABLE "indicator_reputations" ADD CONSTRAINT "indicator_reputations_indicator_id_indicators_id_fk" FOREIGN KEY ("indicator_id") REFERENCES "public"."indicators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indicator_reputations" ADD CONSTRAINT "indicator_reputations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "indicator_reputations_indicator_idx" ON "indicator_reputations" USING btree ("indicator_id","created_at");