CREATE TYPE "public"."hash_kind" AS ENUM('md5', 'sha1', 'sha256');--> statement-breakpoint
CREATE TYPE "public"."indicator_status" AS ENUM('active', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."indicator_type" AS ENUM('ip', 'domain', 'url', 'hash', 'email');--> statement-breakpoint
CREATE TYPE "public"."notification_kind" AS ENUM('port_opened', 'port_closed', 'page_exposed', 'cert_expiring', 'asset_down');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('success', 'fail');--> statement-breakpoint
CREATE TYPE "public"."scan_status" AS ENUM('success', 'fail', 'partial');--> statement-breakpoint
CREATE TYPE "public"."source_kind" AS ENUM('api', 'html', 'pdf');--> statement-breakpoint
CREATE TYPE "public"."whitelist_type" AS ENUM('ip', 'cidr', 'domain');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"created_by" uuid,
	"last_used_at" timestamp with time zone,
	"revoked" boolean DEFAULT false NOT NULL,
	CONSTRAINT "api_keys_keyHash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"target" text NOT NULL,
	"owner" text,
	"department" text,
	"importance" smallint DEFAULT 3 NOT NULL,
	"scan_level" smallint DEFAULT 3 NOT NULL,
	"scan_permitted" boolean NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"memo" text,
	CONSTRAINT "assets_importance_ck" CHECK ("assets"."importance" between 1 and 5),
	CONSTRAINT "assets_scan_level_ck" CHECK ("assets"."scan_level" between 1 and 5),
	CONSTRAINT "assets_scan_permitted_ck" CHECK ("assets"."scan_permitted" = true)
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid,
	"action" text NOT NULL,
	"target" text,
	"detail" jsonb,
	"ip" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collect_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"status" "run_status" NOT NULL,
	"new_count" integer DEFAULT 0 NOT NULL,
	"error_message" text
);
--> statement-breakpoint
CREATE TABLE "indicator_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"indicator_id" uuid NOT NULL,
	"source_id" uuid,
	"source_name" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ref_url" text,
	"note" text,
	CONSTRAINT "indicator_sources_indicator_source_uq" UNIQUE("indicator_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "indicators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"type" "indicator_type" NOT NULL,
	"value" text NOT NULL,
	"hash_kind" "hash_kind",
	"status" "indicator_status" DEFAULT 'active' NOT NULL,
	"excluded" boolean DEFAULT false NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"memo" text,
	CONSTRAINT "indicators_type_value_uq" UNIQUE("type","value"),
	CONSTRAINT "indicators_hash_kind_ck" CHECK (("indicators"."type" = 'hash') = ("indicators"."hash_kind" is not null)),
	CONSTRAINT "indicators_value_len_ck" CHECK (length("indicators"."value") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" "notification_kind" NOT NULL,
	"asset_id" uuid NOT NULL,
	"message" text NOT NULL,
	"read" boolean DEFAULT false NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scan_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"asset_id" uuid NOT NULL,
	"scan_date" date NOT NULL,
	"scan_level" smallint NOT NULL,
	"status" "scan_status" NOT NULL,
	"open_ports" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"exposed_pages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cert_expires_at" timestamp with time zone,
	"error_message" text,
	"duration_sec" integer,
	CONSTRAINT "scan_results_asset_date_uq" UNIQUE("asset_id","scan_date")
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"kind" "source_kind" NOT NULL,
	"url" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"api_key_enc" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_success_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "whitelist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"type" "whitelist_type" NOT NULL,
	"value" text NOT NULL,
	"reason" text,
	"created_by" uuid,
	CONSTRAINT "whitelist_type_value_uq" UNIQUE("type","value")
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collect_runs" ADD CONSTRAINT "collect_runs_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indicator_sources" ADD CONSTRAINT "indicator_sources_indicator_id_indicators_id_fk" FOREIGN KEY ("indicator_id") REFERENCES "public"."indicators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indicator_sources" ADD CONSTRAINT "indicator_sources_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_results" ADD CONSTRAINT "scan_results_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whitelist" ADD CONSTRAINT "whitelist_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assets_target_idx" ON "assets" USING btree ("target");--> statement-breakpoint
CREATE INDEX "audit_logs_occurred_idx" ON "audit_logs" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "collect_runs_source_started_idx" ON "collect_runs" USING btree ("source_id","started_at");--> statement-breakpoint
CREATE INDEX "indicators_last_seen_idx" ON "indicators" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "indicators_status_excluded_idx" ON "indicators" USING btree ("status","excluded");--> statement-breakpoint
CREATE INDEX "notifications_read_occurred_idx" ON "notifications" USING btree ("read","occurred_at");--> statement-breakpoint
CREATE INDEX "scan_results_scan_date_idx" ON "scan_results" USING btree ("scan_date");