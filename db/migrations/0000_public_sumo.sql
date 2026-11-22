CREATE TYPE "public"."user_role" AS ENUM('admin', 'viewer');--> statement-breakpoint
CREATE TABLE "user_allowed_ips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"cidr" text NOT NULL,
	"memo" text,
	"created_by" uuid,
	CONSTRAINT "user_allowed_ips_user_cidr_uq" UNIQUE("user_id","cidr")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"username" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'viewer' NOT NULL,
	"otp_secret_enc" text,
	"otp_enabled" boolean DEFAULT false NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"last_login_at" timestamp with time zone,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
ALTER TABLE "user_allowed_ips" ADD CONSTRAINT "user_allowed_ips_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_allowed_ips" ADD CONSTRAINT "user_allowed_ips_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;