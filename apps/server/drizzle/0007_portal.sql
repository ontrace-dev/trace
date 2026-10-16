CREATE TABLE "portal_sign_ins" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"email" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD COLUMN "portal" jsonb;--> statement-breakpoint
ALTER TABLE "portal_sign_ins" ADD CONSTRAINT "portal_sign_ins_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portal_sign_ins_org_email_idx" ON "portal_sign_ins" USING btree ("org_id","email","created_at");