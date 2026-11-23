CREATE TABLE "news_articles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"title_key" text NOT NULL,
	"title" text NOT NULL,
	"publisher" text DEFAULT '' NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"url" text NOT NULL,
	"provider" text NOT NULL,
	"keywords" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "news_articles_titleKey_unique" UNIQUE("title_key")
);
--> statement-breakpoint
CREATE INDEX "news_articles_published_idx" ON "news_articles" USING btree ("published_at" DESC NULLS LAST);