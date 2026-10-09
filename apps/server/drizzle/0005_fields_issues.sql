CREATE TABLE "ticket_fields" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"type" text NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"customer_attribute" text,
	"ai_instruction" text DEFAULT '' NOT NULL,
	"shown" text DEFAULT 'panel' NOT NULL,
	"required_to_resolve" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_links" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"ticket_id" text NOT NULL,
	"provider" text NOT NULL,
	"integration_id" text,
	"external_id" text NOT NULL,
	"key" text NOT NULL,
	"url" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT '' NOT NULL,
	"status_category" text DEFAULT 'todo' NOT NULL,
	"created_by_trace" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "fields" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ticket_fields" ADD CONSTRAINT "ticket_fields_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_links" ADD CONSTRAINT "ticket_links_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_links" ADD CONSTRAINT "ticket_links_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_links" ADD CONSTRAINT "ticket_links_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_fields_org_key_idx" ON "ticket_fields" USING btree ("org_id","key");--> statement-breakpoint
CREATE INDEX "ticket_links_ticket_idx" ON "ticket_links" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "ticket_links_org_key_idx" ON "ticket_links" USING btree ("org_id","provider","key");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_links_ticket_key_idx" ON "ticket_links" USING btree ("ticket_id","provider","key");